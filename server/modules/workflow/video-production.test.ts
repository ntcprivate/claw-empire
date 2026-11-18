import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyBaseSchema } from "../bootstrap/schema/base-schema.ts";
import {
  assertVideoProductionTaskAdmission,
  decideVideoProduction,
  ensureVideoProductionSchema,
  getVideoProduction,
  ingestVideoProductionDirective,
  isManagedVideoProductionTask,
  releaseVideoProductionTask,
  reserveVideoProductionTask,
  saveVideoProductionPlan,
} from "./video-production.ts";
import type { VideoProductionBrief } from "../../../shared/video-production.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  applyBaseSchema(db);
  ensureVideoProductionSchema(db);
  db.prepare(
    "INSERT INTO departments(id,name,name_ko,icon,color) VALUES('operations','Operations','Operations','P','#000')",
  ).run();
  return db;
}
const brief: VideoProductionBrief = {
  title: "Launch video",
  objective: "Explain the product",
  targetAudience: "Editors",
  duration: "60s",
  aspectRatio: "9:16",
  language: "Vietnamese",
  style: "Documentary",
  deliveryPlatform: "Shorts",
  constraints: "",
};
const directive = (id = "message-1") => ({
  messageId: id,
  content: "Create a launch video",
  projectPath: path.resolve(process.cwd(), ".tmp", "production-fixtures", id),
  brief,
});
function code(fn: () => unknown, error: string) {
  expect(fn).toThrow(error);
}

