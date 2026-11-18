import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI_WORKER_CONTAINER_IMAGE, CLI_WORKER_RUNTIME_MODE } from "../../config/runtime.ts";
import { resolveVideoHostRuntime, scrubVideoHostEnv } from "./video-production-host.ts";

export interface WorkerIsolationProbe {
  ready: boolean;
  phase4Ready?: boolean;
  authoringReady?: boolean;
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
const hostWorkers = new Map<string, { child: ChildProcess; image: string; workspace: string; exitCode?: number }>();

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
  if (CLI_WORKER_RUNTIME_MODE === "host") {
    try {
      const runtime = resolveVideoHostRuntime();
      return { ready: true, phase4Ready: true, authoringReady: true, immutableImageId: runtime.identity, reason: "host_runtime_verified" };
    } catch (error) { return { ready: false, reason: error instanceof Error ? error.message : "host_runtime_unavailable" }; }
  }
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
      Config?: { User?: string; Env?: string[]; Volumes?: Record<string, unknown> | null; Labels?: Record<string, string>; Entrypoint?: string[] | null };
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
      authoringReady: config.Labels?.["claw-empire.worker-authoring"] === "shotcraft-v1",
      reason: "worker_container_runtime_verified",
      phase4Ready: config.Labels?.["claw-empire.worker-protocol"] === "phase4-v1" &&
        config.Labels?.["claw-empire.worker-runner"] === "remotion-shot-v1" &&
        (config.Entrypoint ?? []).includes("/opt/claw-empire/worker-runner.mjs"),
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

export function registerWorkerWorkspaceForAttempt(attemptId: string, workspacePath: string): void {
  workspaceByAttempt.set(attemptId, path.resolve(workspacePath));
}

export function buildIsolatedDockerArgs(
  imageId: string,
  containerName: string,
  attemptId: string,
  stagingPath: string,
  command: readonly string[],
  profile: "default" | "production_render" = "default",
): string[] {
  const render = profile === "production_render";
  return [
    "run",
    "--interactive",
    "--pull=never",
    "--name",
    containerName,
    "--label",
    `claw-empire.attempt-id=${attemptId}`,
    "--label",
    "claw-empire.worker-protocol=phase4-v1",
    "--network",
    "none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--pids-limit=${render ? 256 : 64}`,
    `--memory=${render ? "2g" : "512m"}`,
    `--cpus=${render ? 4 : 2}`,
    "--user=65532:65532",
    "--tmpfs",
    render ? "/tmp:rw,nosuid,nodev,size=256m" : "/tmp:rw,nosuid,nodev,size=64m",
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
  profile?: "default" | "production_render";
  interactive?: boolean;
}): ChildProcess {
  const stagingPath = input.workspacePath ?? stageIsolatedWorkspace();
  const name = workerContainerName(input.attemptId);
  workspaceByAttempt.set(input.attemptId, stagingPath);
  if (CLI_WORKER_RUNTIME_MODE === "host") {
    const runtime = resolveVideoHostRuntime();
    if (runtime.identity !== input.imageId || input.executorCommand.length) throw new Error("host_worker_identity_mismatch");
    const child = spawn(process.execPath, [runtime.runner], { cwd: stagingPath, shell: false, windowsHide: true,
      env: { ...scrubVideoHostEnv(), CLAW_WORKER_HOST: "1", CLAW_WORKER_WORKSPACE: stagingPath, CLAW_WORKER_MODULE_ANCHOR: runtime.anchor, CLAW_WORKER_DEPENDENCIES: runtime.dependencies, CLAW_WORKER_SKILL_ROOT: runtime.skillRoot, CLAW_REMOTION_BROWSER: runtime.browser }, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const record = { child, image: input.imageId, workspace: path.resolve(stagingPath), exitCode: undefined as number | undefined };
    hostWorkers.set(input.attemptId, record);
    child.once("close", (code) => { record.exitCode = code ?? 1; });
    if (input.interactive) child.stdin?.write(`${input.prompt}\n`); else child.stdin?.end(input.prompt);
    return child;
  }
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    WINDIR: process.env.WINDIR,
  };
  const child = spawn("docker", buildIsolatedDockerArgs(input.imageId, name, input.attemptId, stagingPath, input.executorCommand, input.profile), {
    env: safeEnv,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  });
  if (input.interactive) child.stdin?.write(`${input.prompt}\n`);
  else child.stdin?.end(input.prompt);
  return child;
}

export function inspectWorkerContainer(
  containerName: string,
  expectedAttemptId: string,
  expectedImageId: string,
  expectedWorkspacePath?: string,
  expectedProtocol?: "phase4-v1",
): { state: "unknown" | "missing" | "running" | "exited"; exitCode?: number; verified: boolean } {
  if (expectedImageId.startsWith("host:")) {
    const record = hostWorkers.get(expectedAttemptId);
    if (!record || containerName !== workerContainerName(expectedAttemptId) || record.image !== expectedImageId || (expectedWorkspacePath && record.workspace !== path.resolve(expectedWorkspacePath))) return { state: "unknown", verified: false };
    return record.exitCode === undefined ? { state: "running", verified: true } : { state: "exited", exitCode: record.exitCode, verified: true };
  }
  try {
    const raw = execFileSync("docker", ["inspect", "--format", "{{json .}}", containerName], {
      encoding: "utf8",
      timeout: 2500,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const container = JSON.parse(raw) as {
      Image?: string;
      Config?: { Image?: string; User?: string; Env?: string[]; Labels?: Record<string, string>; Entrypoint?: string[] | null };
      HostConfig?: { NetworkMode?: string; ReadonlyRootfs?: boolean; CapDrop?: string[]; SecurityOpt?: string[]; Binds?: string[] | null };
      Mounts?: Array<{ Destination?: string; Type?: string; RW?: boolean; Source?: string }>;
      State?: { Status?: string; ExitCode?: number };
    };
    const mounts = container.Mounts ?? [];
    const verified =
      container.Image === expectedImageId &&
      container.Config?.Image === expectedImageId &&
      container.Config?.Labels?.["claw-empire.attempt-id"] === expectedAttemptId &&
      (!expectedProtocol || (container.Config?.Labels?.["claw-empire.worker-protocol"] === expectedProtocol &&
        container.Config?.Labels?.["claw-empire.worker-runner"] === "remotion-shot-v1" &&
        (container.Config?.Entrypoint ?? []).includes("/opt/claw-empire/worker-runner.mjs"))) &&
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
      mounts[0]?.RW === true &&
      (!expectedWorkspacePath || path.resolve(mounts[0]?.Source ?? "") === path.resolve(expectedWorkspacePath));
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
  expectedWorkspacePath?: string,
  expectedProtocol?: "phase4-v1",
): boolean {
  if (containerName !== workerContainerName(expectedAttemptId)) return false;
  const before = inspectWorkerContainer(containerName, expectedAttemptId, expectedImageId, expectedWorkspacePath, expectedProtocol);
  if (!before.verified) return false;
  if (before.state === "exited") return true;
  if (before.state !== "running") return false;
  if (expectedImageId.startsWith("host:")) {
    const record = hostWorkers.get(expectedAttemptId)!;
    // Target only the process tree created for this attempt, never a recovered PID.
    if (process.platform === "win32" && record.child.pid) {
      try { execFileSync("taskkill", ["/PID", String(record.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { return false; }
    } else if (record.child.pid) {
      try { process.kill(-record.child.pid, "SIGTERM"); } catch { return false; }
    }
    if (!record.child.pid) return false;
    for (let check = 0; check < 100; check++) {
      try { process.kill(record.child.pid, 0); }
      catch { record.exitCode = 143; return true; }
      if (process.platform !== "win32") {
        try {
          const state = execFileSync("ps", ["-o", "stat=", "-p", String(record.child.pid)], { encoding: "utf8", timeout: 1000 }).trim();
          if (!state || state.startsWith("Z")) { record.exitCode = 143; return true; }
        } catch { /* Retain ownership unless exit is confirmed. */ }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    return false;
  }
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
  const after = inspectWorkerContainer(containerName, expectedAttemptId, expectedImageId, expectedWorkspacePath, expectedProtocol);
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
  hostWorkers.delete(attemptId);
}

/** Restart recovery variant; call only after inspecting the exact owned container as exited. */
export function cleanupVerifiedWorkerWorkspacePath(workspacePath: string): boolean {
  try {
    const absolute = path.resolve(workspacePath);
    if (path.basename(absolute).startsWith("claw-worker-") === false) return false;
    const parent = path.resolve(path.dirname(absolute));
    if (parent.toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase()) return false;
    const info = fs.lstatSync(absolute);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const canonical = fs.realpathSync(absolute);
    if (path.resolve(canonical) !== absolute) return false;
    fs.rmSync(absolute, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Workspace is retained while a verified worker result is being validated/imported. */
export function getWorkerWorkspaceForAttempt(attemptId: string): string | undefined {
  return workspaceByAttempt.get(attemptId);
}

export function isWorkerIsolationReady(): boolean {
  return probeWorkerIsolation().ready;
}

export function invalidateWorkerIsolationProbe(): void {
  cachedProbe = null;
}
