import { createHash } from "node:crypto";
import fs, { createReadStream } from "node:fs";
import { realpath, lstat, readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { TimelinePlanOutputSchema } from "../../../shared/video-production-stage-outputs.ts";
import type { VideoProductionAgentActor } from "./video-production-rbac.ts";
import { createTrustedVideoProductionAttemptActor } from "./video-production-rbac.ts";
import { createVideoProductionManifest, previewVideoProductionManifest, registerVideoProductionFinalAsset } from "./video-production-registry.ts";
import { storeVideoProductionAsset, verifyVideoProductionAsset } from "./video-production-registry-storage.ts";
import { validateRenderedMp4 } from "./video-production-media.ts";
import { VIDEO_PRODUCTION_ASSET_ROOT } from "../../config/runtime.ts";
import { VideoProductionPolicyError } from "./video-production.ts";

type Db = Pick<DatabaseSync, "prepare" | "exec">;
type AudioPin = { artifactId: string; artifactSha256: string; assetId: string; sha256: string; byteSize: number; storageKey: string; durationMs: number; cues: Array<{ text: string; startMs: number; endMs: number }> };

function audioPin(db: Db, projectId: string, planVersion: number): AudioPin {
  const row = db.prepare(`SELECT s.artifact_id,s.content_sha256,s.content_text,s.metadata_json,a.asset_id,a.sha256,a.byte_size,a.storage_key
    FROM video_production_stage_artifacts s JOIN video_production_assets a ON a.project_id=s.project_id AND a.asset_id=json_extract(s.metadata_json,'$.audioAssetId')
    WHERE s.project_id=? AND s.artifact_type='audio_cues' AND s.attempt_plan_version=? ORDER BY s.created_at DESC LIMIT 1`).get(projectId, planVersion) as
      | { artifact_id: string; content_sha256: string; content_text: string; metadata_json: string; asset_id: string; sha256: string; byte_size: number; storage_key: string }
      | undefined;
  if (!row) throw new VideoProductionPolicyError("approved_audio_cues_required", 409);
  const decision = db.prepare("SELECT decision FROM video_production_stage_decisions WHERE project_id=? AND target_artifact_id=? ORDER BY created_at DESC,decision_id DESC LIMIT 1").get(projectId, row.artifact_id) as { decision: string } | undefined;
  if (decision?.decision !== "approved") throw new VideoProductionPolicyError("approved_audio_cues_required", 409);
  const cues = JSON.parse(row.content_text) as { durationMs?: number; cues?: Array<{ text: string; startMs: number; endMs: number }> };
  if (!Number.isInteger(cues.durationMs) || Number(cues.durationMs) <= 0 || !Array.isArray(cues.cues) || cues.cues.length > 500 || cues.cues.some((cue) => typeof cue.text !== "string" || cue.text.length > 2000 || !Number.isInteger(cue.startMs) || !Number.isInteger(cue.endMs) || cue.startMs < 0 || cue.endMs <= cue.startMs || cue.endMs > Number(cues.durationMs))) throw new VideoProductionPolicyError("audio_cues_invalid", 409);
  return { artifactId: row.artifact_id, artifactSha256: row.content_sha256, assetId: row.asset_id, sha256: row.sha256, byteSize: row.byte_size, storageKey: row.storage_key, durationMs: Number(cues.durationMs), cues: cues.cues };
}

function loadJob(db: Db, taskId: string, allowRunning: boolean) {
  const job = db.prepare(`SELECT j.project_id,j.plan_version,j.stage_key,j.execution_action,j.assigned_agent_id,j.target_artifact_id,j.state,
      p.brief_json,p.plan_version AS current_plan,p.approved_version,p.state AS production_state,t.status AS task_status,t.assigned_agent_id AS task_assignee,
      a.content_text,a.content_sha256,a.attempt_plan_version
    FROM video_production_stage_jobs j JOIN video_productions p ON p.project_id=j.project_id JOIN tasks t ON t.id=j.task_id
    JOIN video_production_stage_artifacts a ON a.project_id=j.project_id AND a.artifact_id=j.target_artifact_id
    WHERE j.task_id=?`).get(taskId) as { project_id: string; plan_version: number; stage_key: string; execution_action: string; assigned_agent_id: string; target_artifact_id: string; state: string; brief_json: string; current_plan: number; approved_version: number | null; production_state: string; task_status: string; task_assignee: string | null; content_text: string; content_sha256: string; attempt_plan_version: number } | undefined;
  const validStates = allowRunning ? ["READY", "PAUSED", "RUNNING"] : ["READY", "PAUSED"];
  const expectedTaskStatuses = job?.state === "RUNNING" ? ["in_progress"] : job?.state === "PAUSED" ? ["pending"] : ["inbox", "planned", "pending"];
  if (!job || job.stage_key !== "asset_handoff_rough_cut" || job.execution_action !== "edit.manage" || !validStates.includes(job.state) || !expectedTaskStatuses.includes(job.task_status) || job.task_assignee !== job.assigned_agent_id || job.assigned_agent_id !== "video_production-role-editor" || job.plan_version !== job.current_plan || job.approved_version !== job.current_plan || job.production_state !== "APPROVED" || job.attempt_plan_version !== job.plan_version) throw new VideoProductionPolicyError("final_render_job_stale", 409);
  const approved = db.prepare("SELECT decision FROM video_production_stage_decisions WHERE project_id=? AND target_artifact_id=? ORDER BY created_at DESC,decision_id DESC LIMIT 1").get(job.project_id, job.target_artifact_id) as { decision: string } | undefined;
  if (approved?.decision !== "approved") throw new VideoProductionPolicyError("approved_timeline_plan_required", 409);
  return job;
}

function requestSnapshot(db: Db, taskId: string, attemptId: string) {
  const job = loadJob(db, taskId, true);
  const preview = previewVideoProductionManifest(db, job.project_id);
  if (preview.planVersion !== job.plan_version) throw new VideoProductionPolicyError("final_render_manifest_plan_stale", 409);
  const plan = TimelinePlanOutputSchema.parse(JSON.parse(job.content_text));
  const entryIds = preview.entries.map((entry) => `${entry.shotId}@${entry.shotVersion}`);
  const planIds = plan.shots.map((shot) => `${shot.shotId}@${shot.shotVersion}`);
  if (planIds.length !== entryIds.length || new Set(planIds).size !== planIds.length || [...planIds].sort().join("|") !== [...entryIds].sort().join("|")) throw new VideoProductionPolicyError("final_render_timeline_manifest_mismatch", 409);
  const entryByShot = new Map(preview.entries.map((entry) => [`${entry.shotId}@${entry.shotVersion}`, entry]));
  const brief = JSON.parse(job.brief_json) as { aspectRatio?: string };
  const [ratioW, ratioH] = (brief.aspectRatio ?? "16:9").split(":").map(Number);
  const portrait = ratioW > 0 && ratioH > ratioW;
  let totalFrames = 0;
  const shots = plan.shots.map((shot, index) => {
    const entry = entryByShot.get(`${shot.shotId}@${shot.shotVersion}`)!;
    const transitionFrames = index > 0 && plan.shots[index - 1]?.transitionAfter === "crossfade" ? Math.round(plan.shots[index - 1]!.transitionDurationMs * 30 / 1000) : 0;
    const durationFrames = Math.max(1, Math.round(shot.durationMs * 30 / 1000));
    totalFrames += durationFrames - transitionFrames;
    if (transitionFrames >= durationFrames) throw new VideoProductionPolicyError("final_timeline_transition_invalid", 409);
    return { shotId: shot.shotId, shotVersion: shot.shotVersion, takeId: entry.takeId, assetId: entry.assetId, sha256: entry.sha256,
      inputName: `shot-${index}.mp4`, durationFrames, transitionFrames, subtitleText: shot.subtitleText };
  });
  for (let index = 1; index < shots.length; index++) if (shots[index]!.transitionFrames >= shots[index - 1]!.durationFrames) throw new VideoProductionPolicyError("final_timeline_transition_invalid", 409);
  const audio = audioPin(db, job.project_id, job.plan_version);
  const finalDurationMs = Math.round(totalFrames * 1000 / 30);
  if (Math.abs(audio.durationMs - finalDurationMs) > 100) throw new VideoProductionPolicyError("final_audio_timing_mismatch", 409);
  const timelineSource = { artifactId: job.target_artifact_id, sha256: job.content_sha256 };
  const request = { protocol: "claw-video-worker-v1", operation: "render-timeline", attemptId, manifestDigest: preview.digest,
    timelineArtifactId: job.target_artifact_id, fps: 30, width: portrait ? 720 : 1280, height: portrait ? 1280 : 720,
    shots, audio: { inputName: "narration.mp3", assetId: audio.assetId, sha256: audio.sha256, durationFrames: Math.round(audio.durationMs * 30 / 1000), cuesArtifactId: audio.artifactId, cuesSha256: audio.artifactSha256, cues: audio.cues } };
  const inputDigest = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  Object.assign(request, { inputDigest });
  return { request, preview, audio, timelineSource, projectId: job.project_id, planVersion: job.plan_version, expectedDurationMs: finalDurationMs };
}

export function buildLiamWorkerRequest(db: Db, taskId: string, attemptId: string) {
  return JSON.stringify(requestSnapshot(db, taskId, attemptId).request);
}

/** Called only after the exact attempt claim and before Docker spawn. */
export function stageLiamWorkerInputs(db: Db, taskId: string, attemptId: string, workspacePath: string, expectedInputDigest: string, storageRoot = VIDEO_PRODUCTION_ASSET_ROOT): string {
  const snapshot = requestSnapshot(db, taskId, attemptId);
  const { inputDigest: _ignored, ...requestWithoutDigest } = snapshot.request as typeof snapshot.request & { inputDigest?: string };
  const inputDigest = createHash("sha256").update(JSON.stringify(requestWithoutDigest)).digest("hex");
  if (inputDigest !== expectedInputDigest) throw new VideoProductionPolicyError("final_render_input_snapshot_changed", 409);
  const inputRoot = path.join(workspacePath, "input");
  fs.mkdirSync(inputRoot, { recursive: false, mode: 0o755 });
  fs.chmodSync(inputRoot, 0o755);
  const root = fs.realpathSync(storageRoot);
  const projectRoot = fs.realpathSync(path.join(root, snapshot.projectId));
  if (path.relative(root, projectRoot).startsWith("..")) throw new VideoProductionPolicyError("final_render_asset_root_invalid", 409);
  const entries = new Map(snapshot.preview.entries.map((entry) => [`${entry.shotId}@${entry.shotVersion}`, entry]));
  const assets = snapshot.request.shots.map((shot) => {
    const entry = entries.get(`${shot.shotId}@${shot.shotVersion}`);
    if (!entry || entry.takeId !== shot.takeId || entry.assetId !== shot.assetId || entry.sha256 !== shot.sha256) throw new VideoProductionPolicyError("final_render_manifest_order_changed", 409);
    return { name: shot.inputName, storageKey: `${snapshot.projectId}/${entry.sha256}`, sha256: entry.sha256, byteSize: entry.byteSize };
  });
  assets.push({ name: "narration.mp3", storageKey: snapshot.audio.storageKey, sha256: snapshot.audio.sha256, byteSize: snapshot.audio.byteSize });
  let total = 0;
  for (const asset of assets) {
    if (asset.byteSize > 256 * 1024 * 1024 || (total += asset.byteSize) > 1024 * 1024 * 1024) throw new VideoProductionPolicyError("final_render_inputs_too_large", 413);
    const source = path.resolve(root, asset.storageKey);
    const relative = path.relative(projectRoot, source);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new VideoProductionPolicyError("final_render_asset_path_invalid", 409);
    const info = fs.lstatSync(source);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.byteSize) throw new VideoProductionPolicyError("final_render_asset_invalid", 409);
    const bytes = fs.readFileSync(source);
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new VideoProductionPolicyError("final_render_asset_hash_mismatch", 409);
    const destination = path.join(inputRoot, asset.name);
    fs.writeFileSync(destination, bytes, { flag: "wx", mode: 0o644 });
    fs.chmodSync(destination, 0o644);
  }
  const persisted = db.prepare(`UPDATE video_production_attempts SET worker_input_digest=?,updated_at=? WHERE attempt_id=? AND task_id=? AND state='LAUNCHING'
    AND EXISTS(SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id=? AND attempt_id=?)`).run(inputDigest, Date.now(), attemptId, taskId, taskId, attemptId);
  if (persisted.changes !== 1) throw new VideoProductionPolicyError("production_attempt_ownership_lost", 409);
  return inputDigest;
}

