import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerAudioSpeechRoutes } from "./audio-speech.ts";

describe("speech route behavior", () => {
  it("validates input and refuses unknown task paths without starting synthesis", async () => {
    const get = vi.fn(() => undefined);
    const app = express();
    app.use(express.json());
    registerAudioSpeechRoutes(app, { prepare: () => ({ get }) });

    await request(app).post("/api/audio/speech").send({ text: "hello", voice: "invalid" }).expect(400);
    await request(app).post("/api/audio/speech").send({ taskId: "missing", text: "hello" }).expect(404);
    expect(get).toHaveBeenCalledOnce();
    await request(app).get("/api/audio/speech").expect(200).expect({ ok: true, jobs: [] });
    await request(app).get("/api/audio/speech/unknown").expect(404);
    await request(app).get("/api/audio/speech/unknown/audio").expect(404);
  });

  it("rejects client supplied file paths and extra properties", async () => {
    const app = express();
    app.use(express.json());
    registerAudioSpeechRoutes(app, { prepare: () => ({ get: () => undefined }) });
    await request(app).post("/api/audio/speech").send({ text: "hello", outputPath: "../../outside.mp3" }).expect(400);
  });

  it("queues a server-owned output path, reports completion, and streams only the generated MP3", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "speech-route-test-"));
    const app = express();
    app.use(express.json());
    const synthesize = vi.fn(async (input: any) => {
      input.onQueueState?.("running");
      const audioPath = path.join(input.projectRoot, ...input.outputPath.split("/"));
      fs.mkdirSync(path.dirname(audioPath), { recursive: true });
      fs.writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x64]));
      return {
        success: true,
        audio_path: input.outputPath,
        outputPath: input.outputPath,
        bytes: 4,
        duration_seconds: 1,
        durationSeconds: 1,
        voice: "Minh Quân" as const,
        cues: [{ text: "Xin chào", startSeconds: 0, endSeconds: 1.0 }],
        engine: "vieneu-tts" as const,
      };
    });
    const appDb = { prepare: () => ({ get: () => ({ id: "task-1", project_path: projectRoot }) }) };
    registerAudioSpeechRoutes(app, appDb, synthesize);
    try {
      const queued = await request(app)
        .post("/api/audio/speech")
        .send({ taskId: "task-1", text: "Xin chào", speed: 1.0 })
        .expect(202);
      const id = queued.body.id as string;
      await vi.waitFor(async () =>
        expect((await request(app).get(`/api/audio/speech/${id}`)).body.job.status).toBe("done"),
      );
      const status = await request(app).get(`/api/audio/speech/${id}`).expect(200);
      expect(status.body.job).toMatchObject({
        status: "done",
        durationSeconds: 1,
        cues: [{ text: "Xin chào", startSeconds: 0, endSeconds: 1.0 }],
        engine: "vieneu-tts",
      });
      const audio = await request(app).get(`/api/audio/speech/${id}/audio`).expect(200);
      expect(audio.headers["content-type"]).toContain("audio/mpeg");
      expect(synthesize).toHaveBeenCalledWith(
        expect.objectContaining({ settings: expect.objectContaining({ voice: "Minh Quân", speed: 1.0 }) }),
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
