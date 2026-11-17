import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  prepareVideoVoiceoverRun,
  publishNarrationScript,
  requestsVideoVoiceover,
  synthesizeNarration,
  VIDEO_AUDIO_QA_MARKER,
  VIDEO_RENDER_MARKER,
  VOICEOVER_MARKER,
  voiceoverPaths,
} from "./video-voiceover.ts";

const task = { title: "Tạo video có lời thuyết minh", description: null, workflow_pack_key: "video_preprod" };

describe("Vietnamese narration handoff", () => {
  it("opts in from the brief and leaves silent, development, and delegated video tasks unchanged", () => {
    expect(requestsVideoVoiceover(task)).toBe(true);
    expect(requestsVideoVoiceover({ ...task, title: "[VOICEOVER] Intro" })).toBe(true);
    expect(requestsVideoVoiceover({ ...task, title: "Video demo không cần lồng tiếng" })).toBe(false);
    expect(requestsVideoVoiceover({ ...task, title: "Video demo" })).toBe(false);
    expect(requestsVideoVoiceover({ ...task, workflow_pack_key: "development" })).toBe(false);
    expect(requestsVideoVoiceover({ ...task, source_task_id: "parent" })).toBe(false);
  });

  it("publishes the approved script, synthesizes once, stages the MP3 and waits for render before QA", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "claw-voice-handoff-"));
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT);
        CREATE TABLE subtasks (
          id TEXT PRIMARY KEY, task_id TEXT, title TEXT, description TEXT, status TEXT,
          target_department_id TEXT, delegated_task_id TEXT, blocked_reason TEXT, created_at INTEGER
        );
      `);
      const prep = path.join(project, "prep");
      const audio = path.join(project, "audio");
      const render = path.join(project, "render");
      const qa = path.join(project, "qa");
      for (const folder of [prep, audio, render, qa]) fs.mkdirSync(folder);
      const parent = "root-video";
      const broadcast = vi.fn();
      const paths = voiceoverPaths(parent);
      const child = { ...task, source_task_id: parent, title: "" };
      const prepare = (id: string, title: string, worktree: string) =>
        prepareVideoVoiceoverRun(db, id, { ...child, title }, project, worktree, 1, broadcast);

      expect(prepareVideoVoiceoverRun(db, parent, task, project, prep, 1, broadcast)).toEqual({
        replacesVideoRules: true,
        prompt: expect.stringContaining(paths.script),
      });
      prepareVideoVoiceoverRun(db, parent, task, project, prep, 1, broadcast);
      expect(broadcast).toHaveBeenCalledTimes(3);
      expect(db.prepare("SELECT target_department_id AS dept FROM subtasks ORDER BY rowid").all()).toEqual([
        { dept: "voice_audio" },
        { dept: "dev" },
        { dept: "qa" },
      ]);
      expect(() => prepare("render", VIDEO_RENDER_MARKER, render)).toThrow("still unfinished");
      expect(() => prepare("qa", VIDEO_AUDIO_QA_MARKER, qa)).toThrow("still unfinished");
      expect(() => publishNarrationScript(project, prep, parent)).toThrow();

      const spoken = "Xin chào. Đây là phần thuyết minh.";
      fs.mkdirSync(path.dirname(path.join(prep, paths.script)), { recursive: true });
      fs.writeFileSync(path.join(prep, paths.script), spoken);
      publishNarrationScript(project, prep, parent);
      const voiceRow = db.prepare("SELECT id FROM subtasks WHERE target_department_id = 'voice_audio'").get() as {
        id: string;
      };
      db.prepare("UPDATE subtasks SET delegated_task_id = 'audio' WHERE id = ?").run(voiceRow.id);
      expect(prepare("audio", VOICEOVER_MARKER, audio).prompt).toContain(paths.settings);
      expect(fs.readFileSync(path.join(audio, paths.script), "utf8")).toBe(spoken);

      const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64]);
      const cues = [{ text: spoken, startSeconds: 0, endSeconds: 3 }];
      const generate = vi.fn(async () => {
        fs.writeFileSync(path.join(project, paths.metadata), JSON.stringify({ duration_seconds: 3, cues }));
        fs.writeFileSync(path.join(project, paths.audio), mp3);
        return {
          outputPath: paths.audio,
          bytes: mp3.length,
          durationSeconds: 3,
          voice: "Minh Quân",
          cues,
          engine: "vieneu-tts",
        } as const;
      });
      await expect(synthesizeNarration(audio, project, parent, generate)).resolves.toMatchObject({
        durationSeconds: 3,
      });
      await expect(synthesizeNarration(audio, project, parent, generate)).resolves.toMatchObject({
        durationSeconds: 3,
      });
      expect(generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: spoken }));
      expect(() => prepare("render", VIDEO_RENDER_MARKER, render)).toThrow("still unfinished");

      db.prepare("UPDATE subtasks SET status = 'done' WHERE id = ?").run(voiceRow.id);
      const renderHandoff = prepare("render", VIDEO_RENDER_MARKER, render).prompt;
      expect(renderHandoff).toContain(`staticFile("${paths.remotion}")`);
      expect(renderHandoff).toContain(`public/${paths.remotionMetadata}`);
      expect(renderHandoff).toContain("duration_seconds");
      expect(renderHandoff).toContain("cues");
      expect(fs.readFileSync(path.join(render, "public", paths.remotion))).toEqual(mp3);
      expect(fs.existsSync(path.join(render, "public", paths.remotionMetadata))).toBe(true);
      db.exec(
        "UPDATE subtasks SET delegated_task_id = 'render', status = 'done' WHERE target_department_id = 'dev'; INSERT INTO tasks VALUES ('render', 'inbox');",
      );
      expect(() => prepare("qa", VIDEO_AUDIO_QA_MARKER, qa)).toThrow("still unfinished");
      db.exec("UPDATE tasks SET status = 'review' WHERE id = 'render';");
      expect(prepare("qa", VIDEO_AUDIO_QA_MARKER, qa).prompt).toContain("Inspect the rendered MP4");
      expect(
        prepareVideoVoiceoverRun(
          db,
          "silent-render",
          { ...child, source_task_id: "silent-parent", title: VIDEO_RENDER_MARKER },
          project,
          render,
          1,
          broadcast,
        ),
      ).toEqual({ prompt: "", replacesVideoRules: false });
    } finally {
      db.close();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
