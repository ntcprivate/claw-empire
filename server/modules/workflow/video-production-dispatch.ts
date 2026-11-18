import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  createVideoProductionAudioCueJob,
  createVideoProductionFinalRenderJob,
  createVideoProductionFinalQaJob,
  createVideoProductionContinuityJob,
  createVideoProductionCreativeReviewJob,
  createVideoProductionRegenerationCoordinatorJob,
  createVideoProductionScreenplayJob,
  createVideoProductionScreenplayRevisionJob,
  createVideoProductionShotRenderJob,
  createVideoProductionShotSpecJob,
  createVideoProductionTakeReviewJob,
  createVideoProductionTimelinePlanJob,
  VideoProductionPolicyError,
} from "./video-production.ts";

type Db = Pick<DatabaseSync, "prepare" | "exec">;
const IDS = {
  production_manager: "video_production-seed-5",
  director: "video_production-role-director",
  screenwriter: "video_production-role-screenwriter",
  art_director: "video_production-role-art-director",
  video_producer: "video_production-role-video-producer",
  editor: "video_production-role-editor",
  sound_producer: "video_production-role-sound-producer",
  qa: "video_production-role-qa-supervisor",
} as const;

function key(action: string, source: string): string {
  return `auto_${createHash("sha256").update(`${action}:${source}`).digest("hex")}`;
}

