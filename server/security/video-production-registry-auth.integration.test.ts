import express from "express";
import path from "node:path";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_AUTH_TOKEN } from "../config/runtime.ts";
import { applyBaseSchema } from "../modules/bootstrap/schema/base-schema.ts";
import { ensureVideoProductionSchema } from "../modules/bootstrap/schema/video-production-schema.ts";
import { registerVideoProductionRoutes } from "../modules/routes/core/video-production.ts";
import { decideVideoProduction, ingestVideoProductionDirective } from "../modules/workflow/video-production.ts";
import { issueVideoProductionAttemptCredential, resolveVideoProductionActor, seedVideoProductionOrganization } from "../modules/workflow/video-production-rbac.ts";
import { getCsrfToken, installSecurityMiddleware, matchVideoProductionAgentRoute } from "./auth.ts";

const isolation = vi.hoisted(() => ({ ready: false }));
vi.mock("../modules/workflow/worker-isolation.ts", () => ({ isWorkerIsolationReady: () => isolation.ready }));

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); isolation.ready = false; });

function fixture(options: { agentId?: string; action?: "screenplay.write" | "footage.submit"; stageKey?: string } = {}) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  applyBaseSchema(db);
  ensureVideoProductionSchema(db);
  for (const [id, name] of [["operations", "Operations"], ["planning", "Planning"], ["design", "Design"], ["dev", "Development"], ["qa", "QA"], ["devsecops", "DevSecOps"]]) {
    db.prepare("INSERT INTO departments(id,name,name_ko,icon,color) VALUES(?,?,?,?,?)").run(id, name, name, "D", "#777");
  }
  seedVideoProductionOrganization(db, "ceo_session");
  const createProject = (messageId: string) => {
    const result = ingestVideoProductionDirective(db, {
      messageId, content: "Registry auth integration", projectPath: path.join(process.cwd(), ".tmp", messageId),
      brief: { title: "Auth", objective: "Test registry", targetAudience: "Test", duration: "20s", aspectRatio: "16:9", language: "English", style: "Documentary", deliveryPlatform: "Web", constraints: "" },
    });
    decideVideoProduction(db, result.project_id, { version: 1, decision: "approve" });
    return result.project_id;
  };
  const projectA = createProject("registry-auth-a");
  const projectB = createProject("registry-auth-b");
  const agentId = options.agentId ?? "video_production-role-screenwriter";
  const action = options.action ?? "screenplay.write";
  const stageKey = options.stageKey ?? "story_development";
  const taskId = "registry-auth-task";
  const attemptId = "registry-auth-attempt";
  db.prepare("INSERT INTO video_production_project_grants(project_id,agent_id,grant_key,granted_by,created_at) VALUES(?,?,'member','ceo_session',1)").run(projectA, agentId);
  db.prepare(`INSERT INTO tasks(id,title,department_id,assigned_agent_id,project_id,status,workflow_pack_key,created_at,updated_at)
    VALUES(?,'Scoped registry task','planning',?,?,'in_progress','video_production',1,1)`).run(taskId, agentId, projectA);
  db.prepare("UPDATE agents SET current_task_id=? WHERE id=?").run(taskId, agentId);
  db.prepare("UPDATE video_production_stages SET status='RUNNING',implemented=1,task_id=? WHERE project_id=? AND stage_key=?").run(taskId, projectA, stageKey);
  db.prepare(`INSERT INTO video_production_attempts(attempt_id,task_id,project_id,state,worker_kind,plan_version,assigned_agent_id,created_at,updated_at,detail_json)
    VALUES(?,?,?,'RUNNING','fixture',1,?,1,1,'{}')`).run(attemptId, taskId, projectA, agentId);
  db.prepare("UPDATE video_production_slot SET task_id=?,attempt_id=?,acquired_at=1 WHERE singleton=1").run(taskId, attemptId);
  const credential = issueVideoProductionAttemptCredential(db, { attemptId, scopes: [action], expiresAt: 2_100_000 }, { now: 2_000_000, enabled: true, isolationReady: true });

  const app = express();
  installSecurityMiddleware(app, {
    resolveVideoProductionAgent: (token, projectId, action) => resolveVideoProductionActor(db, token, projectId, action, { now: 2_000_001, enabled: true, isolationReady: true }),
  });
  registerVideoProductionRoutes({ app, db, broadcast: vi.fn(), assetRoot: process.cwd() } as never);
  return { app, db, projectA, projectB, agentId, credential };
}

