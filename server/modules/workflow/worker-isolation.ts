import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI_WORKER_CONTAINER_IMAGE, CLI_WORKER_RUNTIME_MODE } from "../../config/runtime.ts";

export interface WorkerIsolationProbe {
  ready: boolean;
  reason: string;
  image?: string;
  dockerVersion?: string;
  immutableImageId?: string;
}

// Phase 1.1 deliberately ships no production CLI executor. Entries here must be
// server-owned argv arrays; request fields can never add a command.
export const CONTAINER_WORKER_EXECUTOR_REGISTRY: Readonly<Record<string, readonly string[]>> = Object.freeze({});

export function hasContainerWorkerExecutor(provider: string): boolean {
  return Boolean(CONTAINER_WORKER_EXECUTOR_REGISTRY[provider]?.length);
}

let cachedProbe: { expiresAt: number; value: WorkerIsolationProbe } | null = null;
const workspaceByAttempt = new Map<string, string>();

/**
 * A mode setting alone is not evidence of isolation. Require a live daemon and
 * inspect the exact image that the CLI launcher will use before permitting a
 * production CEO operation.
 */
export function probeWorkerIsolation(): WorkerIsolationProbe {
  if (cachedProbe && cachedProbe.expiresAt > Date.now()) return cachedProbe.value;
  const result = inspectWorkerIsolation();
  cachedProbe = { expiresAt: Date.now() + 30_000, value: result };
  return result;
}

function inspectWorkerIsolation(): WorkerIsolationProbe {
  if (CLI_WORKER_RUNTIME_MODE !== "container") {
    return { ready: false, reason: "worker_container_mode_not_configured" };
  }
  if (!CLI_WORKER_CONTAINER_IMAGE) {
    return { ready: false, reason: "worker_container_image_not_configured" };
  }
  if (!/^(?:[a-z0-9._/-]+@)?sha256:[a-f0-9]{64}$/i.test(CLI_WORKER_CONTAINER_IMAGE)) {
    return { ready: false, reason: "worker_image_digest_required" };
  }
  try {
    const dockerVersion = execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      encoding: "utf8",
      timeout: 2500,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!dockerVersion) return { ready: false, reason: "worker_container_daemon_unavailable" };
    const raw = execFileSync(
      "docker",
      ["image", "inspect", "--format", "{{json .}}", CLI_WORKER_CONTAINER_IMAGE],
      { encoding: "utf8", timeout: 2500, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const image = JSON.parse(raw) as {
      Id?: string;
      Config?: { User?: string; Env?: string[]; Volumes?: Record<string, unknown> | null; Labels?: Record<string, string> };
    };
    const config = image.Config ?? {};
    if (config.Labels?.["claw-empire.worker"] !== "v1") {
      return { ready: false, reason: "dedicated_worker_image_required" };
    }
    if (!config.User || config.User === "0" || config.User.startsWith("0:")) {
      return { ready: false, reason: "worker_image_not_non_root" };
    }
    const environmentKeys = (config.Env ?? []).map((entry) => entry.split("=", 1)[0]);
    if (environmentKeys.some((key) => /(?:API_AUTH|SESSION|INBOX|SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY)/i.test(key))) {
      return { ready: false, reason: "worker_image_contains_sensitive_environment" };
    }
    if (config.Volumes && Object.keys(config.Volumes).length > 0) {
      return { ready: false, reason: "worker_image_declares_unreviewed_volumes" };
    }
    const uid = Number(
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--pull=never",
          "--network",
          "none",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--pids-limit=32",
          "--memory=128m",
          "--entrypoint",
          "id",
          image.Id ?? CLI_WORKER_CONTAINER_IMAGE,
          "-u",
        ],
        { encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      ).trim(),
    );
    if (!Number.isInteger(uid) || uid <= 0) return { ready: false, reason: "worker_image_not_non_root" };
    if (!image.Id || !/^sha256:[a-f0-9]{64}$/i.test(image.Id)) {
      return { ready: false, reason: "worker_image_identity_unavailable" };
    }
    return {
      ready: true,
      reason: "worker_container_runtime_verified",
      image: CLI_WORKER_CONTAINER_IMAGE,
      immutableImageId: image.Id,
      dockerVersion,
    };
  } catch {
    return { ready: false, reason: "worker_container_runtime_unavailable" };
  }
}

/** Phase 1.1 intentionally provides no project files to the fake executor. */
export function stageIsolatedWorkspace(): string {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "claw-worker-"));
  try {
    fs.chmodSync(staging, 0o777);
  } catch {
    // Windows ACLs govern bind mount access; the runtime probe fails closed if
    // the non-root container cannot write the workspace.
  }
  return staging;
}

export function buildIsolatedDockerArgs(
  imageId: string,
  containerName: string,
  attemptId: string,
  stagingPath: string,
  command: readonly string[],
): string[] {
  return [
    "run",
    "--interactive",
    "--pull=never",
    "--name",
    containerName,
    "--label",
    `claw-empire.attempt-id=${attemptId}`,
    "--network",
    "none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=64",
    "--memory=512m",
    "--cpus=2",
    "--user=65532:65532",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m",
    "--env",
    "HOME=/tmp",
    "--env",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "--mount",
    `type=bind,source=${path.resolve(stagingPath)},target=/workspace`,
    "--workdir",
    "/workspace",
    imageId,
    ...command,
  ];
}