/** Deterministic Dami selection. It derives the only eligible next task from DB state; callers cannot choose role, action, shot, or artifact. */
export function createNextVideoProductionStageJob(db: Db, projectId: string, createdBy: string) {
  const production = db
    .prepare("SELECT plan_version,state,approved_version,manager_agent_id FROM video_productions WHERE project_id=?")
    .get(projectId) as
    | { plan_version: number; state: string; approved_version: number | null; manager_agent_id: string }
    | undefined;
  if (!production || production.state !== "APPROVED" || production.approved_version !== production.plan_version)
    throw new VideoProductionPolicyError("production_approval_required", 409);
  if (createdBy !== "ceo_session" && createdBy !== production.manager_agent_id)
    throw new VideoProductionPolicyError("production_job_actor_not_authorized", 403);
  const artifact = (type: string) =>
    db
      .prepare(
        `SELECT a.artifact_id,a.task_id,j.state FROM video_production_stage_artifacts a
    JOIN video_production_stage_jobs j ON j.project_id=a.project_id AND j.task_id=a.task_id
    WHERE a.project_id=? AND a.artifact_type=? AND a.attempt_plan_version=? AND j.plan_version=? ORDER BY a.created_at DESC,a.artifact_id DESC LIMIT 1`,
      )
      .get(projectId, type, production.plan_version, production.plan_version) as
      | { artifact_id: string; task_id: string; state: string }
      | undefined;
  const source = (type: string) => artifact(type);
  const idempotencyKey = (action: string, value: string) =>
    key(action, `${projectId}_${production.plan_version}_${value}`);
  const screening = source("screenplay");
  if (!screening)
    return createVideoProductionScreenplayJob(db, {
      projectId,
      agentId: IDS.screenwriter,
      idempotencyKey: idempotencyKey("screenplay", "approved_plan"),
      createdBy,
    });
  const storyDecision = db
    .prepare(
      "SELECT decision FROM video_production_stage_decisions WHERE project_id=? AND target_artifact_id=? ORDER BY created_at DESC,decision_id DESC LIMIT 1",
    )
    .get(projectId, screening.artifact_id) as { decision: string } | undefined;
  if (storyDecision?.decision === "changes_requested")
    return createVideoProductionScreenplayRevisionJob(db, {
      projectId,
      artifactId: screening.artifact_id,
      agentId: IDS.screenwriter,
      idempotencyKey: idempotencyKey("screenplay_revision", screening.artifact_id),
      createdBy,
    });
  if (screening.state === "WAITING_APPROVAL")
    return createVideoProductionCreativeReviewJob(db, {
      projectId,
      artifactId: screening.artifact_id,
      agentId: IDS.director,
      idempotencyKey: idempotencyKey("review_story", screening.artifact_id),
      createdBy,
    });
  if (screening.state !== "COMPLETED")
    throw new VideoProductionPolicyError("production_next_stage_waiting_for_story_decision", 409);

  const shotSpec = source("shot_spec");
  if (!shotSpec)
    return createVideoProductionShotSpecJob(db, {
      projectId,
      screenplayArtifactId: screening.artifact_id,
      agentId: IDS.screenwriter,
      idempotencyKey: idempotencyKey("shot_spec", screening.artifact_id),
      createdBy,
    });
  const continuity = source("continuity_package");
  if (shotSpec.state === "WAITING_APPROVAL" && !continuity)
    return createVideoProductionContinuityJob(db, {
      projectId,
      shotSpecArtifactId: shotSpec.artifact_id,
      agentId: IDS.art_director,
      idempotencyKey: idempotencyKey("continuity", shotSpec.artifact_id),
      createdBy,
    });
  if (!continuity) throw new VideoProductionPolicyError("production_next_stage_waiting_for_continuity", 409);
  const timeline = source("timeline_plan");
  if (continuity.state === "WAITING_APPROVAL" && !timeline)
    return createVideoProductionTimelinePlanJob(db, {
      projectId,
      continuityArtifactId: continuity.artifact_id,
      agentId: IDS.editor,
      idempotencyKey: idempotencyKey("timeline_plan", continuity.artifact_id),
      createdBy,
    });
  if (!timeline) throw new VideoProductionPolicyError("production_next_stage_waiting_for_timeline", 409);
  if (timeline.state === "WAITING_APPROVAL")
    return createVideoProductionCreativeReviewJob(db, {
      projectId,
      artifactId: timeline.artifact_id,
      agentId: IDS.director,
      idempotencyKey: idempotencyKey("review_visual", timeline.artifact_id),
      createdBy,
    });
  if (timeline.state !== "COMPLETED")
    throw new VideoProductionPolicyError("production_next_stage_waiting_for_visual_decision", 409);

  const audio = source("audio_cues");
  if (!audio)
    return createVideoProductionAudioCueJob(db, {
      projectId,
      screenplayArtifactId: screening.artifact_id,
      agentId: IDS.sound_producer,
      idempotencyKey: idempotencyKey("audio", screening.artifact_id),
      createdBy,
    });
  if (audio.state === "WAITING_APPROVAL")
    return createVideoProductionCreativeReviewJob(db, {
      projectId,
      artifactId: audio.artifact_id,
      agentId: IDS.director,
      idempotencyKey: idempotencyKey("review_audio", audio.artifact_id),
      createdBy,
    });
  if (audio.state !== "COMPLETED")
    throw new VideoProductionPolicyError("production_next_stage_waiting_for_audio_decision", 409);

  const shots = db
    .prepare(
      `SELECT sh.shot_id,sh.current_version FROM video_production_scenes sc JOIN video_production_shots sh ON sh.project_id=sc.project_id AND sh.scene_id=sc.scene_id
    JOIN video_production_shot_versions sv ON sv.project_id=sh.project_id AND sv.shot_id=sh.shot_id AND sv.version=sh.current_version
      AND sv.scene_version=sc.current_version
    WHERE sh.project_id=? AND sh.deleted_at IS NULL AND sc.deleted_at IS NULL AND sh.is_required=1 ORDER BY sc.sort_order,sh.sort_order,sh.shot_id`,
    )
    .all(projectId) as Array<{ shot_id: string; current_version: number }>;
  if (!shots.length) throw new VideoProductionPolicyError("production_required_shots_missing", 409);
  for (const shot of shots) {
    const approved = db
      .prepare(
        "SELECT take_id FROM video_production_approved_takes WHERE project_id=? AND shot_id=? AND shot_version=?",
      )
      .get(projectId, shot.shot_id, shot.current_version);
    if (approved) continue;
    const take = db
      .prepare(
        `SELECT take_id FROM video_production_takes WHERE project_id=? AND shot_id=? AND shot_version=? ORDER BY take_number DESC LIMIT 1`,
      )
      .get(projectId, shot.shot_id, shot.current_version) as { take_id: string } | undefined;
    if (!take)
      return createVideoProductionShotRenderJob(db, {
        projectId,
        shotId: shot.shot_id,
        shotVersion: shot.current_version,
        agentId: IDS.video_producer,
        idempotencyKey: idempotencyKey("render", `${shot.shot_id}_${shot.current_version}`),
        createdBy,
      });
    const review = db
      .prepare(
        `SELECT decision FROM video_production_take_reviews WHERE project_id=? AND take_id=? ORDER BY review_number DESC LIMIT 1`,
      )
      .get(projectId, take.take_id) as { decision: string } | undefined;
    if (review?.decision === "rejected") {
      const regeneration = db
        .prepare(
          "SELECT idempotency_key FROM video_production_regeneration_requests WHERE project_id=? AND shot_id=? AND shot_version=? AND rejected_take_id=? ORDER BY created_at DESC LIMIT 1",
        )
        .get(projectId, shot.shot_id, shot.current_version, take.take_id) as { idempotency_key: string } | undefined;
      if (!regeneration)
        return createVideoProductionRegenerationCoordinatorJob(db, {
          projectId,
          shotId: shot.shot_id,
          shotVersion: shot.current_version,
          rejectedTakeId: take.take_id,
          idempotencyKey: idempotencyKey("regeneration_request", take.take_id),
          createdBy,
        });
      return createVideoProductionShotRenderJob(db, {
        projectId,
        shotId: shot.shot_id,
        shotVersion: shot.current_version,
        agentId: IDS.video_producer,
        idempotencyKey: idempotencyKey("render_regeneration", regeneration.idempotency_key),
        createdBy,
      });
    }
    const current = db
      .prepare(
        "SELECT state FROM video_production_stage_jobs WHERE project_id=? AND stage_key='ai_footage_production' AND shot_id=? AND shot_version=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(projectId, shot.shot_id, shot.current_version) as { state: string } | undefined;
    if (current?.state === "WAITING_APPROVAL")
      return createVideoProductionTakeReviewJob(db, {
        projectId,
        shotId: shot.shot_id,
        shotVersion: shot.current_version,
        agentId: IDS.art_director,
        idempotencyKey: idempotencyKey("review_take", take.take_id),
        createdBy,
      });
    throw new VideoProductionPolicyError("production_next_stage_waiting_for_take_review", 409);
  }
  const approvedTimeline = source("timeline_plan");
  if (!approvedTimeline || approvedTimeline.state !== "COMPLETED")
    throw new VideoProductionPolicyError("approved_timeline_plan_required", 409);
  const finalCut = db
    .prepare(
      `SELECT a.artifact_id,a.content_text,a.content_sha256 FROM video_production_stage_artifacts a
    WHERE a.project_id=? AND a.artifact_type='final_cut' AND a.stage_key='asset_handoff_rough_cut' AND a.attempt_plan_version=?
    ORDER BY a.created_at DESC,a.artifact_id DESC LIMIT 1`,
    )
    .get(projectId, production.plan_version) as
    | { artifact_id: string; content_text: string; content_sha256: string }
    | undefined;
  if (!finalCut)
    return createVideoProductionFinalRenderJob(db, {
      projectId,
      timelineArtifactId: approvedTimeline.artifact_id,
      agentId: IDS.editor,
      idempotencyKey: idempotencyKey("final_render", approvedTimeline.artifact_id),
      createdBy,
    });
  const finalCutDecision = db
    .prepare(
      "SELECT decision,decision_id FROM video_production_stage_decisions WHERE project_id=? AND target_artifact_id=? AND stage_key='director_review' ORDER BY created_at DESC,decision_id DESC LIMIT 1",
    )
    .get(projectId, finalCut.artifact_id) as { decision: string; decision_id: string } | undefined;
  if (!finalCutDecision)
    return createVideoProductionCreativeReviewJob(db, {
      projectId,
      artifactId: finalCut.artifact_id,
      agentId: IDS.director,
      idempotencyKey: idempotencyKey("review_final_cut", finalCut.artifact_id),
      createdBy,
    });
  if (finalCutDecision.decision !== "approved")
    throw new VideoProductionPolicyError("director_requested_final_cut_changes", 409);
  const qaJob = db
    .prepare(
      "SELECT task_id,state FROM video_production_stage_jobs WHERE project_id=? AND stage_key='finishing_qa' AND target_artifact_id=? ORDER BY created_at DESC LIMIT 1",
    )
    .get(projectId, finalCut.artifact_id) as { task_id: string; state: string } | undefined;
  if (!qaJob)
    return createVideoProductionFinalQaJob(db, {
      projectId,
      finalCutArtifactId: finalCut.artifact_id,
      agentId: IDS.qa,
      idempotencyKey: idempotencyKey("final_qa", finalCut.artifact_id),
      createdBy,
    });
  if (qaJob.state !== "COMPLETED") throw new VideoProductionPolicyError("final_qa_pending", 409);
  // A completed QA task records a decision, including rejection. Only approved
  // evidence for this exact cut may transition to the CEO release checkpoint.
  const qa = db
    .prepare(
      `SELECT a.content_text,a.content_sha256,d.decision
    FROM video_production_stage_artifacts a
    JOIN video_production_stage_decisions d ON d.project_id=a.project_id AND d.target_artifact_id=a.artifact_id
      AND d.task_id=a.task_id AND d.attempt_id=a.attempt_id AND d.stage_key='finishing_qa'
    JOIN video_production_stage_jobs j ON j.project_id=a.project_id AND j.task_id=a.task_id
      AND j.plan_version=a.attempt_plan_version AND j.target_artifact_id=? AND j.execution_action='qa.final' AND j.stage_key='finishing_qa'
    WHERE a.project_id=? AND a.task_id=? AND a.artifact_type='qa_evidence' AND a.stage_key='finishing_qa'
      AND a.attempt_plan_version=? AND j.state='COMPLETED'
    ORDER BY d.created_at DESC,d.decision_id DESC LIMIT 1`,
    )
    .get(finalCut.artifact_id, projectId, qaJob.task_id, production.plan_version) as
    | { content_text: string; content_sha256: string; decision: string }
    | undefined;
  let cutPins: Record<string, unknown>;
  let qaPins: Record<string, unknown>;
  try {
    cutPins = JSON.parse(finalCut.content_text) as Record<string, unknown>;
    qaPins = JSON.parse(qa?.content_text ?? "null") as Record<string, unknown>;
  } catch {
    throw new VideoProductionPolicyError("final_qa_evidence_invalid", 409);
  }
  const pins = [
    "finalAssetId",
    "finalAssetSha256",
    "manifestId",
    "manifestDigest",
    "timelineArtifactId",
    "timelineSha256",
    "timelineSourceArtifactId",
    "timelineSourceSha256",
    "audioCuesArtifactId",
    "audioCuesSha256",
    "audioAssetId",
    "audioSha256",
  ];
  if (
    !qa ||
    !cutPins ||
    !qaPins ||
    qaPins.decision !== qa.decision ||
    qaPins.finalCutArtifactId !== finalCut.artifact_id ||
    createHash("sha256").update(finalCut.content_text).digest("hex") !== finalCut.content_sha256 ||
    createHash("sha256").update(qa.content_text).digest("hex") !== qa.content_sha256 ||
    qaPins.finalCutSha256 !== finalCut.content_sha256 ||
    qaPins.planVersion !== production.plan_version ||
    cutPins.planVersion !== production.plan_version ||
    pins.some((pin) => typeof cutPins[pin] !== "string" || !cutPins[pin] || qaPins[pin] !== cutPins[pin])
  ) {
    throw new VideoProductionPolicyError("final_qa_evidence_invalid", 409);
  }
  if (qa.decision !== "approved") throw new VideoProductionPolicyError("final_qa_changes_requested", 409);
  throw new VideoProductionPolicyError("awaiting_ceo_final_release", 409);
}
