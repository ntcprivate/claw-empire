import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isVideoProductionManifestCurrent, previewVideoProductionManifest } from "./video-production-registry.ts";
import { verifyVideoProductionAsset } from "./video-production-registry-storage.ts";
import { VideoProductionPolicyError } from "./video-production.ts";

type Db = Pick<DatabaseSync, "prepare" | "exec">;
type ReleaseSnapshot = {
  projectId: string; planVersion: number; finalAssetId: string; finalAssetSha256: string; finalAssetBytes: number;
  audioAssetStorageKey: string; audioAssetBytes: number; finalCutSha256: string;
  manifestId: string; manifestDigest: string; timelineArtifactId: string; timelineSha256: string;
  timelineSourceArtifactId: string; timelineSourceSha256: string;
  audioArtifactId: string; audioCuesSha256: string; audioAssetId: string; audioSha256: string;
  directorArtifactId: string; directorDecisionId: string; qaArtifactId: string; qaArtifactSha256: string; qaDecisionId: string;
};

function loadSnapshot(db: Db, projectId: string): ReleaseSnapshot {
  const production = db.prepare("SELECT plan_version,approved_version,state FROM video_productions WHERE project_id=?").get(projectId) as { plan_version: number; approved_version: number | null; state: string } | undefined;
  if (!production || production.state !== "APPROVED" || production.approved_version !== production.plan_version) throw new VideoProductionPolicyError("production_approval_required", 409);
  const cut = db.prepare(`SELECT a.artifact_id,a.content_text,a.content_sha256,a.attempt_plan_version
    FROM video_production_stage_artifacts a JOIN video_production_stage_jobs j ON j.task_id=a.task_id
    WHERE a.project_id=? AND a.artifact_type='final_cut' AND a.stage_key='asset_handoff_rough_cut' AND a.attempt_plan_version=?
      AND j.stage_key='asset_handoff_rough_cut' AND j.state='COMPLETED'
    ORDER BY a.created_at DESC,a.artifact_id DESC LIMIT 1`).get(projectId, production.plan_version) as { artifact_id: string; content_text: string; content_sha256: string; attempt_plan_version: number } | undefined;
  const director = cut ? db.prepare("SELECT decision_id,decision FROM video_production_stage_decisions WHERE project_id=? AND target_artifact_id=? AND stage_key='director_review' ORDER BY created_at DESC,decision_id DESC LIMIT 1").get(projectId, cut.artifact_id) as { decision_id: string; decision: string } | undefined : undefined;
  if (!cut || cut.attempt_plan_version !== production.plan_version || director?.decision !== "approved") throw new VideoProductionPolicyError("director_approved_final_cut_required", 409);
  let cutPins: Record<string, unknown>;
  try { cutPins = JSON.parse(cut.content_text) as Record<string, unknown>; } catch { throw new VideoProductionPolicyError("final_cut_pin_invalid", 409); }
  const qaEvidence = db.prepare(`SELECT a.artifact_id,a.content_sha256,a.content_text
    FROM video_production_stage_artifacts a JOIN video_production_stage_jobs j ON j.task_id=a.task_id
    WHERE a.project_id=? AND a.artifact_type='qa_evidence' AND a.stage_key='finishing_qa' AND a.attempt_plan_version=?
      AND json_extract(a.content_text,'$.finalCutArtifactId')=? AND j.state='COMPLETED'
    ORDER BY a.created_at DESC,a.artifact_id DESC LIMIT 1`).get(projectId, production.plan_version, cut.artifact_id) as { artifact_id: string; content_sha256: string; content_text: string } | undefined;
  const qa = qaEvidence ? db.prepare("SELECT decision_id,decision FROM video_production_stage_decisions WHERE project_id=? AND target_artifact_id=? AND stage_key='finishing_qa' ORDER BY created_at DESC,decision_id DESC LIMIT 1").get(projectId, qaEvidence.artifact_id) as { decision_id: string; decision: string } | undefined : undefined;
  if (!qaEvidence || !qa || qa.decision !== "approved") throw new VideoProductionPolicyError("approved_final_qa_required", 409);
  let qaPins: Record<string, unknown>;
  try { qaPins = JSON.parse(qaEvidence.content_text) as Record<string, unknown>; } catch { throw new VideoProductionPolicyError("final_qa_evidence_invalid", 409); }
  const finalAssetId = String(cutPins.finalAssetId ?? "");
  const finalAssetSha256 = String(cutPins.finalAssetSha256 ?? "");
  const manifestId = String(cutPins.manifestId ?? "");
  const manifestDigest = String(cutPins.manifestDigest ?? "");
  const timelineArtifactId = String(cutPins.timelineArtifactId ?? "");
  const timelineSha256 = String(cutPins.timelineSha256 ?? "");
  const timelineSourceArtifactId = String(cutPins.timelineSourceArtifactId ?? "");
  const timelineSourceSha256 = String(cutPins.timelineSourceSha256 ?? "");
  const audioArtifactId = String(cutPins.audioCuesArtifactId ?? "");
  const audioCuesSha256 = String(cutPins.audioCuesSha256 ?? "");
  const audioAssetId = String(cutPins.audioAssetId ?? "");
  const audioSha256 = String(cutPins.audioSha256 ?? "");
  const manifest = db.prepare("SELECT digest_sha256,plan_version FROM video_production_manifests WHERE project_id=? AND manifest_id=?").get(projectId, manifestId) as { digest_sha256: string; plan_version: number } | undefined;
  const timeline = db.prepare("SELECT content_sha256,artifact_type,attempt_plan_version FROM video_production_stage_artifacts WHERE project_id=? AND artifact_id=?").get(projectId, timelineArtifactId) as { content_sha256: string; artifact_type: string; attempt_plan_version: number } | undefined;
  const timelineSource = db.prepare("SELECT content_sha256,artifact_type,attempt_plan_version,metadata_json FROM video_production_stage_artifacts WHERE project_id=? AND artifact_id=?").get(projectId, timelineSourceArtifactId) as { content_sha256: string; artifact_type: string; attempt_plan_version: number; metadata_json: string } | undefined;
  let timelineSourceMetadata: Record<string, unknown> = {};
  try { timelineSourceMetadata = JSON.parse(timelineSource?.metadata_json ?? "{}") as Record<string, unknown>; } catch { /* fail closed below */ }
  const audioArtifact = db.prepare("SELECT content_sha256,artifact_type,attempt_plan_version,metadata_json FROM video_production_stage_artifacts WHERE project_id=? AND artifact_id=?").get(projectId, audioArtifactId) as { content_sha256: string; artifact_type: string; attempt_plan_version: number; metadata_json: string } | undefined;
  const finalAsset = db.prepare("SELECT sha256,byte_size,content_type FROM video_production_assets WHERE project_id=? AND asset_id=? AND shot_id IS NULL").get(projectId, finalAssetId) as { sha256: string; byte_size: number; content_type: string } | undefined;
  const audioAsset = db.prepare("SELECT sha256,content_type,storage_key,byte_size FROM video_production_assets WHERE project_id=? AND asset_id=? AND shot_id IS NULL").get(projectId, audioAssetId) as { sha256: string; content_type: string; storage_key: string; byte_size: number } | undefined;
  let audioMetadata: Record<string, unknown> = {};
  try { audioMetadata = JSON.parse(audioArtifact?.metadata_json ?? "{}") as Record<string, unknown>; } catch { /* fail closed below */ }
  const keys = ["finalAssetId","finalAssetSha256","manifestId","manifestDigest","timelineArtifactId","timelineSha256","timelineSourceArtifactId","timelineSourceSha256","audioCuesArtifactId","audioCuesSha256","audioAssetId","audioSha256","planVersion"];
  if (!manifest || manifest.digest_sha256 !== manifestDigest || manifest.plan_version !== production.plan_version ||
      !timeline || timeline.artifact_type !== "timeline_plan" || timeline.content_sha256 !== timelineSha256 || timeline.attempt_plan_version !== production.plan_version ||
      !timelineSource || timelineSource.artifact_type !== "timeline_source" || timelineSource.content_sha256 !== timelineSourceSha256 || timelineSource.attempt_plan_version !== production.plan_version || timelineSourceMetadata.timelineArtifactId !== timelineArtifactId || timelineSourceMetadata.timelineSha256 !== timelineSha256 ||
      !audioArtifact || audioArtifact.artifact_type !== "audio_cues" || audioArtifact.content_sha256 !== audioCuesSha256 || audioArtifact.attempt_plan_version !== production.plan_version ||
      audioMetadata.audioAssetId !== audioAssetId || !finalAsset || finalAsset.sha256 !== finalAssetSha256 || finalAsset.content_type !== "video/mp4" ||
      !audioAsset || audioAsset.sha256 !== audioSha256 || !audioAsset.content_type.startsWith("audio/") || qaPins.decision !== "approved" ||
      qaPins.finalCutArtifactId !== cut.artifact_id || qaPins.finalCutSha256 !== createHash("sha256").update(cut.content_text).digest("hex") ||
      qaPins.finalCutArtifactId !== cut.artifact_id || keys.some((key) => qaPins[key] !== cutPins[key]) || qaPins.planVersion !== production.plan_version) {
    throw new VideoProductionPolicyError("final_release_evidence_mismatch", 409);
  }
  return { projectId, planVersion: production.plan_version, finalAssetId, finalAssetSha256, finalAssetBytes: finalAsset.byte_size,
    manifestId, manifestDigest, timelineArtifactId, timelineSha256, audioArtifactId, audioCuesSha256, audioAssetId, audioSha256,
      timelineSourceArtifactId, timelineSourceSha256,
      audioAssetStorageKey: audioAsset.storage_key, audioAssetBytes: audioAsset.byte_size, finalCutSha256: cut.content_sha256,
      directorArtifactId: cut.artifact_id, directorDecisionId: director.decision_id, qaArtifactId: qaEvidence.artifact_id, qaArtifactSha256: qaEvidence.content_sha256, qaDecisionId: qa.decision_id };
}

