import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  VIDEO_PRODUCTION_BRIEF_FIELDS,
  VIDEO_PRODUCTION_PACK,
  VIDEO_PRODUCTION_STAGES,
  type VideoProductionBrief,
  type VideoProductionSnapshot,
  type VideoProductionStageStatus,
} from "../../../shared/video-production.ts";
export { ensureVideoProductionSchema } from "../bootstrap/schema/video-production-schema.ts";

type Db = Pick<DatabaseSync, "prepare" | "exec">;
type ProductionRow = {
  project_id: string;
  message_id: string;
  root_task_id: string;
  manager_agent_id: string;
  state: VideoProductionSnapshot["state"];
  plan_version: number;
  approved_version: number | null;
  brief_json: string;
};
export class VideoProductionPolicyError extends Error {
  constructor(
    public code: string,
    public status = 409,
    message = code,
  ) {
    super(message);
  }
}
function transaction<T>(db: Db, callback: () => T): T {
  const savepoint = `video_${randomUUID().replaceAll("-", "")}`;
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
function normalizeBrief(input: unknown): VideoProductionBrief {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new VideoProductionPolicyError("invalid_brief", 400);
  const source = input as Record<string, unknown>;
  const result = {} as VideoProductionBrief;
  for (const field of VIDEO_PRODUCTION_BRIEF_FIELDS) {
    if (source[field] !== undefined && typeof source[field] !== "string")
      throw new VideoProductionPolicyError(`invalid_brief_${field}`, 400);
    result[field] = String(source[field] ?? "").trim();
    if (result[field].length > 10000) throw new VideoProductionPolicyError(`brief_${field}_too_long`, 400);
  }
  return result;
}
function missingFields(brief: VideoProductionBrief): string[] {
  return VIDEO_PRODUCTION_BRIEF_FIELDS.filter((field) => field !== "constraints" && !brief[field]);
}
function event(db: Db, projectId: string, name: string, actor: string, detail: unknown): void {
  db.prepare(
    "INSERT INTO video_production_events(project_id,event,actor_id,detail_json,created_at) VALUES(?,?,?,?,?)",
  ).run(projectId, name, actor, JSON.stringify(detail), Date.now());
}
function recordPlanVersion(
  db: Db,
  projectId: string,
  version: number,
  brief: VideoProductionBrief,
  actor: string,
): void {
  db.prepare(
    "INSERT INTO video_production_plan_versions(project_id,version,brief_json,stages_json,actor_id,created_at) VALUES(?,?,?,?,?,?)",
  ).run(projectId, version, JSON.stringify(brief), JSON.stringify(VIDEO_PRODUCTION_STAGES), actor, Date.now());
}
function publishPlanningCheckpoint(
  db: Db,
  row: { projectId: string; rootTaskId: string; manager: string; version: number; brief: VideoProductionBrief },
): void {
  const missing = missingFields(row.brief);
  const content = missing.length
    ? `[Production planning checkpoint — biểu mẫu tự động]\nProject Brief còn thiếu: ${missing.join(", ")}. CEO vui lòng bổ sung trong Project Brief hoặc gửi riêng cho Production Manager: [VIDEO_BRIEF] {"expectedVersion":${row.version},"brief":{...}} kèm project_id. Kế hoạch chưa thể phê duyệt.`
    : `[Production planning checkpoint — biểu mẫu tự động]\nProject Brief và kế hoạch 9 giai đoạn phiên bản ${row.version} đã sẵn sàng để CEO xem xét. Vui lòng chọn Approve hoặc Request Changes. Các giai đoạn sản xuất sau Intake & Planning chưa được triển khai trong Phase 1.`;
  db.prepare(
    "INSERT INTO messages(id,sender_type,sender_id,receiver_type,content,message_type,task_id,idempotency_key,created_at) VALUES(?,'agent',?,'all',?,'chat',?,?,?)",
  ).run(
    randomUUID(),
    row.manager,
    content,
    row.rootTaskId,
    `video-production:${row.projectId}:brief:${row.version}`,
    Date.now(),
  );
}
function production(db: Db, projectId: string): ProductionRow {
  const row = db.prepare("SELECT * FROM video_productions WHERE project_id = ?").get(projectId) as
    | ProductionRow
    | undefined;
  if (!row) throw new VideoProductionPolicyError("video_production_not_found", 404);
  return row;
}
export function getVideoProduction(db: Db, projectId: string): VideoProductionSnapshot | null {
  const row = db.prepare("SELECT * FROM video_productions WHERE project_id = ?").get(projectId) as
    | ProductionRow
    | undefined;
  if (!row) return null;
  const brief = normalizeBrief(JSON.parse(row.brief_json));
  const plan = db
    .prepare("SELECT stages_json FROM video_production_plan_versions WHERE project_id=? AND version=?")
    .get(projectId, row.plan_version) as { stages_json: string } | undefined;
  if (!plan) throw new VideoProductionPolicyError("plan_snapshot_missing", 500);
  const definitions = JSON.parse(plan.stages_json) as Array<(typeof VIDEO_PRODUCTION_STAGES)[number]>;
  const stages = db
    .prepare("SELECT * FROM video_production_stages WHERE project_id = ? ORDER BY stage_order")
    .all(projectId) as Array<{
    stage_key: string;
    stage_order: number;
    status: VideoProductionStageStatus;
    implemented: number;
    task_id: string | null;
  }>;
  return {
    project_id: row.project_id,
    source_message_id: row.message_id,
    root_task_id: row.root_task_id,
    manager_agent_id: row.manager_agent_id,
    manager_name: (
      db.prepare("SELECT name FROM agents WHERE id=?").get(row.manager_agent_id) as { name: string } | undefined
    )?.name,
    state: row.state,
    plan_version: row.plan_version,
    approved_version: row.approved_version,
    brief,
    missing_fields: missingFields(brief),
    stages: stages.map((stage) => {
      const definition = definitions.find((item) => item.key === stage.stage_key);
      if (!definition) throw new VideoProductionPolicyError("invalid_production_stage", 500);
      return {
        ...definition,
        inputs: [...definition.inputs],
        outputs: [...definition.outputs],
        order: stage.stage_order,
        status: stage.status,
        implemented: stage.implemented === 1,
        task_id: stage.task_id,
      };
    }),
    decisions: db
      .prepare(
        "SELECT version,decision,note,actor_id,created_at FROM video_production_decisions WHERE project_id = ? ORDER BY version",
      )
      .all(projectId) as unknown as VideoProductionSnapshot["decisions"],
  };
}
function resolveManager(db: Db): string {
  const leaders = db
    .prepare(
      "SELECT id FROM agents WHERE workflow_pack_key = 'video_production' AND role = 'team_leader' AND acts_as_planning_leader = 1 ORDER BY id",
    )
    .all() as Array<{ id: string }>;
  if (leaders.length > 1) throw new VideoProductionPolicyError("video_production_manager_configuration_required", 409);
  if (leaders.length === 1) return leaders[0].id;
  if (!db.prepare("SELECT 1 FROM departments WHERE id='operations'").get())
    throw new VideoProductionPolicyError("video_production_manager_configuration_required", 409);
  const stableId = "video_production-seed-5";
  if (db.prepare("SELECT 1 FROM agents WHERE id=?").get(stableId))
    throw new VideoProductionPolicyError("video_production_manager_configuration_required", 409);
  db.prepare(
    "INSERT INTO agents(id,name,name_ko,department_id,workflow_pack_key,role,acts_as_planning_leader,cli_provider,personality) VALUES(?, 'Dami','Dami','operations','video_production','team_leader',1,'codex',?)",
  ).run(
    stableId,
    "Production Manager: clarify the CEO brief, prepare a production plan, and wait for explicit CEO approval.",
  );
  return stableId;
}
export function ingestVideoProductionDirective(
  db: Db,
  input: {
    messageId: string;
    content: string;
    projectPath: string;
    projectId?: string | null;
    brief?: unknown;
    actorId?: string;
    allowProjectBinding?: boolean;
  },
): VideoProductionSnapshot {
  if (!input.messageId?.trim() || !input.content?.trim())
    throw new VideoProductionPolicyError("invalid_video_directive", 400);
  if (!path.isAbsolute(input.projectPath ?? ""))
    throw new VideoProductionPolicyError("absolute_project_path_required", 400);
  const brief = normalizeBrief(input.brief ?? {});
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        content: input.content,
        projectPath: input.projectPath,
        projectId: input.projectId ?? null,
        brief,
      }),
    )
    .digest("hex");
  return transaction(db, () => {
    const existing = db
      .prepare("SELECT project_id,directive_hash FROM video_productions WHERE message_id = ?")
      .get(input.messageId) as { project_id: string; directive_hash: string } | undefined;
    if (existing) {
      if (existing.directive_hash !== hash) throw new VideoProductionPolicyError("directive_idempotency_conflict");
      return getVideoProduction(db, existing.project_id)!;
    }
    const manager = resolveManager(db);
    const projectId = input.projectId ?? randomUUID();
    const rootTaskId = randomUUID();
    const now = Date.now();
    if (input.projectId) {
      const project = db.prepare("SELECT project_path,default_pack_key FROM projects WHERE id = ?").get(projectId) as
        | { project_path: string; default_pack_key: string }
        | undefined;
      if (!project) throw new VideoProductionPolicyError("project_not_found", 404);
      if (path.resolve(project.project_path) !== path.resolve(input.projectPath))
        throw new VideoProductionPolicyError("project_path_mismatch");
      if (project.default_pack_key !== VIDEO_PRODUCTION_PACK) {
        if (!input.allowProjectBinding || db.prepare("SELECT 1 FROM tasks WHERE project_id=? LIMIT 1").get(projectId))
          throw new VideoProductionPolicyError("project_not_video_production");
        db.prepare("UPDATE projects SET default_pack_key=?,updated_at=? WHERE id=?").run(
          VIDEO_PRODUCTION_PACK,
          now,
          projectId,
        );
      }
      if (db.prepare("SELECT 1 FROM video_productions WHERE project_id = ?").get(projectId))
        throw new VideoProductionPolicyError("project_already_has_video_production");
    } else {
      const normalizedPath = path.normalize(input.projectPath);
      const projects = db.prepare("SELECT id,project_path FROM projects").all() as Array<{
        id: string;
        project_path: string;
      }>;
      const comparePath = (value: string) =>
        process.platform === "win32" || process.platform === "darwin"
          ? path.normalize(value).toLowerCase()
          : path.normalize(value);
      if (projects.some((project) => comparePath(project.project_path) === comparePath(normalizedPath))) {
        throw new VideoProductionPolicyError("project_path_conflict");
      }
      db.prepare(
        "INSERT INTO projects(id,name,project_path,core_goal,default_pack_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        projectId,
        brief.title || "Video production",
        input.projectPath,
        input.content,
        VIDEO_PRODUCTION_PACK,
        now,
        now,
      );
    }
    const state = missingFields(brief).length ? "NEEDS_INFORMATION" : "WAITING_FOR_APPROVAL";
    const managerRow = db.prepare("SELECT department_id FROM agents WHERE id = ?").get(manager) as {
      department_id: string | null;
    };
    db.prepare(
      "INSERT INTO tasks(id,title,description,department_id,assigned_agent_id,project_id,status,task_type,workflow_pack_key,workflow_meta_json,project_path,created_at,updated_at) VALUES(?,?,?,?,?,?,'inbox','documentation',?,?,?,?,?)",
    ).run(
      rootTaskId,
      brief.title || "Intake & Planning",
      input.content,
      managerRow.department_id,
      manager,
      projectId,
      VIDEO_PRODUCTION_PACK,
      JSON.stringify({
        videoProduction: { projectId, stage: "intake_planning", execution: "human_only", state, planVersion: 1 },
      }),
      input.projectPath,
      now,
      now,
    );
    db.prepare(
      "INSERT INTO video_productions(project_id,root_task_id,message_id,directive_hash,manager_agent_id,state,brief_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(projectId, rootTaskId, input.messageId, hash, manager, state, JSON.stringify(brief), now, now);
    const configuredManager = db.prepare("SELECT role_key FROM video_production_agent_roles WHERE agent_id=?").get(manager) as { role_key: string } | undefined;
    if (configuredManager?.role_key === "production_manager") {
      db.prepare(`INSERT OR IGNORE INTO video_production_project_grants(project_id,agent_id,grant_key,granted_by,created_at)
        VALUES(?,?,'coordinator',?,?)`).run(projectId, manager, input.actorId ?? "ceo_session", now);
      event(db, projectId, "project_agent_granted", input.actorId ?? "ceo_session", { agentId: manager, roleKey: "production_manager", grantKey: "coordinator", source: "new_project_setup" });
    }
    VIDEO_PRODUCTION_STAGES.forEach((stage, index) => {
      db.prepare(
        "INSERT INTO video_production_stages(project_id,stage_key,stage_order,status,implemented,task_id) VALUES(?,?,?,?,?,?)",
      ).run(
        projectId,
        stage.key,
        index + 1,
        index === 0 ? state : "NOT_IMPLEMENTED",
        index === 0 ? 1 : 0,
        index === 0 ? rootTaskId : null,
      );
    });
    recordPlanVersion(db, projectId, 1, brief, input.actorId ?? "ceo");
    publishPlanningCheckpoint(db, { projectId, rootTaskId, manager, version: 1, brief });
    event(db, projectId, "directive_ingested", input.actorId ?? "ceo", { messageId: input.messageId });
    return getVideoProduction(db, projectId)!;
  });
}
export function saveVideoProductionPlan(
  db: Db,
  projectId: string,
  input: { brief: unknown; expectedVersion: number; actorId?: string },
): VideoProductionSnapshot {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new VideoProductionPolicyError("invalid_plan_version", 400);
  const brief = normalizeBrief(input.brief);
  return transaction(db, () => {
    const row = production(db, projectId);
    if (row.plan_version !== input.expectedVersion) throw new VideoProductionPolicyError("stale_plan_version");
    if (db.prepare("SELECT 1 FROM video_production_stages WHERE project_id = ? AND status = 'RUNNING'").get(projectId))
      throw new VideoProductionPolicyError("production_is_running");
    const state = missingFields(brief).length ? "NEEDS_INFORMATION" : "WAITING_FOR_APPROVAL";
    const version = row.plan_version + 1;
    db.prepare(
      "UPDATE video_productions SET brief_json=?,state=?,plan_version=?,approved_version=NULL,updated_at=? WHERE project_id=?",
    ).run(JSON.stringify(brief), state, version, Date.now(), projectId);
    db.prepare(
      "UPDATE video_production_stages SET status = CASE WHEN stage_key = 'intake_planning' THEN ? WHEN implemented=0 THEN 'NOT_IMPLEMENTED' ELSE 'BLOCKED' END WHERE project_id=?",
    ).run(state, projectId);
    db.prepare(
      "UPDATE tasks SET title=?,status='inbox',completed_at=NULL,workflow_meta_json=?,updated_at=? WHERE id=?",
    ).run(
      brief.title || "Intake & Planning",
      JSON.stringify({
        videoProduction: { projectId, stage: "intake_planning", execution: "human_only", state, planVersion: version },
      }),
      Date.now(),
      row.root_task_id,
    );
    event(db, projectId, "plan_saved", input.actorId ?? row.manager_agent_id, { version });
    recordPlanVersion(db, projectId, version, brief, input.actorId ?? row.manager_agent_id);
    publishPlanningCheckpoint(db, {
      projectId,
      rootTaskId: row.root_task_id,
      manager: row.manager_agent_id,
      version,
      brief,
    });
    return getVideoProduction(db, projectId)!;
  });
}
export function decideVideoProduction(
  db: Db,
  projectId: string,
  input: { version: number; decision: "approve" | "request_changes"; note?: string; actorId?: string },
): VideoProductionSnapshot {
  if (!Number.isSafeInteger(input.version) || input.version < 1)
    throw new VideoProductionPolicyError("invalid_plan_version", 400);
  if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 10000))
    throw new VideoProductionPolicyError("invalid_decision_note", 400);
  if (!["approve", "request_changes"].includes(input.decision))
    throw new VideoProductionPolicyError("invalid_decision", 400);
  return transaction(db, () => {
    const row = production(db, projectId);
    if (row.plan_version !== input.version) throw new VideoProductionPolicyError("stale_plan_version");
    const prior = db
      .prepare("SELECT decision,note FROM video_production_decisions WHERE project_id=? AND version=?")
      .get(projectId, input.version) as { decision: string; note: string } | undefined;
    if (prior) {
      if (prior.decision === input.decision && prior.note === (input.note ?? "").trim())
        return getVideoProduction(db, projectId)!;
      throw new VideoProductionPolicyError("decision_already_recorded");
    }
    if (row.state !== "WAITING_FOR_APPROVAL") throw new VideoProductionPolicyError("plan_not_ready_for_approval");
    const version = db
      .prepare("SELECT brief_json FROM video_production_plan_versions WHERE project_id=? AND version=?")
      .get(projectId, input.version) as { brief_json: string } | undefined;
    if (!version || version.brief_json !== row.brief_json)
      throw new VideoProductionPolicyError("plan_snapshot_mismatch");
    if (missingFields(normalizeBrief(JSON.parse(version.brief_json))).length)
      throw new VideoProductionPolicyError("brief_incomplete");
    const approved = input.decision === "approve";
    const now = Date.now();
    db.prepare(
      "INSERT INTO video_production_decisions(project_id,version,decision,note,actor_id,created_at) VALUES(?,?,?,?,?,?)",
    ).run(projectId, input.version, input.decision, (input.note ?? "").trim(), input.actorId ?? "ceo", now);
    db.prepare("UPDATE video_productions SET state=?,approved_version=?,updated_at=? WHERE project_id=?").run(
      approved ? "APPROVED" : "CHANGES_REQUESTED",
      approved ? input.version : null,
      now,
      projectId,
    );
    db.prepare("UPDATE video_production_stages SET status=? WHERE project_id=? AND stage_key='intake_planning'").run(
      approved ? "COMPLETED" : "CHANGES_REQUESTED",
      projectId,
    );
    if (approved)
      db.prepare(
        "UPDATE video_production_stages SET status=CASE WHEN implemented=1 AND task_id IS NOT NULL THEN 'READY' ELSE 'NOT_IMPLEMENTED' END WHERE project_id=? AND stage_order=2",
      ).run(projectId);
    db.prepare("UPDATE tasks SET status=?,completed_at=?,workflow_meta_json=?,updated_at=? WHERE id=?").run(
      approved ? "done" : "inbox",
      approved ? now : null,
      JSON.stringify({
        videoProduction: {
          projectId,
          stage: "intake_planning",
          execution: "human_only",
          state: approved ? "APPROVED" : "CHANGES_REQUESTED",
          planVersion: input.version,
        },
      }),
      now,
      row.root_task_id,
    );
    event(db, projectId, input.decision, input.actorId ?? "ceo", { version: input.version, note: input.note ?? "" });
    return getVideoProduction(db, projectId)!;
  });
}

