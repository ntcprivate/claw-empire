import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  VIDEO_STUDIO_DEPARTMENTS,
  VIDEO_STUDIO_PROFILES,
  VIDEO_STUDIO_ROLE_BY_KEY,
  type VideoStudioAction,
  type VideoStudioRoleKey,
} from "../../../shared/video-studio-organization.ts";
import { VideoProductionPolicyError } from "./video-production.ts";
import { VIDEO_PRODUCTION_AGENT_CREDENTIALS_ENABLED } from "../../config/runtime.ts";
import { isWorkerIsolationReady } from "./worker-isolation.ts";

type Db = Pick<DatabaseSync, "prepare" | "exec">;

export interface VideoProductionAgentActor {
  kind: "agent";
  agentId: string;
  projectId: string;
  roleKey: VideoStudioRoleKey;
  credentialId: string;
  action: VideoStudioAction;
  attemptId?: string;
  taskId?: string;
  planVersion?: number;
  testRuntimeGate?: { enabled: true; isolationReady: true; now?: number };
}

export interface VideoProductionCeoActor {
  kind: "ceo";
  actorId: "ceo_session";
  projectId: string;
}

export type VideoProductionActor = VideoProductionAgentActor | VideoProductionCeoActor;

const ROLE_TO_AGENT_RANK = {
  production_manager: "team_leader",
  director: "senior",
  screenwriter: "senior",
  art_director: "senior",
  video_producer: "junior",
  editor: "senior",
  sound_producer: "senior",
  qa_supervisor: "team_leader",
} as const;

const DEPARTMENT_PRESENTATION = {
  operations: { name: "Production Management", nameKo: "제작 관리", icon: "P", color: "#a26b36" },
  planning: { name: "Creative Development", nameKo: "크리에이티브 개발", icon: "C", color: "#b48a4a" },
  design: { name: "AI Visual Production", nameKo: "AI 시각 제작", icon: "V", color: "#648b82" },
  dev: { name: "Post-production & Sound", nameKo: "후반 작업 및 사운드", icon: "S", color: "#587b99" },
  qa: { name: "Quality Assurance", nameKo: "품질 보증", icon: "Q", color: "#9c615f" },
  devsecops: { name: "Studio Technology", nameKo: "스튜디오 기술", icon: "T", color: "#747c84" },
} as const;

const ATTEMPT_BOUND_REGISTRY_ACTIONS = new Set<VideoStudioAction>([
  "screenplay.write", "shot_spec.write", "visual.manage", "footage.submit", "take.review", "regeneration.request", "edit.manage",
]);

interface ActiveAttemptRow {
  attempt_id: string;
  project_id: string;
  task_id: string;
  assigned_agent_id: string;
  plan_version: number;
  role_key: VideoStudioRoleKey;
  grant_key: string;
}

function findActiveAttemptForAgent(db: Db, attemptId: string, agentId?: string): ActiveAttemptRow | null {
  return (db.prepare(`
    SELECT a.attempt_id,a.project_id,a.task_id,a.assigned_agent_id,a.plan_version,r.role_key,g.grant_key
    FROM video_production_attempts a
    JOIN tasks t ON t.id=a.task_id AND t.project_id=a.project_id
    JOIN video_production_stages s ON s.project_id=a.project_id AND s.task_id=a.task_id AND s.implemented=1 AND s.status='RUNNING'
    JOIN video_production_slot slot ON slot.singleton=1 AND slot.task_id=a.task_id AND slot.attempt_id=a.attempt_id
    JOIN video_productions p ON p.project_id=a.project_id AND p.state='APPROVED'
      AND p.plan_version=a.plan_version AND p.approved_version=a.plan_version
    JOIN agents ag ON ag.id=a.assigned_agent_id AND ag.workflow_pack_key='video_production'
      AND ag.id=t.assigned_agent_id AND ag.current_task_id=t.id
    JOIN video_production_agent_roles r ON r.agent_id=ag.id
    JOIN video_production_project_grants g ON g.project_id=a.project_id AND g.agent_id=ag.id AND g.revoked_at IS NULL
    WHERE a.attempt_id=? AND a.state='RUNNING' AND t.status='in_progress'
      AND a.assigned_agent_id IS NOT NULL AND (? IS NULL OR a.assigned_agent_id=?)
  `).get(attemptId, agentId ?? null, agentId ?? null) as ActiveAttemptRow | undefined) ?? null;
}

