import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { link, lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  DEFAULT_VIENEU_VOICE,
  VIENEU_SPEED_MAX,
  VIENEU_SPEED_MIN,
  VIENEU_VOICES,
  type SpeechCue,
  type VieNeuVoice,
} from "../../../../shared/vieneu-speech.ts";

const workerScript = fileURLToPath(new URL("../../../../scripts/vieneu-speech.py", import.meta.url));
const runtimeDirectory = fileURLToPath(new URL("../../../../data/vieneu/", import.meta.url));
const maxQueueSize = 8;
const maxWorkerReplyBytes = 40_000_000;
const waiting: Array<() => void> = [];
const generating = new Set<string>();
let running = false;
let worker: ChildProcessWithoutNullStreams | undefined;
let idleTimer: NodeJS.Timeout | undefined;

const workerErrors = z.enum([
  "invalid_input",
  "unavailable",
  "provider_error",
  "no_audio",
  "output_error",
  "model_not_found",
]);

export class VieNeuTtsError extends Error {
  constructor(
    readonly code: z.infer<typeof workerErrors> | "queue_full" | "timeout" | "generation_in_progress" | "worker_error",
  ) {
    super(code);
    this.name = "VieNeuTtsError";
  }
}

export type VieNeuTtsInput = {
  projectRoot: string;
  outputPath: string;
  text: string;
  voice?: VieNeuVoice;
  speed?: number;
  signal?: AbortSignal;
  onQueueState?: (state: "queued" | "running") => void;
};

export type VieNeuTtsOutput = {
  outputPath: string;
  bytes: number;
  durationSeconds: number;
  voice: VieNeuVoice;
  cues: SpeechCue[];
  engine: "vieneu-tts";
};

const workerReply = z.discriminatedUnion("success", [
  z.object({
    id: z.string(),
    success: z.literal(true),
    mp3_base64: z.string(),
    durationSeconds: z.number().positive(),
    voice: z.enum(VIENEU_VOICES),
    cues: z
      .array(
        z.object({
          text: z.string().min(1),
          startSeconds: z.number().nonnegative(),
          endSeconds: z.number().positive(),
        }),
      )
      .min(1),
  }),
  z.object({ id: z.string(), success: z.literal(false), error: workerErrors }),
]);

function stopWorker(child: ChildProcessWithoutNullStreams) {
  if (worker === child) worker = undefined;
  child.stdin.end();
  child.kill();
}

function getWorker(): ChildProcessWithoutNullStreams {
  if (idleTimer) clearTimeout(idleTimer);
  if (worker) return worker;

  const defaultPython = path.join(
    runtimeDirectory,
    ".venv",
    ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]),
  );
  const model = process.env.VIE_NEU_MODEL_DIR?.trim() || path.join(runtimeDirectory, "model");
  if (!existsSync(path.join(model, "config.json"))) throw new VieNeuTtsError("model_not_found");
  const python = process.env.VIE_NEU_PYTHON?.trim() || defaultPython;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(key)),
  );
  env.VIE_NEU_MODEL_DIR = path.resolve(model);
  env.HF_HUB_OFFLINE = "1";
  const child = spawn(python, ["-I", "-X", "utf8", "-u", workerScript], { env, windowsHide: true });
  worker = child;
  child.stderr.resume();
  child.stdout.setEncoding("utf8");
  // Retire the current process only; a cancelled worker can close after its replacement starts.
  const retire = () => {
    if (worker === child) worker = undefined;
  };
  child.once("error", retire);
  child.once("exit", retire);
  child.stdin.on("error", () => stopWorker(child));
  return child;
}

/** Fail before an upstream language-model request if the local offline TTS runtime is absent. */
export function assertVieNeuRuntimeReady(): void {
  const model = process.env.VIE_NEU_MODEL_DIR?.trim() || path.join(runtimeDirectory, "model");
  if (!existsSync(path.join(model, "config.json"))) throw new VieNeuTtsError("model_not_found");
  const python = process.env.VIE_NEU_PYTHON?.trim() || path.join(
    runtimeDirectory,
    ".venv",
    ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]),
  );
  if (!existsSync(python)) throw new VieNeuTtsError("unavailable");
}

function requestSynthesis(text: string, voice: VieNeuVoice, speed: number, signal: AbortSignal) {
  if (signal.aborted) throw new VieNeuTtsError("timeout");
  const child = getWorker();
  const id = randomUUID();
  return new Promise<Extract<z.infer<typeof workerReply>, { success: true }>>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    function finish(error?: VieNeuTtsError, result?: Extract<z.infer<typeof workerReply>, { success: true }>) {
      if (settled) return;
      settled = true;
      child.stdout.off("data", receive);
      child.off("error", spawnFailed);
      child.off("exit", exited);
      signal.removeEventListener("abort", abort);
      if (worker === child) {
        idleTimer = setTimeout(() => stopWorker(child), 60_000);
        idleTimer.unref();
      }
      if (error) reject(error);
      else if (result) resolve(result);
    }
    function badReply() {
      stopWorker(child);
      finish(new VieNeuTtsError("worker_error"));
    }
    function receive(chunk: string) {
      buffer += chunk;
      if (buffer.length > maxWorkerReplyBytes) return badReply();
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const reply = workerReply.parse(JSON.parse(buffer.slice(0, end)));
        if (reply.id !== id) return badReply();
        if (!reply.success) return finish(new VieNeuTtsError(reply.error));
        finish(undefined, reply);
      } catch {
        badReply();
      }
    }
    function abort() {
      stopWorker(child);
      finish(new VieNeuTtsError("timeout"));
    }
    function spawnFailed() {
      finish(new VieNeuTtsError("unavailable"));
    }
    function exited() {
      finish(new VieNeuTtsError("worker_error"));
    }
    child.stdout.on("data", receive);
    child.once("error", spawnFailed);
    child.once("exit", exited);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) return abort();
    child.stdin.write(`${JSON.stringify({ id, text, voice, speed })}\n`, "utf8", (error) => {
      if (error) badReply();
    });
  });
}