export function workerContainerName(attemptId: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(attemptId)) {
    throw new Error("invalid_execution_attempt_id");
  }
  return `claw-worker-${attemptId.replaceAll("-", "")}`;
}

export function spawnIsolatedWorker(input: {
  imageId: string;
  attemptId: string;
  executorCommand: readonly string[];
  prompt: string;
  workspacePath?: string;
}): ChildProcess {
  const stagingPath = input.workspacePath ?? stageIsolatedWorkspace();
  const name = workerContainerName(input.attemptId);
  if (!input.workspacePath) workspaceByAttempt.set(input.attemptId, stagingPath);
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    WINDIR: process.env.WINDIR,
  };
  const child = spawn("docker", buildIsolatedDockerArgs(input.imageId, name, input.attemptId, stagingPath, input.executorCommand), {
    env: safeEnv,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  });
  child.stdin?.end(input.prompt);
  return child;
}

export function inspectWorkerContainer(
  containerName: string,
  expectedAttemptId: string,
  expectedImageId: string,
): { state: "unknown" | "missing" | "running" | "exited"; exitCode?: number; verified: boolean } {
  try {
    const raw = execFileSync("docker", ["inspect", "--format", "{{json .}}", containerName], {
      encoding: "utf8",
      timeout: 2500,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const container = JSON.parse(raw) as {
      Image?: string;
      Config?: { Image?: string; User?: string; Env?: string[]; Labels?: Record<string, string> };
      HostConfig?: { NetworkMode?: string; ReadonlyRootfs?: boolean; CapDrop?: string[]; SecurityOpt?: string[]; Binds?: string[] | null };
      Mounts?: Array<{ Destination?: string; Type?: string; RW?: boolean; Source?: string }>;
      State?: { Status?: string; ExitCode?: number };
    };
    const mounts = container.Mounts ?? [];
    const verified =
      container.Image === expectedImageId &&
      container.Config?.Image === expectedImageId &&
      container.Config?.Labels?.["claw-empire.attempt-id"] === expectedAttemptId &&
      container.Config?.User === "65532:65532" &&
      !(container.Config.Env ?? []).some((entry) => /(?:API_AUTH|SESSION|INBOX|SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY)=/i.test(entry)) &&
      container.HostConfig?.NetworkMode === "none" &&
      container.HostConfig?.ReadonlyRootfs === true &&
      (container.HostConfig.CapDrop ?? []).includes("ALL") &&
      (container.HostConfig.SecurityOpt ?? []).some((entry) => entry === "no-new-privileges" || entry.startsWith("no-new-privileges:")) &&
      !(container.HostConfig.Binds ?? []).some((entry) => /docker\.sock|\\\.\pipe\\docker_engine/i.test(entry)) &&
      mounts.length === 1 &&
      mounts[0]?.Type === "bind" &&
      mounts[0]?.Destination === "/workspace" &&
      mounts[0]?.RW === true;
    if (!verified) return { state: "unknown", verified: false };
    const status = container.State?.Status;
    if (status === "running") return { state: "running", verified: true };
    if (status === "exited" && typeof container.State?.ExitCode === "number") {
      return { state: "exited", exitCode: container.State.ExitCode, verified: true };
    }
    return { state: "unknown", verified: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such object|not found/i.test(message)) {
      try {
        execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
          encoding: "utf8",
          timeout: 2500,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        });
        return { state: "missing", verified: true };
      } catch {
        return { state: "unknown", verified: false };
      }
    }
    return { state: "unknown", verified: false };
  }
}

/** Stop only the container whose persisted name, attempt label and image pass
 * the same strict inspection used by recovery; never target host PIDs. */
export function stopVerifiedWorkerContainer(
  containerName: string,
  expectedAttemptId: string,
  expectedImageId: string,
): boolean {
  if (containerName !== workerContainerName(expectedAttemptId)) return false;
  const before = inspectWorkerContainer(containerName, expectedAttemptId, expectedImageId);
  if (!before.verified) return false;
  if (before.state === "exited") return true;
  if (before.state !== "running") return false;
  try {
    execFileSync("docker", ["stop", "--time", "5", containerName], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return false;
  }
  const after = inspectWorkerContainer(containerName, expectedAttemptId, expectedImageId);
  return after.verified && after.state === "exited" && typeof after.exitCode === "number";
}

export function cleanupStagedWorkspace(stagingPath: string): void {
  fs.rmSync(stagingPath, { recursive: true, force: true });
}

/** Call only after inspecting this exact attempt's container as exited. */
export function cleanupVerifiedWorkerWorkspace(attemptId: string): void {
  const workspace = workspaceByAttempt.get(attemptId);
  if (!workspace) return;
  cleanupStagedWorkspace(workspace);
  workspaceByAttempt.delete(attemptId);
}

export function isWorkerIsolationReady(): boolean {
  return probeWorkerIsolation().ready;
}

export function invalidateWorkerIsolationProbe(): void {
  cachedProbe = null;
}
