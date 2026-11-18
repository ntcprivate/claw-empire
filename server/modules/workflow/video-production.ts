import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { VIDEO_STUDIO_STAGE_OWNERSHIP, type VideoStudioAction, type VideoStudioRoleKey } from "../../../shared/video-studio-organization.ts";
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
    : `[Production planning checkpoint — biểu mẫu tự động]\nProject Brief và kế hoạch 9 giai đoạn phiên bản ${row.version} đã sẵn sàng để CEO xem xét. Vui lòng chọn Approve hoặc Request Changes. Sau khi phê duyệt, hệ thống tự chạy các job đủ điều kiện và dừng khi cần CEO duyệt phát hành, gặp lỗi hoặc được yêu cầu hủy.`;
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
    automation: (db.prepare("SELECT state,reason,task_id,plan_version FROM video_production_auto_runs WHERE project_id=?").get(projectId) as VideoProductionSnapshot["automation"]) ?? null,
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
    db.prepare("UPDATE video_production_auto_runs SET state='WAITING_CEO',reason='production_approval_required',updated_at=? WHERE project_id=? AND state='RUNNING'")
      .run(Date.now(), projectId);
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
    if (approved) {
      db.prepare(`INSERT INTO video_production_auto_runs(project_id,plan_version,state,updated_at) VALUES(?,?,'RUNNING',?)
        ON CONFLICT(project_id) DO UPDATE SET plan_version=excluded.plan_version,state='RUNNING',task_id=NULL,reason=NULL,jobs_started=0,updated_at=excluded.updated_at`)
        .run(projectId, input.version, now);
    }
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
  if (stage.stage_key === "ai_footage_production") {
    const job = db.prepare(`SELECT j.project_id,j.plan_version,j.stage_key,j.execution_action,j.assigned_agent_id,j.state,j.shot_id,j.shot_version,j.target_take_id,j.target_asset_id,j.target_asset_sha256,
        t.assigned_agent_id AS task_assignee,p.plan_version AS current_plan
      FROM video_production_stage_jobs j JOIN tasks t ON t.id=j.task_id
      JOIN video_productions p ON p.project_id=j.project_id
      WHERE j.task_id=?`).get(taskId) as { project_id: string; plan_version: number; stage_key: string; execution_action: string; assigned_agent_id: string; state: string; shot_id: string | null; shot_version: number | null; target_take_id: string | null; target_asset_id: string | null; target_asset_sha256: string | null; task_assignee: string | null; current_plan: number } | undefined;
    const jobReady = job?.state === "READY" || (options.allowPaused && job?.state === "PAUSED");
    if (!job || !jobReady || job.stage_key !== stage.stage_key || job.project_id !== stage.project_id || job.plan_version !== job.current_plan || job.task_assignee !== job.assigned_agent_id || !job.shot_id || !job.shot_version || !["footage.submit", "take.review", "regeneration.request"].includes(job.execution_action)) {
      throw new VideoProductionPolicyError("production_stage_job_invalid", 409);
    }
    const currentShot = db.prepare("SELECT current_version,deleted_at FROM video_production_shots WHERE project_id=? AND shot_id=?").get(job.project_id, job.shot_id) as { current_version: number; deleted_at: number | null } | undefined;
    if (!currentShot || currentShot.deleted_at !== null || currentShot.current_version !== job.shot_version) throw new VideoProductionPolicyError("production_stage_job_shot_stale", 409);
    if (job.execution_action === "take.review" && (!job.target_take_id || !job.target_asset_id || !job.target_asset_sha256 || !db.prepare(`SELECT 1 FROM video_production_takes t JOIN video_production_assets a
        ON a.project_id=t.project_id AND a.asset_id=t.asset_id WHERE t.project_id=? AND t.take_id=? AND t.shot_id=? AND t.shot_version=?
        AND t.asset_id=? AND a.sha256=?`).get(job.project_id, job.target_take_id, job.shot_id, job.shot_version, job.target_asset_id, job.target_asset_sha256))) {
      throw new VideoProductionPolicyError("production_stage_job_target_stale", 409);
    }
    if (job.execution_action === "regeneration.request") {
      const coordinator = db.prepare("SELECT role_key FROM video_production_agent_roles WHERE agent_id=?").get(job.assigned_agent_id) as { role_key: string } | undefined;
      const grant = db.prepare("SELECT grant_key FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").get(job.project_id, job.assigned_agent_id) as { grant_key: string } | undefined;
      const rejected = job.target_take_id ? db.prepare("SELECT decision FROM video_production_take_reviews WHERE project_id=? AND take_id=? ORDER BY review_number DESC LIMIT 1").get(job.project_id, job.target_take_id) as { decision: string } | undefined : undefined;
      const policy = VIDEO_STUDIO_STAGE_OWNERSHIP.find((item) => item.stageKey === "ai_footage_production");
      if (coordinator?.role_key !== "production_manager" || grant?.grant_key !== "coordinator" || rejected?.decision !== "rejected" || !job.target_take_id ||
        !policy?.sequence.some((step) => step.kind === "agent" && step.roleKey === "production_manager" && step.action === "regeneration.request" && step.condition === "take_rejected")) throw new VideoProductionPolicyError("production_stage_job_target_stale", 409);
    }
  }
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

/** Creates one approved-plan-bound shot job using the existing tasks table and stage pointer. */
export function createVideoProductionShotRenderJob(db: Db, input: {
  projectId: string;
  shotId: string;
  shotVersion: number;
  agentId: string;
  idempotencyKey: string;
  createdBy: string;
}): { taskId: string; stageKey: string; action: VideoStudioAction; agentId: string; shotId: string; shotVersion: number } {
  if ((db as DatabaseSync).isTransaction) throw new VideoProductionPolicyError("production_job_requires_top_level_commit", 503);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey)) throw new VideoProductionPolicyError("production_job_idempotency_key_invalid", 400);
  return transaction(db, () => {
    const prior = db.prepare("SELECT task_id,stage_key,execution_action,assigned_agent_id,shot_id,shot_version FROM video_production_stage_jobs WHERE project_id=? AND idempotency_key=?").get(input.projectId, input.idempotencyKey) as
      | { task_id: string; stage_key: string; execution_action: string; assigned_agent_id: string; shot_id: string; shot_version: number }
      | undefined;
    if (prior) {
      if (prior.stage_key !== "ai_footage_production" || prior.execution_action !== "footage.submit" || prior.assigned_agent_id !== input.agentId || prior.shot_id !== input.shotId || prior.shot_version !== input.shotVersion) {
        throw new VideoProductionPolicyError("production_job_idempotency_conflict", 409);
      }
      return { taskId: prior.task_id, stageKey: prior.stage_key, action: "footage.submit", agentId: prior.assigned_agent_id, shotId: prior.shot_id, shotVersion: prior.shot_version };
    }
    const production = db.prepare("SELECT plan_version,approved_version,state,manager_agent_id FROM video_productions WHERE project_id=?").get(input.projectId) as
      | { plan_version: number; approved_version: number | null; state: string; manager_agent_id: string }
      | undefined;
    if (!production || production.state !== "APPROVED" || production.approved_version !== production.plan_version) throw new VideoProductionPolicyError("production_approval_required");
    const stage = db.prepare("SELECT stage_order,status,implemented,task_id FROM video_production_stages WHERE project_id=? AND stage_key='ai_footage_production'").get(input.projectId) as
      | { stage_order: number; status: string; implemented: number; task_id: string | null }
      | undefined;
    if (!stage) throw new VideoProductionPolicyError("video_production_stage_not_found", 404);
    if (db.prepare("SELECT 1 FROM video_production_stages WHERE project_id=? AND stage_order<? AND status!='COMPLETED' LIMIT 1").get(input.projectId, stage.stage_order)) {
      throw new VideoProductionPolicyError("production_dependency_incomplete", 409);
    }
    if (db.prepare("SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id IS NOT NULL").get()) throw new VideoProductionPolicyError("production_slot_busy", 409);
    if (input.createdBy !== "ceo_session") {
      const manager = db.prepare("SELECT manager_agent_id FROM video_productions WHERE project_id=?").get(input.projectId) as { manager_agent_id: string } | undefined;
      const grant = db.prepare("SELECT grant_key FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").get(input.projectId, input.createdBy) as { grant_key: string } | undefined;
      if (manager?.manager_agent_id !== input.createdBy || grant?.grant_key !== "coordinator") throw new VideoProductionPolicyError("production_job_actor_not_authorized", 403);
    }
    if (stage.task_id) {
      const previous = db.prepare("SELECT state FROM video_production_stage_jobs WHERE task_id=? AND project_id=?").get(stage.task_id, input.projectId) as { state: string } | undefined;
      if (stage.status !== "BLOCKED" || !previous || previous.state !== "COMPLETED") throw new VideoProductionPolicyError("production_stage_already_has_current_job", 409);
    }
    const shot = db.prepare("SELECT current_version,deleted_at FROM video_production_shots WHERE project_id=? AND shot_id=?").get(input.projectId, input.shotId) as { current_version: number; deleted_at: number | null } | undefined;
    if (!shot || shot.deleted_at !== null || shot.current_version !== input.shotVersion) throw new VideoProductionPolicyError("production_stage_job_shot_stale", 409);
    if (db.prepare("SELECT 1 FROM video_production_approved_takes WHERE project_id=? AND shot_id=? AND shot_version=?").get(input.projectId, input.shotId, input.shotVersion)) {
      throw new VideoProductionPolicyError("approved_shot_cannot_be_regenerated", 409);
    }
    const submittedTake = db.prepare("SELECT take_id FROM video_production_takes WHERE project_id=? AND shot_id=? AND shot_version=? ORDER BY take_number DESC LIMIT 1").get(input.projectId, input.shotId, input.shotVersion) as { take_id: string } | undefined;
    if (submittedTake && !db.prepare("SELECT 1 FROM video_production_regeneration_requests WHERE project_id=? AND shot_id=? AND shot_version=? AND rejected_take_id=?").get(input.projectId, input.shotId, input.shotVersion, submittedTake.take_id)) {
      throw new VideoProductionPolicyError("shot_regeneration_request_required", 409);
    }
    const target = db.prepare("SELECT a.department_id,r.role_key FROM agents a JOIN video_production_agent_roles r ON r.agent_id=a.id WHERE a.id=? AND a.workflow_pack_key='video_production'").get(input.agentId) as { department_id: string; role_key: VideoStudioRoleKey } | undefined;
    if (!target || target.role_key !== "video_producer" || !VIDEO_STUDIO_STAGE_OWNERSHIP.find((item) => item.stageKey === "ai_footage_production")?.sequence.some((step) => step.kind === "agent" && step.roleKey === target.role_key && step.action === "footage.submit")) {
      throw new VideoProductionPolicyError("unsupported_stage_assignment", 409);
    }
    if (!db.prepare("SELECT 1 FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").get(input.projectId, input.agentId)) {
      throw new VideoProductionPolicyError("video_production_project_grant_required", 403);
    }
    const now = Date.now();
    const taskId = randomUUID();
    db.prepare(`INSERT INTO tasks(id,title,description,department_id,assigned_agent_id,project_id,status,workflow_pack_key,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'inbox','video_production',?,?)`).run(taskId, `Render shot ${input.shotId} v${input.shotVersion}`, `Server-owned Remotion render job for approved shot ${input.shotId} version ${input.shotVersion}.`, target.department_id, input.agentId, input.projectId, now, now);
    db.prepare(`INSERT INTO video_production_stage_jobs(task_id,project_id,plan_version,stage_key,execution_action,assigned_agent_id,idempotency_key,shot_id,shot_version,state,created_by,created_at,updated_at)
      VALUES(?,?,?,'ai_footage_production','footage.submit',?,?,?,?,'READY',?,?,?)`).run(taskId, input.projectId, production.plan_version, input.agentId, input.idempotencyKey, input.shotId, input.shotVersion, input.createdBy, now, now);
    const pointer = db.prepare("UPDATE video_production_stages SET implemented=1,status='READY',task_id=? WHERE project_id=? AND stage_key='ai_footage_production' AND task_id IS ? AND status IN ('BLOCKED','NOT_IMPLEMENTED','READY')").run(taskId, input.projectId, stage.task_id);
    if (pointer.changes !== 1) throw new VideoProductionPolicyError("production_stage_pointer_conflict", 409);
    event(db, input.projectId, "production_stage_job_created", input.createdBy, { taskId, stageKey: "ai_footage_production", action: "footage.submit", shotId: input.shotId, shotVersion: input.shotVersion, agentId: input.agentId, planVersion: production.plan_version });
    return { taskId, stageKey: "ai_footage_production", action: "footage.submit", agentId: input.agentId, shotId: input.shotId, shotVersion: input.shotVersion };
  });
}

