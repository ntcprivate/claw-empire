import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { VIDEO_PRODUCTION_ASSET_ROOT } from "../../config/runtime.ts";
import { createTrustedVideoProductionAttemptActor } from "./video-production-rbac.ts";
import { importVideoProductionRender } from "./video-production-registry.ts";
import { storeVideoProductionAsset, verifyVideoProductionAsset } from "./video-production-registry-storage.ts";
import { validateRenderedMp4 } from "./video-production-media.ts";
import { VideoProductionPolicyError } from "./video-production.ts";
import { importMiroSourceArchive } from "./video-production-source-archive.ts";

type Db = Pick<DatabaseSync, "prepare" | "exec">;

export async function buildMiroWorkerRequest(input: { db: Db; taskId: string; workspaceAttemptId: string; storageRoot?: string }): Promise<string> {
  const job = input.db.prepare(`SELECT j.project_id,j.plan_version,j.stage_key,j.execution_action,j.assigned_agent_id,j.shot_id,j.shot_version,
      p.plan_version AS current_plan,p.approved_version,p.state AS production_state,
      sh.current_version,sh.deleted_at AS shot_deleted,sv.action,sv.camera_json,sv.duration_ms,sv.scene_version,
      sc.current_version AS scene_current,sc.deleted_at AS scene_deleted,scv.description
    FROM video_production_stage_jobs j JOIN video_productions p ON p.project_id=j.project_id
    JOIN video_production_shots sh ON sh.project_id=j.project_id AND sh.shot_id=j.shot_id
    JOIN video_production_shot_versions sv ON sv.project_id=j.project_id AND sv.shot_id=j.shot_id AND sv.version=j.shot_version
    JOIN video_production_scenes sc ON sc.project_id=sv.project_id AND sc.scene_id=sv.scene_id
    JOIN video_production_scene_versions scv ON scv.project_id=sc.project_id AND scv.scene_id=sc.scene_id AND scv.version=sv.scene_version
    WHERE j.task_id=? AND j.state IN ('READY','PAUSED','RUNNING')`).get(input.taskId) as
      | { project_id: string; plan_version: number; stage_key: string; execution_action: string; assigned_agent_id: string; shot_id: string; shot_version: number; current_plan: number; approved_version: number | null; production_state: string; current_version: number; shot_deleted: number | null; action: string; camera_json: string; duration_ms: number; scene_version: number; scene_current: number; scene_deleted: number | null; description: string }
      | undefined;
  if (!job || job.stage_key !== "ai_footage_production" || job.execution_action !== "footage.submit" ||
      job.plan_version !== job.current_plan || job.approved_version !== job.current_plan || job.production_state !== "APPROVED" ||
      job.current_version !== job.shot_version || job.shot_deleted !== null || job.scene_version !== job.scene_current || job.scene_deleted !== null) {
    throw new VideoProductionPolicyError("production_stage_job_stale", 409);
  }
  const storageRoot = input.storageRoot ?? VIDEO_PRODUCTION_ASSET_ROOT;
  const reference = input.db.prepare(`SELECT a.sha256,a.byte_size,a.storage_key,a.content_type
    FROM video_production_shot_references sr
    LEFT JOIN video_production_visual_reference_versions rv ON rv.project_id=sr.project_id
      AND rv.reference_id=sr.target_reference_id AND rv.version=sr.target_reference_version
    JOIN video_production_assets a ON a.project_id=sr.project_id AND a.asset_id=COALESCE(sr.target_asset_id,rv.asset_id)
    WHERE sr.project_id=? AND sr.shot_id=? AND sr.shot_version=? AND a.content_type LIKE 'image/%'
    ORDER BY sr.reference_key LIMIT 1`).get(job.project_id, job.shot_id, job.shot_version) as
      | { sha256: string; byte_size: number; storage_key: string; content_type: string }
      | undefined;
  let referenceImage: { contentType: string; base64: string } | undefined;
  if (reference) {
    const stored = { projectId: job.project_id, sha256: reference.sha256, byteSize: reference.byte_size, storageKey: reference.storage_key };
    if (!await verifyVideoProductionAsset(storageRoot, stored)) throw new VideoProductionPolicyError("video_production_reference_asset_integrity_failed", 409);
    if (!new Set(["image/png", "image/jpeg", "image/webp"]).has(reference.content_type) || reference.byte_size > 8 * 1024 * 1024) {
      throw new VideoProductionPolicyError("video_production_reference_image_too_large_or_unsupported", 409);
    }
    const image = await readFile(path.join(storageRoot, job.project_id, reference.sha256));
    if (image.length !== reference.byte_size) throw new VideoProductionPolicyError("video_production_reference_asset_integrity_failed", 409);
    const actualHash = createHash("sha256").update(image).digest("hex");
    if (actualHash !== reference.sha256) throw new VideoProductionPolicyError("video_production_reference_asset_integrity_failed", 409);
    referenceImage = { contentType: reference.content_type, base64: image.toString("base64") };
  }
  const brief = input.db.prepare("SELECT brief_json FROM video_productions WHERE project_id=?").get(job.project_id) as { brief_json: string };
  const aspect = (JSON.parse(brief.brief_json) as { aspectRatio?: string }).aspectRatio ?? "16:9";
  const [rw, rh] = aspect.split(":").map(Number);
  const portrait = rw > 0 && rh > rw;
  const fps = 30;
  const durationFrames = Math.max(1, Math.min(fps * 120, Math.round(job.duration_ms * fps / 1000)));
  const request = {
    protocol: "claw-video-worker-v1",
    operation: "render-shot",
    attemptId: input.workspaceAttemptId,
    brief: JSON.parse(brief.brief_json),
    shot: { shotId: job.shot_id, shotVersion: job.shot_version, title: job.description.slice(0, 200), action: job.action, camera: JSON.parse(job.camera_json), durationFrames },
    width: portrait ? 720 : 1280,
    height: portrait ? 1280 : 720,
    fps,
    ...(referenceImage ? { referenceImage } : {}),
  };
  return JSON.stringify(request);
}