async function safeWorkspaceChild(workspacePath: string, relative: string): Promise<string> {
  const root = await realpath(workspacePath);
  const absolute = path.resolve(root, relative);
  const rel = path.relative(root, absolute);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new VideoProductionPolicyError("production_worker_path_invalid", 409);
  let cursor = root;
  for (const part of rel.split(path.sep)) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new VideoProductionPolicyError("production_worker_symlink_rejected", 409);
  }
  const canonical = await realpath(absolute);
  if (path.relative(root, canonical).startsWith("..")) throw new VideoProductionPolicyError("production_worker_path_invalid", 409);
  return canonical;
}

export async function importLiamWorkerOutput(input: { db: Db; taskId: string; attemptId: string; workspacePath: string; storageRoot?: string }) {
  const snapshot = requestSnapshot(input.db, input.taskId, input.attemptId);
  const resultPath = await safeWorkspaceChild(input.workspacePath, "output/result.json");
  const resultInfo = await lstat(resultPath);
  if (!resultInfo.isFile() || resultInfo.size > 8192) throw new VideoProductionPolicyError("final_render_result_invalid", 409);
  const result = JSON.parse(await readFile(resultPath, "utf8")) as { protocol?: string; ok?: boolean; operation?: string; attemptId?: string; manifestDigest?: string; timelineArtifactId?: string; inputDigest?: string; output?: string; sourceOutput?: string; byteSize?: number; sha256?: string };
  const { inputDigest: _ignored, ...requestWithoutDigest } = snapshot.request as typeof snapshot.request & { inputDigest?: string };
  const inputDigest = createHash("sha256").update(JSON.stringify(requestWithoutDigest)).digest("hex");
  const persisted = input.db.prepare("SELECT worker_input_digest FROM video_production_attempts WHERE task_id=? AND attempt_id=? AND state IN ('RUNNING','COMPLETING','RECONCILIATION_REQUIRED')").get(input.taskId, input.attemptId) as { worker_input_digest: string | null } | undefined;
  if (result.protocol !== "claw-video-worker-v1" || result.operation !== "render-timeline" || !result.ok || result.attemptId !== input.attemptId || result.manifestDigest !== snapshot.preview.digest || result.timelineArtifactId !== snapshot.timelineSource.artifactId || result.inputDigest !== inputDigest || persisted?.worker_input_digest !== inputDigest || result.output !== "output/final.mp4" || result.sourceOutput !== `render-final-${createHash("sha256").update(`${input.attemptId}:${inputDigest}`).digest("hex").slice(0, 24)}/entry.tsx`) throw new VideoProductionPolicyError("final_render_result_mismatch", 409);
  const outputPath = await safeWorkspaceChild(input.workspacePath, "output/final.mp4");
  const media = await validateRenderedMp4(outputPath, { width: snapshot.request.width, height: snapshot.request.height, framesPerSecond: 30, minDurationSeconds: snapshot.expectedDurationMs / 1000 - 0.1, maxDurationSeconds: snapshot.expectedDurationMs / 1000 + 0.1, requireAudio: true, audioDurationToleranceSeconds: 0.1, maxBytes: 1024 * 1024 * 1024 });
  if (media.sha256 !== result.sha256 || media.byteSize !== result.byteSize) throw new VideoProductionPolicyError("final_render_media_hash_mismatch", 409);
  const sourcePath = await safeWorkspaceChild(input.workspacePath, result.sourceOutput!);
  const sourceInfo = await lstat(sourcePath);
  if (sourceInfo.size > 1_048_576) throw new VideoProductionPolicyError("final_render_source_too_large", 409);
  const sourceText = await readFile(sourcePath, "utf8");
  const storageRoot = input.storageRoot ?? VIDEO_PRODUCTION_ASSET_ROOT;
  const stored = await storeVideoProductionAsset(storageRoot, { projectId: snapshot.projectId, assetType: "footage", contentType: "video/mp4", source: createReadStream(outputPath), maxBytes: 1024 * 1024 * 1024 });
  if (stored.sha256 !== media.sha256 || stored.byteSize !== media.byteSize) throw new VideoProductionPolicyError("final_render_import_hash_mismatch", 409);
  const actor: VideoProductionAgentActor = createTrustedVideoProductionAttemptActor(input.db, input.attemptId, "edit.manage");
  const manifest = await createVideoProductionManifest(input.db, actor, snapshot.projectId, storageRoot);
  if (manifest.digest !== snapshot.preview.digest) throw new VideoProductionPolicyError("final_render_manifest_changed", 409);
  const assetId = `final-${input.attemptId.replace(/[^A-Za-z0-9_-]/g, "-")}`.slice(0, 120);
  return registerVideoProductionFinalAsset(input.db, actor, {
    projectId: snapshot.projectId, assetId, stored,
    metadata: { label: "Validated final rough cut", technicalMetadata: { width: media.width, height: media.height, frameRate: media.framesPerSecond, durationMs: Math.round(media.durationSeconds * 1000) } },
    idempotencyKey: `final-${input.attemptId.replace(/[^A-Za-z0-9_-]/g, "-")}`.slice(0, 120), sourceText,
    sourceMetadata: { finalAssetId: assetId, finalAssetSha256: stored.sha256, manifestId: manifest.manifestId, manifestDigest: manifest.digest,
      timelineArtifactId: snapshot.timelineSource.artifactId, timelineSha256: snapshot.timelineSource.sha256,
      audioCuesArtifactId: snapshot.audio.artifactId, audioCuesSha256: snapshot.audio.artifactSha256, audioAssetId: snapshot.audio.assetId,
      audioSha256: snapshot.audio.sha256, planVersion: snapshot.planVersion, technicalValidation: { ...media, decodedFully: true } },
  }, storageRoot);
}