export function assertVideoProductionAgentAttemptCurrent(
  db: Db,
  actor: VideoProductionAgentActor,
  projectId: string,
  action: VideoStudioAction,
): ActiveAttemptRow {
  const testGate = actor.testRuntimeGate;
  if (!(VIDEO_PRODUCTION_AGENT_CREDENTIALS_ENABLED && isWorkerIsolationReady()) && !testGate) {
    throw new VideoProductionPolicyError("video_production_agent_credentials_disabled", 503);
  }
  if (actor.projectId !== projectId || actor.action !== action || !videoStudioRoleAllows(actor.roleKey, action)) {
    throw new VideoProductionPolicyError("video_production_actor_scope_mismatch", 403);
  }
  if (!ATTEMPT_BOUND_REGISTRY_ACTIONS.has(action) || !actor.attemptId || !actor.taskId || actor.planVersion === undefined) {
    throw new VideoProductionPolicyError("video_production_active_attempt_required", 403);
  }
  const attempt = findActiveAttemptForAgent(db, actor.attemptId, actor.agentId);
  if (!attempt || attempt.project_id !== projectId || attempt.task_id !== actor.taskId || attempt.plan_version !== actor.planVersion) {
    throw new VideoProductionPolicyError("video_production_attempt_stale", 409);
  }
  const credential = db.prepare(`SELECT c.expires_at,c.revoked_at,c.scopes_json,c.project_id,c.agent_id,c.attempt_id,c.task_id,c.plan_version,
      r.role_key,g.grant_key,p.manager_agent_id
    FROM video_production_agent_credentials c
    JOIN video_production_agent_roles r ON r.agent_id=c.agent_id
    JOIN video_production_project_grants g ON g.project_id=c.project_id AND g.agent_id=c.agent_id AND g.revoked_at IS NULL
    JOIN video_productions p ON p.project_id=c.project_id
    WHERE c.credential_id=?`).get(actor.credentialId) as {
      expires_at: number; revoked_at: number | null; scopes_json: string; project_id: string; agent_id: string;
      attempt_id: string | null; task_id: string | null; plan_version: number | null; role_key: VideoStudioRoleKey;
      grant_key: string; manager_agent_id: string;
    } | undefined;
  const now = testGate?.now ?? Date.now();
  if (!credential || credential.revoked_at !== null || credential.expires_at <= now || credential.project_id !== projectId ||
      credential.agent_id !== actor.agentId || credential.role_key !== actor.roleKey || credential.role_key !== attempt.role_key ||
      credential.attempt_id !== attempt.attempt_id || credential.task_id !== attempt.task_id || credential.plan_version !== attempt.plan_version) {
    throw new VideoProductionPolicyError("video_production_credential_stale", 401);
  }
  let scopes: unknown;
  try { scopes = JSON.parse(credential.scopes_json); } catch { throw new VideoProductionPolicyError("video_production_credential_invalid", 401); }
  if (!Array.isArray(scopes) || !scopes.includes(action) || !videoStudioRoleAllows(credential.role_key, action)) {
    throw new VideoProductionPolicyError("video_production_scope_not_allowed", 403);
  }
  if ((action === "plan.update" || action === "task.assign" || action === "regeneration.request") &&
      (attempt.role_key !== "production_manager" || attempt.assigned_agent_id !== (db.prepare("SELECT manager_agent_id FROM video_productions WHERE project_id=?").get(projectId) as { manager_agent_id: string } | undefined)?.manager_agent_id || attempt.grant_key !== "coordinator")) {
    throw new VideoProductionPolicyError("video_production_coordinator_required", 403);
  }
  return attempt;
}

