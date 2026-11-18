import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyBaseSchema } from "../bootstrap/schema/base-schema.ts";
import { ensureVideoProductionSchema } from "../bootstrap/schema/video-production-schema.ts";
import {
  beginVideoProductionCompletion,
  claimVideoProductionAttempt,
  decideVideoProduction,
  finishVideoProductionAttempt,
  finishVideoProductionExecutionPendingReview,
  ingestVideoProductionDirective,
  requireOwnedVideoProductionAttempt,
  setVideoProductionAttemptLaunchState,
} from "./video-production.ts";
import { cancelVideoProductionAttempt, launchVideoProductionAttempt, reconcileVideoProductionAttemptsAfterRestart, requestVideoProductionExecution, VideoProductionLaunchNotStartedError } from "./video-production-execution.ts";
import {
  inspectWorkerContainer,
  spawnIsolatedWorker,
  workerContainerName,
} from "./worker-isolation.ts";

const dbs: DatabaseSync[] = [];
const folders: string[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

function setup(db: DatabaseSync): string[] {
  db.exec("PRAGMA foreign_keys=ON");
  applyBaseSchema(db);
  ensureVideoProductionSchema(db);
  db.prepare("INSERT INTO departments(id,name,name_ko,icon,color) VALUES('operations','Operations','Operations','P','#000')").run();
  const projects: string[] = [];
  for (const name of ["one", "two"]) {
    const production = ingestVideoProductionDirective(db, {
      messageId: `directive-${name}`,
      content: `Create ${name}`,
      projectPath: path.resolve(os.tmpdir(), `video-production-${name}`),
      brief: {
        title: name,
        objective: "Explain",
        targetAudience: "Editors",
        duration: "60s",
        aspectRatio: "9:16",
        language: "English",
        style: "Documentary",
        deliveryPlatform: "Shorts",
        constraints: "",
      },
    });
    decideVideoProduction(db, production.project_id, { version: 1, decision: "approve" });
    const taskId = `supported-${name}`;
    db.prepare("INSERT INTO tasks(id,title,workflow_pack_key,project_id,status,assigned_agent_id) VALUES(?,?,'video_production',?,'inbox',?)")
      .run(taskId, name, production.project_id, production.manager_agent_id);
    db.prepare("UPDATE video_production_stages SET implemented=1,status='READY',task_id=? WHERE project_id=? AND stage_order=2")
      .run(taskId, production.project_id);
    projects.push(taskId);
  }
  return projects;
}

function localFakeWorker(): ReturnType<typeof spawn> {
  const cleanEnv = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR };
  const child = spawn(process.execPath, ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('local-fake-worker-complete\\n'))"], {
    env: cleanEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin?.end("fake local task");
  return child;
}

