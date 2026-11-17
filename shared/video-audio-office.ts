export const VIDEO_AUDIO_PACK = "video_preprod";
export const VIDEO_AUDIO_AGENT_ID = "video_preprod-seed-99";
export const VIDEO_AUDIO_OFFICE_SEEDED_KEY = "videoAudioOfficeSeeded";

export const VIDEO_AUDIO_DEPARTMENT = {
  id: "voice_audio",
  name: "Voice & Audio",
  name_ko: "음성 및 오디오",
  name_ja: "音声・オーディオ",
  name_zh: "语音与音频",
  icon: "🎙️",
  color: "#0f766e",
  description: "AI voiceover generation, narration, audio production and sound processing.",
  prompt:
    "Produce Vietnamese narration from the approved script. Keep wording and pronunciation faithful to the brief, " +
    "choose an appropriate delivery and pace, and hand the Scene Engine the generated MP3 and its metadata.",
} as const;

export const VIDEO_AUDIO_AGENT = {
  name: "Audio Producer",
  name_ko: "오디오 프로듀서",
  name_ja: "オーディオプロデューサー",
  name_zh: "音频制作人",
  department_id: VIDEO_AUDIO_DEPARTMENT.id,
  role: "team_leader",
  acts_as_planning_leader: 0,
  cli_provider: "codex",
  avatar_emoji: VIDEO_AUDIO_DEPARTMENT.icon,
  personality:
    "Specializes in clear Vietnamese narration. Adapts pace and delivery to the brief, preserves approved dialogue, " +
    "and coordinates audio handoff with the Scene Engine.",
} as const;
