import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../config/runtime.ts", () => ({ CLI_WORKER_RUNTIME_MODE: "host" }));

const childProcessMocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: childProcessMocks.execFileSync,
}));

import { ensureVideoPreprodRemotionBestPracticesSkill } from "./video-skill-bootstrap";

describe("ensureVideoPreprodRemotionBestPracticesSkill", () => {
  beforeEach(() => {
    childProcessMocks.execFileSync.mockReset();
    childProcessMocks.execFileSync.mockReturnValue(Buffer.from(""));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("installs the remotion skill for kimi video-preprod agents", () => {
    const db = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => null),
        run: vi.fn(() => undefined),
      })),
    };

    const result = ensureVideoPreprodRemotionBestPracticesSkill({
      db: db as any,
      nowMs: () => 1_000,
      workflowPackKey: "video_preprod",
      provider: "kimi",
    });

    expect(result).toEqual({
      state: "installed",
      command: expect.stringContaining("--agent kimi-code"),
    });
    if (process.platform === "win32") {
      expect(childProcessMocks.execFileSync).toHaveBeenCalledWith(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", expect.stringMatching(/^npx\.cmd .*--agent kimi-code\b/)],
        expect.any(Object),
      );
    } else {
      expect(childProcessMocks.execFileSync).toHaveBeenCalledWith(
        "npx",
        expect.arrayContaining(["--agent", "kimi-code"]),
        expect.any(Object),
      );
    }
  });
});
