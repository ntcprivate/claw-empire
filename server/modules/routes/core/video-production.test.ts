import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { ensureVideoProductionSchema } from "../../workflow/video-production.ts";
import {
  createMessageIdempotencyTools,
  IdempotencyConflictError,
  StorageBusyError,
} from "../../bootstrap/message-idempotency.ts";
import { registerDirectiveAndInboxRoutes } from "../ops/messages/directives-inbox-routes.ts";
import { registerAnnouncementRoutes } from "../ops/messages/announcements-routes.ts";
import { registerChatMessageRoutes } from "../ops/messages/chat-routes.ts";
import { registerVideoProductionRoutes } from "./video-production.ts";
import { registerProjectRoutes } from "./projects.ts";
import { createDirectChatHandlers } from "../collab/direct-chat-handlers.ts";
import type { RuntimeContext } from "../../../types/runtime-context.ts";

vi.mock("../../../security/auth.ts", () => ({
  isAuthenticated: (req: express.Request) => req.header("x-test-session") === "ceo",
  hasValidCsrfToken: (req: express.Request) => req.header("x-test-csrf") === "valid",
  safeSecretEquals: (a: string, b: string) => a === b,
  getVideoProductionAuthenticatedAgent: () => null,
}));
vi.mock("../../workflow/worker-isolation.ts", () => ({ isWorkerIsolationReady: () => true }));

const brief = {
  title: "Studio launch",
  objective: "Explain our studio",
  targetAudience: "Small businesses",
  duration: "60 seconds",
  aspectRatio: "9:16",
  language: "Vietnamese",
  style: "Documentary",
  deliveryPlatform: "Shorts",
  constraints: "No paid assets",
};
const databases: DatabaseSync[] = [];
function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  applyBaseSchema(db);
  ensureVideoProductionSchema(db);
  db.prepare(
    "INSERT INTO departments(id,name,name_ko,icon,color) VALUES('operations','Operations','Operations','O','#123456')",
  ).run();
  const app = express();
  app.use(express.json());
  const broadcast = vi.fn();
  const delegation = vi.fn();
  const replies = vi.fn();
  const messages = createMessageIdempotencyTools({
    db,
    nowMs: Date.now,
    sleepMs: async () => {},
    SQLITE_BUSY_RETRY_BASE_DELAY_MS: 0,
    SQLITE_BUSY_RETRY_JITTER_MS: 0,
    SQLITE_BUSY_RETRY_MAX_ATTEMPTS: 0,
    SQLITE_BUSY_RETRY_MAX_DELAY_MS: 0,
  });
  registerDirectiveAndInboxRoutes(
    { app, db, broadcast } as unknown as Pick<RuntimeContext, "app" | "db" | "broadcast">,
    {
      ...messages,
      IdempotencyConflictError,
      StorageBusyError,
      enforceDirectiveProjectBinding: true,
      normalizeTextField: (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null),
      recordMessageIngressAuditOr503: () => true,
      recordAcceptedIngressAuditOrRollback: async () => true,
      handleTaskDelegation: delegation,
      scheduleAnnouncementReplies: replies,
      analyzeDirectivePolicy: () => ({ skipPlannedMeeting: false, skipPlanSubtasks: false }),
      shouldExecuteDirectiveDelegation: () => true,
      findTeamLeader: () => null,
      scheduleAgentReply: vi.fn(),
      resetDirectChatState: vi.fn(),
      detectMentions: () => ({ deptIds: ["design"], agentIds: [] }),
    } as never,
  );
  registerVideoProductionRoutes({ app, db, broadcast } as unknown as Pick<RuntimeContext, "app" | "db" | "broadcast">);
  registerProjectRoutes({
    app,
    db,
    nowMs: Date.now,
    normalizeTextField: (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null),
    firstQueryValue: (v: unknown) => (typeof v === "string" ? v : undefined),
    runInTransaction: (fn) => fn(),
  });
  registerAnnouncementRoutes(
    { app, db, broadcast } as never,
    {
      ...messages,
      IdempotencyConflictError,
      StorageBusyError,
      recordMessageIngressAuditOr503: () => true,
      recordAcceptedIngressAuditOrRollback: async () => true,
      scheduleAnnouncementReplies: replies,
      detectMentions: () => ({ deptIds: [], agentIds: [] }),
      findTeamLeader: () => null,
      handleTaskDelegation: delegation,
    } as never,
  );
  registerChatMessageRoutes(
    { app, db, broadcast } as never,
    {
      ...messages,
      IdempotencyConflictError,
      StorageBusyError,
      normalizeTextField: (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null),
      recordMessageIngressAuditOr503: () => true,
      recordAcceptedIngressAuditOrRollback: async () => true,
      scheduleAgentReply: replies,
      handleReportRequest: () => false,
      detectMentions: () => ({ deptIds: [], agentIds: [] }),
      firstQueryValue: (v: unknown) => (typeof v === "string" ? v : undefined),
      resolveLang: () => "en",
      handleMentionDelegation: delegation,
    } as never,
  );
  return { app, db, delegation, replies };
}
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.clearAllMocks();
});

