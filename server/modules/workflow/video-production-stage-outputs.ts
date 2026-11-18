import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AudioScriptOutputSchema, ContinuityPackageOutputSchema, CreativeReviewOutputSchema, FinalQaOutputSchema, HaruScreenplayOutputSchema, ShotSpecOutputSchema, TimelinePlanOutputSchema, type HaruScreenplayOutput } from "../../../shared/video-production-stage-outputs.ts";
import { createTrustedVideoProductionAttemptActor } from "./video-production-rbac.ts";
import { createVideoProductionScene, createVideoProductionShot, isVideoProductionManifestCurrent, registerVideoProductionAsset, requestVideoProductionRegeneration, reviewVideoProductionTake, updateVideoProductionScene, updateVideoProductionShot } from "./video-production-registry.ts";
import { storeVideoProductionAsset, verifyVideoProductionAsset } from "./video-production-registry-storage.ts";
import { recordTrustedVideoProductionStageArtifact } from "./video-production-stage-artifacts.ts";
import { VideoProductionPolicyError } from "./video-production.ts";
import { getVideoProductionAgentProvider, requestVideoProductionJson } from "./video-production-provider-broker.ts";
import { VIDEO_STUDIO_STAGE_OWNERSHIP } from "../../../shared/video-studio-organization.ts";
import { assertVieNeuRuntimeReady, generateVieNeuSpeech, type VieNeuTtsInput, type VieNeuTtsOutput } from "./packs/vieneu-tts.ts";
import { VIDEO_PRODUCTION_ASSET_ROOT } from "../../config/runtime.ts";
import { sampleVideoFrames, validateRenderedMp4 } from "./video-production-media.ts";

function claimSingleProviderCall(db: Db, input: { taskId: string; attemptId: string; action: string }): void {
  const result = db.prepare(`UPDATE video_production_attempts SET detail_json=json_set(detail_json,'$.providerCallStarted',?),updated_at=?
    WHERE task_id=? AND attempt_id=? AND state='RUNNING' AND execution_action=? AND json_valid(detail_json)
      AND json_type(detail_json,'$.providerCallStarted') IS NULL
      AND EXISTS (SELECT 1 FROM video_production_slot s JOIN tasks t ON t.id=s.task_id
        JOIN video_production_stage_jobs j ON j.task_id=t.id AND j.project_id=t.project_id
        JOIN video_production_stages st ON st.project_id=t.project_id AND st.task_id=t.id
        JOIN video_productions p ON p.project_id=t.project_id
        WHERE s.singleton=1 AND s.task_id=? AND s.attempt_id=? AND t.id=? AND t.status='in_progress'
          AND j.state='RUNNING' AND j.execution_action=? AND st.status='RUNNING' AND p.state='APPROVED'
          AND p.plan_version=p.approved_version AND p.plan_version=video_production_attempts.plan_version)`)
    .run(input.action, Date.now(), input.taskId, input.attemptId, input.action, input.taskId, input.attemptId, input.taskId, input.action);
  if (result.changes !== 1) throw new VideoProductionPolicyError("video_provider_call_already_claimed_or_attempt_stale", 409);
}