describe("durable production execution coordinator", () => {
  it("commits before launch, serializes attempts, and sends successful execution to artifact review", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "claw-prod-int-") );
    folders.push(folder);
    const file = path.join(folder, "state.sqlite");
    const db = new DatabaseSync(file);
    dbs.push(db);
    const [firstTask, secondTask] = setup(db);
    const observer = new DatabaseSync(file);
    dbs.push(observer);
    let firstAttempt = "";
    let spawnCount = 0;
    let completionCount = 0;
    const launched = launchVideoProductionAttempt({
      db,
      taskId: firstTask,
      agentId: "video_production-seed-5",
      launch(attemptId) {
        firstAttempt = attemptId;
        spawnCount++;
        expect(observer.prepare("SELECT status FROM tasks WHERE id=?").get(firstTask)).toEqual({ status: "in_progress" });
        expect(observer.prepare("SELECT attempt_id,task_id FROM video_production_slot").get()).toEqual({ attempt_id: attemptId, task_id: firstTask });
        expect(observer.prepare("SELECT state FROM video_production_attempts WHERE attempt_id=?").get(attemptId)).toEqual({ state: "LAUNCHING" });
        return localFakeWorker();
      },
      inspect: () => ({ state: "exited", exitCode: 0, verified: true }),
      complete(taskId, _code, attemptId) {
        completionCount++;
        expect(beginVideoProductionCompletion(db, taskId, attemptId)).toBe(true);
        expect(finishVideoProductionExecutionPendingReview(db, taskId, attemptId, { reason: "test_success_without_output_validator" })).toBe(true);
      },
      imageId: "sha256:test-image",
    });
    const secondSpawn = () => {
      spawnCount++;
      return localFakeWorker();
    };
    expect(() => launchVideoProductionAttempt({
      db: observer,
      taskId: secondTask,
      agentId: "video_production-seed-5",
      launch: secondSpawn,
      complete: () => undefined,
      inspect: () => ({ state: "exited", exitCode: 0, verified: true }),
      imageId: "sha256:test-image",
    })).toThrow("production_slot_busy");
    expect(spawnCount).toBe(1);
    await once(launched.child, "close");
    expect(completionCount).toBe(1);
    expect(requireOwnedVideoProductionAttempt(db, firstTask, firstAttempt)).toBe(false);
    expect(observer.prepare("SELECT task_id,attempt_id FROM video_production_slot").get()).toEqual({ task_id: null, attempt_id: null });
    expect(observer.prepare("SELECT status FROM tasks WHERE id=?").get(firstTask)).toEqual({ status: "review" });
    expect(observer.prepare("SELECT status FROM video_production_stages WHERE task_id=?").get(firstTask)).toEqual({ status: "BLOCKED" });
    expect(observer.prepare("SELECT state FROM video_production_attempts WHERE attempt_id=?").get(firstAttempt)).toEqual({ state: "COMPLETED" });
    expect(finishVideoProductionAttempt(db, firstTask, "00000000-0000-4000-8000-000000000000", "failed")).toBe(false);
  }, 20_000);

  it("marks a crash after durable intent for reconciliation and never retries/releases it", () => {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    const [taskId] = setup(db);
    const attemptId = "d85b1408-f45e-4859-a33c-6f4859bf6808";
    // Simulate the durable pre-spawn commit followed by a backend crash.
    claimVideoProductionAttempt(db, taskId, attemptId, "container_cli", "video_production-seed-5");
    setVideoProductionAttemptLaunchState(db, taskId, attemptId, "LAUNCHING", { workerIdentity: workerContainerName(attemptId) });
    db.prepare("UPDATE video_production_attempts SET state='RECONCILIATION_REQUIRED' WHERE attempt_id=?").run(attemptId);
    expect(requireOwnedVideoProductionAttempt(db, taskId, attemptId)).toBe(true);
    expect(db.prepare("SELECT task_id,attempt_id FROM video_production_slot").get()).toEqual({ task_id: taskId, attempt_id: attemptId });
    expect(() => launchVideoProductionAttempt({ db, taskId, agentId: "video_production-seed-5", launch: () => { throw new Error("must not launch"); }, complete: () => undefined })).toThrow();
  });

  it("records startup recovery and retains the slot when the stored worker identity is unknown", () => {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    const [taskId] = setup(db);
    const attemptId = "a0e75aa1-2681-4fe2-a22c-b4633049738f";
    const identity = workerContainerName(attemptId);
    claimVideoProductionAttempt(db, taskId, attemptId, "container_cli", "video_production-seed-5");
    expect(setVideoProductionAttemptLaunchState(db, taskId, attemptId, "LAUNCHING", { workerIdentity: identity, imageId: "sha256:test-image" })).toBe(true);
    const recovered = reconcileVideoProductionAttemptsAfterRestart(db, (name, token, image) => {
      expect([name, token, image]).toEqual([identity, attemptId, "sha256:test-image"]);
      return { state: "unknown", verified: false };
    });
    expect(recovered).toEqual([{ taskId, attemptId, state: "reconciliation_required" }]);
    expect(db.prepare("SELECT state FROM video_production_attempts WHERE attempt_id=?").get(attemptId)).toEqual({ state: "RECONCILIATION_REQUIRED" });
    expect(db.prepare("SELECT task_id,attempt_id FROM video_production_slot").get()).toEqual({ task_id: taskId, attempt_id: attemptId });
    expect(db.prepare("SELECT event FROM video_production_events WHERE event='execution_recovery_checked'").get()).toEqual({ event: "execution_recovery_checked" });
  });

  it("retains a verified live worker after restart without releasing its reservation", () => {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    const [taskId] = setup(db);
    const attemptId = "ce1bb887-6da9-4f53-a83f-49e5585a1197";
    const identity = workerContainerName(attemptId);
    claimVideoProductionAttempt(db, taskId, attemptId, "container_cli", "video_production-seed-5");
    expect(setVideoProductionAttemptLaunchState(db, taskId, attemptId, "LAUNCHING", { workerIdentity: identity, imageId: "sha256:test-image" })).toBe(true);
    expect(reconcileVideoProductionAttemptsAfterRestart(db, () => ({ state: "running", verified: true })))
      .toEqual([{ taskId, attemptId, state: "reconciliation_required" }]);
    expect(db.prepare("SELECT task_id,attempt_id FROM video_production_slot").get()).toEqual({ task_id: taskId, attempt_id: attemptId });
    expect(db.prepare("SELECT state FROM video_production_attempts WHERE attempt_id=?").get(attemptId)).toEqual({ state: "RECONCILIATION_REQUIRED" });
  });

  it("releases a verified successful process only to human review, without completing its stage", () => {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    const [taskId] = setup(db);
    const attemptId = "3f04bdba-d89e-4faf-a4d0-edeb8237d8f5";
    const identity = workerContainerName(attemptId);
    claimVideoProductionAttempt(db, taskId, attemptId, "container_cli", "video_production-seed-5");
    expect(setVideoProductionAttemptLaunchState(db, taskId, attemptId, "LAUNCHING", { workerIdentity: identity, imageId: "sha256:test-image" })).toBe(true);
    const recovered = reconcileVideoProductionAttemptsAfterRestart(db, () => ({ state: "exited", exitCode: 0, verified: true }));
    expect(recovered).toEqual([{ taskId, attemptId, state: "review_pending_artifact_validation" }]);
    expect(db.prepare("SELECT state FROM video_production_attempts WHERE attempt_id=?").get(attemptId)).toEqual({ state: "COMPLETED" });
    expect(db.prepare("SELECT status FROM video_production_stages WHERE task_id=?").get(taskId)).toEqual({ status: "BLOCKED" });
    expect(db.prepare("SELECT status FROM tasks WHERE id=?").get(taskId)).toEqual({ status: "review" });
    expect(db.prepare("SELECT task_id,attempt_id FROM video_production_slot").get()).toEqual({ task_id: null, attempt_id: null });
  });

  it("releases only a verified failed worker during startup recovery", () => {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    const [taskId] = setup(db);
    const attemptId = "6bba32d5-6809-47a1-a78d-a53d3b17f735";
    const identity = workerContainerName(attemptId);
    claimVideoProductionAttempt(db, taskId, attemptId, "container_cli", "video_production-seed-5");
    expect(setVideoProductionAttemptLaunchState(db, taskId, attemptId, "LAUNCHING", { workerIdentity: identity, imageId: "sha256:test-image" })).toBe(true);
    const recovered = reconcileVideoProductionAttemptsAfterRestart(db, () => ({ state: "exited", exitCode: 17, verified: true }));
    expect(recovered).toEqual([{ taskId, attemptId, state: "failed" }]);
    expect(db.prepare("SELECT state FROM video_production_attempts WHERE attempt_id=?").get(attemptId)).toEqual({ state: "FAILED" });
    expect(db.prepare("SELECT task_id,attempt_id FROM video_production_slot").get()).toEqual({ task_id: null, attempt_id: null });
    expect(db.prepare("SELECT status FROM tasks WHERE id=?").get(taskId)).toEqual({ status: "pending" });
  });

  it("rejects nested claims and failed claims before any worker is spawned", () => {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    const [taskId, otherTask] = setup(db);
    let spawnCount = 0;
    db.exec("BEGIN");
    expect(() => launchVideoProductionAttempt({
      db,
      taskId,
      agentId: "video_production-seed-5",
      launch: () => { spawnCount++; return localFakeWorker(); },
      complete: () => undefined,
      imageId: "sha256:test-image",
    })).toThrow("production_claim_requires_top_level_commit");
    db.exec("ROLLBACK");
    const attemptId = "1326fcb1-2bdf-4aa6-9024-90ab65a01514";
    claimVideoProductionAttempt(db, taskId, attemptId, "container_cli", "video_production-seed-5");
    expect(() => launchVideoProductionAttempt({
      db,
      taskId: otherTask,
      agentId: "video_production-seed-5",
      launch: () => { spawnCount++; return localFakeWorker(); },
      complete: () => undefined,
      imageId: "sha256:test-image",
    })).toThrow("production_slot_busy");
    expect(spawnCount).toBe(0);
  });

  it("records a proven pre-spawn rejection and releases only its own reservation", () => {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    const [taskId] = setup(db);
    expect(() => launchVideoProductionAttempt({
      db,
      taskId,
      agentId: "video_production-seed-5",
      launch: () => {
        throw new VideoProductionLaunchNotStartedError("executor rejected before process creation");
      },
      complete: () => undefined,
      imageId: "sha256:test-image",
    })).toThrow("executor rejected before process creation");
    expect(db.prepare("SELECT task_id,attempt_id FROM video_production_slot").get()).toEqual({ task_id: null, attempt_id: null });
    expect(db.prepare("SELECT state,detail_json FROM video_production_attempts WHERE task_id=?").get(taskId)).toMatchObject({
      state: "FAILED",
      detail_json: expect.stringContaining("worker_launch_rejected_before_spawn"),
    });
    expect(db.prepare("SELECT status FROM tasks WHERE id=?").get(taskId)).toEqual({ status: "pending" });
  });

  it("rejects a supplied executor identity that conflicts with the persisted task assignee", () => {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    const [taskId] = setup(db);
    expect(() => claimVideoProductionAttempt(db, taskId, undefined, "container_cli", "spoofed-agent"))
      .toThrow("production_assignee_identity_mismatch");
    expect(db.prepare("SELECT task_id,attempt_id FROM video_production_slot").get()).toEqual({ task_id: null, attempt_id: null });
    expect(db.prepare("SELECT status FROM tasks WHERE id=?").get(taskId)).toEqual({ status: "inbox" });
  });

  it("cancels only a verified owned attempt, is idempotent, and resumes through the shared claim", async () => {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    const [taskId] = setup(db);
    const firstAttempt = claimVideoProductionAttempt(db, taskId, "f4d70912-3f63-48fd-b47b-8aa520dad0e0", "container_cli", "video_production-seed-5");
    db.prepare("UPDATE agents SET status='working',current_task_id=? WHERE id='video_production-seed-5'").run(taskId);
    const firstIdentity = workerContainerName(firstAttempt);
    expect(setVideoProductionAttemptLaunchState(db, taskId, firstAttempt, "RUNNING", { workerIdentity: firstIdentity, imageId: "sha256:test-image" })).toBe(true);
    let stopCalls = 0;
    expect(cancelVideoProductionAttempt({ db, taskId, attemptId: firstAttempt, stop: (name, token, image) => {
      stopCalls++;
      expect([name, token, image]).toEqual([firstIdentity, firstAttempt, "sha256:test-image"]);
      return true;
    } })).toEqual({ cancelled: true, alreadyCancelled: false });
    expect(cancelVideoProductionAttempt({ db, taskId, attemptId: firstAttempt, stop: () => { stopCalls++; return false; } }))
      .toEqual({ cancelled: true, alreadyCancelled: true });
    expect(stopCalls).toBe(1);
    expect(db.prepare("SELECT status,current_task_id FROM agents WHERE id='video_production-seed-5'").get())
      .toEqual({ status: "idle", current_task_id: null });
    expect(() => cancelVideoProductionAttempt({ db, taskId, attemptId: "00000000-0000-4000-8000-000000000001", stop: () => true }))
      .toThrow("production_attempt_not_found");

    let launches = 0;
    expect(() => requestVideoProductionExecution({
      db, taskId, requesterAgentId: "spoofed-manager", executorAgentId: "video_production-seed-5",
      launch: () => { launches++; return localFakeWorker(); }, complete: () => undefined,
      imageId: "sha256:test-image", resumeFromAttemptId: firstAttempt,
    })).toThrow("production_manager_identity_mismatch");
    expect(launches).toBe(0);
    const resumed = requestVideoProductionExecution({
      db, taskId, requesterAgentId: "video_production-seed-5", executorAgentId: "video_production-seed-5",
      launch: () => { launches++; return localFakeWorker(); }, complete: () => undefined,
      inspect: () => ({ state: "unknown", verified: false }), imageId: "sha256:test-image", resumeFromAttemptId: firstAttempt,
    });
    expect(() => requestVideoProductionExecution({
      db, taskId, requesterAgentId: "video_production-seed-5", executorAgentId: "video_production-seed-5",
      launch: () => { launches++; return localFakeWorker(); }, complete: () => undefined,
      imageId: "sha256:test-image", resumeFromAttemptId: firstAttempt,
    })).toThrow("production_resume_snapshot_mismatch");
    expect(launches).toBe(1);
    await once(resumed.child, "close");
    expect(launches).toBe(1);
    expect(requireOwnedVideoProductionAttempt(db, taskId, resumed.attemptId)).toBe(true);
    expect(db.prepare("SELECT status FROM video_production_stages WHERE task_id=?").get(taskId)).toEqual({ status: "RUNNING" });
    expect(db.prepare("SELECT task_id,attempt_id FROM video_production_slot").get()).toEqual({ task_id: taskId, attempt_id: resumed.attemptId });
  });

  it("does not release an unresolved launch or let a late close complete a cancelled attempt", () => {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    const [taskId] = setup(db);
    let completeCount = 0;
    const child = new EventEmitter() as ChildProcess;
    const launched = launchVideoProductionAttempt({
      db, taskId, agentId: "video_production-seed-5", imageId: "sha256:test-image",
      launch: () => child,
      complete: () => { completeCount++; },
      inspect: () => ({ state: "exited", exitCode: 0, verified: true }),
    });
    expect(() => cancelVideoProductionAttempt({ db, taskId, attemptId: launched.attemptId, stop: () => false }))
      .toThrow("production_worker_stop_unverified");
    expect(db.prepare("SELECT task_id,attempt_id FROM video_production_slot").get()).toEqual({ task_id: taskId, attempt_id: launched.attemptId });
    expect(db.prepare("SELECT state FROM video_production_attempts WHERE attempt_id=?").get(launched.attemptId)).toEqual({ state: "RECONCILIATION_REQUIRED" });
    expect(cancelVideoProductionAttempt({ db, taskId, attemptId: launched.attemptId, stop: () => true }))
      .toEqual({ cancelled: true, alreadyCancelled: false });
    child.emit("close", 0);
    expect(completeCount).toBe(0);
    expect(db.prepare("SELECT status FROM tasks WHERE id=?").get(taskId)).toEqual({ status: "pending" });
    expect(db.prepare("SELECT task_id,attempt_id FROM video_production_slot").get()).toEqual({ task_id: null, attempt_id: null });
  });

  it("makes completion ownership one-shot and keeps a new attempt from stale release", () => {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    const [taskId] = setup(db);
    const oldAttempt = claimVideoProductionAttempt(db, taskId, "2270d6cb-911d-4957-89eb-707694de4034", "container_cli", "video_production-seed-5");
    expect(setVideoProductionAttemptLaunchState(db, taskId, oldAttempt, "RUNNING", { workerIdentity: "test-worker" })).toBe(true);
    expect(beginVideoProductionCompletion(db, taskId, oldAttempt)).toBe(true);
    expect(beginVideoProductionCompletion(db, taskId, oldAttempt)).toBe(false);
    expect(finishVideoProductionAttempt(db, taskId, oldAttempt, "failed", { exitCode: 1 })).toBe(true);
    expect(finishVideoProductionAttempt(db, taskId, oldAttempt, "failed", { exitCode: 1 })).toBe(false);
    db.prepare("UPDATE tasks SET status='inbox' WHERE id=?").run(taskId);
    db.prepare("UPDATE video_production_stages SET status='READY' WHERE task_id=? AND implemented=1").run(taskId);
    const newAttempt = claimVideoProductionAttempt(db, taskId, "3af6f4ec-b5e0-4bd4-9304-4ad13df2c43d", "container_cli", "video_production-seed-5");
    expect(finishVideoProductionAttempt(db, taskId, oldAttempt, "failed")).toBe(false);
    expect(requireOwnedVideoProductionAttempt(db, taskId, newAttempt)).toBe(true);
    expect(db.prepare("SELECT attempt_id FROM video_production_slot").get()).toEqual({ attempt_id: newAttempt });
  });

  it("retains the slot when launch throws after a worker may have been created", async () => {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    const [taskId] = setup(db);
    let launchedWorker: ReturnType<typeof spawn> | null = null;
    expect(() => launchVideoProductionAttempt({
      db,
      taskId,
      agentId: "video_production-seed-5",
      launch() {
        launchedWorker = localFakeWorker();
        throw new Error("adapter failed after creating worker");
      },
      complete: () => undefined,
      inspect: () => ({ state: "unknown", verified: false }),
      imageId: "sha256:test-image",
    })).toThrow("adapter failed after creating worker");
    await once(launchedWorker!, "close");
    const attempt = db.prepare("SELECT attempt_id,state FROM video_production_attempts WHERE task_id=?").get(taskId) as
      | { attempt_id: string; state: string }
      | undefined;
    expect(attempt?.state).toBe("RECONCILIATION_REQUIRED");
    expect(requireOwnedVideoProductionAttempt(db, taskId, attempt!.attempt_id)).toBe(true);
    expect(db.prepare("SELECT task_id,attempt_id FROM video_production_slot").get()).toEqual({ task_id: taskId, attempt_id: attempt?.attempt_id });
  });
});

