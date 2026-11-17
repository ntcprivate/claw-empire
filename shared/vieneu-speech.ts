export const VIENEU_VOICES = ["Minh Quân", "Mỹ Duyên"] as const;
export const DEFAULT_VIENEU_VOICE: VieNeuVoice = "Minh Quân";
export const VIENEU_SPEED_MIN = 0.7;
export const VIENEU_SPEED_MAX = 1.2;

export type VieNeuVoice = (typeof VIENEU_VOICES)[number];

export type SpeechCue = {
  text: string;
  startSeconds: number;
  endSeconds: number;
};
