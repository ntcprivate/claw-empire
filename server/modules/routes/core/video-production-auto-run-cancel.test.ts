import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { ensureVideoProductionSchema } from "../../bootstrap/schema/video-production-schema.ts";
import { registerVideoProductionRoutes } from "./video-production.ts";
import { createVideoProductionAutoRunner, resumeVideoProductionAutoRun } from "../../workflow/video-production-auto-run.ts";
import { createNextVideoProductionStageJob } from "../../workflow/video-production-dispatch.ts";
import {
  claimVideoProductionAttempt, decideVideoProduction, finishVideoProductionAttempt,
  ingestVideoProductionDirective, setVideoProductionAttemptLaunchState,
} from "../../workflow/video-production.ts";
import { grantVideoProductionProjectAgent, seedVideoProductionOrganization } from "../../workflow/video-production-rbac.ts";
import {
  reconcileVideoProductionAttemptsAfterRestart, registerVideoProductionProviderAbort,
  unregisterVideoProductionProviderAbort,
} from "../../workflow/video-production-execution.ts";

const worker = vi.hoisted(() => ({ stop: vi.fn(() => true), inspect: vi.fn(() => ({ state: "unknown", verified: false })) }));
vi.mock("../../../security/auth.ts", () => ({
  isAuthenticated: (req: express.Request) => req.header("x-test-session") === "ceo",
  hasValidCsrfToken: (req: express.Request) => req.header("x-test-csrf") === "valid",
  getVideoProductionAuthenticatedAgent: () => null,
}));
vi.mock("../../workflow/worker-isolation.ts", () => ({
  isWorkerIsolationReady: () => true,
  stopVerifiedWorkerContainer: worker.stop,
  inspectWorkerContainer: worker.inspect,
}));

const databases: DatabaseSync[] = [];
const aborts: Array<{ taskId: string; attemptId: string; controller: AbortController }> = [];
afterEach(() => {
  for (const abort of aborts.splice(0)) unregisterVideoProductionProviderAbort(abort.taskId, abort.attemptId, abort.controller);
  for (const db of databases.splice(0)) db.close();
  vi.clearAllMocks();
});

function fixture(kind = "phase4_provider_broker") {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  ensureVideoProductionSchema(db);
  for (const id of ["operations", "planning", "design", "dev", "qa", "devsecops"]) {
    db.prepare("INSERT OR IGNORE INTO departments(id,name,name_ko,icon,color) VALUES(?,?,?,?,?)").run(id, id, id, "D", "#777");
  }
  seedVideoProductionOrganization(db, "ceo_session");
  const production = ingestVideoProductionDirective(db, {
    messageId: "auto-cancel", content: "Create a short video", projectPath: process.cwd(),
    brief: { title: "Cancel test", objective: "Explain", targetAudience: "Viewers", duration: "30s", aspectRatio: "16:9", language: "Vietnamese", style: "Documentary", deliveryPlatform: "Web", constraints: "" },
  });
  decideVideoProduction(db, production.project_id, { version: 1, decision: "approve" });
  const agentId = "video_production-role-screenwriter";
  grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId, grantedBy: "ceo_session" });
  const job = createNextVideoProductionStageJob(db, production.project_id, "ceo_session");
  const taskId = job.taskId;
  const attemptId = "old-attempt";
  claimVideoProductionAttempt(db, taskId, attemptId, kind, agentId, undefined, "screenplay.write");
  setVideoProductionAttemptLaunchState(db, taskId, attemptId, "RUNNING", {
    workerIdentity: "fixture-worker", imageId: "sha256:fixture", workspacePath: process.cwd(),
  });
  resumeVideoProductionAutoRun(db, taskId);
  const controller = new AbortController();
  if (kind === "phase4_provider_broker") {
    registerVideoProductionProviderAbort(taskId, attemptId, controller);
    aborts.push({ taskId, attemptId, controller });
  }
  const execute = vi.fn(async () => ({ status: 202, body: { ok: true } }));
  const runner = createVideoProductionAutoRunner({
    db, activeProcesses: new Map(), appendTaskLog: vi.fn(), getNextHttpAgentPid: () => 1,
    broadcast: vi.fn(), startProgressTimer: vi.fn(), handleTaskRunComplete: vi.fn(), notifyCeo: vi.fn(),
  } as never, execute);
  const app = express();
  app.use(express.json());
  const schedule = vi.fn();
  registerVideoProductionRoutes({ app, db, broadcast: vi.fn(), scheduleVideoProductionAutoRun: schedule });
  const cancel = (id = attemptId) => request(app).post(`/api/tasks/${taskId}/video-production/cancel`)
    .set("x-test-session", "ceo").set("x-test-csrf", "valid").send({ attempt_id: id });
  return { db, taskId, attemptId, agentId, production, controller, runner, execute, cancel };
}

describe("video auto-run cancellation intent", () => {
  it.each(["completion callback", "startup recovery"])("pauses accepted provider cancellation durably before %s and never restarts it", async (completion) => {
    const h = fixture();
    const response = await h.cancel().expect(202);
    expect(response.body).toMatchObject({ cancelRequested: true, status: "stopping" });
    expect(h.controller.signal.aborted).toBe(true);
    expect(h.db.prepare("SELECT state,reason FROM video_production_auto_runs").get()).toEqual({ state: "PAUSED", reason: "ceo_cancelled" });
    // The cancellation response is already durable while the original attempt
    // is still RUNNING; neither its later callback nor startup may revive it.
    expect(h.db.prepare("SELECT state,json_extract(detail_json,'$.cancelRequested') AS cancelled FROM video_production_attempts").get()).toEqual({ state: "RUNNING", cancelled: 1 });
    if (completion === "completion callback") {
      expect(finishVideoProductionAttempt(h.db, h.taskId, h.attemptId, "failed", { reason: "cancelled" })).toBe(true);
    } else {
      expect(reconcileVideoProductionAttemptsAfterRestart(h.db)).toContainEqual({ taskId: h.taskId, attemptId: h.attemptId, state: "failed" });
    }
    await h.runner.drain();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.db.prepare("SELECT state,reason FROM video_production_auto_runs").get()).toEqual({ state: "PAUSED", reason: "ceo_cancelled" });
    expect(worker.stop).not.toHaveBeenCalled();
    expect(worker.inspect).not.toHaveBeenCalled();
  });

  it("keeps a newly resumed same-task run active when an old worker cancellation is repeated", async () => {
    const h = fixture("phase4_remotion");
    await h.cancel().expect(200);
    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(h.db.prepare("SELECT state FROM video_production_auto_runs").get()).toEqual({ state: "PAUSED" });
    claimVideoProductionAttempt(h.db, h.taskId, "new-attempt", "phase4_remotion", h.agentId, h.attemptId, "screenplay.write");
    setVideoProductionAttemptLaunchState(h.db, h.taskId, "new-attempt", "RUNNING");
    resumeVideoProductionAutoRun(h.db, h.taskId);
    const response = await h.cancel(h.attemptId).expect(200);
    expect(response.body.alreadyCancelled).toBe(true);
    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(h.db.prepare("SELECT state,reason FROM video_production_auto_runs").get()).toEqual({ state: "RUNNING", reason: null });
    expect(h.db.prepare("SELECT task_id,attempt_id FROM video_production_slot").get()).toEqual({ task_id: h.taskId, attempt_id: "new-attempt" });
    expect(h.db.prepare("SELECT state FROM video_production_attempts WHERE attempt_id='new-attempt'").get()).toEqual({ state: "RUNNING" });
  });
});
