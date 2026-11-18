import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  VideoProductionAssetMetadataSchema,
  VideoProductionReferenceLinkSchema,
  VideoProductionSceneContentSchema,
  VideoProductionShotContentSchema,
  VideoProductionTakeMetadataSchema,
  VideoProductionVisualReferenceSchema,
  type VideoProductionAssetMetadata,
  type VideoProductionReferenceLink,
  type VideoProductionSceneContent,
  type VideoProductionShotContent,
  type VideoProductionTakeMetadata,
} from "../../../shared/video-production-registry.ts";
import type { VideoStudioAction } from "../../../shared/video-studio-organization.ts";
import type { VideoProductionAgentActor } from "./video-production-rbac.ts";
import {
  assertVideoProductionAgentAttemptCurrent,
  videoStudioRoleAllows,
} from "./video-production-rbac.ts";
import { VideoProductionPolicyError } from "./video-production.ts";
import type { StoredVideoProductionAsset } from "./video-production-registry-storage.ts";
import { verifyVideoProductionAsset } from "./video-production-registry-storage.ts";

type Db = Pick<DatabaseSync, "prepare" | "exec">;
type SceneRow = { scene_id: string; current_version: number; sort_order: number; is_required: number; deleted_at: number | null };
type ShotRow = { shot_id: string; scene_id: string; current_version: number; sort_order: number; is_required: number; deleted_at: number | null };

function transaction<T>(db: Db, work: () => T): T {
  const key = `vp_registry_${randomUUID().replaceAll("-", "")}`;
  db.exec(`SAVEPOINT ${key}`);
  try {
    const result = work();
    db.exec(`RELEASE SAVEPOINT ${key}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${key}`);
    db.exec(`RELEASE SAVEPOINT ${key}`);
    throw error;
  }
}

function fail(code: string, status = 409): never {
  throw new VideoProductionPolicyError(code, status);
}

function parse<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, value: unknown, code: string): T {
  const result = schema.safeParse(value);
  if (!result.success) fail(code, 400);
  return result.data;
}

function assertActor(db: Db, actor: VideoProductionAgentActor, projectId: string, action: VideoStudioAction) {
  return assertVideoProductionAgentAttemptCurrent(db, actor, projectId, action);
}

function audit(db: Db, projectId: string, event: string, actorId: string, detail: unknown): void {
  db.prepare(`INSERT INTO video_production_events(project_id,event,actor_id,detail_json,created_at)
    VALUES(?,?,?,?,?)`).run(projectId, event, actorId, JSON.stringify(detail), Date.now());
}

function currentScene(db: Db, projectId: string, sceneId: string): SceneRow {
  const row = db.prepare("SELECT scene_id,current_version,sort_order,is_required,deleted_at FROM video_production_scenes WHERE project_id=? AND scene_id=?")
    .get(projectId, sceneId) as SceneRow | undefined;
  if (!row || row.deleted_at !== null) fail("video_production_scene_not_found", 404);
  return row;
}

function currentShot(db: Db, projectId: string, shotId: string): ShotRow {
  const row = db.prepare("SELECT shot_id,scene_id,current_version,sort_order,is_required,deleted_at FROM video_production_shots WHERE project_id=? AND shot_id=?")
    .get(projectId, shotId) as ShotRow | undefined;
  if (!row || row.deleted_at !== null) fail("video_production_shot_not_found", 404);
  return row;
}

function nextOrder(db: Db, table: "video_production_scenes" | "video_production_shots", projectId: string, sceneId?: string): number {
  if (table === "video_production_scenes") {
    return Number((db.prepare("SELECT COALESCE(MAX(sort_order)+1,0) AS value FROM video_production_scenes WHERE project_id=? AND deleted_at IS NULL").get(projectId) as { value: number }).value);
  }
  if (!sceneId) fail("video_production_scene_required", 400);
  return Number((db.prepare("SELECT COALESCE(MAX(sort_order)+1,0) AS value FROM video_production_shots WHERE project_id=? AND scene_id=? AND deleted_at IS NULL").get(projectId, sceneId) as { value: number }).value);
}

