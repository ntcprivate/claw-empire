import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../bootstrap/schema/task-schema-migrations.ts";
import { ensureVideoProductionSchema } from "../bootstrap/schema/video-production-schema.ts";
import { decideVideoProduction, ingestVideoProductionDirective } from "./video-production.ts";
import {
  grantVideoProductionProjectAgent,
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
import { Readable } from "node:stream";

const databases: DatabaseSync[] = [];
let fixtureSequence = 0;
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function createStudio() {
  const db = new DatabaseSync(":memory:");
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
  });

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
