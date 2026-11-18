import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
vi.mock("../../config/runtime.ts", () => ({ CLI_WORKER_RUNTIME_MODE: "host", CLI_WORKER_CONTAINER_IMAGE: "" }));
import {
  probeWorkerIsolation,
  spawnIsolatedWorker,
  stageIsolatedWorkspace,
  inspectWorkerContainer,
  stopVerifiedWorkerContainer,
  workerContainerName,
  cleanupVerifiedWorkerWorkspace,
  invalidateWorkerIsolationProbe,
} from "./worker-isolation.ts";
const attempts: string[] = [];
afterEach(() => {
  attempts.splice(0).forEach(cleanupVerifiedWorkerWorkspace);
});
describe("host worker lifecycle", () => {
  it("verifies local readiness and owns the exact process through exit", async () => {
    invalidateWorkerIsolationProbe();
    const probe = probeWorkerIsolation();
    expect(probe).toMatchObject({ ready: true, phase4Ready: true, authoringReady: true });
    const attemptId = randomUUID();
    attempts.push(attemptId);
    const workspacePath = stageIsolatedWorkspace();
    const child = spawnIsolatedWorker({
      imageId: probe.immutableImageId!,
      attemptId,
      executorCommand: [],
      prompt: JSON.stringify({ invalid: true }),
      workspacePath,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    expect(
      inspectWorkerContainer(workerContainerName(attemptId), attemptId, probe.immutableImageId!, workspacePath),
    ).toEqual({ state: "exited", exitCode: 2, verified: true });
    expect(
      inspectWorkerContainer(
        workerContainerName(attemptId),
        attemptId,
        probe.immutableImageId!,
        workspacePath + "wrong",
      ).verified,
    ).toBe(false);
    expect(fs.existsSync(workspacePath)).toBe(true);
  }, 15000);
  it("cancels only a locally owned host process and rejects unknown/restarted ownership", async () => {
    const probe = probeWorkerIsolation();
    const attemptId = randomUUID();
    attempts.push(attemptId);
    const workspacePath = stageIsolatedWorkspace();
    const child = spawnIsolatedWorker({
      imageId: probe.immutableImageId!,
      attemptId,
      executorCommand: [],
      prompt: "",
      workspacePath,
      interactive: true,
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    expect(
      stopVerifiedWorkerContainer(workerContainerName(attemptId), attemptId, probe.immutableImageId!, workspacePath),
    ).toBe(true);
    await closed;
    expect(
      inspectWorkerContainer(workerContainerName(randomUUID()), randomUUID(), probe.immutableImageId!, workspacePath)
        .verified,
    ).toBe(false);
  }, 15000);
});
