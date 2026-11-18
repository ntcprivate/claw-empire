import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { VideoStudioAction } from "../../../shared/video-studio-organization.ts";
import { createTrustedVideoProductionAttemptActor, assertVideoProductionAgentAttemptCurrent } from "./video-production-rbac.ts";

type Db = Pick<DatabaseSync, "prepare" | "exec">;
export type VideoProductionStageArtifactType = "screenplay" | "shot_spec" | "continuity_package" | "timeline_plan" | "remotion_source" | "audio_cues" | "timeline_source" | "final_cut" | "qa_evidence";

/** Persist an immutable typed text artifact from an in-process active stage attempt. */
export function recordTrustedVideoProductionStageArtifact(db: Db, input: {
  attemptId: string;
  action: VideoStudioAction;
  artifactType: VideoProductionStageArtifactType;
  stageKey: string;
  content: string;
  shotId?: string;
  shotVersion?: number;
  metadata?: Record<string, unknown>;
}): { artifactId: string; sha256: string } {
  if (input.content.length > 1_048_576) throw new Error("video_production_stage_artifact_too_large");
  const metadataJson = JSON.stringify(input.metadata ?? {});
  if (metadataJson.length > 32_768) throw new Error("video_production_stage_artifact_metadata_too_large");
  const allowed: Partial<Record<VideoProductionStageArtifactType, { stageKey: string; action: VideoStudioAction }>> = {
    screenplay: { stageKey: "story_development", action: "screenplay.write" },
    shot_spec: { stageKey: "visual_preproduction", action: "shot_spec.write" },
    continuity_package: { stageKey: "visual_preproduction", action: "visual.manage" },
    timeline_plan: { stageKey: "visual_preproduction", action: "edit.manage" },
    remotion_source: { stageKey: "ai_footage_production", action: "footage.submit" },
    audio_cues: { stageKey: "audio_preproduction", action: "audio.manage" },
    timeline_source: { stageKey: "asset_handoff_rough_cut", action: "edit.manage" },
    final_cut: { stageKey: "asset_handoff_rough_cut", action: "edit.manage" },
    qa_evidence: { stageKey: "finishing_qa", action: "qa.final" },
  };
  if (allowed[input.artifactType]?.stageKey !== input.stageKey || allowed[input.artifactType]?.action !== input.action) {
    throw new Error("video_production_stage_artifact_action_mismatch");
  }
  const actor = createTrustedVideoProductionAttemptActor(db, input.attemptId, input.action);
  const attempt = assertVideoProductionAgentAttemptCurrent(db, actor, actor.projectId, input.action);
  const sha256 = createHash("sha256").update(input.content, "utf8").digest("hex");
  const logicalKey = `${input.attemptId}:${input.artifactType}:${input.shotId ?? ""}:${input.shotVersion ?? ""}`;
  const artifactId = `stage-${createHash("sha256").update(logicalKey).digest("hex").slice(0, 48)}`;
  const existing = db.prepare("SELECT content_sha256,metadata_json FROM video_production_stage_artifacts WHERE project_id=? AND artifact_id=?").get(actor.projectId, artifactId) as { content_sha256: string; metadata_json: string } | undefined;
  if (existing) {
    if (existing.content_sha256 !== sha256 || existing.metadata_json !== metadataJson) throw new Error("video_production_stage_artifact_idempotency_conflict");
    return { artifactId, sha256 };
  }
  db.prepare(`INSERT INTO video_production_stage_artifacts
    (project_id,artifact_id,stage_key,artifact_type,shot_id,shot_version,content_sha256,content_text,metadata_json,
      created_by_agent_id,task_id,attempt_id,attempt_plan_version,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(actor.projectId, artifactId, input.stageKey, input.artifactType,
    input.shotId ?? null, input.shotVersion ?? null, sha256, input.content, metadataJson,
    actor.agentId, attempt.task_id, attempt.attempt_id, attempt.plan_version, Date.now());
  return { artifactId, sha256 };
}
