import { beforeEach, describe, expect, it, vi } from "vitest";

import { request } from "./core";
import { decideVideoProductionPlan, getVideoProduction, saveVideoProductionPlan } from "./video-production";

vi.mock("./core", () => ({ request: vi.fn() }));

describe("video production API", () => {
  beforeEach(() => vi.resetAllMocks());

  it("uses the authenticated request helper and escapes project IDs", async () => {
    vi.mocked(request).mockResolvedValue({ production: null });
    await expect(getVideoProduction("studio/one")).resolves.toEqual({ production: null });
    expect(request).toHaveBeenCalledWith("/api/projects/studio%2Fone/video-production");
  });

  it("sends the expected plan version with a structured brief", async () => {
    const brief = {
      title: "Launch",
      objective: "Introduce",
      targetAudience: "Creators",
      duration: "30s",
      aspectRatio: "16:9",
      language: "Vietnamese",
      style: "Documentary",
      deliveryPlatform: "YouTube",
      constraints: "",
    };
    await saveVideoProductionPlan("studio", brief, 3);
    expect(request).toHaveBeenCalledWith("/api/projects/studio/video-production/plan", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief, expectedVersion: 3 }),
    });
  });

  it("binds approval to the displayed version and does not retry conflicts", async () => {
    const conflict = new Error("stale plan");
    vi.mocked(request).mockRejectedValue(conflict);
    await expect(decideVideoProductionPlan("studio", 3, "approve", "Ready")).rejects.toBe(conflict);
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/projects/studio/video-production/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 3, decision: "approve", note: "Ready" }),
    });
  });
});
