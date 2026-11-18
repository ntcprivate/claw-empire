import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../bootstrap/schema/task-schema-migrations.ts";
import { ensureVideoProductionSchema } from "../bootstrap/schema/video-production-schema.ts";
import { createVideoProductionAutoRunner, resumeVideoProductionAutoRun } from "./video-production-auto-run.ts";
import { createNextVideoProductionStageJob } from "./video-production-dispatch.ts";
import * as dispatch from "./video-production-dispatch.ts";
import {
  claimVideoProductionAttempt,
  decideVideoProduction,
  finishVideoProductionAttempt,
  finishVideoProductionExecutionPendingReview,
  ingestVideoProductionDirective,
  setVideoProductionAttemptLaunchState,
  VideoProductionPolicyError,
} from "./video-production.ts";
import { grantVideoProductionProjectAgent, seedVideoProductionOrganization } from "./video-production-rbac.ts";
import { runHaruScreenplayJob } from "./video-production-stage-outputs.ts";
import { executeVideoProductionJob } from "./video-production-job-executor.ts";
import { createRunCompleteHandler } from "./orchestration/run-complete-handler.ts";
import * as workerIsolation from "./worker-isolation.ts";

const databases = new Set<DatabaseSync>();
const directories: string[] = [];
let sequence = 0;
const HARU = "video_production-role-screenwriter";
const RIAN = "video_production-role-director";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const db of databases) db.close();
  databases.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function database(filename = ":memory:") {
  const db = new DatabaseSync(filename);
  databases.add(db);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("BEGIN");
  applyBaseSchema(db);
  db.exec("COMMIT");
  applyTaskSchemaMigrations(db);
  db.exec("BEGIN");
  ensureVideoProductionSchema(db);
  for (const id of ["operations", "planning", "design", "dev", "qa", "devsecops"]) {
    db.prepare("INSERT OR IGNORE INTO departments(id,name,name_ko,icon,color) VALUES(?,?,?,'D','#777')").run(
      id,
      id,
      id,
    );
  }
  seedVideoProductionOrganization(db, "ceo_session");
  db.exec("COMMIT");
  return db;
}

function production(db: DatabaseSync, approve = true) {
  const id = ++sequence;
  const result = ingestVideoProductionDirective(db, {
    messageId: `auto-run-${id}`,
    content: "Produce a short garden story",
    projectPath: path.join(process.cwd(), `auto-run-fixture-${id}`),
    brief: {
      title: "Garden story",
      objective: "Tell a story",
      targetAudience: "Viewers",
      duration: "30s",
      aspectRatio: "16:9",
      language: "English",
      style: "Documentary",
      deliveryPlatform: "Web",
      constraints: "",
    },
  });
  for (const agentId of [result.manager_agent_id, HARU, RIAN]) {
    grantVideoProductionProjectAgent(db, {
      projectId: result.project_id,
      agentId,
      grantedBy: "ceo_session",
      ...(agentId === result.manager_agent_id ? { grantKey: "coordinator" as const } : {}),
    });
  }
  if (approve) decideVideoProduction(db, result.project_id, { version: 1, decision: "approve" });
  return result;
}

function deps(db: DatabaseSync) {
  return {
    db,
    activeProcesses: new Map(),
    appendTaskLog: vi.fn(),
    getNextHttpAgentPid: () => 1,
    broadcast: vi.fn(),
    startProgressTimer: vi.fn(),
    handleTaskRunComplete: vi.fn(),
    notifyCeo: vi.fn(),
  };
}

function runState(db: DatabaseSync, projectId: string) {
  return db
    .prepare("SELECT state,reason,task_id,jobs_started,plan_version FROM video_production_auto_runs WHERE project_id=?")
    .get(projectId);
}

function claim(db: DatabaseSync, taskId: string) {
  const job = db
    .prepare("SELECT assigned_agent_id,execution_action FROM video_production_stage_jobs WHERE task_id=?")
    .get(taskId) as { assigned_agent_id: string; execution_action: string };
  const attemptId = `auto-attempt-${++sequence}`;
  claimVideoProductionAttempt(
    db,
    taskId,
    attemptId,
    "phase4_provider_broker",
    job.assigned_agent_id,
    undefined,
    job.execution_action,
  );
  expect(setVideoProductionAttemptLaunchState(db, taskId, attemptId, "RUNNING")).toBe(true);
  db.prepare("UPDATE agents SET status='working',current_task_id=? WHERE id=?").run(taskId, job.assigned_agent_id);
  return attemptId;
}

