import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../bootstrap/schema/task-schema-migrations.ts";
import { ensureVideoProductionSchema } from "../bootstrap/schema/video-production-schema.ts";
import { beginVideoProductionCompletion, claimVideoProductionAttempt, claimVideoProductionAttemptForRecovery, createVideoProductionAudioCueJob, createVideoProductionContinuityJob, createVideoProductionCreativeReviewJob, createVideoProductionRegenerationCoordinatorJob, createVideoProductionScreenplayJob, createVideoProductionScreenplayRevisionJob, createVideoProductionShotRenderJob, createVideoProductionShotSpecJob, createVideoProductionTakeReviewJob, createVideoProductionTimelinePlanJob, decideVideoProduction, finishVideoProductionAttempt, finishVideoProductionCreativeDecision, finishVideoProductionExecutionPendingReview, finishVideoProductionRegenerationRequest, finishVideoProductionVerifiedRoughCut, finishVideoProductionQaDecision, ingestVideoProductionDirective, setVideoProductionAttemptLaunchState } from "./video-production.ts";
import {
  grantVideoProductionProjectAgent,
  createTrustedVideoProductionAttemptActor,
  issueVideoProductionAttemptCredential,
  issueVideoProductionCredential,
  resolveVideoProductionActor,
  seedVideoProductionOrganization,
  videoStudioRoleAllows,
} from "./video-production-rbac.ts";
import { VIDEO_STUDIO_PROFILES } from "../../../shared/video-studio-organization.ts";
import {
  createVideoProductionManifest,
  createVideoProductionScene,
  createVideoProductionShot,
  createVideoProductionTake,
  isVideoProductionManifestCurrent,
  linkVideoProductionShotReference,
  listVideoProductionRegistry,
  registerVideoProductionAsset,
  reorderVideoProductionScenes,
  reorderVideoProductionShots,
  requestVideoProductionRegeneration,
  reviewVideoProductionTake,
  softDeleteVideoProductionScene,
  updateVideoProductionScene,
  updateVideoProductionShot,
} from "./video-production-registry.ts";
import * as registryStorage from "./video-production-registry-storage.ts";
import { storeVideoProductionAsset } from "./video-production-registry-storage.ts";
import { buildMiroWorkerRequest, importMiroWorkerOutput } from "./video-production-stage-runner.ts";
import { localMediaBinaryPath, renderTrustedVideoTimeline, resolveLocalRemotionTools } from "./video-production-media.ts";
import { runAudioCueJob, runDamiRegenerationRequestJob, runHaruScreenplayJob, runHaruShotSpecJob, runLiamTimelinePlanJob, runQuinnFinalQaJob, runRianCreativeReviewJob, runYunaContinuityJob, runYunaTakeReviewJob } from "./video-production-stage-outputs.ts";
import type { VieNeuTtsInput, VieNeuTtsOutput } from "./packs/vieneu-tts.ts";
import { reconcileVideoProductionAttemptsAfterRestart } from "./video-production-execution.ts";
import { createNextVideoProductionStageJob } from "./video-production-dispatch.ts";
import { buildLiamWorkerRequest, importLiamWorkerOutput, stageLiamWorkerInputs } from "./video-production-final-render.ts";
import { Readable } from "node:stream";
import { releaseVideoProductionFinalCut } from "./video-production-release.ts";