function recordSceneVersion(db: Db, projectId: string, sceneId: string, version: number, sortOrder: number, content: VideoProductionSceneContent, actor: VideoProductionAgentActor): void {
  assertActor(db, actor, projectId, "screenplay.write");
  const attempt = assertVideoProductionAgentAttemptCurrent(db, actor, projectId, "screenplay.write");
  db.prepare(`INSERT INTO video_production_scene_versions
    (project_id,scene_id,version,sort_order,description,location,characters_json,continuity_json,created_by_agent_id,task_id,attempt_id,attempt_plan_version,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(projectId, sceneId, version, sortOrder, content.description, content.location,
    JSON.stringify(content.characters), JSON.stringify(content.continuity), actor.agentId, attempt.task_id, attempt.attempt_id, attempt.plan_version, Date.now());
}

function recordShotVersion(db: Db, projectId: string, shotId: string, sceneId: string, version: number, sortOrder: number, content: VideoProductionShotContent, actor: VideoProductionAgentActor): void {
  const attempt = assertActor(db, actor, projectId, "shot_spec.write");
  const scene = currentScene(db, projectId, sceneId);
  db.prepare(`INSERT INTO video_production_shot_versions
    (project_id,shot_id,version,scene_id,scene_version,sort_order,action,camera_json,duration_ms,references_json,created_by_agent_id,task_id,attempt_id,attempt_plan_version,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,'[]',?,?,?,?,?)`).run(projectId, shotId, version, sceneId, scene.current_version, sortOrder,
    content.action, JSON.stringify(content.camera), content.durationMs, actor.agentId, attempt.task_id, attempt.attempt_id, attempt.plan_version, Date.now());
  db.prepare(`UPDATE video_production_shots SET current_version=?,sort_order=?,is_required=?,updated_at=? WHERE project_id=? AND shot_id=?`)
    .run(version, sortOrder, Number(content.required), Date.now(), projectId, shotId);
  markApprovedManifestDependenciesStale(db, projectId, shotId, version);
}

function copyShotReferenceSnapshot(db: Db, projectId: string, shotId: string, sourceVersion: number, destinationVersion: number, actor: VideoProductionAgentActor, excludeKey?: string): void {
  const attempt = assertActor(db, actor, projectId, actor.action);
  const rows = db.prepare(`SELECT reference_key,reference_type,target_shot_id,target_shot_version,target_asset_id,target_reference_id,target_reference_version
    FROM video_production_shot_references WHERE project_id=? AND shot_id=? AND shot_version=? AND (? IS NULL OR reference_key<>?)`).all(projectId, shotId, sourceVersion, excludeKey ?? null, excludeKey ?? null) as Array<Record<string, unknown>>;
  const insert = db.prepare(`INSERT INTO video_production_shot_references(project_id,shot_id,shot_version,reference_key,reference_type,target_shot_id,target_shot_version,target_asset_id,target_reference_id,target_reference_version,created_by,task_id,attempt_id,attempt_plan_version,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of rows) {
    insert.run(projectId, shotId, destinationVersion, String(row.reference_key), String(row.reference_type),
      row.target_shot_id == null ? null : String(row.target_shot_id), row.target_shot_version == null ? null : Number(row.target_shot_version),
      row.target_asset_id == null ? null : String(row.target_asset_id), row.target_reference_id == null ? null : String(row.target_reference_id),
      row.target_reference_version == null ? null : Number(row.target_reference_version), actor.agentId,
      attempt.task_id, attempt.attempt_id, attempt.plan_version, Date.now());
  }
}

function currentShotSceneVersion(db: Db, projectId: string, shotId: string, shotVersion: number): boolean {
  const row = db.prepare(`SELECT sh.deleted_at AS shot_deleted,sc.deleted_at AS scene_deleted,sv.scene_version,sc.current_version AS scene_current
    FROM video_production_shots sh JOIN video_production_shot_versions sv
      ON sv.project_id=sh.project_id AND sv.shot_id=sh.shot_id AND sv.version=?
    JOIN video_production_scenes sc ON sc.project_id=sh.project_id AND sc.scene_id=sh.scene_id
    WHERE sh.project_id=? AND sh.shot_id=?`).get(shotVersion, projectId, shotId) as { shot_deleted: number | null; scene_deleted: number | null; scene_version: number; scene_current: number } | undefined;
  return Boolean(row && row.shot_deleted === null && row.scene_deleted === null && row.scene_version === row.scene_current);
}

function markApprovedManifestDependenciesStale(db: Db, projectId: string, changedShotId: string, newVersion: number): void {
  // An immutable old manifest remains historical; staleness is computed dynamically from current heads/references.
  db.prepare(`INSERT INTO video_production_events(project_id,event,actor_id,detail_json,created_at)
    VALUES(?,?,?,?,?)`).run(projectId, "registry_dependency_version_changed", "system_registry", JSON.stringify({ changedShotId, newVersion }), Date.now());
}

export async function listVideoProductionRegistry(db: Db, projectId: string, storageRoot: string): Promise<Record<string, unknown>> {
  const production = db.prepare("SELECT project_id,manager_agent_id,state,plan_version,approved_version FROM video_productions WHERE project_id=?").get(projectId);
  if (!production) fail("video_production_not_found", 404);
  const scenes = db.prepare(`SELECT s.*,v.description,v.location,v.characters_json,v.continuity_json
    FROM video_production_scenes s JOIN video_production_scene_versions v
      ON v.project_id=s.project_id AND v.scene_id=s.scene_id AND v.version=s.current_version
    WHERE s.project_id=? AND s.deleted_at IS NULL ORDER BY s.sort_order,s.scene_id`).all(projectId);
  const shots = db.prepare(`SELECT s.*,v.action,v.camera_json,v.duration_ms
    FROM video_production_shots s JOIN video_production_shot_versions v
      ON v.project_id=s.project_id AND v.shot_id=s.shot_id AND v.version=s.current_version
    WHERE s.project_id=? AND s.deleted_at IS NULL ORDER BY s.scene_id,s.sort_order,s.shot_id`).all(projectId);
  const takes = db.prepare(`SELECT t.*,r.decision AS latest_decision,r.feedback AS latest_feedback,r.reviewer_agent_id AS latest_reviewer,r.created_at AS latest_reviewed_at,a.sha256,a.byte_size,a.content_type,
      CASE WHEN at.take_id=t.take_id THEN 1 ELSE 0 END AS current_approved
    FROM video_production_takes t JOIN video_production_assets a ON a.project_id=t.project_id AND a.asset_id=t.asset_id
    LEFT JOIN video_production_take_reviews r ON r.project_id=t.project_id AND r.take_id=t.take_id
      AND r.review_number=(SELECT MAX(r2.review_number) FROM video_production_take_reviews r2 WHERE r2.project_id=t.project_id AND r2.take_id=t.take_id)
    LEFT JOIN video_production_approved_takes at ON at.project_id=t.project_id AND at.shot_id=t.shot_id AND at.take_id=t.take_id
    WHERE t.project_id=? ORDER BY t.submitted_at DESC`).all(projectId);
  const assets = db.prepare(`SELECT a.asset_id,a.shot_id,a.shot_version,a.asset_type,a.sha256,a.byte_size,a.content_type,a.metadata_json,a.uploaded_by,a.created_at
    FROM video_production_assets a WHERE a.project_id=? ORDER BY a.created_at DESC`).all(projectId);
  const references = db.prepare(`SELECT r.reference_id,r.reference_type,r.owner_shot_id,r.current_version,v.asset_id,v.metadata_json AS version_metadata,
      a.sha256,a.byte_size,a.content_type,r.created_by_agent_id,r.created_at
    FROM video_production_visual_references r JOIN video_production_visual_reference_versions v
      ON v.project_id=r.project_id AND v.reference_id=r.reference_id AND v.version=r.current_version
    JOIN video_production_assets a ON a.project_id=v.project_id AND a.asset_id=v.asset_id
    WHERE r.project_id=? AND r.deleted_at IS NULL ORDER BY r.created_at,r.reference_id`).all(projectId);
  const shotDependencies = db.prepare(`SELECT r.shot_id,r.shot_version,r.reference_key,r.reference_type,r.target_shot_id,r.target_shot_version,
      r.target_asset_id,r.target_reference_id,r.target_reference_version
    FROM video_production_shot_references r JOIN video_production_shots s ON s.project_id=r.project_id AND s.shot_id=r.shot_id AND s.current_version=r.shot_version
    WHERE r.project_id=? ORDER BY r.shot_id,r.reference_key`).all(projectId) as Array<Record<string, unknown>>;
  const dependencies = shotDependencies.map((dependency) => ({ ...dependency, stale: getStaleReferenceKeys(db, projectId, String(dependency.shot_id), Number(dependency.shot_version)).includes(String(dependency.reference_key)) }));
  const regenerationRequests = db.prepare("SELECT request_id,shot_id,shot_version,rejected_take_id,idempotency_key,request_fingerprint,status,requested_by_agent_id,created_at FROM video_production_regeneration_requests WHERE project_id=? ORDER BY created_at DESC").all(projectId);
  const manifests = db.prepare("SELECT manifest_id,manifest_version,plan_version,digest_sha256,created_at FROM video_production_manifests WHERE project_id=? ORDER BY manifest_version DESC").all(projectId) as Array<{ manifest_id: string; manifest_version: number; plan_version: number; digest_sha256: string; created_at: number }>;
  const manifestStates = await Promise.all(manifests.map(async (manifest) => ({ ...manifest, current: await isVideoProductionManifestCurrent(db, projectId, manifest.manifest_id, storageRoot) })));
  return { production, scenes, shots, takes, assets, visualReferences: references, dependencies, regenerationRequests, manifests: manifestStates };
}

export function createVideoProductionScene(db: Db, actor: VideoProductionAgentActor, projectId: string, input: { sceneId: string; content: unknown; sortOrder?: number; required?: boolean }) {
  assertActor(db, actor, projectId, "screenplay.write");
  const content = parse(VideoProductionSceneContentSchema, input.content, "video_production_scene_invalid");
  const order = input.sortOrder ?? nextOrder(db, "video_production_scenes", projectId);
  if (!Number.isSafeInteger(order) || order < 0) fail("video_production_scene_order_invalid", 400);
  return transaction(db, () => {
    const attempt = assertActor(db, actor, projectId, "screenplay.write");
    db.prepare(`INSERT INTO video_production_scenes(project_id,scene_id,current_version,sort_order,is_required,created_by_agent_id,task_id,attempt_id,attempt_plan_version,created_at,updated_at)
      VALUES(?,?,1,?,?,?, ?,?,?,?,?)`).run(projectId, input.sceneId, order, Number(input.required ?? true), actor.agentId,
      attempt.task_id, attempt.attempt_id, attempt.plan_version, Date.now(), Date.now());
    recordSceneVersion(db, projectId, input.sceneId, 1, order, { ...content, continuity: content.continuity ?? {} }, actor);
    audit(db, projectId, "scene_created", actor.agentId, { sceneId: input.sceneId, version: 1 });
    return { sceneId: input.sceneId, version: 1, sortOrder: order };
  });
}

export function updateVideoProductionScene(db: Db, actor: VideoProductionAgentActor, projectId: string, sceneId: string, expectedVersion: number, input: { content: unknown; sortOrder?: number; required?: boolean }) {
  const content = parse(VideoProductionSceneContentSchema, input.content, "video_production_scene_invalid");
  return transaction(db, () => {
    assertActor(db, actor, projectId, "screenplay.write");
    const current = currentScene(db, projectId, sceneId);
    if (current.current_version !== expectedVersion) fail("video_production_scene_version_conflict");
    const version = expectedVersion + 1;
    const order = input.sortOrder ?? current.sort_order;
    recordSceneVersion(db, projectId, sceneId, version, order, content, actor);
    db.prepare("UPDATE video_production_scenes SET current_version=?,sort_order=?,is_required=?,updated_at=? WHERE project_id=? AND scene_id=? AND current_version=?")
      .run(version, order, Number(input.required ?? (current.is_required === 1)), Date.now(), projectId, sceneId, expectedVersion);
    db.prepare(`UPDATE video_production_shots SET updated_at=? WHERE project_id=? AND scene_id=? AND deleted_at IS NULL`).run(Date.now(), projectId, sceneId);
    audit(db, projectId, "scene_version_created", actor.agentId, { sceneId, version });
    return { sceneId, version, sortOrder: order };
  });
}

export function reorderVideoProductionScenes(db: Db, actor: VideoProductionAgentActor, projectId: string, sceneIds: string[]) {
  assertActor(db, actor, projectId, "screenplay.write");
  if (!Array.isArray(sceneIds) || new Set(sceneIds).size !== sceneIds.length) fail("video_production_scene_order_invalid", 400);
  return transaction(db, () => {
    assertActor(db, actor, projectId, "screenplay.write");
    const active = (db.prepare("SELECT scene_id FROM video_production_scenes WHERE project_id=? AND deleted_at IS NULL ORDER BY sort_order").all(projectId) as Array<{ scene_id: string }>).map((row) => row.scene_id);
    if (active.length !== sceneIds.length || active.some((id) => !sceneIds.includes(id))) fail("video_production_scene_order_incomplete", 400);
    db.prepare("UPDATE video_production_scenes SET sort_order=sort_order+1000000 WHERE project_id=? AND deleted_at IS NULL").run(projectId);
    sceneIds.forEach((id, index) => db.prepare("UPDATE video_production_scenes SET sort_order=?,updated_at=? WHERE project_id=? AND scene_id=? AND deleted_at IS NULL").run(index, Date.now(), projectId, id));
    audit(db, projectId, "scenes_reordered", actor.agentId, { sceneIds });
    return { sceneIds };
  });
}

export function softDeleteVideoProductionScene(db: Db, actor: VideoProductionAgentActor, projectId: string, sceneId: string, expectedVersion: number) {
  return transaction(db, () => {
    assertActor(db, actor, projectId, "screenplay.write");
    const scene = currentScene(db, projectId, sceneId);
    if (scene.current_version !== expectedVersion) fail("video_production_scene_version_conflict");
    const activeShot = db.prepare("SELECT 1 FROM video_production_shots WHERE project_id=? AND scene_id=? AND deleted_at IS NULL LIMIT 1").get(projectId, sceneId);
    if (activeShot) fail("video_production_scene_has_active_shots");
    db.prepare("UPDATE video_production_scenes SET deleted_at=?,updated_at=? WHERE project_id=? AND scene_id=? AND current_version=?").run(Date.now(), Date.now(), projectId, sceneId, expectedVersion);
    audit(db, projectId, "scene_soft_deleted", actor.agentId, { sceneId, expectedVersion });
    return { sceneId, deleted: true };
  });
}

export function createVideoProductionShot(db: Db, actor: VideoProductionAgentActor, projectId: string, sceneId: string, input: { shotId: string; content: unknown; sortOrder?: number }) {
  assertActor(db, actor, projectId, "shot_spec.write");
  const content = parse(VideoProductionShotContentSchema, input.content, "video_production_shot_invalid");
  const order = input.sortOrder ?? nextOrder(db, "video_production_shots", projectId, sceneId);
  return transaction(db, () => {
    const attempt = assertActor(db, actor, projectId, "shot_spec.write");
    currentScene(db, projectId, sceneId);
    db.prepare(`INSERT INTO video_production_shots(project_id,scene_id,shot_id,current_version,sort_order,is_required,created_by_agent_id,task_id,attempt_id,attempt_plan_version,created_at,updated_at)
      VALUES(?,?,?,1,?,?,?, ?,?,?,?,?)`).run(projectId, sceneId, input.shotId, order, Number(content.required), actor.agentId,
      attempt.task_id, attempt.attempt_id, attempt.plan_version, Date.now(), Date.now());
    recordShotVersion(db, projectId, input.shotId, sceneId, 1, order, content, actor);
    audit(db, projectId, "shot_created", actor.agentId, { sceneId, shotId: input.shotId, version: 1 });
    return { shotId: input.shotId, sceneId, version: 1, sortOrder: order };
  });
}

export function updateVideoProductionShot(db: Db, actor: VideoProductionAgentActor, projectId: string, shotId: string, expectedVersion: number, contentInput: unknown) {
  const content = parse(VideoProductionShotContentSchema, contentInput, "video_production_shot_invalid");
  return transaction(db, () => {
    assertActor(db, actor, projectId, "shot_spec.write");
    const current = currentShot(db, projectId, shotId);
    if (current.current_version !== expectedVersion) fail("video_production_shot_version_conflict");
    recordShotVersion(db, projectId, shotId, current.scene_id, expectedVersion + 1, current.sort_order, content, actor);
    copyShotReferenceSnapshot(db, projectId, shotId, expectedVersion, expectedVersion + 1, actor);
    audit(db, projectId, "shot_version_created", actor.agentId, { shotId, version: expectedVersion + 1 });
    return { shotId, version: expectedVersion + 1 };
  });
}

export function reorderVideoProductionShots(db: Db, actor: VideoProductionAgentActor, projectId: string, sceneId: string, shotIds: string[]) {
  return transaction(db, () => {
    const activeAttempt = assertActor(db, actor, projectId, "shot_spec.write");
    currentScene(db, projectId, sceneId);
    const current = db.prepare("SELECT shot_id, current_version FROM video_production_shots WHERE project_id=? AND scene_id=? AND deleted_at IS NULL ORDER BY sort_order").all(projectId, sceneId) as Array<{ shot_id: string; current_version: number }>;
    if (current.length !== shotIds.length || new Set(shotIds).size !== shotIds.length || current.some((row) => !shotIds.includes(row.shot_id))) fail("video_production_shot_order_incomplete", 400);
    db.prepare("UPDATE video_production_shots SET sort_order=sort_order+1000000 WHERE project_id=? AND scene_id=? AND deleted_at IS NULL").run(projectId, sceneId);
    shotIds.forEach((shotId, index) => {
      const shot = current.find((row) => row.shot_id === shotId)!;
      db.prepare("UPDATE video_production_shots SET sort_order=?,updated_at=? WHERE project_id=? AND shot_id=?").run(index, Date.now(), projectId, shotId);
      const spec = db.prepare("SELECT * FROM video_production_shot_versions WHERE project_id=? AND shot_id=? AND version=?").get(projectId, shotId, shot.current_version) as Record<string, unknown>;
      db.prepare("INSERT INTO video_production_shot_versions(project_id,shot_id,version,scene_id,scene_version,sort_order,action,camera_json,duration_ms,references_json,created_by_agent_id,task_id,attempt_id,attempt_plan_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(projectId, shotId, shot.current_version + 1, sceneId, Number(spec.scene_version), index, String(spec.action), String(spec.camera_json), Number(spec.duration_ms),
          String(spec.references_json), actor.agentId, activeAttempt.task_id, activeAttempt.attempt_id, activeAttempt.plan_version, Date.now());
      db.prepare("UPDATE video_production_shots SET current_version=? WHERE project_id=? AND shot_id=?").run(shot.current_version + 1, projectId, shotId);
      copyShotReferenceSnapshot(db, projectId, shotId, shot.current_version, shot.current_version + 1, actor);
      markApprovedManifestDependenciesStale(db, projectId, shotId, shot.current_version + 1);
    });
    audit(db, projectId, "shots_reordered", actor.agentId, { sceneId, shotIds });
    return { sceneId, shotIds };
  });
}

export function softDeleteVideoProductionShot(db: Db, actor: VideoProductionAgentActor, projectId: string, shotId: string, expectedVersion: number) {
  return transaction(db, () => {
    assertActor(db, actor, projectId, "shot_spec.write");
    const shot = currentShot(db, projectId, shotId);
    if (shot.current_version !== expectedVersion) fail("video_production_shot_version_conflict");
    db.prepare("UPDATE video_production_shots SET deleted_at=?,updated_at=? WHERE project_id=? AND shot_id=? AND current_version=?").run(Date.now(), Date.now(), projectId, shotId, expectedVersion);
    audit(db, projectId, "shot_soft_deleted", actor.agentId, { shotId, expectedVersion });
    return { shotId, deleted: true };
  });
}

export async function registerVideoProductionAsset(db: Db, actor: VideoProductionAgentActor, input: {
  projectId: string; assetId: string; assetType: "visual_reference" | "footage" | "audio" | "continuity";
  stored: StoredVideoProductionAsset; metadata: unknown; idempotencyKey: string; shotId?: string; shotVersion?: number;
}, storageRoot: string) {
  const action: VideoStudioAction = input.assetType === "visual_reference" || input.assetType === "continuity" ? "visual.manage" : "footage.submit";
  if (input.stored.projectId !== input.projectId) fail("video_production_asset_storage_invalid", 400);
  if (!await verifyVideoProductionAsset(storageRoot, input.stored)) fail("video_production_asset_bytes_not_verified", 409);
  return transaction(db, () => {
    const attempt = assertActor(db, actor, input.projectId, action);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.assetId) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey)) fail("video_production_asset_id_invalid", 400);
    if (input.stored.projectId !== input.projectId || !/^[a-f0-9]{64}$/.test(input.stored.sha256) || input.stored.storageKey !== `${input.projectId}/${input.stored.sha256}`) fail("video_production_asset_storage_invalid", 400);
    const metadata = parse(VideoProductionAssetMetadataSchema, input.metadata, "video_production_asset_metadata_invalid") as VideoProductionAssetMetadata;
    if (input.shotId) {
      const shot = currentShot(db, input.projectId, input.shotId);
      if (shot.current_version !== input.shotVersion) fail("video_production_shot_version_conflict");
    }
    const existing = db.prepare("SELECT asset_id,sha256,storage_key,byte_size,asset_type FROM video_production_assets WHERE project_id=? AND idempotency_key=?")
      .get(input.projectId, input.idempotencyKey) as { asset_id: string; sha256: string; storage_key: string; byte_size: number; asset_type: string } | undefined;
    if (existing) {
      if (existing.asset_id !== input.assetId || existing.sha256 !== input.stored.sha256 || existing.asset_type !== input.assetType) fail("video_production_asset_idempotency_conflict");
      return existing;
    }
    db.prepare(`INSERT INTO video_production_assets
      (project_id,asset_id,shot_id,shot_version,asset_type,storage_key,sha256,byte_size,content_type,metadata_json,idempotency_key,uploaded_by,task_id,attempt_id,attempt_plan_version,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.projectId, input.assetId, input.shotId ?? null, input.shotVersion ?? null,
      input.assetType, input.stored.storageKey, input.stored.sha256, input.stored.byteSize, input.stored.contentType,
      JSON.stringify(metadata), input.idempotencyKey, actor.agentId, attempt.task_id, attempt.attempt_id, attempt.plan_version, Date.now());
    audit(db, input.projectId, "registry_asset_registered", actor.agentId, { assetId: input.assetId, type: input.assetType, sha256: input.stored.sha256, attemptId: attempt.attempt_id });
    return { assetId: input.assetId, sha256: input.stored.sha256, storageKey: input.stored.storageKey, byteSize: input.stored.byteSize, metadata };
  });
}

export function createVideoProductionVisualReference(db: Db, actor: VideoProductionAgentActor, projectId: string, input: { definition: unknown; assetId: string }) {
  const definition = parse(VideoProductionVisualReferenceSchema, input.definition, "video_production_visual_reference_invalid");
  return transaction(db, () => {
    const attempt = assertActor(db, actor, projectId, "visual.manage");
    const asset = db.prepare("SELECT asset_type FROM video_production_assets WHERE project_id=? AND asset_id=?").get(projectId, input.assetId) as { asset_type: string } | undefined;
    if (!asset || asset.asset_type !== "visual_reference") fail("video_production_visual_reference_asset_required", 409);
    if (definition.ownerShotId) currentShot(db, projectId, definition.ownerShotId);
    db.prepare(`INSERT INTO video_production_visual_references(project_id,reference_id,reference_type,owner_shot_id,current_version,created_by_agent_id,task_id,attempt_id,attempt_plan_version,created_at,updated_at)
      VALUES(?,?,?,?,1,?,?,?,?,?,?)`).run(projectId, definition.referenceId, definition.referenceType, definition.ownerShotId,
      actor.agentId, attempt.task_id, attempt.attempt_id, attempt.plan_version, Date.now(), Date.now());
    db.prepare(`INSERT INTO video_production_visual_reference_versions(project_id,reference_id,version,asset_id,metadata_json,created_by_agent_id,task_id,attempt_id,attempt_plan_version,created_at)
      VALUES(?,?,1,?,?,?,?,?,?,?)`).run(projectId, definition.referenceId, input.assetId, JSON.stringify({ name: definition.name, ...definition.metadata }),
      actor.agentId, attempt.task_id, attempt.attempt_id, attempt.plan_version, Date.now());
    audit(db, projectId, "visual_reference_created", actor.agentId, { referenceId: definition.referenceId, version: 1, assetId: input.assetId });
    return { referenceId: definition.referenceId, version: 1 };
  });
}

export function updateVideoProductionVisualReference(db: Db, actor: VideoProductionAgentActor, projectId: string, referenceId: string, expectedVersion: number, input: { assetId: string; metadata: unknown }) {
  return transaction(db, () => {
    const attempt = assertActor(db, actor, projectId, "visual.manage");
    const reference = db.prepare("SELECT current_version FROM video_production_visual_references WHERE project_id=? AND reference_id=? AND deleted_at IS NULL").get(projectId, referenceId) as { current_version: number } | undefined;
    if (!reference) fail("video_production_visual_reference_not_found", 404);
    if (reference.current_version !== expectedVersion) fail("video_production_reference_version_conflict");
    const asset = db.prepare("SELECT asset_type FROM video_production_assets WHERE project_id=? AND asset_id=?").get(projectId, input.assetId) as { asset_type: string } | undefined;
    if (!asset || asset.asset_type !== "visual_reference") fail("video_production_visual_reference_asset_required", 409);
    const version = expectedVersion + 1;
    db.prepare(`INSERT INTO video_production_visual_reference_versions(project_id,reference_id,version,asset_id,metadata_json,created_by_agent_id,task_id,attempt_id,attempt_plan_version,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(projectId, referenceId, version, input.assetId, JSON.stringify(input.metadata), actor.agentId,
      attempt.task_id, attempt.attempt_id, attempt.plan_version, Date.now());
    db.prepare("UPDATE video_production_visual_references SET current_version=?,updated_at=? WHERE project_id=? AND reference_id=? AND current_version=?")
      .run(version, Date.now(), projectId, referenceId, expectedVersion);
    db.prepare(`INSERT INTO video_production_events(project_id,event,actor_id,detail_json,created_at)
      VALUES(?,?,?,?,?)`).run(projectId, "registry_reference_dependencies_stale", actor.agentId,
      JSON.stringify({ referenceId, previousVersion: expectedVersion, currentVersion: version }), Date.now());
    return { referenceId, version, staleDependencyCount: Number((db.prepare("SELECT COUNT(DISTINCT shot_id) AS count FROM video_production_shot_references WHERE project_id=? AND target_reference_id=? AND target_reference_version=?").get(projectId, referenceId, expectedVersion) as { count: number }).count) };
  });
}