describe("Video production CEO directive foundation", () => {
  it("creates once, links the source directive, routes only to the configured PM and never starts legacy work", async () => {
    const { app, db, delegation, replies } = fixture();
    const body = { content: "[video_production] Create our launch video @design", project_path: process.cwd(), brief };
    const first = await request(app).post("/api/directives").send(body).expect(200);
    expect(first.body.production.state).toBe("WAITING_FOR_APPROVAL");
    const productionId = first.body.production.project_id;
    const source = db.prepare("SELECT message_id FROM video_productions WHERE project_id=?").get(productionId);
    expect(source).toMatchObject({ message_id: first.body.message.id });
    expect(first.body.production.manager_agent_id).toBe("video_production-seed-5");
    const retry = await request(app).post("/api/directives").send(body).expect(200);
    expect(retry.body.production.project_id).toBe(productionId);
    expect(retry.body.duplicate).toBe(true);
    expect(db.prepare("SELECT count(*) AS n FROM projects").get()).toMatchObject({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM tasks").get()).toMatchObject({ n: 1 });
    expect(delegation).not.toHaveBeenCalled();
    expect(replies).not.toHaveBeenCalled();
  });

  it("persists an incomplete brief, accepts a versioned plan and requires authenticated CSRF-protected CEO approval", async () => {
    const { app, db } = fixture();
    const intake = await request(app)
      .post("/api/directives")
      .send({ content: "[video_production] Make a video", project_path: process.cwd() })
      .expect(200);
    let production = intake.body.production;
    expect(production.state).toBe("NEEDS_INFORMATION");
    const url = `/api/projects/${production.project_id}/video-production`;
    await request(app)
      .post(`${url}/decision`)
      .send({ version: production.plan_version, decision: "approve", actorId: "ceo" })
      .expect(401);
    await request(app)
      .post(`${url}/decision`)
      .set("x-test-session", "ceo")
      .send({ version: production.plan_version, decision: "approve" })
      .expect(403);
    const saved = await request(app)
      .put(`${url}/plan`)
      .set("x-test-session", "ceo")
      .set("x-test-csrf", "valid")
      .send({ brief, expectedVersion: production.plan_version })
      .expect(200);
    production = saved.body.production;
    expect(production.state).toBe("WAITING_FOR_APPROVAL");
    await request(app)
      .post(`${url}/decision`)
      .set("x-test-session", "ceo")
      .set("x-test-csrf", "valid")
      .send({ version: production.plan_version - 1, decision: "approve" })
      .expect(409);
    const approved = await request(app)
      .post(`${url}/decision`)
      .set("x-test-session", "ceo")
      .set("x-test-csrf", "valid")
      .send({ version: production.plan_version, decision: "approve", actorId: "forged-agent" })
      .expect(200);
    expect(approved.body.production.state).toBe("APPROVED");
    expect(approved.body.production.decisions[0].actor_id).toBe("ceo_session");
    expect(
      approved.body.production.stages.filter(
        (stage: { status: string }) => stage.status === "READY" || stage.status === "RUNNING",
      ),
    ).toHaveLength(0);
    expect(db.prepare("SELECT count(*) AS n FROM tasks WHERE status='in_progress'").get()).toMatchObject({ n: 0 });
    const loaded = await request(app).get(url).set("x-test-session", "ceo").expect(200);
    expect(loaded.body.production.approved_version).toBe(production.plan_version);
  });

  it("keeps normal directive behavior and rejects production paths without guessing", async () => {
    const { app, replies, db } = fixture();
    await request(app).post("/api/directives").send({ content: "A normal directive" }).expect(428);
    await request(app).post("/api/directives").send({ content: "[video_production] Make a video" }).expect(400);
    await request(app)
      .post("/api/directives")
      .send({ content: "[video_production] Make a video", project_path: "relative/path" })
      .expect(400);
    expect(replies).not.toHaveBeenCalled();
    await request(app).post("/api/announcements").send({ content: "Welcome to the studio" }).expect(200);
    expect(replies).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT count(*) AS n FROM projects").get()).toMatchObject({ n: 0 });
  });

  it("binds an empty selected project explicitly and accepts a validated brief reply through existing conversation", async () => {
    const { app, db, replies } = fixture();
    db.prepare("INSERT INTO projects(id,name,project_path,core_goal) VALUES('selected','Selected',?,'Goal')").run(
      process.cwd(),
    );
    const intake = await request(app)
      .post("/api/directives")
      .send({ content: "[video_production] Plan this video", project_id: "selected" })
      .expect(200);
    expect(db.prepare("SELECT default_pack_key FROM projects WHERE id='selected'").get()).toMatchObject({
      default_pack_key: "video_production",
    });
    expect(intake.body.production.state).toBe("NEEDS_INFORMATION");
    const generation = vi.fn(() => {
      throw new Error("Production conversation must not launch a provider");
    });
    const planningReply = vi.fn();
    const chat = createDirectChatHandlers({
      db,
      nowMs: Date.now,
      sendAgentMessage: planningReply,
      runAgentOneShot: generation,
      executeApiProviderAgent: generation,
    } as never);
    chat.scheduleAgentReply(intake.body.production.manager_agent_id, "Start producing immediately", "chat", {
      projectId: "selected",
    });
    expect(generation).not.toHaveBeenCalled();
    expect(planningReply).toHaveBeenCalledWith(
      expect.objectContaining({ id: intake.body.production.manager_agent_id }),
      expect.stringContaining("automatic planning reply"),
    );
    const reply = await request(app)
      .post("/api/messages")
      .send({
        receiver_type: "agent",
        receiver_id: intake.body.production.manager_agent_id,
        project_id: "selected",
        content: `[VIDEO_BRIEF] ${JSON.stringify({ expectedVersion: 1, brief })}`,
      })
      .set("x-test-session", "ceo")
      .set("x-test-csrf", "valid")
      .expect(200);
    expect(reply.body.production.state).toBe("WAITING_FOR_APPROVAL");
    expect(reply.body.production.plan_version).toBe(2);
    expect(reply.body.production.approved_version).toBeNull();
    await request(app).patch("/api/projects/selected").send({ default_pack_key: "development" }).expect(409);
    await request(app)
      .patch("/api/projects/selected")
      .send({ project_path: process.cwd() + "/other" })
      .expect(409);
    await request(app).delete("/api/projects/selected").expect(409);
    expect(replies).not.toHaveBeenCalled();
    expect(db.prepare("SELECT count(*) AS n FROM tasks").get()).toMatchObject({ n: 1 });
  });
});
