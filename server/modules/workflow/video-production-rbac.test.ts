import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyTaskSchemaMigrations } from "../bootstrap/schema/task-schema-migrations.ts";
import { afterEach, describe, expect, it } from "vitest";
import { applyBaseSchema } from "../bootstrap/schema/base-schema.ts";
import { ensureVideoProductionSchema } from "../bootstrap/schema/video-production-schema.ts";
import { decideVideoProduction, ingestVideoProductionDirective } from "./video-production.ts";
import {
  grantVideoProductionProjectAgent,
  issueVideoProductionCredential,
  resolveVideoProductionActor,
  revokeVideoProductionCredential,
  seedVideoProductionOrganization,
  videoStudioRoleAllows,
} from "./video-production-rbac.ts";
import { VIDEO_STUDIO_PROFILES } from "../../../shared/video-studio-organization.ts";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function setup() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  applyBaseSchema(db);
  ensureVideoProductionSchema(db);
  const department = db.prepare("INSERT INTO departments(id,name,name_ko,icon,color) VALUES(?,?,?,?,?)");
  for (const [id, name] of [["operations", "Operations"], ["planning", "Planning"], ["design", "Design"], ["dev", "Development"], ["qa", "QA"], ["devsecops", "DevSecOps"]]) {
    department.run(id, name, name, "D", "#777");
  }
  const production = ingestVideoProductionDirective(db, {
    messageId: "rbac-directive", content: "Create a studio video", projectPath: process.cwd(),
    brief: { title: "Studio", objective: "Explain", targetAudience: "Viewers", duration: "30s", aspectRatio: "16:9", language: "English", style: "Documentary", deliveryPlatform: "Web", constraints: "" },
  });
  decideVideoProduction(db, production.project_id, { version: 1, decision: "approve" });
  return { db, production };
}