export async function importMiroWorkerOutput(input: {
  db: Db;
  taskId: string;
  attemptId: string;
  workspacePath: string;
  storageRoot?: string;
}): Promise<{ assetId: string; takeId: string; sha256: string }> {
  const bound = input.db.prepare(`SELECT j.project_id,j.plan_version,j.execution_action,j.assigned_agent_id,j.shot_id,j.shot_version,
      p.plan_version AS current_plan,p.approved_version,p.state AS production_state,t.assigned_agent_id AS task_assignee
    FROM video_production_stage_jobs j JOIN video_productions p ON p.project_id=j.project_id
    JOIN tasks t ON t.id=j.task_id WHERE j.task_id=? AND j.state='RUNNING'`).get(input.taskId) as
      | { project_id: string; plan_version: number; execution_action: string; assigned_agent_id: string; shot_id: string; shot_version: number; current_plan: number; approved_version: number | null; production_state: string; task_assignee: string | null }
      | undefined;
  if (!bound || bound.execution_action !== "footage.submit" || bound.plan_version !== bound.current_plan || bound.approved_version !== bound.current_plan || bound.production_state !== "APPROVED" || bound.task_assignee !== bound.assigned_agent_id) {
    throw new VideoProductionPolicyError("production_stage_job_stale", 409);
  }
  const storageRoot = input.storageRoot ?? VIDEO_PRODUCTION_ASSET_ROOT;
  const shotSnapshot = input.db.prepare(`SELECT p.brief_json,sv.duration_ms,sh.current_version,sh.deleted_at AS shot_deleted,
      sc.current_version AS scene_current,sc.deleted_at AS scene_deleted,sv.scene_version
    FROM video_production_shots sh JOIN video_production_shot_versions sv ON sv.project_id=sh.project_id AND sv.shot_id=sh.shot_id AND sv.version=?
    JOIN video_production_scenes sc ON sc.project_id=sv.project_id AND sc.scene_id=sv.scene_id
    JOIN video_productions p ON p.project_id=sh.project_id WHERE sh.project_id=? AND sh.shot_id=?`)
    .get(bound.shot_version, bound.project_id, bound.shot_id) as { brief_json: string; duration_ms: number; current_version: number; shot_deleted: number | null; scene_current: number; scene_deleted: number | null; scene_version: number } | undefined;
  if (!shotSnapshot || shotSnapshot.current_version !== bound.shot_version || shotSnapshot.shot_deleted !== null || shotSnapshot.scene_deleted !== null || shotSnapshot.scene_version !== shotSnapshot.scene_current) throw new VideoProductionPolicyError("video_production_shot_version_stale", 409);
  const brief = JSON.parse(shotSnapshot.brief_json) as { aspectRatio?: string };
  const [ratioW, ratioH] = (brief.aspectRatio ?? "16:9").split(":").map(Number);
  const portrait = ratioW > 0 && ratioH > ratioW;
  const expectedWidth = portrait ? 720 : 1280;
  const expectedHeight = portrait ? 1280 : 720;
  const durationSeconds = Math.min(120, Math.max(0.1, shotSnapshot.duration_ms / 1000));
  const canonicalWorkspace = await realpath(input.workspacePath);
  const safeChild = async (relative: string, expectedType: "file" | "directory"): Promise<string> => {
    const absolute = path.resolve(canonicalWorkspace, relative);
    const rel = path.relative(canonicalWorkspace, absolute);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new VideoProductionPolicyError("production_worker_path_invalid", 409);
    let cursor = canonicalWorkspace;
    for (const part of rel.split(path.sep)) {
      cursor = path.join(cursor, part);
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new VideoProductionPolicyError("production_worker_symlink_rejected", 409);
    }
    const canonical = await realpath(absolute);
    const canonicalRelative = path.relative(canonicalWorkspace, canonical);
    if (canonicalRelative.startsWith("..") || path.isAbsolute(canonicalRelative)) throw new VideoProductionPolicyError("production_worker_path_invalid", 409);
    const info = await lstat(canonical);
    if (expectedType === "file" ? !info.isFile() : !info.isDirectory()) throw new VideoProductionPolicyError("production_worker_path_invalid", 409);
    return canonical;
  };
  const resultPath = await safeChild("output/result.json", "file");
  const resultStat = await lstat(resultPath);
  if (!resultStat.isFile() || resultStat.isSymbolicLink() || resultStat.size > 8192) throw new VideoProductionPolicyError("production_worker_result_invalid", 409);
  const result = JSON.parse(await readFile(resultPath, "utf8")) as { protocol?: string; operation?: string; ok?: boolean; attemptId?: string; shotId?: string; shotVersion?: number; output?: string; byteSize?: number; sha256?: string; sourceOutput?: string; sourceArchiveOutput?: string; sourceArchiveSha256?: string; sourceArchiveBytes?: number };
  const renderHash = createHash("sha256").update(`${bound.shot_id}:v${bound.shot_version}`).digest("hex").slice(0, 24);
  const expectedOutput = `output/shot-${renderHash}.mp4`;
  const expectedSource = `render-${renderHash}/entry.tsx`;
  if (result.protocol !== "claw-video-worker-v1" || !result.ok || result.attemptId !== input.attemptId || result.shotId !== bound.shot_id || result.shotVersion !== bound.shot_version || result.output !== expectedOutput || result.sourceOutput !== expectedSource) {
    throw new VideoProductionPolicyError("production_worker_result_mismatch", 409);
  }
  const outputPath = await safeChild(`output/shot-${renderHash}.mp4`, "file");
  const mediaInfo = await validateRenderedMp4(outputPath, { width: expectedWidth, height: expectedHeight, framesPerSecond: 30, minDurationSeconds: Math.max(0.1, durationSeconds - 0.25), maxDurationSeconds: durationSeconds + 0.25, maxBytes: 256 * 1024 * 1024 });
  if (result.byteSize !== mediaInfo.byteSize || result.sha256 !== mediaInfo.sha256) throw new VideoProductionPolicyError("production_worker_media_hash_mismatch", 409);
  const sourcePath = await safeChild(`render-${renderHash}/entry.tsx`, "file");
  const sourceStat = await lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > 1_048_576) throw new VideoProductionPolicyError("production_worker_source_invalid", 409);
  const sourceText = await readFile(sourcePath, "utf8");
  const attempt = input.db.prepare("SELECT detail_json FROM video_production_attempts WHERE attempt_id=? AND task_id=?").get(input.attemptId, input.taskId) as { detail_json: string } | undefined;
  const authored = result.operation === "author-shot";
  const authoringMarker = attempt && JSON.parse(attempt.detail_json).miroAuthoring;
  const expectedAuthoring = authoringMarker === true || authoringMarker === 1;
  if (expectedAuthoring && !authored) throw new VideoProductionPolicyError("production_source_archive_required", 409);
  const sourceArchive = authored ? await importMiroSourceArchive({
    workspacePath: input.workspacePath, storageRoot, projectId: bound.project_id, attemptId: input.attemptId,
    shotId: bound.shot_id, shotVersion: bound.shot_version, renderHash, sourceText,
    sourceArchiveOutput: result.sourceArchiveOutput, sourceArchiveSha256: result.sourceArchiveSha256, sourceArchiveBytes: result.sourceArchiveBytes,
  }) : undefined;
  const stored = await storeVideoProductionAsset(storageRoot, { projectId: bound.project_id, assetType: "footage", contentType: "video/mp4", source: createReadStream(outputPath), maxBytes: 256 * 1024 * 1024 });
  if (stored.sha256 !== mediaInfo.sha256 || stored.byteSize !== mediaInfo.byteSize) throw new VideoProductionPolicyError("video_production_render_import_hash_mismatch", 409);
  const actor = createTrustedVideoProductionAttemptActor(input.db, input.attemptId, "footage.submit");
  const key = createHash("sha256").update(`${input.attemptId}:${bound.shot_id}:v${bound.shot_version}`).digest("hex").slice(0, 48);
  const assetId = `render-${key}`;
  return importVideoProductionRender(input.db, actor, {
    projectId: bound.project_id, assetId, idempotencyKey: `render-${key}`, shotId: bound.shot_id, shotVersion: bound.shot_version, stored,
    assetMetadata: { label: `Remotion render ${bound.shot_id} v${bound.shot_version}`, technicalMetadata: { width: mediaInfo.width, height: mediaInfo.height, frameRate: mediaInfo.framesPerSecond, durationMs: Math.round(mediaInfo.durationSeconds * 1000) } },
    takeMetadata: { model: authored ? "miro-shotcraft-author-v1" : "remotion-shot-renderer-v1", prompt: authored ? "Author and render the approved shot with the pinned offline Video Shotcraft skill." : "Render the exact approved shot specification with the server-owned motion graphics template.", generationParameters: { fps: 30, width: mediaInfo.width, height: mediaInfo.height, ...(sourceArchive ? { sourceArchiveSha256: sourceArchive.sha256, skillCommit: sourceArchive.skillCommit } : {}) }, reportedValidation: { width: mediaInfo.width, height: mediaInfo.height, frameRate: mediaInfo.framesPerSecond, durationMs: Math.round(mediaInfo.durationSeconds * 1000) } },
    sourceText, sourceMetadata: { assetId, sha256: stored.sha256, ...(sourceArchive ? { sourceArchive } : {}) },
  }, storageRoot);
}

