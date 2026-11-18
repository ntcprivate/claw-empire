import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_AUTH_TOKEN } from "../config/runtime.ts";
import {
  getVideoProductionAuthenticatedAgent,
  installSecurityMiddleware,
  VIDEO_PRODUCTION_AGENT_CAPABILITY_HEADER,
} from "./auth.ts";

const apps: ReturnType<typeof express>[] = [];
afterEach(() => { apps.splice(0); });

function createApp() {
  const app = express();
  apps.push(app);
  installSecurityMiddleware(app, {
    resolveVideoProductionAgent: (token, projectId, action) => token === "valid-scoped-token"
      ? { kind: "agent", agentId: "agent-from-server", projectId, roleKey: "director", credentialId: "cred-1", action }
      : null,
  });
  app.get("/api/projects/:id/video-production/organization", (req, res) => {
    res.json({ actor: getVideoProductionAuthenticatedAgent(req), setCookie: res.getHeader("set-cookie") ?? null });
  });
  app.put("/api/projects/:id/video-production/plan", (_req, res) => res.json({ ok: true }));
  app.get("/api/tasks/:id", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("narrow Video Production agent authentication hook", () => {
  it("accepts only the exact allowlisted route and sets server-owned identity without issuing CEO cookies", async () => {
    const app = createApp();
    const response = await request(app).get("/api/projects/project_1/video-production/organization")
      .set(VIDEO_PRODUCTION_AGENT_CAPABILITY_HEADER, "valid-scoped-token")
      .set("agent_id", "spoofed")
      .set("role", "ceo")
      .expect(200);
    expect(response.body.actor).toMatchObject({ agentId: "agent-from-server", roleKey: "director", projectId: "project_1", action: "studio.read" });
    expect(response.body.setCookie).toBeNull();
  });

  it("rejects generic APIs, auth/session bootstrap, CEO+agent ambiguity, and path variants", async () => {
    const app = createApp();
    await request(app).get("/api/tasks/task-1").set(VIDEO_PRODUCTION_AGENT_CAPABILITY_HEADER, "valid-scoped-token").expect(401);
    await request(app).get("/api/auth/session").set(VIDEO_PRODUCTION_AGENT_CAPABILITY_HEADER, "valid-scoped-token").expect(401);
    await request(app).get("/api/auth/session")
      .set("authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
      .set(VIDEO_PRODUCTION_AGENT_CAPABILITY_HEADER, "valid-scoped-token").expect(401);
    await request(app).get("/api/projects/project_1//video-production/organization")
      .set(VIDEO_PRODUCTION_AGENT_CAPABILITY_HEADER, "valid-scoped-token").expect(401);
    await request(app).get("/api/projects/project_1/video-production/organization/")
      .set(VIDEO_PRODUCTION_AGENT_CAPABILITY_HEADER, "valid-scoped-token").expect(401);
    await request(app).get("/api/projects/project_1%2Fother/video-production/organization")
      .set(VIDEO_PRODUCTION_AGENT_CAPABILITY_HEADER, "valid-scoped-token").expect(401);
  });
});