/** Queue Yuna's exact take review after Miro's imported render is waiting for review. */
export function createVideoProductionTakeReviewJob(db: Db, input: { projectId: string; shotId: string; shotVersion: number; agentId: string; idempotencyKey: string; createdBy: string }): { taskId: string; stageKey: string; action: VideoStudioAction; agentId: string; shotId: string; shotVersion: number; takeId: string } {
  if ((db as DatabaseSync).isTransaction) throw new VideoProductionPolicyError("production_job_requires_top_level_commit", 503);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey)) throw new VideoProductionPolicyError("production_job_idempotency_key_invalid", 400);
  return transaction(db, () => {
    const prior = db.prepare("SELECT task_id,stage_key,execution_action,assigned_agent_id,shot_id,shot_version,target_take_id FROM video_production_stage_jobs WHERE project_id=? AND idempotency_key=?").get(input.projectId, input.idempotencyKey) as { task_id: string; stage_key: string; execution_action: string; assigned_agent_id: string; shot_id: string; shot_version: number; target_take_id: string | null } | undefined;
    if (prior) {
      if (prior.stage_key !== "ai_footage_production" || prior.execution_action !== "take.review" || prior.assigned_agent_id !== input.agentId || prior.shot_id !== input.shotId || prior.shot_version !== input.shotVersion) throw new VideoProductionPolicyError("production_job_idempotency_conflict", 409);
      if (!prior.target_take_id) throw new VideoProductionPolicyError("take_review_target_missing", 409);
      return { taskId: prior.task_id, stageKey: prior.stage_key, action: "take.review", agentId: prior.assigned_agent_id, shotId: prior.shot_id, shotVersion: prior.shot_version, takeId: prior.target_take_id };
    }
    const production = db.prepare("SELECT plan_version,approved_version,state,manager_agent_id FROM video_productions WHERE project_id=?").get(input.projectId) as { plan_version: number; approved_version: number | null; state: string; manager_agent_id: string } | undefined;
    const stage = db.prepare("SELECT status,task_id FROM video_production_stages WHERE project_id=? AND stage_key='ai_footage_production'").get(input.projectId) as { status: string; task_id: string | null } | undefined;
    const priorJob = stage?.task_id ? db.prepare("SELECT state,shot_id,shot_version FROM video_production_stage_jobs WHERE project_id=? AND task_id=?").get(input.projectId, stage.task_id) as { state: string; shot_id: string | null; shot_version: number | null } | undefined : undefined;
    if (!production || production.state !== "APPROVED" || production.approved_version !== production.plan_version || !stage || stage.status !== "BLOCKED" || !priorJob || priorJob.state !== "WAITING_APPROVAL" || priorJob.shot_id !== input.shotId || priorJob.shot_version !== input.shotVersion) throw new VideoProductionPolicyError("take_review_not_ready", 409);
    const shot = db.prepare("SELECT current_version,deleted_at FROM video_production_shots WHERE project_id=? AND shot_id=?").get(input.projectId, input.shotId) as { current_version: number; deleted_at: number | null } | undefined;
    const take = db.prepare(`SELECT t.take_id,t.asset_id,a.sha256 FROM video_production_takes t JOIN video_production_assets a ON a.project_id=t.project_id AND a.asset_id=t.asset_id
      WHERE t.project_id=? AND t.shot_id=? AND t.shot_version=? ORDER BY t.take_number DESC LIMIT 1`).get(input.projectId, input.shotId, input.shotVersion) as { take_id: string; asset_id: string; sha256: string } | undefined;
    if (!shot || shot.deleted_at !== null || shot.current_version !== input.shotVersion || !take || db.prepare("SELECT 1 FROM video_production_approved_takes WHERE project_id=? AND shot_id=? AND shot_version=?").get(input.projectId, input.shotId, input.shotVersion)) throw new VideoProductionPolicyError("take_review_not_ready", 409);
    const target = db.prepare("SELECT department_id FROM agents WHERE id=? AND workflow_pack_key='video_production'").get(input.agentId) as { department_id: string } | undefined;
    const role = db.prepare("SELECT role_key FROM video_production_agent_roles WHERE agent_id=?").get(input.agentId) as { role_key: string } | undefined;
    if (!target || role?.role_key !== "art_director" || !db.prepare("SELECT 1 FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").get(input.projectId, input.agentId)) throw new VideoProductionPolicyError("unsupported_stage_assignment", 409);
    if (input.createdBy !== "ceo_session" && (input.createdBy !== production.manager_agent_id || !db.prepare("SELECT 1 FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND grant_key='coordinator' AND revoked_at IS NULL").get(input.projectId, input.createdBy))) throw new VideoProductionPolicyError("production_job_actor_not_authorized", 403);
    const taskId = randomUUID(); const now = Date.now();
    db.prepare("INSERT INTO tasks(id,title,description,department_id,assigned_agent_id,project_id,status,workflow_pack_key,created_at,updated_at) VALUES(?,?,?,?,?,?,'inbox','video_production',?,?)").run(taskId, `Review take ${take.take_id}`, `Yuna reviews the exact imported take for ${input.shotId} v${input.shotVersion}.`, target.department_id, input.agentId, input.projectId, now, now);
    db.prepare(`INSERT INTO video_production_stage_jobs(task_id,project_id,plan_version,stage_key,execution_action,assigned_agent_id,idempotency_key,shot_id,shot_version,state,created_by,created_at,updated_at,target_take_id,target_asset_id,target_asset_sha256)
      VALUES(?,?,?,'ai_footage_production','take.review',?,?,?,?,'READY',?,?,?,?,?,?)`).run(taskId, input.projectId, production.plan_version, input.agentId, input.idempotencyKey, input.shotId, input.shotVersion, input.createdBy, now, now, take.take_id, take.asset_id, take.sha256);
    const pointer = db.prepare("UPDATE video_production_stages SET status='READY',task_id=? WHERE project_id=? AND stage_key='ai_footage_production' AND status='BLOCKED' AND task_id=?").run(taskId, input.projectId, stage.task_id);
    if (pointer.changes !== 1) throw new VideoProductionPolicyError("production_stage_pointer_conflict", 409);
    event(db, input.projectId, "production_stage_job_created", input.createdBy, { taskId, stageKey: "ai_footage_production", action: "take.review", agentId: input.agentId, takeId: take.take_id, shotId: input.shotId, shotVersion: input.shotVersion });
    return { taskId, stageKey: "ai_footage_production", action: "take.review", agentId: input.agentId, shotId: input.shotId, shotVersion: input.shotVersion, takeId: take.take_id };
  });
}

/** Dami's deterministic coordinator step after a rejected take; no model call or client-selected command. */
export function createVideoProductionRegenerationCoordinatorJob(db: Db, input: { projectId: string; shotId: string; shotVersion: number; rejectedTakeId: string; idempotencyKey: string; createdBy: string }): { taskId: string; stageKey: string; action: VideoStudioAction; agentId: string; shotId: string; shotVersion: number; takeId: string } {
  if ((db as DatabaseSync).isTransaction) throw new VideoProductionPolicyError("production_job_requires_top_level_commit", 503);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey)) throw new VideoProductionPolicyError("production_job_idempotency_key_invalid", 400);
  return transaction(db, () => {
    const prior = db.prepare("SELECT task_id,assigned_agent_id,shot_id,shot_version,target_take_id FROM video_production_stage_jobs WHERE project_id=? AND idempotency_key=?").get(input.projectId, input.idempotencyKey) as { task_id: string; assigned_agent_id: string; shot_id: string; shot_version: number; target_take_id: string | null } | undefined;
    if (prior) {
      if (prior.assigned_agent_id !== "video_production-seed-5" || prior.shot_id !== input.shotId || prior.shot_version !== input.shotVersion || prior.target_take_id !== input.rejectedTakeId) throw new VideoProductionPolicyError("production_job_idempotency_conflict", 409);
      return { taskId: prior.task_id, stageKey: "ai_footage_production", action: "regeneration.request", agentId: prior.assigned_agent_id, shotId: prior.shot_id, shotVersion: prior.shot_version, takeId: input.rejectedTakeId };
    }
    const production = db.prepare("SELECT plan_version,approved_version,state,manager_agent_id FROM video_productions WHERE project_id=?").get(input.projectId) as { plan_version: number; approved_version: number | null; state: string; manager_agent_id: string } | undefined;
    const stage = db.prepare("SELECT status,task_id FROM video_production_stages WHERE project_id=? AND stage_key='ai_footage_production'").get(input.projectId) as { status: string; task_id: string | null } | undefined;
    const previous = stage?.task_id ? db.prepare("SELECT state,execution_action,shot_id,shot_version FROM video_production_stage_jobs WHERE project_id=? AND task_id=?").get(input.projectId, stage.task_id) as { state: string; execution_action: string; shot_id: string | null; shot_version: number | null } | undefined : undefined;
    const role = db.prepare("SELECT role_key,department_id FROM video_production_agent_roles r JOIN agents a ON a.id=r.agent_id WHERE r.agent_id=? AND a.workflow_pack_key='video_production'").get("video_production-seed-5") as { role_key: string; department_id: string } | undefined;
    const coordinatorGrant = db.prepare("SELECT grant_key FROM video_production_project_grants WHERE project_id=? AND agent_id='video_production-seed-5' AND revoked_at IS NULL").get(input.projectId) as { grant_key: string } | undefined;
    const shot = db.prepare("SELECT current_version,deleted_at FROM video_production_shots WHERE project_id=? AND shot_id=?").get(input.projectId, input.shotId) as { current_version: number; deleted_at: number | null } | undefined;
    const rejected = db.prepare(`SELECT r.decision FROM video_production_take_reviews r JOIN video_production_takes t ON t.project_id=r.project_id AND t.take_id=r.take_id
      WHERE r.project_id=? AND r.take_id=? AND t.shot_id=? AND t.shot_version=? ORDER BY r.review_number DESC LIMIT 1`).get(input.projectId, input.rejectedTakeId, input.shotId, input.shotVersion) as { decision: string } | undefined;
    const rejectedTake = db.prepare("SELECT t.asset_id,a.sha256 FROM video_production_takes t JOIN video_production_assets a ON a.project_id=t.project_id AND a.asset_id=t.asset_id WHERE t.project_id=? AND t.take_id=? AND t.shot_id=? AND t.shot_version=?")
      .get(input.projectId, input.rejectedTakeId, input.shotId, input.shotVersion) as { asset_id: string; sha256: string } | undefined;
    if (!production || production.manager_agent_id !== "video_production-seed-5" || production.state !== "APPROVED" || production.approved_version !== production.plan_version || input.createdBy !== "ceo_session" && (input.createdBy !== production.manager_agent_id || coordinatorGrant?.grant_key !== "coordinator")) throw new VideoProductionPolicyError("production_job_actor_not_authorized", 403);
    const policy = VIDEO_STUDIO_STAGE_OWNERSHIP.find((item) => item.stageKey === "ai_footage_production");
    const regenerationStep = policy?.sequence.some((step) => step.kind === "agent" && step.roleKey === "production_manager" && step.action === "regeneration.request" && step.condition === "take_rejected");
    if (!role || role.role_key !== "production_manager" || !regenerationStep || coordinatorGrant?.grant_key !== "coordinator" || !stage || stage.status !== "BLOCKED" || !previous || previous.state !== "COMPLETED" || previous.execution_action !== "take.review" || previous.shot_id !== input.shotId || previous.shot_version !== input.shotVersion || !shot || shot.deleted_at !== null || shot.current_version !== input.shotVersion || rejected?.decision !== "rejected" || !rejectedTake || db.prepare("SELECT 1 FROM video_production_approved_takes WHERE project_id=? AND shot_id=?").get(input.projectId, input.shotId)) throw new VideoProductionPolicyError("rejected_take_regeneration_not_ready", 409);
    const now = Date.now(); const taskId = randomUUID();
    db.prepare("INSERT INTO tasks(id,title,description,department_id,assigned_agent_id,project_id,status,workflow_pack_key,created_at,updated_at) VALUES(?,?,?,?,?,?,'inbox','video_production',?,?)")
      .run(taskId, `Request regeneration for ${input.shotId}`, `Dami records a targeted regeneration request for rejected take ${input.rejectedTakeId}.`, role.department_id, "video_production-seed-5", input.projectId, now, now);
    db.prepare(`INSERT INTO video_production_stage_jobs(task_id,project_id,plan_version,stage_key,execution_action,assigned_agent_id,idempotency_key,shot_id,shot_version,target_take_id,target_asset_id,target_asset_sha256,state,created_by,created_at,updated_at)
      VALUES(?,?,?,'ai_footage_production','regeneration.request','video_production-seed-5',?,?,?,?,?,?,'READY',?,?,?)`).run(taskId, input.projectId, production.plan_version, input.idempotencyKey, input.shotId, input.shotVersion, input.rejectedTakeId, rejectedTake.asset_id, rejectedTake.sha256, input.createdBy, now, now);
    const pointer = db.prepare("UPDATE video_production_stages SET status='READY',task_id=? WHERE project_id=? AND stage_key='ai_footage_production' AND status='BLOCKED' AND task_id=?").run(taskId, input.projectId, stage.task_id);
    if (pointer.changes !== 1) throw new VideoProductionPolicyError("production_stage_pointer_conflict", 409);
    event(db, input.projectId, "production_stage_job_created", input.createdBy, { taskId, stageKey: "ai_footage_production", action: "regeneration.request", agentId: "video_production-seed-5", shotId: input.shotId, shotVersion: input.shotVersion, rejectedTakeId: input.rejectedTakeId });
    return { taskId, stageKey: "ai_footage_production", action: "regeneration.request", agentId: "video_production-seed-5", shotId: input.shotId, shotVersion: input.shotVersion, takeId: input.rejectedTakeId };
  });
}