export function linkVideoProductionShotReference(db: Db, actor: VideoProductionAgentActor, projectId: string, shotId: string, expectedShotVersion: number, input: unknown) {
  const reference = parse(VideoProductionReferenceLinkSchema, input, "video_production_reference_link_invalid") as VideoProductionReferenceLink;
  return transaction(db, () => {
    const attempt = assertActor(db, actor, projectId, "visual.manage");
    const shot = currentShot(db, projectId, shotId);
    if (shot.current_version !== expectedShotVersion) fail("video_production_shot_version_conflict");
    const version = expectedShotVersion + 1;
    const spec = db.prepare("SELECT * FROM video_production_shot_versions WHERE project_id=? AND shot_id=? AND version=?").get(projectId, shotId, expectedShotVersion) as Record<string, unknown>;
    const links = JSON.parse(String(spec.references_json)) as VideoProductionReferenceLink[];
    const withoutSame = links.filter((entry) => entry.referenceKey !== reference.referenceKey);
    withoutSame.push(reference);
    const target = reference.target;
    if (target.kind === "shot") {
      const targetShot = db.prepare("SELECT current_version,deleted_at FROM video_production_shots WHERE project_id=? AND shot_id=?").get(projectId, target.shotId) as { current_version: number; deleted_at: number | null } | undefined;
      if (!targetShot || targetShot.deleted_at !== null || targetShot.current_version !== target.version || target.shotId === shotId) fail("video_production_reference_target_stale", 409);
    } else if (target.kind === "asset") {
      if (!db.prepare("SELECT 1 FROM video_production_assets WHERE project_id=? AND asset_id=?").get(projectId, target.assetId)) fail("video_production_reference_asset_not_found", 404);
    } else {
      const current = db.prepare("SELECT current_version,deleted_at FROM video_production_visual_references WHERE project_id=? AND reference_id=?").get(projectId, target.referenceId) as { current_version: number; deleted_at: number | null } | undefined;
      if (!current || current.deleted_at !== null || current.current_version !== target.version) fail("video_production_reference_target_stale", 409);
    }
    db.prepare(`INSERT INTO video_production_shot_versions(project_id,shot_id,version,scene_id,scene_version,sort_order,action,camera_json,duration_ms,references_json,created_by_agent_id,task_id,attempt_id,attempt_plan_version,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(projectId, shotId, version, shot.scene_id, Number(spec.scene_version), shot.sort_order,
      String(spec.action), String(spec.camera_json), Number(spec.duration_ms), JSON.stringify(withoutSame), actor.agentId, attempt.task_id, attempt.attempt_id, attempt.plan_version, Date.now());
    db.prepare("UPDATE video_production_shots SET current_version=?,updated_at=? WHERE project_id=? AND shot_id=? AND current_version=?")
      .run(version, Date.now(), projectId, shotId, expectedShotVersion);
    const values = target.kind === "shot" ? [target.shotId, target.version, null, null, null]
      : target.kind === "asset" ? [null, null, target.assetId, null, null]
        : [null, null, null, target.referenceId, target.version];
    copyShotReferenceSnapshot(db, projectId, shotId, expectedShotVersion, version, actor, reference.referenceKey);
    db.prepare(`INSERT INTO video_production_shot_references(project_id,shot_id,shot_version,reference_key,reference_type,target_shot_id,target_shot_version,target_asset_id,target_reference_id,target_reference_version,created_by,task_id,attempt_id,attempt_plan_version,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(projectId, shotId, version, reference.referenceKey, reference.referenceType,
      ...values, actor.agentId, attempt.task_id, attempt.attempt_id, attempt.plan_version, Date.now());
    markApprovedManifestDependenciesStale(db, projectId, shotId, version);
    audit(db, projectId, "shot_reference_linked", actor.agentId, { shotId, version, referenceKey: reference.referenceKey, target });
    return { shotId, version };
  });
}

export function createVideoProductionTake(db: Db, actor: VideoProductionAgentActor, projectId: string, shotId: string, input: { shotVersion: number; assetId: string; metadata: unknown }) {
  const metadata = parse(VideoProductionTakeMetadataSchema, input.metadata, "video_production_take_metadata_invalid") as VideoProductionTakeMetadata;
  return transaction(db, () => {
    const attempt = assertActor(db, actor, projectId, "footage.submit");
    const shot = currentShot(db, projectId, shotId);
    if (shot.current_version !== input.shotVersion) fail("video_production_shot_version_conflict");
    if (!currentShotSceneVersion(db, projectId, shotId, input.shotVersion)) fail("video_production_scene_version_stale", 409);
    const staleReferences = getStaleReferenceKeys(db, projectId, shotId, input.shotVersion);
    if (staleReferences.length) fail("video_production_shot_references_stale", 409);
    const asset = db.prepare("SELECT asset_type,sha256 FROM video_production_assets WHERE project_id=? AND asset_id=? AND shot_id=? AND shot_version=?")
      .get(projectId, input.assetId, shotId, input.shotVersion) as { asset_type: string; sha256: string } | undefined;
    if (!asset || (asset.asset_type !== "footage" && asset.asset_type !== "audio")) fail("video_production_take_asset_invalid", 409);
    const takeNumber = Number((db.prepare("SELECT COALESCE(MAX(take_number)+1,1) AS value FROM video_production_takes WHERE project_id=? AND shot_id=? AND shot_version=?")
      .get(projectId, shotId, input.shotVersion) as { value: number }).value);
    const takeId = randomUUID();
    const fingerprint = createHash("sha256").update(JSON.stringify({ shotId, shotVersion: input.shotVersion, assetId: input.assetId, metadata })).digest("hex");
    db.prepare(`INSERT INTO video_production_takes(project_id,take_id,shot_id,shot_version,take_number,asset_id,attempt_metadata_json,content_fingerprint,submitted_by,task_id,attempt_id,attempt_plan_version,submitted_at)
      VALUES(?,?,?,?,?,?,?, ?,?,?,?,?,?)`).run(projectId, takeId, shotId, input.shotVersion, takeNumber, input.assetId,
      JSON.stringify(metadata), fingerprint, actor.agentId, attempt.task_id, attempt.attempt_id, attempt.plan_version, Date.now());
    audit(db, projectId, "take_submitted", actor.agentId, { takeId, shotId, shotVersion: input.shotVersion, assetId: input.assetId, attemptId: attempt.attempt_id });
    return { takeId, takeNumber, shotId, shotVersion: input.shotVersion, assetId: input.assetId, status: "submitted", integrity: "metadata_only" };
  });
}

function getStaleReferenceKeys(db: Db, projectId: string, shotId: string, shotVersion: number): string[] {
  if (!currentShotSceneVersion(db, projectId, shotId, shotVersion)) return ["scene_version"];
  const rows = db.prepare(`SELECT r.reference_key,r.target_shot_id,r.target_shot_version,r.target_asset_id,r.target_reference_id,r.target_reference_version
    FROM video_production_shot_references r WHERE r.project_id=? AND r.shot_id=? AND r.shot_version=?`).all(projectId, shotId, shotVersion) as Array<Record<string, unknown>>;
  return rows.filter((row) => {
    if (row.target_shot_id) {
      const target = db.prepare("SELECT current_version,deleted_at FROM video_production_shots WHERE project_id=? AND shot_id=?").get(projectId, String(row.target_shot_id)) as { current_version: number; deleted_at: number | null } | undefined;
      return !target || target.deleted_at !== null || target.current_version !== row.target_shot_version;
    }
    if (row.target_reference_id) {
      const target = db.prepare("SELECT current_version,deleted_at FROM video_production_visual_references WHERE project_id=? AND reference_id=?").get(projectId, String(row.target_reference_id)) as { current_version: number; deleted_at: number | null } | undefined;
      return !target || target.deleted_at !== null || target.current_version !== row.target_reference_version;
    }
    if (row.target_asset_id) return !db.prepare("SELECT 1 FROM video_production_assets WHERE project_id=? AND asset_id=?").get(projectId, String(row.target_asset_id));
    return true;
  }).map((row) => String(row.reference_key));
}

export async function reviewVideoProductionTake(db: Db, actor: VideoProductionAgentActor, projectId: string, takeId: string, input: { expectedShotVersion: number; expectedAssetId: string; decision: "approved" | "rejected"; feedback: string }, storageRoot: string) {
  if (actor.roleKey !== "art_director" || !videoStudioRoleAllows(actor.roleKey, "take.review")) fail("video_production_take_review_forbidden", 403);
  if (typeof input.feedback !== "string" || input.feedback.length > 5000 || !["approved", "rejected"].includes(input.decision)) fail("video_production_take_review_invalid", 400);
  const preflight = db.prepare(`SELECT t.shot_id,t.shot_version,t.asset_id,a.storage_key,a.sha256,a.byte_size
    FROM video_production_takes t JOIN video_production_assets a ON a.project_id=t.project_id AND a.asset_id=t.asset_id
    WHERE t.project_id=? AND t.take_id=?`).get(projectId, takeId) as { shot_id: string; shot_version: number; asset_id: string; storage_key: string; sha256: string; byte_size: number } | undefined;
  if (!preflight || preflight.shot_version !== input.expectedShotVersion || preflight.asset_id !== input.expectedAssetId) fail("video_production_take_version_stale", 409);
  if (!currentShotSceneVersion(db, projectId, preflight.shot_id, preflight.shot_version)) fail("video_production_scene_version_stale", 409);
  if (!await verifyVideoProductionAsset(storageRoot, { projectId, storageKey: preflight.storage_key, sha256: preflight.sha256, byteSize: preflight.byte_size })) fail("video_production_take_asset_integrity_failed", 409);
  return transaction(db, () => {
    const attempt = assertActor(db, actor, projectId, "take.review");
    const take = db.prepare(`SELECT t.*,s.current_version FROM video_production_takes t
      JOIN video_production_shots s ON s.project_id=t.project_id AND s.shot_id=t.shot_id
      WHERE t.project_id=? AND t.take_id=?`).get(projectId, takeId) as Record<string, unknown> | undefined;
    if (!take) fail("video_production_take_not_found", 404);
    if (take.shot_version !== input.expectedShotVersion || take.asset_id !== input.expectedAssetId || take.current_version !== input.expectedShotVersion) fail("video_production_take_version_stale", 409);
    if (!currentShotSceneVersion(db, projectId, String(take.shot_id), Number(take.shot_version))) fail("video_production_scene_version_stale", 409);
    if (getStaleReferenceKeys(db, projectId, String(take.shot_id), Number(take.shot_version)).length) fail("video_production_take_references_stale", 409);
    const latestReview = db.prepare("SELECT MAX(review_number) AS value FROM video_production_take_reviews WHERE project_id=? AND take_id=?").get(projectId, takeId) as { value: number | null };
    const reviewNumber = (latestReview.value ?? 0) + 1;
    const reviewId = randomUUID();
    db.prepare(`INSERT INTO video_production_take_reviews(project_id,review_id,take_id,shot_id,shot_version,asset_id,review_number,decision,feedback,content_fingerprint,reviewer_agent_id,task_id,attempt_id,attempt_plan_version,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(projectId, reviewId, takeId, String(take.shot_id), Number(take.shot_version), String(take.asset_id),
      reviewNumber, input.decision, input.feedback.trim(), String(take.content_fingerprint), actor.agentId, attempt.task_id, attempt.attempt_id, attempt.plan_version, Date.now());
    if (input.decision === "approved") {
      db.prepare(`INSERT INTO video_production_approved_takes(project_id,shot_id,take_id,shot_version,asset_id,review_id,updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,shot_id) DO UPDATE SET take_id=excluded.take_id,shot_version=excluded.shot_version,
          asset_id=excluded.asset_id,review_id=excluded.review_id,updated_at=excluded.updated_at`)
        .run(projectId, String(take.shot_id), takeId, Number(take.shot_version), String(take.asset_id), reviewId, Date.now());
    } else {
      db.prepare("DELETE FROM video_production_approved_takes WHERE project_id=? AND shot_id=? AND take_id=?")
        .run(projectId, String(take.shot_id), takeId);
    }
    audit(db, projectId, "take_reviewed", actor.agentId, { takeId, reviewId, decision: input.decision, shotVersion: take.shot_version, assetId: take.asset_id });
    return { reviewId, takeId, decision: input.decision, shotId: take.shot_id, shotVersion: take.shot_version };
  });
}

export function requestVideoProductionRegeneration(db: Db, actor: VideoProductionAgentActor, projectId: string, shotId: string, input: { expectedShotVersion: number; rejectedTakeId: string; idempotencyKey: string; reason: string }) {
  if (actor.roleKey !== "production_manager") fail("video_production_regeneration_forbidden", 403);
  const reason = input.reason.trim();
  if (!reason || reason.length > 4000 || !/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey)) fail("video_production_regeneration_invalid", 400);
  return transaction(db, () => {
    const attempt = assertActor(db, actor, projectId, "regeneration.request");
    const shot = currentShot(db, projectId, shotId);
    if (shot.current_version !== input.expectedShotVersion) fail("video_production_shot_version_conflict");
    if (db.prepare("SELECT 1 FROM video_production_approved_takes WHERE project_id=? AND shot_id=?").get(projectId, shotId)) fail("video_production_approved_shot_cannot_regenerate", 409);
    const review = db.prepare(`SELECT decision FROM video_production_take_reviews WHERE project_id=? AND take_id=?
      ORDER BY review_number DESC LIMIT 1`).get(projectId, input.rejectedTakeId) as { decision: string } | undefined;
    const take = db.prepare("SELECT shot_id,shot_version FROM video_production_takes WHERE project_id=? AND take_id=?").get(projectId, input.rejectedTakeId) as { shot_id: string; shot_version: number } | undefined;
    if (!take || take.shot_id !== shotId || take.shot_version !== input.expectedShotVersion || review?.decision !== "rejected") fail("video_production_rejected_take_required", 409);
    const fingerprint = createHash("sha256").update(JSON.stringify({ shotId, version: input.expectedShotVersion, rejectedTakeId: input.rejectedTakeId, reason })).digest("hex");
    const prior = db.prepare("SELECT request_id,request_fingerprint FROM video_production_regeneration_requests WHERE project_id=? AND idempotency_key=?").get(projectId, input.idempotencyKey) as { request_id: string; request_fingerprint: string } | undefined;
    if (prior) {
      if (prior.request_fingerprint !== fingerprint) fail("video_production_regeneration_idempotency_conflict", 409);
      return { requestId: prior.request_id, idempotent: true, status: "requested" };
    }
    const requestId = randomUUID();
    db.prepare(`INSERT INTO video_production_regeneration_requests(project_id,request_id,shot_id,shot_version,rejected_take_id,idempotency_key,request_fingerprint,requested_by_agent_id,task_id,attempt_id,attempt_plan_version,created_at,updated_at)
      VALUES(?,?,?,?,?,?,? ,?,?,?,?,?,?)`).run(projectId, requestId, shotId, input.expectedShotVersion, input.rejectedTakeId,
      input.idempotencyKey, fingerprint, actor.agentId, attempt.task_id, attempt.attempt_id, attempt.plan_version, Date.now(), Date.now());
    audit(db, projectId, "shot_regeneration_requested", actor.agentId, { requestId, shotId, shotVersion: input.expectedShotVersion, rejectedTakeId: input.rejectedTakeId, reason, idempotencyKey: input.idempotencyKey });
    return { requestId, idempotent: false, status: "requested" };
  });
}

export async function createVideoProductionManifest(db: Db, actor: VideoProductionAgentActor, projectId: string, storageRoot: string) {
  const preflight = manifestCandidateSnapshot(db, projectId);
  if (!manifestSnapshotComplete(preflight) || (await Promise.all(preflight.rows.map((asset) => verifyVideoProductionAsset(storageRoot, {
    projectId, storageKey: asset.storage_key, sha256: asset.sha256, byteSize: asset.byte_size,
  })))).some((valid) => !valid)) fail("video_production_manifest_asset_invalid", 409);
  return transaction(db, () => {
    const attempt = assertActor(db, actor, projectId, "edit.manage");
    const latest = manifestCandidateSnapshot(db, projectId);
    const required = latest.rows;
    if (!manifestSnapshotComplete(latest) || latest.fingerprint !== preflight.fingerprint || required.some((row) => getStaleReferenceKeys(db, projectId, row.shot_id, row.shot_version).length)) {
      fail("video_production_manifest_incomplete", 409);
    }
    for (const row of required) {
      const review = db.prepare(`SELECT decision FROM video_production_take_reviews WHERE project_id=? AND take_id=? AND review_id=(
        SELECT review_id FROM video_production_approved_takes WHERE project_id=? AND shot_id=?)`).get(projectId, String(row.take_id), projectId, String(row.shot_id)) as { decision: string } | undefined;
      if (review?.decision !== "approved") fail("video_production_manifest_approval_invalid", 409);
    }
    const manifestId = randomUUID();
    const manifestVersion = Number((db.prepare("SELECT COALESCE(MAX(manifest_version),0)+1 AS value FROM video_production_manifests WHERE project_id=?").get(projectId) as { value: number }).value);
    const entries = required.map((row) => ({ sceneId: row.scene_id, sceneVersion: row.scene_version, shotId: row.shot_id, shotVersion: row.shot_version, takeId: row.take_id, assetId: row.asset_id, sha256: row.sha256, byteSize: row.byte_size }));
    const digest = createHash("sha256").update(JSON.stringify({ projectId, planVersion: actor.planVersion, entries })).digest("hex");
    db.prepare(`INSERT INTO video_production_manifests(project_id,manifest_id,manifest_version,plan_version,status,digest_sha256,created_by_agent_id,task_id,attempt_id,attempt_plan_version,created_at)
      VALUES(?,?,?,?,'READY',?,?,?,?,?,?)`).run(projectId, manifestId, manifestVersion, attempt.plan_version, digest, actor.agentId, attempt.task_id, attempt.attempt_id, attempt.plan_version, Date.now());
    entries.forEach((entry, index) => db.prepare(`INSERT INTO video_production_manifest_entries(project_id,manifest_id,entry_order,scene_id,scene_version,shot_id,shot_version,take_id,asset_id,asset_sha256,metadata_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(projectId, manifestId, index, String(entry.sceneId), Number(entry.sceneVersion), String(entry.shotId), Number(entry.shotVersion),
      String(entry.takeId), String(entry.assetId), String(entry.sha256), JSON.stringify({ byteSize: entry.byteSize })));
    audit(db, projectId, "registry_manifest_created", actor.agentId, { manifestId, manifestVersion, digest, entryCount: entries.length });
    return { manifestId, manifestVersion, status: "READY", digest, entries };
  });
}

export async function isVideoProductionManifestCurrent(db: Db, projectId: string, manifestId: string, storageRoot: string): Promise<boolean> {
  const manifest = db.prepare("SELECT plan_version FROM video_production_manifests WHERE project_id=? AND manifest_id=?").get(projectId, manifestId) as { plan_version: number } | undefined;
  if (!manifest) return false;
  const production = db.prepare("SELECT plan_version,approved_version,state FROM video_productions WHERE project_id=?").get(projectId) as { plan_version: number; approved_version: number | null; state: string } | undefined;
  if (!production || production.state !== "APPROVED" || production.plan_version !== manifest.plan_version || production.approved_version !== manifest.plan_version) return false;
  const entries = db.prepare("SELECT scene_id,scene_version,shot_id,shot_version,take_id,asset_id,asset_sha256 FROM video_production_manifest_entries WHERE project_id=? AND manifest_id=? ORDER BY entry_order").all(projectId, manifestId) as Array<Record<string, unknown>>;
  if (!entries.length) return false;
  const requiredSnapshot = manifestCandidateSnapshot(db, projectId);
  const required = requiredSnapshot.rows;
  if (!manifestSnapshotComplete(requiredSnapshot) || required.length !== entries.length || required.some((row, index) => {
    const entry = entries[index];
    return !entry || row.scene_id !== entry.scene_id || row.scene_version !== entry.scene_version || row.shot_id !== entry.shot_id ||
      row.shot_version !== entry.shot_version || row.take_id !== entry.take_id || row.asset_id !== entry.asset_id || row.sha256 !== entry.asset_sha256;
  })) return false;
  for (const row of required) {
    if (!row.storage_key || !row.sha256 || !row.byte_size || !await verifyVideoProductionAsset(storageRoot, {
      projectId, storageKey: String(row.storage_key), sha256: String(row.sha256), byteSize: Number(row.byte_size),
    })) return false;
  }
  const latestProduction = db.prepare("SELECT plan_version,approved_version,state FROM video_productions WHERE project_id=?").get(projectId) as { plan_version: number; approved_version: number | null; state: string } | undefined;
  if (!latestProduction || latestProduction.state !== "APPROVED" || latestProduction.plan_version !== manifest.plan_version || latestProduction.approved_version !== manifest.plan_version) return false;
  const latest = manifestCandidateSnapshot(db, projectId);
  if (latest.fingerprint !== requiredSnapshot.fingerprint) return false;
  return entries.every((entry) => {
    const current = db.prepare(`SELECT s.current_version AS scene_version,sh.current_version AS shot_version,at.take_id,a.sha256
      FROM video_production_scenes s JOIN video_production_shots sh ON sh.project_id=s.project_id AND sh.scene_id=s.scene_id
      JOIN video_production_approved_takes at ON at.project_id=sh.project_id AND at.shot_id=sh.shot_id
      JOIN video_production_assets a ON a.project_id=at.project_id AND a.asset_id=at.asset_id
      WHERE s.project_id=? AND s.scene_id=? AND sh.shot_id=? AND s.deleted_at IS NULL AND sh.deleted_at IS NULL`).get(projectId, String(entry.scene_id), String(entry.shot_id)) as Record<string, unknown> | undefined;
    return Boolean(current && current.scene_version === entry.scene_version && current.shot_version === entry.shot_version && current.take_id === entry.take_id && current.sha256 === entry.asset_sha256 && !getStaleReferenceKeys(db, projectId, String(entry.shot_id), Number(entry.shot_version)).length);
  });
}

type ManifestCandidate = { scene_id: string; scene_version: number; shot_id: string; shot_version: number; take_id: string; asset_id: string; sha256: string; byte_size: number; storage_key: string };
function manifestCandidateSnapshot(db: Db, projectId: string): { planVersion: number; fingerprint: string; rows: ManifestCandidate[]; hasEmptyRequiredScene: boolean } {
  const production = db.prepare("SELECT plan_version,approved_version,state FROM video_productions WHERE project_id=?").get(projectId) as { plan_version: number; approved_version: number | null; state: string } | undefined;
  if (!production || production.state !== "APPROVED" || production.approved_version !== production.plan_version) return { planVersion: production?.plan_version ?? -1, fingerprint: "invalid-production", rows: [], hasEmptyRequiredScene: true };
  const raw = db.prepare(`SELECT s.scene_id,sv.version AS scene_version,sh.shot_id,sh.current_version AS shot_version,
      at.take_id,at.asset_id,a.sha256,a.byte_size,a.storage_key,sh.is_required AS shot_required,s.is_required AS scene_required
    FROM video_production_scenes s JOIN video_production_scene_versions sv ON sv.project_id=s.project_id AND sv.scene_id=s.scene_id AND sv.version=s.current_version
    LEFT JOIN video_production_shots sh ON sh.project_id=s.project_id AND sh.scene_id=s.scene_id AND sh.deleted_at IS NULL AND sh.is_required=1
    LEFT JOIN video_production_approved_takes at ON at.project_id=sh.project_id AND at.shot_id=sh.shot_id AND at.shot_version=sh.current_version
    LEFT JOIN video_production_assets a ON a.project_id=at.project_id AND a.asset_id=at.asset_id
    WHERE s.project_id=? AND s.deleted_at IS NULL AND (s.is_required=1 OR sh.shot_id IS NOT NULL)
    ORDER BY s.sort_order,sh.sort_order,sh.shot_id`).all(projectId) as Array<Record<string, unknown>>;
  const hasEmptyRequiredScene = raw.some((row) => row.scene_required === 1 && row.shot_id === null);
  const rows = raw.filter((row) => row.shot_id !== null).map((row) => ({
    scene_id: String(row.scene_id), scene_version: Number(row.scene_version), shot_id: String(row.shot_id), shot_version: Number(row.shot_version),
    take_id: String(row.take_id ?? ""), asset_id: String(row.asset_id ?? ""), sha256: String(row.sha256 ?? ""),
    byte_size: Number(row.byte_size ?? 0), storage_key: String(row.storage_key ?? ""),
  }));
  const fingerprint = JSON.stringify({ planVersion: production.plan_version, rows: raw.map((row) => [row.scene_id,row.scene_version,row.shot_id,row.shot_version,row.take_id,row.asset_id,row.sha256,row.byte_size,row.storage_key,row.scene_required]) });
  return { planVersion: production.plan_version, fingerprint, rows, hasEmptyRequiredScene };
}

function manifestSnapshotComplete(snapshot: ReturnType<typeof manifestCandidateSnapshot>): boolean {
  return !snapshot.hasEmptyRequiredScene && snapshot.rows.length > 0 && snapshot.rows.every((row) => row.take_id && row.asset_id && row.sha256 && row.byte_size > 0 && row.storage_key);
}