describe("Video Production organization and RBAC foundation", () => {
  it("seeds six pack-scoped departments and eight stable agents idempotently without changing Dami runtime fields", () => {
    const { db } = setup();
    db.prepare("UPDATE agents SET cli_provider='claude',oauth_account_id='preserve-oauth',status='working',current_task_id='legacy-task' WHERE id='video_production-seed-5'").run();
    expect(seedVideoProductionOrganization(db, "ceo_session")).toEqual({ departments: 6, agents: 7 });
    expect(seedVideoProductionOrganization(db, "ceo_session")).toEqual({ departments: 6, agents: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM office_pack_departments WHERE workflow_pack_key='video_production'").get()).toEqual({ count: 6 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM video_production_agent_roles").get()).toEqual({ count: 8 });
    expect(db.prepare("SELECT name,department_id,workflow_pack_key,role,cli_provider,oauth_account_id,status,current_task_id FROM agents WHERE id='video_production-seed-5'").get()).toEqual({
      name: "Dami", department_id: "operations", workflow_pack_key: "video_production", role: "team_leader",
      cli_provider: "claude", oauth_account_id: "preserve-oauth", status: "working", current_task_id: "legacy-task",
    });
    expect(db.prepare("SELECT role_key FROM video_production_agent_roles WHERE agent_id=?").get("video_production-role-qa-supervisor")).toEqual({ role_key: "qa_supervisor" });
  });

  it("fails closed on existing custom Video Production agents and rolls back the opt-in seed", () => {
    const { db } = setup();
    db.prepare("INSERT INTO agents(id,name,department_id,workflow_pack_key,role) VALUES('custom-video','Custom','design','video_production','junior')").run();
    expect(() => seedVideoProductionOrganization(db, "ceo_session")).toThrow("video_production_custom_agents_conflict");
    expect(db.prepare("SELECT COUNT(*) AS count FROM office_pack_departments WHERE workflow_pack_key='video_production'").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM video_production_agent_roles").get()).toEqual({ count: 0 });
  });

  it("preserves extra custom pack departments and rolls back instead of claiming a complete studio", () => {
    const { db } = setup();
    db.prepare(`INSERT INTO office_pack_departments(workflow_pack_key,department_id,name,name_ko,icon,color,sort_order)
      VALUES('video_production','custom-studio','Custom Studio','Custom Studio','X','#123456',99)`).run();
    expect(() => seedVideoProductionOrganization(db, "ceo_session")).toThrow("video_production_custom_departments_conflict");
    expect(db.prepare("SELECT COUNT(*) AS count FROM office_pack_departments WHERE workflow_pack_key='video_production'").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM video_production_agent_roles").get()).toEqual({ count: 0 });
  });

  it("keeps permissions server-owned and rejects self-approval roles", () => {
    expect(videoStudioRoleAllows("video_producer", "take.review")).toBe(false);
    expect(videoStudioRoleAllows("screenwriter", "creative.approve")).toBe(false);
    expect(videoStudioRoleAllows("production_manager", "project.greenlight")).toBe(false);
    expect(videoStudioRoleAllows("director", "creative.approve")).toBe(true);
    expect(videoStudioRoleAllows("director", "pilot.approve")).toBe(true);
    expect(videoStudioRoleAllows("art_director", "pilot.approve")).toBe(false);
    expect(videoStudioRoleAllows("art_director", "take.review")).toBe(true);
    expect(videoStudioRoleAllows("qa_supervisor", "qa.final")).toBe(true);
    expect(videoStudioRoleAllows("toString" as never, "studio.read")).toBe(false);
    for (const profile of VIDEO_STUDIO_PROFILES) {
      expect(profile.actions).not.toContain("project.greenlight");
      expect(profile.actions).not.toContain("budget.override");
      expect(profile.actions).not.toContain("release.final");
    }
  });

  it("issues only scoped hash-stored credentials and rejects revoked, expired, wrong-project and role-ineligible use", () => {
    const { db, production } = setup();
    seedVideoProductionOrganization(db, "ceo_session");
    const profile = VIDEO_STUDIO_PROFILES.find((entry) => entry.roleKey === "director")!;
    grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId: profile.id, grantedBy: "ceo_session" });
    const now = 2_000_000;
    expect(() => issueVideoProductionCredential(db, {
      projectId: production.project_id, agentId: profile.id, scopes: ["creative.approve"], issuedBy: "ceo_session", expiresAt: now + 60_000,
    }, { now })).toThrow("video_production_agent_credentials_disabled");
    const issued = issueVideoProductionCredential(db, {
      projectId: production.project_id, agentId: profile.id, scopes: ["studio.read", "creative.approve"], issuedBy: "ceo_session", expiresAt: now + 60_000,
    }, { now, enabled: true, isolationReady: true });
    const stored = db.prepare("SELECT token_hash,scopes_json,issued_by FROM video_production_agent_credentials WHERE credential_id=?").get(issued.credentialId) as { token_hash: string; scopes_json: string; issued_by: string };
    expect(stored.token_hash).not.toBe(issued.token);
    expect(stored.token_hash).toHaveLength(64);
    expect(stored.scopes_json).toBe('["creative.approve","studio.read"]');
    expect(stored.issued_by).toBe("ceo_session");
    expect(resolveVideoProductionActor(db, issued.token, production.project_id, "creative.approve", { now: now + 1, enabled: true, isolationReady: true }))
      .toMatchObject({ agentId: profile.id, roleKey: "director", projectId: production.project_id });
    db.prepare("UPDATE agents SET workflow_pack_key='development' WHERE id=?").run(profile.id);
    expect(resolveVideoProductionActor(db, issued.token, production.project_id, "creative.approve", { now: now + 1, enabled: true, isolationReady: true })).toBeNull();
    db.prepare("UPDATE agents SET workflow_pack_key='video_production' WHERE id=?").run(profile.id);
    expect(resolveVideoProductionActor(db, issued.token, production.project_id, "plan.update", { now: now + 1, enabled: true, isolationReady: true })).toBeNull();
    expect(resolveVideoProductionActor(db, issued.token, "other-project", "studio.read", { now: now + 1, enabled: true, isolationReady: true })).toBeNull();
    expect(resolveVideoProductionActor(db, issued.token, production.project_id, "studio.read", { now: issued.expiresAt, enabled: true, isolationReady: true })).toBeNull();
    expect(revokeVideoProductionCredential(db, { credentialId: issued.credentialId, revokedBy: "ceo_session", now: now + 2 })).toBe(true);
    expect(resolveVideoProductionActor(db, issued.token, production.project_id, "studio.read", { now: now + 3, enabled: true, isolationReady: true })).toBeNull();
  });

  it("requires the persisted manager plus coordinator grant for plan and assignment capabilities", () => {
    const { db, production } = setup();
    seedVideoProductionOrganization(db, "ceo_session");
    const dami = VIDEO_STUDIO_PROFILES.find((entry) => entry.roleKey === "production_manager")!;
    grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId: dami.id, grantKey: "coordinator", grantedBy: "ceo_session" });
    const credential = issueVideoProductionCredential(db, {
      projectId: production.project_id, agentId: dami.id, scopes: ["plan.update", "task.assign"], issuedBy: "ceo_session", expiresAt: 2_100_000,
    }, { now: 2_000_000, enabled: true, isolationReady: true });
    expect(resolveVideoProductionActor(db, credential.token, production.project_id, "plan.update", { now: 2_000_001, enabled: true, isolationReady: true }))
      .toMatchObject({ agentId: dami.id, roleKey: "production_manager" });
    db.prepare("INSERT INTO agents(id,name,department_id,workflow_pack_key,role) VALUES('other-manager','Other','operations','video_production','team_leader')").run();
    db.prepare("UPDATE video_productions SET manager_agent_id='other-manager' WHERE project_id=?").run(production.project_id);
    expect(resolveVideoProductionActor(db, credential.token, production.project_id, "plan.update", { now: 2_000_001, enabled: true, isolationReady: true })).toBeNull();
  });

  it("invalidates rotated credentials and keeps revoked grants denied after regrant", () => {
    const { db, production } = setup();
    seedVideoProductionOrganization(db, "ceo_session");
    const director = "video_production-role-director";
    grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId: director, grantedBy: "ceo_session" });
    const input = { projectId: production.project_id, agentId: director, scopes: ["studio.read"] as Array<"studio.read">, issuedBy: "ceo_session", expiresAt: 2_100_000 };
    const first = issueVideoProductionCredential(db, input, { now: 2_000_000, enabled: true, isolationReady: true });
    const second = issueVideoProductionCredential(db, input, { now: 2_000_001, enabled: true, isolationReady: true });
    expect(resolveVideoProductionActor(db, first.token, production.project_id, "studio.read", { now: 2_000_002, enabled: true, isolationReady: true })).toBeNull();
    expect(resolveVideoProductionActor(db, second.token, production.project_id, "studio.read", { now: 2_000_002, enabled: true, isolationReady: true })).not.toBeNull();
    db.prepare("UPDATE video_production_project_grants SET revoked_at=? WHERE project_id=? AND agent_id=?").run(2_000_003, production.project_id, director);
    db.prepare("UPDATE video_production_agent_credentials SET revoked_at=? WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").run(2_000_003, production.project_id, director);
    grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId: director, grantedBy: "ceo_session" });
    expect(resolveVideoProductionActor(db, second.token, production.project_id, "studio.read", { now: 2_000_004, enabled: true, isolationReady: true })).toBeNull();
  });

  it("rolls back a grant when its audit event cannot be written", () => {
    const { db, production } = setup();
    seedVideoProductionOrganization(db, "ceo_session");
    db.exec("CREATE TRIGGER reject_video_event BEFORE INSERT ON video_production_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
    expect(() => grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId: "video_production-role-director", grantedBy: "ceo_session" })).toThrow("audit unavailable");
    expect(db.prepare("SELECT COUNT(*) AS count FROM video_production_project_grants WHERE project_id=? AND agent_id=?").get(production.project_id, "video_production-role-director")).toEqual({ count: 0 });
  });

  it("enforces credential foreign keys and token-hash uniqueness in SQLite", () => {
    const { db, production } = setup();
    seedVideoProductionOrganization(db, "ceo_session");
    grantVideoProductionProjectAgent(db, { projectId: production.project_id, agentId: "video_production-role-director", grantedBy: "ceo_session" });
    const issued = issueVideoProductionCredential(db, { projectId: production.project_id, agentId: "video_production-role-director", scopes: ["studio.read"], issuedBy: "ceo_session", expiresAt: Date.now() + 60_000 }, { enabled: true, isolationReady: true });
    const credential = db.prepare("SELECT token_hash,scopes_json FROM video_production_agent_credentials WHERE credential_id=?").get(issued.credentialId) as { token_hash: string; scopes_json: string };
    expect(() => db.prepare(`INSERT INTO video_production_agent_credentials(credential_id,project_id,agent_id,token_hash,scopes_json,issued_by,created_at,expires_at)
      VALUES('other-credential',?,?,'not-a-valid-agent-hash','[]','ceo',1,2)`).run(production.project_id, "unknown-agent")).toThrow();
    expect(() => db.prepare(`INSERT INTO video_production_agent_credentials(credential_id,project_id,agent_id,token_hash,scopes_json,issued_by,created_at,expires_at)
      VALUES('duplicate-hash',?,?,?,?,'ceo',1,2)`).run(production.project_id, "video_production-role-director", credential.token_hash, credential.scopes_json)).toThrow();
  });

  it("persists role bindings and constraints across a file-backed SQLite reopen", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "video-studio-rbac-"));
    const file = path.join(directory, "studio.sqlite");
    try {
      let db = new DatabaseSync(file);
      applyBaseSchema(db);
      ensureVideoProductionSchema(db);
      for (const [id, name] of [["operations", "Operations"], ["planning", "Planning"], ["design", "Design"], ["dev", "Development"], ["qa", "QA"], ["devsecops", "DevSecOps"]]) {
        db.prepare("INSERT INTO departments(id,name,name_ko,icon,color) VALUES(?,?,?,?,?)").run(id, name, name, "D", "#777");
      }
      expect(seedVideoProductionOrganization(db, "ceo_session")).toEqual({ departments: 6, agents: 8 });
      const production = ingestVideoProductionDirective(db, {
        messageId: "rbac-persist-directive", content: "Studio", projectPath: process.cwd(),
        brief: { title: "Studio", objective: "Explain", targetAudience: "Viewers", duration: "30s", aspectRatio: "16:9", language: "English", style: "Documentary", deliveryPlatform: "Web", constraints: "" },
      });
      db.prepare("INSERT INTO settings(key,value) VALUES('officePackProfiles',?)").run(JSON.stringify({
        video_production: {
          departments: [{ id: "operations", name: "Editable legacy name", name_ko: "Editable legacy name" }],
          agents: [{ id: "video_production-seed-5", department_id: "design" }],
        },
      }));
      applyTaskSchemaMigrations(db);
      expect(db.prepare("SELECT name FROM office_pack_departments WHERE workflow_pack_key='video_production' AND department_id='operations'").get()).toEqual({ name: "Production Management" });
      expect(db.prepare("SELECT workflow_pack_key,department_id FROM agents WHERE id='video_production-seed-5'").get()).toEqual({ workflow_pack_key: "video_production", department_id: "operations" });
      expect(() => db.prepare("INSERT INTO video_production_agent_roles(agent_id,role_key,bound_by,created_at,updated_at) VALUES(?,?,?,?,?)").run("video_production-seed-5", "director", "ceo", 1, 1)).toThrow();
      db.close();
      db = new DatabaseSync(file);
      ensureVideoProductionSchema(db);
      expect(db.prepare("SELECT role_key,bound_by FROM video_production_agent_roles WHERE agent_id='video_production-seed-5'").get()).toEqual({ role_key: "production_manager", bound_by: "ceo_session" });
      expect(db.prepare("SELECT grant_key FROM video_production_project_grants WHERE project_id=? AND agent_id=?").get(production.project_id, production.manager_agent_id)).toEqual({ grant_key: "coordinator" });
      db.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 15_000);
});