/** First server-owned Haru job after the approved intake plan. */
export function createVideoProductionScreenplayJob(db: Db, input: {
  projectId: string;
  agentId: string;
  idempotencyKey: string;
  createdBy: string;
}): { taskId: string; stageKey: string; action: VideoStudioAction; agentId: string } {
  if ((db as DatabaseSync).isTransaction) throw new VideoProductionPolicyError("production_job_requires_top_level_commit", 503);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey)) throw new VideoProductionPolicyError("production_job_idempotency_key_invalid", 400);
  return transaction(db, () => {
    const prior = db.prepare("SELECT task_id,stage_key,execution_action,assigned_agent_id,target_artifact_id FROM video_production_stage_jobs WHERE project_id=? AND idempotency_key=?").get(input.projectId, input.idempotencyKey) as { task_id: string; stage_key: string; execution_action: string; assigned_agent_id: string; target_artifact_id: string | null } | undefined;
    if (prior) {
      if (prior.stage_key !== "story_development" || prior.execution_action !== "screenplay.write" || prior.assigned_agent_id !== input.agentId || prior.target_artifact_id !== null) throw new VideoProductionPolicyError("production_job_idempotency_conflict", 409);
      return { taskId: prior.task_id, stageKey: prior.stage_key, action: "screenplay.write", agentId: prior.assigned_agent_id };
    }
    const production = db.prepare("SELECT plan_version,approved_version,state,manager_agent_id FROM video_productions WHERE project_id=?").get(input.projectId) as { plan_version: number; approved_version: number | null; state: string; manager_agent_id: string } | undefined;
    if (!production || production.state !== "APPROVED" || production.approved_version !== production.plan_version) throw new VideoProductionPolicyError("production_approval_required");
    const stage = db.prepare("SELECT stage_order,status,implemented,task_id FROM video_production_stages WHERE project_id=? AND stage_key='story_development'").get(input.projectId) as { stage_order: number; status: string; implemented: number; task_id: string | null } | undefined;
    if (!stage) throw new VideoProductionPolicyError("video_production_stage_not_found", 404);
    if (db.prepare("SELECT 1 FROM video_production_stages WHERE project_id=? AND stage_order<? AND status!='COMPLETED' LIMIT 1").get(input.projectId, stage.stage_order)) throw new VideoProductionPolicyError("production_dependency_incomplete", 409);
    if (db.prepare("SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id IS NOT NULL").get()) throw new VideoProductionPolicyError("production_slot_busy", 409);
    if (stage.task_id) throw new VideoProductionPolicyError("production_stage_already_has_current_job", 409);
    if (input.createdBy !== "ceo_session") {
      const grant = db.prepare("SELECT grant_key FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").get(input.projectId, input.createdBy) as { grant_key: string } | undefined;
      if (production.manager_agent_id !== input.createdBy || grant?.grant_key !== "coordinator") throw new VideoProductionPolicyError("production_job_actor_not_authorized", 403);
    }
    const ownership = VIDEO_STUDIO_STAGE_OWNERSHIP.find((entry) => entry.stageKey === "story_development");
    if (ownership?.sequence[0]?.kind !== "agent" || ownership.sequence[0].action !== "screenplay.write" || ownership.sequence[0].roleKey !== "screenwriter") throw new VideoProductionPolicyError("production_stage_policy_invalid", 503);
    const target = db.prepare("SELECT a.department_id,r.role_key FROM agents a JOIN video_production_agent_roles r ON r.agent_id=a.id WHERE a.id=? AND a.workflow_pack_key='video_production'").get(input.agentId) as { department_id: string; role_key: VideoStudioRoleKey } | undefined;
    if (!target || target.role_key !== "screenwriter") throw new VideoProductionPolicyError("unsupported_stage_assignment", 409);
    if (!db.prepare("SELECT 1 FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").get(input.projectId, input.agentId)) throw new VideoProductionPolicyError("video_production_project_grant_required", 403);
    const now = Date.now();
    const taskId = randomUUID();
    db.prepare(`INSERT INTO tasks(id,title,description,department_id,assigned_agent_id,project_id,status,workflow_pack_key,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'inbox','video_production',?,?)`).run(taskId, "Develop screenplay", "Server-owned typed screenplay generation for the approved production brief.", target.department_id, input.agentId, input.projectId, now, now);
    db.prepare(`INSERT INTO video_production_stage_jobs(task_id,project_id,plan_version,stage_key,execution_action,assigned_agent_id,idempotency_key,shot_id,shot_version,state,created_by,created_at,updated_at)
      VALUES(?,?,?,'story_development','screenplay.write',?,?,NULL,NULL,'READY',?,?,?)`).run(taskId, input.projectId, production.plan_version, input.agentId, input.idempotencyKey, input.createdBy, now, now);
    const pointer = db.prepare("UPDATE video_production_stages SET implemented=1,status='READY',task_id=? WHERE project_id=? AND stage_key='story_development' AND task_id IS NULL AND status IN ('BLOCKED','NOT_IMPLEMENTED','READY')").run(taskId, input.projectId);
    if (pointer.changes !== 1) throw new VideoProductionPolicyError("production_stage_pointer_conflict", 409);
    event(db, input.projectId, "production_stage_job_created", input.createdBy, { taskId, stageKey: "story_development", action: "screenplay.write", agentId: input.agentId, planVersion: production.plan_version });
    return { taskId, stageKey: "story_development", action: "screenplay.write", agentId: input.agentId };
  });
}

/** Haru turns an approved screenplay into immutable, versioned shot specifications. */
export function createVideoProductionShotSpecJob(db: Db, input: { projectId: string; screenplayArtifactId: string; agentId: string; idempotencyKey: string; createdBy: string }): { taskId: string; stageKey: string; action: VideoStudioAction; agentId: string; artifactId: string } {
  if ((db as DatabaseSync).isTransaction) throw new VideoProductionPolicyError("production_job_requires_top_level_commit", 503);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey)) throw new VideoProductionPolicyError("production_job_idempotency_key_invalid", 400);
  return transaction(db, () => {
    const prior = db.prepare("SELECT task_id,stage_key,execution_action,assigned_agent_id,target_artifact_id FROM video_production_stage_jobs WHERE project_id=? AND idempotency_key=?").get(input.projectId, input.idempotencyKey) as { task_id: string; stage_key: string; execution_action: string; assigned_agent_id: string; target_artifact_id: string | null } | undefined;
    if (prior) {
      if (prior.stage_key !== "visual_preproduction" || prior.execution_action !== "shot_spec.write" || prior.assigned_agent_id !== input.agentId || prior.target_artifact_id !== input.screenplayArtifactId) throw new VideoProductionPolicyError("production_job_idempotency_conflict", 409);
      return { taskId: prior.task_id, stageKey: prior.stage_key, action: "shot_spec.write", agentId: prior.assigned_agent_id, artifactId: input.screenplayArtifactId };
    }
    const production = db.prepare("SELECT plan_version,approved_version,state,manager_agent_id FROM video_productions WHERE project_id=?").get(input.projectId) as { plan_version: number; approved_version: number | null; state: string; manager_agent_id: string } | undefined;
    if (!production || production.state !== "APPROVED" || production.approved_version !== production.plan_version) throw new VideoProductionPolicyError("production_approval_required");
    const script = db.prepare(`SELECT a.stage_key,a.artifact_type,a.attempt_plan_version,j.state AS job_state
      FROM video_production_stage_artifacts a JOIN video_production_stage_jobs j ON j.task_id=a.task_id
      WHERE a.project_id=? AND a.artifact_id=?`).get(input.projectId, input.screenplayArtifactId) as { stage_key: string; artifact_type: string; attempt_plan_version: number; job_state: string } | undefined;
    if (!script || script.stage_key !== "story_development" || script.artifact_type !== "screenplay" || script.attempt_plan_version !== production.plan_version || script.job_state !== "COMPLETED") throw new VideoProductionPolicyError("approved_screenplay_required", 409);
    if (input.createdBy !== "ceo_session") {
      const grant = db.prepare("SELECT grant_key FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").get(input.projectId, input.createdBy) as { grant_key: string } | undefined;
      if (input.createdBy !== production.manager_agent_id || grant?.grant_key !== "coordinator") throw new VideoProductionPolicyError("production_job_actor_not_authorized", 403);
    }
    const target = db.prepare("SELECT a.department_id,r.role_key FROM agents a JOIN video_production_agent_roles r ON r.agent_id=a.id WHERE a.id=? AND a.workflow_pack_key='video_production'").get(input.agentId) as { department_id: string; role_key: VideoStudioRoleKey } | undefined;
    if (!target || target.role_key !== "screenwriter" || !VIDEO_STUDIO_STAGE_OWNERSHIP.find((item) => item.stageKey === "visual_preproduction")?.sequence.some((step) => step.kind === "agent" && step.roleKey === target.role_key && step.action === "shot_spec.write")) throw new VideoProductionPolicyError("unsupported_stage_assignment", 409);
    if (!db.prepare("SELECT 1 FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").get(input.projectId, input.agentId)) throw new VideoProductionPolicyError("video_production_project_grant_required", 403);
    const stage = db.prepare("SELECT stage_order,status,task_id FROM video_production_stages WHERE project_id=? AND stage_key='visual_preproduction'").get(input.projectId) as { stage_order: number; status: string; task_id: string | null } | undefined;
    if (!stage || stage.task_id || !["NOT_IMPLEMENTED", "BLOCKED", "READY"].includes(stage.status) || db.prepare("SELECT 1 FROM video_production_stages WHERE project_id=? AND stage_order<? AND status!='COMPLETED' LIMIT 1").get(input.projectId, stage.stage_order)) throw new VideoProductionPolicyError("production_dependency_incomplete", 409);
    if (db.prepare("SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id IS NOT NULL").get()) throw new VideoProductionPolicyError("production_slot_busy", 409);
    const now = Date.now(); const taskId = randomUUID();
    db.prepare("INSERT INTO tasks(id,title,description,department_id,assigned_agent_id,project_id,status,workflow_pack_key,created_at,updated_at) VALUES(?,?,?,?,?,?,'inbox','video_production',?,?)")
      .run(taskId, "Create shot specifications", `Haru creates shot specifications from approved screenplay ${input.screenplayArtifactId}.`, target.department_id, input.agentId, input.projectId, now, now);
    db.prepare(`INSERT INTO video_production_stage_jobs(task_id,project_id,plan_version,stage_key,execution_action,assigned_agent_id,idempotency_key,state,created_by,created_at,updated_at,target_artifact_id)
      VALUES(?,?,?,'visual_preproduction','shot_spec.write',?,?,'READY',?,?,?,?)`).run(taskId, input.projectId, production.plan_version, input.agentId, input.idempotencyKey, input.createdBy, now, now, input.screenplayArtifactId);
    const pointer = db.prepare("UPDATE video_production_stages SET implemented=1,status='READY',task_id=? WHERE project_id=? AND stage_key='visual_preproduction' AND task_id IS NULL AND status IN ('NOT_IMPLEMENTED','BLOCKED','READY')").run(taskId, input.projectId);
    if (pointer.changes !== 1) throw new VideoProductionPolicyError("production_stage_pointer_conflict", 409);
    event(db, input.projectId, "production_stage_job_created", input.createdBy, { taskId, stageKey: "visual_preproduction", action: "shot_spec.write", agentId: input.agentId, artifactId: input.screenplayArtifactId });
    return { taskId, stageKey: "visual_preproduction", action: "shot_spec.write", agentId: input.agentId, artifactId: input.screenplayArtifactId };
  });
}