type Db = Pick<DatabaseSync, "prepare" | "exec">;
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function persistScreenplay(db: Db, attemptId: string, output: HaruScreenplayOutput): { artifactId: string; sceneIds: string[]; sha256: string } {
  const normalized = HaruScreenplayOutputSchema.parse(output);
  const content = JSON.stringify(normalized);
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  const existing = db.prepare("SELECT artifact_id,content_sha256,content_text FROM video_production_stage_artifacts WHERE attempt_id=? AND artifact_type='screenplay'").get(attemptId) as { artifact_id: string; content_sha256: string; content_text: string } | undefined;
  if (existing) {
    if (existing.content_sha256 !== sha256 || existing.content_text !== content) throw new VideoProductionPolicyError("video_production_screenplay_retry_conflict", 409);
    return { artifactId: existing.artifact_id, sceneIds: normalized.scenes.map((scene) => scene.sceneId), sha256 };
  }
  const savepoint = `vp_haru_${randomUUID().replaceAll("-", "")}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const actor = createTrustedVideoProductionAttemptActor(db, attemptId, "screenplay.write");
    const requestedIds = new Set(normalized.scenes.map((scene) => scene.sceneId));
    const priorScenes = db.prepare("SELECT scene_id FROM video_production_scenes WHERE project_id=? AND deleted_at IS NULL").all(actor.projectId) as Array<{ scene_id: string }>;
    if (priorScenes.some((scene) => !requestedIds.has(scene.scene_id))) throw new VideoProductionPolicyError("video_production_screenplay_revision_must_preserve_scene_set", 409);
    for (const scene of normalized.scenes) {
      const prior = db.prepare("SELECT current_version,deleted_at FROM video_production_scenes WHERE project_id=? AND scene_id=?").get(actor.projectId, scene.sceneId) as { current_version: number; deleted_at: number | null } | undefined;
      if (prior) {
        if (prior.deleted_at !== null) throw new VideoProductionPolicyError("video_production_screenplay_scene_deleted", 409);
        updateVideoProductionScene(db, actor, actor.projectId, scene.sceneId, prior.current_version, { content: scene.content });
      } else createVideoProductionScene(db, actor, actor.projectId, scene);
    }
    const artifact = recordTrustedVideoProductionStageArtifact(db, {
      attemptId, action: "screenplay.write", artifactType: "screenplay", stageKey: "story_development",
      content, metadata: { title: normalized.title, logline: normalized.logline, sceneIds: normalized.scenes.map((scene) => scene.sceneId) },
    });
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return { artifactId: artifact.artifactId, sceneIds: normalized.scenes.map((scene) => scene.sceneId), sha256 };
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}

/** Rian's model-assisted decision is bound to the exact immutable screenplay digest. */
export async function runRianCreativeReviewJob(input: { db: Db; taskId: string; attemptId: string; fetchImpl?: FetchLike; signal?: AbortSignal; storageRoot?: string }): Promise<{ decisionId: string; artifactId: string; decision: "approved" | "changes_requested"; feedback: string }> {
  const job = input.db.prepare(`SELECT j.project_id,j.plan_version,j.stage_key,j.execution_action,j.assigned_agent_id,j.target_artifact_id,j.state,
      p.brief_json,p.plan_version AS current_plan,p.approved_version,p.state AS production_state,t.status AS task_status,t.assigned_agent_id AS task_assignee,
      a.artifact_type,a.stage_key AS artifact_stage,a.content_text,a.content_sha256,a.attempt_plan_version
    FROM video_production_stage_jobs j JOIN video_productions p ON p.project_id=j.project_id JOIN tasks t ON t.id=j.task_id
    JOIN video_production_stage_artifacts a ON a.project_id=j.project_id AND a.artifact_id=j.target_artifact_id
    WHERE j.task_id=?`).get(input.taskId) as
      | { project_id: string; plan_version: number; stage_key: string; execution_action: string; assigned_agent_id: string; target_artifact_id: string; state: string; brief_json: string; current_plan: number; approved_version: number | null; production_state: string; task_status: string; task_assignee: string | null; artifact_type: string; artifact_stage: string; content_text: string; content_sha256: string; attempt_plan_version: number }
      | undefined;
  const sourceActionByType: Record<string, string> = { screenplay: "screenplay.write", shot_spec: "shot_spec.write", continuity_package: "visual.manage", timeline_plan: "edit.manage", audio_cues: "audio.manage", timeline_source: "edit.manage", final_cut: "edit.manage" };
  const ownership = job ? VIDEO_STUDIO_STAGE_OWNERSHIP.find((entry) => entry.stageKey === job.stage_key) : undefined;
  const previousAgentStep = ownership?.sequence.slice(0, -1).filter((step) => step.kind === "agent").at(-1);
  if (!job || job.execution_action !== "creative.approve" || job.state !== "RUNNING" ||
      job.task_status !== "in_progress" || job.task_assignee !== job.assigned_agent_id || job.assigned_agent_id !== "video_production-role-director" ||
      job.target_artifact_id === "" || (job.artifact_type === "final_cut" ? job.artifact_stage !== "asset_handoff_rough_cut" : job.artifact_stage !== job.stage_key) || job.execution_action !== "creative.approve" ||
      (job.artifact_type !== "final_cut" && sourceActionByType[job.artifact_type] !== previousAgentStep?.action) || !ownership?.sequence.some((step) => step.kind === "agent" && step.roleKey === "director" && step.action === "creative.approve") ||
      job.plan_version !== job.current_plan || job.approved_version !== job.current_plan || job.attempt_plan_version !== job.plan_version || job.production_state !== "APPROVED") {
    throw new VideoProductionPolicyError("creative_review_target_not_ready", 409);
  }
  const existing = input.db.prepare("SELECT decision_id,decision,feedback FROM video_production_stage_decisions WHERE task_id=? AND attempt_id=?").get(input.taskId, input.attemptId) as { decision_id: string; decision: "approved" | "changes_requested"; feedback: string } | undefined;
  if (existing) return { decisionId: existing.decision_id, artifactId: job.target_artifact_id, decision: existing.decision, feedback: existing.feedback };
  const actor = createTrustedVideoProductionAttemptActor(input.db, input.attemptId, "creative.approve");
  if (actor.projectId !== job.project_id || actor.agentId !== job.assigned_agent_id || actor.taskId !== input.taskId || actor.planVersion !== job.plan_version) throw new VideoProductionPolicyError("production_attempt_snapshot_mismatch", 409);
  const { provider, model } = getVideoProductionAgentProvider(input.db, job.assigned_agent_id);
  const storageRoot = input.storageRoot ?? VIDEO_PRODUCTION_ASSET_ROOT;
  let images: Array<{ mimeType: "image/jpeg"; data: string }> | undefined;
  let finalCutPin: { finalAssetId: string; finalAssetSha256: string; manifestId: string; manifestDigest: string; technicalValidation?: { durationSeconds?: number } } | undefined;
  if (job.artifact_type === "final_cut") {
    try { finalCutPin = JSON.parse(job.content_text) as typeof finalCutPin; } catch { throw new VideoProductionPolicyError("final_cut_pin_invalid", 409); }
    const asset = finalCutPin?.finalAssetId && finalCutPin.finalAssetSha256 ? input.db.prepare(`SELECT asset_id,sha256,storage_key,byte_size,content_type
      FROM video_production_assets WHERE project_id=? AND asset_id=? AND shot_id IS NULL`).get(job.project_id, finalCutPin.finalAssetId) as
        | { asset_id: string; sha256: string; storage_key: string; byte_size: number; content_type: string } | undefined : undefined;
    if (!finalCutPin || !asset || asset.sha256 !== finalCutPin.finalAssetSha256 || asset.content_type !== "video/mp4" ||
        !finalCutPin.manifestId || !finalCutPin.manifestDigest || !await isVideoProductionManifestCurrent(input.db, job.project_id, finalCutPin.manifestId, storageRoot)) {
      throw new VideoProductionPolicyError("final_cut_review_snapshot_stale", 409);
    }
    const manifest = input.db.prepare("SELECT digest_sha256 FROM video_production_manifests WHERE project_id=? AND manifest_id=?").get(job.project_id, finalCutPin.manifestId) as { digest_sha256: string } | undefined;
    if (manifest?.digest_sha256 !== finalCutPin.manifestDigest) throw new VideoProductionPolicyError("final_cut_review_snapshot_stale", 409);
    const stored = { projectId: job.project_id, storageKey: asset.storage_key, sha256: asset.sha256, byteSize: asset.byte_size };
    if (!await verifyVideoProductionAsset(storageRoot, stored)) throw new VideoProductionPolicyError("final_cut_review_asset_invalid", 409);
    const durationSeconds = Number(finalCutPin.technicalValidation?.durationSeconds);
    images = await sampleVideoFrames(path.join(storageRoot, job.project_id, asset.sha256), durationSeconds);
  }
  const prompt = [
    job.artifact_type === "final_cut"
      ? "Review three sampled actual frames from the exact final rough-cut MP4. Decide whether the picture is coherent and fits the approved brief; provide actionable frame-level feedback. This decision is not CEO release approval."
      : `Review the submitted ${job.artifact_type} for creative coherence, continuity, and fit to the approved brief.`,
    "Return JSON only with decision ('approved' or 'changes_requested') and actionable feedback. Do not claim CEO approval or modify the source artifact.",
    `Approved brief JSON:\n${job.brief_json.slice(0, 8_000)}`,
    `Artifact SHA-256: ${job.content_sha256}`,
    `Submitted ${job.artifact_type} JSON:\n${job.content_text.slice(0, 32_000)}`,
    ...(finalCutPin ? [`Final asset ${finalCutPin.finalAssetId} SHA-256 ${finalCutPin.finalAssetSha256}; manifest ${finalCutPin.manifestId} digest ${finalCutPin.manifestDigest}.`] : []),
  ].join("\n\n");
  claimSingleProviderCall(input.db, { taskId: input.taskId, attemptId: input.attemptId, action: "creative.approve" });
  const candidate = await requestVideoProductionJson({ provider, model, prompt, images, fetchImpl: input.fetchImpl, signal: input.signal });
  if (input.signal?.aborted) throw new VideoProductionPolicyError("video_provider_cancelled", 409);
  const output = CreativeReviewOutputSchema.parse(candidate);
  const currentActor = createTrustedVideoProductionAttemptActor(input.db, input.attemptId, "creative.approve");
  const currentArtifact = input.db.prepare("SELECT content_sha256 FROM video_production_stage_artifacts WHERE project_id=? AND artifact_id=?").get(job.project_id, job.target_artifact_id) as { content_sha256: string } | undefined;
  if (input.signal?.aborted || currentActor.projectId !== actor.projectId || currentActor.agentId !== actor.agentId || currentActor.taskId !== actor.taskId || currentActor.planVersion !== actor.planVersion || currentArtifact?.content_sha256 !== job.content_sha256) {
    throw new VideoProductionPolicyError("production_attempt_snapshot_mismatch", 409);
  }
  if (finalCutPin) {
    const currentAsset = input.db.prepare("SELECT sha256 FROM video_production_assets WHERE project_id=? AND asset_id=?").get(job.project_id, finalCutPin.finalAssetId) as { sha256: string } | undefined;
    if (currentAsset?.sha256 !== finalCutPin.finalAssetSha256 || !await verifyVideoProductionAsset(storageRoot, { projectId: job.project_id, storageKey: `${job.project_id}/${finalCutPin.finalAssetSha256}`, sha256: finalCutPin.finalAssetSha256, byteSize: Number((input.db.prepare("SELECT byte_size FROM video_production_assets WHERE project_id=? AND asset_id=?").get(job.project_id, finalCutPin.finalAssetId) as { byte_size: number } | undefined)?.byte_size ?? 0) }) ||
        !await isVideoProductionManifestCurrent(input.db, job.project_id, finalCutPin.manifestId, storageRoot)) throw new VideoProductionPolicyError("final_cut_review_snapshot_stale", 409);
  }
  const decisionId = randomUUID();
  input.db.prepare(`INSERT INTO video_production_stage_decisions(project_id,decision_id,stage_key,target_artifact_id,target_sha256,decision,feedback,reviewer_agent_id,task_id,attempt_id,attempt_plan_version,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(job.project_id, decisionId, job.stage_key, job.target_artifact_id, job.content_sha256, output.decision, output.feedback, actor.agentId, input.taskId, input.attemptId, actor.planVersion, Date.now());
  return { decisionId, artifactId: job.target_artifact_id, decision: output.decision, feedback: output.feedback };
}

/** Yuna reviews the newest exact imported take for the shot bound to this task. */
export async function runYunaTakeReviewJob(input: { db: Db; taskId: string; attemptId: string; fetchImpl?: FetchLike; signal?: AbortSignal; storageRoot?: string }): Promise<{ takeId: string; decision: "approved" | "rejected"; feedback: string }> {
  const job = input.db.prepare(`SELECT j.project_id,j.plan_version,j.stage_key,j.execution_action,j.assigned_agent_id,j.shot_id,j.shot_version,j.state,
      j.target_take_id,j.target_asset_id,j.target_asset_sha256,
      p.brief_json,p.plan_version AS current_plan,p.approved_version,p.state AS production_state,t.status AS task_status,t.assigned_agent_id AS task_assignee,
      x.take_id,x.asset_id,x.content_fingerprint,x.attempt_metadata_json,a.sha256,a.byte_size,a.content_type,a.metadata_json,a.storage_key
    FROM video_production_stage_jobs j JOIN video_productions p ON p.project_id=j.project_id JOIN tasks t ON t.id=j.task_id
    JOIN video_production_takes x ON x.project_id=j.project_id AND x.take_id=j.target_take_id AND x.shot_id=j.shot_id AND x.shot_version=j.shot_version AND x.asset_id=j.target_asset_id
    JOIN video_production_assets a ON a.project_id=x.project_id AND a.asset_id=x.asset_id AND a.sha256=j.target_asset_sha256
    WHERE j.task_id=?`).get(input.taskId) as { project_id: string; plan_version: number; stage_key: string; execution_action: string; assigned_agent_id: string; shot_id: string; shot_version: number; state: string; target_take_id: string | null; target_asset_id: string | null; target_asset_sha256: string | null; brief_json: string; current_plan: number; approved_version: number | null; production_state: string; task_status: string; task_assignee: string | null; take_id: string; asset_id: string; content_fingerprint: string; attempt_metadata_json: string; sha256: string; byte_size: number; content_type: string; metadata_json: string; storage_key: string } | undefined;
  if (!job || !job.target_take_id || !job.target_asset_id || !job.target_asset_sha256 || job.stage_key !== "ai_footage_production" || job.execution_action !== "take.review" || job.state !== "RUNNING" || job.task_status !== "in_progress" || job.task_assignee !== job.assigned_agent_id || job.assigned_agent_id !== "video_production-role-art-director" || job.plan_version !== job.current_plan || job.approved_version !== job.current_plan || job.production_state !== "APPROVED" || job.take_id !== job.target_take_id || job.asset_id !== job.target_asset_id || job.sha256 !== job.target_asset_sha256 || job.content_type !== "video/mp4") throw new VideoProductionPolicyError("take_review_job_stale", 409);
  const actor = createTrustedVideoProductionAttemptActor(input.db, input.attemptId, "take.review");
  if (actor.projectId !== job.project_id || actor.agentId !== job.assigned_agent_id || actor.taskId !== input.taskId || actor.planVersion !== job.plan_version) throw new VideoProductionPolicyError("production_attempt_snapshot_mismatch", 409);
  const { provider, model } = getVideoProductionAgentProvider(input.db, job.assigned_agent_id);
  let metadata: Record<string, unknown>;
  try { metadata = JSON.parse(job.attempt_metadata_json) as Record<string, unknown>; } catch { throw new VideoProductionPolicyError("take_review_metadata_invalid", 409); }
  const storageRoot = input.storageRoot ?? VIDEO_PRODUCTION_ASSET_ROOT;
  const stored = { projectId: job.project_id, sha256: job.sha256, byteSize: job.byte_size, storageKey: job.storage_key };
  if (!await verifyVideoProductionAsset(storageRoot, stored)) throw new VideoProductionPolicyError("take_review_asset_integrity_failed", 409);
  const durationSeconds = Number((metadata.reportedValidation as { durationMs?: number } | undefined)?.durationMs) / 1000;
  const frames = await sampleVideoFrames(path.join(storageRoot, job.project_id, job.sha256), durationSeconds);
  claimSingleProviderCall(input.db, { taskId: input.taskId, attemptId: input.attemptId, action: "take.review" });
  const candidate = await requestVideoProductionJson({ provider, model, signal: input.signal, fetchImpl: input.fetchImpl, prompt: [
    "Review the three sampled real frames from this rendered take for visual continuity, shot intent, and obvious defects. Return JSON with decision ('approved' or 'changes_requested') and specific feedback.",
    "The images are sampled at 15%, 50%, and 85% of the exact registered video. Do not claim full-motion or technical validation beyond the supplied metadata. Do not claim CEO release approval.",
    `Approved brief: ${job.brief_json.slice(0, 6000)}`,
    `Shot ${job.shot_id} version ${job.shot_version}; take ${job.take_id}; asset SHA-256 ${job.sha256}; bytes ${job.byte_size}; MIME ${job.content_type}; durationMs ${Math.round(durationSeconds * 1000)}.`,
    `Take metadata: ${job.metadata_json.slice(0, 6000)}`,
    `Attempt metadata: ${JSON.stringify(metadata).slice(0, 6000)}`,
  ].join("\n\n"), images: frames });
  if (input.signal?.aborted) throw new VideoProductionPolicyError("video_provider_cancelled", 409);
  const output = CreativeReviewOutputSchema.parse(candidate);
  const refreshed = createTrustedVideoProductionAttemptActor(input.db, input.attemptId, "take.review");
  if (input.signal?.aborted || refreshed.projectId !== actor.projectId || refreshed.agentId !== actor.agentId || refreshed.taskId !== actor.taskId || refreshed.planVersion !== actor.planVersion) throw new VideoProductionPolicyError("production_attempt_snapshot_mismatch", 409);
  if (!await verifyVideoProductionAsset(storageRoot, stored)) throw new VideoProductionPolicyError("take_review_asset_integrity_failed", 409);
  const decision = output.decision === "approved" ? "approved" : "rejected";
  const exact = input.db.prepare("SELECT sha256 FROM video_production_assets WHERE project_id=? AND asset_id=?").get(job.project_id, job.asset_id) as { sha256: string } | undefined;
  if (input.signal?.aborted || exact?.sha256 !== job.target_asset_sha256) throw new VideoProductionPolicyError("production_attempt_snapshot_mismatch", 409);
  await reviewVideoProductionTake(input.db, actor, job.project_id, job.take_id, { expectedShotVersion: job.shot_version, expectedAssetId: job.asset_id, decision, feedback: output.feedback }, storageRoot);
  return { takeId: job.take_id, decision, feedback: output.feedback };
}

/** Quinn independently checks the exact Rian-approved final MP4, decodes it, samples frames and records hash-bound QA evidence. */
export async function runQuinnFinalQaJob(input: { db: Db; taskId: string; attemptId: string; fetchImpl?: FetchLike; signal?: AbortSignal; storageRoot?: string }): Promise<{ artifactId: string; decision: "approved" | "changes_requested"; feedback: string }> {
  const job = input.db.prepare(`SELECT j.project_id,j.plan_version,j.stage_key,j.execution_action,j.assigned_agent_id,j.target_artifact_id,j.state,
      p.plan_version AS current_plan,p.approved_version,p.state AS production_state,t.status AS task_status,t.assigned_agent_id AS task_assignee,
      a.content_text AS finalcut_content,a.content_sha256 AS finalcut_sha256
    FROM video_production_stage_jobs j JOIN video_productions p ON p.project_id=j.project_id JOIN tasks t ON t.id=j.task_id
    JOIN video_production_stage_artifacts a ON a.project_id=j.project_id AND a.artifact_id=j.target_artifact_id AND a.artifact_type='final_cut'
    WHERE j.task_id=?`).get(input.taskId) as { project_id: string; plan_version: number; stage_key: string; execution_action: string; assigned_agent_id: string; target_artifact_id: string; state: string; current_plan: number; approved_version: number | null; production_state: string; task_status: string; task_assignee: string | null; finalcut_content: string; finalcut_sha256: string } | undefined;
  if (!job || job.stage_key !== "finishing_qa" || job.execution_action !== "qa.final" || job.state !== "RUNNING" || job.assigned_agent_id !== "video_production-role-qa-supervisor" || job.task_status !== "in_progress" || job.task_assignee !== job.assigned_agent_id || job.plan_version !== job.current_plan || job.approved_version !== job.current_plan || job.production_state !== "APPROVED") throw new VideoProductionPolicyError("final_qa_job_stale", 409);
  const actor = createTrustedVideoProductionAttemptActor(input.db, input.attemptId, "qa.final");
  if (actor.projectId !== job.project_id || actor.agentId !== job.assigned_agent_id || actor.taskId !== input.taskId || actor.planVersion !== job.plan_version) throw new VideoProductionPolicyError("production_attempt_snapshot_mismatch", 409);
  let pin: Record<string, unknown>;
  try { pin = JSON.parse(job.finalcut_content) as Record<string, unknown>; } catch { throw new VideoProductionPolicyError("final_cut_pin_invalid", 409); }
  const decision = input.db.prepare("SELECT decision FROM video_production_stage_decisions WHERE project_id=? AND target_artifact_id=? ORDER BY created_at DESC,decision_id DESC LIMIT 1").get(job.project_id, job.target_artifact_id) as { decision: string } | undefined;
  const manifestId = String(pin.manifestId ?? "");
  const manifest = input.db.prepare("SELECT digest_sha256,plan_version FROM video_production_manifests WHERE project_id=? AND manifest_id=?").get(job.project_id, manifestId) as { digest_sha256: string; plan_version: number } | undefined;
  const asset = input.db.prepare("SELECT asset_id,sha256,storage_key,byte_size,content_type,metadata_json FROM video_production_assets WHERE project_id=? AND asset_id=? AND shot_id IS NULL").get(job.project_id, String(pin.finalAssetId ?? "")) as { asset_id: string; sha256: string; storage_key: string; byte_size: number; content_type: string; metadata_json: string } | undefined;
  const storageRoot = input.storageRoot ?? VIDEO_PRODUCTION_ASSET_ROOT;
  if (decision?.decision !== "approved" || !manifest || manifest.digest_sha256 !== pin.manifestDigest || manifest.plan_version !== job.plan_version ||
      !asset || asset.sha256 !== pin.finalAssetSha256 || asset.content_type !== "video/mp4" || !await isVideoProductionManifestCurrent(input.db, job.project_id, manifestId, storageRoot)) throw new VideoProductionPolicyError("final_qa_snapshot_stale", 409);
  const stored = { projectId: job.project_id, storageKey: asset.storage_key, sha256: asset.sha256, byteSize: asset.byte_size };
  if (!await verifyVideoProductionAsset(storageRoot, stored)) throw new VideoProductionPolicyError("final_qa_asset_integrity_failed", 409);
  let assetMetadata: Record<string, unknown>;
  try { assetMetadata = JSON.parse(asset.metadata_json) as Record<string, unknown>; } catch { throw new VideoProductionPolicyError("final_qa_asset_metadata_invalid", 409); }
  const expectedDurationSeconds = Number((assetMetadata.technicalMetadata as { durationMs?: number } | undefined)?.durationMs) / 1000;
  if (!Number.isFinite(expectedDurationSeconds) || expectedDurationSeconds <= 0) throw new VideoProductionPolicyError("final_qa_expected_duration_invalid", 409);
  const technical = await validateRenderedMp4(path.join(storageRoot, job.project_id, asset.sha256), {
    width: Number((assetMetadata.technicalMetadata as { width?: number } | undefined)?.width),
    height: Number((assetMetadata.technicalMetadata as { height?: number } | undefined)?.height),
    framesPerSecond: Number((assetMetadata.technicalMetadata as { frameRate?: number } | undefined)?.frameRate),
    minDurationSeconds: expectedDurationSeconds - 0.1, maxDurationSeconds: expectedDurationSeconds + 0.1,
    requireAudio: true, audioDurationToleranceSeconds: 0.1, maxBytes: 1024 * 1024 * 1024,
  });
  if (technical.sha256 !== asset.sha256) throw new VideoProductionPolicyError("final_qa_asset_integrity_failed", 409);
  const frames = await sampleVideoFrames(path.join(storageRoot, job.project_id, asset.sha256), technical.durationSeconds);
  const { provider, model } = getVideoProductionAgentProvider(input.db, job.assigned_agent_id);
  claimSingleProviderCall(input.db, { taskId: input.taskId, attemptId: input.attemptId, action: "qa.final" });
  const candidate = await requestVideoProductionJson({ provider, model, prompt: [
    "Perform independent final content QA on the actual sampled frames and full technical decode evidence. Check obvious visual defects, continuity, subtitles, and fit to the approved brief. Return JSON only: decision ('approved' or 'changes_requested'), actionable feedback, and issues[]. Each issue must have scope ('shot','audio','subtitle','continuity','technical','other'), concise detail, optional shotId, optional timeMs. A changes_requested decision must contain at least one targeted issue. This is not CEO release approval.",
    `Approved brief: ${((input.db.prepare("SELECT brief_json FROM video_productions WHERE project_id=?").get(job.project_id) as { brief_json: string } | undefined)?.brief_json ?? "{}").slice(0, 6000)}`,
    `Exact final asset ${asset.asset_id}, SHA-256 ${asset.sha256}, ${asset.byte_size} bytes; final-cut artifact ${job.target_artifact_id} SHA-256 ${job.finalcut_sha256}.`,
    `Approved manifest ${manifestId}, digest ${manifest.digest_sha256}; technical evidence: ${JSON.stringify(technical)}.`,
  ].join("\n\n"), images: frames, fetchImpl: input.fetchImpl, signal: input.signal });
  if (input.signal?.aborted) throw new VideoProductionPolicyError("video_provider_cancelled", 409);
  const output = FinalQaOutputSchema.parse(candidate);
  const refreshed = createTrustedVideoProductionAttemptActor(input.db, input.attemptId, "qa.final");
  if (refreshed.projectId !== actor.projectId || refreshed.agentId !== actor.agentId || refreshed.taskId !== actor.taskId || refreshed.planVersion !== actor.planVersion ||
      !await verifyVideoProductionAsset(storageRoot, stored) || !await isVideoProductionManifestCurrent(input.db, job.project_id, manifestId, storageRoot)) throw new VideoProductionPolicyError("final_qa_snapshot_stale", 409);
  const shotIds = new Set((input.db.prepare("SELECT shot_id FROM video_production_manifest_entries WHERE project_id=? AND manifest_id=?").all(job.project_id, manifestId) as Array<{ shot_id: string }>).map((row) => row.shot_id));
  if (output.issues.some((issue) => issue.shotId && !shotIds.has(issue.shotId))) throw new VideoProductionPolicyError("final_qa_issue_shot_outside_manifest", 409);
  const pins = { ...pin, finalCutArtifactId: job.target_artifact_id, finalCutSha256: job.finalcut_sha256, decision: output.decision, feedback: output.feedback, issues: output.issues,
    technicalValidation: { ...technical, fullDecode: true }, sampledFrameCount: frames.length, reviewerAgentId: actor.agentId, taskId: input.taskId, attemptId: input.attemptId };
  const savepoint = `vp_qa_${createHash("sha256").update(input.attemptId).digest("hex").slice(0, 16)}`;
  input.db.exec(`SAVEPOINT ${savepoint}`);
  let evidenceArtifactId: string | undefined;
  try {
    const refreshedInCommit = createTrustedVideoProductionAttemptActor(input.db, input.attemptId, "qa.final");
    const exactFinal = input.db.prepare("SELECT content_sha256 FROM video_production_stage_artifacts WHERE project_id=? AND artifact_id=? AND artifact_type='final_cut'").get(job.project_id, job.target_artifact_id) as { content_sha256: string } | undefined;
    const exactAsset = input.db.prepare("SELECT sha256 FROM video_production_assets WHERE project_id=? AND asset_id=?").get(job.project_id, asset.asset_id) as { sha256: string } | undefined;
    const exactManifest = input.db.prepare("SELECT digest_sha256 FROM video_production_manifests WHERE project_id=? AND manifest_id=?").get(job.project_id, manifestId) as { digest_sha256: string } | undefined;
    if (refreshedInCommit.taskId !== actor.taskId || refreshedInCommit.planVersion !== actor.planVersion || exactFinal?.content_sha256 !== job.finalcut_sha256 || exactAsset?.sha256 !== asset.sha256 || exactManifest?.digest_sha256 !== pin.manifestDigest) throw new VideoProductionPolicyError("final_qa_snapshot_stale", 409);
    const evidence = recordTrustedVideoProductionStageArtifact(input.db, { attemptId: input.attemptId, action: "qa.final", artifactType: "qa_evidence", stageKey: "finishing_qa", content: JSON.stringify(pins), metadata: pins });
    evidenceArtifactId = evidence.artifactId;
    const decisionId = randomUUID();
    input.db.prepare(`INSERT INTO video_production_stage_decisions(project_id,decision_id,stage_key,target_artifact_id,target_sha256,decision,feedback,reviewer_agent_id,task_id,attempt_id,attempt_plan_version,created_at)
      VALUES(?,?,'finishing_qa',?,?,?,?,?,?,?,?,?)`).run(job.project_id, decisionId, evidence.artifactId, evidence.sha256, output.decision, output.feedback, actor.agentId, input.taskId, input.attemptId, actor.planVersion, Date.now());
    input.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
  } catch (error) {
    input.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    input.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
  if (!evidenceArtifactId) throw new VideoProductionPolicyError("final_qa_evidence_commit_failed", 500);
  return { artifactId: evidenceArtifactId, decision: output.decision, feedback: output.feedback };
}

/** Dami records a target-only regeneration intent from Yuna's exact rejection; this is deterministic and makes no provider call. */
export function runDamiRegenerationRequestJob(input: { db: Db; taskId: string; attemptId: string }) {
  const job = input.db.prepare(`SELECT j.project_id,j.plan_version,j.stage_key,j.execution_action,j.assigned_agent_id,j.idempotency_key,j.shot_id,j.shot_version,j.target_take_id,j.state,
      p.plan_version AS current_plan,p.approved_version,p.state AS production_state,t.status AS task_status,t.assigned_agent_id AS task_assignee,
      r.feedback,r.decision
    FROM video_production_stage_jobs j JOIN video_productions p ON p.project_id=j.project_id JOIN tasks t ON t.id=j.task_id
    JOIN video_production_take_reviews r ON r.project_id=j.project_id AND r.take_id=j.target_take_id
    WHERE j.task_id=? ORDER BY r.review_number DESC LIMIT 1`).get(input.taskId) as { project_id: string; plan_version: number; stage_key: string; execution_action: string; assigned_agent_id: string; idempotency_key: string; shot_id: string; shot_version: number; target_take_id: string; state: string; current_plan: number; approved_version: number | null; production_state: string; task_status: string; task_assignee: string | null; feedback: string; decision: string } | undefined;
  if (!job || job.state !== "RUNNING" || job.stage_key !== "ai_footage_production" || job.execution_action !== "regeneration.request" || job.assigned_agent_id !== "video_production-seed-5" || job.task_assignee !== job.assigned_agent_id || job.task_status !== "in_progress" || job.plan_version !== job.current_plan || job.approved_version !== job.current_plan || job.production_state !== "APPROVED" || job.decision !== "rejected") throw new VideoProductionPolicyError("regeneration_job_stale", 409);
  const actor = createTrustedVideoProductionAttemptActor(input.db, input.attemptId, "regeneration.request");
  if (actor.projectId !== job.project_id || actor.agentId !== job.assigned_agent_id || actor.taskId !== input.taskId || actor.planVersion !== job.plan_version) throw new VideoProductionPolicyError("production_attempt_snapshot_mismatch", 409);
  const result = requestVideoProductionRegeneration(input.db, actor, job.project_id, job.shot_id, {
    expectedShotVersion: job.shot_version, rejectedTakeId: job.target_take_id, idempotencyKey: job.idempotency_key, reason: job.feedback,
  });
  return { ...result, shotId: job.shot_id, shotVersion: job.shot_version, rejectedTakeId: job.target_take_id };
}

/** Haru's approved-plan-only typed output path. Provider invocation is host-side;
 * its credential and URL are never passed into the isolated Remotion worker. */
export async function runHaruScreenplayJob(input: { db: Db; taskId: string; attemptId: string; fetchImpl?: FetchLike; signal?: AbortSignal }): Promise<{ artifactId: string; sceneIds: string[]; sha256: string }> {
  const job = input.db.prepare(`SELECT j.project_id,j.plan_version,j.stage_key,j.execution_action,j.assigned_agent_id,j.target_artifact_id,
      p.brief_json,p.plan_version AS current_plan,p.approved_version,p.state AS production_state,t.status AS task_status,
      t.assigned_agent_id AS task_assignee
    FROM video_production_stage_jobs j JOIN video_productions p ON p.project_id=j.project_id
    JOIN tasks t ON t.id=j.task_id WHERE j.task_id=? AND j.state='RUNNING'`).get(input.taskId) as
      | { project_id: string; plan_version: number; stage_key: string; execution_action: string; assigned_agent_id: string; target_artifact_id: string | null; brief_json: string; current_plan: number; approved_version: number | null; production_state: string; task_status: string; task_assignee: string | null }
      | undefined;
  if (!job || job.stage_key !== "story_development" || job.execution_action !== "screenplay.write" || job.task_status !== "in_progress" ||
      job.task_assignee !== job.assigned_agent_id || job.plan_version !== job.current_plan || job.approved_version !== job.current_plan || job.production_state !== "APPROVED") {
    throw new VideoProductionPolicyError("production_stage_job_stale", 409);
  }
  const existing = input.db.prepare("SELECT artifact_id,content_sha256,content_text FROM video_production_stage_artifacts WHERE task_id=? AND attempt_id=? AND artifact_type='screenplay'").get(input.taskId, input.attemptId) as { artifact_id: string; content_sha256: string; content_text: string } | undefined;
  if (existing) {
    const output = HaruScreenplayOutputSchema.parse(JSON.parse(existing.content_text));
    return { artifactId: existing.artifact_id, sceneIds: output.scenes.map((scene) => scene.sceneId), sha256: existing.content_sha256 };
  }
  const actor = createTrustedVideoProductionAttemptActor(input.db, input.attemptId, "screenplay.write");
  if (actor.projectId !== job.project_id || actor.agentId !== job.assigned_agent_id || actor.taskId !== input.taskId || actor.planVersion !== job.plan_version) {
    throw new VideoProductionPolicyError("production_attempt_snapshot_mismatch", 409);
  }
  const { provider, model } = getVideoProductionAgentProvider(input.db, job.assigned_agent_id);
  const revision = job.target_artifact_id ? input.db.prepare(`SELECT a.content_text,d.feedback FROM video_production_stage_artifacts a
    JOIN video_production_stage_decisions d ON d.project_id=a.project_id AND d.target_artifact_id=a.artifact_id
    WHERE a.project_id=? AND a.artifact_id=? AND d.decision='changes_requested' ORDER BY d.created_at DESC LIMIT 1`).get(job.project_id, job.target_artifact_id) as { content_text: string; feedback: string } | undefined : undefined;
  if (job.target_artifact_id && !revision) throw new VideoProductionPolicyError("screenplay_revision_feedback_missing", 409);
  const prompt = [
    "Create a concise, production-ready screenplay and scene breakdown for the approved video brief.",
    "Return JSON only with keys: title, logline, screenplay, scenes.",
    "Each scene must have sceneId and content {description, location, characters, continuity}.",
    "For a revision, keep the same sceneId set and preserve continuity unless the feedback explicitly requires changes.",
    "Do not return shot specifications, code, URLs, tools, file paths, or claims of approval.",
    `Approved brief JSON:\n${job.brief_json.slice(0, 8_000)}`,
    ...(revision ? [`Prior screenplay:\n${revision.content_text.slice(0, 32_000)}`, `Rian's requested changes:\n${revision.feedback.slice(0, 4_000)}`] : []),
  ].join("\n\n");
  claimSingleProviderCall(input.db, { taskId: input.taskId, attemptId: input.attemptId, action: "screenplay.write" });
  const candidate = await requestVideoProductionJson({ provider, model, prompt, fetchImpl: input.fetchImpl, signal: input.signal });
  if (input.signal?.aborted) throw new VideoProductionPolicyError("video_provider_cancelled", 409);
  const output = HaruScreenplayOutputSchema.parse(candidate);
  const currentActor = createTrustedVideoProductionAttemptActor(input.db, input.attemptId, "screenplay.write");
  if (input.signal?.aborted || currentActor.projectId !== actor.projectId || currentActor.agentId !== actor.agentId ||
      currentActor.taskId !== actor.taskId || currentActor.planVersion !== actor.planVersion || currentActor.roleKey !== actor.roleKey) {
    throw new VideoProductionPolicyError("production_attempt_snapshot_mismatch", 409);
  }
  return persistScreenplay(input.db, input.attemptId, output);
}

export async function runHaruShotSpecJob(input: { db: Db; taskId: string; attemptId: string; fetchImpl?: FetchLike; signal?: AbortSignal }): Promise<{ artifactId: string; shotIds: string[]; sha256: string }> {
  const job = input.db.prepare(`SELECT j.project_id,j.plan_version,j.stage_key,j.execution_action,j.assigned_agent_id,j.target_artifact_id,j.state,
      p.brief_json,p.plan_version AS current_plan,p.approved_version,p.state AS production_state,t.status AS task_status,t.assigned_agent_id AS task_assignee,
      a.content_text,a.content_sha256
    FROM video_production_stage_jobs j JOIN video_productions p ON p.project_id=j.project_id JOIN tasks t ON t.id=j.task_id
    JOIN video_production_stage_artifacts a ON a.project_id=j.project_id AND a.artifact_id=j.target_artifact_id
    WHERE j.task_id=?`).get(input.taskId) as
      | { project_id: string; plan_version: number; stage_key: string; execution_action: string; assigned_agent_id: string; target_artifact_id: string; state: string; brief_json: string; current_plan: number; approved_version: number | null; production_state: string; task_status: string; task_assignee: string | null; content_text: string; content_sha256: string }
      | undefined;
  if (!job || job.stage_key !== "visual_preproduction" || job.execution_action !== "shot_spec.write" || job.state !== "RUNNING" || job.task_status !== "in_progress" ||
      job.task_assignee !== job.assigned_agent_id || job.assigned_agent_id !== "video_production-role-screenwriter" || job.plan_version !== job.current_plan || job.approved_version !== job.current_plan || job.production_state !== "APPROVED") throw new VideoProductionPolicyError("shot_spec_job_stale", 409);
  const screenplay = HaruScreenplayOutputSchema.parse(JSON.parse(job.content_text));
  const priorOutput = input.db.prepare("SELECT artifact_id,content_sha256,content_text FROM video_production_stage_artifacts WHERE task_id=? AND attempt_id=? AND artifact_type='shot_spec'").get(input.taskId, input.attemptId) as { artifact_id: string; content_sha256: string; content_text: string } | undefined;
  if (priorOutput) {
    const output = ShotSpecOutputSchema.parse(JSON.parse(priorOutput.content_text));
    return { artifactId: priorOutput.artifact_id, shotIds: output.scenes.flatMap((scene) => scene.shots.map((shot) => shot.shotId)), sha256: priorOutput.content_sha256 };
  }
  const actor = createTrustedVideoProductionAttemptActor(input.db, input.attemptId, "shot_spec.write");
  const { provider, model } = getVideoProductionAgentProvider(input.db, job.assigned_agent_id);
  const prompt = [
    "Create a concise storyboard shot list for every screenplay scene.",
    "Return JSON only: {scenes:[{sceneId,shots:[{shotId,action,camera,durationMs,required}]}]}.",
    "Use only the supplied scene IDs; each scene needs at least one shot. Do not generate images, URLs, code, or claim approval.",
    `Approved brief:\n${job.brief_json.slice(0, 8_000)}`,
    `Screenplay digest: ${job.content_sha256}`,
    `Screenplay JSON:\n${job.content_text.slice(0, 40_000)}`,
  ].join("\n\n");
  claimSingleProviderCall(input.db, { taskId: input.taskId, attemptId: input.attemptId, action: "shot_spec.write" });
  const candidate = await requestVideoProductionJson({ provider, model, prompt, fetchImpl: input.fetchImpl, signal: input.signal });
  if (input.signal?.aborted) throw new VideoProductionPolicyError("video_provider_cancelled", 409);
  const output = ShotSpecOutputSchema.parse(candidate);
  const sourceIds = screenplay.scenes.map((scene) => scene.sceneId).sort();
  const outputIds = output.scenes.map((scene) => scene.sceneId).sort();
  if (JSON.stringify(sourceIds) !== JSON.stringify(outputIds)) throw new VideoProductionPolicyError("shot_spec_scene_set_mismatch", 422);
  const currentActor = createTrustedVideoProductionAttemptActor(input.db, input.attemptId, "shot_spec.write");
  if (input.signal?.aborted || currentActor.projectId !== actor.projectId || currentActor.agentId !== actor.agentId || currentActor.taskId !== actor.taskId || currentActor.planVersion !== actor.planVersion) throw new VideoProductionPolicyError("production_attempt_snapshot_mismatch", 409);
  const content = JSON.stringify(output);
  const savepoint = `vp_shots_${randomUUID().replaceAll("-", "")}`;
  input.db.exec(`SAVEPOINT ${savepoint}`);
  try {
    for (const scene of output.scenes) {
      for (const [index, shot] of scene.shots.entries()) {
        const payload = { action: shot.action, camera: shot.camera, durationMs: shot.durationMs, required: shot.required };
        const prior = input.db.prepare("SELECT current_version,scene_id,deleted_at FROM video_production_shots WHERE project_id=? AND shot_id=?").get(job.project_id, shot.shotId) as { current_version: number; scene_id: string; deleted_at: number | null } | undefined;
        if (prior) {
          if (prior.scene_id !== scene.sceneId || prior.deleted_at !== null) throw new VideoProductionPolicyError("shot_spec_existing_identity_conflict", 409);
          updateVideoProductionShot(input.db, currentActor, job.project_id, shot.shotId, prior.current_version, payload);
        } else createVideoProductionShot(input.db, currentActor, job.project_id, scene.sceneId, { shotId: shot.shotId, content: payload, sortOrder: index });
      }
    }
    const artifact = recordTrustedVideoProductionStageArtifact(input.db, {
      attemptId: input.attemptId, action: "shot_spec.write", artifactType: "shot_spec", stageKey: "visual_preproduction",
      content, metadata: { sourceArtifactId: job.target_artifact_id, sourceSha256: job.content_sha256, shotIds: output.scenes.flatMap((scene) => scene.shots.map((shot) => shot.shotId)) },
    });
    input.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return { artifactId: artifact.artifactId, shotIds: output.scenes.flatMap((scene) => scene.shots.map((shot) => shot.shotId)), sha256: artifact.sha256 };
  } catch (error) {
    input.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    input.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}

export async function runYunaContinuityJob(input: { db: Db; taskId: string; attemptId: string; fetchImpl?: FetchLike; signal?: AbortSignal }): Promise<{ artifactId: string; sha256: string }> {
  const job = input.db.prepare(`SELECT j.project_id,j.plan_version,j.stage_key,j.execution_action,j.assigned_agent_id,j.target_artifact_id,j.state,
      p.brief_json,p.plan_version AS current_plan,p.approved_version,p.state AS production_state,t.status AS task_status,t.assigned_agent_id AS task_assignee,
      a.content_text,a.content_sha256
    FROM video_production_stage_jobs j JOIN video_productions p ON p.project_id=j.project_id JOIN tasks t ON t.id=j.task_id
    JOIN video_production_stage_artifacts a ON a.project_id=j.project_id AND a.artifact_id=j.target_artifact_id WHERE j.task_id=?`).get(input.taskId) as
      | { project_id: string; plan_version: number; stage_key: string; execution_action: string; assigned_agent_id: string; target_artifact_id: string; state: string; brief_json: string; current_plan: number; approved_version: number | null; production_state: string; task_status: string; task_assignee: string | null; content_text: string; content_sha256: string }
      | undefined;
  if (!job || job.stage_key !== "visual_preproduction" || job.execution_action !== "visual.manage" || job.state !== "RUNNING" || job.task_status !== "in_progress" ||
      job.task_assignee !== job.assigned_agent_id || job.assigned_agent_id !== "video_production-role-art-director" || job.plan_version !== job.current_plan || job.approved_version !== job.current_plan || job.production_state !== "APPROVED") throw new VideoProductionPolicyError("continuity_job_stale", 409);
  const shotSpec = ShotSpecOutputSchema.parse(JSON.parse(job.content_text));
  const existing = input.db.prepare("SELECT artifact_id,content_sha256 FROM video_production_stage_artifacts WHERE task_id=? AND attempt_id=? AND artifact_type='continuity_package'").get(input.taskId, input.attemptId) as { artifact_id: string; content_sha256: string } | undefined;
  if (existing) return { artifactId: existing.artifact_id, sha256: existing.content_sha256 };
  const actor = createTrustedVideoProductionAttemptActor(input.db, input.attemptId, "visual.manage");
  const { provider, model } = getVideoProductionAgentProvider(input.db, job.assigned_agent_id);
  const prompt = ["Analyze shot specifications for visual continuity and reference needs.", "Return JSON only matching {notes:[{scope,subject,description,sceneIds}],referenceRequests:[{referenceType,subject,brief}]}.", "Do not claim reference images exist or approve footage. These are textual requirements only.", `Approved brief:\n${job.brief_json.slice(0, 8_000)}`, `Shot spec digest: ${job.content_sha256}`, `Shot specification JSON:\n${job.content_text.slice(0, 40_000)}`].join("\n\n");
  claimSingleProviderCall(input.db, { taskId: input.taskId, attemptId: input.attemptId, action: "visual.manage" });
  const candidate = await requestVideoProductionJson({ provider, model, prompt, fetchImpl: input.fetchImpl, signal: input.signal });
  if (input.signal?.aborted) throw new VideoProductionPolicyError("video_provider_cancelled", 409);
  const output = ContinuityPackageOutputSchema.parse(candidate);
  const sceneIds = new Set(shotSpec.scenes.map((scene) => scene.sceneId));
  if (output.notes.some((note) => note.sceneIds.some((sceneId) => !sceneIds.has(sceneId)))) throw new VideoProductionPolicyError("continuity_scene_set_mismatch", 422);
  const currentActor = createTrustedVideoProductionAttemptActor(input.db, input.attemptId, "visual.manage");
  if (input.signal?.aborted || currentActor.projectId !== actor.projectId || currentActor.agentId !== actor.agentId || currentActor.taskId !== actor.taskId || currentActor.planVersion !== actor.planVersion) throw new VideoProductionPolicyError("production_attempt_snapshot_mismatch", 409);
  const artifact = recordTrustedVideoProductionStageArtifact(input.db, { attemptId: input.attemptId, action: "visual.manage", artifactType: "continuity_package", stageKey: "visual_preproduction", content: JSON.stringify(output), metadata: { sourceArtifactId: job.target_artifact_id, sourceSha256: job.content_sha256 } });
  return { artifactId: artifact.artifactId, sha256: artifact.sha256 };
}

export async function runLiamTimelinePlanJob(input: { db: Db; taskId: string; attemptId: string; fetchImpl?: FetchLike; signal?: AbortSignal }): Promise<{ artifactId: string; sha256: string }> {
  const job = input.db.prepare(`SELECT j.project_id,j.plan_version,j.stage_key,j.execution_action,j.assigned_agent_id,j.target_artifact_id,j.state,
      p.brief_json,p.plan_version AS current_plan,p.approved_version,p.state AS production_state,t.status AS task_status,t.assigned_agent_id AS task_assignee,
      a.content_text,a.content_sha256
    FROM video_production_stage_jobs j JOIN video_productions p ON p.project_id=j.project_id JOIN tasks t ON t.id=j.task_id
    JOIN video_production_stage_artifacts a ON a.project_id=j.project_id AND a.artifact_id=j.target_artifact_id WHERE j.task_id=?`).get(input.taskId) as
      | { project_id: string; plan_version: number; stage_key: string; execution_action: string; assigned_agent_id: string; target_artifact_id: string; state: string; brief_json: string; current_plan: number; approved_version: number | null; production_state: string; task_status: string; task_assignee: string | null; content_text: string; content_sha256: string }
      | undefined;
  if (!job || job.stage_key !== "visual_preproduction" || job.execution_action !== "edit.manage" || job.state !== "RUNNING" || job.task_status !== "in_progress" ||
      job.task_assignee !== job.assigned_agent_id || job.assigned_agent_id !== "video_production-role-editor" || job.plan_version !== job.current_plan || job.approved_version !== job.current_plan || job.production_state !== "APPROVED") throw new VideoProductionPolicyError("timeline_plan_job_stale", 409);
  const continuity = ContinuityPackageOutputSchema.parse(JSON.parse(job.content_text));
  const existing = input.db.prepare("SELECT artifact_id,content_sha256 FROM video_production_stage_artifacts WHERE task_id=? AND attempt_id=? AND artifact_type='timeline_plan'").get(input.taskId, input.attemptId) as { artifact_id: string; content_sha256: string } | undefined;
  if (existing) return { artifactId: existing.artifact_id, sha256: existing.content_sha256 };
  const currentShots = input.db.prepare(`SELECT s.shot_id,s.current_version,v.duration_ms,v.action FROM video_production_shots s
    JOIN video_production_shot_versions v ON v.project_id=s.project_id AND v.shot_id=s.shot_id AND v.version=s.current_version
    WHERE s.project_id=? AND s.deleted_at IS NULL AND s.is_required=1 ORDER BY s.sort_order`).all(job.project_id) as Array<{ shot_id: string; current_version: number; duration_ms: number; action: string }>;
  if (!currentShots.length) throw new VideoProductionPolicyError("timeline_plan_shots_required", 409);
  const actor = createTrustedVideoProductionAttemptActor(input.db, input.attemptId, "edit.manage");
  const { provider, model } = getVideoProductionAgentProvider(input.db, job.assigned_agent_id);
  const prompt = ["Create an ordered previsualization timeline from the supplied required shots.", "Return JSON only: {shots:[{shotId,shotVersion,durationMs,transitionAfter,transitionDurationMs,subtitleText}]}.", "Include every shot exactly once, use the supplied duration and exact version, and do not claim rendered footage or create assets.", `Approved brief:\n${job.brief_json.slice(0, 8_000)}`, `Continuity package:\n${JSON.stringify(continuity).slice(0, 12_000)}`, `Required shots:\n${JSON.stringify(currentShots).slice(0, 16_000)}`].join("\n\n");
  claimSingleProviderCall(input.db, { taskId: input.taskId, attemptId: input.attemptId, action: "edit.manage" });
  const candidate = await requestVideoProductionJson({ provider, model, prompt, fetchImpl: input.fetchImpl, signal: input.signal });
  if (input.signal?.aborted) throw new VideoProductionPolicyError("video_provider_cancelled", 409);
  const output = TimelinePlanOutputSchema.parse(candidate);
  const expected = currentShots.map((shot) => `${shot.shot_id}@${shot.current_version}`).sort();
  const received = output.shots.map((shot) => `${shot.shotId}@${shot.shotVersion}`).sort();
  const durationByIdentity = new Map(currentShots.map((shot) => [`${shot.shot_id}@${shot.current_version}`, shot.duration_ms]));
  if (new Set(received).size !== received.length || JSON.stringify(expected) !== JSON.stringify(received) || output.shots.some((shot) => shot.durationMs !== durationByIdentity.get(`${shot.shotId}@${shot.shotVersion}`) || (shot.transitionAfter === "cut" && shot.transitionDurationMs !== 0))) throw new VideoProductionPolicyError("timeline_plan_shot_set_mismatch", 422);
  const currentActor = createTrustedVideoProductionAttemptActor(input.db, input.attemptId, "edit.manage");
  const freshShots = input.db.prepare(`SELECT s.shot_id,s.current_version FROM video_production_shots s WHERE s.project_id=? AND s.deleted_at IS NULL AND s.is_required=1 ORDER BY s.sort_order`).all(job.project_id) as Array<{ shot_id: string; current_version: number }>;
  if (input.signal?.aborted || currentActor.projectId !== actor.projectId || currentActor.taskId !== actor.taskId || currentActor.planVersion !== actor.planVersion || JSON.stringify(freshShots.map((shot) => `${shot.shot_id}@${shot.current_version}`).sort()) !== JSON.stringify(expected)) throw new VideoProductionPolicyError("production_attempt_snapshot_mismatch", 409);
  const artifact = recordTrustedVideoProductionStageArtifact(input.db, { attemptId: input.attemptId, action: "edit.manage", artifactType: "timeline_plan", stageKey: "visual_preproduction", content: JSON.stringify(output), metadata: { sourceArtifactId: job.target_artifact_id, sourceSha256: job.content_sha256, containsRenderedMedia: false } });
  return { artifactId: artifact.artifactId, sha256: artifact.sha256 };
}

type VieNeuSynthesizer = (input: VieNeuTtsInput) => Promise<VieNeuTtsOutput>;

export async function runAudioCueJob(input: {
  db: Db;
  taskId: string;
  attemptId: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  assetRoot?: string;
  synthesize?: VieNeuSynthesizer;
}): Promise<{ assetId: string; sha256: string; artifactId: string; durationMs: number }> {
  const job = input.db.prepare(`SELECT j.project_id,j.plan_version,j.stage_key,j.execution_action,j.assigned_agent_id,j.target_artifact_id,j.state,
      p.brief_json,p.plan_version AS current_plan,p.approved_version,p.state AS production_state,t.status AS task_status,t.assigned_agent_id AS task_assignee,
      a.content_text,a.content_sha256
    FROM video_production_stage_jobs j JOIN video_productions p ON p.project_id=j.project_id JOIN tasks t ON t.id=j.task_id
    JOIN video_production_stage_artifacts a ON a.project_id=j.project_id AND a.artifact_id=j.target_artifact_id WHERE j.task_id=?`).get(input.taskId) as
      | { project_id: string; plan_version: number; stage_key: string; execution_action: string; assigned_agent_id: string; target_artifact_id: string; state: string; brief_json: string; current_plan: number; approved_version: number | null; production_state: string; task_status: string; task_assignee: string | null; content_text: string; content_sha256: string }
      | undefined;
  if (!job || job.stage_key !== "audio_preproduction" || job.execution_action !== "audio.manage" || job.state !== "RUNNING" || job.task_status !== "in_progress" ||
      job.task_assignee !== job.assigned_agent_id || job.assigned_agent_id !== "video_production-role-sound-producer" || job.plan_version !== job.current_plan || job.approved_version !== job.current_plan || job.production_state !== "APPROVED") throw new VideoProductionPolicyError("audio_cue_job_stale", 409);
  const existing = input.db.prepare("SELECT a.asset_id,a.sha256,a.byte_size,a.metadata_json,s.artifact_id,s.content_sha256 FROM video_production_assets a JOIN video_production_stage_artifacts s ON s.project_id=a.project_id AND s.attempt_id=a.attempt_id AND s.artifact_type='audio_cues' WHERE a.project_id=? AND a.attempt_id=? AND a.asset_type='audio' LIMIT 1").get(job.project_id, input.attemptId) as { asset_id: string; sha256: string; byte_size: number; metadata_json: string; artifact_id: string; content_sha256: string } | undefined;
  if (existing) return { assetId: existing.asset_id, sha256: existing.sha256, artifactId: existing.artifact_id, durationMs: Number((JSON.parse(existing.metadata_json) as { technicalMetadata?: { durationMs?: number } }).technicalMetadata?.durationMs ?? 0) };
  const screenplay = HaruScreenplayOutputSchema.parse(JSON.parse(job.content_text));
  const actor = createTrustedVideoProductionAttemptActor(input.db, input.attemptId, "audio.manage");
  const { provider, model } = getVideoProductionAgentProvider(input.db, job.assigned_agent_id);
  if (!input.synthesize) assertVieNeuRuntimeReady();
  const prompt = ["Prepare a concise narration script for the approved screenplay for offline VieNeu-TTS synthesis.", "Return JSON only {narration,voice,speed}; voice must be one of Minh Quân or Mỹ Duyên; speed from 0.7 to 1.2.", "Use Vietnamese only if the screenplay requires it; do not add music or claim audio was synthesized.", `Approved brief:\n${job.brief_json.slice(0, 8_000)}`, `Screenplay digest: ${job.content_sha256}`, `Screenplay:\n${screenplay.screenplay.slice(0, 32_000)}`].join("\n\n");
  claimSingleProviderCall(input.db, { taskId: input.taskId, attemptId: input.attemptId, action: "audio.manage" });
  const candidate = await requestVideoProductionJson({ provider, model, prompt, fetchImpl: input.fetchImpl, signal: input.signal });
  if (input.signal?.aborted) throw new VideoProductionPolicyError("video_provider_cancelled", 409);
  const script = AudioScriptOutputSchema.parse(candidate);
  const currentActor = createTrustedVideoProductionAttemptActor(input.db, input.attemptId, "audio.manage");
  if (input.signal?.aborted || currentActor.projectId !== actor.projectId || currentActor.agentId !== actor.agentId || currentActor.taskId !== actor.taskId || currentActor.planVersion !== actor.planVersion) throw new VideoProductionPolicyError("production_attempt_snapshot_mismatch", 409);

  const staging = await mkdtemp(path.join(os.tmpdir(), "claw-vp-audio-"));
  try {
    const outputFile = path.join(staging, "narration.mp3");
    const synthesized = await (input.synthesize ?? generateVieNeuSpeech)({ projectRoot: staging, outputPath: "narration.mp3", text: script.narration, voice: script.voice, speed: script.speed, signal: input.signal });
    if (input.signal?.aborted || synthesized.outputPath !== "narration.mp3" || !Number.isFinite(synthesized.durationSeconds) || synthesized.durationSeconds <= 0) throw new VideoProductionPolicyError("vieneu_audio_output_invalid", 422);
    const cueContent = JSON.stringify({ narration: script.narration, voice: synthesized.voice, durationMs: Math.round(synthesized.durationSeconds * 1000), cues: synthesized.cues.map((cue) => ({ text: cue.text, startMs: Math.round(cue.startSeconds * 1000), endMs: Math.round(cue.endSeconds * 1000) })) });
    const assetId = `audio-${input.attemptId.replace(/[^A-Za-z0-9_-]/g, "-")}`.slice(0, 120);
    const storageRoot = input.assetRoot ?? VIDEO_PRODUCTION_ASSET_ROOT;
    const stored = await storeVideoProductionAsset(storageRoot, { projectId: job.project_id, assetType: "audio", contentType: "audio/mpeg", source: createReadStream(outputFile), maxBytes: 64 * 1024 * 1024 });
    if (input.signal?.aborted) throw new VideoProductionPolicyError("video_provider_cancelled", 409);
    const asset = await registerVideoProductionAsset(input.db, actor, {
      projectId: job.project_id, assetId, assetType: "audio", stored,
      metadata: { label: "VieNeu narration", technicalMetadata: { durationMs: Math.round(synthesized.durationSeconds * 1000) } },
      idempotencyKey: `audio-${input.attemptId.replace(/[^A-Za-z0-9_-]/g, "-")}`.slice(0, 120),
      stageArtifact: { content: cueContent, metadata: { screenplayArtifactId: job.target_artifact_id, screenplaySha256: job.content_sha256, audioAssetId: assetId, audioSha256: stored.sha256, durationMs: Math.round(synthesized.durationSeconds * 1000), engine: "vieneu-tts" } },
    }, storageRoot);
    const artifact = input.db.prepare("SELECT artifact_id FROM video_production_stage_artifacts WHERE project_id=? AND task_id=? AND attempt_id=? AND artifact_type='audio_cues'").get(job.project_id, input.taskId, input.attemptId) as { artifact_id: string } | undefined;
    if (!artifact) throw new VideoProductionPolicyError("audio_cues_artifact_missing", 500);
    return { assetId: String((asset as { assetId?: string }).assetId ?? assetId), sha256: stored.sha256, artifactId: artifact.artifact_id, durationMs: Math.round(synthesized.durationSeconds * 1000) };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
