import { randomUUID } from "node:crypto";
import {
  assertVideoProductionTaskAdmission,
  claimVideoProductionAttempt,
  setVideoProductionAttemptLaunchState,
  markVideoProductionAttemptReconciliationRequired,
  VideoProductionPolicyError,
} from "./video-production.ts";
import {
  isWorkerIsolationReady,
  probeWorkerIsolation,
  spawnIsolatedWorker,
  stopVerifiedWorkerContainer,
  getWorkerWorkspaceForAttempt,
} from "./worker-isolation.ts";
import { runMiroAuthoringSession } from "./video-production-miro-session.ts";
import { getVideoProductionAgentProvider } from "./video-production-provider-broker.ts";
import {
  registerVideoProductionProviderAbort,
  requestVideoProductionExecution,
  unregisterVideoProductionProviderAbort,
  VideoProductionLaunchNotStartedError,
} from "./video-production-execution.ts";
import { buildMiroWorkerRequest, importMiroWorkerOutput } from "./video-production-stage-runner.ts";
import {
  buildLiamWorkerRequest,
  importLiamWorkerOutput,
  stageLiamWorkerInputs,
} from "./video-production-final-render.ts";
import {
  runAudioCueJob,
  runDamiRegenerationRequestJob,
  runHaruScreenplayJob,
  runHaruShotSpecJob,
  runLiamTimelinePlanJob,
  runQuinnFinalQaJob,
  runRianCreativeReviewJob,
  runYunaContinuityJob,
  runYunaTakeReviewJob,
} from "./video-production-stage-outputs.ts";
import type { RuntimeContext } from "../../types/runtime-context.ts";

export type VideoProductionJobExecutorDeps = Pick<
  RuntimeContext,
  | "db"
  | "activeProcesses"
  | "appendTaskLog"
  | "getNextHttpAgentPid"
  | "broadcast"
  | "startProgressTimer"
  | "handleTaskRunComplete"
>;

export type VideoProductionJobExecutionResult = {
  status: number;
  body: Record<string, unknown>;
};

/** Trusted server-side entry point shared by CEO task runs and the production
 * coordinator. HTTP callers must authenticate before invoking this service.
 * Every invocation revalidates admission and isolation before any launch. */