/** Yuna creates a text-only visual continuity/reference package from approved shot specs. */
export function createVideoProductionContinuityJob(db: Db, input: { projectId: string; shotSpecArtifactId: string; agentId: string; idempotencyKey: string; createdBy: string }): { taskId: string; stageKey: string; action: VideoStudioAction; agentId: string; artifactId: string } {
  if ((db as DatabaseSync).isTransaction) throw new VideoProductionPolicyError("production_job_requires_top_level_commit", 503);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey)) throw new VideoProductionPolicyError("production_job_idempotency_key_invalid", 400);
  return transaction(db, () => {
    const prior = db.prepare("SELECT task_id,stage_key,execution_action,assigned_agent_id,target_artifact_id FROM video_production_stage_jobs WHERE project_id=? AND idempotency_key=?").get(input.projectId, input.idempotencyKey) as { task_id: string; stage_key: string; execution_action: string; assigned_agent_id: string; target_artifact_id: string | null } | undefined;
    if (prior) {
      if (prior.stage_key !== "visual_preproduction" || prior.execution_action !== "visual.manage" || prior.assigned_agent_id !== input.agentId || prior.target_artifact_id !== input.shotSpecArtifactId) throw new VideoProductionPolicyError("production_job_idempotency_conflict", 409);
      return { taskId: prior.task_id, stageKey: prior.stage_key, action: "visual.manage", agentId: prior.assigned_agent_id, artifactId: input.shotSpecArtifactId };
    }
    const production = db.prepare("SELECT plan_version,approved_version,state,manager_agent_id FROM video_productions WHERE project_id=?").get(input.projectId) as { plan_version: number; approved_version: number | null; state: string; manager_agent_id: string } | undefined;
    const source = db.prepare(`SELECT a.stage_key,a.artifact_type,a.attempt_plan_version,j.state AS job_state,t.status AS task_status
      FROM video_production_stage_artifacts a JOIN video_production_stage_jobs j ON j.task_id=a.task_id JOIN tasks t ON t.id=a.task_id
      WHERE a.project_id=? AND a.artifact_id=?`).get(input.projectId, input.shotSpecArtifactId) as { stage_key: string; artifact_type: string; attempt_plan_version: number; job_state: string; task_status: string } | undefined;
    if (!production || production.state !== "APPROVED" || production.approved_version !== production.plan_version || !source || source.stage_key !== "visual_preproduction" || source.artifact_type !== "shot_spec" || source.attempt_plan_version !== production.plan_version || source.job_state !== "WAITING_APPROVAL" || source.task_status !== "review") throw new VideoProductionPolicyError("approved_shot_spec_required", 409);
    if (input.createdBy !== "ceo_session") {
      const grant = db.prepare("SELECT grant_key FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").get(input.projectId, input.createdBy) as { grant_key: string } | undefined;
      if (input.createdBy !== production.manager_agent_id || grant?.grant_key !== "coordinator") throw new VideoProductionPolicyError("production_job_actor_not_authorized", 403);
    }
    const target = db.prepare("SELECT a.department_id,r.role_key FROM agents a JOIN video_production_agent_roles r ON r.agent_id=a.id WHERE a.id=? AND a.workflow_pack_key='video_production'").get(input.agentId) as { department_id: string; role_key: VideoStudioRoleKey } | undefined;
    if (!target || target.role_key !== "art_director") throw new VideoProductionPolicyError("unsupported_stage_assignment", 409);
    if (!db.prepare("SELECT 1 FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").get(input.projectId, input.agentId)) throw new VideoProductionPolicyError("video_production_project_grant_required", 403);
    const stage = db.prepare("SELECT task_id,status FROM video_production_stages WHERE project_id=? AND stage_key='visual_preproduction'").get(input.projectId) as { task_id: string | null; status: string } | undefined;
    if (!stage?.task_id || stage.status !== "BLOCKED" || db.prepare("SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id IS NOT NULL").get()) throw new VideoProductionPolicyError("production_stage_not_ready", 409);
    const now = Date.now(); const taskId = randomUUID();
    db.prepare("INSERT INTO tasks(id,title,description,department_id,assigned_agent_id,project_id,status,workflow_pack_key,created_at,updated_at) VALUES(?,?,?,?,?,?,'inbox','video_production',?,?)")
      .run(taskId, "Build visual continuity package", `Yuna reviews shot specifications ${input.shotSpecArtifactId} and records continuity/reference requests.`, target.department_id, input.agentId, input.projectId, now, now);
    db.prepare(`INSERT INTO video_production_stage_jobs(task_id,project_id,plan_version,stage_key,execution_action,assigned_agent_id,idempotency_key,state,created_by,created_at,updated_at,target_artifact_id)
      VALUES(?,?,?,'visual_preproduction','visual.manage',?,?,'READY',?,?,?,?)`).run(taskId, input.projectId, production.plan_version, input.agentId, input.idempotencyKey, input.createdBy, now, now, input.shotSpecArtifactId);
    const pointer = db.prepare("UPDATE video_production_stages SET status='READY',task_id=? WHERE project_id=? AND stage_key='visual_preproduction' AND status='BLOCKED' AND task_id=?").run(taskId, input.projectId, stage.task_id);
    if (pointer.changes !== 1) throw new VideoProductionPolicyError("production_stage_pointer_conflict", 409);
    event(db, input.projectId, "production_stage_job_created", input.createdBy, { taskId, stageKey: "visual_preproduction", action: "visual.manage", agentId: input.agentId, artifactId: input.shotSpecArtifactId });
    return { taskId, stageKey: "visual_preproduction", action: "visual.manage", agentId: input.agentId, artifactId: input.shotSpecArtifactId };
  });
}

/** Liam creates an ordered edit plan from current shot specs and Yuna's continuity package. */
export function createVideoProductionTimelinePlanJob(db: Db, input: { projectId: string; continuityArtifactId: string; agentId: string; idempotencyKey: string; createdBy: string }): { taskId: string; stageKey: string; action: VideoStudioAction; agentId: string; artifactId: string } {
  if ((db as DatabaseSync).isTransaction) throw new VideoProductionPolicyError("production_job_requires_top_level_commit", 503);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey)) throw new VideoProductionPolicyError("production_job_idempotency_key_invalid", 400);
  return transaction(db, () => {
    const prior = db.prepare("SELECT task_id,stage_key,execution_action,assigned_agent_id,target_artifact_id FROM video_production_stage_jobs WHERE project_id=? AND idempotency_key=?").get(input.projectId, input.idempotencyKey) as { task_id: string; stage_key: string; execution_action: string; assigned_agent_id: string; target_artifact_id: string | null } | undefined;
    if (prior) {
      if (prior.stage_key !== "visual_preproduction" || prior.execution_action !== "edit.manage" || prior.assigned_agent_id !== input.agentId || prior.target_artifact_id !== input.continuityArtifactId) throw new VideoProductionPolicyError("production_job_idempotency_conflict", 409);
      return { taskId: prior.task_id, stageKey: prior.stage_key, action: "edit.manage", agentId: prior.assigned_agent_id, artifactId: input.continuityArtifactId };
    }
    const production = db.prepare("SELECT plan_version,approved_version,state,manager_agent_id FROM video_productions WHERE project_id=?").get(input.projectId) as { plan_version: number; approved_version: number | null; state: string; manager_agent_id: string } | undefined;
    const source = db.prepare(`SELECT a.stage_key,a.artifact_type,a.attempt_plan_version,j.state AS job_state,t.status AS task_status
      FROM video_production_stage_artifacts a JOIN video_production_stage_jobs j ON j.task_id=a.task_id JOIN tasks t ON t.id=a.task_id
      WHERE a.project_id=? AND a.artifact_id=?`).get(input.projectId, input.continuityArtifactId) as { stage_key: string; artifact_type: string; attempt_plan_version: number; job_state: string; task_status: string } | undefined;
    if (!production || production.state !== "APPROVED" || production.approved_version !== production.plan_version || !source || source.stage_key !== "visual_preproduction" || source.artifact_type !== "continuity_package" || source.attempt_plan_version !== production.plan_version || source.job_state !== "WAITING_APPROVAL" || source.task_status !== "review") throw new VideoProductionPolicyError("visual_continuity_package_required", 409);
    if (input.createdBy !== "ceo_session") {
      const grant = db.prepare("SELECT grant_key FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").get(input.projectId, input.createdBy) as { grant_key: string } | undefined;
      if (input.createdBy !== production.manager_agent_id || grant?.grant_key !== "coordinator") throw new VideoProductionPolicyError("production_job_actor_not_authorized", 403);
    }
    const target = db.prepare("SELECT a.department_id,r.role_key FROM agents a JOIN video_production_agent_roles r ON r.agent_id=a.id WHERE a.id=? AND a.workflow_pack_key='video_production'").get(input.agentId) as { department_id: string; role_key: VideoStudioRoleKey } | undefined;
    if (!target || target.role_key !== "editor") throw new VideoProductionPolicyError("unsupported_stage_assignment", 409);
    if (!db.prepare("SELECT 1 FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").get(input.projectId, input.agentId)) throw new VideoProductionPolicyError("video_production_project_grant_required", 403);
    const stage = db.prepare("SELECT task_id,status FROM video_production_stages WHERE project_id=? AND stage_key='visual_preproduction'").get(input.projectId) as { task_id: string | null; status: string } | undefined;
    if (!stage?.task_id || stage.status !== "BLOCKED" || db.prepare("SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id IS NOT NULL").get()) throw new VideoProductionPolicyError("production_stage_not_ready", 409);
    const now = Date.now(); const taskId = randomUUID();
    db.prepare("INSERT INTO tasks(id,title,description,department_id,assigned_agent_id,project_id,status,workflow_pack_key,created_at,updated_at) VALUES(?,?,?,?,?,?,'inbox','video_production',?,?)")
      .run(taskId, "Plan visual edit", `Liam orders the approved shot specifications using Yuna's continuity package ${input.continuityArtifactId}.`, target.department_id, input.agentId, input.projectId, now, now);
    db.prepare(`INSERT INTO video_production_stage_jobs(task_id,project_id,plan_version,stage_key,execution_action,assigned_agent_id,idempotency_key,state,created_by,created_at,updated_at,target_artifact_id)
      VALUES(?,?,?,'visual_preproduction','edit.manage',?,?,'READY',?,?,?,?)`).run(taskId, input.projectId, production.plan_version, input.agentId, input.idempotencyKey, input.createdBy, now, now, input.continuityArtifactId);
    const pointer = db.prepare("UPDATE video_production_stages SET status='READY',task_id=? WHERE project_id=? AND stage_key='visual_preproduction' AND status='BLOCKED' AND task_id=?").run(taskId, input.projectId, stage.task_id);
    if (pointer.changes !== 1) throw new VideoProductionPolicyError("production_stage_pointer_conflict", 409);
    event(db, input.projectId, "production_stage_job_created", input.createdBy, { taskId, stageKey: "visual_preproduction", action: "edit.manage", agentId: input.agentId, artifactId: input.continuityArtifactId });
    return { taskId, stageKey: "visual_preproduction", action: "edit.manage", agentId: input.agentId, artifactId: input.continuityArtifactId };
  });
}

/** Audio Producer creates narration text that is synthesized only by the configured offline VieNeu runtime. */
export function createVideoProductionAudioCueJob(db: Db, input: { projectId: string; screenplayArtifactId: string; agentId: string; idempotencyKey: string; createdBy: string }): { taskId: string; stageKey: string; action: VideoStudioAction; agentId: string; artifactId: string } {
  if ((db as DatabaseSync).isTransaction) throw new VideoProductionPolicyError("production_job_requires_top_level_commit", 503);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey)) throw new VideoProductionPolicyError("production_job_idempotency_key_invalid", 400);
  return transaction(db, () => {
    const prior = db.prepare("SELECT task_id,stage_key,execution_action,assigned_agent_id,target_artifact_id FROM video_production_stage_jobs WHERE project_id=? AND idempotency_key=?").get(input.projectId, input.idempotencyKey) as { task_id: string; stage_key: string; execution_action: string; assigned_agent_id: string; target_artifact_id: string | null } | undefined;
    if (prior) {
      if (prior.stage_key !== "audio_preproduction" || prior.execution_action !== "audio.manage" || prior.assigned_agent_id !== input.agentId || prior.target_artifact_id !== input.screenplayArtifactId) throw new VideoProductionPolicyError("production_job_idempotency_conflict", 409);
      return { taskId: prior.task_id, stageKey: prior.stage_key, action: "audio.manage", agentId: prior.assigned_agent_id, artifactId: input.screenplayArtifactId };
    }
    const production = db.prepare("SELECT plan_version,approved_version,state,manager_agent_id FROM video_productions WHERE project_id=?").get(input.projectId) as { plan_version: number; approved_version: number | null; state: string; manager_agent_id: string } | undefined;
    const source = db.prepare(`SELECT a.stage_key,a.artifact_type,a.attempt_plan_version,j.state AS job_state
      FROM video_production_stage_artifacts a JOIN video_production_stage_jobs j ON j.task_id=a.task_id
      WHERE a.project_id=? AND a.artifact_id=?`).get(input.projectId, input.screenplayArtifactId) as { stage_key: string; artifact_type: string; attempt_plan_version: number; job_state: string } | undefined;
    if (!production || production.state !== "APPROVED" || production.approved_version !== production.plan_version || !source || source.stage_key !== "story_development" || source.artifact_type !== "screenplay" || source.attempt_plan_version !== production.plan_version || source.job_state !== "COMPLETED") throw new VideoProductionPolicyError("approved_screenplay_required", 409);
    if (input.createdBy !== "ceo_session") {
      const grant = db.prepare("SELECT grant_key FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").get(input.projectId, input.createdBy) as { grant_key: string } | undefined;
      if (input.createdBy !== production.manager_agent_id || grant?.grant_key !== "coordinator") throw new VideoProductionPolicyError("production_job_actor_not_authorized", 403);
    }
    const target = db.prepare("SELECT a.department_id,r.role_key FROM agents a JOIN video_production_agent_roles r ON r.agent_id=a.id WHERE a.id=? AND a.workflow_pack_key='video_production'").get(input.agentId) as { department_id: string; role_key: VideoStudioRoleKey } | undefined;
    if (!target || target.role_key !== "sound_producer") throw new VideoProductionPolicyError("unsupported_stage_assignment", 409);
    if (!db.prepare("SELECT 1 FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").get(input.projectId, input.agentId)) throw new VideoProductionPolicyError("video_production_project_grant_required", 403);
    const stage = db.prepare("SELECT stage_order,status,task_id FROM video_production_stages WHERE project_id=? AND stage_key='audio_preproduction'").get(input.projectId) as { stage_order: number; status: string; task_id: string | null } | undefined;
    if (!stage || stage.task_id || !["NOT_IMPLEMENTED", "BLOCKED", "READY"].includes(stage.status) || db.prepare("SELECT 1 FROM video_production_stages WHERE project_id=? AND stage_order<? AND status!='COMPLETED' LIMIT 1").get(input.projectId, stage.stage_order)) throw new VideoProductionPolicyError("production_dependency_incomplete", 409);
    if (db.prepare("SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id IS NOT NULL").get()) throw new VideoProductionPolicyError("production_slot_busy", 409);
    const now = Date.now(); const taskId = randomUUID();
    db.prepare("INSERT INTO tasks(id,title,description,department_id,assigned_agent_id,project_id,status,workflow_pack_key,created_at,updated_at) VALUES(?,?,?,?,?,?,'inbox','video_production',?,?)")
      .run(taskId, "Prepare narration and audio cues", `Audio Producer prepares narration from approved screenplay ${input.screenplayArtifactId}; local VieNeu runtime is required.`, target.department_id, input.agentId, input.projectId, now, now);
    db.prepare(`INSERT INTO video_production_stage_jobs(task_id,project_id,plan_version,stage_key,execution_action,assigned_agent_id,idempotency_key,state,created_by,created_at,updated_at,target_artifact_id)
      VALUES(?,?,?,'audio_preproduction','audio.manage',?,?,'READY',?,?,?,?)`).run(taskId, input.projectId, production.plan_version, input.agentId, input.idempotencyKey, input.createdBy, now, now, input.screenplayArtifactId);
    const pointer = db.prepare("UPDATE video_production_stages SET implemented=1,status='READY',task_id=? WHERE project_id=? AND stage_key='audio_preproduction' AND task_id IS NULL AND status IN ('NOT_IMPLEMENTED','BLOCKED','READY')").run(taskId, input.projectId);
    if (pointer.changes !== 1) throw new VideoProductionPolicyError("production_stage_pointer_conflict", 409);
    event(db, input.projectId, "production_stage_job_created", input.createdBy, { taskId, stageKey: "audio_preproduction", action: "audio.manage", agentId: input.agentId, screenplayArtifactId: input.screenplayArtifactId });
    return { taskId, stageKey: "audio_preproduction", action: "audio.manage", agentId: input.agentId, artifactId: input.screenplayArtifactId };
  });
}

