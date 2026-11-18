import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const HOST_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export function scrubVideoHostEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) => !/^(API_AUTH_TOKEN|SESSION_AUTH_TOKEN|INBOX_WEBHOOK_SECRET|OAUTH_ENCRYPTION_SECRET)$/i.test(key),
    ),
  );
}
export function resolveVideoHostRuntime() {
  const anchor = path.join(HOST_ROOT, "package.json");
  const require = createRequire(anchor);
  require.resolve("@remotion/cli/package.json");
  const candidates = [
    process.env.CLAW_REMOTION_BROWSER,
    ...[process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
      .filter(Boolean)
      .flatMap((root) => [
        path.join(root!, "Google/Chrome/Application/chrome.exe"),
        path.join(root!, "Microsoft/Edge/Application/msedge.exe"),
      ]),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/microsoft-edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  const browser = candidates.find((file): file is string => Boolean(file && fs.existsSync(file)));
  if (!browser) throw new Error("host_browser_unavailable");
  let skillRoot = process.env.CLAW_SHOTCRAFT_ROOT || path.join(HOST_ROOT, "tools/video-shotcraft");
  if (!fs.existsSync(path.join(skillRoot, "SKILL.md"))) {
    skillRoot = path.join(os.homedir(), ".cache/claw-empire/shotcraft-55eb60d155d703b0267a46a0507f6e268a053ad1");
    if (!fs.existsSync(path.join(skillRoot, "SKILL.md"))) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "claw-shotcraft-install-"));
      const archive = path.join(scratch, "source.tar.gz");
      try {
        execFileSync(
          process.platform === "win32" ? "curl.exe" : "curl",
          [
            "--fail",
            "--location",
            "--max-time",
            "120",
            "--output",
            archive,
            "https://codeload.github.com/Vincentwei1021/video-shotcraft/tar.gz/55eb60d155d703b0267a46a0507f6e268a053ad1",
          ],
          { env: scrubVideoHostEnv(), windowsHide: true, timeout: 130000, stdio: "ignore" },
        );
        if (
          createHash("sha256").update(fs.readFileSync(archive)).digest("hex") !==
          "3b09abdbe2e2cb34400c0bc9aeca6f34cbfa0f4730afcb137b9e8704c9922cd1"
        )
          throw new Error("shotcraft_checksum_mismatch");
        const extracted = path.join(scratch, "skill");
        fs.mkdirSync(extracted);
        execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", extracted], {
          windowsHide: true,
          timeout: 30000,
          stdio: "ignore",
        });
        fs.mkdirSync(path.dirname(skillRoot), { recursive: true });
        try {
          fs.renameSync(extracted, skillRoot);
        } catch (error) {
          if (!fs.existsSync(path.join(skillRoot, "SKILL.md"))) throw error;
        }
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    }
  }
  for (const relative of ["SKILL.md", "assets/lib", "demos/_fixtures"])
    if (!fs.existsSync(path.join(skillRoot, relative))) throw new Error("host_shotcraft_incomplete");
  const runner = path.join(HOST_ROOT, "deploy/worker/worker-runner.mjs");
  const identityHash = createHash("sha256");
  for (const file of [runner, path.join(HOST_ROOT, "deploy/worker/authoring-tools.mjs"), path.join(HOST_ROOT, "deploy/worker/worker-platform.mjs")]) identityHash.update(fs.readFileSync(file));
  const identity = "host:" + identityHash.digest("hex");
  return { runner, browser, skillRoot, anchor, dependencies: path.join(HOST_ROOT, "node_modules"), identity };
}