export async function executeVideoProductionJob(
  deps: VideoProductionJobExecutorDeps,
  id: string,
  resumeFromAttemptId?: string,
): Promise<VideoProductionJobExecutionResult> {
  const {
    db,
    activeProcesses,
    appendTaskLog,
    getNextHttpAgentPid,
    broadcast,
    startProgressTimer,
    handleTaskRunComplete,
  } = deps;
  const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as
    | { id: string; title: string; department_id: string | null; assigned_agent_id: string | null; status: string }
    | undefined;
  if (!task) return { status: 404, body: { error: "not_found" } };
  try {
    assertVideoProductionTaskAdmission(db, id, { allowPaused: Boolean(resumeFromAttemptId) });
  } catch (error) {
    if (error instanceof VideoProductionPolicyError)
      return { status: error.status, body: { error: error.code, message: error.message } };
    throw error;
  }
  if (!isWorkerIsolationReady()) return { status: 503, body: { error: "requires_worker_isolation", retryable: false } };

  const job = db
    .prepare(
      `SELECT j.project_id,j.plan_version,j.stage_key,j.execution_action,j.assigned_agent_id,j.state,
      p.manager_agent_id,t.status AS task_status
    FROM video_production_stage_jobs j JOIN video_productions p ON p.project_id=j.project_id
    JOIN tasks t ON t.id=j.task_id WHERE j.task_id=?`,
    )
    .get(id) as
    | {
        project_id: string;
        plan_version: number;
        stage_key: string;
        execution_action: string;
        assigned_agent_id: string;
        state: string;
        manager_agent_id: string;
        task_status: string;
      }
    | undefined;
  if (
    !job ||
    !(
      (job.stage_key === "ai_footage_production" &&
        ["footage.submit", "take.review", "regeneration.request"].includes(job.execution_action)) ||
      (job.stage_key === "story_development" &&
        (job.execution_action === "screenplay.write" || job.execution_action === "creative.approve")) ||
      (job.stage_key === "visual_preproduction" &&
        ["shot_spec.write", "visual.manage", "edit.manage", "creative.approve"].includes(job.execution_action)) ||
      (job.stage_key === "audio_preproduction" &&
        ["audio.manage", "creative.approve"].includes(job.execution_action)) ||
      (job.stage_key === "asset_handoff_rough_cut" && job.execution_action === "edit.manage") ||
      (job.stage_key === "director_review" && job.execution_action === "creative.approve") ||
      (job.stage_key === "finishing_qa" && job.execution_action === "qa.final")
    )
  ) {
    return { status: 409, body: { error: "production_stage_not_implemented" } };
  }
  const probe = probeWorkerIsolation();
  if (!probe.phase4Ready || !probe.immutableImageId) {
    return { status: 503, body: { error: "phase4_worker_runner_not_verified", retryable: false } };
  }
  if (
    task.assigned_agent_id !== job.assigned_agent_id ||
    (task.status !== "inbox" && task.status !== "planned" && task.status !== "pending" && !resumeFromAttemptId)
  ) {
    return { status: 409, body: { error: "production_stage_job_not_runnable" } };
  }
  if (
    [
      "screenplay.write",
      "shot_spec.write",
      "visual.manage",
      "audio.manage",
      "creative.approve",
      "take.review",
      "qa.final",
      "regeneration.request",
    ].includes(job.execution_action) ||
    (job.execution_action === "edit.manage" && job.stage_key !== "asset_handoff_rough_cut")
  ) {
    const attemptId = randomUUID();
    const controller = new AbortController();
    try {
      claimVideoProductionAttempt(
        db,
        id,
        attemptId,
        "phase4_provider_broker",
        job.assigned_agent_id,
        resumeFromAttemptId,
        job.execution_action,
      );
      if (
        !setVideoProductionAttemptLaunchState(db, id, attemptId, "RUNNING", {
          detail: { executor: "host_bounded_provider_broker" },
        })
      ) {
        throw new VideoProductionPolicyError("production_attempt_ownership_lost", 409);
      }
      const pseudoChild = {
        pid: -Math.abs(getNextHttpAgentPid()),
        kill: () => {
          controller.abort();
          return true;
        },
      } as unknown as import("node:child_process").ChildProcess;
      activeProcesses.set(id, pseudoChild);
      registerVideoProductionProviderAbort(id, attemptId, controller);
      db.prepare("UPDATE agents SET status='working',current_task_id=? WHERE id=?").run(id, job.assigned_agent_id);
      broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id=?").get(id));
      broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id=?").get(job.assigned_agent_id));
      startProgressTimer(id, task.title, task.department_id);
      const runStage =
        job.execution_action === "screenplay.write"
          ? runHaruScreenplayJob
          : job.execution_action === "shot_spec.write"
            ? runHaruShotSpecJob
            : job.execution_action === "visual.manage"
              ? runYunaContinuityJob
              : job.execution_action === "edit.manage"
                ? runLiamTimelinePlanJob
                : job.execution_action === "audio.manage" && job.stage_key === "audio_preproduction"
                  ? runAudioCueJob
                  : job.execution_action === "take.review"
                    ? runYunaTakeReviewJob
                    : job.execution_action === "regeneration.request"
                      ? runDamiRegenerationRequestJob
                      : job.execution_action === "qa.final"
                        ? runQuinnFinalQaJob
                        : runRianCreativeReviewJob;
      void Promise.resolve()
        .then(async () => {
          await runStage({ db, taskId: id, attemptId, signal: controller.signal });
        })
        .then(() => {
          handleTaskRunComplete(id, controller.signal.aborted ? 1 : 0, attemptId);
        })
        .catch(() => {
          if (!controller.signal.aborted)
            appendTaskLog(
              id,
              "error",
              "Video production stage failed validation or a required configured service is unavailable.",
            );
          handleTaskRunComplete(id, 1, attemptId);
        })
        .finally(() => unregisterVideoProductionProviderAbort(id, attemptId, controller));
      return { status: 202, body: { ok: true, attemptId, worker: "host-bounded-provider-broker" } };
    } catch (error) {
      if (error instanceof VideoProductionPolicyError)
        return { status: error.status, body: { error: error.code, message: error.message } };
      return { status: 503, body: { error: "production_provider_launch_unavailable", retryable: false } };
    }
  }
  try {
    const attemptId = randomUUID();
    const finalTimeline = job.stage_key === "asset_handoff_rough_cut" && job.execution_action === "edit.manage";
    if (!finalTimeline && !probe.authoringReady)
      return { status: 503, body: { error: "shotcraft_worker_not_verified", retryable: false } };
    if (!finalTimeline) getVideoProductionAgentProvider(db, job.assigned_agent_id);
    const workerRequest = finalTimeline
      ? buildLiamWorkerRequest(db, id, attemptId)
      : JSON.stringify({
          ...JSON.parse(await buildMiroWorkerRequest({ db, taskId: id, workspaceAttemptId: attemptId })),
          operation: "author-shot",
        });
    const launched = requestVideoProductionExecution({
      db,
      taskId: id,
      requesterAgentId: job.manager_agent_id,
      executorAgentId: job.assigned_agent_id,
      executionAction: job.execution_action,
      workerKind: "phase4_remotion",
      requirePhase4Protocol: true,
      outputValidationRequired: true,
      imageId: probe.immutableImageId,
      attemptId,
      resumeFromAttemptId,
      launch: (claimedAttemptId, _workerIdentity, workspacePath) => {
        if (!finalTimeline) {
          const marked = db
            .prepare(
              "UPDATE video_production_attempts SET detail_json=json_set(detail_json,'$.miroAuthoring',1) WHERE attempt_id=? AND task_id=? AND state='LAUNCHING'",
            )
            .run(claimedAttemptId, id);
          if (marked.changes !== 1) throw new VideoProductionLaunchNotStartedError("miro_authoring_attempt_not_owned");
        }
        if (finalTimeline) {
          try {
            const requestDigest = (JSON.parse(workerRequest) as { inputDigest?: string }).inputDigest;
            if (!requestDigest) throw new Error("final_timeline_request_digest_missing");
            stageLiamWorkerInputs(db, id, claimedAttemptId, workspacePath, requestDigest);
          } catch {
            throw new VideoProductionLaunchNotStartedError("final_timeline_inputs_not_staged");
          }
        }
        const child = spawnIsolatedWorker({
          imageId: probe.immutableImageId!,
          attemptId: claimedAttemptId,
          executorCommand: [],
          prompt: workerRequest,
          workspacePath,
          profile: "production_render",
          interactive: !finalTimeline,
        });
        if (finalTimeline)
          child.stdout?.on("data", (chunk: Buffer) =>
            appendTaskLog(
              id,
              "system",
              `${finalTimeline ? "Liam" : "Miro"} worker: ${chunk.toString("utf8").slice(0, 1024)}`,
            ),
          );
        child.stderr?.on("data", (chunk: Buffer) =>
          appendTaskLog(
            id,
            "system",
            `${finalTimeline ? "Liam" : "Miro"} worker diagnostic (sanitized): ${chunk
              .toString("utf8")
              .slice(0, 512)
              .replace(/[^\x20-\x7E\r\n]/g, "?")}`,
          ),
        );
        activeProcesses.set(id, child);
        return child;
      },
      validateOutput: ({ attemptId, workspacePath }) => {
        if (!workspacePath) throw new Error("worker_workspace_unavailable");
        return finalTimeline
          ? importLiamWorkerOutput({ db, taskId: id, attemptId, workspacePath }).then(() => undefined)
          : importMiroWorkerOutput({ db, taskId: id, attemptId, workspacePath }).then(() => undefined);
      },
      complete: handleTaskRunComplete,
      onUnknown: (attemptId, detail) =>
        appendTaskLog(
          id,
          "system",
          `Production attempt ${attemptId} requires reconciliation: ${JSON.stringify(detail)}`,
        ),
    });
    if (!finalTimeline) {
      setVideoProductionAttemptLaunchState(db, id, launched.attemptId, "RUNNING");
      const controller = new AbortController();
      registerVideoProductionProviderAbort(id, launched.attemptId, controller);
      void runMiroAuthoringSession({
        db,
        taskId: id,
        attemptId: launched.attemptId,
        child: launched.child,
        signal: controller.signal,
      })
        .catch(() => {
          appendTaskLog(
            id,
            "error",
            "Miro authoring session stopped: model/tool failure, cancellation or session budget exhausted.",
          );
          launched.child.stdin?.end();
          // Never settle from a model response. Only the verified container close
          // callback may fail/complete this attempt and release its slot.
          const workspace = getWorkerWorkspaceForAttempt(launched.attemptId);
          if (
            workspace &&
            !stopVerifiedWorkerContainer(
              launched.workerIdentity,
              launched.attemptId,
              probe.immutableImageId!,
              workspace,
              "phase4-v1",
            )
          ) {
            markVideoProductionAttemptReconciliationRequired(db, id, launched.attemptId, {
              reason: "miro_session_stop_unverified",
            });
          }
        })
        .finally(() => unregisterVideoProductionProviderAbort(id, launched.attemptId, controller));
    }
    const updatedTask = db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
    db.prepare("UPDATE agents SET status='working',current_task_id=? WHERE id=?").run(id, job.assigned_agent_id);
    const updatedAgent = db.prepare("SELECT * FROM agents WHERE id=?").get(job.assigned_agent_id);
    broadcast("task_update", updatedTask);
    broadcast("agent_status", updatedAgent);
    startProgressTimer(id, task.title, task.department_id);
    return {
      status: 200,
      body: { ok: true, pid: launched.child.pid ?? null, attemptId: launched.attemptId, worker: "phase4-remotion" },
    };
  } catch (error) {
    if (error instanceof VideoProductionPolicyError)
      return { status: error.status, body: { error: error.code, message: error.message } };
    return { status: 503, body: { error: "production_worker_launch_unavailable", retryable: false } };
  }
}
