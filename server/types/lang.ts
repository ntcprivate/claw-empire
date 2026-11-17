export type Lang = "ko" | "en" | "ja" | "zh" | "vi";

export const SUPPORTED_LANGS: readonly Lang[] = ["ko", "en", "ja", "zh", "vi"] as const;

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && SUPPORTED_LANGS.includes(value as Lang);
}
