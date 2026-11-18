import type { ChildProcess } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import {
  claimVideoProductionAttempt,
  beginVideoProductionCompletion,
  setVideoProductionAttemptLaunchState,
  VideoProductionPolicyError,
  finishVideoProductionAttempt,
  finishVideoProductionExecutionPendingReview,
  finishVideoProductionCreativeDecision,
  finishVideoProductionQaDecision,
  finishVideoProductionRegenerationRequest,
  markVideoProductionAttemptReconciliationRequired,
  recordVideoProductionRecoveryEvent,
  releaseVideoProductionTask,
  requireOwnedVideoProductionAttempt,
} from "./video-production.ts";
import { cleanupStagedWorkspace, cleanupVerifiedWorkerWorkspace, getWorkerWorkspaceForAttempt, inspectWorkerContainer, probeWorkerIsolation, registerWorkerWorkspaceForAttempt, stageIsolatedWorkspace, stopVerifiedWorkerContainer, workerContainerName } from "./worker-isolation.ts";

type Db = Pick<DatabaseSync, "prepare" | "exec">;
const attemptByChild = new WeakMap<object, string>();
const providerAbortByAttempt = new Map<string, AbortController>();

export function registerVideoProductionProviderAbort(taskId: string, attemptId: string, controller: AbortController): void {
  providerAbortByAttempt.set(`${taskId}:${attemptId}`, controller);
}

export function unregisterVideoProductionProviderAbort(taskId: string, attemptId: string, controller: AbortController): void {
  const key = `${taskId}:${attemptId}`;
  if (providerAbortByAttempt.get(key) === controller) providerAbortByAttempt.delete(key);
}

export function requestVideoProductionProviderAbort(taskId: string, attemptId: string): boolean {
  const controller = providerAbortByAttempt.get(`${taskId}:${attemptId}`);
  if (!controller || controller.signal.aborted) return false;
  controller.abort();
  return true;
}

export function isVideoProductionChildForAttempt(child: unknown, attemptId: string): boolean {
  return typeof child === "object" && child !== null && attemptByChild.get(child) === attemptId;
}

export interface VideoProductionLaunchResult {
  attemptId: string;
  workerIdentity: string;
  child: ChildProcess;
}

/** Use only when an adapter can prove it created no worker process/container. */
export class VideoProductionLaunchNotStartedError extends Error {
  constructor(message = "worker_launch_not_started") {
    super(message);
    this.name = "VideoProductionLaunchNotStartedError";
  }
}

