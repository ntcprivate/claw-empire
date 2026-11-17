import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateVieNeuSpeech } from "./vieneu-tts.ts";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

class FakeWorker extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();

  constructor() {
    super();
    this.stdin.on("data", (raw) => {
      const { id, text, voice } = JSON.parse(raw.toString());
      setImmediate(() =>
        this.stdout.write(
          `${JSON.stringify({
            id,
            success: true,
            voice,
            mp3_base64: Buffer.from("ID3test").toString("base64"),
            durationSeconds: 1,
            cues: [{ text, startSeconds: 0, endSeconds: 0.9 }],
          })}\n`,
        ),
      );
    });
  }

  kill() {
    this.emit("exit", 0);
  }
}

let root: string;
let worker: FakeWorker;
const speech = (name = "read.mp3") => ({ projectRoot: root, outputPath: name, text: "Xin chào Việt Nam." });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "vieneu-tts-test-"));
  worker = new FakeWorker();
  spawn.mockReset().mockReturnValue(worker);
  vi.stubEnv("VIE_NEU_MODEL_DIR", root);
});

afterEach(async () => {
  worker.kill();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("VieNeu-TTS worker handoff", () => {
  it("shares a worker across queued requests and publishes complete MP3 and JSON pairs", async () => {
    await fs.writeFile(path.join(root, "config.json"), "{}");
    const states: string[] = [];
    const run = (name: string) =>
      generateVieNeuSpeech({ ...speech(name), onQueueState: (state) => states.push(state) });
    const [first, second] = await Promise.all([run("first.mp3"), run("second.mp3")]);
    expect(states).toEqual(["running", "queued", "running"]);
    expect(spawn).toHaveBeenCalledOnce();
    for (const item of [first, second]) {
      const metadata = await fs.readFile(path.join(root, item.outputPath.replace(/\.mp3$/, ".json")), "utf8");
      expect(JSON.parse(metadata)).toMatchObject({ duration_seconds: 1, cues: item.cues, voice: "Minh Quân" });
      expect(await fs.readFile(path.join(root, item.outputPath), "utf8")).toBe("ID3test");
    }
  });

  it("leaves a historical sidecar intact when a destination is already occupied", async () => {
    const sidecar = path.join(root, "read.json");
    await fs.writeFile(sidecar, "historical data");
    await expect(generateVieNeuSpeech(speech())).rejects.toMatchObject({ code: "output_error" });
    expect(await fs.readFile(sidecar, "utf8")).toBe("historical data");
    await expect(fs.access(path.join(root, "read.mp3"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports missing models, cancels aborted requests and rejects paths outside the project", async () => {
    await expect(generateVieNeuSpeech(speech())).rejects.toMatchObject({ code: "model_not_found" });
    await expect(generateVieNeuSpeech(speech("../outside.mp3"))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(generateVieNeuSpeech({ ...speech(), signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});