let dockerImageId = "";
if (process.env.CLAW_RUN_DOCKER_TESTS === "1") {
  try {
    dockerImageId = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", "node:22-bookworm-slim"], {
      encoding: "utf8", timeout: 2500, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    dockerImageId = "";
  }
}

describe.skipIf(!dockerImageId)("isolated Docker fake worker", () => {
  it("runs the registered local fake command through the SQLite launch coordinator", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "claw-prod-docker-"));
    folders.push(folder);
    const dbFile = path.join(folder, "state.sqlite");
    const db = new DatabaseSync(dbFile);
    dbs.push(db);
    const [taskId] = setup(db);
    const observer = new DatabaseSync(dbFile);
    dbs.push(observer);
    const output: Buffer[] = [];
    let completionCount = 0;
    let containerName = "";
    const launched = launchVideoProductionAttempt({
      db,
      taskId,
      agentId: "video_production-seed-5",
      imageId: dockerImageId,
      launch(attemptId, workerIdentity) {
        containerName = workerIdentity;
        expect(observer.prepare("SELECT status FROM tasks WHERE id=?").get(taskId)).toEqual({ status: "in_progress" });
        expect(observer.prepare("SELECT attempt_id FROM video_production_attempts WHERE task_id=?").get(taskId)).toEqual({ attempt_id: attemptId });
        const child = spawnIsolatedWorker({
          imageId: dockerImageId,
          attemptId,
          executorCommand: ["node", "-e", "const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(String(process.getuid())+'\\n'+String(Object.keys(process.env).some(k=>/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY/i.test(k)))+'\\n'+String(fs.existsSync('/var/run/docker.sock'))+'\\n'+String(fs.existsSync('/root/.codex'))+'\\n'))"],
          prompt: "fake local task",
        });
        child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
        return child;
      },
      complete(task, _code, attempt) {
        completionCount++;
        expect(beginVideoProductionCompletion(db, task, attempt)).toBe(true);
        expect(finishVideoProductionExecutionPendingReview(db, task, attempt, { reason: "test_success_without_output_validator" })).toBe(true);
      },
    });
    expect(launched.workerIdentity).toBe(containerName);
    const [dockerClientExit] = await once(launched.child, "close") as [number | null];
    expect(dockerClientExit).toBe(0);
    expect(completionCount).toBe(1);
    expect(Buffer.concat(output).toString()).toContain("65532\nfalse\nfalse\nfalse");
    expect(inspectWorkerContainer(containerName, launched.attemptId, dockerImageId)).toEqual({ state: "exited", exitCode: 0, verified: true });
    const dockerState = JSON.parse(execFileSync("docker", ["inspect", "--format", "{{json .}}", containerName], { encoding: "utf8", timeout: 5000, windowsHide: true })) as {
      HostConfig: { NetworkMode: string; ReadonlyRootfs: boolean; Privileged: boolean; CapDrop: string[]; SecurityOpt: string[] };
      Mounts: Array<{ Type: string; Destination: string; Source: string }>;
      Config: { Env: string[] };
    };
    expect(dockerState.HostConfig).toMatchObject({ NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"] });
    expect(dockerState.HostConfig.SecurityOpt).toContain("no-new-privileges");
    expect(dockerState.Mounts).toHaveLength(1);
    expect(dockerState.Mounts[0]).toMatchObject({ Type: "bind", Destination: "/workspace" });
    expect(dockerState.Mounts[0].Source).toContain("claw-worker-");
    expect(dockerState.Config.Env?.some((entry) => /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY/i.test(entry))).toBe(false);
    expect(observer.prepare("SELECT state FROM video_production_attempts WHERE attempt_id=?").get(launched.attemptId)).toEqual({ state: "COMPLETED" });
    expect(observer.prepare("SELECT status FROM tasks WHERE id=?").get(taskId)).toEqual({ status: "review" });
    expect(observer.prepare("SELECT status FROM video_production_stages WHERE task_id=?").get(taskId)).toEqual({ status: "BLOCKED" });
    expect(observer.prepare("SELECT task_id,attempt_id FROM video_production_slot").get()).toEqual({ task_id: null, attempt_id: null });
    execFileSync("docker", ["rm", containerName], { stdio: "ignore", timeout: 5000, windowsHide: true });
  }, 30_000);
});