export function reconcileVideoProductionAttemptsAfterRestart(
  db: Db,
  inspect: typeof inspectWorkerContainer = inspectWorkerContainer,
): Array<{ taskId: string; attemptId: string; state: string }> {
  const attempts = db.prepare(
    "SELECT task_id,attempt_id,worker_identity,image_id,workspace_path,worker_kind,state FROM video_production_attempts WHERE state IN ('PREPARED','LAUNCHING','RUNNING','COMPLETING','RECONCILIATION_REQUIRED') ORDER BY created_at",
  ).all() as Array<{ task_id: string; attempt_id: string; worker_identity: string | null; image_id: string | null; workspace_path: string | null; worker_kind: string; state: string }>;
  const results: Array<{ taskId: string; attemptId: string; state: string }> = [];
  for (const attempt of attempts) {
    if (attempt.worker_kind === "phase4_provider_broker") {
      const job = db.prepare("SELECT execution_action FROM video_production_stage_jobs WHERE task_id=?").get(attempt.task_id) as { execution_action: string } | undefined;
      if (job?.execution_action === "qa.final" || job?.execution_action === "regeneration.request") {
        // These actions commit different evidence than ordinary creative review.
        // Reuse the exact owned-attempt finalizer; never replay a provider call or
        // release the slot on merely finding evidence for a different attempt.
        const evidence = job.execution_action === "qa.final"
          ? db.prepare("SELECT 1 FROM video_production_stage_decisions WHERE task_id=? AND attempt_id=? LIMIT 1").get(attempt.task_id, attempt.attempt_id)
          : db.prepare("SELECT 1 FROM video_production_regeneration_requests WHERE task_id=? AND attempt_id=? LIMIT 1").get(attempt.task_id, attempt.attempt_id);
        if (evidence) {
          const claimed = attempt.state === "COMPLETING" || beginVideoProductionCompletion(db, attempt.task_id, attempt.attempt_id);
          const settled = claimed && (job.execution_action === "qa.final"
            ? finishVideoProductionQaDecision(db, attempt.task_id, attempt.attempt_id)
            : finishVideoProductionRegenerationRequest(db, attempt.task_id, attempt.attempt_id));
          if (!settled) markVideoProductionAttemptReconciliationRequired(db, attempt.task_id, attempt.attempt_id, { reason: "restart_committed_stage_evidence_unverified" });
          results.push({ taskId: attempt.task_id, attemptId: attempt.attempt_id, state: settled
            ? job.execution_action === "qa.final" ? "qa_decision_reconciled" : "regeneration_request_reconciled"
            : "reconciliation_required" });
        } else {
          const settled = finishVideoProductionAttempt(db, attempt.task_id, attempt.attempt_id, "failed", { reason: "provider_attempt_interrupted_no_automatic_replay" });
          results.push({ taskId: attempt.task_id, attemptId: attempt.attempt_id, state: settled ? "failed" : "reconciliation_required" });
        }
        continue;
      }
      const takeReview = db.prepare("SELECT 1 FROM video_production_take_reviews WHERE task_id=? AND attempt_id=? LIMIT 1").get(attempt.task_id, attempt.attempt_id);
      if (takeReview) {
        const claimed = attempt.state === "COMPLETING" || beginVideoProductionCompletion(db, attempt.task_id, attempt.attempt_id);
        const settled = claimed && finishVideoProductionAttempt(db, attempt.task_id, attempt.attempt_id, "completed", { outcome: "restart_recovered_committed_take_review" });
        results.push({ taskId: attempt.task_id, attemptId: attempt.attempt_id, state: settled ? "take_review_reconciled" : "reconciliation_required" });
      } else {
        const output = db.prepare(`SELECT artifact_type FROM video_production_stage_artifacts WHERE task_id=? AND attempt_id=?
          AND artifact_type IN ('screenplay','shot_spec','continuity_package','timeline_plan','audio_cues') LIMIT 1`).get(attempt.task_id, attempt.attempt_id) as { artifact_type: string } | undefined;
        if (output) {
          const settled = finishVideoProductionExecutionPendingReview(db, attempt.task_id, attempt.attempt_id, { reason: "restart_recovered_committed_stage_output", artifactType: output.artifact_type });
        results.push({ taskId: attempt.task_id, attemptId: attempt.attempt_id, state: settled ? "review" : "reconciliation_required" });
        } else {
          const decision = db.prepare("SELECT 1 FROM video_production_stage_decisions WHERE task_id=? AND attempt_id=? LIMIT 1").get(attempt.task_id, attempt.attempt_id);
          if (decision) {
            const completionClaimed = attempt.state === "COMPLETING" || beginVideoProductionCompletion(db, attempt.task_id, attempt.attempt_id);
            const settled = completionClaimed && finishVideoProductionCreativeDecision(db, attempt.task_id, attempt.attempt_id);
            results.push({ taskId: attempt.task_id, attemptId: attempt.attempt_id, state: settled ? "decision_reconciled" : "reconciliation_required" });
          } else {
            const settled = finishVideoProductionAttempt(db, attempt.task_id, attempt.attempt_id, "failed", { reason: "provider_attempt_interrupted_no_automatic_replay" });
            results.push({ taskId: attempt.task_id, attemptId: attempt.attempt_id, state: settled ? "failed" : "reconciliation_required" });
          }
        }
      }
      continue;
    }
    const workspacePath = attempt.workspace_path ?? undefined;
    const observed = attempt.worker_identity && attempt.image_id && workspacePath
      ? inspect(attempt.worker_identity, attempt.attempt_id, attempt.image_id, workspacePath, attempt.worker_kind === "phase4_remotion" ? "phase4-v1" : undefined)
      : { state: "unknown" as const, verified: false };
    if (observed.verified && observed.state === "exited" && typeof observed.exitCode === "number") {
      if (observed.exitCode === 0) {
        const detail = { observed: "exited", outcome: "output_validation_required_after_restart", action: "retained_for_reconciliation" };
        markVideoProductionAttemptReconciliationRequired(db, attempt.task_id, attempt.attempt_id, detail);
        recordVideoProductionRecoveryEvent(db, attempt.task_id, attempt.attempt_id, detail);
        results.push({ taskId: attempt.task_id, attemptId: attempt.attempt_id, state: "reconciliation_required" });
      } else {
        finishVideoProductionAttempt(db, attempt.task_id, attempt.attempt_id, "failed", {
          reason: "restart_reconciled_worker_failure",
          exitCode: observed.exitCode,
        });
        recordVideoProductionRecoveryEvent(db, attempt.task_id, attempt.attempt_id, { observed: "exited", outcome: "failed" });
        results.push({ taskId: attempt.task_id, attemptId: attempt.attempt_id, state: "failed" });
      }
      continue;
    }
    const detail = { observed: observed.verified ? observed.state : "unknown", action: "retained_for_reconciliation" };
    markVideoProductionAttemptReconciliationRequired(db, attempt.task_id, attempt.attempt_id, detail);
    recordVideoProductionRecoveryEvent(db, attempt.task_id, attempt.attempt_id, detail);
    results.push({ taskId: attempt.task_id, attemptId: attempt.attempt_id, state: "reconciliation_required" });
  }
  return results;
}

