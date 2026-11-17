import { useEffect, useState } from "react";
import * as api from "../../api";
import type { Task } from "../../types";
import type { TFunction } from "./types";
import {
  VIENEU_VOICES,
  DEFAULT_VIENEU_VOICE,
  VIENEU_SPEED_MIN,
  VIENEU_SPEED_MAX,
} from "../../../shared/vieneu-speech.ts";
import type { VieNeuVoice } from "../../../shared/vieneu-speech.ts";

type Props = { t: TFunction };

export default function VieNeuSpeechPanel({ t }: Props) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [jobs, setJobs] = useState<api.SpeechJob[]>([]);
  const [taskId, setTaskId] = useState("");
  const [text, setText] = useState("");
  const [voice, setVoice] = useState<VieNeuVoice>(DEFAULT_VIENEU_VOICE);
  const [speed, setSpeed] = useState(1.0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([api.getTasks(), api.getSpeechJobs()])
      .then(([taskRows, recentJobs]) => {
        const eligible = taskRows.filter((task) => task.project_path).slice(0, 60);
        setTasks(eligible);
        setJobs(recentJobs);
      })
      .catch(() =>
        setError(
          t({
            en: "Could not load projects or speech history.",
            ko: "프로젝트 또는 음성 기록을 불러오지 못했습니다.",
            ja: "プロジェクトまたは音声履歴を読み込めませんでした。",
            zh: "无法加载项目或语音历史。",
          }),
        ),
      );
  }, [t]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const queued = await api.generateSpeech({ taskId: taskId || undefined, text, voice, speed });
      let current: api.SpeechJob = {
        id: queued.id,
        taskId: taskId || null,
        status: queued.status,
        voice,
        createdAt: Date.now(),
      };
      const updateJob = (next: api.SpeechJob) =>
        setJobs((items) => [next, ...items.filter((job) => job.id !== next.id)]);
      updateJob(current);
      for (let attempt = 0; attempt < 180; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        current = await api.getSpeechJob(queued.id);
        updateJob(current);
        if (current.status === "done") break;
        if (current.status === "failed") throw new Error(current.error || "Speech generation failed.");
      }
      if (current.status !== "done")
        throw new Error("Speech generation is still running. It remains in history and can be checked again.");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t({
              en: "Speech generation failed.",
              ko: "음성 생성에 실패했습니다.",
              ja: "音声生成に失敗しました。",
              zh: "语音生成失败。",
            }),
      );
    } finally {
      setBusy(false);
    }
  }

  const inputStyle = {
    background: "var(--th-input-bg)",
    borderColor: "var(--th-input-border)",
    color: "var(--th-text-primary)",
  };
  return (
    <section
      className="space-y-4 rounded-xl p-5 sm:p-6"
      style={{ background: "var(--th-card-bg)", border: "1px solid var(--th-card-border)" }}
    >
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--th-text-primary)" }}>
          {t({
            en: "Vietnamese speech (VieNeu-TTS)",
            ko: "베트남어 음성 (VieNeu-TTS)",
            ja: "ベトナム語音声 (VieNeu-TTS)",
            zh: "越南语语音 (VieNeu-TTS)",
          })}
        </h3>
        <p className="mt-1 text-xs" style={{ color: "var(--th-text-secondary)" }}>
          {t({
            en: "Generate MP3 narration with VieNeu-TTS. Audio is stored under the selected task's project, or in the server audio folder for previews.",
            ko: "VieNeu-TTS로 MP3 내레이션을 생성합니다. 오디오는 선택한 작업 프로젝트 또는 미리 듣기용 서버 오디오 폴더에 저장됩니다.",
            ja: "VieNeu-TTSでMP3ナレーションを生成します。音声は選択したタスクのプロジェクト、またはプレビュー用サーバーフォルダーに保存されます。",
            zh: "使用 VieNeu-TTS 生成 MP3 旁白，音频保存在所选任务的项目或试听用服务器目录中。",
          })}
        </p>
      </div>
      <form onSubmit={submit} className="space-y-3">
        <label
          htmlFor="speech-project-task"
          className="block space-y-1 text-xs"
          style={{ color: "var(--th-text-secondary)" }}
        >
          <span>{t({ en: "Project task", ko: "프로젝트 작업", ja: "プロジェクトタスク", zh: "项目任务" })}</span>
          <select
            id="speech-project-task"
            value={taskId}
            onChange={(event) => setTaskId(event.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-sm"
            style={inputStyle}
          >
            <option value="">
              {t({
                en: "Standalone preview (server audio folder)",
                ko: "미리 듣기 (서버 오디오 폴더)",
                ja: "プレビュー（サーバーフォルダー）",
                zh: "试听（服务器目录）",
              })}
            </option>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title} · {task.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1 text-xs" style={{ color: "var(--th-text-secondary)" }}>
          <span>{t({ en: "Narration text", ko: "내레이션 문장", ja: "ナレーションテキスト", zh: "旁白文本" })}</span>
          <textarea
            required
            maxLength={40_000}
            rows={4}
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="w-full resize-y rounded-lg border px-3 py-2 text-sm"
            style={inputStyle}
          />
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label
            htmlFor="speech-voice"
            className="block space-y-1 text-xs"
            style={{ color: "var(--th-text-secondary)" }}
          >
            <span>{t({ en: "Voice", ko: "음성", ja: "音声", zh: "声音" })}</span>
            <select
              id="speech-voice"
              value={voice}
              onChange={(event) => setVoice(event.target.value as VieNeuVoice)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
              style={inputStyle}
            >
              {VIENEU_VOICES.map((v) => (
                <option key={v} value={v}>
                  {v} ·{" "}
                  {v === "Minh Quân"
                    ? t({ en: "male", ko: "남성", ja: "男性", zh: "男声" })
                    : t({ en: "female", ko: "여성", ja: "女性", zh: "女声" })}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-xs" style={{ color: "var(--th-text-secondary)" }}>
            <span>
              {t({ en: "Speed", ko: "속도", ja: "速度", zh: "速度" })}: {speed.toFixed(1)}x
            </span>
            <input
              type="range"
              min={VIENEU_SPEED_MIN}
              max={VIENEU_SPEED_MAX}
              step={0.1}
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
              className="w-full accent-teal-700"
            />
          </label>
        </div>
        <button
          type="submit"
          disabled={busy || !text.trim()}
          className="rounded-lg px-4 py-2 text-sm font-medium text-white transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          style={{ background: "#237c73" }}
        >
          {busy
            ? t({ en: "Generating…", ko: "생성 중…", ja: "生成中…", zh: "正在生成…" })
            : t({ en: "Generate speech", ko: "음성 생성", ja: "音声を生成", zh: "生成语音" })}
        </button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-red-500">
          {error}
        </p>
      )}
      <div className="divide-y" style={{ borderColor: "var(--th-card-border)" }}>
        {jobs.map((job) => (
          <article key={job.id} className="space-y-2 py-3">
            <div
              className="flex flex-wrap items-center justify-between gap-2 text-xs"
              style={{ color: "var(--th-text-secondary)" }}
            >
              <span>
                {job.status === "done"
                  ? `${job.voice} · ${job.engine || "vieneu-tts"} · ${job.durationSeconds?.toFixed(2)}s · ${job.bytes?.toLocaleString()} bytes`
                  : `${job.status}${job.error ? ` · ${job.error}` : ""}`}
              </span>
              {job.audioUrl && (
                <a href={job.audioUrl} download={`narration-${job.id}.mp3`} className="underline underline-offset-2">
                  {t({ en: "Download MP3", ko: "MP3 다운로드", ja: "MP3をダウンロード", zh: "下载 MP3" })}
                </a>
              )}
            </div>
            {job.audioUrl && <audio controls preload="none" className="h-9 w-full" src={job.audioUrl} />}
            {job.outputPath && (
              <code className="block break-all text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                {job.outputPath}
              </code>
            )}
          </article>
        ))}
        {!jobs.length && (
          <p className="py-3 text-xs" style={{ color: "var(--th-text-secondary)" }}>
            {t({
              en: "No speech generated in this server session yet.",
              ko: "이 서버 세션에서 생성한 음성이 아직 없습니다.",
              ja: "このサーバーセッションではまだ音声が生成されていません。",
              zh: "此服务器会话中尚未生成语音。",
            })}
          </p>
        )}
      </div>
    </section>
  );
}
