import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { ensureVideoProductionSchema } from "../../bootstrap/schema/video-production-schema.ts";
import { ingestVideoProductionDirective } from "../../workflow/video-production.ts";
import { grantVideoProductionProjectAgent, issueVideoProductionCredential, resolveVideoProductionActor } from "../../workflow/video-production-rbac.ts";
import { registerVideoProductionRoutes } from "./video-production.ts";
import { getCsrfToken, installSecurityMiddleware, VIDEO_PRODUCTION_AGENT_CAPABILITY_HEADER } from "../../../security/auth.ts";
import { SESSION_AUTH_TOKEN } from "../../../config/runtime.ts";

const isolation = vi.hoisted(() => ({ ready: false }));
vi.mock("../../workflow/worker-isolation.ts", () => ({ isWorkerIsolationReady: () => isolation.ready }));

const databases: DatabaseSync[] = [];
afterEach(() => { isolation.ready = false; for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  applyBaseSchema(db);
  ensureVideoProductionSchema(db);
  for (const [id, name] of [["operations", "Operations"], ["planning", "Planning"], ["design", "Design"], ["dev", "Development"], ["qa", "QA"], ["devsecops", "DevSecOps"]]) {
    db.prepare("INSERT INTO departments(id,name,name_ko,icon,color) VALUES(?,?,?,?,?)").run(id, name, name, "D", "#777");
  }
  const app = express();
  installSecurityMiddleware(app, {
    resolveVideoProductionAgent: (token, projectId, action) => resolveVideoProductionActor(db, token, projectId, action, { enabled: true, isolationReady: true }),
  });
  const broadcast = vi.fn();
  registerVideoProductionRoutes({ app, db, broadcast } as never);
  app.get("/api/tasks/:id", (_req, res) => res.json({ ok: true }));
  return { db, app, broadcast };
}

const auth = () => ({ authorization: `Bearer ${SESSION_AUTH_TOKEN}`, "x-csrf-token": getCsrfToken() });

describe("Video Production RBAC route integration", () => {
  it("uses real middleware and SQLite for opt-in setup, new-project Dami grant, scoped plan and CEO decision boundaries", async () => {
    const { db, app } = fixture();
    await request(app).post("/api/video-production/organization/setup").set(auth()).send({}).expect(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM video_production_agent_roles").get()).toEqual({ n: 8 });
    expect(db.prepare("SELECT value FROM settings WHERE key='officePackHydratedPacks'").get()).toEqual({ value: '["video_production"]' });

    const production = ingestVideoProductionDirective(db, {
      messageId: "rbac-route-directive", content: "Studio plan", projectPath: process.cwd(),
      brief: { title: "Studio", objective: "Explain", targetAudience: "Viewers", duration: "30s", aspectRatio: "16:9", language: "English", style: "Documentary", deliveryPlatform: "Web", constraints: "" },
    });
    const grant = db.prepare("SELECT grant_key FROM video_production_project_grants WHERE project_id=? AND agent_id=?").get(production.project_id, production.manager_agent_id);
    expect(grant).toEqual({ grant_key: "coordinator" });
    const issued = issueVideoProductionCredential(db, {
      projectId: production.project_id, agentId: production.manager_agent_id, scopes: ["studio.read", "plan.update", "task.assign"],
      issuedBy: "ceo_session", expiresAt: Date.now() + 60_000,
    }, { enabled: true, isolationReady: true });
    const headers = { [VIDEO_PRODUCTION_AGENT_CAPABILITY_HEADER]: issued.token };
    const organization = await request(app).get(`/api/projects/${production.project_id}/video-production/organization`).set(headers).expect(200);
    expect(organization.body).toMatchObject({ configured: true, agents: expect.arrayContaining([expect.objectContaining({ id: "video_production-seed-5", role_key: "production_manager" })]) });
    expect(organization.body.grants).toEqual(expect.arrayContaining([expect.objectContaining({ agent_id: production.manager_agent_id, grant_key: "coordinator" })]));

    isolation.ready = true;
    await request(app).put(`/api/projects/${production.project_id}/video-production/plan`).set(headers).send({
      actorId: "forged-ceo", role: "ceo", expectedVersion: 1, brief: { title: "Changed", objective: "Explain", targetAudience: "Viewers", duration: "30s", aspectRatio: "16:9", language: "English", style: "Documentary", deliveryPlatform: "Web", constraints: "" },
    }).expect(200);
    expect(db.prepare("SELECT plan_version FROM video_productions WHERE project_id=?").get(production.project_id)).toEqual({ plan_version: 2 });
    expect(db.prepare("SELECT actor_id FROM video_production_events WHERE project_id=? AND event='plan_saved' ORDER BY id DESC LIMIT 1").get(production.project_id)).toEqual({ actor_id: production.manager_agent_id });
    const director = "video_production-role-director";
    const directorGrant = await request(app).post(`/api/projects/${production.project_id}/video-production/agents/${director}/grant`).set(auth()).send({ grant_key: "member" }).expect(200);
    expect(directorGrant.body.grant).toMatchObject({ agent_id: director, grant_key: "member", granted_by: "ceo_session" });
    const readOnly = issueVideoProductionCredential(db, { projectId: production.project_id, agentId: director, scopes: ["studio.read"], issuedBy: "ceo_session", expiresAt: Date.now() + 60_000 }, { enabled: true, isolationReady: true });
    await request(app).put(`/api/projects/${production.project_id}/video-production/plan`).set({ [VIDEO_PRODUCTION_AGENT_CAPABILITY_HEADER]: readOnly.token })
      .send({ expectedVersion: 2, brief: organization.body.production.brief }).expect(401);
    const projectB = ingestVideoProductionDirective(db, {
      messageId: "rbac-route-directive-b", content: "Another studio plan", projectPath: `${process.cwd()}\\rbac-project-b`,
      brief: { title: "Studio B", objective: "Explain", targetAudience: "Viewers", duration: "30s", aspectRatio: "16:9", language: "English", style: "Documentary", deliveryPlatform: "Web", constraints: "" },
    });
    const damiB = issueVideoProductionCredential(db, {
      projectId: projectB.project_id, agentId: projectB.manager_agent_id, scopes: ["studio.read"], issuedBy: "ceo_session", expiresAt: Date.now() + 60_000,
    }, { enabled: true, isolationReady: true });
    await request(app).get(`/api/projects/${projectB.project_id}/video-production/organization`).set(headers).expect(401);
    await request(app).get(`/api/projects/${projectB.project_id}/video-production/organization`).set({ [VIDEO_PRODUCTION_AGENT_CAPABILITY_HEADER]: damiB.token }).expect(200);
    const miro = "video_production-role-video-producer";
    grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId: miro, grantedBy: "ceo_session" });
    const miroToken = issueVideoProductionCredential(db, {
      projectId: production.project_id, agentId: miro, scopes: ["studio.read"], issuedBy: "ceo_session", expiresAt: Date.now() + 60_000,
    }, { enabled: true, isolationReady: true });
    const grantsBefore = db.prepare("SELECT COUNT(*) AS count FROM video_production_project_grants WHERE project_id=?").get(production.project_id);
    await request(app).post(`/api/projects/${production.project_id}/video-production/agents/${production.manager_agent_id}/grant`)
      .set({ [VIDEO_PRODUCTION_AGENT_CAPABILITY_HEADER]: miroToken.token }).send({ role: "ceo", agent_id: production.manager_agent_id, grant_key: "coordinator" }).expect(401);
    await request(app).patch(`/api/agents/${production.manager_agent_id}`).set({ [VIDEO_PRODUCTION_AGENT_CAPABILITY_HEADER]: miroToken.token })
      .send({ role: "ceo", agent_id: production.manager_agent_id }).expect(401);
    expect(db.prepare("SELECT COUNT(*) AS count FROM video_production_project_grants WHERE project_id=?").get(production.project_id)).toEqual(grantsBefore);
    isolation.ready = false;
    await request(app).post(`/api/projects/${production.project_id}/video-production/decision`).set(auth()).send({ version: 1, decision: "approve" }).expect(503);
    await request(app).post(`/api/projects/${production.project_id}/video-production/decision`).set(headers)
      .send({ version: 1, decision: "approve", role: "ceo", agent_id: production.manager_agent_id, actorId: "ceo_session" }).expect(401);
    expect(db.prepare("SELECT COUNT(*) AS count FROM video_production_decisions WHERE project_id=?").get(production.project_id)).toEqual({ count: 0 });
    await request(app).get("/api/tasks/any").set(headers).expect(401);
    await request(app).get(`/api/projects/other-project/video-production/organization`).set(headers).expect(401);
  });

  it("allows setup and grants with CEO+CSRF while isolation is unavailable, but does not admit spoofed or unsupported assignment", async () => {
    const { db, app } = fixture();
    db.prepare("INSERT INTO agents(id,name,name_ko,department_id,workflow_pack_key,role,acts_as_planning_leader,cli_provider) VALUES('video_production-seed-5','Dami','Dami','operations','video_production','team_leader',1,'codex')").run();
    const production = ingestVideoProductionDirective(db, {
      messageId: "rbac-config-directive", content: "Studio plan", projectPath: process.cwd(),
      brief: { title: "Studio", objective: "Explain", targetAudience: "Viewers", duration: "30s", aspectRatio: "16:9", language: "English", style: "Documentary", deliveryPlatform: "Web", constraints: "" },
    });
    await request(app).post("/api/video-production/organization/setup").set(auth()).send({}).expect(200);
    expect(db.prepare("SELECT COUNT(*) AS count FROM video_production_project_grants WHERE project_id=?").get(production.project_id)).toEqual({ count: 0 });
    await request(app).post(`/api/projects/${production.project_id}/video-production/agents/${production.manager_agent_id}/grant`).set(auth()).send({ grant_key: "coordinator" }).expect(200);
    const managerCredential = issueVideoProductionCredential(db, { projectId: production.project_id, agentId: production.manager_agent_id, scopes: ["task.assign"], issuedBy: "ceo_session", expiresAt: Date.now() + 60_000 }, { enabled: true, isolationReady: true });
    const rian = "video_production-role-director";
    await request(app).post(`/api/projects/${production.project_id}/video-production/agents/${rian}/grant`).set(auth()).send({ grant_key: "member" }).expect(200);
    isolation.ready = true;
    const managerHeaders = { [VIDEO_PRODUCTION_AGENT_CAPABILITY_HEADER]: managerCredential.token };
    await request(app).post(`/api/projects/${production.project_id}/video-production/assignments`).set(managerHeaders)
      .send({ task_id: production.root_task_id, agent_id: rian, actorId: "ceo_session", role: "ceo" }).expect(409);
    await request(app).post(`/api/projects/${production.project_id}/video-production/assignments`).set(managerHeaders)
      .send({ task_id: production.root_task_id, agent_id: production.manager_agent_id }).expect(200);
    await request(app).post(`/api/projects/${production.project_id}/video-production/assignments`).set(managerHeaders)
      .send({ task_id: production.root_task_id, agent_id: production.manager_agent_id }).expect(200);
    await request(app).post(`/api/projects/${production.project_id}/video-production/assignments`).set(auth())
      .send({ task_id: production.root_task_id, agent_id: rian, actorId: "ceo_session", role: "production_manager" }).expect(409);
    await request(app).post(`/api/projects/${production.project_id}/video-production/assignments`).set(auth())
      .send({ task_id: production.root_task_id, agent_id: production.manager_agent_id }).expect(200);
    isolation.ready = false;
    const assigned = await request(app).post(`/api/projects/${production.project_id}/video-production/assignments`).set(auth())
      .send({ task_id: production.root_task_id, agent_id: "not-a-stage-owner", actorId: "ceo_session", role: "production_manager" }).expect(503);
    expect(assigned.body.error).toBe("requires_worker_isolation");
    expect(db.prepare("SELECT assigned_agent_id FROM tasks WHERE id=?").get(production.root_task_id)).toEqual({ assigned_agent_id: production.manager_agent_id });
    await request(app).delete(`/api/projects/${production.project_id}/video-production/agents/${rian}/grant`).set(auth()).expect(200);
  });
});