describe("Video Production registry authentication", () => {
  it("maps only exact method/path pairs to role actions and rejects wrong verbs/path variants", () => {
    const cases: Array<[string, string, string]> = [
      ["POST", "/api/projects/p/video-production/scenes", "screenplay.write"],
      ["PUT", "/api/projects/p/video-production/scenes/order", "screenplay.write"],
      ["POST", "/api/projects/p/video-production/scenes/s1/shots", "shot_spec.write"],
      ["PUT", "/api/projects/p/video-production/scenes/s1/shots/order", "shot_spec.write"],
      ["POST", "/api/projects/p/video-production/assets", "footage.submit"],
      ["POST", "/api/projects/p/video-production/visual-references/assets", "visual.manage"],
      ["POST", "/api/projects/p/video-production/takes/t1/review", "take.review"],
      ["POST", "/api/projects/p/video-production/shots/s1/regeneration", "regeneration.request"],
      ["POST", "/api/projects/p/video-production/manifests", "edit.manage"],
      ["GET", "/api/projects/p/video-production/manifests/m1", "studio.read"],
    ];
    for (const [method, path, action] of cases) expect(matchVideoProductionAgentRoute({ method, path })?.action).toBe(action);
    for (const [method, path] of [
      ["GET", "/api/projects/p/video-production/manifests"],
      ["PUT", "/api/projects/p/video-production/scenes/order/"],
      ["POST", "/api/projects/p/video-production/scenes/order"],
      ["DELETE", "/api/projects/p/video-production/decision"],
      ["POST", "/api/projects/p/video-production/scenes//shots"],
      ["POST", "/api/projects/p/video-production/shots/s1/review"],
    ]) expect(matchVideoProductionAgentRoute({ method, path })).toBeNull();
  });

  it("accepts an attempt-bound Haru write, denies CEO impersonation, wrong-role self-review and cross-project use", async () => {
    const { app, db, projectA, projectB, agentId, credential } = fixture();
    const baseA = `/api/projects/${projectA}/video-production`;
    const baseB = `/api/projects/${projectB}/video-production`;
    const capability = { "x-video-production-agent-capability": credential.token };
    const created = await request(app).post(`${baseA}/scenes`).set(capability).send({
      sceneId: "scene-auth", content: { description: "A scene", location: "Room", characters: ["Ari"], continuity: {} },
    }).expect(201);
    expect(created.body.scene.sceneId).toBe("scene-auth");
    await request(app).post(`${baseB}/scenes`).set(capability).send({
      sceneId: "scene-cross", content: { description: "A scene", location: "Room", characters: [], continuity: {} },
    }).expect(401);
    await request(app).post(`${baseA}/scenes`).set("authorization", `Bearer ${SESSION_AUTH_TOKEN}`).set("x-csrf-token", getCsrfToken())
      .send({ sceneId: "scene-ceo", content: { description: "CEO", location: "Room", characters: [], continuity: {} }, actorId: "video_production-role-screenwriter" }).expect(401);
    await request(app).post(`${baseA}/takes/fake-take/review`).set(capability).send({ decision: "approved" }).expect(401);
    await request(app).post("/api/tasks/legacy/stop").set(capability).send({}).expect(401);
    expect(db.prepare("SELECT COUNT(*) AS count FROM video_production_scenes WHERE project_id=?").get(projectA)).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM video_production_scenes WHERE project_id=?").get(projectB)).toEqual({ count: 0 });
    expect(db.prepare("SELECT created_by_agent_id FROM video_production_scene_versions WHERE project_id=? AND scene_id='scene-auth'").get(projectA)).toEqual({ created_by_agent_id: agentId });
  });

  it("serves the CEO registry as read-only while returning no mutation authority", async () => {
    const { app, db, projectA, agentId } = fixture();
    const ceo = `Bearer ${SESSION_AUTH_TOKEN}`;
    await request(app).get(`/api/projects/${projectA}/video-production/registry`).set("authorization", ceo).expect(200);
    await request(app).post(`/api/projects/${projectA}/video-production/scenes`).set("authorization", ceo).set("x-csrf-token", getCsrfToken())
      .send({ sceneId: "scene-ceo", content: { description: "No", location: "Room", characters: [], continuity: {} } }).expect(401);
    expect(db.prepare("SELECT COUNT(*) AS count FROM video_production_scenes WHERE project_id=?").get(projectA)).toEqual({ count: 0 });
    expect(agentId).toBe("video_production-role-screenwriter");
  });

  it("handles malformed upload metadata and invalid media as 4xx responses without an unhandled route rejection", async () => {
    const { app, projectA, credential } = fixture({ agentId: "video_production-role-video-producer", action: "footage.submit", stageKey: "ai_footage_production" });
    const endpoint = `/api/projects/${projectA}/video-production/assets`;
    const capability = { "x-video-production-agent-capability": credential.token };
    await request(app).post(endpoint).set(capability).set("content-type", "video/mp4")
      .set("content-length", "8").set("x-video-production-asset-id", "asset-invalid")
      .set("idempotency-key", "upload-invalid-metadata").set("x-video-production-asset-metadata", "{")
      .send(Buffer.from("0000ftyp")).expect(400);
    await request(app).post(endpoint).set(capability).set("content-type", "video/mp4")
      .set("content-length", "8").set("x-video-production-asset-id", "asset-invalid-signature")
      .set("idempotency-key", "upload-invalid-signature").set("x-video-production-asset-metadata", "{}")
      .send(Buffer.from("notvideo")).expect(400);
    await request(app).post(endpoint).set(capability).set("content-type", "video/mp4")
      .set("content-length", String(256 * 1024 * 1024 + 1)).set("x-video-production-asset-id", "asset-oversized")
      .set("idempotency-key", "upload-oversized").set("x-video-production-asset-metadata", "{}")
      .send(Buffer.from("0000ftyp")).expect(413);
  });
});