function tableExists(db: Db, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
export function isVideoProductionProject(db: Db, projectId: string | null | undefined): boolean {
  if (!projectId || !tableExists(db, "projects")) return false;
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as
    | { default_pack_key?: string }
    | undefined;
  return (
    project?.default_pack_key === VIDEO_PRODUCTION_PACK ||
    (tableExists(db, "video_productions") &&
      Boolean(db.prepare("SELECT 1 FROM video_productions WHERE project_id=?").get(projectId)))
  );
}
export function isManagedVideoProductionTask(db: Db, taskId: string): boolean {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
    | { workflow_pack_key?: string; workflow_meta_json?: string | null; project_id?: string | null }
    | undefined;
  if (!task) return false;
  if (task.workflow_pack_key === VIDEO_PRODUCTION_PACK) return true;
  if (isVideoProductionProject(db, task.project_id)) return true;
  try {
    if (JSON.parse(task.workflow_meta_json ?? "{}").videoProduction) return true;
  } catch {
    /* malformed legacy metadata */
  }
  return (
    tableExists(db, "video_production_stages") &&
    Boolean(db.prepare("SELECT 1 FROM video_production_stages WHERE task_id=?").get(taskId))
  );
}
export function assertVideoProductionTaskAdmission(db: Db, taskId: string, options: { allowPaused?: boolean } = {}): void {
  if (!isManagedVideoProductionTask(db, taskId)) return;
  if (!tableExists(db, "video_production_stages"))
    throw new VideoProductionPolicyError("video_production_not_registered");
  const stage = db
    .prepare(
      "SELECT s.*,p.state AS production_state,p.plan_version,p.approved_version FROM video_production_stages s JOIN video_productions p ON p.project_id=s.project_id WHERE s.task_id=?",
    )
    .get(taskId) as
    | {
        stage_key: string;
        stage_order: number;
        project_id: string;
        status: string;
        implemented: number;
        production_state: string;
        plan_version: number;
        approved_version: number | null;
      }
    | undefined;
  if (!stage) throw new VideoProductionPolicyError("video_production_not_registered");
  if (stage.stage_key === "intake_planning") throw new VideoProductionPolicyError("production_planning_human_only");
  if (!stage.implemented) throw new VideoProductionPolicyError("production_stage_not_implemented");
  if (stage.production_state !== "APPROVED" || stage.approved_version !== stage.plan_version)
    throw new VideoProductionPolicyError("production_approval_required");
  if (stage.status !== "READY" && !(options.allowPaused && stage.status === "PAUSED")) throw new VideoProductionPolicyError("production_stage_not_ready");
  if (
    db
      .prepare(
        "SELECT 1 FROM video_production_stages WHERE project_id=? AND stage_order < ? AND status != 'COMPLETED' LIMIT 1",
      )
      .get(stage.project_id, stage.stage_order)
  )
    throw new VideoProductionPolicyError("production_dependency_incomplete");
  const slot = db.prepare("SELECT task_id FROM video_production_slot WHERE singleton=1").get() as {
    task_id: string | null;
  };
  if (slot.task_id && slot.task_id !== taskId) throw new VideoProductionPolicyError("production_slot_busy");
}
export function reserveVideoProductionTask(db: Db, taskId: string): string {
  return claimVideoProductionAttempt(db, taskId, randomUUID());
}
export function reserveVideoProductionAttempt(db: Db, taskId: string, attemptId: string): void {
  claimVideoProductionAttempt(db, taskId, attemptId);
}
/** Claim task state and the production singleton in one committed transaction before launch. */
export function claimVideoProductionAttempt(
  db: Db,
  taskId: string,
  attemptId: string = randomUUID(),
  workerKind = "external_cli",
  assignedAgentId?: string,
  resumeFromAttemptId?: string,
): string {
  if ((db as DatabaseSync).isTransaction) {
    throw new VideoProductionPolicyError("production_claim_requires_top_level_commit", 503);
  }
  transaction(db, () => {
    if (resumeFromAttemptId) {
      const prior = db.prepare("SELECT project_id,plan_version,assigned_agent_id,state FROM video_production_attempts WHERE task_id=? AND attempt_id=?").get(taskId, resumeFromAttemptId) as
        | { project_id: string; plan_version: number; assigned_agent_id: string | null; state: string }
        | undefined;
      const current = db.prepare("SELECT s.project_id,p.plan_version,p.state,p.approved_version,t.assigned_agent_id FROM video_production_stages s JOIN video_productions p ON p.project_id=s.project_id JOIN tasks t ON t.id=s.task_id WHERE s.task_id=?").get(taskId) as
        | { project_id: string; plan_version: number; state: string; approved_version: number | null; assigned_agent_id: string | null }
        | undefined;
      const latest = db.prepare("SELECT attempt_id FROM video_production_attempts WHERE task_id=? ORDER BY rowid DESC LIMIT 1").get(taskId) as { attempt_id: string } | undefined;
      if (!prior || prior.state !== "PAUSED" || latest?.attempt_id !== resumeFromAttemptId || !current || prior.project_id !== current.project_id || prior.plan_version !== current.plan_version || prior.assigned_agent_id !== current.assigned_agent_id) {
        throw new VideoProductionPolicyError("production_resume_snapshot_mismatch");
      }
      if (current.state !== "APPROVED" || current.approved_version !== current.plan_version) {
        throw new VideoProductionPolicyError("production_approval_required");
      }
      db.prepare("UPDATE video_production_stages SET status='READY' WHERE task_id=? AND status='PAUSED' AND implemented=1").run(taskId);
    }
    assertVideoProductionTaskAdmission(db, taskId);
    if (!isManagedVideoProductionTask(db, taskId)) throw new VideoProductionPolicyError("not_video_production_task");
    const stage = db.prepare("SELECT s.project_id,p.plan_version,p.manager_agent_id,t.assigned_agent_id FROM video_production_stages s JOIN video_productions p ON p.project_id=s.project_id JOIN tasks t ON t.id=s.task_id WHERE s.task_id=?").get(taskId) as
      | { project_id: string; plan_version: number; manager_agent_id: string; assigned_agent_id: string | null }
      | undefined;
    if (!stage) throw new VideoProductionPolicyError("production_stage_not_ready");
    if (assignedAgentId && stage.assigned_agent_id && assignedAgentId !== stage.assigned_agent_id) {
      throw new VideoProductionPolicyError("production_assignee_identity_mismatch", 403);
    }
    const now = Date.now();
    const taskClaim = db
      .prepare("UPDATE tasks SET status='in_progress',assigned_agent_id=COALESCE(?,assigned_agent_id),started_at=?,updated_at=? WHERE id=? AND status IN ('inbox','planned','pending')")
      .run(assignedAgentId ?? null, now, now, taskId);
    if (!taskClaim.changes) throw new VideoProductionPolicyError("production_task_claim_failed");
    const slotClaim = db
      .prepare("UPDATE video_production_slot SET task_id=?,attempt_id=?,acquired_at=? WHERE singleton=1 AND task_id IS NULL")
      .run(taskId, attemptId, now);
    if (!slotClaim.changes) throw new VideoProductionPolicyError("production_slot_busy");
    const stageClaim = db
      .prepare("UPDATE video_production_stages SET status='RUNNING' WHERE task_id=? AND status='READY' AND implemented=1")
      .run(taskId);
    if (!stageClaim.changes) throw new VideoProductionPolicyError("production_stage_not_ready");
    db.prepare(
      "INSERT INTO video_production_attempts(attempt_id,task_id,project_id,state,worker_kind,plan_version,assigned_agent_id,created_at,updated_at) VALUES(?,?,?,'PREPARED',?,?,?,?,?)",
    ).run(attemptId, taskId, stage.project_id, workerKind, stage.plan_version, assignedAgentId ?? stage.assigned_agent_id, now, now);
    event(db, stage.project_id, "execution_attempt_prepared", "system", { attemptId, taskId, workerKind });
  });
  return attemptId;
}
export function setVideoProductionAttemptLaunchState(
  db: Db,
  taskId: string,
  attemptId: string,
  state: "LAUNCHING" | "RUNNING" | "RECONCILIATION_REQUIRED",
  input: { workerIdentity?: string; pid?: number | null; imageId?: string; detail?: unknown } = {},
): boolean {
  return transaction(db, () => {
    if (!requireOwnedVideoProductionAttempt(db, taskId, attemptId)) return false;
    const result = db.prepare(
      "UPDATE video_production_attempts SET state=?,worker_identity=COALESCE(?,worker_identity),pid=COALESCE(?,pid),container_id=COALESCE(?,container_id),image_id=COALESCE(?,image_id),detail_json=?,updated_at=? WHERE attempt_id=? AND task_id=? AND state IN ('PREPARED','LAUNCHING','RUNNING','RECONCILIATION_REQUIRED') AND NOT (state='RUNNING' AND ?='LAUNCHING') AND EXISTS (SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id=? AND attempt_id=?)",
    ).run(state, input.workerIdentity ?? null, input.pid ?? null, input.workerIdentity ?? null, input.imageId ?? null, JSON.stringify(input.detail ?? {}), Date.now(), attemptId, taskId, state, taskId, attemptId);
    return result.changes === 1;
  });
}
export function finishVideoProductionAttempt(
  db: Db,
  taskId: string,
  attemptId: string,
  outcome: "completed" | "failed",
  detail: unknown = {},
): boolean {
  return transaction(db, () => {
    if (!requireOwnedVideoProductionAttempt(db, taskId, attemptId)) return false;
    const state = outcome === "completed" ? "COMPLETED" : "FAILED";
    const attempt = db.prepare(
      "UPDATE video_production_attempts SET state=?,detail_json=?,updated_at=?,finished_at=? WHERE attempt_id=? AND task_id=? AND state IN ('PREPARED','LAUNCHING','RUNNING','COMPLETING','RECONCILIATION_REQUIRED')",
    ).run(state, JSON.stringify(detail), Date.now(), Date.now(), attemptId, taskId);
    if (attempt.changes !== 1) return false;
    db.prepare("UPDATE video_production_stages SET status=? WHERE task_id=? AND status='RUNNING'").run(
      outcome === "completed" ? "COMPLETED" : "FAILED",
      taskId,
    );
    db.prepare("UPDATE tasks SET status=?,completed_at=?,updated_at=? WHERE id=? AND status='in_progress'").run(
      outcome === "completed" ? "done" : "pending",
      outcome === "completed" ? Date.now() : null,
      Date.now(),
      taskId,
    );
    db.prepare("UPDATE video_production_slot SET task_id=NULL,attempt_id=NULL,acquired_at=NULL WHERE singleton=1 AND task_id=? AND attempt_id=?").run(taskId, attemptId);
    const project = db.prepare("SELECT project_id FROM video_production_attempts WHERE attempt_id=?").get(attemptId) as { project_id: string };
    event(db, project.project_id, "execution_attempt_finished", "system", { attemptId, taskId, outcome });
    return true;
  });
}

/** Record a verified successful process exit without asserting that an artifact passed review. */
export function finishVideoProductionExecutionPendingReview(
  db: Db,
  taskId: string,
  attemptId: string,
  detail: unknown = {},
): boolean {
  return transaction(db, () => {
    if (!requireOwnedVideoProductionAttempt(db, taskId, attemptId)) return false;
    const now = Date.now();
    const attempt = db.prepare(
      "UPDATE video_production_attempts SET state='COMPLETED',detail_json=?,updated_at=?,finished_at=? WHERE task_id=? AND attempt_id=? AND state IN ('LAUNCHING','RUNNING','COMPLETING','RECONCILIATION_REQUIRED') AND EXISTS (SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id=? AND attempt_id=?)",
    ).run(JSON.stringify({ outcome: "execution_succeeded_pending_artifact_review", ...((detail && typeof detail === "object") ? detail as object : { detail }) }), now, now, taskId, attemptId, taskId, attemptId);
    if (attempt.changes !== 1) return false;
    db.prepare("UPDATE video_production_stages SET status='BLOCKED' WHERE task_id=? AND status='RUNNING'").run(taskId);
    db.prepare("UPDATE tasks SET status='review',completed_at=?,updated_at=? WHERE id=? AND status='in_progress'").run(now, now, taskId);
    const released = db.prepare("UPDATE video_production_slot SET task_id=NULL,attempt_id=NULL,acquired_at=NULL WHERE singleton=1 AND task_id=? AND attempt_id=?").run(taskId, attemptId);
    if (released.changes !== 1) throw new VideoProductionPolicyError("production_attempt_ownership_lost", 409);
    const project = db.prepare("SELECT project_id FROM video_production_attempts WHERE attempt_id=? AND task_id=?").get(attemptId, taskId) as { project_id: string };
    event(db, project.project_id, "execution_attempt_finished_pending_review", "system", { attemptId, taskId });
    return true;
  });
}

export function requireOwnedVideoProductionAttempt(db: Db, taskId: string, attemptId: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id=? AND attempt_id=?").get(taskId, attemptId) &&
      db.prepare("SELECT 1 FROM video_production_attempts WHERE task_id=? AND attempt_id=? AND state IN ('PREPARED','LAUNCHING','RUNNING','COMPLETING','RECONCILIATION_REQUIRED')").get(taskId, attemptId),
  );
}
export function beginVideoProductionCompletion(db: Db, taskId: string, attemptId: string): boolean {
  const result = db.prepare(
    "UPDATE video_production_attempts SET state='COMPLETING',updated_at=? WHERE task_id=? AND attempt_id=? AND state IN ('RUNNING','RECONCILIATION_REQUIRED') AND EXISTS (SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id=? AND attempt_id=?)",
  ).run(Date.now(), taskId, attemptId, taskId, attemptId);
  return result.changes === 1;
}
export function holdVideoProductionAttemptForReconciliation(
  db: Db,
  taskId: string,
  attemptId: string,
  detail: unknown,
): boolean {
  const result = db.prepare(
    "UPDATE video_production_attempts SET state='RECONCILIATION_REQUIRED',detail_json=?,updated_at=? WHERE task_id=? AND attempt_id=? AND state='COMPLETING' AND EXISTS (SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id=? AND attempt_id=?)",
  ).run(JSON.stringify(detail), Date.now(), taskId, attemptId, taskId, attemptId);
  return result.changes === 1;
}
export function markVideoProductionAttemptReconciliationRequired(
  db: Db,
  taskId: string,
  attemptId: string,
  detail: unknown,
): boolean {
  return db.prepare(
    "UPDATE video_production_attempts SET state='RECONCILIATION_REQUIRED',detail_json=?,updated_at=? WHERE task_id=? AND attempt_id=? AND state IN ('PREPARED','LAUNCHING','RUNNING','COMPLETING','RECONCILIATION_REQUIRED') AND EXISTS (SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id=? AND attempt_id=?)",
  ).run(JSON.stringify(detail), Date.now(), taskId, attemptId, taskId, attemptId).changes === 1;
}
export function recordVideoProductionRecoveryEvent(db: Db, taskId: string, attemptId: string, detail: unknown): void {
  const row = db.prepare("SELECT project_id FROM video_production_attempts WHERE task_id=? AND attempt_id=?").get(taskId, attemptId) as
    | { project_id: string }
    | undefined;
  if (row) event(db, row.project_id, "execution_recovery_checked", "system", { taskId, attemptId, ...((detail && typeof detail === "object") ? detail as object : { detail }) });
}
export function releaseVideoProductionTask(
  db: Db,
  taskId: string,
  input: { outcome: "completed" | "failed" | "paused"; attemptId: string; detail?: unknown },
): void {
  transaction(db, () => {
    const slot = db.prepare("SELECT task_id,attempt_id FROM video_production_slot WHERE singleton=1").get() as {
      task_id: string | null;
      attempt_id: string | null;
    };
    if (slot.task_id !== taskId || slot.attempt_id !== input.attemptId) return;
    const terminal = input.outcome === "completed" ? "COMPLETED" : input.outcome === "paused" ? "PAUSED" : "FAILED";
    const owned = db.prepare(
      "UPDATE video_production_attempts SET state=?,detail_json=?,updated_at=?,finished_at=? WHERE task_id=? AND attempt_id=? AND state IN ('PREPARED','LAUNCHING','RUNNING','COMPLETING','RECONCILIATION_REQUIRED')",
    ).run(terminal, JSON.stringify(input.detail ?? {}), Date.now(), Date.now(), taskId, input.attemptId);
    if (!owned.changes) return;
    db.prepare("UPDATE video_production_stages SET status=? WHERE task_id=?").run(
      input.outcome === "completed" ? "COMPLETED" : input.outcome === "failed" ? "FAILED" : "PAUSED",
      taskId,
    );
    db.prepare("UPDATE tasks SET status=?,completed_at=?,updated_at=? WHERE id=? AND status='in_progress'").run(
      input.outcome === "completed" ? "done" : "pending",
      input.outcome === "completed" ? Date.now() : null,
      Date.now(),
      taskId,
    );
    const attemptOwner = db.prepare("SELECT assigned_agent_id FROM video_production_attempts WHERE task_id=? AND attempt_id=?").get(taskId, input.attemptId) as { assigned_agent_id: string | null } | undefined;
    if (attemptOwner?.assigned_agent_id) {
      db.prepare("UPDATE agents SET status='idle',current_task_id=NULL WHERE id=? AND current_task_id=?").run(attemptOwner.assigned_agent_id, taskId);
    }
    db.prepare("UPDATE video_production_slot SET task_id=NULL,attempt_id=NULL,acquired_at=NULL WHERE singleton=1 AND task_id=? AND attempt_id=?").run(taskId, input.attemptId);
  });
}