/** The single production launch boundary used by the task route and integration tests. */
export function launchVideoProductionAttempt(input: {
  db: Db;
  taskId: string;
  agentId: string;
  launch: (attemptId: string, workerIdentity: string, workspacePath: string) => ChildProcess;
  complete: (taskId: string, exitCode: number, attemptId: string, completionClaimed?: boolean) => void;
  validateOutput?: (input: { taskId: string; attemptId: string; workspacePath?: string }) => Promise<void> | void;
  outputValidationRequired?: boolean;
  executionAction?: string;
  requirePhase4Protocol?: boolean;
  workerKind?: string;
  inspect?: typeof inspectWorkerContainer;
  imageId?: string;
  onUnknown?: (attemptId: string, detail: unknown) => void;
  resumeFromAttemptId?: string;
  attemptId?: string;
}): VideoProductionLaunchResult {
  const imageId = input.imageId ?? probeWorkerIsolation().immutableImageId;
  if (!imageId) throw new VideoProductionPolicyError("worker_container_image_unverified", 503);
  if (input.requirePhase4Protocol && !probeWorkerIsolation().phase4Ready) {
    throw new VideoProductionPolicyError("phase4_worker_runner_not_verified", 503);
  }
  if (input.outputValidationRequired && !input.validateOutput) {
    throw new VideoProductionPolicyError("production_output_validator_unavailable", 503);
  }
  const attemptId = claimVideoProductionAttempt(input.db, input.taskId, input.attemptId, input.workerKind ?? "container_cli", input.agentId, input.resumeFromAttemptId, input.executionAction);
  const workerIdentity = workerContainerName(attemptId);
  let workspacePath: string;
  try {
    workspacePath = stageIsolatedWorkspace();
  } catch {
    finishVideoProductionAttempt(input.db, input.taskId, attemptId, "failed", { reason: "workspace_staging_failed_before_spawn" });
    throw new VideoProductionLaunchNotStartedError("worker_workspace_staging_failed");
  }
  registerWorkerWorkspaceForAttempt(attemptId, workspacePath);
  if (
    !setVideoProductionAttemptLaunchState(input.db, input.taskId, attemptId, "LAUNCHING", {
      workerIdentity,
      imageId,
      workspacePath,
      detail: { workspacePath },
    })
  ) {
    cleanupStagedWorkspace(workspacePath);
    throw new VideoProductionPolicyError("production_attempt_ownership_lost", 409);
  }

  let child: ChildProcess;
  try {
    child = input.launch(attemptId, workerIdentity, workspacePath);
  } catch (error) {
    if (error instanceof VideoProductionLaunchNotStartedError) {
      cleanupVerifiedWorkerWorkspace(attemptId);
      finishVideoProductionAttempt(input.db, input.taskId, attemptId, "failed", {
        reason: "worker_launch_rejected_before_spawn",
        error: error.message.slice(0, 160),
      });
      throw error;
    }
    const detail = {
      reason: "worker_launch_threw",
      error: error instanceof Error ? error.message.slice(0, 160) : "unknown",
    };
    setVideoProductionAttemptLaunchState(input.db, input.taskId, attemptId, "RECONCILIATION_REQUIRED", { detail });
    input.onUnknown?.(attemptId, detail);
    throw error;
  }
  attemptByChild.set(child, attemptId);

  const inspect = input.inspect ?? inspectWorkerContainer;
  child.once("error", () => {
    setVideoProductionAttemptLaunchState(input.db, input.taskId, attemptId, "RECONCILIATION_REQUIRED", {
      detail: { reason: "docker_client_error" },
    });
    input.onUnknown?.(attemptId, { reason: "docker_client_error" });
  });
  child.once("close", (dockerExitCode: number | null) => {
    const state = inspect(workerIdentity, attemptId, imageId, workspacePath, input.requirePhase4Protocol ? "phase4-v1" : undefined);
    if (!state.verified || state.state !== "exited" || typeof state.exitCode !== "number") {
      const detail = { reason: "container_state_unverified", containerState: state.state, dockerExitCode };
      setVideoProductionAttemptLaunchState(input.db, input.taskId, attemptId, "RECONCILIATION_REQUIRED", { detail });
      input.onUnknown?.(attemptId, detail);
      return;
    }
    const stillOwned = setVideoProductionAttemptLaunchState(input.db, input.taskId, attemptId, "RUNNING", {
      detail: { containerState: state.state, exitCode: state.exitCode },
    });
    if (!stillOwned) return;
    void (async () => {
      try {
        if (state.exitCode === 0 && input.outputValidationRequired && !beginVideoProductionCompletion(input.db, input.taskId, attemptId)) return;
        if (state.exitCode === 0 && input.validateOutput) {
          await input.validateOutput({ taskId: input.taskId, attemptId, workspacePath: getWorkerWorkspaceForAttempt(attemptId) });
        }
      } catch (error) {
        const detail = {
          reason: "production_output_validation_failed",
          error: error instanceof Error ? error.message.slice(0, 160) : "unknown",
        };
        markVideoProductionAttemptReconciliationRequired(input.db, input.taskId, attemptId, detail);
        input.onUnknown?.(attemptId, detail);
        return;
      }
      if (state.exitCode === 0 && input.outputValidationRequired && !input.validateOutput) {
        markVideoProductionAttemptReconciliationRequired(input.db, input.taskId, attemptId, { reason: "production_output_validator_unavailable" });
        return;
      }
      input.complete(input.taskId, state.exitCode as number, attemptId, state.exitCode === 0 && input.outputValidationRequired === true);
      // Completion may import/pin assets and release the slot. Only clean after that succeeds.
      if (!requireOwnedVideoProductionAttempt(input.db, input.taskId, attemptId)) cleanupVerifiedWorkerWorkspace(attemptId);
    })().catch((error: unknown) => {
      const detail = { reason: "production_completion_callback_failed", error: error instanceof Error ? error.message.slice(0, 160) : "unknown" };
      markVideoProductionAttemptReconciliationRequired(input.db, input.taskId, attemptId, detail);
      input.onUnknown?.(attemptId, detail);
    });
  });
  return { attemptId, workerIdentity, child };
}