async function acquire(signal: AbortSignal, onQueueState: VieNeuTtsInput["onQueueState"]) {
  if (signal.aborted) throw new VieNeuTtsError("timeout");
  if (running) {
    if (waiting.length >= maxQueueSize) throw new VieNeuTtsError("queue_full");
    onQueueState?.("queued");
    await new Promise<void>((resolve, reject) => {
      const promote = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const i = waiting.indexOf(promote);
        if (i >= 0) waiting.splice(i, 1);
        reject(new VieNeuTtsError("timeout"));
      };
      waiting.push(promote);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  } else {
    running = true;
  }
}

function pathKey(filename: string) {
  return process.platform === "win32" ? filename.toLowerCase() : filename;
}

function captionText(text: string) {
  return text.trim().replace(/\s+/gu, " ");
}

export async function generateVieNeuSpeech(input: VieNeuTtsInput): Promise<VieNeuTtsOutput> {
  const { text, voice = DEFAULT_VIENEU_VOICE, speed = 1, onQueueState } = input;
  const parts = input.outputPath.split(/[\\/]/);
  if (
    !text.trim() ||
    text.length > 40_000 ||
    !VIENEU_VOICES.includes(voice) ||
    !Number.isFinite(speed) ||
    speed < VIENEU_SPEED_MIN ||
    speed > VIENEU_SPEED_MAX ||
    !path.isAbsolute(input.projectRoot) ||
    !/\.mp3$/i.test(input.outputPath) ||
    parts.some(
      (part) =>
        !/^[\p{L}\p{N}_-][\p{L}\p{N}._-]*$/u.test(part) ||
        part.endsWith(".") ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
    )
  ) {
    throw new VieNeuTtsError("invalid_input");
  }

  const timeout = AbortSignal.timeout(300_000);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  let directory: string;
  try {
    directory = await realpath(input.projectRoot);
    for (const part of parts.slice(0, -1)) {
      directory = path.join(directory, part);
      await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      if (!(await lstat(directory)).isDirectory()) throw new VieNeuTtsError("output_error");
    }
  } catch {
    throw new VieNeuTtsError("output_error");
  }

  const filename = path.join(directory, parts.at(-1)!);
  const sidecar = filename.replace(/\.mp3$/i, ".json");
  const key = pathKey(filename);
  if (generating.has(key)) throw new VieNeuTtsError("generation_in_progress");
  generating.add(key);

  const temporary = path.join(directory, `.vieneu-${randomUUID()}`);
  const temporaryMetadata = `${temporary}.json`;
  let acquired = false;
  let metadataLinked = false;
  let published = false;
  try {
    await acquire(signal, onQueueState);
    acquired = true;
    onQueueState?.("running");
    if (existsSync(filename) || existsSync(sidecar)) throw new VieNeuTtsError("output_error");
    const result = await requestSynthesis(text, voice, speed, signal);
    const mp3 = Buffer.from(result.mp3_base64, "base64");
    const hasMp3Header =
      mp3.subarray(0, 3).toString("ascii") === "ID3" || (mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0);
    if (
      !hasMp3Header ||
      mp3.length < 4 ||
      result.voice !== voice ||
      captionText(result.cues.map((cue) => cue.text).join(" ")) !== captionText(text) ||
      result.cues.some(
        (cue, i, cues) =>
          cue.endSeconds <= cue.startSeconds ||
          cue.endSeconds > result.durationSeconds ||
          (i > 0 && cue.startSeconds < cues[i - 1].endSeconds),
      )
    ) {
      throw new VieNeuTtsError("worker_error");
    }
    if (pathKey(await realpath(directory)) !== pathKey(directory)) throw new VieNeuTtsError("output_error");

    const output = {
      outputPath: parts.join("/"),
      bytes: mp3.length,
      durationSeconds: result.durationSeconds,
      voice,
      cues: result.cues,
      engine: "vieneu-tts" as const,
    };
    await writeFile(temporary, mp3, { flag: "wx", mode: 0o600 });
    await writeFile(
      temporaryMetadata,
      JSON.stringify({ ...output, duration_seconds: output.durationSeconds, schemaVersion: 1 }),
      { flag: "wx", mode: 0o600 },
    );
    if (signal.aborted) throw new VieNeuTtsError("timeout");
    // The MP3 becomes visible only once its already-validated sidecar is in place.
    await link(temporaryMetadata, sidecar);
    metadataLinked = true;
    await link(temporary, filename);
    published = true;
    return output;
  } catch (error) {
    if (error instanceof VieNeuTtsError) throw error;
    throw new VieNeuTtsError("output_error");
  } finally {
    if (metadataLinked && !published) await rm(sidecar, { force: true }).catch(() => undefined);
    await Promise.all([temporary, temporaryMetadata].map((file) => rm(file, { force: true }).catch(() => undefined)));
    generating.delete(key);
    if (acquired) {
      const next = waiting.shift();
      if (next) next();
      else running = false;
    }
  }
}
