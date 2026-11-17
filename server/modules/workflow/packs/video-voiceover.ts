import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { VIENEU_SPEED_MAX, VIENEU_SPEED_MIN, VIENEU_VOICES } from "../../../../shared/vieneu-speech.ts";
import { generateVieNeuSpeech } from "./vieneu-tts.ts";

export const VOICEOVER_MARKER = "[VIDEO_VOICEOVER]";
export const VIDEO_RENDER_MARKER = "[VIDEO_FINAL_RENDER]";
export const VIDEO_AUDIO_QA_MARKER = "[VIDEO_AUDIO_QA]";
const AUDIO_DEPARTMENT = "voice_audio";
type Db = Pick<DatabaseSync, "prepare">;
type VideoTask = {
  title: string;
  description: string | null;
  workflow_pack_key?: string | null;
  source_task_id?: string | null;
};

export function requestsVideoVoiceover(task: VideoTask): boolean {
  if (task.workflow_pack_key !== "video_preprod" || task.source_task_id) return false;
  const brief = `${task.title}\n${task.description ?? ""}`.normalize("NFC");
  if (/\[VOICEOVER\]/i.test(brief)) return true;
  if (
    /(?:không(?: cần| có| dùng| thêm)?\s+(?:lời thuyết minh|thuyết minh|giọng đọc|lồng tiếng)|(?:no|without)\s+(?:voice[ -]?over|narration)|un[n-]?narrated)/iu.test(
      brief,
    )
  ) {
    return false;
  }
  return /lời thuyết minh|thuyết minh|giọng đọc|lồng tiếng|lời dẫn|voice[ -]?over|\bnarrat(?:ion|ed|or)\b/iu.test(
    brief,
  );
}

function artifactKey(parentTaskId: string): string {
  return createHash("sha256").update(parentTaskId).digest("hex").slice(0, 24);
}

export function voiceoverPaths(parentTaskId: string) {
  const key = artifactKey(parentTaskId);
  const output = `video_output/voiceover/${key}`;
  return {
    script: `${output}/narration.txt`,
    settings: `${output}/voice-settings.json`,
    audio: `${output}/narration.mp3`,
    metadata: `${output}/narration.json`,
    remotion: `claw-empire-audio/${key}.mp3`,
    remotionMetadata: `claw-empire-audio/${key}.json`,
  };
}

export function getVoiceoverSubtask(db: Db, parentTaskId: string) {
  return db
    .prepare("SELECT id, status FROM subtasks WHERE task_id = ? AND title LIKE ? LIMIT 1")
    .get(parentTaskId, `${VOICEOVER_MARKER}%`) as { id: string; status: string } | undefined;
}

export function hasFinishedNarratedStage(
  db: Db,
  parentTaskId: string,
  marker: typeof VIDEO_RENDER_MARKER | typeof VIDEO_AUDIO_QA_MARKER,
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM subtasks s JOIN tasks t ON s.delegated_task_id = t.id
     WHERE s.task_id = ? AND s.title LIKE ? AND s.status = 'done' AND t.status IN ('review', 'done')`,
      )
      .get(parentTaskId, `%${marker}%`),
  );
}

export function isDelegatedVoiceoverTask(db: Db, taskId: string, task: VideoTask): boolean {
  if (task.workflow_pack_key !== "video_preprod" || !task.source_task_id) return false;
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM subtasks WHERE task_id = ? AND delegated_task_id = ? AND target_department_id = ? AND title LIKE ?",
      )
      .get(task.source_task_id, taskId, AUDIO_DEPARTMENT, `${VOICEOVER_MARKER}%`),
  );
}

export function seedVideoVoiceover(
  db: Db,
  taskId: string,
  task: VideoTask,
  now: number,
  broadcast: (event: string, payload: unknown) => void,
): boolean {
  if (!requestsVideoVoiceover(task)) return false;
  const insert = (title: string, description: string, department: string, reason: string) => {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO subtasks (id, task_id, title, description, status, blocked_reason, target_department_id, created_at)
       VALUES (?, ?, ?, ?, 'blocked', ?, ?, ?)`,
    ).run(id, taskId, title, description, reason, department, now);
    broadcast("subtask_update", db.prepare("SELECT * FROM subtasks WHERE id = ?").get(id));
  };
  if (!getVoiceoverSubtask(db, taskId)) {
    insert(
      `${VOICEOVER_MARKER} Tạo giọng đọc tiếng Việt`,
      "Review pacing and delivery for the approved Vietnamese narration. The backend generates MP3 and caption cues with VieNeu-TTS.",
      AUDIO_DEPARTMENT,
      "Waiting for the Pre-production narration script",
    );
  }
  if (
    !db
      .prepare("SELECT 1 FROM subtasks WHERE task_id = ? AND title LIKE ? AND status != 'cancelled'")
      .get(taskId, `%${VIDEO_RENDER_MARKER}%`)
  ) {
    insert(
      `${VIDEO_RENDER_MARKER} Render video bằng Remotion`,
      "Build and render the video with the prepared Vietnamese narration asset. Verify that the narration is audible in the final MP4.",
      "dev",
      "Waiting for the voiceover and other production deliverables",
    );
  }
  if (
    !db.prepare("SELECT 1 FROM subtasks WHERE task_id = ? AND title LIKE ?").get(taskId, `${VIDEO_AUDIO_QA_MARKER}%`)
  ) {
    insert(
      `${VIDEO_AUDIO_QA_MARKER} Kiểm tra lời đọc trong video`,
      "Check the final MP4 for a complete Vietnamese narration track, intelligibility, sync, and balance. Report findings and any timestamps in need of revision.",
      "qa",
      "Waiting for Scene Engine to render the MP4",
    );
  }
  return true;
}

