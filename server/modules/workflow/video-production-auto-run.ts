import type { DatabaseSync } from "node:sqlite";
import { createNextVideoProductionStageJob } from "./video-production-dispatch.ts";
import { VideoProductionPolicyError } from "./video-production.ts";
import {
  executeVideoProductionJob,
  type VideoProductionJobExecutorDeps,
  type VideoProductionJobExecutionResult,
} from "./video-production-job-executor.ts";

type Db = Pick<DatabaseSync, "prepare" | "exec">;
type AutoRun = {
  project_id: string;
  plan_version: number;
  state: string;
  task_id: string | null;
  jobs_started: number;
};
type Deps = VideoProductionJobExecutorDeps & {
  notifyCeo: (content: string, taskId?: string | null) => void;
};

/** A successful explicit CEO run also resumes automatic continuation, including
 * productions approved before this feature existed. Never called for a failed launch. */
export function resumeVideoProductionAutoRun(db: Db, taskId: string): void {
  db.prepare(
    `INSERT INTO video_production_auto_runs(project_id,plan_version,state,task_id,updated_at)
    SELECT j.project_id,j.plan_version,'RUNNING',j.task_id,? FROM video_production_stage_jobs j
    JOIN video_productions p ON p.project_id=j.project_id
    WHERE j.task_id=? AND p.state='APPROVED' AND p.approved_version=j.plan_version AND p.plan_version=j.plan_version
    ON CONFLICT(project_id) DO UPDATE SET plan_version=excluded.plan_version,state='RUNNING',task_id=excluded.task_id,reason=NULL,updated_at=excluded.updated_at`,
  ).run(Date.now(), taskId);
}

/** Uses the existing completion callback and task executor, never a synthetic
 * HTTP session or the generic CLI path. SQLite retains intent across restarts;
 * the existing singleton attempt claim remains the final concurrency boundary. */
