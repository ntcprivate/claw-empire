import path from "node:path";

export function scrubWorkerEnv(source) {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) => !/^(API_AUTH_TOKEN|SESSION_AUTH_TOKEN|INBOX_WEBHOOK_SECRET|OAUTH_ENCRYPTION_SECRET)$/i.test(key),
    ),
  );
}
export const workerPaths = {
  host: process.env.CLAW_WORKER_HOST === "1",
  workspace: process.env.CLAW_WORKER_WORKSPACE || "/workspace",
  skillRoot: process.env.CLAW_WORKER_SKILL_ROOT || "/opt/skills/video-shotcraft",
  dependencies: process.env.CLAW_WORKER_DEPENDENCIES || "/opt/claw-empire/node_modules",
  moduleAnchor: process.env.CLAW_WORKER_MODULE_ANCHOR || "/opt/claw-empire/worker-runner.mjs",
  browser: process.env.CLAW_REMOTION_BROWSER || "/usr/bin/chromium",
};
export function compositorPackageName() {
  const platform =
    process.platform === "win32"
      ? "win32-x64-msvc"
      : process.platform === "linux"
        ? "linux-x64-gnu"
        : `darwin-${process.arch === "arm64" ? "arm64" : "x64"}`;
  return `@remotion/compositor-${platform}`;
}
export function mediaBinary(name) {
  return name + (process.platform === "win32" ? ".exe" : "");
}
