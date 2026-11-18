import type { Request, Response } from "express";
import { getVideoProductionAuthenticatedAgent, hasValidCsrfToken, isAuthenticated } from "../../../security/auth.ts";
import type { RuntimeContext } from "../../../types/runtime-context.ts";
import {
  decideVideoProduction,
  createVideoProductionShotRenderJob,
  createVideoProductionTakeReviewJob,
  claimVideoProductionAttemptForRecovery,
  beginVideoProductionCompletion,
  createVideoProductionScreenplayJob,
  createVideoProductionCreativeReviewJob,
  createVideoProductionScreenplayRevisionJob,
  createVideoProductionShotSpecJob,
  createVideoProductionContinuityJob,
  createVideoProductionTimelinePlanJob,
  createVideoProductionAudioCueJob,
  getVideoProduction,
  markVideoProductionAttemptReconciliationRequired,
  requireOwnedVideoProductionAttempt,
  saveVideoProductionPlan,
  VideoProductionPolicyError,
} from "../../workflow/video-production.ts";
import type { VideoProductionSnapshot } from "../../../../shared/video-production.ts";
import { createNextVideoProductionStageJob } from "../../workflow/video-production-dispatch.ts";
import { resumeVideoProductionAutoRun } from "../../workflow/video-production-auto-run.ts";
import { cleanupVerifiedWorkerWorkspacePath, inspectWorkerContainer, isWorkerIsolationReady, probeWorkerIsolation } from "../../workflow/worker-isolation.ts";
import { cancelVideoProductionAttempt, isVideoProductionChildForAttempt, requestVideoProductionProviderAbort } from "../../workflow/video-production-execution.ts";
import { importMiroWorkerOutput } from "../../workflow/video-production-stage-runner.ts";
import { importLiamWorkerOutput } from "../../workflow/video-production-final-render.ts";
import {
  grantVideoProductionProjectAgent, listVideoStudioProfiles, recordVideoProductionEvent,
  revokeVideoProductionProjectAgent, seedVideoProductionOrganization,
} from "../../workflow/video-production-rbac.ts";
import { VIDEO_STUDIO_STAGE_OWNERSHIP } from "../../../../shared/video-studio-organization.ts";
import { registerVideoProductionRegistryRoutes } from "./video-production-registry.ts";
import { releaseVideoProductionFinalCut } from "../../workflow/video-production-release.ts";
import { VIDEO_PRODUCTION_ASSET_ROOT } from "../../../config/runtime.ts";

export function publishVideoProductionUpdate(
  ctx: Pick<RuntimeContext, "db" | "broadcast">,
  production: VideoProductionSnapshot,
): void {
  ctx.broadcast("tasks_changed", {});
  ctx.broadcast("task_update", ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(production.root_task_id));
  const checkpoint = ctx.db
    .prepare("SELECT * FROM messages WHERE idempotency_key = ?")
    .get(`video-production:${production.project_id}:brief:${production.plan_version}`);
  if (checkpoint) ctx.broadcast("new_message", checkpoint);
}

// The application has one trusted CEO session, not per-agent web credentials.
// Webhook credentials and claimed actor/role fields are never approval authority.
export function requireVideoProductionCeo(req: Request, res: Response): boolean {
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  if (req.method !== "GET" && !hasValidCsrfToken(req)) {
    res.status(403).json({ error: "csrf_token_invalid" });
    return false;
  }
  if (req.method !== "GET" && !isWorkerIsolationReady()) {
    res.status(503).json({ error: "requires_worker_isolation", retryable: false });
    return false;
  }
  return true;
}

function requireVideoProductionConfigurationCeo(req: Request, res: Response): boolean {
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  if (!hasValidCsrfToken(req)) {
    res.status(403).json({ error: "csrf_token_invalid" });
    return false;
  }
  return true;
}

export function respondVideoProductionError(res: Response, error: unknown): void {
  if (error instanceof VideoProductionPolicyError) {
    res.status(error.status).json({ error: error.code });
    return;
  }
  if (error instanceof Error && /SQLITE_BUSY|SQLITE_LOCKED|database is (?:locked|busy)/i.test(error.message)) {
    res.status(503).json({ error: "storage_busy", retryable: true });
    return;
  }
  throw error;
}