/** Dami's trusted internal request path; requester identity is DB-owned and
 * remains separate from the executor assigned to the task. */
export function requestVideoProductionExecution(input: {
  db: Db;
  taskId: string;
  requesterAgentId: string;
  executorAgentId: string;
  launch: (attemptId: string, workerIdentity: string, workspacePath: string) => ChildProcess;
  complete: (taskId: string, exitCode: number, attemptId: string, completionClaimed?: boolean) => void;
  validateOutput?: (input: { taskId: string; attemptId: string; workspacePath?: string }) => Promise<void> | void;
  outputValidationRequired?: boolean;
  executionAction?: string;
  requirePhase4Protocol?: boolean;
  workerKind?: string;
  inspect?: typeof inspectWorkerContainer;
  imageId?: string;
  onUnknown?: (attemptId: string, detail: unknown) => void;
  resumeFromAttemptId?: string;
  attemptId?: string;
}): VideoProductionLaunchResult {
  const owner = input.db.prepare(
    "SELECT p.manager_agent_id FROM video_production_stages s JOIN video_productions p ON p.project_id=s.project_id WHERE s.task_id=?",
  ).get(input.taskId) as { manager_agent_id: string } | undefined;
  if (!owner) throw new VideoProductionPolicyError("video_production_not_registered");
  if (owner.manager_agent_id !== input.requesterAgentId) {
    throw new VideoProductionPolicyError("production_manager_identity_mismatch", 403);
  }
  return launchVideoProductionAttempt({
    db: input.db,
    taskId: input.taskId,
    agentId: input.executorAgentId,
    launch: input.launch,
    complete: input.complete,
    validateOutput: input.validateOutput,
    outputValidationRequired: input.outputValidationRequired,
    executionAction: input.executionAction,
    requirePhase4Protocol: input.requirePhase4Protocol,
    workerKind: input.workerKind,
    inspect: input.inspect,
    imageId: input.imageId,
    onUnknown: input.onUnknown,
    resumeFromAttemptId: input.resumeFromAttemptId,
    attemptId: input.attemptId,
  });
}