export function createVideoProductionAutoRunner(
  deps: Deps,
  execute: (taskId: string) => Promise<VideoProductionJobExecutionResult> = (taskId) =>
    executeVideoProductionJob(deps, taskId),
) {
  const { db } = deps;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let draining = false;
  let requested = false;

  function stop(run: AutoRun, state: "WAITING_CEO" | "ERROR" | "PAUSED" | "COMPLETED", reason: string): void {
    const updated = db
      .prepare(
        `UPDATE video_production_auto_runs SET state=?,reason=?,updated_at=?
      WHERE project_id=? AND plan_version=? AND state='RUNNING'`,
      )
      .run(state, reason, Date.now(), run.project_id, run.plan_version);
    if (!updated.changes) return;
    db.prepare(
      `INSERT INTO video_production_events(project_id,event,actor_id,detail_json,created_at) VALUES(?,'auto_run_stopped','system',?,?)`,
    ).run(
      run.project_id,
      JSON.stringify({ state, reason, taskId: run.task_id, planVersion: run.plan_version }),
      Date.now(),
    );
    deps.broadcast("video_production_registry_changed", { projectId: run.project_id });
    deps.notifyCeo(
      `Video production ${state === "WAITING_CEO" ? "awaiting CEO approval" : state.toLowerCase()}: ${reason}`,
      run.task_id,
    );
  }

  async function drain(): Promise<void> {
    if (draining) {
      requested = true;
      return;
    }
    draining = true;
    try {
      do {
        requested = false;
        const runs = db
          .prepare("SELECT * FROM video_production_auto_runs WHERE state='RUNNING' ORDER BY updated_at,project_id")
          .all() as AutoRun[];
        for (const run of runs) {
          try {
            const production = db
              .prepare(
                "SELECT state,plan_version,approved_version,manager_agent_id FROM video_productions WHERE project_id=?",
              )
              .get(run.project_id) as
              | { state: string; plan_version: number; approved_version: number | null; manager_agent_id: string }
              | undefined;
            if (
              !production ||
              production.state !== "APPROVED" ||
              production.plan_version !== run.plan_version ||
              production.approved_version !== run.plan_version
            ) {
              stop(run, "WAITING_CEO", "production_approval_required");
              continue;
            }
            if (
              db
                .prepare("SELECT 1 FROM video_production_final_releases WHERE project_id=? AND plan_version=?")
                .get(run.project_id, run.plan_version)
            ) {
              stop(run, "COMPLETED", "final_release_recorded");
              continue;
            }
            if (run.task_id) {
              const last = db
                .prepare(
                  "SELECT state FROM video_production_attempts WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
                )
                .get(run.task_id) as { state: string } | undefined;
              if (last?.state === "FAILED" || last?.state === "PAUSED" || last?.state === "RECONCILIATION_REQUIRED") {
                stop(
                  run,
                  last.state === "PAUSED" ? "PAUSED" : "ERROR",
                  `production_attempt_${last.state.toLowerCase()}`,
                );
                continue;
              }
            }
            // A busy slot is queued work, not a failure. Completion (even a failed
            // one) wakes the queue. Reconciliation retains the slot and blocks launch.
            if (db.prepare("SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id IS NOT NULL").get())
              continue;
            if (run.jobs_started >= 1000) {
              stop(run, "ERROR", "production_auto_run_job_limit");
              continue;
            }
            const job = createNextVideoProductionStageJob(db, run.project_id, production.manager_agent_id);
            const current = db
              .prepare("SELECT state FROM video_production_stage_jobs WHERE task_id=?")
              .get(job.taskId) as { state: string } | undefined;
            if (current?.state !== "READY") {
              if (db.prepare("SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id=?").get(job.taskId))
                continue;
              stop(run, current?.state === "PAUSED" ? "PAUSED" : "ERROR", "production_next_job_not_runnable");
              continue;
            }
            // Persist the selected task BEFORE launch, so a restart between selection
            // and claim can safely reuse the same idempotent READY job.
            const selected = db.prepare(
              "UPDATE video_production_auto_runs SET task_id=?,jobs_started=jobs_started+1,reason=NULL,updated_at=? WHERE project_id=? AND plan_version=? AND state='RUNNING'",
            ).run(job.taskId, Date.now(), run.project_id, run.plan_version);
            if (selected.changes !== 1) continue;
            run.task_id = job.taskId;
            const result = await execute(job.taskId);
            if (result.status >= 300) {
              const reason =
                typeof result.body.error === "string" ? result.body.error : "production_auto_launch_failed";
              // Another process may have won the SQLite slot claim. Preserve the
              // queued READY job, but never retry other admission or launch errors.
              const alreadyClaimed = db
                .prepare("SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id=?")
                .get(job.taskId);
              if (reason !== "production_slot_busy" && !alreadyClaimed) stop(run, "ERROR", reason);
            } else {
              deps.appendTaskLog(
                job.taskId,
                "system",
                "Production coordinator automatically started the next approved stage job.",
              );
              deps.broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id=?").get(job.taskId));
              deps.broadcast("video_production_registry_changed", { projectId: run.project_id });
            }
          } catch (error) {
            if (error instanceof VideoProductionPolicyError && error.code === "production_slot_busy") continue;
            const reason = error instanceof VideoProductionPolicyError ? error.code : "production_auto_dispatch_failed";
            stop(run, reason === "awaiting_ceo_final_release" ? "WAITING_CEO" : "ERROR", reason);
          }
        }
      } while (requested);
    } finally {
      draining = false;
    }
  }

  function schedule(): void {
    requested = true;
    if (draining || scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = undefined;
      void drain().catch(() => {
        // Infrastructure failure is surfaced; no retry loop or unhandled rejection.
        deps.notifyCeo("Video production automatic dispatch failed; inspect the production state before resuming.");
      });
    }, 0);
    scheduled.unref?.();
  }

  return { schedule, drain };
}