describe("video production foundation", () => {
  it("migrates idempotently, preserves missing brief fields, creates one persistent root and no unsupported tasks", () => {
    const db = setup();
    ensureVideoProductionSchema(db);
    const first = ingestVideoProductionDirective(db, { ...directive(), brief: { title: "Supplied title" } });
    expect(first.state).toBe("NEEDS_INFORMATION");
    expect(first.brief.objective).toBe("");
    expect(first.manager_agent_id).toBe("video_production-seed-5");
    expect(first.stages).toHaveLength(9);
    expect(first.stages.slice(1).every((stage) => !stage.implemented && stage.task_id === null)).toBe(true);
    const again = ingestVideoProductionDirective(db, { ...directive(), brief: { title: "Supplied title" } });
    expect(again).toEqual(first);
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()?.count).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE sender_type='agent'").get()?.count).toBe(1);
    expect(db.prepare("SELECT content FROM messages WHERE sender_type='agent'").get()?.content).toContain("objective");
    code(
      () => ingestVideoProductionDirective(db, { ...directive(), content: "Different request" }),
      "directive_idempotency_conflict",
    );
    expect(getVideoProduction(db, first.project_id)).toEqual(first);
  });

  it("versions edits, rejects stale approval, records idempotent human approval, and stops at NOT_IMPLEMENTED", () => {
    const db = setup();
    const first = ingestVideoProductionDirective(db, directive());
    code(() => assertVideoProductionTaskAdmission(db, first.root_task_id), "production_planning_human_only");
    const edited = saveVideoProductionPlan(db, first.project_id, {
      brief: { ...brief, duration: "90s" },
      expectedVersion: 1,
    });
    expect(edited.plan_version).toBe(2);
    code(() => decideVideoProduction(db, first.project_id, { version: 1, decision: "approve" }), "stale_plan_version");
    const approved = decideVideoProduction(db, first.project_id, { version: 2, decision: "approve", actorId: "ceo-1" });
    expect(approved.state).toBe("APPROVED");
    expect(approved.approved_version).toBe(2);
    expect(approved.stages[0].status).toBe("COMPLETED");
    expect(approved.stages[1].status).toBe("NOT_IMPLEMENTED");
    expect(approved.stages.some((stage) => stage.status === "READY" || stage.status === "RUNNING")).toBe(false);
    expect(decideVideoProduction(db, first.project_id, { version: 2, decision: "approve", actorId: "ceo-1" })).toEqual(
      approved,
    );
    expect(approved.decisions).toHaveLength(1);
    const revised = saveVideoProductionPlan(db, first.project_id, { brief, expectedVersion: 2 });
    expect(revised.approved_version).toBeNull();
    expect(revised.stages[1].status).toBe("NOT_IMPLEMENTED");
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM video_production_plan_versions WHERE project_id=?")
        .get(first.project_id)?.count,
    ).toBe(3);
  });

  it("persists changes requested without launching and rejects approval of incomplete brief", () => {
    const db = setup();
    const first = ingestVideoProductionDirective(db, directive());
    const rejected = decideVideoProduction(db, first.project_id, {
      version: 1,
      decision: "request_changes",
      note: "Clarify goal",
    });
    expect(rejected.state).toBe("CHANGES_REQUESTED");
    const revised = saveVideoProductionPlan(db, first.project_id, {
      brief: { title: "Only title" },
      expectedVersion: 1,
    });
    expect(revised.state).toBe("NEEDS_INFORMATION");
    code(
      () => decideVideoProduction(db, first.project_id, { version: 2, decision: "approve" }),
      "plan_not_ready_for_approval",
    );
  });

  it("rolls back partial ingestion when project path conflicts and does not steal legacy manager", () => {
    const db = setup();
    db.prepare(
      "INSERT INTO agents(id,name,department_id,workflow_pack_key,role,acts_as_planning_leader) VALUES('legacy','Rian','operations','video_preprod','team_leader',1)",
    ).run();
    const first = ingestVideoProductionDirective(db, directive());
    expect(first.manager_agent_id).not.toBe("legacy");
    code(
      () =>
        ingestVideoProductionDirective(db, {
          ...directive("message-2"),
          projectId: first.project_id,
          projectPath: "D:\\Other",
        }),
      "project_path_mismatch",
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()?.count).toBe(1);
    expect(db.prepare("SELECT acts_as_planning_leader AS flag FROM agents WHERE id='legacy'").get()?.flag).toBe(1);
  });

  it("leaves legacy tasks alone and prevents project-level bypass", () => {
    const db = setup();
    const first = ingestVideoProductionDirective(db, directive());
    db.prepare("INSERT INTO tasks(id,title,workflow_pack_key) VALUES('legacy-task','Legacy','development')").run();
    expect(isManagedVideoProductionTask(db, "legacy-task")).toBe(false);
    expect(() => assertVideoProductionTaskAdmission(db, "legacy-task")).not.toThrow();
    db.prepare("UPDATE tasks SET project_id=? WHERE id='legacy-task'").run(first.project_id);
    expect(isManagedVideoProductionTask(db, "legacy-task")).toBe(true);
    code(() => assertVideoProductionTaskAdmission(db, "legacy-task"), "video_production_not_registered");
  });

  it("enforces one persisted global slot and gates retries on READY status", () => {
    const db = setup();
    const ids = ["one", "two"].map((id) => {
      const value = ingestVideoProductionDirective(db, directive(id));
      decideVideoProduction(db, value.project_id, { version: 1, decision: "approve" });
      const taskId = `supported-fixture-${id}`;
      // Future-worker fixture: Phase 1 never enables these stages itself.
      db.prepare("INSERT INTO tasks(id,title,workflow_pack_key,project_id) VALUES(?,?,'video_production',?)").run(
        taskId,
        id,
        value.project_id,
      );
      db.prepare(
        "UPDATE video_production_stages SET implemented=1,status='READY',task_id=? WHERE project_id=? AND stage_order=2",
      ).run(taskId, value.project_id);
      return taskId;
    });
    const firstAttempt = reserveVideoProductionTask(db, ids[0]);
    code(() => reserveVideoProductionTask(db, ids[1]), "production_slot_busy");
    code(() => reserveVideoProductionTask(db, ids[0]), "production_stage_not_ready");
    releaseVideoProductionTask(db, ids[0], { outcome: "failed", attemptId: firstAttempt });
    code(() => reserveVideoProductionTask(db, ids[0]), "production_stage_not_ready");
    reserveVideoProductionTask(db, ids[1]);
    expect(db.prepare("SELECT task_id FROM video_production_slot").get()?.task_id).toBe(ids[1]);
    ensureVideoProductionSchema(db);
    expect(db.prepare("SELECT task_id FROM video_production_slot").get()?.task_id).toBe(ids[1]);
  });

  it("binds only explicitly opted-in empty projects and preserves unrelated projects", () => {
    const db = setup();
    db.prepare("INSERT INTO projects(id,name,project_path,core_goal) VALUES('empty','Empty',?,'Existing goal')").run(
      directive().projectPath,
    );
    code(
      () => ingestVideoProductionDirective(db, { ...directive(), projectId: "empty" }),
      "project_not_video_production",
    );
    const result = ingestVideoProductionDirective(db, {
      ...directive(),
      projectId: "empty",
      allowProjectBinding: true,
    });
    expect(result.project_id).toBe("empty");
    db.prepare("INSERT INTO projects(id,name,project_path,core_goal) VALUES('busy','Busy',?,'Existing goal')").run(
      directive("second").projectPath,
    );
    db.prepare("INSERT INTO tasks(id,title,project_id) VALUES('existing','Existing','busy')").run();
    code(
      () =>
        ingestVideoProductionDirective(db, { ...directive("second"), projectId: "busy", allowProjectBinding: true }),
      "project_not_video_production",
    );
    expect(db.prepare("SELECT default_pack_key FROM projects WHERE id='busy'").get()?.default_pack_key).toBe(
      "development",
    );
  });

  it("makes only an implemented next task READY after approval and keeps dependencies blocked", () => {
    const db = setup();
    const value = ingestVideoProductionDirective(db, directive());
    // Simulated future executor capability; no production stage is enabled by Phase 1.
    db.prepare(
      "INSERT INTO tasks(id,title,project_id,workflow_pack_key) VALUES('future-story','Story',?,'video_production')",
    ).run(value.project_id);
    db.prepare(
      "UPDATE video_production_stages SET implemented=1,status='BLOCKED',task_id='future-story' WHERE project_id=? AND stage_order=2",
    ).run(value.project_id);
    code(() => assertVideoProductionTaskAdmission(db, "future-story"), "production_approval_required");
    const approved = decideVideoProduction(db, value.project_id, { version: 1, decision: "approve" });
    expect(approved.stages[1].status).toBe("READY");
    expect(approved.stages.slice(2).every((stage) => stage.status === "NOT_IMPLEMENTED")).toBe(true);
    expect(() => assertVideoProductionTaskAdmission(db, "future-story")).not.toThrow();
    saveVideoProductionPlan(db, value.project_id, { brief: { ...brief, duration: "90s" }, expectedVersion: 1 });
    code(() => assertVideoProductionTaskAdmission(db, "future-story"), "production_approval_required");
  });

  it("enforces the global execution ceiling in SQLite even for direct SQL writes", () => {
    const db = setup();
    const first = ingestVideoProductionDirective(db, directive("one"));
    const second = ingestVideoProductionDirective(db, directive("two"));
    db.prepare("UPDATE video_production_stages SET status='RUNNING' WHERE project_id=? AND stage_order=2").run(
      first.project_id,
    );
    expect(() =>
      db
        .prepare("UPDATE video_production_stages SET status='RUNNING' WHERE project_id=? AND stage_order=2")
        .run(second.project_id),
    ).toThrow(/UNIQUE constraint failed/);
    db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(first.root_task_id);
    expect(() => db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(second.root_task_id)).toThrow(
      /UNIQUE constraint failed/,
    );
    db.prepare(
      "INSERT INTO tasks(id,title,status,workflow_pack_key) VALUES('legacy-one','Legacy','in_progress','development'),('legacy-two','Legacy','in_progress','development')",
    ).run();
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM tasks WHERE workflow_pack_key='development' AND status='in_progress'")
        .get()?.count,
    ).toBe(2);
  });

  it("persists slot ownership across independent connections and process-style reopen", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claw-production-test-"));
    const file = path.join(directory, "production.sqlite");
    const first = new DatabaseSync(file);
    first.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL");
    let second: DatabaseSync | undefined;
    try {
      applyBaseSchema(first);
      ensureVideoProductionSchema(first);
      first
        .prepare(
          "INSERT INTO departments(id,name,name_ko,icon,color) VALUES('operations','Operations','Operations','P','#000')",
        )
        .run();
      const tasks = ["one", "two"].map((id) => {
        const value = ingestVideoProductionDirective(first, directive(id));
        decideVideoProduction(first, value.project_id, { version: 1, decision: "approve" });
        const taskId = `future-${id}`;
        first
          .prepare("INSERT INTO tasks(id,title,project_id,workflow_pack_key) VALUES(?,?,?,'video_production')")
          .run(taskId, id, value.project_id);
        first
          .prepare(
            "UPDATE video_production_stages SET implemented=1,status='READY',task_id=? WHERE project_id=? AND stage_order=2",
          )
          .run(taskId, value.project_id);
        return taskId;
      });
      second = new DatabaseSync(file);
      const firstAttempt = reserveVideoProductionTask(first, tasks[0]);
      code(() => reserveVideoProductionTask(second!, tasks[1]), "production_slot_busy");
      second.close();
      second = new DatabaseSync(file);
      ensureVideoProductionSchema(second);
      expect(second.prepare("SELECT task_id FROM video_production_slot").get()?.task_id).toBe(tasks[0]);
      releaseVideoProductionTask(second, tasks[0], { outcome: "failed", attemptId: firstAttempt });
      reserveVideoProductionTask(first, tasks[1]);
      expect(
        second.prepare("SELECT COUNT(*) AS count FROM video_production_stages WHERE status='RUNNING'").get()?.count,
      ).toBe(1);
    } finally {
      second?.close();
      first.close();
      for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(`${file}${suffix}`, { force: true });
      fs.rmdirSync(directory);
    }
  }, 20000);
});