/** Idempotent cancellation by the exact task+attempt pair. Unknown, stale, or
 * unverified workers keep the singleton reservation for reconciliation. */
export function cancelVideoProductionAttempt(input: {
  db: Db;
  taskId: string;
  attemptId: string;
  stop?: typeof stopVerifiedWorkerContainer;
}): { cancelled: boolean; alreadyCancelled: boolean } {
  const row = input.db.prepare(
    "SELECT state,worker_identity,image_id,workspace_path,worker_kind,detail_json FROM video_production_attempts WHERE task_id=? AND attempt_id=?",
  ).get(input.taskId, input.attemptId) as
    | { state: string; worker_identity: string | null; image_id: string | null; workspace_path: string | null; worker_kind: string; detail_json: string }
    | undefined;
  if (!row) throw new VideoProductionPolicyError("production_attempt_not_found", 404);
  let details: Record<string, unknown> = {};
  try { details = JSON.parse(row.detail_json) as Record<string, unknown>; } catch { /* malformed legacy detail remains non-authoritative */ }
  if (row.state === "PAUSED" && details.outcome === "cancelled") return { cancelled: true, alreadyCancelled: true };
  if (!requireOwnedVideoProductionAttempt(input.db, input.taskId, input.attemptId)) {
    throw new VideoProductionPolicyError("production_attempt_not_owned", 409);
  }
  if (!row.worker_identity || !row.image_id) {
    markVideoProductionAttemptReconciliationRequired(input.db, input.taskId, input.attemptId, { reason: "cancel_identity_missing" });
    throw new VideoProductionPolicyError("production_worker_identity_unverified", 503);
  }
  if (row.worker_kind === "phase4_remotion" && !row.workspace_path) {
    markVideoProductionAttemptReconciliationRequired(input.db, input.taskId, input.attemptId, { reason: "cancel_workspace_identity_missing" });
    throw new VideoProductionPolicyError("production_worker_identity_unverified", 503);
  }
  const stopped = (input.stop ?? stopVerifiedWorkerContainer)(row.worker_identity, input.attemptId, row.image_id, row.workspace_path ?? undefined, row.worker_kind === "phase4_remotion" ? "phase4-v1" : undefined);
  if (!stopped) {
    markVideoProductionAttemptReconciliationRequired(input.db, input.taskId, input.attemptId, { reason: "cancel_stop_or_inspection_unverified" });
    throw new VideoProductionPolicyError("production_worker_stop_unverified", 503);
  }
  releaseVideoProductionTask(input.db, input.taskId, {
    outcome: "paused",
    attemptId: input.attemptId,
    detail: { outcome: "cancelled", reason: "worker_stopped_and_verified" },
  });
  const after = input.db.prepare("SELECT state,detail_json FROM video_production_attempts WHERE task_id=? AND attempt_id=?").get(input.taskId, input.attemptId) as
    | { state: string; detail_json: string }
    | undefined;
  let afterDetail: Record<string, unknown> = {};
  try { afterDetail = JSON.parse(after?.detail_json ?? "{}") as Record<string, unknown>; } catch { /* ignore */ }
  if (after?.state !== "PAUSED" || afterDetail.outcome !== "cancelled") {
    throw new VideoProductionPolicyError("production_attempt_ownership_lost", 409);
  }
  return { cancelled: true, alreadyCancelled: false };
}