type VideoProductionRouteContext = Pick<RuntimeContext, "app" | "db" | "broadcast"> &
  Partial<Pick<RuntimeContext, "activeProcesses" | "stopProgressTimer" | "handleTaskRunComplete" | "scheduleVideoProductionAutoRun">>;

export function registerVideoProductionRoutes(ctx: VideoProductionRouteContext): void {
  registerVideoProductionRegistryRoutes(ctx);
  const { app, db, broadcast, activeProcesses, stopProgressTimer } = ctx;
  const publish = (projectId: string) => {
    const production = getVideoProduction(db, projectId);
    if (production) publishVideoProductionUpdate({ db, broadcast }, production);
    return production;
  };
  const agentFor = (req: Request, projectId: string, action: string) => {
    const actor = getVideoProductionAuthenticatedAgent(req);
    return actor && actor.projectId === projectId && actor.action === action ? actor : null;
  };
  app.post("/api/video-production/organization/setup", (req, res) => {
    if (!requireVideoProductionConfigurationCeo(req, res)) return;
    const savepoint = `vp_setup_${Math.random().toString(36).slice(2)}`;
    let savepointCreated = false;
    try {
      db.exec(`SAVEPOINT ${savepoint}`);
      savepointCreated = true;
      const result = seedVideoProductionOrganization(db, "ceo_session");
      const row = db.prepare("SELECT value FROM settings WHERE key='officePackHydratedPacks'").get() as { value?: string } | undefined;
      let hydrated: string[] = [];
      try { hydrated = JSON.parse(row?.value ?? "[]"); } catch { hydrated = []; }
      if (!Array.isArray(hydrated)) hydrated = [];
      if (!hydrated.includes("video_production")) hydrated.push("video_production");
      db.prepare("INSERT INTO settings(key,value) VALUES('officePackHydratedPacks',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify(hydrated));
      for (const row of db.prepare("SELECT project_id FROM video_productions").all() as Array<{ project_id: string }>) {
        recordVideoProductionEvent(db, row.project_id, "organization_seeded", "ceo_session", { departments: result.departments, agents: result.agents });
      }
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      for (const agent of db.prepare("SELECT * FROM agents WHERE workflow_pack_key='video_production' ORDER BY name").all()) broadcast("agent_created", agent);
      broadcast("departments_changed", { workflow_pack_key: "video_production" });
      res.json({ ok: true, ...result });
    } catch (error) {
      if (savepointCreated) {
        try {
          db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "video_production_setup_rollback_failed");
        }
      }
      respondVideoProductionError(res, error);
    }
  });
  app.get("/api/projects/:id/video-production/organization", (req, res) => {
    const projectId = String(req.params.id);
    const actor = agentFor(req, projectId, "studio.read");
    if (!actor && !requireVideoProductionCeo(req, res)) return;
    try {
      const production = getVideoProduction(db, projectId);
      if (!production) return res.status(404).json({ error: "video_production_not_found" });
      const grants = db.prepare(`SELECT g.agent_id,g.grant_key,g.granted_by,g.created_at,g.revoked_at,r.role_key,a.name,a.department_id
        FROM video_production_project_grants g JOIN video_production_agent_roles r ON r.agent_id=g.agent_id
        JOIN agents a ON a.id=g.agent_id WHERE g.project_id=? ORDER BY a.name`).all(projectId);
      const agents = db.prepare(`SELECT a.id,a.name,a.name_ko,a.department_id,a.role,r.role_key,r.bound_by,r.created_at
        FROM agents a JOIN video_production_agent_roles r ON r.agent_id=a.id
        WHERE a.workflow_pack_key='video_production' ORDER BY a.name`).all();
      const departments = db.prepare(`SELECT department_id,name,name_ko,icon,color,sort_order
        FROM office_pack_departments WHERE workflow_pack_key='video_production' ORDER BY sort_order`).all();
      const profiles = listVideoStudioProfiles();
      const configured = agents.length === profiles.length && profiles.every((profile) => agents.some((agent) => (agent as { id: string; role_key: string }).id === profile.id && (agent as { role_key: string }).role_key === profile.roleKey)) && departments.length === 6;
      res.json({ production, configured, profiles, agents, departments, stages: VIDEO_STUDIO_STAGE_OWNERSHIP, grants });
    } catch (error) { respondVideoProductionError(res, error); }
  });
  app.post("/api/projects/:id/video-production/agents/:agentId/grant", (req, res) => {
    if (!requireVideoProductionConfigurationCeo(req, res)) return;
    try {
      grantVideoProductionProjectAgent(db, { projectId: String(req.params.id), agentId: String(req.params.agentId), grantKey: req.body?.grant_key === "coordinator" ? "coordinator" : "member", grantedBy: "ceo_session" });
      const row = db.prepare("SELECT * FROM video_production_project_grants WHERE project_id=? AND agent_id=?").get(String(req.params.id), String(req.params.agentId));
      res.json({ grant: row });
    } catch (error) { respondVideoProductionError(res, error); }
  });
  app.delete("/api/projects/:id/video-production/agents/:agentId/grant", (req, res) => {
    if (!requireVideoProductionConfigurationCeo(req, res)) return;
    try {
      const revoked = revokeVideoProductionProjectAgent(db, { projectId: String(req.params.id), agentId: String(req.params.agentId), revokedBy: "ceo_session" });
      res.json({ revoked });
    } catch (error) { respondVideoProductionError(res, error); }
  });
  app.get("/api/projects/:id/video-production", (req, res) => {
    if (!requireVideoProductionCeo(req, res)) return;
    res.json({ production: getVideoProduction(db, String(req.params.id)) });
  });
  app.post("/api/projects/:id/video-production/release", async (req, res) => {
    if (!requireVideoProductionCeo(req, res)) return;
    try {
      const expected = req.body?.expected;
      if (!expected || typeof expected !== "object") return res.status(400).json({ error: "final_release_confirmation_required" });
      const result = await releaseVideoProductionFinalCut(db, String(req.params.id), "ceo_session", {
        finalCutArtifactId: String(expected.finalCutArtifactId ?? ""),
        finalAssetId: String(expected.finalAssetId ?? ""), finalAssetSha256: String(expected.finalAssetSha256 ?? ""),
        manifestId: String(expected.manifestId ?? ""), manifestDigest: String(expected.manifestDigest ?? ""),
        timelineArtifactId: String(expected.timelineArtifactId ?? ""), timelineSha256: String(expected.timelineSha256 ?? ""),
        timelineSourceArtifactId: String(expected.timelineSourceArtifactId ?? ""), timelineSourceSha256: String(expected.timelineSourceSha256 ?? ""),
        audioCuesArtifactId: String(expected.audioCuesArtifactId ?? ""), audioAssetId: String(expected.audioAssetId ?? ""), audioSha256: String(expected.audioSha256 ?? ""),
        directorDecisionId: String(expected.directorDecisionId ?? ""), qaArtifactId: String(expected.qaArtifactId ?? ""),
        qaArtifactSha256: String(expected.qaArtifactSha256 ?? ""), qaDecisionId: String(expected.qaDecisionId ?? ""),
      }, VIDEO_PRODUCTION_ASSET_ROOT);
      broadcast("tasks_changed", {});
      broadcast("video_production_registry_changed", { projectId: String(req.params.id) });
      return res.status(result.idempotent ? 200 : 201).json(result);
    } catch (error) { return respondVideoProductionError(res, error); }
  });
  app.put("/api/projects/:id/video-production/plan", (req, res) => {
    const projectId = String(req.params.id);
    const actor = agentFor(req, projectId, "plan.update");
    if (!actor && !requireVideoProductionCeo(req, res)) return;
    if (!isWorkerIsolationReady()) return res.status(503).json({ error: "requires_worker_isolation", retryable: false });
    try {
      saveVideoProductionPlan(db, projectId, {
        brief: req.body?.brief,
        expectedVersion: req.body?.expectedVersion,
        actorId: actor?.agentId ?? "ceo_session",
      });
      res.json({ production: publish(projectId) });
    } catch (error) {
      respondVideoProductionError(res, error);
    }
  });
  app.post("/api/projects/:id/video-production/assignments", (req, res) => {
    const projectId = String(req.params.id);
    const actor = agentFor(req, projectId, "task.assign");
    if (!actor && !requireVideoProductionCeo(req, res)) return;
    if (!isWorkerIsolationReady()) return res.status(503).json({ error: "requires_worker_isolation", retryable: false });
    const taskId = typeof req.body?.task_id === "string" ? req.body.task_id.trim() : "";
    const agentId = typeof req.body?.agent_id === "string" ? req.body.agent_id.trim() : "";
    if (!taskId || !agentId) return res.status(400).json({ error: "task_and_agent_required" });
    try {
      const savepoint = `vp_assign_${Math.random().toString(36).slice(2)}`;
      db.exec(`SAVEPOINT ${savepoint}`);
      let run: unknown;
      try {
        const stage = db.prepare(`SELECT s.stage_key,s.implemented,s.task_id,p.manager_agent_id,t.project_id,t.status
          FROM video_production_stages s JOIN video_productions p ON p.project_id=s.project_id
          JOIN tasks t ON t.id=s.task_id WHERE s.project_id=? AND s.task_id=?`).get(projectId, taskId) as
          | { stage_key: string; implemented: number; task_id: string; manager_agent_id: string; project_id: string; status: string }
          | undefined;
        if (!stage || stage.project_id !== projectId) throw new VideoProductionPolicyError("video_production_task_not_found", 404);
        if (!stage.implemented || stage.stage_key !== "intake_planning") throw new VideoProductionPolicyError("production_stage_not_implemented", 409);
        if (actor && actor.agentId !== stage.manager_agent_id) throw new VideoProductionPolicyError("video_production_manager_required", 403);
        const target = db.prepare("SELECT role_key FROM video_production_agent_roles WHERE agent_id=?").get(agentId) as { role_key: string } | undefined;
        const ownership = VIDEO_STUDIO_STAGE_OWNERSHIP.find((entry) => entry.stageKey === stage.stage_key);
        if (!target || !ownership?.owners.includes(target.role_key as never)) throw new VideoProductionPolicyError("unsupported_stage_assignment", 409);
        if (taskId === stage.task_id && agentId !== stage.manager_agent_id) throw new VideoProductionPolicyError("production_root_manager_invariant", 409);
        if (db.prepare("SELECT 1 FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").get(projectId, agentId) === undefined) {
          throw new VideoProductionPolicyError("video_production_project_grant_required", 403);
        }
        const changed = db.prepare("UPDATE tasks SET assigned_agent_id=?,updated_at=? WHERE id=? AND project_id=? AND status IN ('inbox','pending')")
          .run(agentId, Date.now(), taskId, projectId);
        if (changed.changes !== 1) throw new VideoProductionPolicyError("task_assignment_conflict", 409);
        recordVideoProductionEvent(db, projectId, "task_assigned", actor?.agentId ?? "ceo_session", { taskId, agentId });
        run = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (error) {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
      broadcast("task_update", run);
      res.json({ task: run });
    } catch (error) { respondVideoProductionError(res, error); }
  });
  app.post("/api/projects/:id/video-production/stage-jobs", (req, res) => {
    const projectId = String(req.params.id);
    const actor = agentFor(req, projectId, "task.assign");
    if (!actor && !requireVideoProductionCeo(req, res)) return;
    const worker = probeWorkerIsolation();
    if (!worker.ready || !worker.phase4Ready) return res.status(503).json({ error: "phase4_worker_runner_not_verified", retryable: false });
    try {
      const action = req.body?.action;
      if (!(["screenplay.write", "screenplay.revise", "shot_spec.write", "visual.manage", "edit.manage", "audio.manage", "creative.approve", "footage.submit", "take.review"] as unknown[]).includes(action)) {
        throw new VideoProductionPolicyError("production_stage_action_not_implemented", 501);
      }
      const job = action === "screenplay.write"
        ? createVideoProductionScreenplayJob(db, {
            projectId,
            agentId: String(req.body?.agent_id ?? ""),
            idempotencyKey: String(req.body?.idempotency_key ?? ""),
            createdBy: actor?.agentId ?? "ceo_session",
          })
        : req.body?.action === "creative.approve"
          ? createVideoProductionCreativeReviewJob(db, {
              projectId,
              artifactId: String(req.body?.artifact_id ?? ""),
              agentId: String(req.body?.agent_id ?? ""),
              idempotencyKey: String(req.body?.idempotency_key ?? ""),
              createdBy: actor?.agentId ?? "ceo_session",
            })
          : req.body?.action === "screenplay.revise"
            ? createVideoProductionScreenplayRevisionJob(db, {
                projectId,
                artifactId: String(req.body?.artifact_id ?? ""),
                agentId: String(req.body?.agent_id ?? ""),
                idempotencyKey: String(req.body?.idempotency_key ?? ""),
                createdBy: actor?.agentId ?? "ceo_session",
              })
            : req.body?.action === "shot_spec.write"
              ? createVideoProductionShotSpecJob(db, {
                  projectId,
                  screenplayArtifactId: String(req.body?.artifact_id ?? ""),
                  agentId: String(req.body?.agent_id ?? ""),
                  idempotencyKey: String(req.body?.idempotency_key ?? ""),
                  createdBy: actor?.agentId ?? "ceo_session",
                })
              : req.body?.action === "visual.manage"
                ? createVideoProductionContinuityJob(db, {
                    projectId,
                    shotSpecArtifactId: String(req.body?.artifact_id ?? ""),
                    agentId: String(req.body?.agent_id ?? ""),
                    idempotencyKey: String(req.body?.idempotency_key ?? ""),
                    createdBy: actor?.agentId ?? "ceo_session",
                  })
                : req.body?.action === "edit.manage"
                  ? createVideoProductionTimelinePlanJob(db, {
                      projectId,
                      continuityArtifactId: String(req.body?.artifact_id ?? ""),
                      agentId: String(req.body?.agent_id ?? ""),
                      idempotencyKey: String(req.body?.idempotency_key ?? ""),
                      createdBy: actor?.agentId ?? "ceo_session",
                    })
                  : req.body?.action === "audio.manage"
                    ? createVideoProductionAudioCueJob(db, {
                        projectId,
                        screenplayArtifactId: String(req.body?.artifact_id ?? ""),
                        agentId: String(req.body?.agent_id ?? ""),
                        idempotencyKey: String(req.body?.idempotency_key ?? ""),
                        createdBy: actor?.agentId ?? "ceo_session",
                      })
            : action === "take.review"
              ? createVideoProductionTakeReviewJob(db, {
                  projectId,
                  shotId: String(req.body?.shot_id ?? ""),
                  shotVersion: req.body?.shot_version,
                  agentId: String(req.body?.agent_id ?? ""),
                  idempotencyKey: String(req.body?.idempotency_key ?? ""),
                  createdBy: actor?.agentId ?? "ceo_session",
                })
            : action === "footage.submit"
              ? createVideoProductionShotRenderJob(db, {
            projectId,
            shotId: String(req.body?.shot_id ?? ""),
            shotVersion: req.body?.shot_version,
            agentId: String(req.body?.agent_id ?? ""),
            idempotencyKey: String(req.body?.idempotency_key ?? ""),
            createdBy: actor?.agentId ?? "ceo_session",
              })
              : (() => { throw new VideoProductionPolicyError("production_stage_action_not_implemented", 501); })();
      const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(job.taskId);
      broadcast("task_update", task);
      broadcast("tasks_changed", {});
      res.status(201).json({ job, task });
    } catch (error) { respondVideoProductionError(res, error); }
  });
  app.post("/api/projects/:id/video-production/next-job", (req, res) => {
    const projectId = String(req.params.id);
    const actor = agentFor(req, projectId, "task.assign");
    if (!actor && !requireVideoProductionCeo(req, res)) return;
    const worker = probeWorkerIsolation();
    if (!worker.ready || !worker.phase4Ready) return res.status(503).json({ error: "phase4_worker_runner_not_verified", retryable: false });
    try {
      const job = createNextVideoProductionStageJob(db, projectId, actor?.agentId ?? "ceo_session");
      const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(job.taskId);
      broadcast("task_update", task);
      broadcast("tasks_changed", {});
      return res.status(201).json({ job, task });
    } catch (error) { return respondVideoProductionError(res, error); }
  });
  app.post("/api/tasks/:id/video-production/reconcile", async (req, res) => {
    if (!requireVideoProductionCeo(req, res)) return;
    const taskId = String(req.params.id);
    const attemptId = typeof req.body?.attempt_id === "string" ? req.body.attempt_id.trim() : "";
    if (!attemptId || !ctx.handleTaskRunComplete) return res.status(400).json({ error: "reconciliation_attempt_required" });
    const attempt = db.prepare(`SELECT a.attempt_id,a.state,a.worker_kind,a.worker_identity,a.image_id,a.workspace_path,a.project_id,a.worker_input_digest,
        j.stage_key,j.execution_action,j.shot_id,j.shot_version
      FROM video_production_attempts a JOIN video_production_stage_jobs j ON j.task_id=a.task_id
      WHERE a.task_id=? AND a.attempt_id=?`).get(taskId, attemptId) as
        | { attempt_id: string; state: string; worker_kind: string; worker_identity: string | null; image_id: string | null; workspace_path: string | null; project_id: string; worker_input_digest: string | null; stage_key: string; execution_action: string; shot_id: string | null; shot_version: number | null }
        | undefined;
    const isMiro = attempt?.worker_kind === "phase4_remotion" && attempt.stage_key === "ai_footage_production" && attempt.execution_action === "footage.submit";
    const isLiam = attempt?.worker_kind === "phase4_remotion" && attempt.stage_key === "asset_handoff_rough_cut" && attempt.execution_action === "edit.manage" && Boolean(attempt.worker_input_digest);
    if (!attempt || (!isMiro && !isLiam)) {
      return res.status(404).json({ error: "phase4_attempt_not_found" });
    }
    if (attempt.state === "COMPLETED") {
      const submitted = isMiro
        ? db.prepare("SELECT 1 FROM video_production_takes WHERE project_id=? AND shot_id=? AND shot_version=? AND attempt_id=? LIMIT 1").get(attempt.project_id, attempt.shot_id, attempt.shot_version, attemptId)
        : db.prepare("SELECT 1 FROM video_production_stage_artifacts WHERE project_id=? AND attempt_id=? AND artifact_type='final_cut' AND stage_key='asset_handoff_rough_cut' LIMIT 1").get(attempt.project_id, attemptId);
      if (submitted) return res.json({ ok: true, alreadyReconciled: true });
      return res.status(409).json({ error: "phase4_completed_attempt_missing_import" });
    }
    if (!requireOwnedVideoProductionAttempt(db, taskId, attemptId) || attempt.state !== "RECONCILIATION_REQUIRED" || !attempt.worker_identity || !attempt.image_id || !attempt.workspace_path) {
      return res.status(409).json({ error: "phase4_attempt_not_reconcilable" });
    }
    const inspected = inspectWorkerContainer(attempt.worker_identity, attemptId, attempt.image_id, attempt.workspace_path, "phase4-v1");
    if (!inspected.verified || inspected.state !== "exited" || inspected.exitCode !== 0) {
      return res.status(409).json({ error: "phase4_worker_exit_not_verified" });
    }
    if (!claimVideoProductionAttemptForRecovery(db, taskId, attemptId, isLiam ? "edit.manage" : "footage.submit")) {
      return res.status(409).json({ error: "phase4_recovery_claim_conflict" });
    }
    if (!beginVideoProductionCompletion(db, taskId, attemptId)) return res.status(409).json({ error: "phase4_recovery_claim_conflict" });
    try {
      if (isLiam) await importLiamWorkerOutput({ db, taskId, attemptId, workspacePath: attempt.workspace_path });
      else await importMiroWorkerOutput({ db, taskId, attemptId, workspacePath: attempt.workspace_path });
      ctx.handleTaskRunComplete(taskId, 0, attemptId, true);
      const settled = db.prepare("SELECT state FROM video_production_attempts WHERE task_id=? AND attempt_id=?").get(taskId, attemptId) as { state: string } | undefined;
      if (settled?.state === "COMPLETED") {
        cleanupVerifiedWorkerWorkspacePath(attempt.workspace_path);
        resumeVideoProductionAutoRun(db, taskId);
        ctx.scheduleVideoProductionAutoRun?.();
        return res.json({ ok: true, reconciled: true });
      }
      markVideoProductionAttemptReconciliationRequired(db, taskId, attemptId, { reason: "restart_completion_commit_unconfirmed" });
      return res.status(409).json({ error: "phase4_completion_commit_failed" });
    } catch (error) {
      markVideoProductionAttemptReconciliationRequired(db, taskId, attemptId, { reason: "restart_output_validation_failed" });
      if (error instanceof VideoProductionPolicyError) return res.status(error.status).json({ error: error.code });
      return res.status(409).json({ error: "phase4_output_validation_failed" });
    }
  });
  app.post("/api/projects/:id/video-production/decision", (req, res) => {
    if (!requireVideoProductionCeo(req, res)) return;
    try {
      const projectId = String(req.params.id);
      decideVideoProduction(db, projectId, {
        version: req.body?.version,
        decision: req.body?.decision,
        note: req.body?.note,
        actorId: "ceo_session",
      });
      ctx.scheduleVideoProductionAutoRun?.();
      res.json({ production: publish(projectId) });
    } catch (error) {
      respondVideoProductionError(res, error);
    }
  });
  app.post("/api/tasks/:id/video-production/cancel", (req, res) => {
    if (!requireVideoProductionCeo(req, res)) return;
    const taskId = String(req.params.id);
    const attemptId = typeof req.body?.attempt_id === "string" ? req.body.attempt_id.trim() : "";
    if (!attemptId) return res.status(400).json({ error: "production_attempt_id_required" });
    try {
      const activeChild = activeProcesses?.get(taskId);
      const attempt = db.prepare("SELECT assigned_agent_id,worker_kind,state,detail_json FROM video_production_attempts WHERE task_id=? AND attempt_id=?").get(taskId, attemptId) as { assigned_agent_id: string | null; worker_kind: string; state: string; detail_json: string } | undefined;
      if (attempt?.worker_kind === "phase4_provider_broker") {
        if (attempt.state === "PAUSED") return res.json({ ok: true, cancelled: true, alreadyCancelled: true, status: "pending" });
        if (!requireOwnedVideoProductionAttempt(db, taskId, attemptId) || attempt.state !== "RUNNING") return res.status(409).json({ error: "production_attempt_not_owned" });
        let detail: Record<string, unknown> = {};
        try { detail = JSON.parse(attempt.detail_json) as Record<string, unknown>; } catch { return res.status(409).json({ error: "production_attempt_state_unverified" }); }
        if (detail.cancelRequested === true) return res.status(202).json({ ok: true, cancelRequested: true, status: "stopping" });
        if (!requestVideoProductionProviderAbort(taskId, attemptId)) return res.status(503).json({ error: "provider_attempt_not_locally_active", retryable: false });
        db.prepare("UPDATE video_production_attempts SET detail_json=json_set(detail_json,'$.cancelRequested',1),updated_at=? WHERE task_id=? AND attempt_id=? AND state='RUNNING' AND EXISTS (SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id=? AND attempt_id=?)")
          .run(Date.now(), taskId, attemptId, taskId, attemptId);
        db.prepare("UPDATE video_production_auto_runs SET state='PAUSED',reason='ceo_cancelled',updated_at=? WHERE task_id=? AND state='RUNNING'")
          .run(Date.now(), taskId);
        return res.status(202).json({ ok: true, cancelRequested: true, status: "stopping" });
      }
      const result = cancelVideoProductionAttempt({ db, taskId, attemptId });
      ctx.scheduleVideoProductionAutoRun?.();
      if (!result.alreadyCancelled) {
        requestVideoProductionProviderAbort(taskId, attemptId);
        db.prepare("UPDATE video_production_auto_runs SET state='PAUSED',reason='ceo_cancelled',updated_at=? WHERE task_id=? AND state='RUNNING'")
          .run(Date.now(), taskId);
        if (activeChild && isVideoProductionChildForAttempt(activeChild, attemptId)) activeProcesses?.delete(taskId);
        stopProgressTimer?.(taskId);
        broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId));
        if (attempt?.assigned_agent_id) {
          broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id=?").get(attempt.assigned_agent_id));
        }
      }
      res.json({ ok: true, ...result, status: "pending" });
    } catch (error) {
      respondVideoProductionError(res, error);
    }
  });
}