export function buildNarrationScriptPrompt(parentTaskId: string): string {
  return [
    "[Vietnamese video narration — Pre-production handoff]",
    `Write the final Vietnamese spoken lines as UTF-8 plain text to ${voiceoverPaths(parentTaskId).script} in this worktree.`,
    "Preserve any supplied dialogue. If no dialogue is supplied, write narration that matches the brief and duration. Keep scene labels, timing, and production notes outside this file.",
    "Finish the script and other pre-production deliverables before handing off. Voice & Audio will prepare and synthesize the narration, then Scene Engine will render the final MP4.",
  ].join("\n");
}

// Keep task-owned input and staged assets within the selected workspace, including on Windows junctions.
function checkedPath(root: string, relative: string): string {
  let current = fs.realpathSync(root);
  for (const part of relative.split("/")) {
    if (!part || part === "." || part === ".." || /[\\:]/.test(part)) throw new Error("Invalid voiceover asset path");
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Voiceover asset path contains a link");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return current;
}

function copyAsset(sourceRoot: string, source: string, targetRoot: string, target: string): void {
  const from = checkedPath(sourceRoot, source);
  const to = checkedPath(targetRoot, target);
  if (!fs.statSync(from).isFile() || fs.statSync(from).size === 0) throw new Error("Voiceover asset is empty");
  if (from === to) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

export function stageNarrationScript(projectRoot: string, audioWorktree: string, parentTaskId: string): string {
  const paths = voiceoverPaths(parentTaskId);
  copyAsset(projectRoot, paths.script, audioWorktree, paths.script);
  return buildAudioProducerPrompt(parentTaskId);
}

export function publishNarrationScript(projectRoot: string, parentWorktree: string, parentTaskId: string): void {
  const script = voiceoverPaths(parentTaskId).script;
  if (!hasNarrationAudio(projectRoot, parentTaskId)) {
    if (!readSmallFile(parentWorktree, script, 40_000).trim()) throw new Error("Narration script is blank");
    copyAsset(parentWorktree, script, projectRoot, script);
  }
}

export function buildAudioProducerPrompt(parentTaskId: string): string {
  const paths = voiceoverPaths(parentTaskId);
  return [
    "[Audio Producer — Vietnamese narration]",
    `Read the approved spoken lines at ${paths.script}. Keep the wording intact.`,
    "Review emphasis, pauses, pacing, and pronunciation. Keep the approved wording and punctuation intact.",
    `If you can write files, you may save optional delivery settings to ${paths.settings} as a JSON object with voice (${VIENEU_VOICES.join(", ")}) and speed (${VIENEU_SPEED_MIN}–${VIENEU_SPEED_MAX}).`,
    "If you work through text only, report your delivery notes. The backend can synthesize the approved script with the default voice and speed after your turn.",
    "The backend runs VieNeu-TTS and hands the verified MP3 and measured caption cues to Scene Engine for Remotion.",
  ].join("\n");
}

const narrationSettings = z.strictObject({
  voice: z.enum(VIENEU_VOICES).optional(),
  speed: z.number().min(VIENEU_SPEED_MIN).max(VIENEU_SPEED_MAX).optional(),
});

export async function generateSpeech(input: {
  projectRoot: string;
  outputPath: string;
  text: string;
  settings: z.infer<typeof narrationSettings>;
  signal?: AbortSignal;
  onQueueState?: (state: "queued" | "running") => void;
}) {
  const { settings, ...request } = input;
  const result = await generateVieNeuSpeech({ ...request, ...narrationSettings.parse(settings) });
  return {
    ...result,
    success: true,
    audio_path: result.outputPath,
    duration_seconds: result.durationSeconds,
  };
}

export const videoAudioToolRuntime = {
  generate_speech: generateSpeech,
} as const;

function readSmallFile(root: string, relative: string, maxBytes: number): string {
  const file = checkedPath(root, relative);
  const stat = fs.statSync(file);
  if (!stat.isFile() || !stat.size || stat.size > maxBytes) throw new Error("Invalid voiceover input size");
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
}

export function hasNarrationAudio(projectRoot: string, parentTaskId: string): boolean {
  try {
    const stat = fs.statSync(checkedPath(projectRoot, voiceoverPaths(parentTaskId).audio));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export async function synthesizeNarration(
  audioWorktree: string,
  projectRoot: string,
  parentTaskId: string,
  synthesize = generateVieNeuSpeech,
  signal?: AbortSignal,
  onQueueState?: (state: "queued" | "running") => void,
) {
  const paths = voiceoverPaths(parentTaskId);
  if (hasNarrationAudio(projectRoot, parentTaskId)) {
    const bytes = fs.statSync(checkedPath(projectRoot, paths.audio)).size;
    let durationSeconds: number | null = null;
    try {
      const metadata = JSON.parse(readSmallFile(projectRoot, paths.metadata, 8_000_000));
      const measured = metadata.durationSeconds ?? metadata.duration_seconds;
      if (typeof measured === "number" && Number.isFinite(measured)) {
        durationSeconds = measured;
      }
    } catch {
      // Historical MP3s may not have a sidecar.
    }
    return { outputPath: paths.audio, bytes, durationSeconds };
  }
  const text = readSmallFile(projectRoot, paths.script, 40_000).trim();
  let settings: z.infer<typeof narrationSettings> = {};
  try {
    settings = narrationSettings.parse(JSON.parse(readSmallFile(audioWorktree, paths.settings, 2_048)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return synthesize({ ...settings, projectRoot, outputPath: paths.audio, text, signal, onQueueState });
}

export function stageNarrationForRemotion(projectRoot: string, renderWorktree: string, parentTaskId: string): string {
  const paths = voiceoverPaths(parentTaskId);
  copyAsset(projectRoot, paths.audio, renderWorktree, `public/${paths.remotion}`);
  let hasMetadata = false;
  try {
    if (fs.statSync(checkedPath(projectRoot, paths.metadata)).isFile()) {
      copyAsset(projectRoot, paths.metadata, renderWorktree, `public/${paths.remotionMetadata}`);
      hasMetadata = true;
    }
  } catch {
    // Preserve the legacy MP3-only handoff; its measured duration is read from the media file during render.
  }
  return [
    "[Required Vietnamese narration]",
    `The approved MP3 is staged at public/${paths.remotion}. Import Audio and staticFile from remotion and use <Audio src={staticFile(${JSON.stringify(paths.remotion)})} /> in the composition.`,
    hasMetadata
      ? `The measured audio duration and caption timing are in public/${paths.remotionMetadata}. Set the composition duration to at least Math.ceil(duration_seconds * fps). Use each cues entry's text, startSeconds and endSeconds for subtitles. For historical metadata, use word_times when cues are unavailable.`
      : `No metadata sidecar exists for this legacy MP3. Measure its duration with ffprobe and set composition duration to at least Math.ceil(duration_seconds * fps). Align captions against the approved narration script; do not guess timing.`,
    `Pass --public-dir=${JSON.stringify(path.join(renderWorktree, "public").replaceAll("\\", "/"))} to the Remotion CLI so it bundles the staged file. If this project already uses a custom public directory, copy the asset there first and pass that directory instead.`,
    "Use the aspect ratio, resolution and target duration requested in the project brief when setting up the Remotion composition.",
    "Align scenes to the audio, keep narration audible over music, and verify the exported MP4 has the complete voice track.",
  ].join("\n");
}

export function prepareVideoVoiceoverRun(
  db: Db,
  taskId: string,
  task: VideoTask,
  projectRoot: string,
  worktree: string,
  now: number,
  broadcast: (event: string, payload: unknown) => void,
): { prompt: string; replacesVideoRules: boolean } {
  if (seedVideoVoiceover(db, taskId, task, now, broadcast)) {
    return { prompt: buildNarrationScriptPrompt(taskId), replacesVideoRules: true };
  }
  if (task.workflow_pack_key === "video_preprod" && task.source_task_id) {
    if (isDelegatedVoiceoverTask(db, taskId, task)) {
      return { prompt: stageNarrationScript(projectRoot, worktree, task.source_task_id), replacesVideoRules: true };
    }
    const voiceover = getVoiceoverSubtask(db, task.source_task_id);
    if (voiceover && task.title.includes(VIDEO_RENDER_MARKER)) {
      if (voiceover.status !== "done") throw new Error("The required Vietnamese narration is still unfinished");
      return {
        prompt: stageNarrationForRemotion(projectRoot, worktree, task.source_task_id),
        replacesVideoRules: false,
      };
    }
    if (voiceover && task.title.includes(VIDEO_AUDIO_QA_MARKER)) {
      if (!hasFinishedNarratedStage(db, task.source_task_id, VIDEO_RENDER_MARKER))
        throw new Error("The final MP4 is still unfinished");
      return {
        prompt: [
          "[Cut QA — final video and Vietnamese narration]",
          `Inspect the rendered MP4 under ${path.join(projectRoot, "video_output")} (read-only).`,
          `The reference narration for this task is ${path.join(projectRoot, voiceoverPaths(task.source_task_id).audio)}.`,
          'Use ffprobe -v error -select_streams a -show_streams "<mp4>" to verify that an audio stream exists.',
          "Verify that the MP4 contains an audible audio track. Check narration completeness, sync and balance as far as available tools permit, and identify checks you could not perform.",
        ].join("\n"),
        replacesVideoRules: true,
      };
    }
  }
  return { prompt: "", replacesVideoRules: false };
}