const databases: DatabaseSync[] = [];
const folders: string[] = [];
let fixtureSequence = 0;
let localRenderAvailable = false;
try {
  const tools = resolveLocalRemotionTools();
  localRenderAvailable = Boolean(
    tools.browserExecutable &&
    localMediaBinaryPath(tools.binariesDirectory, "ffmpeg") &&
    localMediaBinaryPath(tools.binariesDirectory, "ffprobe"),
  );
} catch {
  localRenderAvailable = false;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function createStudio(db = new DatabaseSync(":memory:")) {
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  ensureVideoProductionSchema(db);
  const department = db.prepare("INSERT OR IGNORE INTO departments(id,name,name_ko,icon,color) VALUES(?,?,?,?,?)");
  for (const [id, name] of [["operations", "Operations"], ["planning", "Planning"], ["design", "Design"], ["dev", "Development"], ["qa", "QA"], ["devsecops", "DevSecOps"]]) {
    department.run(id, name, name, "D", "#777");
  }
  seedVideoProductionOrganization(db, "ceo_session");
  const production = ingestVideoProductionDirective(db, {
    messageId: `registry-${Math.random()}`, content: "Create a shot registry", projectPath: process.cwd(),
    brief: { title: "Registry", objective: "Track shots", targetAudience: "Viewers", duration: "30s", aspectRatio: "16:9", language: "English", style: "Documentary", deliveryPlatform: "Web", constraints: "" },
  });
  decideVideoProduction(db, production.project_id, { version: 1, decision: "approve" });
  return { db, production };
}

function startFakeAttempt(db: DatabaseSync, projectId: string, agentId: string, attemptId: string, taskId: string, stageKey = "story_development") {
  db.prepare("UPDATE video_production_attempts SET state='PAUSED',finished_at=1 WHERE state IN ('PREPARED','LAUNCHING','RUNNING','COMPLETING','RECONCILIATION_REQUIRED')").run();
  db.prepare("UPDATE video_production_slot SET task_id=NULL,attempt_id=NULL,acquired_at=NULL WHERE singleton=1").run();
  db.prepare("UPDATE tasks SET status='done' WHERE project_id=? AND status='in_progress'").run(projectId);
  db.prepare("UPDATE agents SET current_task_id=NULL WHERE current_task_id IS NOT NULL").run();
  const agent = db.prepare("SELECT department_id FROM agents WHERE id=?").get(agentId) as { department_id: string };
  db.prepare(`INSERT INTO tasks(id,title,department_id,assigned_agent_id,project_id,status,workflow_pack_key,created_at,updated_at)
    VALUES(?,?,?,?,?,'in_progress','video_production',1,1)`).run(taskId, "Fixture task", agent.department_id, agentId, projectId);
  db.prepare("UPDATE agents SET current_task_id=? WHERE id=?").run(taskId, agentId);
  db.prepare(`UPDATE video_production_stages SET status='READY',task_id=NULL WHERE project_id=?`).run(projectId);
  db.prepare(`UPDATE video_production_stages SET status='RUNNING',implemented=1,task_id=? WHERE project_id=? AND stage_key=?`)
    .run(taskId, projectId, stageKey);
  db.prepare(`INSERT INTO video_production_attempts(attempt_id,task_id,project_id,state,worker_kind,plan_version,assigned_agent_id,created_at,updated_at,detail_json)
    VALUES(?,?,?,'RUNNING','fixture',1,?,1,1,'{}')`).run(attemptId, taskId, projectId, agentId);
  db.prepare("UPDATE video_production_slot SET task_id=?,attempt_id=?,acquired_at=1 WHERE singleton=1").run(taskId, attemptId);
}

function insertSceneShotAndAsset(db: DatabaseSync, projectId: string, agentId: string, taskId: string, attemptId: string) {
  db.exec("BEGIN");
  try {
    db.prepare(`INSERT INTO video_production_scenes
      (project_id,scene_id,current_version,sort_order,is_required,created_by_agent_id,task_id,attempt_id,attempt_plan_version,created_at,updated_at)
      VALUES(?,'scene-1',1,0,1,?,?,?,1,1,1)`).run(projectId, agentId, taskId, attemptId);
    db.prepare(`INSERT INTO video_production_scene_versions
      (project_id,scene_id,version,sort_order,description,location,characters_json,continuity_json,created_by_agent_id,task_id,attempt_id,attempt_plan_version,created_at)
      VALUES(?,'scene-1',1,0,'Scene description','Studio','["character-a"]','{}',?,?,?,1,1)`).run(projectId, agentId, taskId, attemptId);
    db.prepare(`INSERT INTO video_production_shots
      (project_id,scene_id,shot_id,current_version,sort_order,is_required,created_by_agent_id,task_id,attempt_id,attempt_plan_version,created_at,updated_at)
      VALUES(?,'scene-1','shot-1',1,0,1,?,?,?,1,1,1)`).run(projectId, agentId, taskId, attemptId);
    db.prepare(`INSERT INTO video_production_shot_versions
      (project_id,shot_id,version,scene_id,scene_version,sort_order,action,camera_json,duration_ms,references_json,created_by_agent_id,task_id,attempt_id,attempt_plan_version,created_at)
      VALUES(?,'shot-1',1,'scene-1',1,0,'Subject enters frame','{}',2400,'[]',?,?,?,1,1)`).run(projectId, agentId, taskId, attemptId);
    db.prepare(`INSERT INTO video_production_assets
      (project_id,asset_id,shot_id,shot_version,asset_type,storage_key,sha256,byte_size,content_type,metadata_json,idempotency_key,uploaded_by,task_id,attempt_id,attempt_plan_version,created_at)
      VALUES(?,'asset-1','shot-1',1,'footage',?,'${"a".repeat(64)}',12,'video/mp4','{}','asset-key-1',?,?,?,1,1)`)
      .run(projectId, `${projectId}/${"a".repeat(64)}`, agentId, taskId, attemptId);
    db.prepare(`INSERT INTO video_production_takes
      (project_id,take_id,shot_id,shot_version,take_number,asset_id,attempt_metadata_json,content_fingerprint,submitted_by,task_id,attempt_id,attempt_plan_version,submitted_at)
      VALUES(?,'take-1','shot-1',1,1,'asset-1','{"model":"fixture","prompt":"fixture"}','${"b".repeat(64)}',?,?,?,1,1)`)
      .run(projectId, agentId, taskId, attemptId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function getScopedActor(db: DatabaseSync, projectId: string, agentId: string, action: "screenplay.write" | "shot_spec.write" | "visual.manage" | "footage.submit" | "take.review" | "edit.manage" | "regeneration.request", stageKey: string) {
  const sequence = ++fixtureSequence;
  const attemptId = `attempt-${sequence}`;
  const taskId = `task-${sequence}`;
  startFakeAttempt(db, projectId, agentId, attemptId, taskId, stageKey);
  const expiresAt = 2_100_000;
  const credential = issueVideoProductionAttemptCredential(db, { attemptId, scopes: [action], expiresAt }, { now: 2_000_000, enabled: true, isolationReady: true });
  const actor = resolveVideoProductionActor(db, credential.token, projectId, action, { now: 2_000_001, enabled: true, isolationReady: true });
  if (!actor) throw new Error(`fixture_actor_failed:${action}`);
  return actor;
}

describe("Video Production Shot and Asset Registry foundation", () => {
  it("records Dami's idempotent rejected-shot request and queues only that shot while approved sibling stays pinned", () => {
    const { db, production } = createStudio();
    const damiId = "video_production-seed-5";
    const miroId = "video_production-role-video-producer";
    const yunaId = "video_production-role-art-director";
    grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId: damiId, grantKey: "coordinator", grantedBy: "ceo_session" });
    grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId: miroId, grantedBy: "ceo_session" });
    grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId: yunaId, grantedBy: "ceo_session" });
    const miro = getScopedActor(db, production.project_id, miroId, "footage.submit", "ai_footage_production");
    const miroTaskId = miro.taskId; const miroAttemptId = miro.attemptId;
    if (!miroTaskId || !miroAttemptId) throw new Error("fixture_miro_attempt_missing");
    insertSceneShotAndAsset(db, production.project_id, miroId, miroTaskId, miroAttemptId);
    db.exec("BEGIN");
    try {
      db.prepare(`INSERT INTO video_production_shots(project_id,scene_id,shot_id,current_version,sort_order,is_required,created_by_agent_id,task_id,attempt_id,attempt_plan_version,created_at,updated_at)
        VALUES(?,'scene-1','shot-2',1,1,1,?,?,?,1,1,1)`).run(production.project_id, miroId, miroTaskId, miroAttemptId);
      db.prepare(`INSERT INTO video_production_shot_versions(project_id,shot_id,version,scene_id,scene_version,sort_order,action,camera_json,duration_ms,references_json,created_by_agent_id,task_id,attempt_id,attempt_plan_version,created_at)
        VALUES(?,'shot-2',1,'scene-1',1,1,'Second shot','{}',2400,'[]',?,?,?,1,1)`).run(production.project_id, miroId, miroTaskId, miroAttemptId);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    db.prepare(`INSERT INTO video_production_assets(project_id,asset_id,shot_id,shot_version,asset_type,storage_key,sha256,byte_size,content_type,metadata_json,idempotency_key,uploaded_by,task_id,attempt_id,attempt_plan_version,created_at)
      VALUES(?,'asset-2','shot-2',1,'footage',?,'${"c".repeat(64)}',12,'video/mp4','{}','asset-key-2',?,?,?,1,1)`)
      .run(production.project_id, `${production.project_id}/${"c".repeat(64)}`, miroId, miroTaskId, miroAttemptId);
    db.prepare(`INSERT INTO video_production_takes(project_id,take_id,shot_id,shot_version,take_number,asset_id,attempt_metadata_json,content_fingerprint,submitted_by,task_id,attempt_id,attempt_plan_version,submitted_at)
      VALUES(?,'take-2','shot-2',1,1,'asset-2','{}','${"d".repeat(64)}',?,?,?,1,1)`).run(production.project_id, miroId, miroTaskId, miroAttemptId);

    const yuna = getScopedActor(db, production.project_id, yunaId, "take.review", "ai_footage_production");
    const yunaTaskId = yuna.taskId; const yunaAttemptId = yuna.attemptId;
    if (!yunaTaskId || !yunaAttemptId) throw new Error("fixture_yuna_attempt_missing");
    const reviewRows = db.prepare(`INSERT INTO video_production_take_reviews(project_id,review_id,take_id,shot_id,shot_version,asset_id,review_number,decision,feedback,content_fingerprint,reviewer_agent_id,task_id,attempt_id,attempt_plan_version,created_at)
      VALUES(?,?,?,?,?, ?,1,?,?,?, ?,?,?,1,1)`);
    reviewRows.run(production.project_id, "review-rejected-shot-1", "take-1", "shot-1", 1, "asset-1", "rejected", "Fix the framing on shot one.", "b".repeat(64), yunaId, yunaTaskId, yunaAttemptId);
    reviewRows.run(production.project_id, "review-approved-shot-2", "take-2", "shot-2", 1, "asset-2", "approved", "Approved sibling shot.", "d".repeat(64), yunaId, yunaTaskId, yunaAttemptId);
    db.prepare("INSERT INTO video_production_approved_takes(project_id,shot_id,take_id,shot_version,asset_id,review_id,updated_at) VALUES(?,?,?,?,?,?,1)")
      .run(production.project_id, "shot-2", "take-2", 1, "asset-2", "review-approved-shot-2");
    db.prepare(`INSERT INTO video_production_stage_jobs(task_id,project_id,plan_version,stage_key,execution_action,assigned_agent_id,idempotency_key,shot_id,shot_version,target_take_id,target_asset_id,target_asset_sha256,state,created_by,created_at,updated_at)
      VALUES(?,?,1,'ai_footage_production','take.review',?,'prior-yuna-shot-1','shot-1',1,'take-1','asset-1','${"a".repeat(64)}','COMPLETED','ceo_session',1,1)`).run(yunaTaskId, production.project_id, yunaId);
    db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(yunaTaskId);
    db.prepare("UPDATE video_production_attempts SET state='COMPLETED',finished_at=1 WHERE attempt_id=?").run(yunaAttemptId);
    db.prepare("UPDATE video_production_slot SET task_id=NULL,attempt_id=NULL,acquired_at=NULL WHERE singleton=1 AND task_id=? AND attempt_id=?").run(yunaTaskId, yunaAttemptId);
    db.prepare("UPDATE video_production_stages SET implemented=1,status='COMPLETED' WHERE project_id=? AND stage_order<(SELECT stage_order FROM video_production_stages WHERE project_id=? AND stage_key='ai_footage_production')").run(production.project_id, production.project_id);
    db.prepare("UPDATE video_production_stages SET implemented=1,status='BLOCKED',task_id=? WHERE project_id=? AND stage_key='ai_footage_production'").run(yunaTaskId, production.project_id);

    const coordinatorJob = createVideoProductionRegenerationCoordinatorJob(db, { projectId: production.project_id, shotId: "shot-1", shotVersion: 1, rejectedTakeId: "take-1", idempotencyKey: "request-shot-1", createdBy: "ceo_session" });
    const damiAttempt = "regen-dami-attempt";
    claimVideoProductionAttempt(db, coordinatorJob.taskId, damiAttempt, "phase4_provider_broker", damiId, undefined, "regeneration.request");
    expect(setVideoProductionAttemptLaunchState(db, coordinatorJob.taskId, damiAttempt, "RUNNING")).toBe(true);
    db.prepare("UPDATE agents SET status='working',current_task_id=? WHERE id=?").run(coordinatorJob.taskId, damiId);
    expect(runDamiRegenerationRequestJob({ db, taskId: coordinatorJob.taskId, attemptId: damiAttempt })).toMatchObject({ shotId: "shot-1", rejectedTakeId: "take-1", idempotent: false });
    expect(beginVideoProductionCompletion(db, coordinatorJob.taskId, damiAttempt)).toBe(true);
    expect(finishVideoProductionRegenerationRequest(db, coordinatorJob.taskId, damiAttempt)).toBe(true);
    const regen = db.prepare("SELECT request_id,idempotency_key,rejected_take_id FROM video_production_regeneration_requests WHERE project_id=?").get(production.project_id) as { request_id: string; idempotency_key: string; rejected_take_id: string };
    expect(regen.rejected_take_id).toBe("take-1");
    const renderKey = `render_${createHash("sha256").update(regen.idempotency_key).digest("hex").slice(0, 32)}`;
    const render = createVideoProductionShotRenderJob(db, { projectId: production.project_id, shotId: "shot-1", shotVersion: 1, agentId: miroId, idempotencyKey: renderKey, createdBy: "video_production-seed-5" });
    expect(render).toMatchObject({ shotId: "shot-1", shotVersion: 1 });
    expect(db.prepare("SELECT take_id,asset_id FROM video_production_approved_takes WHERE project_id=? AND shot_id='shot-2'").get(production.project_id)).toEqual({ take_id: "take-2", asset_id: "asset-2" });
    expect(db.prepare("SELECT shot_id,shot_version FROM video_production_stage_jobs WHERE task_id=?").get(render.taskId)).toEqual({ shot_id: "shot-1", shot_version: 1 });
  });

  it("creates only the first approved-plan Haru screenplay action with a durable role and action binding", () => {
    const { db, production } = createStudio();
    const haruId = "video_production-role-screenwriter";
    grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId: haruId, grantedBy: "ceo_session" });
    const input = { projectId: production.project_id, agentId: haruId, idempotencyKey: "story-v1", createdBy: "ceo_session" };
    const created = createVideoProductionScreenplayJob(db, input);
    expect(createVideoProductionScreenplayJob(db, input)).toEqual(created);
    expect(db.prepare("SELECT stage_key,execution_action,assigned_agent_id,shot_id,shot_version,state FROM video_production_stage_jobs WHERE task_id=?").get(created.taskId)).toEqual({
      stage_key: "story_development", execution_action: "screenplay.write", assigned_agent_id: haruId, shot_id: null, shot_version: null, state: "READY",
    });
    expect(db.prepare("SELECT status,implemented,task_id FROM video_production_stages WHERE project_id=? AND stage_key='story_development'").get(production.project_id)).toEqual({ status: "READY", implemented: 1, task_id: created.taskId });
    expect(() => createVideoProductionScreenplayJob(db, { ...input, idempotencyKey: "story-v2", agentId: "video_production-role-director" })).toThrow("production_stage_already_has_current_job");
  });

  it("runs Haru's typed screenplay job once, persists immutable scene output, and never replays the provider call", async () => {
    const { db, production } = createStudio();
    const haruId = "video_production-role-screenwriter";
    grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId: haruId, grantedBy: "ceo_session" });
    db.prepare("INSERT INTO api_providers(id,name,type,base_url,enabled) VALUES('fixture-provider','Fixture','custom','https://provider.example.test/v1',1)").run();
    db.prepare("UPDATE agents SET api_provider_id='fixture-provider',api_model='fixture-model' WHERE id=?").run(haruId);
    const job = createVideoProductionScreenplayJob(db, { projectId: production.project_id, agentId: haruId, idempotencyKey: "haru-run-once", createdBy: "ceo_session" });
    const attemptId = "haru-provider-attempt-1";
    claimVideoProductionAttempt(db, job.taskId, attemptId, "phase4_provider_broker", haruId, undefined, "screenplay.write");
    db.prepare("UPDATE agents SET status='working',current_task_id=? WHERE id=?").run(job.taskId, haruId);
    setVideoProductionAttemptLaunchState(db, job.taskId, attemptId, "RUNNING");
    const candidate = { title: "A New Beginning", logline: "A worker discovers a hidden garden.", screenplay: "INT. WORKSHOP - DAY\nARI opens the door.", scenes: [{ sceneId: "scene-haru-1", content: { description: "Ari enters the garden.", location: "Workshop garden", characters: ["Ari"], continuity: { key: "door-open" } } }] };
    const fetchImpl = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(candidate) } }] }), { status: 200 }));
    const result = await runHaruScreenplayJob({ db, taskId: job.taskId, attemptId, fetchImpl });
    expect(result).toMatchObject({ sceneIds: ["scene-haru-1"] });
    expect(db.prepare("SELECT artifact_type,stage_key,content_sha256 FROM video_production_stage_artifacts WHERE task_id=? AND attempt_id=?").get(job.taskId, attemptId)).toMatchObject({ artifact_type: "screenplay", stage_key: "story_development", content_sha256: result.sha256 });
    expect(db.prepare("SELECT scene_id,current_version FROM video_production_scenes WHERE project_id=?").get(production.project_id)).toEqual({ scene_id: "scene-haru-1", current_version: 1 });
    await expect(runHaruScreenplayJob({ db, taskId: job.taskId, attemptId, fetchImpl })).resolves.toEqual(result);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("aborts Haru's exact pending provider attempt without persisting late output", async () => {
    const { db, production } = createStudio();
    const haruId = "video_production-role-screenwriter";
    grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId: haruId, grantedBy: "ceo_session" });
    db.prepare("INSERT INTO api_providers(id,name,type,base_url,enabled) VALUES('abort-provider','Fixture','custom','https://provider.example.test/v1',1)").run();
    db.prepare("UPDATE agents SET api_provider_id='abort-provider',api_model='fixture-model' WHERE id=?").run(haruId);
    const job = createVideoProductionScreenplayJob(db, { projectId: production.project_id, agentId: haruId, idempotencyKey: "haru-abort", createdBy: "ceo_session" });
    const attemptId = "haru-provider-attempt-abort";
    claimVideoProductionAttempt(db, job.taskId, attemptId, "phase4_provider_broker", haruId, undefined, "screenplay.write");
    db.prepare("UPDATE agents SET status='working',current_task_id=? WHERE id=?").run(job.taskId, haruId);
    const controller = new AbortController();
    setVideoProductionAttemptLaunchState(db, job.taskId, attemptId, "RUNNING");
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      markFetchStarted();
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const pending = runHaruScreenplayJob({ db, taskId: job.taskId, attemptId, fetchImpl, signal: controller.signal });
    await fetchStarted;
    controller.abort();
    await expect(pending).rejects.toThrow("video_provider_cancelled");
    expect(db.prepare("SELECT COUNT(*) AS count FROM video_production_stage_artifacts WHERE task_id=? AND attempt_id=?").get(job.taskId, attemptId)).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM video_production_scenes WHERE project_id=?").get(production.project_id)).toEqual({ count: 0 });
    expect(db.prepare("SELECT state FROM video_production_attempts WHERE task_id=? AND attempt_id=?").get(job.taskId, attemptId)).toEqual({ state: "RUNNING" });
  });

  it("settles committed Haru output after file-backed restart and never replays an interrupted provider call", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "vp-haru-restart-"));
    folders.push(directory);
    const file = path.join(directory, "production.sqlite");
    let db = new DatabaseSync(file);
    const { production } = createStudio(db);
    const haruId = "video_production-role-screenwriter";
    grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId: haruId, grantedBy: "ceo_session" });
    db.prepare("INSERT INTO api_providers(id,name,type,base_url,enabled) VALUES('restart-provider','Fixture','custom','https://provider.example.test/v1',1)").run();
    db.prepare("UPDATE agents SET api_provider_id='restart-provider',api_model='fixture-model' WHERE id=?").run(haruId);
    const job = createVideoProductionScreenplayJob(db, { projectId: production.project_id, agentId: haruId, idempotencyKey: "haru-restart", createdBy: "ceo_session" });
    const attemptId = "haru-provider-attempt-restart";
    claimVideoProductionAttempt(db, job.taskId, attemptId, "phase4_provider_broker", haruId, undefined, "screenplay.write");
    db.prepare("UPDATE agents SET status='working',current_task_id=? WHERE id=?").run(job.taskId, haruId);
    setVideoProductionAttemptLaunchState(db, job.taskId, attemptId, "RUNNING");
    const candidate = { title: "Restart safe", logline: "A continuity check.", screenplay: "INT. ROOM - DAY", scenes: [{ sceneId: "scene-restart", content: { description: "A quiet room.", location: "Room", characters: [], continuity: {} } }] };
    const fetchImpl = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(candidate) } }] }), { status: 200 }));
    await runHaruScreenplayJob({ db, taskId: job.taskId, attemptId, fetchImpl });
    const priorIndex = databases.indexOf(db);
    databases.splice(priorIndex, 1);
    db.close();
    db = new DatabaseSync(file);
    databases.push(db);
    expect(reconcileVideoProductionAttemptsAfterRestart(db, () => ({ state: "unknown", verified: false }))).toContainEqual({ taskId: job.taskId, attemptId, state: "review" });
    expect(db.prepare("SELECT status FROM tasks WHERE id=?").get(job.taskId)).toEqual({ status: "review" });
    expect(db.prepare("SELECT task_id,attempt_id FROM video_production_slot WHERE singleton=1").get()).toEqual({ task_id: null, attempt_id: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("hands the pinned screenplay to Rian, completes only approval, and keeps requested changes revisable", async () => {
    for (const decision of ["approved", "changes_requested"] as const) {
      const { db, production } = createStudio();
      const haruId = "video_production-role-screenwriter";
      const rianId = "video_production-role-director";
      db.prepare("INSERT INTO api_providers(id,name,type,base_url,enabled) VALUES('review-provider','Fixture','custom','https://provider.example.test/v1',1)").run();
      for (const agentId of [haruId, rianId]) {
        grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId, grantedBy: "ceo_session" });
        db.prepare("UPDATE agents SET api_provider_id='review-provider',api_model=? WHERE id=?").run(agentId === haruId ? "haru-model" : "rian-model", agentId);
      }
      const screenplayJob = createVideoProductionScreenplayJob(db, { projectId: production.project_id, agentId: haruId, idempotencyKey: `script-${decision}`, createdBy: "ceo_session" });
      const haruAttempt = `haru-${decision}`;
      claimVideoProductionAttempt(db, screenplayJob.taskId, haruAttempt, "phase4_provider_broker", haruId, undefined, "screenplay.write");
      db.prepare("UPDATE agents SET status='working',current_task_id=? WHERE id=?").run(screenplayJob.taskId, haruId);
      setVideoProductionAttemptLaunchState(db, screenplayJob.taskId, haruAttempt, "RUNNING");
      const output = { title: "Reviewable", logline: "A clear story.", screenplay: "INT. GARDEN - DAY", scenes: [{ sceneId: "scene-review", content: { description: "Ari arrives.", location: "Garden", characters: ["Ari"], continuity: { motif: "blue door" } } }] };
      const haruFetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), { status: 200 }));
      const submitted = await runHaruScreenplayJob({ db, taskId: screenplayJob.taskId, attemptId: haruAttempt, fetchImpl: haruFetch });
      expect(finishVideoProductionExecutionPendingReview(db, screenplayJob.taskId, haruAttempt)).toBe(true);

      const reviewJob = createVideoProductionCreativeReviewJob(db, { projectId: production.project_id, artifactId: submitted.artifactId, agentId: rianId, idempotencyKey: `review-${decision}`, createdBy: "ceo_session" });
      expect(reviewJob).toMatchObject({ action: "creative.approve", artifactId: submitted.artifactId, agentId: rianId });
      const rianAttempt = `rian-${decision}`;
      claimVideoProductionAttempt(db, reviewJob.taskId, rianAttempt, "phase4_provider_broker", rianId, undefined, "creative.approve");
      db.prepare("UPDATE agents SET status='working',current_task_id=? WHERE id=?").run(reviewJob.taskId, rianId);
      setVideoProductionAttemptLaunchState(db, reviewJob.taskId, rianAttempt, "RUNNING");
      const reviewOutput = { decision, feedback: decision === "approved" ? "The story is coherent." : "Clarify why Ari enters the garden." };
      const rianFetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reviewOutput) } }] }), { status: 200 }));
      const recorded = await runRianCreativeReviewJob({ db, taskId: reviewJob.taskId, attemptId: rianAttempt, fetchImpl: rianFetch });
      expect(recorded).toMatchObject({ artifactId: submitted.artifactId, decision });
      await expect(runRianCreativeReviewJob({ db, taskId: reviewJob.taskId, attemptId: rianAttempt, fetchImpl: rianFetch })).resolves.toEqual(recorded);
      expect(rianFetch).toHaveBeenCalledTimes(1);
      expect(beginVideoProductionCompletion(db, reviewJob.taskId, rianAttempt)).toBe(true);
      expect(finishVideoProductionCreativeDecision(db, reviewJob.taskId, rianAttempt)).toBe(true);
      expect(db.prepare("SELECT status FROM video_production_stages WHERE project_id=? AND stage_key='story_development'").get(production.project_id)).toEqual({ status: decision === "approved" ? "COMPLETED" : "BLOCKED" });
      expect(db.prepare("SELECT status FROM tasks WHERE id=?").get(screenplayJob.taskId)).toEqual({ status: "done" });

      if (decision === "changes_requested") {
        const revisionJob = createVideoProductionScreenplayRevisionJob(db, { projectId: production.project_id, artifactId: submitted.artifactId, agentId: haruId, idempotencyKey: "screenplay-revision-1", createdBy: "ceo_session" });
        expect(revisionJob).toMatchObject({ action: "screenplay.write", artifactId: submitted.artifactId });
        const revisionAttempt = "haru-revision-1";
        claimVideoProductionAttempt(db, revisionJob.taskId, revisionAttempt, "phase4_provider_broker", haruId, undefined, "screenplay.write");
        db.prepare("UPDATE agents SET status='working',current_task_id=? WHERE id=?").run(revisionJob.taskId, haruId);
        setVideoProductionAttemptLaunchState(db, revisionJob.taskId, revisionAttempt, "RUNNING");
        const revised = { ...output, screenplay: "INT. GARDEN - DAY\\nARI explains the blue door.", scenes: [{ ...output.scenes[0]!, content: { ...output.scenes[0]!.content, description: "Ari explains the blue door before entering." } }] };
        const reviseFetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(revised) } }] }), { status: 200 }));
        const revision = await runHaruScreenplayJob({ db, taskId: revisionJob.taskId, attemptId: revisionAttempt, fetchImpl: reviseFetch });
        expect(revision.artifactId).not.toBe(submitted.artifactId);
        expect(db.prepare("SELECT current_version FROM video_production_scenes WHERE project_id=? AND scene_id='scene-review'").get(production.project_id)).toEqual({ current_version: 2 });
        expect(finishVideoProductionExecutionPendingReview(db, revisionJob.taskId, revisionAttempt)).toBe(true);
        const nextReview = createVideoProductionCreativeReviewJob(db, { projectId: production.project_id, artifactId: revision.artifactId, agentId: rianId, idempotencyKey: "review-revision-1", createdBy: "ceo_session" });
        expect(nextReview.artifactId).toBe(revision.artifactId);
      }
    }
  });

  it.skipIf(!localRenderAvailable)("hands approved story through Haru, Yuna, Liam, Rian and Audio Producer into an exact Miro shot job", async () => {
    const restartDirectory = mkdtempSync(path.join(tmpdir(), "vp-liam-end-to-end-restart-"));
    folders.push(restartDirectory);
    let db = new DatabaseSync(path.join(restartDirectory, "studio.sqlite"));
    const { production } = createStudio(db);
    const ids = {
      haru: "video_production-role-screenwriter", yuna: "video_production-role-art-director",
      liam: "video_production-role-editor", rian: "video_production-role-director",
      audio: "video_production-role-sound-producer", miro: "video_production-role-video-producer", qa: "video_production-role-qa-supervisor",
    };
    db.prepare("INSERT INTO api_providers(id,name,type,base_url,enabled) VALUES('pipeline-provider','Fixture','custom','https://provider.example.test/v1',1)").run();
    for (const agentId of Object.values(ids)) {
      grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId, grantedBy: "ceo_session" });
      db.prepare("UPDATE agents SET api_provider_id='pipeline-provider',api_model='gpt-4o-fixture' WHERE id=?").run(agentId);
    }
    const task = (agentId: string, title: string) => db.prepare("SELECT id FROM tasks WHERE assigned_agent_id=? AND project_id=? ORDER BY created_at DESC LIMIT 1").get(agentId, production.project_id);
    let call = 0;
    const responses: unknown[] = [];
    const fetchNext = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
      const value = responses[call++];
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { status: 200 });
    });
    const start = (taskId: string, agentId: string, action: string, attemptId: string) => {
      claimVideoProductionAttempt(db, taskId, attemptId, "phase4_provider_broker", agentId, undefined, action);
      db.prepare("UPDATE agents SET status='working',current_task_id=? WHERE id=?").run(taskId, agentId);
      setVideoProductionAttemptLaunchState(db, taskId, attemptId, "RUNNING");
    };
    const settleOutput = (taskId: string, attemptId: string) => expect(finishVideoProductionExecutionPendingReview(db, taskId, attemptId)).toBe(true);
    const review = async (artifactId: string, idem: string) => {
      const rianJob = createNextVideoProductionStageJob(db, production.project_id, "ceo_session");
      expect(rianJob).toMatchObject({ action: "creative.approve", artifactId });
      const attemptId = `rian-${idem}`;
      start(rianJob.taskId, ids.rian, "creative.approve", attemptId);
      responses.push({ decision: "approved", feedback: "Approved against the pinned input version." });
      await runRianCreativeReviewJob({ db, taskId: rianJob.taskId, attemptId, fetchImpl: fetchNext });
      expect(beginVideoProductionCompletion(db, rianJob.taskId, attemptId)).toBe(true);
      expect(finishVideoProductionCreativeDecision(db, rianJob.taskId, attemptId)).toBe(true);
    };

    const haruJob = createNextVideoProductionStageJob(db, production.project_id, "ceo_session");
    const haruAttempt = "pipeline-haru";
    start(haruJob.taskId, ids.haru, "screenplay.write", haruAttempt);
    responses.push({ title: "Garden", logline: "Ari enters a garden.", screenplay: "INT. GARDEN - DAY\\nARI opens a blue door.", scenes: [{ sceneId: "pipeline-scene", content: { description: "Ari enters a garden.", location: "Garden", characters: ["Ari"], continuity: { door: "blue" } } }] });
    const script = await runHaruScreenplayJob({ db, taskId: haruJob.taskId, attemptId: haruAttempt, fetchImpl: fetchNext });
    settleOutput(haruJob.taskId, haruAttempt);
    await review(script.artifactId, "pipeline-review-script");

    const shotJob = createNextVideoProductionStageJob(db, production.project_id, "ceo_session");
    const shotAttempt = "pipeline-shots";
    start(shotJob.taskId, ids.haru, "shot_spec.write", shotAttempt);
    responses.push({ scenes: [{ sceneId: "pipeline-scene", shots: [{ shotId: "pipeline-shot", action: "Ari opens the blue door.", camera: { framing: "wide" }, durationMs: 1800, required: true }] }] });
    const shotSpec = await runHaruShotSpecJob({ db, taskId: shotJob.taskId, attemptId: shotAttempt, fetchImpl: fetchNext });
    settleOutput(shotJob.taskId, shotAttempt);

    const yunaJob = createNextVideoProductionStageJob(db, production.project_id, "ceo_session");
    const yunaAttempt = "pipeline-yuna";
    start(yunaJob.taskId, ids.yuna, "visual.manage", yunaAttempt);
    responses.push({ notes: [{ scope: "prop", subject: "Blue door", description: "Keep the door's blue paint and brass handle consistent.", sceneIds: ["pipeline-scene"] }], referenceRequests: [{ referenceType: "prop", subject: "Blue door", brief: "A weathered blue garden door with a brass handle." }] });
    const continuity = await runYunaContinuityJob({ db, taskId: yunaJob.taskId, attemptId: yunaAttempt, fetchImpl: fetchNext });
    settleOutput(yunaJob.taskId, yunaAttempt);

    const liamJob = createNextVideoProductionStageJob(db, production.project_id, "ceo_session");
    const liamAttempt = "pipeline-liam";
    start(liamJob.taskId, ids.liam, "edit.manage", liamAttempt);
    responses.push({ shots: [{ shotId: "pipeline-shot", shotVersion: 1, durationMs: 1800, transitionAfter: "cut", transitionDurationMs: 0, subtitleText: "" }] });
    const timeline = await runLiamTimelinePlanJob({ db, taskId: liamJob.taskId, attemptId: liamAttempt, fetchImpl: fetchNext });
    settleOutput(liamJob.taskId, liamAttempt);
    await review(timeline.artifactId, "pipeline-review-timeline");

    const audioJob = createNextVideoProductionStageJob(db, production.project_id, "ceo_session");
    const audioAttempt = "pipeline-audio";
    start(audioJob.taskId, ids.audio, "audio.manage", audioAttempt);
    responses.push({ narration: "Ari opens the blue door and steps into the garden.", voice: "Minh Quân", speed: 1 });
    const storageRoot = mkdtempSync(path.join(tmpdir(), "vp-audio-registry-"));
    folders.push(storageRoot);
    const synthesize = async (ttsInput: VieNeuTtsInput): Promise<VieNeuTtsOutput> => {
      const output = path.join(ttsInput.projectRoot, ttsInput.outputPath);
      execFileSync(localMediaBinaryPath(resolveLocalRemotionTools().binariesDirectory, "ffmpeg"), ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "1.8", "-ac", "2", "-codec:a", "libmp3lame", "-q:a", "8", output], { windowsHide: true });
      return { outputPath: ttsInput.outputPath, bytes: statSync(output).size, durationSeconds: 1.8, voice: ttsInput.voice ?? "Minh Quân", cues: [{ text: ttsInput.text, startSeconds: 0, endSeconds: 1.8 }], engine: "vieneu-tts" };
    };
    const audio = await runAudioCueJob({ db, taskId: audioJob.taskId, attemptId: audioAttempt, fetchImpl: fetchNext, assetRoot: storageRoot, synthesize });
    expect(db.prepare("SELECT asset_type,sha256 FROM video_production_assets WHERE project_id=? AND asset_id=?").get(production.project_id, audio.assetId)).toMatchObject({ asset_type: "audio", sha256: audio.sha256 });
    settleOutput(audioJob.taskId, audioAttempt);
    await review(audio.artifactId, "pipeline-review-audio");

    const miroJob = createNextVideoProductionStageJob(db, production.project_id, "ceo_session");
    expect(miroJob).toMatchObject({ stageKey: "ai_footage_production", action: "footage.submit", shotId: "pipeline-shot", shotVersion: 1 });
    const miroRequest = JSON.parse(await buildMiroWorkerRequest({ db, taskId: miroJob.taskId, workspaceAttemptId: "123e4567-e89b-42d3-a456-426614174000" }));
    expect(miroRequest).toMatchObject({ operation: "render-shot", shot: { shotId: "pipeline-shot", shotVersion: 1, durationFrames: 54 } });
    const miroAttempt = "123e4567-e89b-42d3-a456-426614174001";
    claimVideoProductionAttempt(db, miroJob.taskId, miroAttempt, "phase4_remotion", ids.miro, undefined, "footage.submit");
    db.prepare("UPDATE agents SET status='working',current_task_id=? WHERE id=?").run(miroJob.taskId, ids.miro);
    setVideoProductionAttemptLaunchState(db, miroJob.taskId, miroAttempt, "RUNNING");
    const miroCredential = issueVideoProductionAttemptCredential(db, { attemptId: miroAttempt, scopes: ["footage.submit"], expiresAt: 2_100_000 }, { now: 2_000_000, enabled: true, isolationReady: true });
    const miroActor = resolveVideoProductionActor(db, miroCredential.token, production.project_id, "footage.submit", { now: 2_000_001, enabled: true, isolationReady: true });
    if (!miroActor) throw new Error("fixture_miro_actor_missing");
    const clipWorkspace = mkdtempSync(path.join(tmpdir(), "vp-liam-approved-clip-"));
    folders.push(clipWorkspace);
    const clipRender = await renderTrustedVideoTimeline({ workspacePath: clipWorkspace, approvedAssetRoot: clipWorkspace,
      shots: [{ shotId: "pipeline-shot", title: "Fixture", action: "Ari opens the blue door", durationFrames: 54 }], fps: 30, width: 1280, height: 720, outputName: "approved.mp4" });
    const clipBytes = readFileSync(clipRender.outputPath);
    const clip = await storeVideoProductionAsset(storageRoot, { projectId: production.project_id, assetType: "footage", contentType: "video/mp4", source: Readable.from([clipBytes]) });
    await registerVideoProductionAsset(db, miroActor, { projectId: production.project_id, assetId: "pipeline-clip", assetType: "footage", stored: clip,
      metadata: { label: "fixture clip", technicalMetadata: { width: 1280, height: 720, frameRate: 30, durationMs: 1800 } }, idempotencyKey: "pipeline-clip-key", shotId: "pipeline-shot", shotVersion: 1 }, storageRoot);
    const submittedTake = createVideoProductionTake(db, miroActor, production.project_id, "pipeline-shot", { shotVersion: 1, assetId: "pipeline-clip", metadata: { model: "fixture", prompt: "fixture render", reportedValidation: { width: 1280, height: 720, frameRate: 30, durationMs: 1800 } } });
    expect(finishVideoProductionExecutionPendingReview(db, miroJob.taskId, miroAttempt)).toBe(true);
    const yunaReviewJob = createVideoProductionTakeReviewJob(db, { projectId: production.project_id, shotId: "pipeline-shot", shotVersion: 1, agentId: ids.yuna, idempotencyKey: "pipeline-yuna-take-review", createdBy: "ceo_session" });
    const yunaTakeReviewAttempt = "123e4567-e89b-42d3-a456-426614174002";
    claimVideoProductionAttempt(db, yunaReviewJob.taskId, yunaTakeReviewAttempt, "phase4_provider_broker", ids.yuna, undefined, "take.review");
    db.prepare("UPDATE agents SET status='working',current_task_id=? WHERE id=?").run(yunaReviewJob.taskId, ids.yuna);
    setVideoProductionAttemptLaunchState(db, yunaReviewJob.taskId, yunaTakeReviewAttempt, "RUNNING");
    const yunaCredential = issueVideoProductionAttemptCredential(db, { attemptId: yunaTakeReviewAttempt, scopes: ["take.review"], expiresAt: 2_100_000 }, { now: 2_000_000, enabled: true, isolationReady: true });
    const yunaActor = resolveVideoProductionActor(db, yunaCredential.token, production.project_id, "take.review", { now: 2_000_001, enabled: true, isolationReady: true });
    if (!yunaActor) throw new Error("fixture_yuna_actor_missing");
    await reviewVideoProductionTake(db, yunaActor, production.project_id, submittedTake.takeId, { expectedShotVersion: 1, expectedAssetId: "pipeline-clip", decision: "approved", feedback: "Fixture approval" }, storageRoot);
    expect(beginVideoProductionCompletion(db, yunaReviewJob.taskId, yunaTakeReviewAttempt)).toBe(true);
    expect(finishVideoProductionAttempt(db, yunaReviewJob.taskId, yunaTakeReviewAttempt, "completed")).toBe(true);
    const finalJob = createNextVideoProductionStageJob(db, production.project_id, "ceo_session");
    expect(finalJob).toMatchObject({ stageKey: "asset_handoff_rough_cut", action: "edit.manage", artifactId: timeline.artifactId });
    const finalAttempt = "123e4567-e89b-42d3-a456-426614174003";
    const encodedRequest = buildLiamWorkerRequest(db, finalJob.taskId, finalAttempt);
    const renderRequest = JSON.parse(encodedRequest) as { inputDigest: string; manifestDigest: string; timelineArtifactId: string; shots: Array<{ shotId: string; inputName: string }> };
    expect(renderRequest.shots).toMatchObject([{ shotId: "pipeline-shot", inputName: "shot-0.mp4" }]);
    claimVideoProductionAttempt(db, finalJob.taskId, finalAttempt, "phase4_remotion", ids.liam, undefined, "edit.manage");
    db.prepare("UPDATE agents SET status='working',current_task_id=? WHERE id=?").run(finalJob.taskId, ids.liam);
    setVideoProductionAttemptLaunchState(db, finalJob.taskId, finalAttempt, "LAUNCHING");
    const workspace = mkdtempSync(path.join(tmpdir(), "vp-liam-stage-"));
    folders.push(workspace);
    expect(stageLiamWorkerInputs(db, finalJob.taskId, finalAttempt, workspace, renderRequest.inputDigest, storageRoot)).toBe(renderRequest.inputDigest);
    expect(db.prepare("SELECT worker_input_digest FROM video_production_attempts WHERE attempt_id=?").get(finalAttempt)).toEqual({ worker_input_digest: renderRequest.inputDigest });
    expect(readFileSync(path.join(workspace, "input", "shot-0.mp4"))).toEqual(clipBytes);
    expect(readFileSync(path.join(workspace, "input", "narration.mp3")).length).toBeGreaterThan(0);
    if (process.platform !== "win32") {
      expect(statSync(path.join(workspace, "input")).mode & 0o777).toBe(0o755);
      expect(statSync(path.join(workspace, "input", "shot-0.mp4")).mode & 0o777).toBe(0o644);
    }
    setVideoProductionAttemptLaunchState(db, finalJob.taskId, finalAttempt, "RUNNING");
    mkdirSync(path.join(workspace, "output"));
    writeFileSync(path.join(workspace, "output", "result.json"), JSON.stringify({ protocol: "claw-video-worker-v1", operation: "render-timeline", ok: true,
      attemptId: finalAttempt, manifestDigest: renderRequest.manifestDigest, timelineArtifactId: renderRequest.timelineArtifactId,
      inputDigest: "0".repeat(64), output: "output/final.mp4", sourceOutput: "render-final-invalid/entry.tsx", byteSize: 0, sha256: "0".repeat(64) }));
    await expect(importLiamWorkerOutput({ db, taskId: finalJob.taskId, attemptId: finalAttempt, workspacePath: workspace, storageRoot })).rejects.toThrow("final_render_result_mismatch");
    const approvedClipPath = path.join(workspace, "approved.mp4");
    copyFileSync(path.join(storageRoot, production.project_id, clip.sha256), approvedClipPath);
    const audioPath = path.join(workspace, "narration.mp3");
    copyFileSync(path.join(storageRoot, production.project_id, audio.sha256), audioPath);
    const finalRender = await renderTrustedVideoTimeline({ workspacePath: workspace, approvedAssetRoot: workspace,
      shots: [{ shotId: "pipeline-shot", title: "Approved clip", action: "Ari opens the blue door", durationFrames: 54, videoPath: approvedClipPath }],
      fps: 30, width: 1280, height: 720, audioPath, outputName: "final-fixture.mp4" });
    const finalHash = createHash("sha256").update(`${finalAttempt}:${renderRequest.inputDigest}`).digest("hex").slice(0, 24);
    const sourceOutput = `render-final-${finalHash}/entry.tsx`;
    mkdirSync(path.dirname(path.join(workspace, sourceOutput)), { recursive: true });
    writeFileSync(path.join(workspace, sourceOutput), finalRender.sourceText);
    copyFileSync(finalRender.outputPath, path.join(workspace, "output", "final.mp4"));
    writeFileSync(path.join(workspace, "output", "result.json"), JSON.stringify({ protocol: "claw-video-worker-v1", operation: "render-timeline", ok: true,
      attemptId: finalAttempt, manifestDigest: renderRequest.manifestDigest, timelineArtifactId: renderRequest.timelineArtifactId, inputDigest: renderRequest.inputDigest,
      output: "output/final.mp4", sourceOutput, byteSize: finalRender.probe.byteSize, sha256: finalRender.probe.sha256 }));
    db.prepare("UPDATE video_production_attempts SET state='RECONCILIATION_REQUIRED' WHERE task_id=? AND attempt_id=? AND state='RUNNING'").run(finalJob.taskId, finalAttempt);
    const openIndex = databases.indexOf(db);
    db.close();
    if (openIndex >= 0) databases.splice(openIndex, 1);
    db = new DatabaseSync(path.join(restartDirectory, "studio.sqlite"));
    databases.push(db);
    expect(claimVideoProductionAttemptForRecovery(db, finalJob.taskId, finalAttempt, "edit.manage")).toBe(true);
    await expect(importLiamWorkerOutput({ db, taskId: finalJob.taskId, attemptId: finalAttempt, workspacePath: workspace, storageRoot })).resolves.toMatchObject({ assetId: expect.any(String), sha256: finalRender.probe.sha256 });
    expect(beginVideoProductionCompletion(db, finalJob.taskId, finalAttempt)).toBe(true);
    expect(finishVideoProductionVerifiedRoughCut(db, finalJob.taskId, finalAttempt)).toBe(true);
    const finalReview = createNextVideoProductionStageJob(db, production.project_id, "ceo_session");
    expect(finalReview).toMatchObject({ stageKey: "director_review", action: "creative.approve", artifactId: expect.any(String) });
    const finalCutArtifactId = (db.prepare("SELECT target_artifact_id FROM video_production_stage_jobs WHERE task_id=?").get(finalReview.taskId) as { target_artifact_id: string }).target_artifact_id;
    const directorAttempt = "123e4567-e89b-42d3-a456-426614174004";
    start(finalReview.taskId, ids.rian, "creative.approve", directorAttempt);
    responses.push({ decision: "approved", feedback: "The final cut matches the approved picture lock." });
    await runRianCreativeReviewJob({ db, taskId: finalReview.taskId, attemptId: directorAttempt, fetchImpl: fetchNext, storageRoot });
    expect(beginVideoProductionCompletion(db, finalReview.taskId, directorAttempt)).toBe(true);
    expect(finishVideoProductionCreativeDecision(db, finalReview.taskId, directorAttempt)).toBe(true);

    const qaJob = createNextVideoProductionStageJob(db, production.project_id, "ceo_session");
    expect(qaJob).toMatchObject({ stageKey: "finishing_qa", action: "qa.final", artifactId: finalCutArtifactId });
    const qaAttempt = "123e4567-e89b-42d3-a456-426614174005";
    start(qaJob.taskId, ids.qa, "qa.final", qaAttempt);
    responses.push({ decision: "approved", feedback: "Decoded streams and sampled frames meet the release checks.", issues: [] });
    await runQuinnFinalQaJob({ db, taskId: qaJob.taskId, attemptId: qaAttempt, fetchImpl: fetchNext, storageRoot });
    expect(beginVideoProductionCompletion(db, qaJob.taskId, qaAttempt)).toBe(true);
    expect(finishVideoProductionQaDecision(db, qaJob.taskId, qaAttempt)).toBe(true);

    const finalCutPins = JSON.parse((db.prepare("SELECT content_text FROM video_production_stage_artifacts WHERE artifact_id=?").get(finalCutArtifactId) as { content_text: string }).content_text) as Record<string, string>;
    const qaEvidence = db.prepare("SELECT a.content_sha256 FROM video_production_stage_artifacts a WHERE a.project_id=? AND a.artifact_type='qa_evidence' ORDER BY a.created_at DESC LIMIT 1").get(production.project_id) as { content_sha256: string };
    const directorDecision = db.prepare("SELECT decision_id FROM video_production_stage_decisions WHERE project_id=? AND target_artifact_id=? AND stage_key='director_review'").get(production.project_id, finalCutArtifactId) as { decision_id: string };
    const qaDecision = db.prepare("SELECT decision_id FROM video_production_stage_decisions WHERE project_id=? AND stage_key='finishing_qa' ORDER BY created_at DESC LIMIT 1").get(production.project_id) as { decision_id: string };
    const qaArtifact = db.prepare("SELECT artifact_id FROM video_production_stage_artifacts WHERE project_id=? AND artifact_type='qa_evidence' ORDER BY created_at DESC LIMIT 1").get(production.project_id) as { artifact_id: string };
    const releaseExpected = {
      finalCutArtifactId,
      finalAssetId: finalCutPins.finalAssetId!, finalAssetSha256: finalCutPins.finalAssetSha256!, manifestDigest: finalCutPins.manifestDigest!,
      manifestId: finalCutPins.manifestId!, timelineArtifactId: finalCutPins.timelineArtifactId!, timelineSha256: finalCutPins.timelineSha256!,
      timelineSourceArtifactId: finalCutPins.timelineSourceArtifactId!, timelineSourceSha256: finalCutPins.timelineSourceSha256!,
      audioCuesArtifactId: finalCutPins.audioCuesArtifactId!, audioAssetId: finalCutPins.audioAssetId!, audioSha256: finalCutPins.audioSha256!,
      directorDecisionId: directorDecision.decision_id, qaArtifactId: qaArtifact.artifact_id, qaArtifactSha256: qaEvidence.content_sha256, qaDecisionId: qaDecision.decision_id,
    };
    const release = await releaseVideoProductionFinalCut(db, production.project_id, "ceo_session", releaseExpected, storageRoot);
    expect(release).toMatchObject({ released: true, idempotent: false });
    await expect(releaseVideoProductionFinalCut(db, production.project_id, "ceo_session", releaseExpected, storageRoot)).resolves.toMatchObject({ released: true, idempotent: true });
    await expect(releaseVideoProductionFinalCut(db, production.project_id, "ceo_session", { ...releaseExpected, finalCutArtifactId: "older-cut" }, storageRoot)).rejects.toThrow("final_release_confirmation_stale");
    expect(db.prepare("SELECT status FROM video_production_stages WHERE project_id=? AND stage_key='release_archive'").get(production.project_id)).toEqual({ status: "COMPLETED" });
    expect(call).toBe(10);
    expect(task(ids.haru, "ignored")).toBeTruthy();
  }, 90_000);

  it.skipIf(!localRenderAvailable)("creates a shot job, restarts file-backed storage before first import, then idempotently validates and submits the exact render", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "vp-phase4-restart-"));
    folders.push(directory);
    let db = new DatabaseSync(path.join(directory, "production.sqlite"));
    const { production } = createStudio(db);
    const haruId = "video_production-role-screenwriter";
    const miroId = "video_production-role-video-producer";
    grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId: haruId, grantedBy: "ceo_session" });
    grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId: miroId, grantedBy: "ceo_session" });
    const screenplay = getScopedActor(db, production.project_id, haruId, "screenplay.write", "story_development");
    const scene = createVideoProductionScene(db, screenplay, production.project_id, {
      sceneId: "scene-job", content: { description: "Workshop entry", location: "Workshop", characters: ["Ari"], continuity: {} },
    });
    const shotWriter = getScopedActor(db, production.project_id, haruId, "shot_spec.write", "visual_preproduction");
    const shot = createVideoProductionShot(db, shotWriter, production.project_id, scene.sceneId, {
      shotId: "shot-job", content: { action: "Ari enters", camera: { framing: "wide" }, durationMs: 1800, required: true },
    });
    db.prepare("UPDATE video_production_attempts SET state='PAUSED',finished_at=1 WHERE state IN ('PREPARED','LAUNCHING','RUNNING','COMPLETING','RECONCILIATION_REQUIRED')").run();
    db.prepare("UPDATE video_production_slot SET task_id=NULL,attempt_id=NULL,acquired_at=NULL WHERE singleton=1").run();
    db.prepare("UPDATE tasks SET status='done' WHERE project_id=? AND status='in_progress'").run(production.project_id);
    db.prepare("UPDATE agents SET current_task_id=NULL,status='idle' WHERE id IN (?,?)").run(haruId, miroId);
    db.prepare("UPDATE video_production_stages SET status='COMPLETED',implemented=1,task_id=NULL WHERE project_id=? AND stage_order<5").run(production.project_id);
    db.prepare("UPDATE video_production_stages SET status='NOT_IMPLEMENTED',implemented=0,task_id=NULL WHERE project_id=? AND stage_key='ai_footage_production'").run(production.project_id);

    const jobInput = { projectId: production.project_id, shotId: shot.shotId, shotVersion: shot.version, agentId: miroId, idempotencyKey: "first-shot-render", createdBy: "ceo_session" };
    const created = createVideoProductionShotRenderJob(db, jobInput);
    expect(created).toMatchObject({ stageKey: "ai_footage_production", action: "footage.submit", agentId: miroId, shotId: shot.shotId, shotVersion: shot.version });
    expect(createVideoProductionShotRenderJob(db, jobInput)).toEqual(created);
    expect(db.prepare("SELECT stage_key,execution_action,assigned_agent_id,shot_id,shot_version,state FROM video_production_stage_jobs WHERE task_id=?").get(created.taskId))
      .toEqual({ stage_key: "ai_footage_production", execution_action: "footage.submit", assigned_agent_id: miroId, shot_id: shot.shotId, shot_version: shot.version, state: "READY" });
    expect(db.prepare("SELECT task_id,status,implemented FROM video_production_stages WHERE project_id=? AND stage_key='ai_footage_production'").get(production.project_id))
      .toEqual({ task_id: created.taskId, status: "READY", implemented: 1 });
    const workerRequest = JSON.parse(await buildMiroWorkerRequest({ db, taskId: created.taskId, workspaceAttemptId: "123e4567-e89b-42d3-a456-426614174000" }));
    expect(workerRequest).toMatchObject({
      protocol: "claw-video-worker-v1", operation: "render-shot", attemptId: "123e4567-e89b-42d3-a456-426614174000",
      shot: { shotId: shot.shotId, shotVersion: shot.version, action: "Ari enters", durationFrames: 54 },
      width: 1280, height: 720, fps: 30,
    });
    const attemptId = "223e4567-e89b-42d3-a456-426614174001";
    claimVideoProductionAttempt(db, created.taskId, attemptId, "phase4_remotion", miroId, undefined, "footage.submit");
    db.prepare("UPDATE agents SET status='working',current_task_id=? WHERE id=?").run(created.taskId, miroId);
    const workspace = mkdtempSync(path.join(tmpdir(), "claw-worker-import-"));
    folders.push(workspace);
    const renderHash = createHash("sha256").update(`${shot.shotId}:v${shot.version}`).digest("hex").slice(0, 24);
    const render = await renderTrustedVideoTimeline({
      workspacePath: workspace, approvedAssetRoot: workspace,
      shots: [{ shotId: shot.shotId, title: "Fixture", action: "Ari enters", durationFrames: 54 }],
      fps: 30, width: 1280, height: 720, outputName: "fixture.mp4",
    });
    mkdirSync(path.join(workspace, "output"), { recursive: true });
    mkdirSync(path.join(workspace, `render-${renderHash}`), { recursive: true });
    copyFileSync(render.outputPath, path.join(workspace, "output", `shot-${renderHash}.mp4`));
    writeFileSync(path.join(workspace, `render-${renderHash}`, "entry.tsx"), render.sourceText);
    writeFileSync(path.join(workspace, "output", "result.json"), JSON.stringify({
      protocol: "claw-video-worker-v1", ok: true, attemptId, shotId: shot.shotId, shotVersion: shot.version,
      output: `output/shot-${renderHash}.mp4`, byteSize: render.probe.byteSize, sha256: render.probe.sha256,
      sourceOutput: `render-${renderHash}/entry.tsx`,
    }));
    setVideoProductionAttemptLaunchState(db, created.taskId, attemptId, "RUNNING", { workspacePath: workspace, imageId: `sha256:${"c".repeat(64)}` });
    db.prepare("UPDATE video_production_attempts SET state='RECONCILIATION_REQUIRED' WHERE attempt_id=?").run(attemptId);
    expect(db.prepare("SELECT COUNT(*) AS count FROM video_production_takes WHERE attempt_id=?").get(attemptId)).toEqual({ count: 0 });
    databases.splice(databases.indexOf(db), 1);
    db.close();
    db = new DatabaseSync(path.join(directory, "production.sqlite"));
    databases.push(db);
    db.exec("PRAGMA foreign_keys=ON");
    ensureVideoProductionSchema(db);
    expect(claimVideoProductionAttemptForRecovery(db, created.taskId, attemptId)).toBe(true);
    expect(claimVideoProductionAttemptForRecovery(db, created.taskId, attemptId)).toBe(false);
    const imported = await importMiroWorkerOutput({ db, taskId: created.taskId, attemptId, workspacePath: workspace, storageRoot: path.join(workspace, "assets") });
    expect(imported.takeId).toBeTruthy();
    expect(await importMiroWorkerOutput({ db, taskId: created.taskId, attemptId, workspacePath: workspace, storageRoot: path.join(workspace, "assets") })).toEqual(imported);
    expect(finishVideoProductionExecutionPendingReview(db, created.taskId, attemptId)).toBe(true);
    expect(db.prepare("SELECT state FROM video_production_stage_jobs WHERE task_id=?").get(created.taskId)).toEqual({ state: "WAITING_APPROVAL" });
    expect(db.prepare("SELECT status FROM video_production_stages WHERE project_id=? AND stage_key='ai_footage_production'").get(production.project_id)).toEqual({ status: "BLOCKED" });
    expect(() => createVideoProductionShotRenderJob(db, { ...jobInput, idempotencyKey: "second-shot-render" })).toThrow("production_stage_already_has_current_job");

    const yunaId = "video_production-role-art-director";
    grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId: yunaId, grantedBy: "ceo_session" });
    db.prepare("INSERT INTO api_providers(id,name,type,base_url,enabled) VALUES('vision-provider','Fixture vision','openai','https://provider.example.test/v1',1)").run();
    db.prepare("UPDATE agents SET api_provider_id='vision-provider',api_model='gpt-4o-mini' WHERE id=?").run(yunaId);
    const reviewJob = createVideoProductionTakeReviewJob(db, { projectId: production.project_id, shotId: shot.shotId, shotVersion: shot.version, agentId: yunaId, idempotencyKey: "review-first-take", createdBy: "ceo_session" });
    const target = db.prepare("SELECT target_take_id,target_asset_id,target_asset_sha256 FROM video_production_stage_jobs WHERE task_id=?").get(reviewJob.taskId) as { target_take_id: string; target_asset_id: string; target_asset_sha256: string };
    expect(target).toMatchObject({ target_take_id: imported.takeId, target_asset_id: imported.assetId, target_asset_sha256: imported.sha256 });
    const reviewAttempt = "review-attempt";
    claimVideoProductionAttempt(db, reviewJob.taskId, reviewAttempt, "phase4_provider_broker", yunaId, undefined, "take.review");
    db.prepare("UPDATE agents SET current_task_id=?,status='working' WHERE id=?").run(reviewJob.taskId, yunaId);
    setVideoProductionAttemptLaunchState(db, reviewJob.taskId, reviewAttempt, "RUNNING");
    const visionFetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: Array<{ image_url?: { url?: string } }> }> };
      expect(body.messages[1]?.content.filter((part) => part.image_url).length).toBe(3);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"decision":"approved","feedback":"Sampled frames preserve the shot intent."}' } }] }), { status: 200 });
    });
    await expect(runYunaTakeReviewJob({ db, taskId: reviewJob.taskId, attemptId: reviewAttempt, fetchImpl: visionFetch, storageRoot: path.join(workspace, "assets") })).resolves.toMatchObject({ takeId: imported.takeId, decision: "approved" });
    expect(beginVideoProductionCompletion(db, reviewJob.taskId, reviewAttempt)).toBe(true);
    expect(finishVideoProductionAttempt(db, reviewJob.taskId, reviewAttempt, "completed")).toBe(true);
    expect(db.prepare("SELECT take_id,asset_id FROM video_production_approved_takes WHERE project_id=? AND shot_id=?").get(production.project_id, shot.shotId)).toMatchObject({ take_id: imported.takeId, asset_id: imported.assetId });
  }, 30_000);

  it("migrates additively and idempotently across a file-backed reopen", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "vp-registry-migration-"));
    const file = path.join(directory, "registry.sqlite");
    try {
      let db = new DatabaseSync(file);
      db.exec("PRAGMA foreign_keys=ON");
      applyBaseSchema(db);
      applyTaskSchemaMigrations(db);
      ensureVideoProductionSchema(db);
      const columns = db.prepare("PRAGMA table_info(video_production_agent_credentials)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["attempt_id", "task_id", "plan_version"]));
      ensureVideoProductionSchema(db);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'video_production_%'").all().length).toBeGreaterThan(12);
      db.close();
      db = new DatabaseSync(file);
      db.exec("PRAGMA foreign_keys=ON");
      ensureVideoProductionSchema(db);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_video_prod_%'").all().length).toBeGreaterThan(10);
      db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("issues registry scopes only from a trusted active attempt and rechecks the singleton slot, stage, task and plan", () => {
    const { db, production } = createStudio();
    const haru = "video_production-role-screenwriter";
    grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId: haru, grantedBy: "ceo_session" });
    startFakeAttempt(db, production.project_id, haru, "attempt-haru", "task-haru");

    expect(videoStudioRoleAllows("production_manager", "regeneration.request")).toBe(true);
    expect(videoStudioRoleAllows("video_producer", "regeneration.request")).toBe(false);
    expect(() => issueVideoProductionCredential(db, {
      projectId: production.project_id, agentId: haru, scopes: ["screenplay.write"], issuedBy: "ceo_session", expiresAt: 2_100_000,
    }, { now: 2_000_000, enabled: true, isolationReady: true })).toThrow("video_production_registry_attempt_required");
    expect(() => issueVideoProductionAttemptCredential(db, {
      attemptId: "attempt-haru", scopes: ["screenplay.write"], expiresAt: 2_100_000,
    }, { now: 2_000_000, enabled: false, isolationReady: true })).toThrow("video_production_agent_credentials_disabled");

    const credential = issueVideoProductionAttemptCredential(db, {
      attemptId: "attempt-haru", scopes: ["screenplay.write"], expiresAt: 2_100_000,
    }, { now: 2_000_000, enabled: true, isolationReady: true });
    expect(db.prepare("SELECT project_id,agent_id,task_id,attempt_id,plan_version FROM video_production_agent_credentials WHERE credential_id=?")
      .get(credential.credentialId)).toEqual({ project_id: production.project_id, agent_id: haru, task_id: "task-haru", attempt_id: "attempt-haru", plan_version: 1 });
    expect(resolveVideoProductionActor(db, credential.token, production.project_id, "screenplay.write", { now: 2_000_001, enabled: true, isolationReady: true }))
      .toMatchObject({ agentId: haru, taskId: "task-haru", attemptId: "attempt-haru", planVersion: 1 });

    db.prepare("UPDATE video_production_slot SET task_id=NULL,attempt_id=NULL WHERE singleton=1").run();
    expect(resolveVideoProductionActor(db, credential.token, production.project_id, "screenplay.write", { now: 2_000_001, enabled: true, isolationReady: true })).toBeNull();
    db.prepare("UPDATE video_production_slot SET task_id='task-haru',attempt_id='attempt-haru' WHERE singleton=1").run();
    db.prepare("UPDATE video_production_stages SET status='PAUSED' WHERE project_id=? AND task_id='task-haru'").run(production.project_id);
    expect(resolveVideoProductionActor(db, credential.token, production.project_id, "screenplay.write", { now: 2_000_001, enabled: true, isolationReady: true })).toBeNull();
    db.prepare("UPDATE video_production_stages SET status='RUNNING' WHERE project_id=? AND task_id='task-haru'").run(production.project_id);
    db.prepare("UPDATE video_productions SET plan_version=2 WHERE project_id=?").run(production.project_id);
    expect(resolveVideoProductionActor(db, credential.token, production.project_id, "screenplay.write", { now: 2_000_001, enabled: true, isolationReady: true })).toBeNull();
  });

  it("rejects credential rows whose attempt provenance does not match persisted project, task, agent and plan", () => {
    const { db, production } = createStudio();
    const haru = "video_production-role-screenwriter";
    grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId: haru, grantedBy: "ceo_session" });
    startFakeAttempt(db, production.project_id, haru, "attempt-haru", "task-haru");
    const issued = issueVideoProductionAttemptCredential(db, {
      attemptId: "attempt-haru", scopes: ["screenplay.write"], expiresAt: 2_100_000,
    }, { now: 2_000_000, enabled: true, isolationReady: true });
    const row = db.prepare("SELECT token_hash,scopes_json FROM video_production_agent_credentials WHERE credential_id=?").get(issued.credentialId) as { token_hash: string; scopes_json: string };
    expect(() => db.prepare(`INSERT INTO video_production_agent_credentials
      (credential_id,project_id,agent_id,token_hash,scopes_json,issued_by,created_at,expires_at,attempt_id,task_id,plan_version)
      VALUES('bad-attempt-scope',?,?,? ,?,'fixture',1,2100000,'attempt-haru','wrong-task',1)`)
      .run(production.project_id, haru, `bad${row.token_hash.slice(3)}`, row.scopes_json)).toThrow();
    expect(() => db.prepare(`INSERT INTO video_production_agent_credentials
      (credential_id,project_id,agent_id,token_hash,scopes_json,issued_by,created_at,expires_at,attempt_id,task_id,plan_version)
      VALUES('partial-attempt-scope',?,?,? ,?,'fixture',1,2100000,'attempt-haru',NULL,NULL)`)
      .run(production.project_id, haru, `partial${row.token_hash.slice(7)}`, row.scopes_json)).toThrow("credential_attempt_scope_mismatch");
  });

  it("enforces exact shot→scene, take→asset, review→take and manifest→shot lineage in SQLite", () => {
    const { db, production } = createStudio();
    const haru = "video_production-role-screenwriter";
    const yuna = "video_production-role-art-director";
    const projectId = production.project_id;
    grantVideoProductionProjectAgent(db, { projectId, agentId: haru, grantedBy: "ceo_session" });
    startFakeAttempt(db, projectId, haru, "attempt-haru", "task-haru");
    insertSceneShotAndAsset(db, projectId, haru, "task-haru", "attempt-haru");

    expect(() => db.prepare(`INSERT INTO video_production_takes
      (project_id,take_id,shot_id,shot_version,take_number,asset_id,attempt_metadata_json,content_fingerprint,submitted_by,task_id,attempt_id,attempt_plan_version,submitted_at)
      VALUES(?,'take-wrong-asset','shot-1',1,2,'missing-asset','{}','${"c".repeat(64)}',?,'task-haru','attempt-haru',1,2)`)
      .run(projectId, haru)).toThrow();
    expect(() => db.prepare(`INSERT INTO video_production_take_reviews
      (project_id,review_id,take_id,shot_id,shot_version,asset_id,review_number,decision,feedback,content_fingerprint,reviewer_agent_id,task_id,attempt_id,attempt_plan_version,created_at)
      VALUES(?,'review-wrong-asset','take-1','shot-1',1,'other-asset',1,'approved','ok','${"d".repeat(64)}',?,'task-haru','attempt-haru',1,2)`)
      .run(projectId, haru)).toThrow();

    const haruCredential = issueVideoProductionAttemptCredential(db, {
      attemptId: "attempt-haru", scopes: ["screenplay.write"], expiresAt: 2_100_000,
    }, { now: 2_000_000, enabled: true, isolationReady: true });
    db.prepare("UPDATE tasks SET assigned_agent_id=? WHERE id='task-haru'").run("video_production-role-video-producer");
    expect(resolveVideoProductionActor(db, haruCredential.token, projectId, "screenplay.write", { now: 2_000_001, enabled: true, isolationReady: true })).toBeNull();
    expect(db.prepare("SELECT created_by_agent_id,task_id,attempt_id FROM video_production_shot_versions WHERE project_id=? AND shot_id='shot-1'").get(projectId))
      .toEqual({ created_by_agent_id: haru, task_id: "task-haru", attempt_id: "attempt-haru" });

    db.prepare("UPDATE video_production_attempts SET state='COMPLETED',finished_at=2 WHERE attempt_id='attempt-haru'").run();
    db.prepare("UPDATE video_production_slot SET task_id=NULL,attempt_id=NULL WHERE singleton=1").run();
    grantVideoProductionProjectAgent(db, { projectId, agentId: yuna, grantedBy: "ceo_session" });
    startFakeAttempt(db, projectId, yuna, "attempt-yuna", "task-yuna");
    db.prepare(`INSERT INTO video_production_take_reviews
      (project_id,review_id,take_id,shot_id,shot_version,asset_id,review_number,decision,feedback,content_fingerprint,reviewer_agent_id,task_id,attempt_id,attempt_plan_version,created_at)
      VALUES(?,'review-rejected','take-1','shot-1',1,'asset-1',1,'rejected','Needs change','${"b".repeat(64)}',?,'task-yuna','attempt-yuna',1,3)`)
      .run(projectId, yuna);
    expect(() => db.prepare(`INSERT INTO video_production_approved_takes(project_id,shot_id,take_id,shot_version,asset_id,review_id,updated_at)
      VALUES(?,'shot-1','take-1',1,'asset-1','review-rejected',3)`).run(projectId)).toThrow();
    db.prepare(`INSERT INTO video_production_take_reviews
      (project_id,review_id,take_id,shot_id,shot_version,asset_id,review_number,decision,feedback,content_fingerprint,reviewer_agent_id,task_id,attempt_id,attempt_plan_version,created_at)
      VALUES(?,'review-1','take-1','shot-1',1,'asset-1',2,'approved','Looks consistent','${"b".repeat(64)}',?,'task-yuna','attempt-yuna',1,3)`)
      .run(projectId, yuna);
    db.prepare(`INSERT INTO video_production_approved_takes(project_id,shot_id,take_id,shot_version,asset_id,review_id,updated_at)
      VALUES(?,'shot-1','take-1',1,'asset-1','review-1',3)`).run(projectId);
    expect(() => db.prepare(`UPDATE video_production_take_reviews SET feedback='rewritten' WHERE project_id=? AND review_id='review-1'`).run(projectId))
      .toThrow("take_reviews_are_immutable");
    expect(() => db.prepare("DELETE FROM video_production_assets WHERE project_id=? AND asset_id='asset-1'").run(projectId))
      .toThrow("assets_are_immutable");

    db.prepare(`INSERT INTO video_production_manifests
      (project_id,manifest_id,manifest_version,plan_version,status,digest_sha256,created_by_agent_id,task_id,attempt_id,attempt_plan_version,created_at)
      VALUES(?,'manifest-1',1,1,'READY','${"e".repeat(64)}',?,'task-yuna','attempt-yuna',1,3)`)
      .run(projectId, yuna);
    expect(() => db.prepare(`INSERT INTO video_production_manifest_entries
      (project_id,manifest_id,entry_order,scene_id,scene_version,shot_id,shot_version,take_id,asset_id,asset_sha256,metadata_json)
      VALUES(?,'manifest-1',0,'wrong-scene',1,'shot-1',1,'take-1','asset-1','${"a".repeat(64)}','{}')`).run(projectId)).toThrow();
    db.prepare(`INSERT INTO video_production_manifest_entries
      (project_id,manifest_id,entry_order,scene_id,scene_version,shot_id,shot_version,take_id,asset_id,asset_sha256,metadata_json)
      VALUES(?,'manifest-1',0,'scene-1',1,'shot-1',1,'take-1','asset-1','${"a".repeat(64)}','{}')`).run(projectId);
    expect(() => db.prepare("DELETE FROM video_production_manifest_entries WHERE project_id=? AND manifest_id='manifest-1'").run(projectId))
      .toThrow("manifest_entries_are_immutable");
  });

  it("binds Liam manifest authority to a live attempt and denies an unbound or terminal token", () => {
    const { db, production } = createStudio();
    const liam = "video_production-role-editor";
    grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId: liam, grantedBy: "ceo_session" });
    startFakeAttempt(db, production.project_id, liam, "attempt-liam", "task-liam");
    expect(() => issueVideoProductionCredential(db, {
      projectId: production.project_id, agentId: liam, scopes: ["edit.manage"], issuedBy: "ceo_session", expiresAt: 2_100_000,
    }, { now: 2_000_000, enabled: true, isolationReady: true })).toThrow("video_production_registry_attempt_required");
    const credential = issueVideoProductionAttemptCredential(db, {
      attemptId: "attempt-liam", scopes: ["edit.manage"], expiresAt: 2_100_000,
    }, { now: 2_000_000, enabled: true, isolationReady: true });
    expect(resolveVideoProductionActor(db, credential.token, production.project_id, "edit.manage", { now: 2_000_001, enabled: true, isolationReady: true }))
      .toMatchObject({ agentId: liam, attemptId: "attempt-liam" });
    db.prepare("UPDATE video_production_attempts SET state='COMPLETED',finished_at=2 WHERE attempt_id='attempt-liam'").run();
    expect(resolveVideoProductionActor(db, credential.token, production.project_id, "edit.manage", { now: 2_000_001, enabled: true, isolationReady: true })).toBeNull();
  });

  it("runs the asset-first submitted take through exact Yuna review to an immutable Liam manifest", async () => {
    const { db, production } = createStudio();
    const root = mkdtempSync(path.join(tmpdir(), "vp-registry-e2e-"));
    try {
      const haruId = "video_production-role-screenwriter";
      const yunaId = "video_production-role-art-director";
      const miroId = "video_production-role-video-producer";
      const liamId = "video_production-role-editor";
      for (const agentId of [haruId, yunaId, miroId, liamId]) grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId, grantedBy: "ceo_session" });

      const haru = getScopedActor(db, production.project_id, haruId, "screenplay.write", "story_development");
      const scene = createVideoProductionScene(db, haru, production.project_id, {
        sceneId: "scene-e2e", content: { description: "An establishing beat", location: "Workshop", characters: ["Ari"], continuity: {} },
      });
      const temporaryScene = createVideoProductionScene(db, haru, production.project_id, {
        sceneId: "scene-delete", content: { description: "Temporary", location: "Workshop", characters: [], continuity: {} },
      });
      updateVideoProductionScene(db, haru, production.project_id, temporaryScene.sceneId, 1, { content: { description: "Updated temporary", location: "Workshop B", characters: [], continuity: { prop: "moved" } } });
      reorderVideoProductionScenes(db, haru, production.project_id, [temporaryScene.sceneId, scene.sceneId]);
      softDeleteVideoProductionScene(db, haru, production.project_id, temporaryScene.sceneId, 2);
      const shotActor = getScopedActor(db, production.project_id, haruId, "shot_spec.write", "visual_preproduction");
      const shot = createVideoProductionShot(db, shotActor, production.project_id, scene.sceneId, {
        shotId: "shot-e2e", content: { action: "Ari enters", camera: { framing: "wide" }, durationMs: 2400, required: true },
      });
      createVideoProductionShot(db, shotActor, production.project_id, scene.sceneId, {
        shotId: "shot-reference-a", content: { action: "Reference A", camera: {}, durationMs: 1200, required: false },
      });
      createVideoProductionShot(db, shotActor, production.project_id, scene.sceneId, {
        shotId: "shot-reference-b", content: { action: "Reference B", camera: {}, durationMs: 1200, required: false },
      });
      const yunaVisual = getScopedActor(db, production.project_id, yunaId, "visual.manage", "visual_preproduction");
      for (const dependentShotId of ["shot-reference-a", "shot-reference-b"]) {
        linkVideoProductionShotReference(db, yunaVisual, production.project_id, dependentShotId, 1, {
          referenceKey: "arrival-continuity", referenceType: "continuity", target: { kind: "shot", shotId: shot.shotId, version: shot.version },
        });
      }
      const haruReorder = getScopedActor(db, production.project_id, haruId, "shot_spec.write", "visual_preproduction");
      reorderVideoProductionShots(db, haruReorder, production.project_id, scene.sceneId, ["shot-e2e", "shot-reference-b", "shot-reference-a"]);
      const sourceSpec = db.prepare("SELECT current_version FROM video_production_shots WHERE project_id=? AND shot_id=?").get(production.project_id, shot.shotId) as { current_version: number };
      updateVideoProductionShot(db, haruReorder, production.project_id, shot.shotId, sourceSpec.current_version, { action: "Ari enters past camera", camera: { framing: "wide" }, durationMs: 2400, required: true });
      const shotVersion = Number((db.prepare("SELECT current_version FROM video_production_shots WHERE project_id=? AND shot_id=?").get(production.project_id, shot.shotId) as { current_version: number }).current_version);
      const dependencyView = await listVideoProductionRegistry(db, production.project_id, root);
      const dependencies = dependencyView.dependencies as Array<Record<string, unknown>>;
      expect(dependencies).toHaveLength(2);
      expect(dependencies.every((dependency) => dependency.stale === true)).toBe(true);
      expect((dependencyView.scenes as Array<Record<string, unknown>>).map((item) => item.scene_id)).not.toContain("scene-delete");
      const miro = getScopedActor(db, production.project_id, miroId, "footage.submit", "ai_footage_production");
      const videoBytes = Buffer.concat([Buffer.from("0000ftyp"), Buffer.from("isomfixture")]);
      const stored = await storeVideoProductionAsset(root, {
        projectId: production.project_id, assetType: "footage", contentType: "video/mp4", source: Readable.from([videoBytes]),
      });
      const assetInput = {
        projectId: production.project_id, assetId: "asset-e2e", assetType: "footage" as const, stored,
        metadata: { label: "fixture take", technicalMetadata: { width: 1280, height: 720, frameRate: 24, durationMs: 2400 } },
        idempotencyKey: "asset-e2e-key", shotId: shot.shotId, shotVersion,
      };
      const revokeDuringVerify = vi.spyOn(registryStorage, "verifyVideoProductionAsset").mockImplementation(async () => {
        db.prepare("UPDATE video_production_agent_credentials SET revoked_at=2000002 WHERE credential_id=?").run(miro.credentialId);
        return true;
      });
      await expect(registerVideoProductionAsset(db, miro, assetInput, root)).rejects.toThrow("video_production_credential_stale");
      expect(db.prepare("SELECT COUNT(*) AS count FROM video_production_assets WHERE project_id=? AND asset_id='asset-e2e'").get(production.project_id)).toEqual({ count: 0 });
      revokeDuringVerify.mockRestore();
      const miroCurrent = getScopedActor(db, production.project_id, miroId, "footage.submit", "ai_footage_production");
      await registerVideoProductionAsset(db, miroCurrent, assetInput, root);
      const take = createVideoProductionTake(db, miroCurrent, production.project_id, shot.shotId, {
        shotVersion, assetId: "asset-e2e", metadata: { model: "fixture-model", prompt: "fixture prompt", generationParameters: {}, reportedValidation: { width: 1280, height: 720, frameRate: 24, durationMs: 2400 } },
      });
      await registerVideoProductionAsset(db, miroCurrent, { ...assetInput, assetId: "asset-e2e-second", idempotencyKey: "asset-e2e-second-key" }, root);
      const take2 = createVideoProductionTake(db, miroCurrent, production.project_id, shot.shotId, {
        shotVersion, assetId: "asset-e2e-second", metadata: { model: "fixture-model", prompt: "second fixture take", generationParameters: {}, reportedValidation: { width: 1280, height: 720, frameRate: 24, durationMs: 2400 } },
      });
      const yuna = getScopedActor(db, production.project_id, yunaId, "take.review", "ai_footage_production");
      const review = await reviewVideoProductionTake(db, yuna, production.project_id, take.takeId, {
        expectedShotVersion: shotVersion, expectedAssetId: "asset-e2e", decision: "approved", feedback: "Continuity matches the submitted reference.",
      }, root);
      expect(review.decision).toBe("approved");
      await reviewVideoProductionTake(db, yuna, production.project_id, take2.takeId, {
        expectedShotVersion: shotVersion, expectedAssetId: "asset-e2e-second", decision: "approved", feedback: "Second take is stronger.",
      }, root);
      expect(db.prepare("SELECT take_id FROM video_production_approved_takes WHERE project_id=? AND shot_id=?").get(production.project_id, shot.shotId)).toEqual({ take_id: take2.takeId });
      await reviewVideoProductionTake(db, yuna, production.project_id, take.takeId, {
        expectedShotVersion: shotVersion, expectedAssetId: "asset-e2e", decision: "rejected", feedback: "Keep the second take approved.",
      }, root);
      expect(db.prepare("SELECT take_id FROM video_production_approved_takes WHERE project_id=? AND shot_id=?").get(production.project_id, shot.shotId)).toEqual({ take_id: take2.takeId });
      expect(db.prepare("SELECT COUNT(*) AS count FROM video_production_assets WHERE project_id=? AND sha256=?").get(production.project_id, stored.sha256)).toEqual({ count: 2 });
      const liam = getScopedActor(db, production.project_id, liamId, "edit.manage", "asset_handoff_rough_cut");
      if (!liam.attemptId || !liam.taskId) throw new Error("fixture_liam_attempt_missing");
      const liamAttemptId = liam.attemptId;
      const liamTaskId = liam.taskId;
      let injectedEmptyScene = false;
      const verifier = vi.spyOn(registryStorage, "verifyVideoProductionAsset").mockImplementation(async () => {
        if (!injectedEmptyScene) {
          injectedEmptyScene = true;
          db.exec("BEGIN");
          try {
            db.prepare(`INSERT INTO video_production_scenes(project_id,scene_id,current_version,sort_order,is_required,created_by_agent_id,task_id,attempt_id,attempt_plan_version,created_at,updated_at)
              VALUES(?,'scene-race',1,2,1,?,?,?,1,1,1)`).run(production.project_id, liam.agentId, liamTaskId, liamAttemptId);
            db.prepare(`INSERT INTO video_production_scene_versions(project_id,scene_id,version,sort_order,description,location,characters_json,continuity_json,created_by_agent_id,task_id,attempt_id,attempt_plan_version,created_at)
              VALUES(?,'scene-race',1,2,'Added during asset verification','Stage','[]','{}',?,?,?,1,1)`).run(production.project_id, liam.agentId, liamTaskId, liamAttemptId);
            db.exec("COMMIT");
          } catch (error) { db.exec("ROLLBACK"); throw error; }
        }
        return true;
      });
      await expect(createVideoProductionManifest(db, liam, production.project_id, root)).rejects.toThrow("video_production_manifest_incomplete");
      expect(db.prepare("SELECT COUNT(*) AS count FROM video_production_manifests WHERE project_id=?").get(production.project_id)).toEqual({ count: 0 });
      verifier.mockRestore();
      db.prepare("UPDATE video_production_scenes SET is_required=0 WHERE project_id=? AND scene_id='scene-race'").run(production.project_id);
      const manifest = await createVideoProductionManifest(db, liam, production.project_id, root);
      expect(manifest).toMatchObject({ status: "READY", entries: [{ sceneId: scene.sceneId, shotId: shot.shotId, takeId: take2.takeId, assetId: "asset-e2e-second" }] });
      expect(await isVideoProductionManifestCurrent(db, production.project_id, manifest.manifestId, root)).toBe(true);
      grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId: production.manager_agent_id, grantKey: "coordinator", grantedBy: "ceo_session" });
      const damiBeforeReject = getScopedActor(db, production.project_id, production.manager_agent_id, "regeneration.request", "story_development");
      const regenInput = { expectedShotVersion: shotVersion, rejectedTakeId: take2.takeId, idempotencyKey: "regen-shot-e2e", reason: "Review requested a tighter cut" };
      expect(() => requestVideoProductionRegeneration(db, damiBeforeReject, production.project_id, shot.shotId, regenInput)).toThrow("video_production_approved_shot_cannot_regenerate");
      const yunaRejector = getScopedActor(db, production.project_id, yunaId, "take.review", "ai_footage_production");
      await reviewVideoProductionTake(db, yunaRejector, production.project_id, take2.takeId, {
        expectedShotVersion: shotVersion, expectedAssetId: "asset-e2e-second", decision: "rejected", feedback: "Tighten the cut before resubmission.",
      }, root);
      expect(db.prepare("SELECT COUNT(*) AS count FROM video_production_approved_takes WHERE project_id=? AND shot_id=?").get(production.project_id, shot.shotId)).toEqual({ count: 0 });
      expect(await isVideoProductionManifestCurrent(db, production.project_id, manifest.manifestId, root)).toBe(false);
      const dami = getScopedActor(db, production.project_id, production.manager_agent_id, "regeneration.request", "story_development");
      const regeneration = requestVideoProductionRegeneration(db, dami, production.project_id, shot.shotId, regenInput);
      expect(regeneration).toMatchObject({ idempotent: false, status: "requested" });
      expect(requestVideoProductionRegeneration(db, dami, production.project_id, shot.shotId, regenInput)).toMatchObject({ requestId: regeneration.requestId, idempotent: true });
      expect(() => requestVideoProductionRegeneration(db, dami, production.project_id, shot.shotId, { ...regenInput, reason: "Different payload" })).toThrow("video_production_regeneration_idempotency_conflict");
      const dependentVersion = Number((db.prepare("SELECT current_version FROM video_production_shots WHERE project_id=? AND shot_id='shot-reference-a'").get(production.project_id) as { current_version: number }).current_version);
      expect(() => requestVideoProductionRegeneration(db, dami, production.project_id, "shot-reference-a", { ...regenInput, expectedShotVersion: dependentVersion, idempotencyKey: "regen-wrong-shot" })).toThrow("video_production_rejected_take_required");
      db.prepare("UPDATE video_production_scenes SET is_required=1 WHERE project_id=? AND scene_id='scene-race'").run(production.project_id);
      expect(await isVideoProductionManifestCurrent(db, production.project_id, manifest.manifestId, root)).toBe(false);
      db.prepare("UPDATE video_production_scenes SET is_required=0 WHERE project_id=? AND scene_id='scene-race'").run(production.project_id);
      const registry = await listVideoProductionRegistry(db, production.project_id, root);
      expect((registry.takes as Array<Record<string, unknown>>).find((item) => item.take_id === take2.takeId)).toMatchObject({ latest_decision: "rejected", latest_feedback: "Tighten the cut before resubmission.", current_approved: 0 });
      const storedPath = path.join(root, production.project_id, stored.sha256);
      chmodSync(storedPath, 0o644);
      writeFileSync(storedPath, Buffer.from("0000ftyp tampered"));
      expect(await registryStorage.verifyVideoProductionAsset(root, stored)).toBe(false);
      expect(() => db.prepare("UPDATE video_production_assets SET metadata_json='{}' WHERE project_id=? AND asset_id='asset-e2e'").run(production.project_id))
        .toThrow("assets_are_immutable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
