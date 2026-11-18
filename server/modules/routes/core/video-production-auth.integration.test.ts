import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_AUTH_TOKEN } from "../../../config/runtime.ts";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { ensureVideoProductionSchema } from "../../bootstrap/schema/video-production-schema.ts";
import { registerVideoProductionRoutes } from "./video-production.ts";
import { registerChatMessageRoutes } from "../ops/messages/chat-routes.ts";
import { ingestVideoProductionDirective } from "../../workflow/video-production.ts";
import { getCsrfToken, installSecurityMiddleware } from "../../../security/auth.ts";

const isolation = vi.hoisted(() => ({ ready: false }));
vi.mock("../../workflow/worker-isolation.ts", () => ({
  isWorkerIsolationReady: () => isolation.ready,
}));

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  isolation.ready = false;
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  applyBaseSchema(db);
  ensureVideoProductionSchema(db);
  db.prepare("INSERT INTO departments(id,name,name_ko,icon,color) VALUES('operations','Operations','Operations','O','#123456')").run();
  const production = ingestVideoProductionDirective(db, {
    messageId: "auth-integration-directive",
    content: "[video_production] Make a short launch video",
    projectPath: process.cwd(),
    brief: {
      title: "Launch", objective: "Explain", targetAudience: "Customers", duration: "30s",
      aspectRatio: "9:16", language: "Vietnamese", style: "Documentary", deliveryPlatform: "Shorts", constraints: "",
    },
  });
  const app = express();
  installSecurityMiddleware(app);
  registerVideoProductionRoutes({ app, db, broadcast: vi.fn() } as never);
  registerChatMessageRoutes({ app, db, broadcast: vi.fn() } as never, {
    IdempotencyConflictError: class extends Error {},
    StorageBusyError: class extends Error {},
    firstQueryValue: (value: unknown) => typeof value === "string" ? value : undefined,
    resolveMessageIdempotencyKey: () => "video-brief-auth-test",
    recordMessageIngressAuditOr503: () => true,
    insertMessageWithIdempotency: async () => { throw new Error("guard should reject before message insert"); },
    recordAcceptedIngressAuditOrRollback: async () => true,
    normalizeTextField: (value: unknown) => typeof value === "string" ? value : null,
    handleReportRequest: () => false,
    scheduleAgentReply: vi.fn(),
    detectMentions: () => ({ deptIds: [], agentIds: [] }),
    resolveLang: () => "en",
    handleMentionDelegation: vi.fn(),
  } as never);
  return { app, db, production };
}

describe("video production routes with real auth middleware", () => {
  it("rejects loopback worker bootstrap and unauthenticated/CSRF-only privileged decisions", async () => {
    const { app, db, production } = fixture();
    const url = `/api/projects/${production.project_id}/video-production/decision`;
    await request(app).get("/api/auth/session").expect(401);
    await request(app).get("/api/auth/session").set("authorization", "Bearer worker-scoped-token").expect(401);
    await request(app).post(url).set("x-csrf-token", getCsrfToken()).send({ version: 1, decision: "approve" }).expect(401);
    await request(app).post(url).set("authorization", "Bearer worker-scoped-token").set("x-csrf-token", getCsrfToken()).send({ version: 1, decision: "approve" }).expect(401);
    expect(db.prepare("SELECT approved_version FROM video_productions WHERE project_id=?").get(production.project_id)).toEqual({ approved_version: null });
  });

  it("requires route-level CSRF and verified isolation before plan or approval writes", async () => {
    const { app, db, production } = fixture();
    const url = `/api/projects/${production.project_id}/video-production`;
    const ceo = `Bearer ${SESSION_AUTH_TOKEN}`;
    await request(app).post(`${url}/decision`).set("authorization", "Bearer worker-scoped-token").set("x-csrf-token", getCsrfToken()).send({ version: 1, decision: "approve" }).expect(401);
    await request(app).post(`${url}/decision`).set("authorization", ceo).send({ version: 1, decision: "approve" }).expect(403);
    await request(app).post(`${url}/decision`).set("authorization", ceo).set("x-csrf-token", getCsrfToken()).send({ version: 1, decision: "approve", actorId: "forged" }).expect(503);
    await request(app).put(`${url}/plan`).set("authorization", ceo).set("x-csrf-token", getCsrfToken()).send({ expectedVersion: 1, brief: { title: "Changed" } }).expect(503);
    const briefMessage = {
      sender_type: "ceo", sender_id: "worker-claimed", receiver_type: "agent", receiver_id: production.manager_agent_id,
      project_id: production.project_id, content: "[VIDEO_BRIEF] {\"expectedVersion\":1}",
    };
    await request(app).post("/api/messages").set("authorization", "Bearer worker-scoped-token").set("x-csrf-token", getCsrfToken()).send(briefMessage).expect(401);
    await request(app).post("/api/messages").set("authorization", ceo).set("x-csrf-token", getCsrfToken()).send(briefMessage).expect(503);
    await request(app).post("/api/messages").set("authorization", ceo).set("x-csrf-token", getCsrfToken()).send({
      sender_type: "ceo", sender_id: "worker-claimed", receiver_type: "agent", receiver_id: production.manager_agent_id,
      project_id: production.project_id, content: "[VIDEO_BRIEF] {\"expectedVersion\":1}",
    }).expect(503);
    expect(db.prepare("SELECT approved_version,plan_version FROM video_productions WHERE project_id=?").get(production.project_id)).toEqual({ approved_version: null, plan_version: 1 });
  });

  it("accepts an actual CEO bearer session only when the isolated runtime dependency is verified", async () => {
    const { app, db, production } = fixture();
    isolation.ready = true;
    const response = await request(app)
      .post(`/api/projects/${production.project_id}/video-production/decision`)
      .set("authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
      .set("x-csrf-token", getCsrfToken())
      .send({ version: 1, decision: "approve", actorId: "forged-worker" })
      .expect(200);
    expect(response.body.production.state).toBe("APPROVED");
    expect(response.body.production.decisions[0].actor_id).toBe("ceo_session");
    expect(db.prepare("SELECT approved_version FROM video_productions WHERE project_id=?").get(production.project_id)).toEqual({ approved_version: 1 });
  });
});