/** Liam's single rough-cut job, pinned to the approved timeline plan after every required take is approved. */
export function createVideoProductionFinalRenderJob(db: Db, input: { projectId: string; timelineArtifactId: string; agentId: string; idempotencyKey: string; createdBy: string }): { taskId: string; stageKey: string; action: VideoStudioAction; agentId: string; artifactId: string } {
  if ((db as DatabaseSync).isTransaction) throw new VideoProductionPolicyError("production_job_requires_top_level_commit", 503);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey)) throw new VideoProductionPolicyError("production_job_idempotency_key_invalid", 400);
  return transaction(db, () => {
    const prior = db.prepare("SELECT task_id,stage_key,execution_action,assigned_agent_id,target_artifact_id FROM video_production_stage_jobs WHERE project_id=? AND idempotency_key=?").get(input.projectId, input.idempotencyKey) as { task_id: string; stage_key: string; execution_action: string; assigned_agent_id: string; target_artifact_id: string | null } | undefined;
    if (prior) {
      if (prior.stage_key !== "asset_handoff_rough_cut" || prior.execution_action !== "edit.manage" || prior.assigned_agent_id !== input.agentId || prior.target_artifact_id !== input.timelineArtifactId) throw new VideoProductionPolicyError("production_job_idempotency_conflict", 409);
      return { taskId: prior.task_id, stageKey: prior.stage_key, action: "edit.manage", agentId: prior.assigned_agent_id, artifactId: input.timelineArtifactId };
    }
    const production = db.prepare("SELECT plan_version,approved_version,state,manager_agent_id FROM video_productions WHERE project_id=?").get(input.projectId) as { plan_version: number; approved_version: number | null; state: string; manager_agent_id: string } | undefined;
    const timeline = db.prepare(`SELECT a.attempt_plan_version,j.state,a.content_text FROM video_production_stage_artifacts a
      JOIN video_production_stage_jobs j ON j.task_id=a.task_id WHERE a.project_id=? AND a.artifact_id=? AND a.artifact_type='timeline_plan'`).get(input.projectId, input.timelineArtifactId) as { attempt_plan_version: number; state: string; content_text: string } | undefined;
    const timelineDecision = db.prepare("SELECT decision FROM video_production_stage_decisions WHERE project_id=? AND target_artifact_id=? ORDER BY created_at DESC,decision_id DESC LIMIT 1").get(input.projectId, input.timelineArtifactId) as { decision: string } | undefined;
    if (!production || production.state !== "APPROVED" || production.approved_version !== production.plan_version || !timeline || timeline.attempt_plan_version !== production.plan_version || timeline.state !== "COMPLETED" || timelineDecision?.decision !== "approved") throw new VideoProductionPolicyError("approved_timeline_plan_required", 409);
    if (!db.prepare("SELECT 1 FROM video_production_stage_artifacts WHERE project_id=? AND artifact_type='audio_cues' AND attempt_plan_version=?").get(input.projectId, production.plan_version) ||
        !db.prepare("SELECT 1 FROM video_production_assets WHERE project_id=? AND asset_type='audio' AND attempt_plan_version=?").get(input.projectId, production.plan_version)) throw new VideoProductionPolicyError("approved_audio_cues_required", 409);
    const shots = db.prepare(`SELECT sh.shot_id,sh.current_version FROM video_production_scenes sc JOIN video_production_shots sh ON sh.project_id=sc.project_id AND sh.scene_id=sc.scene_id
      JOIN video_production_shot_versions sv ON sv.project_id=sh.project_id AND sv.shot_id=sh.shot_id AND sv.version=sh.current_version AND sv.scene_version=sc.current_version
      WHERE sh.project_id=? AND sc.deleted_at IS NULL AND sh.deleted_at IS NULL AND sh.is_required=1 ORDER BY sc.sort_order,sh.sort_order`).all(input.projectId) as Array<{ shot_id: string; current_version: number }>;
    const timelineShots = (JSON.parse(timeline.content_text) as { shots?: Array<{ shotId: string; shotVersion: number }> }).shots ?? [];
    const expected = shots.map((shot) => `${shot.shot_id}@${shot.current_version}`).sort();
    if (!shots.length || JSON.stringify([...timelineShots.map((shot) => `${shot.shotId}@${shot.shotVersion}`)].sort()) !== JSON.stringify(expected) || shots.some((shot) => !db.prepare("SELECT 1 FROM video_production_approved_takes WHERE project_id=? AND shot_id=? AND shot_version=?").get(input.projectId, shot.shot_id, shot.current_version))) throw new VideoProductionPolicyError("video_production_manifest_incomplete", 409);
    const emptyRequiredScene = db.prepare(`SELECT 1 FROM video_production_scenes sc WHERE sc.project_id=? AND sc.deleted_at IS NULL AND sc.is_required=1
      AND NOT EXISTS (SELECT 1 FROM video_production_shots sh WHERE sh.project_id=sc.project_id AND sh.scene_id=sc.scene_id AND sh.deleted_at IS NULL AND sh.is_required=1) LIMIT 1`).get(input.projectId);
    if (emptyRequiredScene) throw new VideoProductionPolicyError("video_production_manifest_incomplete", 409);
    if (input.createdBy !== "ceo_session" && (input.createdBy !== production.manager_agent_id || !db.prepare("SELECT 1 FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND grant_key='coordinator' AND revoked_at IS NULL").get(input.projectId, input.createdBy))) throw new VideoProductionPolicyError("production_job_actor_not_authorized", 403);
    const owner = db.prepare("SELECT a.department_id,r.role_key FROM agents a JOIN video_production_agent_roles r ON r.agent_id=a.id WHERE a.id=? AND a.workflow_pack_key='video_production'").get(input.agentId) as { department_id: string; role_key: VideoStudioRoleKey } | undefined;
    if (!owner || owner.role_key !== "editor" || !db.prepare("SELECT 1 FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").get(input.projectId, input.agentId)) throw new VideoProductionPolicyError("unsupported_stage_assignment", 409);
    const stage = db.prepare("SELECT status,task_id FROM video_production_stages WHERE project_id=? AND stage_key='asset_handoff_rough_cut'").get(input.projectId) as { status: string; task_id: string | null } | undefined;
    if (!stage || stage.task_id || !["NOT_IMPLEMENTED", "BLOCKED"].includes(stage.status) || db.prepare("SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id IS NOT NULL").get()) throw new VideoProductionPolicyError("production_stage_not_ready", 409);
    const now = Date.now(); const taskId = randomUUID();
    db.prepare("INSERT INTO tasks(id,title,description,department_id,assigned_agent_id,project_id,status,workflow_pack_key,created_at,updated_at) VALUES(?,?,?,?,?,?,'inbox','video_production',?,?)")
      .run(taskId, "Render approved rough cut", "Liam assembles the approved shot manifest and timed narration into one validated MP4.", owner.department_id, input.agentId, input.projectId, now, now);
    db.prepare(`INSERT INTO video_production_stage_jobs(task_id,project_id,plan_version,stage_key,execution_action,assigned_agent_id,idempotency_key,state,created_by,created_at,updated_at,target_artifact_id)
      VALUES(?,?,?,'asset_handoff_rough_cut','edit.manage',?,?,'READY',?,?,?,?)`).run(taskId, input.projectId, production.plan_version, input.agentId, input.idempotencyKey, input.createdBy, now, now, input.timelineArtifactId);
    const pointer = db.prepare("UPDATE video_production_stages SET implemented=1,status='READY',task_id=? WHERE project_id=? AND stage_key='asset_handoff_rough_cut' AND task_id IS NULL AND status IN ('NOT_IMPLEMENTED','BLOCKED')").run(taskId, input.projectId);
    if (pointer.changes !== 1) throw new VideoProductionPolicyError("production_stage_pointer_conflict", 409);
    event(db, input.projectId, "production_stage_job_created", input.createdBy, { taskId, stageKey: "asset_handoff_rough_cut", action: "edit.manage", agentId: input.agentId, timelineArtifactId: input.timelineArtifactId, planVersion: production.plan_version });
    return { taskId, stageKey: "asset_handoff_rough_cut", action: "edit.manage", agentId: input.agentId, artifactId: input.timelineArtifactId };
  });
}

/** Quinn's independent, exact-final-asset QA task, enabled only after Rian approves that cut. */
export function createVideoProductionFinalQaJob(db: Db, input: { projectId: string; finalCutArtifactId: string; agentId: string; idempotencyKey: string; createdBy: string }): { taskId: string; stageKey: string; action: VideoStudioAction; agentId: string; artifactId: string } {
  if ((db as DatabaseSync).isTransaction) throw new VideoProductionPolicyError("production_job_requires_top_level_commit", 503);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey)) throw new VideoProductionPolicyError("production_job_idempotency_key_invalid", 400);
  return transaction(db, () => {
    const prior = db.prepare("SELECT task_id,stage_key,execution_action,assigned_agent_id,target_artifact_id FROM video_production_stage_jobs WHERE project_id=? AND idempotency_key=?").get(input.projectId, input.idempotencyKey) as { task_id: string; stage_key: string; execution_action: string; assigned_agent_id: string; target_artifact_id: string | null } | undefined;
    if (prior) {
      if (prior.stage_key !== "finishing_qa" || prior.execution_action !== "qa.final" || prior.assigned_agent_id !== input.agentId || prior.target_artifact_id !== input.finalCutArtifactId) throw new VideoProductionPolicyError("production_job_idempotency_conflict", 409);
      return { taskId: prior.task_id, stageKey: prior.stage_key, action: "qa.final", agentId: prior.assigned_agent_id, artifactId: input.finalCutArtifactId };
    }
    const production = db.prepare("SELECT plan_version,approved_version,state,manager_agent_id FROM video_productions WHERE project_id=?").get(input.projectId) as { plan_version: number; approved_version: number | null; state: string; manager_agent_id: string } | undefined;
    const finalCut = db.prepare(`SELECT a.attempt_plan_version,a.artifact_type,a.stage_key,j.stage_key AS source_stage,j.state AS source_state,t.status AS source_task_status
      FROM video_production_stage_artifacts a JOIN video_production_stage_jobs j ON j.task_id=a.task_id JOIN tasks t ON t.id=a.task_id
      WHERE a.project_id=? AND a.artifact_id=?`).get(input.projectId, input.finalCutArtifactId) as { attempt_plan_version: number; artifact_type: string; stage_key: string; source_stage: string; source_state: string; source_task_status: string } | undefined;
    const directorDecision = db.prepare("SELECT decision FROM video_production_stage_decisions WHERE project_id=? AND target_artifact_id=? AND stage_key='director_review' ORDER BY created_at DESC,decision_id DESC LIMIT 1").get(input.projectId, input.finalCutArtifactId) as { decision: string } | undefined;
    if (!production || production.state !== "APPROVED" || production.approved_version !== production.plan_version || !finalCut || finalCut.artifact_type !== "final_cut" || finalCut.stage_key !== "asset_handoff_rough_cut" || finalCut.source_stage !== "asset_handoff_rough_cut" || finalCut.source_state !== "COMPLETED" || finalCut.source_task_status !== "done" || finalCut.attempt_plan_version !== production.plan_version || directorDecision?.decision !== "approved") throw new VideoProductionPolicyError("director_approved_final_cut_required", 409);
    if (input.createdBy !== "ceo_session") {
      const grant = db.prepare("SELECT grant_key FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").get(input.projectId, input.createdBy) as { grant_key: string } | undefined;
      if (input.createdBy !== production.manager_agent_id || grant?.grant_key !== "coordinator") throw new VideoProductionPolicyError("production_job_actor_not_authorized", 403);
    }
    const target = db.prepare("SELECT a.department_id,r.role_key FROM agents a JOIN video_production_agent_roles r ON r.agent_id=a.id WHERE a.id=? AND a.workflow_pack_key='video_production'").get(input.agentId) as { department_id: string; role_key: VideoStudioRoleKey } | undefined;
    if (!target || target.role_key !== "qa_supervisor" || !db.prepare("SELECT 1 FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").get(input.projectId, input.agentId)) throw new VideoProductionPolicyError("unsupported_stage_assignment", 409);
    const stage = db.prepare("SELECT status,task_id FROM video_production_stages WHERE project_id=? AND stage_key='finishing_qa'").get(input.projectId) as { status: string; task_id: string | null } | undefined;
    if (!stage || stage.task_id || !["NOT_IMPLEMENTED", "BLOCKED"].includes(stage.status) || db.prepare("SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id IS NOT NULL").get()) throw new VideoProductionPolicyError("production_stage_not_ready", 409);
    const now = Date.now(); const taskId = randomUUID();
    db.prepare("INSERT INTO tasks(id,title,description,department_id,assigned_agent_id,project_id,status,workflow_pack_key,created_at,updated_at) VALUES(?,?,?,?,?,?,'inbox','video_production',?,?)")
      .run(taskId, "Independent final cut QA", "Quinn validates the exact Rian-approved final MP4 and its pinned manifest/audio/timeline evidence.", target.department_id, input.agentId, input.projectId, now, now);
    db.prepare(`INSERT INTO video_production_stage_jobs(task_id,project_id,plan_version,stage_key,execution_action,assigned_agent_id,idempotency_key,state,created_by,created_at,updated_at,target_artifact_id)
      VALUES(?,?,?,'finishing_qa','qa.final',?,?,'READY',?,?,?,?)`).run(taskId, input.projectId, production.plan_version, input.agentId, input.idempotencyKey, input.createdBy, now, now, input.finalCutArtifactId);
    const pointer = db.prepare("UPDATE video_production_stages SET implemented=1,status='READY',task_id=? WHERE project_id=? AND stage_key='finishing_qa' AND task_id IS NULL AND status IN ('NOT_IMPLEMENTED','BLOCKED')").run(taskId, input.projectId);
    if (pointer.changes !== 1) throw new VideoProductionPolicyError("production_stage_pointer_conflict", 409);
    event(db, input.projectId, "production_stage_job_created", input.createdBy, { taskId, stageKey: "finishing_qa", action: "qa.final", agentId: input.agentId, finalCutArtifactId: input.finalCutArtifactId, planVersion: production.plan_version });
    return { taskId, stageKey: "finishing_qa", action: "qa.final", agentId: input.agentId, artifactId: input.finalCutArtifactId };
  });
}

