import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localMediaBinaryPath, renderTrustedVideoTimeline, resolveLocalRemotionTools, sampleVideoFrames } from "./video-production-media.ts";

const scratch: string[] = [];
let localRenderAvailable = false;
try {
  const tools = resolveLocalRemotionTools();
  localRenderAvailable = fsSync.existsSync(localMediaBinaryPath(tools.binariesDirectory, "ffmpeg")) && fsSync.existsSync(tools.browserExecutable);
} catch {
  localRenderAvailable = false;
}
afterEach(async () => {
  for (const dir of scratch.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe.skipIf(!localRenderAvailable)("trusted local Remotion media pipeline", () => {
  it("renders a local fixture with audio and verifies metadata plus full decode", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claw-phase4-render-"));
    scratch.push(dir);
    const publicDir = path.join(dir, "public");
    await fs.mkdir(publicDir);
    const tools = resolveLocalRemotionTools();
    const ffmpeg = localMediaBinaryPath(tools.binariesDirectory, "ffmpeg");
    const tone = path.join(publicDir, "fixture.wav");
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ar", "48000", "-ac", "2", tone], {
      windowsHide: true, timeout: 30_000, stdio: ["ignore", "ignore", "pipe"],
    });
    const shot = await renderTrustedVideoTimeline({
      workspacePath: dir,
      approvedAssetRoot: publicDir,
      shots: [{ shotId: "fixture-shot", title: "Offline fixture", action: "Local deterministic animation", durationFrames: 60 }],
      fps: 30, width: 320, height: 180, outputName: "shot.mp4",
    });
    const approvedClip = path.join(publicDir, "approved-shot.mp4");
    await fs.copyFile(shot.outputPath, approvedClip);
    const frames = await sampleVideoFrames(approvedClip, shot.probe.durationSeconds);
    expect(frames).toHaveLength(3);
    expect(frames.every((frame) => frame.mimeType === "image/jpeg" && Buffer.from(frame.data, "base64").length > 128)).toBe(true);
    const rendered = await renderTrustedVideoTimeline({
      workspacePath: dir,
      approvedAssetRoot: publicDir,
      shots: [{ shotId: "fixture-shot", title: "Offline fixture", action: "Uses the exact approved clip", durationFrames: 60, videoPath: approvedClip }],
      fps: 30, width: 320, height: 180, audioPath: tone, outputName: "fixture.mp4",
    });
    expect(rendered.probe.byteSize).toBeGreaterThan(1000);
    expect(rendered.probe.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(rendered.probe.hasAudio).toBe(true);
    expect(rendered.probe.durationSeconds).toBeGreaterThan(1.9);
    expect(rendered.probe.framesPerSecond).toBe(30);
    expect(rendered.sourceText).toContain("OffthreadVideo");
  }, 180_000);
});