function inTransaction<T>(db: Db, callback: () => T): T {
  const savepoint = `vp_rbac_${randomUUID().replaceAll("-", "")}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const value = callback();
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return value;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}

export function videoStudioRoleAllows(roleKey: VideoStudioRoleKey, action: VideoStudioAction): boolean {
  return Object.hasOwn(VIDEO_STUDIO_ROLE_BY_KEY, roleKey) && VIDEO_STUDIO_ROLE_BY_KEY[roleKey].actions.includes(action);
}

export function resolveVideoProductionActor(
  db: Db,
  token: string,
  projectId: string,
  action: VideoStudioAction,
  options: { now?: number; enabled?: boolean; isolationReady?: boolean } = {},
): VideoProductionAgentActor | null {
  if (!(options.enabled ?? VIDEO_PRODUCTION_AGENT_CREDENTIALS_ENABLED) || !(options.isolationReady ?? isWorkerIsolationReady())) return null;
  const now = options.now ?? Date.now();
  if (!token || token.length > 512 || !projectId) return null;
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  const row = db.prepare(`
    SELECT c.credential_id, c.agent_id, c.project_id, c.scopes_json, c.attempt_id, c.task_id, c.plan_version,
      r.role_key, g.grant_key, p.manager_agent_id
    FROM video_production_agent_credentials c
    JOIN video_production_project_grants g
      ON g.project_id=c.project_id AND g.agent_id=c.agent_id AND g.revoked_at IS NULL
    JOIN video_production_agent_roles r ON r.agent_id=c.agent_id
    JOIN agents a ON a.id=c.agent_id AND a.workflow_pack_key='video_production'
    JOIN video_productions p ON p.project_id=c.project_id
    WHERE c.token_hash=? AND c.project_id=? AND c.revoked_at IS NULL AND c.expires_at>?
  `).get(tokenHash, projectId, now) as
    | { credential_id: string; agent_id: string; project_id: string; scopes_json: string; attempt_id: string | null; task_id: string | null; plan_version: number | null; role_key: VideoStudioRoleKey; grant_key: string; manager_agent_id: string }
    | undefined;
  if (!row || !videoStudioRoleAllows(row.role_key, action)) return null;
  if (ATTEMPT_BOUND_REGISTRY_ACTIONS.has(action)) {
    if (!row.attempt_id || !row.task_id || row.plan_version === null) return null;
    const activeAttempt = findActiveAttemptForAgent(db, row.attempt_id, row.agent_id);
    if (!activeAttempt || activeAttempt.project_id !== row.project_id || activeAttempt.task_id !== row.task_id || activeAttempt.plan_version !== row.plan_version) return null;
  }
  if ((action === "plan.update" || action === "task.assign" || action === "regeneration.request") &&
      (row.role_key !== "production_manager" || row.agent_id !== row.manager_agent_id || row.grant_key !== "coordinator")) return null;
  let scopes: unknown;
  try { scopes = JSON.parse(row.scopes_json); } catch { return null; }
  if (!Array.isArray(scopes) || !scopes.includes(action)) return null;
  return {
    kind: "agent", agentId: row.agent_id, projectId: row.project_id, roleKey: row.role_key,
    credentialId: row.credential_id, action,
    ...(row.attempt_id ? { attemptId: row.attempt_id, taskId: row.task_id!, planVersion: row.plan_version! } : {}),
    ...(options.enabled === true && options.isolationReady === true ? { testRuntimeGate: { enabled: true as const, isolationReady: true as const, now } } : {}),
  };
}

export function issueVideoProductionCredential(
  db: Db,
  input: { projectId: string; agentId: string; scopes: VideoStudioAction[]; issuedBy: string; expiresAt: number },
  options: { enabled?: boolean; isolationReady?: boolean; now?: number } = {},
): { credentialId: string; token: string; expiresAt: number } {
  if (!(options.enabled ?? VIDEO_PRODUCTION_AGENT_CREDENTIALS_ENABLED) || !(options.isolationReady ?? isWorkerIsolationReady())) {
    throw new VideoProductionPolicyError("video_production_agent_credentials_disabled", 503);
  }
  const now = options.now ?? Date.now();
  if (!input.scopes.length || input.expiresAt <= now || input.expiresAt > now + 24 * 60 * 60 * 1000) {
    throw new VideoProductionPolicyError("invalid_agent_credential_lifetime", 400);
  }
  const binding = db.prepare(`
    SELECT r.role_key FROM video_production_agent_roles r
    JOIN video_production_project_grants g ON g.agent_id=r.agent_id AND g.project_id=? AND g.revoked_at IS NULL
    JOIN video_productions p ON p.project_id=g.project_id
    WHERE r.agent_id=?
  `).get(input.projectId, input.agentId) as { role_key: VideoStudioRoleKey } | undefined;
  if (!binding) throw new VideoProductionPolicyError("video_production_project_grant_required", 403);
  if (input.scopes.some((scope) => !videoStudioRoleAllows(binding.role_key, scope))) {
    throw new VideoProductionPolicyError("video_production_scope_not_allowed", 403);
  }
  if (input.scopes.some((scope) => ATTEMPT_BOUND_REGISTRY_ACTIONS.has(scope))) {
    throw new VideoProductionPolicyError("video_production_registry_attempt_required", 403);
  }
  return persistVideoProductionCredential(db, { ...input, roleKey: binding.role_key }, now);
}

/** Internal executor-only issuer. It derives project, agent, task and plan from a live persisted attempt. */
export function issueVideoProductionAttemptCredential(
  db: Db,
  input: { attemptId: string; scopes: VideoStudioAction[]; expiresAt: number },
  options: { enabled?: boolean; isolationReady?: boolean; now?: number } = {},
): { credentialId: string; token: string; expiresAt: number } {
  if (!(options.enabled ?? VIDEO_PRODUCTION_AGENT_CREDENTIALS_ENABLED) || !(options.isolationReady ?? isWorkerIsolationReady())) {
    throw new VideoProductionPolicyError("video_production_agent_credentials_disabled", 503);
  }
  const now = options.now ?? Date.now();
  if (!input.scopes.length || input.expiresAt <= now || input.expiresAt > now + 24 * 60 * 60 * 1000) {
    throw new VideoProductionPolicyError("invalid_agent_credential_lifetime", 400);
  }
  const attempt = findActiveAttemptForAgent(db, input.attemptId);
  if (!attempt) throw new VideoProductionPolicyError("video_production_active_attempt_required", 409);
  if (input.scopes.some((scope) => !ATTEMPT_BOUND_REGISTRY_ACTIONS.has(scope) || !videoStudioRoleAllows(attempt.role_key, scope))) {
    throw new VideoProductionPolicyError("video_production_scope_not_allowed", 403);
  }
  if (input.scopes.includes("regeneration.request") &&
      (attempt.role_key !== "production_manager" || attempt.assigned_agent_id !== (db.prepare("SELECT manager_agent_id FROM video_productions WHERE project_id=?").get(attempt.project_id) as { manager_agent_id: string } | undefined)?.manager_agent_id || attempt.grant_key !== "coordinator")) {
    throw new VideoProductionPolicyError("video_production_coordinator_required", 403);
  }
  return persistVideoProductionCredential(db, {
    projectId: attempt.project_id,
    agentId: attempt.assigned_agent_id,
    scopes: input.scopes,
    issuedBy: "trusted_video_production_executor",
    expiresAt: input.expiresAt,
    roleKey: attempt.role_key,
    attemptId: attempt.attempt_id,
    taskId: attempt.task_id,
    planVersion: attempt.plan_version,
  }, now);
}

function persistVideoProductionCredential(
  db: Db,
  input: { projectId: string; agentId: string; scopes: VideoStudioAction[]; issuedBy: string; expiresAt: number; roleKey: VideoStudioRoleKey; attemptId?: string; taskId?: string; planVersion?: number },
  now: number,
): { credentialId: string; token: string; expiresAt: number } {
  const token = randomBytes(32).toString("base64url");
  const credentialId = randomUUID();
  inTransaction(db, () => {
    db.prepare("UPDATE video_production_agent_credentials SET revoked_at=? WHERE project_id=? AND agent_id=? AND revoked_at IS NULL")
      .run(now, input.projectId, input.agentId);
    db.prepare(`INSERT INTO video_production_agent_credentials
      (credential_id,project_id,agent_id,token_hash,scopes_json,issued_by,created_at,expires_at,attempt_id,task_id,plan_version)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      credentialId, input.projectId, input.agentId, createHash("sha256").update(token, "utf8").digest("hex"),
      JSON.stringify([...new Set(input.scopes)].sort()), input.issuedBy, now, input.expiresAt,
      input.attemptId ?? null, input.taskId ?? null, input.planVersion ?? null,
    );
    recordVideoProductionEvent(db, input.projectId, "agent_credential_issued", input.issuedBy, {
      agentId: input.agentId, credentialId, scopes: [...new Set(input.scopes)].sort(), expiresAt: input.expiresAt,
      ...(input.attemptId ? { attemptId: input.attemptId, taskId: input.taskId, planVersion: input.planVersion } : {}),
    });
  });
  return { credentialId, token, expiresAt: input.expiresAt };
}