describe("durable video production automatic continuation", () => {
  it("drives successive real stage executors from completion callbacks and stops on invalid provider output", async () => {
    const db = database();
    const p = production(db);
    db.prepare(
      "INSERT INTO api_providers(id,name,type,base_url,enabled) VALUES('automatic-provider','Fixture','custom','https://provider.example.test/v1',1)",
    ).run();
    db.prepare(
      "UPDATE agents SET api_provider_id='automatic-provider',api_model='fixture-model' WHERE id IN (?,?)",
    ).run(HARU, RIAN);
    vi.spyOn(workerIsolation, "isWorkerIsolationReady").mockReturnValue(true);
    vi.spyOn(workerIsolation, "probeWorkerIsolation").mockReturnValue({
      ready: true,
      phase4Ready: true,
      reason: "fixture_verified",
      immutableImageId: `sha256:${"a".repeat(64)}`,
    });
    const screenplay = {
      title: "Garden",
      logline: "A gardener opens a gate.",
      screenplay: "EXT. GARDEN - DAY\nThe gardener opens a gate.",
      scenes: [
        {
          sceneId: "automatic-garden",
          content: {
            description: "An open garden gate.",
            location: "Garden",
            characters: ["Gardener"],
            continuity: {},
          },
        },
      ],
    };
    const outputs: unknown[] = [
      screenplay,
      { decision: "approved", feedback: "The screenplay fits the brief." },
      { malformed: "shot specification" },
    ];
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(outputs.shift()) } }] }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const h = deps(db);
    const completion = createRunCompleteHandler({
      ...h,
      stopProgressTimer: vi.fn(),
      stopRequestedTasks: new Set(),
      stopRequestModeByTask: new Map(),
    }).handleTaskRunComplete;
    const runner = createVideoProductionAutoRunner(h, (taskId) => executeVideoProductionJob(h, taskId));
    h.handleTaskRunComplete.mockImplementation(
      (taskId: string, exitCode: number, attemptId?: string, completionClaimed?: boolean) => {
        completion(taskId, exitCode, attemptId, completionClaimed);
        runner.schedule();
      },
    );
    // Only the initial signal is explicit. Each subsequent job must be started
    // by the shared executor's completion callback, without per-stage drain calls.
    runner.schedule();
    await vi.waitFor(
      () =>
        expect(runState(db, p.project_id)).toMatchObject({
          state: "ERROR",
          reason: "production_attempt_failed",
          jobs_started: 3,
        }),
      { timeout: 5000 },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(h.handleTaskRunComplete.mock.calls.map((call) => call[1])).toEqual([0, 0, 1]);
    expect(
      db
        .prepare("SELECT execution_action,state FROM video_production_stage_jobs WHERE project_id=? ORDER BY rowid")
        .all(p.project_id),
    ).toEqual([
      { execution_action: "screenplay.write", state: "COMPLETED" },
      { execution_action: "creative.approve", state: "COMPLETED" },
      { execution_action: "shot_spec.write", state: "FAILED" },
    ]);
    expect(db.prepare("SELECT task_id,attempt_id FROM video_production_slot WHERE singleton=1").get()).toEqual({
      task_id: null,
      attempt_id: null,
    });
    expect(h.activeProcesses.size).toBe(0);
    await runner.drain();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(h.notifyCeo).toHaveBeenCalledTimes(1);
  });

  it("records automatic intent only after the CEO approves the exact plan", () => {
    const db = database();
    const p = production(db, false);
    expect(runState(db, p.project_id)).toBeUndefined();
    decideVideoProduction(db, p.project_id, { version: 1, decision: "approve" });
    expect(runState(db, p.project_id)).toEqual({
      state: "RUNNING",
      reason: null,
      task_id: null,
      jobs_started: 0,
      plan_version: 1,
    });
    decideVideoProduction(db, p.project_id, { version: 1, decision: "approve" });
    expect(runState(db, p.project_id)).toMatchObject({ jobs_started: 0 });
  });

  it("launches the first server-selected job once despite duplicate drains and scheduled signals", async () => {
    vi.useFakeTimers();
    const db = database();
    const p = production(db);
    const execute = vi.fn(async (taskId: string) => {
      claim(db, taskId);
      return { status: 202, body: { ok: true } };
    });
    const runner = createVideoProductionAutoRunner(deps(db), execute);
    runner.schedule();
    runner.schedule();
    await vi.runAllTimersAsync();
    await Promise.all([runner.drain(), runner.drain()]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare(
          "SELECT stage_key,execution_action,assigned_agent_id,state FROM video_production_stage_jobs WHERE task_id=?",
        )
        .get(execute.mock.calls[0][0]),
    ).toEqual({
      stage_key: "story_development",
      execution_action: "screenplay.write",
      assigned_agent_id: HARU,
      state: "RUNNING",
    });
    expect(runState(db, p.project_id)).toMatchObject({ state: "RUNNING", jobs_started: 1 });
  });

  it("continues to Rian's pinned review after the screenplay is validated and settled", async () => {
    const db = database();
    const p = production(db);
    db.prepare(
      "INSERT INTO api_providers(id,name,type,base_url,enabled) VALUES('auto-provider','Fixture','custom','https://provider.example.test/v1',1)",
    ).run();
    db.prepare("UPDATE agents SET api_provider_id='auto-provider',api_model='fixture-model' WHERE id=?").run(HARU);
    let attemptId = "";
    const execute = vi.fn(async (taskId: string) => {
      attemptId = claim(db, taskId);
      return { status: 202, body: { ok: true } };
    });
    const runner = createVideoProductionAutoRunner(deps(db), execute);
    await runner.drain();
    const taskId = execute.mock.calls[0][0];
    const output = {
      title: "Garden",
      logline: "A gardener opens a gate.",
      screenplay: "EXT. GARDEN - DAY\nThe gardener opens a gate.",
      scenes: [
        {
          sceneId: "garden-scene",
          content: {
            description: "An open garden gate.",
            location: "Garden",
            characters: ["Gardener"],
            continuity: {},
          },
        },
      ],
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), { status: 200 }),
    );
    const artifact = await runHaruScreenplayJob({ db, taskId, attemptId, fetchImpl });
    expect(finishVideoProductionExecutionPendingReview(db, taskId, attemptId)).toBe(true);
    db.prepare("UPDATE agents SET status='idle',current_task_id=NULL WHERE current_task_id=?").run(taskId);
    await runner.drain();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      db
        .prepare(
          "SELECT j.execution_action,j.assigned_agent_id,j.target_artifact_id,a.content_sha256 AS target_sha256 FROM video_production_stage_jobs j JOIN video_production_stage_artifacts a ON a.project_id=j.project_id AND a.artifact_id=j.target_artifact_id WHERE j.task_id=?",
        )
        .get(execute.mock.calls[1][0]),
    ).toEqual({
      execution_action: "creative.approve",
      assigned_agent_id: RIAN,
      target_artifact_id: artifact.artifactId,
      target_sha256: artifact.sha256,
    });
    expect(runState(db, p.project_id)).toMatchObject({ state: "RUNNING", jobs_started: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("queues other projects while the singleton slot is occupied", async () => {
    const db = database();
    const first = production(db);
    const second = production(db);
    db.prepare("UPDATE video_production_auto_runs SET updated_at=1 WHERE project_id=?").run(first.project_id);
    const execute = vi.fn(async (taskId: string) => {
      claim(db, taskId);
      return { status: 202, body: { ok: true } };
    });
    const runner = createVideoProductionAutoRunner(deps(db), execute);
    await runner.drain();
    await runner.drain();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runState(db, second.project_id)).toMatchObject({ state: "RUNNING", task_id: null, jobs_started: 0 });
    const taskId = execute.mock.calls[0][0];
    const attempt = db.prepare("SELECT attempt_id FROM video_production_slot WHERE singleton=1").get() as {
      attempt_id: string;
    };
    expect(finishVideoProductionAttempt(db, taskId, attempt.attempt_id, "failed")).toBe(true);
    db.prepare("UPDATE agents SET current_task_id=NULL,status='idle' WHERE current_task_id=?").run(taskId);
    await runner.drain();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(runState(db, first.project_id)).toMatchObject({ state: "ERROR", reason: "production_attempt_failed" });
    expect(runState(db, second.project_id)).toMatchObject({ state: "RUNNING", jobs_started: 1 });
  });

  it("stops after a launch error and never retries on duplicate completion signals", async () => {
    const db = database();
    const p = production(db);
    const h = deps(db);
    const execute = vi.fn(async () => ({ status: 503, body: { error: "requires_worker_isolation" } }));
    const runner = createVideoProductionAutoRunner(h, execute);
    await runner.drain();
    await runner.drain();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runState(db, p.project_id)).toMatchObject({ state: "ERROR", reason: "requires_worker_isolation" });
    expect(h.notifyCeo).toHaveBeenCalledTimes(1);
  });

  it("coalesces continuation signals received while an asynchronous launch is pending", async () => {
    const db = database();
    const p = production(db);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(async (taskId: string) => {
      await gate;
      claim(db, taskId);
      return { status: 202, body: { ok: true } };
    });
    const runner = createVideoProductionAutoRunner(deps(db), execute);
    const draining = runner.drain();
    expect(execute).toHaveBeenCalledTimes(1);
    runner.schedule();
    runner.schedule();
    await runner.drain();
    release();
    await draining;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runState(db, p.project_id)).toMatchObject({ state: "RUNNING", jobs_started: 1 });
  });

  it("bounds automatic revision loops instead of launching beyond the production budget", async () => {
    const db = database();
    const p = production(db);
    db.prepare("UPDATE video_production_auto_runs SET jobs_started=1000 WHERE project_id=?").run(p.project_id);
    const execute = vi.fn(async () => ({ status: 202, body: { ok: true } }));
    const runner = createVideoProductionAutoRunner(deps(db), execute);
    await runner.drain();
    expect(execute).not.toHaveBeenCalled();
    expect(runState(db, p.project_id)).toMatchObject({
      state: "ERROR",
      reason: "production_auto_run_job_limit",
      jobs_started: 1000,
    });
  });

  it("stops on paused attempts and ignores stale failure callbacks without consuming a new job", async () => {
    const db = database();
    const p = production(db);
    const execute = vi.fn(async (taskId: string) => {
      claim(db, taskId);
      return { status: 202, body: { ok: true } };
    });
    const runner = createVideoProductionAutoRunner(deps(db), execute);
    await runner.drain();
    db.exec(
      "UPDATE video_production_attempts SET state='PAUSED'; UPDATE video_production_slot SET task_id=NULL,attempt_id=NULL,acquired_at=NULL WHERE singleton=1",
    );
    await runner.drain();
    const oldAttempt = db
      .prepare("SELECT attempt_id FROM video_production_attempts WHERE task_id=?")
      .get(execute.mock.calls[0][0]) as { attempt_id: string };
    const completion = createRunCompleteHandler({
      ...deps(db),
      stopProgressTimer: vi.fn(),
      stopRequestedTasks: new Set(),
      stopRequestModeByTask: new Map(),
    }).handleTaskRunComplete;
    completion(execute.mock.calls[0][0], 1, oldAttempt.attempt_id);
    await runner.drain();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runState(db, p.project_id)).toMatchObject({
      state: "PAUSED",
      reason: "production_attempt_paused",
      jobs_started: 1,
    });
  });

  it("waits for CEO approval when the approved plan becomes stale", async () => {
    const db = database();
    const p = production(db);
    db.prepare(
      "UPDATE video_productions SET plan_version=2,approved_version=NULL,state='WAITING_FOR_APPROVAL' WHERE project_id=?",
    ).run(p.project_id);
    const h = deps(db);
    const execute = vi.fn(async () => ({ status: 202, body: { ok: true } }));
    const runner = createVideoProductionAutoRunner(h, execute);
    await runner.drain();
    await runner.drain();
    expect(execute).not.toHaveBeenCalled();
    expect(runState(db, p.project_id)).toMatchObject({
      state: "WAITING_CEO",
      reason: "production_approval_required",
      jobs_started: 0,
    });
    expect(h.notifyCeo).toHaveBeenCalledTimes(1);
  });

  it("stops at the final CEO release checkpoint without retrying or launching another job", async () => {
    const db = database();
    const p = production(db);
    const select = vi.spyOn(dispatch, "createNextVideoProductionStageJob").mockImplementation(() => {
      throw new VideoProductionPolicyError("awaiting_ceo_final_release");
    });
    const h = deps(db);
    const execute = vi.fn(async () => ({ status: 202, body: { ok: true } }));
    const runner = createVideoProductionAutoRunner(h, execute);
    await runner.drain();
    await runner.drain();
    expect(runState(db, p.project_id)).toMatchObject({
      state: "WAITING_CEO",
      reason: "awaiting_ceo_final_release",
      jobs_started: 0,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(1);
    expect(h.notifyCeo).toHaveBeenCalledTimes(1);
  });

  it("stops when reconciliation is required and retains the owned slot without launching again", async () => {
    const db = database();
    const p = production(db);
    const execute = vi.fn(async (taskId: string) => {
      claim(db, taskId);
      return { status: 202, body: { ok: true } };
    });
    const runner = createVideoProductionAutoRunner(deps(db), execute);
    await runner.drain();
    db.prepare("UPDATE video_production_attempts SET state='RECONCILIATION_REQUIRED' WHERE task_id=?").run(
      execute.mock.calls[0][0],
    );
    await runner.drain();
    await runner.drain();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runState(db, p.project_id)).toMatchObject({
      state: "ERROR",
      reason: "production_attempt_reconciliation_required",
      jobs_started: 1,
    });
    expect(db.prepare("SELECT task_id FROM video_production_slot WHERE singleton=1").get()).toEqual({
      task_id: execute.mock.calls[0][0],
    });
  });

  it("restores durable selection after SQLite reopens and launches the existing READY job once", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "claw-auto-run-"));
    directories.push(directory);
    const filename = path.join(directory, "studio.sqlite");
    let db = database(filename);
    const p = production(db);
    const selected = createNextVideoProductionStageJob(db, p.project_id, p.manager_agent_id);
    db.prepare("UPDATE video_production_auto_runs SET task_id=? WHERE project_id=?").run(selected.taskId, p.project_id);
    databases.delete(db);
    db.close();
    db = new DatabaseSync(filename);
    databases.add(db);
    db.exec("PRAGMA foreign_keys=ON");
    ensureVideoProductionSchema(db);
    const execute = vi.fn(async (taskId: string) => {
      claim(db, taskId);
      return { status: 202, body: { ok: true } };
    });
    const runner = createVideoProductionAutoRunner(deps(db), execute);
    await runner.drain();
    await runner.drain();
    expect(execute).toHaveBeenCalledExactlyOnceWith(selected.taskId);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM video_production_stage_jobs WHERE project_id=?").get(p.project_id),
    ).toEqual({ count: 1 });
    expect(runState(db, p.project_id)).toMatchObject({ state: "RUNNING", jobs_started: 1 });
  }, 30000);

  it("resumes explicit CEO runs only against the current approved job binding", () => {
    const db = database();
    const p = production(db);
    const selected = createNextVideoProductionStageJob(db, p.project_id, p.manager_agent_id);
    db.prepare("UPDATE video_production_auto_runs SET state='ERROR',reason='launch_failed' WHERE project_id=?").run(
      p.project_id,
    );
    resumeVideoProductionAutoRun(db, selected.taskId);
    expect(runState(db, p.project_id)).toMatchObject({ state: "RUNNING", reason: null, task_id: selected.taskId });
    db.prepare("UPDATE video_production_auto_runs SET state='ERROR' WHERE project_id=?").run(p.project_id);
    db.prepare("UPDATE video_productions SET approved_version=NULL WHERE project_id=?").run(p.project_id);
    resumeVideoProductionAutoRun(db, selected.taskId);
    expect(runState(db, p.project_id)).toMatchObject({ state: "ERROR" });
  });
});
