import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createNextVideoProductionStageJob } from "./video-production-dispatch.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Minimal persisted state at the end of the pipeline, without media/provider calls. */
function readyForRelease(decision = "approved") {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE video_productions(project_id TEXT,plan_version INTEGER,state TEXT,approved_version INTEGER,manager_agent_id TEXT);
    INSERT INTO video_productions VALUES('project',1,'APPROVED',1,'dami');
    CREATE TABLE video_production_stage_jobs(task_id TEXT,project_id TEXT,stage_key TEXT,execution_action TEXT,state TEXT,plan_version INTEGER,target_artifact_id TEXT,created_at INTEGER);
    CREATE TABLE video_production_stage_artifacts(artifact_id TEXT,project_id TEXT,task_id TEXT,attempt_id TEXT,artifact_type TEXT,stage_key TEXT,attempt_plan_version INTEGER,content_text TEXT,content_sha256 TEXT,created_at INTEGER);
    CREATE TABLE video_production_stage_decisions(decision_id TEXT,project_id TEXT,target_artifact_id TEXT,task_id TEXT,attempt_id TEXT,stage_key TEXT,decision TEXT,created_at INTEGER);
    CREATE TABLE video_production_scenes(project_id TEXT,scene_id TEXT,current_version INTEGER,deleted_at INTEGER,sort_order INTEGER);
    INSERT INTO video_production_scenes VALUES('project','scene',1,NULL,0);
    CREATE TABLE video_production_shots(project_id TEXT,scene_id TEXT,shot_id TEXT,current_version INTEGER,deleted_at INTEGER,is_required INTEGER,sort_order INTEGER);
    INSERT INTO video_production_shots VALUES('project','scene','shot',1,NULL,1,0);
    CREATE TABLE video_production_shot_versions(project_id TEXT,shot_id TEXT,version INTEGER,scene_version INTEGER);
    INSERT INTO video_production_shot_versions VALUES('project','shot',1,1);
    CREATE TABLE video_production_approved_takes(project_id TEXT,shot_id TEXT,shot_version INTEGER,take_id TEXT);
    INSERT INTO video_production_approved_takes VALUES('project','shot',1,'take');
  `);
  const addArtifact = (id: string, type: string, stage: string, content: unknown) => {
    const text = JSON.stringify(content);
    db.prepare("INSERT INTO video_production_stage_artifacts VALUES(?,'project',?,?,?, ?,1,?,?,1)").run(
      id,
      `${id}-task`,
      `${id}-attempt`,
      type,
      stage,
      text,
      hash(text),
    );
    db.prepare("INSERT INTO video_production_stage_jobs VALUES(?,'project',?,?,'COMPLETED',1,?,1)").run(
      `${id}-task`,
      stage,
      type === "qa_evidence" ? "qa.final" : "fixture",
      type === "qa_evidence" ? "cut" : null,
    );
    return text;
  };
  addArtifact("story", "screenplay", "story_development", {});
  addArtifact("shots", "shot_spec", "visual_preproduction", {});
  addArtifact("continuity", "continuity_package", "visual_preproduction", {});
  addArtifact("timeline", "timeline_plan", "visual_preproduction", {});
  addArtifact("audio", "audio_cues", "audio_preproduction", {});
  const cutPins = {
    planVersion: 1,
    finalAssetId: "final-video",
    finalAssetSha256: "a".repeat(64),
    manifestId: "manifest",
    manifestDigest: "b".repeat(64),
    timelineArtifactId: "timeline",
    timelineSha256: "c".repeat(64),
    timelineSourceArtifactId: "source",
    timelineSourceSha256: "d".repeat(64),
    audioCuesArtifactId: "audio",
    audioCuesSha256: "e".repeat(64),
    audioAssetId: "voice",
    audioSha256: "f".repeat(64),
  };
  const cutText = addArtifact("cut", "final_cut", "asset_handoff_rough_cut", cutPins);
  const qaPins = { ...cutPins, finalCutArtifactId: "cut", finalCutSha256: hash(cutText), decision };
  addArtifact("qa", "qa_evidence", "finishing_qa", qaPins);
  db.prepare(
    "INSERT INTO video_production_stage_decisions VALUES('director','project','cut','director-task','director-attempt','director_review','approved',1)",
  ).run();
  db.prepare(
    "INSERT INTO video_production_stage_decisions VALUES('quinn','project','qa','qa-task','qa-attempt','finishing_qa',?,1)",
  ).run(decision);
  return { db, qaPins };
}

describe("video production final QA dispatch", () => {
  it("waits for CEO release only after exact approved QA evidence", () => {
    const { db } = readyForRelease();
    expect(() => createNextVideoProductionStageJob(db, "project", "dami")).toThrow("awaiting_ceo_final_release");
  });

  it("stops on Quinn's changes request despite its completed QA job", () => {
    const { db } = readyForRelease("changes_requested");
    expect(() => createNextVideoProductionStageJob(db, "project", "dami")).toThrow("final_qa_changes_requested");
  });

  it.each(["target", "attempt", "plan", "missing"])("rejects %s QA evidence before the CEO checkpoint", (mismatch) => {
    const { db } = readyForRelease();
    if (mismatch === "target")
      db.prepare(
        "UPDATE video_production_stage_decisions SET target_artifact_id='other-cut' WHERE decision_id='quinn'",
      ).run();
    if (mismatch === "attempt")
      db.prepare(
        "UPDATE video_production_stage_decisions SET attempt_id='other-attempt' WHERE decision_id='quinn'",
      ).run();
    if (mismatch === "plan")
      db.prepare("UPDATE video_production_stage_artifacts SET attempt_plan_version=2 WHERE artifact_id='qa'").run();
    if (mismatch === "missing") db.prepare("DELETE FROM video_production_stage_artifacts WHERE artifact_id='qa'").run();
    expect(() => createNextVideoProductionStageJob(db, "project", "dami")).toThrow("final_qa_evidence_invalid");
  });

  it.each([
    "finalCutArtifactId",
    "finalCutSha256",
    "finalAssetSha256",
    "timelineSourceSha256",
    "decision",
    "planVersion",
  ])("rejects mismatched %s in otherwise approved evidence", (pin) => {
    const { db, qaPins } = readyForRelease();
    const text = JSON.stringify({ ...qaPins, [pin]: "mismatched" });
    db.prepare(
      "UPDATE video_production_stage_artifacts SET content_text=?,content_sha256=? WHERE artifact_id='qa'",
    ).run(text, hash(text));
    expect(() => createNextVideoProductionStageJob(db, "project", "dami")).toThrow("final_qa_evidence_invalid");
  });

  it("continues to stop on the director's final cut changes request", () => {
    const { db } = readyForRelease();
    db.prepare(
      "UPDATE video_production_stage_decisions SET decision='changes_requested' WHERE decision_id='director'",
    ).run();
    expect(() => createNextVideoProductionStageJob(db, "project", "dami")).toThrow(
      "director_requested_final_cut_changes",
    );
  });

  it.each(["cut", "qa"])("rejects a corrupted %s content hash", (artifactId) => {
    const { db } = readyForRelease();
    db.prepare("UPDATE video_production_stage_artifacts SET content_sha256=? WHERE artifact_id=?").run(
      "0".repeat(64),
      artifactId,
    );
    expect(() => createNextVideoProductionStageJob(db, "project", "dami")).toThrow("final_qa_evidence_invalid");
  });
});