export function revokeVideoProductionCredential(db: Db, input: { credentialId: string; revokedBy: string; now?: number }): boolean {
  const now = input.now ?? Date.now();
  return inTransaction(db, () => {
    const credential = db.prepare("SELECT project_id,agent_id FROM video_production_agent_credentials WHERE credential_id=? AND revoked_at IS NULL")
      .get(input.credentialId) as { project_id: string; agent_id: string } | undefined;
    if (!credential) return false;
    db.prepare("UPDATE video_production_agent_credentials SET revoked_at=? WHERE credential_id=? AND revoked_at IS NULL").run(now, input.credentialId);
    recordVideoProductionEvent(db, credential.project_id, "agent_credential_revoked", input.revokedBy, {
      agentId: credential.agent_id, credentialId: input.credentialId,
    });
    return true;
  });
}

export function recordVideoProductionEvent(db: Db, projectId: string, name: string, actorId: string, detail: unknown): void {
  db.prepare("INSERT INTO video_production_events(project_id,event,actor_id,detail_json,created_at) VALUES(?,?,?,?,?)")
    .run(projectId, name, actorId, JSON.stringify(detail), Date.now());
}

export function grantVideoProductionProjectAgent(
  db: Db,
  input: { projectId: string; agentId: string; grantKey?: "member" | "coordinator"; grantedBy: string },
): void {
  inTransaction(db, () => {
    const project = db.prepare("SELECT manager_agent_id FROM video_productions WHERE project_id=?").get(input.projectId) as { manager_agent_id: string } | undefined;
    if (!project) throw new VideoProductionPolicyError("video_production_not_found", 404);
    const role = db.prepare("SELECT role_key FROM video_production_agent_roles WHERE agent_id=?").get(input.agentId) as { role_key: VideoStudioRoleKey } | undefined;
    if (!role) throw new VideoProductionPolicyError("video_production_agent_role_not_configured", 409);
    if (input.grantKey === "coordinator" && role.role_key !== "production_manager") {
      throw new VideoProductionPolicyError("video_production_coordinator_role_required", 403);
    }
    db.prepare(`INSERT INTO video_production_project_grants(project_id,agent_id,grant_key,granted_by,created_at,revoked_at)
      VALUES(?,?,?,?,?,NULL) ON CONFLICT(project_id,agent_id) DO UPDATE SET
      grant_key=excluded.grant_key,granted_by=excluded.granted_by,created_at=excluded.created_at,revoked_at=NULL`)
      .run(input.projectId, input.agentId, input.grantKey ?? "member", input.grantedBy, Date.now());
    recordVideoProductionEvent(db, input.projectId, "project_agent_granted", input.grantedBy, {
      agentId: input.agentId, roleKey: role.role_key, grantKey: input.grantKey ?? "member",
    });
  });
}