function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = fn(); db.exec("COMMIT"); return result; }
  catch (error) { try { db.exec("ROLLBACK"); } catch { /* original transaction error remains primary */ } throw error; }
}

/** Final release is a CEO-session operation and pins every approved artifact plus the MP4 bytes. */
export type FinalReleaseConfirmation = {
  finalCutArtifactId: string; finalAssetId: string; finalAssetSha256: string; manifestId: string; manifestDigest: string;
  timelineArtifactId: string; timelineSha256: string; timelineSourceArtifactId: string; timelineSourceSha256: string; audioCuesArtifactId: string; audioAssetId: string; audioSha256: string;
  directorDecisionId: string; qaArtifactId: string; qaArtifactSha256: string; qaDecisionId: string;
};

export async function releaseVideoProductionFinalCut(db: Db, projectId: string, releasedBy: "ceo_session", expected: FinalReleaseConfirmation, storageRoot: string) {
  if ((db as DatabaseSync).isTransaction) throw new VideoProductionPolicyError("final_release_requires_top_level_commit", 503);
  const snapshot = loadSnapshot(db, projectId);
  if (expected.finalCutArtifactId !== snapshot.directorArtifactId || expected.finalAssetId !== snapshot.finalAssetId || expected.finalAssetSha256 !== snapshot.finalAssetSha256 ||
      expected.manifestId !== snapshot.manifestId || expected.manifestDigest !== snapshot.manifestDigest || expected.timelineArtifactId !== snapshot.timelineArtifactId ||
      expected.timelineSha256 !== snapshot.timelineSha256 || expected.timelineSourceArtifactId !== snapshot.timelineSourceArtifactId || expected.timelineSourceSha256 !== snapshot.timelineSourceSha256 || expected.audioCuesArtifactId !== snapshot.audioArtifactId || expected.audioAssetId !== snapshot.audioAssetId ||
      expected.audioSha256 !== snapshot.audioSha256 || expected.directorDecisionId !== snapshot.directorDecisionId || expected.qaArtifactId !== snapshot.qaArtifactId ||
      expected.qaArtifactSha256 !== snapshot.qaArtifactSha256 || expected.qaDecisionId !== snapshot.qaDecisionId) throw new VideoProductionPolicyError("final_release_confirmation_stale", 409);
  if (!await isVideoProductionManifestCurrent(db, projectId, snapshot.manifestId, storageRoot) ||
      !await verifyVideoProductionAsset(storageRoot, { projectId, storageKey: `${projectId}/${snapshot.finalAssetSha256}`, sha256: snapshot.finalAssetSha256, byteSize: snapshot.finalAssetBytes }) ||
      !await verifyVideoProductionAsset(storageRoot, { projectId, storageKey: snapshot.audioAssetStorageKey, sha256: snapshot.audioSha256, byteSize: snapshot.audioAssetBytes })) {
    throw new VideoProductionPolicyError("final_release_media_not_current", 409);
  }
  const fingerprint = JSON.stringify(snapshot);
  return inTransaction(db, () => {
    const current = loadSnapshot(db, projectId);
    if (JSON.stringify(current) !== fingerprint) throw new VideoProductionPolicyError("final_release_snapshot_changed", 409);
    if (previewVideoProductionManifest(db, projectId).digest !== snapshot.manifestDigest) throw new VideoProductionPolicyError("final_release_manifest_changed", 409);
    const prior = db.prepare("SELECT * FROM video_production_final_releases WHERE project_id=? AND plan_version=?").get(projectId, snapshot.planVersion) as Record<string, unknown> | undefined;
    if (prior) {
      if (prior.final_asset_id !== snapshot.finalAssetId || prior.final_asset_sha256 !== snapshot.finalAssetSha256 || prior.manifest_digest !== snapshot.manifestDigest || prior.qa_artifact_id !== snapshot.qaArtifactId) throw new VideoProductionPolicyError("final_release_already_pinned", 409);
      return { released: true, idempotent: true, release: prior };
    }
    const releaseId = randomUUID();
    const evidence = { ...snapshot, releasedBy };
    db.prepare(`INSERT INTO video_production_final_releases(project_id,release_id,plan_version,final_asset_id,final_asset_sha256,manifest_id,manifest_digest,timeline_artifact_id,timeline_sha256,timeline_source_artifact_id,timeline_source_sha256,
      audio_artifact_id,audio_cues_sha256,audio_asset_id,audio_sha256,director_artifact_id,director_decision_id,qa_artifact_id,qa_artifact_sha256,qa_decision_id,released_by,released_at,evidence_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(projectId, releaseId, snapshot.planVersion, snapshot.finalAssetId, snapshot.finalAssetSha256, snapshot.manifestId, snapshot.manifestDigest,
      snapshot.timelineArtifactId, snapshot.timelineSha256, snapshot.timelineSourceArtifactId, snapshot.timelineSourceSha256, snapshot.audioArtifactId, snapshot.audioCuesSha256, snapshot.audioAssetId, snapshot.audioSha256, snapshot.directorArtifactId,
      snapshot.directorDecisionId, snapshot.qaArtifactId, snapshot.qaArtifactSha256, snapshot.qaDecisionId, releasedBy, Date.now(), JSON.stringify(evidence));
    db.prepare("INSERT INTO video_production_events(project_id,event,actor_id,detail_json,created_at) VALUES(?,?,?,?,?)")
      .run(projectId, "final_release_approved", releasedBy, JSON.stringify(evidence), Date.now());
    db.prepare("UPDATE video_production_stages SET implemented=1,status='COMPLETED' WHERE project_id=? AND stage_key='release_archive' AND task_id IS NULL AND status IN ('NOT_IMPLEMENTED','BLOCKED')").run(projectId);
    db.prepare("UPDATE video_production_auto_runs SET state='COMPLETED',reason='final_release_recorded',updated_at=? WHERE project_id=? AND plan_version=?")
      .run(Date.now(), projectId, snapshot.planVersion);
    return { released: true, idempotent: false, release: db.prepare("SELECT * FROM video_production_final_releases WHERE project_id=? AND release_id=?").get(projectId, releaseId) };
  });
}