/** Rian's model-assisted decision is pinned to the exact immutable stage artifact. */
export function createVideoProductionCreativeReviewJob(db: Db, input: {
  projectId: string;
  artifactId: string;
  agentId: string;
  idempotencyKey: string;
  createdBy: string;
}): { taskId: string; stageKey: string; action: VideoStudioAction; agentId: string; artifactId: string } {
  if ((db as DatabaseSync).isTransaction) throw new VideoProductionPolicyError("production_job_requires_top_level_commit", 503);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey)) throw new VideoProductionPolicyError("production_job_idempotency_key_invalid", 400);
  return transaction(db, () => {
    const prior = db.prepare("SELECT task_id,stage_key,execution_action,assigned_agent_id,target_artifact_id FROM video_production_stage_jobs WHERE project_id=? AND idempotency_key=?").get(input.projectId, input.idempotencyKey) as { task_id: string; stage_key: string; execution_action: string; assigned_agent_id: string; target_artifact_id: string | null } | undefined;
    if (prior) {
      if (prior.execution_action !== "creative.approve" || prior.assigned_agent_id !== input.agentId || prior.target_artifact_id !== input.artifactId) throw new VideoProductionPolicyError("production_job_idempotency_conflict", 409);
      return { taskId: prior.task_id, stageKey: prior.stage_key, action: "creative.approve", agentId: prior.assigned_agent_id, artifactId: input.artifactId };
    }
    const production = db.prepare("SELECT plan_version,approved_version,state,manager_agent_id FROM video_productions WHERE project_id=?").get(input.projectId) as { plan_version: number; approved_version: number | null; state: string; manager_agent_id: string } | undefined;
    if (!production || production.state !== "APPROVED" || production.approved_version !== production.plan_version) throw new VideoProductionPolicyError("production_approval_required");
    const artifact = db.prepare(`SELECT a.stage_key,a.artifact_type,a.attempt_plan_version,a.attempt_id,a.task_id,j.execution_action,j.state,t.status AS task_status,j.stage_key AS source_job_stage
      FROM video_production_stage_artifacts a JOIN video_production_stage_jobs j ON j.task_id=a.task_id
      JOIN tasks t ON t.id=a.task_id WHERE a.project_id=? AND a.artifact_id=?`).get(input.projectId, input.artifactId) as
        | { stage_key: string; artifact_type: string; attempt_plan_version: number; attempt_id: string; task_id: string; execution_action: string; state: string; task_status: string; source_job_stage: string }
        | undefined;
    const artifactActionByType: Record<string, string> = { screenplay: "screenplay.write", shot_spec: "shot_spec.write", continuity_package: "visual.manage", timeline_plan: "edit.manage", audio_cues: "audio.manage", timeline_source: "edit.manage", final_cut: "edit.manage", qa_evidence: "qa.final" };
    const finalCutReady = artifact?.artifact_type === "final_cut" && artifact.stage_key === "asset_handoff_rough_cut" && artifact.execution_action === "edit.manage" &&
      artifact.source_job_stage === "asset_handoff_rough_cut" && artifact.state === "COMPLETED" && artifact.task_status === "done";
    const reviewStageKey = finalCutReady ? "director_review" : artifact?.stage_key;
    const ownership = reviewStageKey ? VIDEO_STUDIO_STAGE_OWNERSHIP.find((entry) => entry.stageKey === reviewStageKey) : undefined;
    const previousAgentStep = ownership?.sequence.slice(0, -1).filter((step) => step.kind === "agent").at(-1);
    if (!artifact || !ownership?.sequence.some((step) => step.kind === "agent" && step.roleKey === "director" && step.action === "creative.approve") ||
        artifact.execution_action !== artifactActionByType[artifact.artifact_type] || artifact.attempt_plan_version !== production.plan_version ||
        (!finalCutReady && (artifact.state !== "WAITING_APPROVAL" || artifact.task_status !== "review" || previousAgentStep?.kind !== "agent" || previousAgentStep.action !== artifact.execution_action))) {
      throw new VideoProductionPolicyError("creative_review_target_not_ready", 409);
    }
    if (input.createdBy !== "ceo_session") {
      const managerGrant = db.prepare("SELECT grant_key FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").get(input.projectId, input.createdBy) as { grant_key: string } | undefined;
      if (input.createdBy !== production.manager_agent_id || managerGrant?.grant_key !== "coordinator") throw new VideoProductionPolicyError("production_job_actor_not_authorized", 403);
    }
    const target = db.prepare("SELECT a.department_id,r.role_key FROM agents a JOIN video_production_agent_roles r ON r.agent_id=a.id WHERE a.id=? AND a.workflow_pack_key='video_production'").get(input.agentId) as { department_id: string; role_key: VideoStudioRoleKey } | undefined;
    if (!target || target.role_key !== "director") throw new VideoProductionPolicyError("unsupported_stage_assignment", 409);
    if (!db.prepare("SELECT 1 FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").get(input.projectId, input.agentId)) throw new VideoProductionPolicyError("video_production_project_grant_required", 403);
    const stage = reviewStageKey ? db.prepare("SELECT task_id,status FROM video_production_stages WHERE project_id=? AND stage_key=?").get(input.projectId, reviewStageKey) as { task_id: string | null; status: string } | undefined : undefined;
    const stageKey = reviewStageKey;
    if (!stageKey) throw new VideoProductionPolicyError("production_review_stage_not_found", 409);
    const stageReady = finalCutReady
      ? Boolean(stage && !stage.task_id && ["NOT_IMPLEMENTED", "BLOCKED"].includes(stage.status))
      : Boolean(stage?.task_id && stage.status === "BLOCKED" && stage.task_id === artifact.task_id);
    if (!stageReady) throw new VideoProductionPolicyError("production_stage_not_ready", 409);
    if (db.prepare("SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id IS NOT NULL").get()) throw new VideoProductionPolicyError("production_slot_busy", 409);
    const now = Date.now();
    const taskId = randomUUID();
    db.prepare(`INSERT INTO tasks(id,title,description,department_id,assigned_agent_id,project_id,status,workflow_pack_key,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'inbox','video_production',?,?)`).run(taskId, `Review ${artifact.artifact_type}`, `Rian reviews immutable ${artifact.artifact_type} artifact ${input.artifactId}.`, target.department_id, input.agentId, input.projectId, now, now);
    db.prepare(`INSERT INTO video_production_stage_jobs(task_id,project_id,plan_version,stage_key,execution_action,assigned_agent_id,idempotency_key,shot_id,shot_version,state,created_by,created_at,updated_at,target_artifact_id)
      VALUES(?,?,?,?,'creative.approve',?,?,NULL,NULL,'READY',?,?,?,?)`).run(taskId, input.projectId, production.plan_version, stageKey, input.agentId, input.idempotencyKey, input.createdBy, now, now, input.artifactId);
    const pointer = finalCutReady
      ? db.prepare("UPDATE video_production_stages SET implemented=1,status='READY',task_id=? WHERE project_id=? AND stage_key=? AND status=? AND task_id IS NULL").run(taskId, input.projectId, stageKey, stage?.status ?? "")
      : db.prepare("UPDATE video_production_stages SET status='READY',task_id=? WHERE project_id=? AND stage_key=? AND status='BLOCKED' AND task_id=?").run(taskId, input.projectId, stageKey, stage?.task_id ?? null);
    if (pointer.changes !== 1) throw new VideoProductionPolicyError("production_stage_pointer_conflict", 409);
    event(db, input.projectId, "production_stage_job_created", input.createdBy, { taskId, stageKey, action: "creative.approve", agentId: input.agentId, artifactId: input.artifactId, planVersion: production.plan_version });
    return { taskId, stageKey, action: "creative.approve", agentId: input.agentId, artifactId: input.artifactId };
  });
}

