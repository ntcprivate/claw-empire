import type { ChildProcess } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import {
  claimVideoProductionAttempt,
  setVideoProductionAttemptLaunchState,
  VideoProductionPolicyError,
  finishVideoProductionAttempt,
  finishVideoProductionExecutionPendingReview,
  markVideoProductionAttemptReconciliationRequired,
  recordVideoProductionRecoveryEvent,
  releaseVideoProductionTask,
  requireOwnedVideoProductionAttempt,
} from "./video-production.ts";
import { cleanupVerifiedWorkerWorkspace, inspectWorkerContainer, probeWorkerIsolation, stopVerifiedWorkerContainer, workerContainerName } from "./worker-isolation.ts";

type Db = Pick<DatabaseSync, "prepare" | "exec">;
const attemptByChild = new WeakMap<object, string>();

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
    "SELECT task_id,attempt_id,worker_identity,image_id,state FROM video_production_attempts WHERE state IN ('PREPARED','LAUNCHING','RUNNING','COMPLETING','RECONCILIATION_REQUIRED') ORDER BY created_at",
  ).all() as Array<{ task_id: string; attempt_id: string; worker_identity: string | null; image_id: string | null; state: string }>;
  const results: Array<{ taskId: string; attemptId: string; state: string }> = [];
  for (const attempt of attempts) {
    const observed = attempt.worker_identity && attempt.image_id
      ? inspect(attempt.worker_identity, attempt.attempt_id, attempt.image_id)
      : { state: "unknown" as const, verified: false };
    if (observed.verified && observed.state === "exited" && typeof observed.exitCode === "number") {
      if (observed.exitCode === 0) {
        finishVideoProductionExecutionPendingReview(db, attempt.task_id, attempt.attempt_id, {
          reason: "restart_reconciled_success_without_output_validator",
        });
        recordVideoProductionRecoveryEvent(db, attempt.task_id, attempt.attempt_id, { observed: "exited", outcome: "review_pending_artifact_validation" });
        results.push({ taskId: attempt.task_id, attemptId: attempt.attempt_id, state: "review_pending_artifact_validation" });
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
  launch: (attemptId: string, workerIdentity: string) => ChildProcess;
  complete: (taskId: string, exitCode: number, attemptId: string) => void;
  inspect?: typeof inspectWorkerContainer;
  imageId?: string;
  onUnknown?: (attemptId: string, detail: unknown) => void;
  resumeFromAttemptId?: string;
}): VideoProductionLaunchResult {
  const imageId = input.imageId ?? probeWorkerIsolation().immutableImageId;
  if (!imageId) throw new VideoProductionPolicyError("worker_container_image_unverified", 503);
  const attemptId = claimVideoProductionAttempt(input.db, input.taskId, undefined, "container_cli", input.agentId, input.resumeFromAttemptId);
  const workerIdentity = workerContainerName(attemptId);
  if (
    !setVideoProductionAttemptLaunchState(input.db, input.taskId, attemptId, "LAUNCHING", {
      workerIdentity,
      imageId,
    })
  ) {
    throw new VideoProductionPolicyError("production_attempt_ownership_lost", 409);
  }

  let child: ChildProcess;
  try {
    child = input.launch(attemptId, workerIdentity);
  } catch (error) {
    if (error instanceof VideoProductionLaunchNotStartedError) {
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
    const state = inspect(workerIdentity, attemptId, imageId);
    if (!state.verified || state.state !== "exited" || typeof state.exitCode !== "number") {
      const detail = { reason: "container_state_unverified", containerState: state.state, dockerExitCode };
      setVideoProductionAttemptLaunchState(input.db, input.taskId, attemptId, "RECONCILIATION_REQUIRED", { detail });
      input.onUnknown?.(attemptId, detail);
      return;
    }
    cleanupVerifiedWorkerWorkspace(attemptId);
    const stillOwned = setVideoProductionAttemptLaunchState(input.db, input.taskId, attemptId, "RUNNING", {
      detail: { containerState: state.state, exitCode: state.exitCode },
    });
    if (!stillOwned) return;
    input.complete(input.taskId, state.exitCode, attemptId);
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
  launch: (attemptId: string, workerIdentity: string) => ChildProcess;
  complete: (taskId: string, exitCode: number, attemptId: string) => void;
  inspect?: typeof inspectWorkerContainer;
  imageId?: string;
  onUnknown?: (attemptId: string, detail: unknown) => void;
  resumeFromAttemptId?: string;
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
    inspect: input.inspect,
    imageId: input.imageId,
    onUnknown: input.onUnknown,
    resumeFromAttemptId: input.resumeFromAttemptId,
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
    "SELECT state,worker_identity,image_id,detail_json FROM video_production_attempts WHERE task_id=? AND attempt_id=?",
  ).get(input.taskId, input.attemptId) as
    | { state: string; worker_identity: string | null; image_id: string | null; detail_json: string }
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
  const stopped = (input.stop ?? stopVerifiedWorkerContainer)(row.worker_identity, input.attemptId, row.image_id);
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
