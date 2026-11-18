import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeVideoProductionJob } from "./video-production-job-executor.ts";
import * as isolation from "./worker-isolation.ts";
import * as execution from "./video-production-execution.ts";
import * as session from "./video-production-miro-session.ts";

vi.mock("./video-production.ts", async (original) => ({
  ...(await original<any>()),
  assertVideoProductionTaskAdmission: vi.fn(),
  setVideoProductionAttemptLaunchState: vi.fn(() => true),
  markVideoProductionAttemptReconciliationRequired: vi.fn(),
}));
vi.mock("./video-production-stage-runner.ts", () => ({
  buildMiroWorkerRequest: vi.fn(async () => JSON.stringify({ operation: "render-shot", shot: { shotId: "one" } })),
  importMiroWorkerOutput: vi.fn(),
}));
vi.mock("./video-production-provider-broker.ts", () => ({ getVideoProductionAgentProvider: vi.fn(() => ({})) }));
vi.mock("./video-production-miro-session.ts", () => ({ runMiroAuthoringSession: vi.fn(async () => ({ turns: 2 })) }));
vi.mock("./worker-isolation.ts", () => ({
  isWorkerIsolationReady: vi.fn(() => true),
  probeWorkerIsolation: vi.fn(),
  spawnIsolatedWorker: vi.fn(),
  stopVerifiedWorkerContainer: vi.fn(() => true),
  getWorkerWorkspaceForAttempt: vi.fn(() => "/fixture/attempt"),
}));
vi.mock("./video-production-execution.ts", async (original) => ({
  ...(await original<any>()),
  requestVideoProductionExecution: vi.fn(),
}));

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 123,
  });
  vi.mocked(isolation.spawnIsolatedWorker).mockReturnValue(child as any);
  vi.mocked(isolation.probeWorkerIsolation).mockReturnValue({
    ready: true,
    phase4Ready: true,
    authoringReady: true,
    immutableImageId: `sha256:${"a".repeat(64)}`,
    reason: "fixture",
  });
  vi.mocked(execution.requestVideoProductionExecution).mockImplementation((input) => ({
    attemptId: input.attemptId!,
    workerIdentity: "fixture-worker",
    child: input.launch(input.attemptId!, "fixture-worker", "/fixture/attempt"),
  }));
  const run = vi.fn(() => ({ changes: 1 }));
  const db = {
    prepare: (sql: string) => ({
      run,
      get: () =>
        sql.includes("SELECT * FROM tasks")
          ? { id: "task", title: "Shot", assigned_agent_id: "miro", status: "inbox" }
          : {
              project_id: "project",
              stage_key: "ai_footage_production",
              execution_action: "footage.submit",
              assigned_agent_id: "miro",
              manager_agent_id: "dami",
              state: "READY",
            },
    }),
  };
  return {
    child,
    run,
    deps: {
      db,
      activeProcesses: new Map(),
      appendTaskLog: vi.fn(),
      getNextHttpAgentPid: () => 1,
      broadcast: vi.fn(),
      startProgressTimer: vi.fn(),
      handleTaskRunComplete: vi.fn(),
    } as any,
  };
}

describe("Miro authoring executor integration", () => {
  beforeEach(() => vi.clearAllMocks());
  it("uses interactive author-shot and starts the model session on the same owned attempt", async () => {
    const h = fixture();
    const result = await executeVideoProductionJob(h.deps, "task");
    expect(result.status).toBe(200);
    const spawn = vi.mocked(isolation.spawnIsolatedWorker).mock.calls[0][0];
    expect(spawn.interactive).toBe(true);
    expect(JSON.parse(spawn.prompt).operation).toBe("author-shot");
    expect(session.runMiroAuthoringSession).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task", attemptId: spawn.attemptId, child: h.child }),
    );
    expect(h.run).toHaveBeenCalledWith(spawn.attemptId, "task");
    expect(h.deps.handleTaskRunComplete).not.toHaveBeenCalled();
  });
  it("rejects old images before launching or making a model call", async () => {
    const h = fixture();
    vi.mocked(isolation.probeWorkerIsolation).mockReturnValue({
      ready: true,
      phase4Ready: true,
      reason: "legacy",
      immutableImageId: `sha256:${"a".repeat(64)}`,
    });
    expect((await executeVideoProductionJob(h.deps, "task")).body.error).toBe("shotcraft_worker_not_verified");
    expect(isolation.spawnIsolatedWorker).not.toHaveBeenCalled();
    expect(session.runMiroAuthoringSession).not.toHaveBeenCalled();
  });
  it("stops only the verified attempt container on session failure without claiming completion", async () => {
    const h = fixture();
    vi.mocked(session.runMiroAuthoringSession).mockRejectedValueOnce(new Error("turn limit"));
    await executeVideoProductionJob(h.deps, "task");
    await vi.waitFor(() => expect(isolation.stopVerifiedWorkerContainer).toHaveBeenCalled());
    expect(isolation.stopVerifiedWorkerContainer).toHaveBeenCalledWith(
      "fixture-worker",
      expect.any(String),
      expect.stringContaining("sha256:"),
      "/fixture/attempt",
      "phase4-v1",
    );
    expect(h.deps.handleTaskRunComplete).not.toHaveBeenCalled();
  });
});