/** A changes-requested review may create a new Haru job pinned to the rejected version. */
export function createVideoProductionScreenplayRevisionJob(db: Db, input: {
  projectId: string;
  artifactId: string;
  agentId: string;
  idempotencyKey: string;
  createdBy: string;
}): { taskId: string; stageKey: string; action: VideoStudioAction; agentId: string; artifactId: string } {
  if ((db as DatabaseSync).isTransaction) throw new VideoProductionPolicyError("production_job_requires_top_level_commit", 503);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey)) throw new VideoProductionPolicyError("production_job_idempotency_key_invalid", 400);
  return transaction(db, () => {
    const prior = db.prepare("SELECT task_id,stage_key,execution_action,assigned_agent_id,target_artifact_id FROM video_production_stage_jobs WHERE project_id=? AND idempotency_key=?").get(input.projectId, input.idempotencyKey) as { task_id: string; stage_key: string; execution_action: string; assigned_agent_id: string; target_artifact_id: string | null } | undefined;
    if (prior) {
      if (prior.stage_key !== "story_development" || prior.execution_action !== "screenplay.write" || prior.assigned_agent_id !== input.agentId || prior.target_artifact_id !== input.artifactId) throw new VideoProductionPolicyError("production_job_idempotency_conflict", 409);
      return { taskId: prior.task_id, stageKey: "story_development", action: "screenplay.write", agentId: prior.assigned_agent_id, artifactId: input.artifactId };
    }
    const production = db.prepare("SELECT plan_version,approved_version,state,manager_agent_id FROM video_productions WHERE project_id=?").get(input.projectId) as { plan_version: number; approved_version: number | null; state: string; manager_agent_id: string } | undefined;
    if (!production || production.state !== "APPROVED" || production.approved_version !== production.plan_version) throw new VideoProductionPolicyError("production_approval_required");
    const review = db.prepare(`SELECT d.decision,d.feedback,d.target_sha256,a.stage_key,a.attempt_plan_version,j.execution_action
      FROM video_production_stage_decisions d JOIN video_production_stage_artifacts a ON a.project_id=d.project_id AND a.artifact_id=d.target_artifact_id
      JOIN video_production_stage_jobs j ON j.task_id=a.task_id
      WHERE d.project_id=? AND d.target_artifact_id=? ORDER BY d.created_at DESC LIMIT 1`).get(input.projectId, input.artifactId) as { decision: string; feedback: string; target_sha256: string; stage_key: string; attempt_plan_version: number; execution_action: string } | undefined;
    if (!review || review.decision !== "changes_requested" || review.stage_key !== "story_development" || review.execution_action !== "screenplay.write" || review.attempt_plan_version !== production.plan_version || !review.feedback.trim()) throw new VideoProductionPolicyError("screenplay_revision_feedback_missing", 409);
    const stage = db.prepare("SELECT task_id,status FROM video_production_stages WHERE project_id=? AND stage_key='story_development'").get(input.projectId) as { task_id: string | null; status: string } | undefined;
    if (!stage?.task_id || stage.status !== "BLOCKED") throw new VideoProductionPolicyError("production_stage_not_ready", 409);
    if (input.createdBy !== "ceo_session") {
      const grant = db.prepare("SELECT grant_key FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").get(input.projectId, input.createdBy) as { grant_key: string } | undefined;
      if (input.createdBy !== production.manager_agent_id || grant?.grant_key !== "coordinator") throw new VideoProductionPolicyError("production_job_actor_not_authorized", 403);
    }
    const ownership = VIDEO_STUDIO_STAGE_OWNERSHIP.find((entry) => entry.stageKey === "story_development");
    if (ownership?.sequence[0]?.kind !== "agent" || ownership.sequence[0].roleKey !== "screenwriter" || ownership.sequence[0].action !== "screenplay.write") throw new VideoProductionPolicyError("production_stage_policy_invalid", 503);
    const target = db.prepare("SELECT a.department_id,r.role_key FROM agents a JOIN video_production_agent_roles r ON r.agent_id=a.id WHERE a.id=? AND a.workflow_pack_key='video_production'").get(input.agentId) as { department_id: string; role_key: VideoStudioRoleKey } | undefined;
    if (!target || target.role_key !== "screenwriter") throw new VideoProductionPolicyError("unsupported_stage_assignment", 409);
    if (!db.prepare("SELECT 1 FROM video_production_project_grants WHERE project_id=? AND agent_id=? AND revoked_at IS NULL").get(input.projectId, input.agentId)) throw new VideoProductionPolicyError("video_production_project_grant_required", 403);
    if (db.prepare("SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id IS NOT NULL").get()) throw new VideoProductionPolicyError("production_slot_busy", 409);
    const now = Date.now();
    const taskId = randomUUID();
    db.prepare(`INSERT INTO tasks(id,title,description,department_id,assigned_agent_id,project_id,status,workflow_pack_key,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'inbox','video_production',?,?)`).run(taskId, "Revise screenplay", `Haru revises screenplay artifact ${input.artifactId} using Rian's recorded feedback.`, target.department_id, input.agentId, input.projectId, now, now);
    db.prepare(`INSERT INTO video_production_stage_jobs(task_id,project_id,plan_version,stage_key,execution_action,assigned_agent_id,idempotency_key,shot_id,shot_version,state,created_by,created_at,updated_at,target_artifact_id)
      VALUES(?,?,?,'story_development','screenplay.write',?,?,NULL,NULL,'READY',?,?,?,?)`).run(taskId, input.projectId, production.plan_version, input.agentId, input.idempotencyKey, input.createdBy, now, now, input.artifactId);
    const pointer = db.prepare("UPDATE video_production_stages SET status='READY',task_id=? WHERE project_id=? AND stage_key='story_development' AND status='BLOCKED' AND task_id=?").run(taskId, input.projectId, stage.task_id);
    if (pointer.changes !== 1) throw new VideoProductionPolicyError("production_stage_pointer_conflict", 409);
    event(db, input.projectId, "production_stage_job_created", input.createdBy, { taskId, stageKey: "story_development", action: "screenplay.write", agentId: input.agentId, revisionOf: input.artifactId, planVersion: production.plan_version });
    return { taskId, stageKey: "story_development", action: "screenplay.write", agentId: input.agentId, artifactId: input.artifactId };
  });
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
  executionAction?: string,
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
      db.prepare("UPDATE video_production_stage_jobs SET state='READY',updated_at=? WHERE task_id=? AND state='PAUSED'").run(Date.now(), taskId);
    }
    assertVideoProductionTaskAdmission(db, taskId);
    if (!isManagedVideoProductionTask(db, taskId)) throw new VideoProductionPolicyError("not_video_production_task");
    const stageJob = db.prepare("SELECT execution_action,state,assigned_agent_id FROM video_production_stage_jobs WHERE task_id=?").get(taskId) as { execution_action: string; state: string; assigned_agent_id: string } | undefined;
    if (stageJob) {
      if (stageJob.state !== "READY" || (executionAction && executionAction !== stageJob.execution_action) || (assignedAgentId && assignedAgentId !== stageJob.assigned_agent_id)) {
        throw new VideoProductionPolicyError("production_stage_job_not_ready", 409);
      }
      executionAction = stageJob.execution_action;
    } else if (executionAction) {
      throw new VideoProductionPolicyError("production_stage_job_required", 409);
    }
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
    if (stageJob) {
      const jobClaim = db.prepare("UPDATE video_production_stage_jobs SET state='RUNNING',updated_at=? WHERE task_id=? AND state='READY'").run(now, taskId);
      if (jobClaim.changes !== 1) throw new VideoProductionPolicyError("production_stage_job_claim_failed", 409);
    }
    db.prepare(
      "INSERT INTO video_production_attempts(attempt_id,task_id,project_id,state,worker_kind,execution_action,plan_version,assigned_agent_id,created_at,updated_at) VALUES(?,?,?,'PREPARED',?,?,?,?,?,?)",
    ).run(attemptId, taskId, stage.project_id, workerKind, executionAction ?? null, stage.plan_version, assignedAgentId ?? stage.assigned_agent_id, now, now);
    event(db, stage.project_id, "execution_attempt_prepared", "system", { attemptId, taskId, workerKind });
  });
  return attemptId;
}
export function setVideoProductionAttemptLaunchState(
  db: Db,
  taskId: string,
  attemptId: string,
  state: "LAUNCHING" | "RUNNING" | "RECONCILIATION_REQUIRED",
  input: { workerIdentity?: string; pid?: number | null; imageId?: string; workspacePath?: string; detail?: unknown } = {},
): boolean {
  return transaction(db, () => {
    if (!requireOwnedVideoProductionAttempt(db, taskId, attemptId)) return false;
    const current = db.prepare("SELECT detail_json FROM video_production_attempts WHERE task_id=? AND attempt_id=?").get(taskId, attemptId) as { detail_json: string } | undefined;
    let priorDetail: Record<string, unknown> = {};
    try { priorDetail = JSON.parse(current?.detail_json ?? "{}") as Record<string, unknown>; } catch { /* corrupt detail cannot override trusted identity fields */ }
    const nextDetail = input.detail && typeof input.detail === "object" ? input.detail as Record<string, unknown> : { detail: input.detail };
    const result = db.prepare(
      "UPDATE video_production_attempts SET state=?,worker_identity=COALESCE(?,worker_identity),pid=COALESCE(?,pid),container_id=COALESCE(?,container_id),image_id=COALESCE(?,image_id),workspace_path=COALESCE(?,workspace_path),detail_json=?,updated_at=? WHERE attempt_id=? AND task_id=? AND state IN ('PREPARED','LAUNCHING','RUNNING','RECONCILIATION_REQUIRED') AND NOT (state='RUNNING' AND ?='LAUNCHING') AND EXISTS (SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id=? AND attempt_id=?)",
    ).run(state, input.workerIdentity ?? null, input.pid ?? null, input.workerIdentity ?? null, input.imageId ?? null, input.workspacePath ?? null, JSON.stringify({ ...priorDetail, ...nextDetail }), Date.now(), attemptId, taskId, state, taskId, attemptId);
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
    const work = db.prepare("SELECT project_id,stage_key,execution_action FROM video_production_stage_jobs WHERE task_id=? AND state='RUNNING'").get(taskId) as { project_id: string; stage_key: string; execution_action: string } | undefined;
    const state = outcome === "completed" ? "COMPLETED" : "FAILED";
    const attempt = db.prepare(
      "UPDATE video_production_attempts SET state=?,detail_json=?,updated_at=?,finished_at=? WHERE attempt_id=? AND task_id=? AND state IN ('PREPARED','LAUNCHING','RUNNING','COMPLETING','RECONCILIATION_REQUIRED')",
    ).run(state, JSON.stringify(detail), Date.now(), Date.now(), attemptId, taskId);
    if (attempt.changes !== 1) return false;
    let stageOutcome = outcome === "completed" ? "COMPLETED" : "FAILED";
    if (outcome === "completed" && work?.execution_action === "take.review") {
      const needsReview = db.prepare(`SELECT 1 FROM video_production_scenes sc
        WHERE sc.project_id=? AND sc.deleted_at IS NULL AND (
          (sc.is_required=1 AND NOT EXISTS (SELECT 1 FROM video_production_shots sh JOIN video_production_shot_versions sv
            ON sv.project_id=sh.project_id AND sv.shot_id=sh.shot_id AND sv.version=sh.current_version AND sv.scene_version=sc.current_version
            WHERE sh.project_id=sc.project_id AND sh.scene_id=sc.scene_id AND sh.deleted_at IS NULL AND sh.is_required=1))
          OR EXISTS (SELECT 1 FROM video_production_shots sh JOIN video_production_shot_versions sv
            ON sv.project_id=sh.project_id AND sv.shot_id=sh.shot_id AND sv.version=sh.current_version AND sv.scene_version=sc.current_version
            WHERE sh.project_id=sc.project_id AND sh.scene_id=sc.scene_id AND sh.deleted_at IS NULL AND sh.is_required=1
              AND NOT EXISTS (SELECT 1 FROM video_production_approved_takes at WHERE at.project_id=sh.project_id AND at.shot_id=sh.shot_id AND at.shot_version=sh.current_version))
        ) LIMIT 1`).get(work.project_id);
      stageOutcome = needsReview ? "BLOCKED" : "COMPLETED";
    }
    db.prepare("UPDATE video_production_stages SET status=? WHERE task_id=? AND status='RUNNING'").run(stageOutcome, taskId);
    db.prepare("UPDATE video_production_stage_jobs SET state=?,updated_at=? WHERE task_id=? AND state='RUNNING'")
      .run(outcome === "completed" ? "COMPLETED" : "FAILED", Date.now(), taskId);
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

/** Final rough cut is COMPLETED only after its manifest, final bytes and source pins are durably imported. */
export function finishVideoProductionVerifiedRoughCut(db: Db, taskId: string, attemptId: string): boolean {
  return transaction(db, () => {
    const evidence = db.prepare(`SELECT a.project_id,a.state,a.plan_version,j.stage_key,j.execution_action,j.target_artifact_id,
        asset.asset_id,asset.sha256,asset.task_id AS asset_task,asset.attempt_id AS asset_attempt,asset.attempt_plan_version AS asset_plan,
        m.manifest_id,m.digest_sha256,source.content_sha256,source.metadata_json
      FROM video_production_attempts a JOIN video_production_stage_jobs j ON j.task_id=a.task_id
      JOIN video_production_stages s ON s.project_id=j.project_id AND s.stage_key=j.stage_key AND s.task_id=j.task_id AND s.status='RUNNING'
      JOIN video_production_assets asset ON asset.project_id=j.project_id AND asset.task_id=j.task_id AND asset.attempt_id=a.attempt_id AND asset.asset_type='footage' AND asset.shot_id IS NULL
      JOIN video_production_manifests m ON m.project_id=j.project_id AND m.attempt_id=a.attempt_id
      JOIN video_production_stage_artifacts source ON source.project_id=j.project_id AND source.task_id=j.task_id AND source.attempt_id=a.attempt_id AND source.artifact_type='timeline_source'
      JOIN video_production_stage_decisions approval ON approval.project_id=j.project_id AND approval.target_artifact_id=j.target_artifact_id AND approval.decision='approved'
      WHERE a.task_id=? AND a.attempt_id=? AND a.state='COMPLETING' AND j.state='RUNNING' AND j.stage_key='asset_handoff_rough_cut' AND j.execution_action='edit.manage'
        AND source.content_sha256!=''`).get(taskId, attemptId) as
        | { project_id: string; state: string; plan_version: number; stage_key: string; execution_action: string; target_artifact_id: string; asset_id: string; sha256: string; asset_task: string; asset_attempt: string; asset_plan: number; manifest_id: string; digest_sha256: string; content_sha256: string; metadata_json: string }
        | undefined;
    if (!evidence || evidence.asset_task !== taskId || evidence.asset_attempt !== attemptId || evidence.asset_plan !== evidence.plan_version) return false;
    let metadata: Record<string, unknown>;
    try { metadata = JSON.parse(evidence.metadata_json) as Record<string, unknown>; } catch { return false; }
    if (metadata.finalAssetId !== evidence.asset_id || metadata.finalAssetSha256 !== evidence.sha256 || metadata.manifestId !== evidence.manifest_id || metadata.manifestDigest !== evidence.digest_sha256 || metadata.timelineArtifactId !== evidence.target_artifact_id) return false;
    return finishVideoProductionAttempt(db, taskId, attemptId, "completed", { outcome: "validated_final_rough_cut_imported", finalAssetId: evidence.asset_id, finalSha256: evidence.sha256, manifestId: evidence.manifest_id, manifestDigest: evidence.digest_sha256, timelineSourceSha256: evidence.content_sha256 });
  });
}

/** Settle Quinn's decision only if its typed evidence still pins the reviewed final-cut artifact. */
export function finishVideoProductionQaDecision(db: Db, taskId: string, attemptId: string): boolean {
  return transaction(db, () => {
    const row = db.prepare(`SELECT a.project_id,a.plan_version,a.state,j.target_artifact_id,j.stage_key,j.execution_action,d.decision_id,d.decision,
        qa.artifact_id AS qa_artifact_id,qa.content_sha256 AS qa_sha256,qa.content_text AS qa_content,finalcut.content_text AS finalcut_content
      FROM video_production_attempts a JOIN video_production_stage_jobs j ON j.task_id=a.task_id
      JOIN video_production_stages s ON s.project_id=j.project_id AND s.stage_key=j.stage_key AND s.task_id=j.task_id AND s.status='RUNNING'
      JOIN video_production_slot slot ON slot.singleton=1 AND slot.task_id=a.task_id AND slot.attempt_id=a.attempt_id
      JOIN video_production_stage_artifacts finalcut ON finalcut.project_id=j.project_id AND finalcut.artifact_id=j.target_artifact_id AND finalcut.artifact_type='final_cut'
      JOIN video_production_stage_decisions d ON d.project_id=a.project_id AND d.task_id=a.task_id AND d.attempt_id=a.attempt_id
      JOIN video_production_stage_artifacts qa ON qa.project_id=d.project_id AND qa.artifact_id=d.target_artifact_id AND qa.artifact_type='qa_evidence'
      WHERE a.task_id=? AND a.attempt_id=? AND a.state='COMPLETING' AND j.state='RUNNING' AND j.stage_key='finishing_qa' AND j.execution_action='qa.final'
        AND qa.task_id=a.task_id AND qa.attempt_id=a.attempt_id`).get(taskId, attemptId) as
      | { project_id: string; plan_version: number; state: string; target_artifact_id: string; stage_key: string; execution_action: string; decision_id: string; decision: string; qa_artifact_id: string; qa_sha256: string; qa_content: string; finalcut_content: string }
      | undefined;
    if (!row) return false;
    let qa: Record<string, unknown>; let finalCut: Record<string, unknown>;
    try { qa = JSON.parse(row.qa_content) as Record<string, unknown>; finalCut = JSON.parse(row.finalcut_content) as Record<string, unknown>; } catch { return false; }
    const exactPins = ["finalAssetId", "finalAssetSha256", "manifestId", "manifestDigest", "timelineArtifactId", "timelineSha256", "audioCuesArtifactId", "audioCuesSha256", "audioAssetId", "audioSha256", "planVersion"];
    if (qa.decision !== row.decision || qa.finalCutArtifactId !== row.target_artifact_id || qa.finalAssetId !== finalCut.finalAssetId ||
        exactPins.some((key) => qa[key] !== finalCut[key]) || qa.planVersion !== row.plan_version) return false;
    const now = Date.now();
    const state = db.prepare("UPDATE video_production_attempts SET state='COMPLETED',detail_json=?,updated_at=?,finished_at=? WHERE task_id=? AND attempt_id=? AND state='COMPLETING'")
      .run(JSON.stringify({ outcome: "quinn_final_qa_recorded", decisionId: row.decision_id, decision: row.decision, evidenceArtifactId: row.qa_artifact_id, evidenceSha256: row.qa_sha256 }), now, now, taskId, attemptId);
    if (state.changes !== 1) return false;
    db.prepare("UPDATE video_production_stage_jobs SET state='COMPLETED',updated_at=? WHERE task_id=? AND state='RUNNING'").run(now, taskId);
    db.prepare("UPDATE video_production_stages SET status=? WHERE project_id=? AND stage_key='finishing_qa' AND task_id=? AND status='RUNNING'").run(row.decision === "approved" ? "COMPLETED" : "BLOCKED", row.project_id, taskId);
    db.prepare("UPDATE tasks SET status='done',completed_at=?,updated_at=? WHERE id=? AND status='in_progress'").run(now, now, taskId);
    const released = db.prepare("UPDATE video_production_slot SET task_id=NULL,attempt_id=NULL,acquired_at=NULL WHERE singleton=1 AND task_id=? AND attempt_id=?").run(taskId, attemptId);
    if (released.changes !== 1) throw new VideoProductionPolicyError("production_attempt_ownership_lost", 409);
    event(db, row.project_id, "production_final_qa_finished", "system", { taskId, attemptId, decisionId: row.decision_id, decision: row.decision, evidenceArtifactId: row.qa_artifact_id });
    return true;
  });
}

/** Settles Dami's no-model regeneration request while leaving the footage stage blocked for Miro's targeted render. */
export function finishVideoProductionRegenerationRequest(db: Db, taskId: string, attemptId: string): boolean {
  return transaction(db, () => {
    const row = db.prepare(`SELECT a.project_id,a.state,j.shot_id,j.shot_version,j.target_take_id,j.idempotency_key,j.stage_key,j.execution_action,r.request_id
      FROM video_production_attempts a JOIN video_production_stage_jobs j ON j.task_id=a.task_id
      JOIN video_production_stages s ON s.project_id=j.project_id AND s.stage_key=j.stage_key AND s.task_id=j.task_id AND s.status='RUNNING'
      JOIN video_production_slot slot ON slot.singleton=1 AND slot.task_id=a.task_id AND slot.attempt_id=a.attempt_id
      JOIN video_production_regeneration_requests r ON r.project_id=a.project_id AND r.task_id=a.task_id AND r.attempt_id=a.attempt_id
        AND r.shot_id=j.shot_id AND r.shot_version=j.shot_version AND r.rejected_take_id=j.target_take_id AND r.idempotency_key=j.idempotency_key
      WHERE a.task_id=? AND a.attempt_id=? AND a.state='COMPLETING' AND j.state='RUNNING' AND j.execution_action='regeneration.request'`).get(taskId, attemptId) as
        | { project_id: string; state: string; shot_id: string; shot_version: number; target_take_id: string; idempotency_key: string; stage_key: string; execution_action: string; request_id: string }
        | undefined;
    if (!row) return false;
    const now = Date.now();
    if (db.prepare("UPDATE video_production_attempts SET state='COMPLETED',detail_json=?,updated_at=?,finished_at=? WHERE task_id=? AND attempt_id=? AND state='COMPLETING'")
      .run(JSON.stringify({ outcome: "targeted_regeneration_requested", requestId: row.request_id, shotId: row.shot_id, shotVersion: row.shot_version, rejectedTakeId: row.target_take_id }), now, now, taskId, attemptId).changes !== 1) return false;
    db.prepare("UPDATE video_production_stage_jobs SET state='COMPLETED',updated_at=? WHERE task_id=? AND state='RUNNING'").run(now, taskId);
    db.prepare("UPDATE video_production_stages SET status='BLOCKED' WHERE project_id=? AND stage_key='ai_footage_production' AND task_id=? AND status='RUNNING'").run(row.project_id, taskId);
    db.prepare("UPDATE tasks SET status='done',completed_at=?,updated_at=? WHERE id=? AND status='in_progress'").run(now, now, taskId);
    if (db.prepare("UPDATE video_production_slot SET task_id=NULL,attempt_id=NULL,acquired_at=NULL WHERE singleton=1 AND task_id=? AND attempt_id=?").run(taskId, attemptId).changes !== 1) throw new VideoProductionPolicyError("production_attempt_ownership_lost", 409);
    event(db, row.project_id, "targeted_regeneration_request_completed", "system", { taskId, attemptId, requestId: row.request_id, shotId: row.shot_id, rejectedTakeId: row.target_take_id });
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
    db.prepare("UPDATE video_production_stage_jobs SET state='WAITING_APPROVAL',updated_at=? WHERE task_id=? AND state='RUNNING'").run(now, taskId);
    db.prepare("UPDATE video_production_stages SET status='BLOCKED' WHERE task_id=? AND status='RUNNING'").run(taskId);
    db.prepare("UPDATE tasks SET status='review',completed_at=?,updated_at=? WHERE id=? AND status='in_progress'").run(now, now, taskId);
    const released = db.prepare("UPDATE video_production_slot SET task_id=NULL,attempt_id=NULL,acquired_at=NULL WHERE singleton=1 AND task_id=? AND attempt_id=?").run(taskId, attemptId);
    if (released.changes !== 1) throw new VideoProductionPolicyError("production_attempt_ownership_lost", 409);
    const project = db.prepare("SELECT project_id FROM video_production_attempts WHERE attempt_id=? AND task_id=?").get(attemptId, taskId) as { project_id: string };
    event(db, project.project_id, "execution_attempt_finished_pending_review", "system", { attemptId, taskId });
    return true;
  });
}

/** Finish Rian's exact persisted review decision; a provider response alone is never enough. */
export function finishVideoProductionCreativeDecision(db: Db, taskId: string, attemptId: string): boolean {
  return transaction(db, () => {
    const row = db.prepare(`SELECT a.project_id,a.state,j.stage_key,j.execution_action,d.decision_id,d.decision
      FROM video_production_attempts a JOIN video_production_stage_jobs j ON j.task_id=a.task_id
      JOIN video_production_stages s ON s.project_id=j.project_id AND s.stage_key=j.stage_key AND s.task_id=j.task_id AND s.status='RUNNING'
      JOIN video_production_slot slot ON slot.singleton=1 AND slot.task_id=a.task_id AND slot.attempt_id=a.attempt_id
      JOIN video_production_stage_decisions d ON d.project_id=a.project_id AND d.task_id=a.task_id AND d.attempt_id=a.attempt_id
      WHERE a.task_id=? AND a.attempt_id=? AND a.state='COMPLETING' AND j.state='RUNNING'
        AND j.execution_action='creative.approve'`).get(taskId, attemptId) as
        | { project_id: string; state: string; stage_key: string; execution_action: string; decision_id: string; decision: string }
        | undefined;
    if (!row) return false;
    const approved = row.decision === "approved";
    const now = Date.now();
    const attempt = db.prepare("UPDATE video_production_attempts SET state='COMPLETED',detail_json=?,updated_at=?,finished_at=? WHERE task_id=? AND attempt_id=? AND state='COMPLETING'").run(JSON.stringify({ outcome: "stage_decision_recorded", decisionId: row.decision_id, decision: row.decision }), now, now, taskId, attemptId);
    if (attempt.changes !== 1) return false;
    db.prepare("UPDATE video_production_stage_jobs SET state='COMPLETED',updated_at=? WHERE task_id=? AND state='RUNNING'").run(now, taskId);
    db.prepare("UPDATE video_production_stages SET status=? WHERE project_id=? AND stage_key=? AND task_id=? AND status='RUNNING'").run(approved ? "COMPLETED" : "BLOCKED", row.project_id, row.stage_key, taskId);
    db.prepare("UPDATE tasks SET status='done',completed_at=?,updated_at=? WHERE id=? AND status='in_progress'").run(now, now, taskId);
    const source = db.prepare("SELECT a.task_id FROM video_production_stage_decisions d JOIN video_production_stage_artifacts a ON a.project_id=d.project_id AND a.artifact_id=d.target_artifact_id WHERE d.project_id=? AND d.decision_id=?").get(row.project_id, row.decision_id) as { task_id: string } | undefined;
    if (source) {
      db.prepare("UPDATE video_production_stage_jobs SET state='COMPLETED',updated_at=? WHERE task_id=? AND state='WAITING_APPROVAL'").run(now, source.task_id);
      db.prepare("UPDATE tasks SET status='done',completed_at=?,updated_at=? WHERE id=? AND status='review'").run(now, now, source.task_id);
    }
    const released = db.prepare("UPDATE video_production_slot SET task_id=NULL,attempt_id=NULL,acquired_at=NULL WHERE singleton=1 AND task_id=? AND attempt_id=?").run(taskId, attemptId);
    if (released.changes !== 1) throw new VideoProductionPolicyError("production_attempt_ownership_lost", 409);
    event(db, row.project_id, "production_creative_decision_finished", "system", { taskId, attemptId, decisionId: row.decision_id, decision: row.decision });
    return true;
  });
}

export function requireOwnedVideoProductionAttempt(db: Db, taskId: string, attemptId: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id=? AND attempt_id=?").get(taskId, attemptId) &&
      db.prepare("SELECT 1 FROM video_production_attempts WHERE task_id=? AND attempt_id=? AND state IN ('PREPARED','LAUNCHING','RUNNING','COMPLETING','RECONCILIATION_REQUIRED')").get(taskId, attemptId),
  );
}

/** One-shot CAS used only after a caller verifies this exact exited worker. */
export function claimVideoProductionAttemptForRecovery(db: Db, taskId: string, attemptId: string, expectedAction: "footage.submit" | "edit.manage" = "footage.submit"): boolean {
  const stagePredicate = expectedAction === "edit.manage"
    ? "j.stage_key='asset_handoff_rough_cut' AND j.execution_action='edit.manage' AND EXISTS (SELECT 1 FROM video_production_attempts a2 WHERE a2.task_id=j.task_id AND a2.attempt_id=? AND a2.worker_input_digest IS NOT NULL)"
    : "j.stage_key='ai_footage_production' AND j.execution_action='footage.submit'";
  return transaction(db, () => {
    const result = db.prepare(`UPDATE video_production_attempts SET state='RUNNING',updated_at=?,detail_json=json_set(detail_json,'$.recovery','verified_exited_worker')
      WHERE task_id=? AND attempt_id=? AND state='RECONCILIATION_REQUIRED'
        AND EXISTS (SELECT 1 FROM video_production_slot WHERE singleton=1 AND task_id=? AND attempt_id=?)
        AND EXISTS (SELECT 1 FROM tasks t JOIN video_production_stages s ON s.project_id=t.project_id AND s.task_id=t.id
          JOIN video_production_stage_jobs j ON j.task_id=t.id AND j.project_id=t.project_id
          JOIN video_productions p ON p.project_id=t.project_id
          WHERE t.id=? AND t.status='in_progress' AND t.assigned_agent_id=j.assigned_agent_id
            AND s.status='RUNNING' AND s.implemented=1 AND j.state='RUNNING'
            AND ${stagePredicate} AND p.state='APPROVED' AND p.plan_version=p.approved_version
            AND p.plan_version=video_production_attempts.plan_version)`)
      .run(...(expectedAction === "edit.manage" ? [Date.now(), taskId, attemptId, taskId, attemptId, taskId, attemptId] : [Date.now(), taskId, attemptId, taskId, attemptId, taskId]));
    return result.changes === 1;
  });
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
    db.prepare("UPDATE video_production_stage_jobs SET state=?,updated_at=? WHERE task_id=? AND state='RUNNING'")
      .run(input.outcome === "paused" ? "PAUSED" : input.outcome === "completed" ? "COMPLETED" : "FAILED", Date.now(), taskId);
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