export function revokeVideoProductionProjectAgent(db: Db, input: { projectId: string; agentId: string; revokedBy: string }): boolean {
  return inTransaction(db, () => {
    const result = db.prepare(`UPDATE video_production_project_grants SET revoked_at=?
      WHERE project_id=? AND agent_id=? AND revoked_at IS NULL AND agent_id != (
        SELECT manager_agent_id FROM video_productions WHERE project_id=?
      )`).run(Date.now(), input.projectId, input.agentId, input.projectId);
    if (result.changes) {
      db.prepare("UPDATE video_production_agent_credentials SET revoked_at=? WHERE project_id=? AND agent_id=? AND revoked_at IS NULL")
        .run(Date.now(), input.projectId, input.agentId);
      recordVideoProductionEvent(db, input.projectId, "project_agent_revoked", input.revokedBy, { agentId: input.agentId });
    }
    return result.changes === 1;
  });
}

export function seedVideoProductionOrganization(db: Db, actorId: string): { departments: number; agents: number } {
  return inTransaction(db, () => {
    const allowedIds = new Set(VIDEO_STUDIO_PROFILES.map((profile) => profile.id));
    const existingPackAgents = db.prepare("SELECT id FROM agents WHERE workflow_pack_key='video_production'").all() as Array<{ id: string }>;
    if (existingPackAgents.some((agent) => !allowedIds.has(agent.id))) {
      throw new VideoProductionPolicyError("video_production_custom_agents_conflict", 409);
    }
    for (const dept of VIDEO_STUDIO_DEPARTMENTS) {
      const anchor = db.prepare("SELECT 1 AS ok FROM departments WHERE id=?").get(dept.id);
      if (!anchor) throw new VideoProductionPolicyError("video_production_department_anchor_missing", 409, dept.id);
    }
    const allowedDepartments = new Set<string>(VIDEO_STUDIO_DEPARTMENTS.map((dept) => dept.id));
    const extraDepartment = db.prepare("SELECT department_id FROM office_pack_departments WHERE workflow_pack_key='video_production'").all()
      .map((row) => (row as { department_id: string }).department_id).find((id) => !allowedDepartments.has(id));
    if (extraDepartment) throw new VideoProductionPolicyError("video_production_custom_departments_conflict", 409);
    const insertDepartment = db.prepare(`INSERT OR IGNORE INTO office_pack_departments
      (workflow_pack_key,department_id,name,name_ko,name_ja,name_zh,icon,color,description,prompt,sort_order,created_at)
      VALUES('video_production',?,?,?,?,?,?,?,?,?,?,?)`);
    const departmentLookup = db.prepare("SELECT name,name_ko FROM office_pack_departments WHERE workflow_pack_key='video_production' AND department_id=?");
    for (const department of VIDEO_STUDIO_DEPARTMENTS) {
      const presentation = DEPARTMENT_PRESENTATION[department.id as keyof typeof DEPARTMENT_PRESENTATION];
      insertDepartment.run(department.id, presentation.name, presentation.nameKo, "", "", presentation.icon, presentation.color,
        `Video Production ${presentation.name} (pack scoped; global anchor ${department.id})`, "", department.sortOrder, Date.now());
      const existing = departmentLookup.get(department.id) as { name: string; name_ko: string } | undefined;
      if (existing?.name !== presentation.name || existing.name_ko !== presentation.nameKo) {
        throw new VideoProductionPolicyError("video_production_department_profile_conflict", 409, department.id);
      }
    }

    const byId = db.prepare("SELECT id,name,department_id,workflow_pack_key,role FROM agents WHERE id=?");
    const sameName = db.prepare("SELECT id FROM agents WHERE workflow_pack_key='video_production' AND name=? COLLATE NOCASE AND id!=?");
    const insertAgent = db.prepare(`INSERT INTO agents
      (id,name,name_ko,department_id,workflow_pack_key,role,acts_as_planning_leader,cli_provider,avatar_emoji,personality)
      VALUES(?,?,?,?,?,?,?,?,'🎬',?)`);
    const bindRole = db.prepare("INSERT INTO video_production_agent_roles(agent_id,role_key,bound_by,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(agent_id) DO NOTHING");
    const verifyRole = db.prepare("SELECT role_key FROM video_production_agent_roles WHERE agent_id=?");
    let agentsCreated = 0;
    const now = Date.now();
    for (const profile of VIDEO_STUDIO_PROFILES) {
      const rank = ROLE_TO_AGENT_RANK[profile.roleKey];
      let agent = byId.get(profile.id) as { id: string; name: string; department_id: string | null; workflow_pack_key: string; role: string } | undefined;
      if (!agent) {
        if (sameName.get(profile.displayName, profile.id)) throw new VideoProductionPolicyError("video_production_agent_name_conflict", 409, profile.displayName);
        insertAgent.run(profile.id, profile.displayName, profile.displayName, profile.departmentId, "video_production", rank,
          profile.roleKey === "production_manager" ? 1 : 0, "codex", JSON.stringify(profile.responsibilities));
        agentsCreated++;
        agent = byId.get(profile.id) as typeof agent;
      }
      if (!agent || agent.name !== profile.displayName || agent.department_id !== profile.departmentId || agent.workflow_pack_key !== "video_production" || agent.role !== rank) {
        throw new VideoProductionPolicyError("video_production_agent_profile_conflict", 409, profile.id);
      }
      bindRole.run(profile.id, profile.roleKey, actorId, now, now);
      const role = verifyRole.get(profile.id) as { role_key: string } | undefined;
      if (role?.role_key !== profile.roleKey) throw new VideoProductionPolicyError("video_production_agent_role_conflict", 409, profile.id);
    }
    return { departments: VIDEO_STUDIO_DEPARTMENTS.length, agents: agentsCreated };
  });
}

export type PublicVideoStudioProfile = typeof VIDEO_STUDIO_PROFILES[number];
export function listVideoStudioProfiles(): readonly PublicVideoStudioProfile[] { return VIDEO_STUDIO_PROFILES; }

export function assertRoleKey(value: unknown): asserts value is VideoStudioRoleKey {
  if (typeof value !== "string" || !Object.hasOwn(VIDEO_STUDIO_ROLE_BY_KEY, value)) throw new VideoProductionPolicyError("invalid_video_production_role", 400);
}

