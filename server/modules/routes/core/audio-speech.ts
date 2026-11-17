import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { videoAudioToolRuntime } from "../../workflow/packs/video-voiceover.ts";
import {
  VIENEU_VOICES,
  DEFAULT_VIENEU_VOICE,
  VIENEU_SPEED_MIN,
  VIENEU_SPEED_MAX,
} from "../../../../shared/vieneu-speech.ts";
import type { Express } from "express";
import { DEFAULT_DATA_ROOT } from "../../../config/runtime.ts";

type Db = { prepare(sql: string): { get(...args: unknown[]): unknown } };
type SpeechJob = {
  taskId: string | null;
  projectRoot: string;
  outputPath: string;
  status: "queued" | "running" | "done" | "failed";
  result?: Awaited<ReturnType<typeof videoAudioToolRuntime.generate_speech>>;
  error?: string;
  createdAt: number;
};
const jobs = new Map<string, SpeechJob>();
const requestSchema = z.strictObject({
  taskId: z.string().min(1).max(100).optional(),
  text: z.string().trim().min(1).max(40_000),
  voice: z.enum(VIENEU_VOICES).default(DEFAULT_VIENEU_VOICE),
  speed: z.number().min(VIENEU_SPEED_MIN).max(VIENEU_SPEED_MAX).default(1.0),
});

export function registerAudioSpeechRoutes(
  app: Express,
  db: Db,
  synthesize: typeof videoAudioToolRuntime.generate_speech = videoAudioToolRuntime.generate_speech,
) {
  app.post("/api/audio/speech", async (req, res) => {
    const parsed = requestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: "invalid_speech_request" });
    const task = parsed.data.taskId
      ? (db.prepare("SELECT id, project_path FROM tasks WHERE id = ?").get(parsed.data.taskId) as
          | { id: string; project_path: string | null }
          | undefined)
      : undefined;
    if (
      parsed.data.taskId &&
      (!task?.project_path || !path.isAbsolute(task.project_path) || !fs.existsSync(task.project_path))
    ) {
      return res.status(404).json({ ok: false, error: "task_project_unavailable" });
    }
    const projectRoot = task?.project_path ?? DEFAULT_DATA_ROOT;
    const id = randomUUID();
    const outputPath = `${task ? "video_output/audio-generated" : "audio-output"}/${id}/narration.mp3`;
    const job: SpeechJob = {
      taskId: task?.id ?? null,
      projectRoot,
      outputPath,
      status: "queued",
      createdAt: Date.now(),
    };
    jobs.set(id, job);
    while (jobs.size > 50) {
      const oldestCompleted = [...jobs.entries()].find(
        ([, item]) => item.status === "done" || item.status === "failed",
      );
      if (!oldestCompleted) break;
      jobs.delete(oldestCompleted[0]);
    }
    void (async () => {
      try {
        job.result = await synthesize({
          projectRoot,
          outputPath,
          text: parsed.data.text,
          settings: {
            voice: parsed.data.voice,
            speed: parsed.data.speed,
          },
          onQueueState: (status) => {
            job.status = status;
          },
        });
        job.status = "done";
      } catch (error) {
        job.status = "failed";
        job.error = error && typeof error === "object" && "code" in error ? String(error.code) : "provider_error";
      }
    })();
    return res.status(202).json({ ok: true, id, status: job.status });
  });

  app.get("/api/audio/speech", (_req, res) => {
    const recent = [...jobs.entries()].reverse().map(([id, job]) => ({
      id,
      taskId: job.taskId,
      status: job.status,
      error: job.error,
      outputPath: job.result?.audio_path,
      bytes: job.result?.bytes,
      durationSeconds: job.result?.duration_seconds,
      voice: job.result?.voice,
      cues: job.result?.cues,
      engine: job.result?.engine,
      createdAt: job.createdAt,
      audioUrl: job.status === "done" ? `/api/audio/speech/${id}/audio` : undefined,
    }));
    res.json({ ok: true, jobs: recent });
  });

  app.get("/api/audio/speech/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: "speech_job_not_found" });
    return res.json({
      ok: true,
      job: {
        id: req.params.id,
        taskId: job.taskId,
        status: job.status,
        error: job.error,
        outputPath: job.result?.audio_path,
        bytes: job.result?.bytes,
        durationSeconds: job.result?.duration_seconds,
        voice: job.result?.voice,
        cues: job.result?.cues,
        engine: job.result?.engine,
        createdAt: job.createdAt,
        audioUrl: job.status === "done" ? `/api/audio/speech/${req.params.id}/audio` : undefined,
      },
    });
  });

  app.get("/api/audio/speech/:id/audio", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.status !== "done" || !job.result)
      return res.status(404).json({ ok: false, error: "audio_not_found" });
    let audioPath: string;
    try {
      const root = fs.realpathSync(job.projectRoot);
      audioPath = path.join(root, ...job.result.audio_path.split("/"));
      let current = root;
      for (const part of job.result.audio_path.split("/")) {
        current = path.join(current, part);
        const info = fs.lstatSync(current);
        if (info.isSymbolicLink() || (current !== audioPath && !info.isDirectory()))
          return res.status(404).json({ ok: false, error: "audio_not_found" });
        if (current === audioPath && !info.isFile())
          return res.status(404).json({ ok: false, error: "audio_not_found" });
      }
    } catch {
      return res.status(404).json({ ok: false, error: "audio_not_found" });
    }
    res.type("audio/mpeg").set("Content-Disposition", 'inline; filename="narration.mp3"').sendFile(audioPath);
  });
}
