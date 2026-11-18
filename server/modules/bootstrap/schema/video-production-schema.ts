import type { DatabaseSync } from "node:sqlite";
import { ensureVideoProductionRbacSchema } from "./video-production-rbac-schema.ts";
import { ensureVideoProductionRegistrySchema } from "./video-production-registry-schema.ts";

export function ensureVideoProductionSchema(db: Pick<DatabaseSync, "exec" | "prepare">): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS video_productions (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      root_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
      message_id TEXT NOT NULL UNIQUE,
      directive_hash TEXT NOT NULL,
      manager_agent_id TEXT NOT NULL REFERENCES agents(id),
      state TEXT NOT NULL CHECK(state IN ('NEEDS_INFORMATION','WAITING_FOR_APPROVAL','CHANGES_REQUESTED','APPROVED')),
      plan_version INTEGER NOT NULL DEFAULT 1,
      approved_version INTEGER,
      brief_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS video_production_stages (
      project_id TEXT NOT NULL REFERENCES video_productions(project_id) ON DELETE CASCADE,
      stage_key TEXT NOT NULL,
      stage_order INTEGER NOT NULL,
      status TEXT NOT NULL,
      implemented INTEGER NOT NULL DEFAULT 0 CHECK(implemented IN (0,1)),
      task_id TEXT UNIQUE REFERENCES tasks(id),
      PRIMARY KEY(project_id, stage_key),
      UNIQUE(project_id, stage_order)
    );
    CREATE TABLE IF NOT EXISTS video_production_auto_runs (
      project_id TEXT PRIMARY KEY REFERENCES video_productions(project_id) ON DELETE CASCADE,
      plan_version INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('RUNNING','WAITING_CEO','ERROR','PAUSED','COMPLETED')),
      task_id TEXT,
      reason TEXT,
      jobs_started INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS video_production_plan_versions (
      project_id TEXT NOT NULL REFERENCES video_productions(project_id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      brief_json TEXT NOT NULL,
      stages_json TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, version)
    );
    CREATE TABLE IF NOT EXISTS video_production_decisions (
      project_id TEXT NOT NULL REFERENCES video_productions(project_id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('approve','request_changes')),
      note TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, version)
    );
    CREATE TABLE IF NOT EXISTS video_production_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES video_productions(project_id) ON DELETE CASCADE,
      event TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS video_production_slot (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      task_id TEXT UNIQUE REFERENCES tasks(id),
      attempt_id TEXT UNIQUE,
      acquired_at INTEGER
    );
    INSERT OR IGNORE INTO video_production_slot(singleton) VALUES(1);
    CREATE TABLE IF NOT EXISTS video_production_attempts (
      attempt_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      project_id TEXT NOT NULL REFERENCES video_productions(project_id),
      state TEXT NOT NULL CHECK(state IN ('PREPARED','LAUNCHING','RUNNING','COMPLETING','RECONCILIATION_REQUIRED','COMPLETED','FAILED','PAUSED')),
      worker_kind TEXT NOT NULL,
      execution_action TEXT,
      worker_identity TEXT,
      plan_version INTEGER NOT NULL,
      assigned_agent_id TEXT,
      container_id TEXT,
      workspace_path TEXT,
      image_id TEXT,
      pid INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER,
      detail_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS video_production_stage_jobs (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id),
      project_id TEXT NOT NULL,
      plan_version INTEGER NOT NULL,
      stage_key TEXT NOT NULL,
      execution_action TEXT NOT NULL,
      assigned_agent_id TEXT NOT NULL REFERENCES agents(id),
      idempotency_key TEXT NOT NULL,
      shot_id TEXT,
      shot_version INTEGER,
      state TEXT NOT NULL CHECK(state IN ('READY','RUNNING','WAITING_APPROVAL','COMPLETED','FAILED','PAUSED')),
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(project_id,idempotency_key),
      CHECK((shot_id IS NULL AND shot_version IS NULL) OR (shot_id IS NOT NULL AND shot_version IS NOT NULL)),
      FOREIGN KEY(project_id,stage_key) REFERENCES video_production_stages(project_id,stage_key) ON DELETE CASCADE,
      FOREIGN KEY(project_id,shot_id,shot_version) REFERENCES video_production_shot_versions(project_id,shot_id,version)
    );
    CREATE INDEX IF NOT EXISTS idx_video_production_stage_jobs_current
      ON video_production_stage_jobs(project_id,stage_key,state,created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_video_production_one_live_attempt
      ON video_production_attempts((1)) WHERE state IN ('PREPARED','LAUNCHING','RUNNING','COMPLETING','RECONCILIATION_REQUIRED');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_video_production_one_running_stage
      ON video_production_stages((1)) WHERE status = 'RUNNING';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_video_production_one_running_task
      ON tasks((1)) WHERE workflow_pack_key = 'video_production' AND status = 'in_progress';
  `);
  const jobColumns = db.prepare("PRAGMA table_info(video_production_stage_jobs)").all() as Array<{ name: string }>;
  if (!jobColumns.some((column) => column.name === "target_artifact_id")) {
    db.exec("ALTER TABLE video_production_stage_jobs ADD COLUMN target_artifact_id TEXT");
  }
  for (const [name, type] of [["target_take_id", "TEXT"], ["target_asset_id", "TEXT"], ["target_asset_sha256", "TEXT"]] as const) {
    if (!jobColumns.some((column) => column.name === name)) db.exec(`ALTER TABLE video_production_stage_jobs ADD COLUMN ${name} ${type}`);
  }
  // Additive upgrade for databases created by the Phase 1 schema.
  const columns = db.prepare("PRAGMA table_info(video_production_slot)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "attempt_id")) {
    db.exec("ALTER TABLE video_production_slot ADD COLUMN attempt_id TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_video_production_slot_attempt ON video_production_slot(attempt_id) WHERE attempt_id IS NOT NULL");
  }
  const attemptColumns = db.prepare("PRAGMA table_info(video_production_attempts)").all() as Array<{ name: string }>;
  if (!attemptColumns.some((column) => column.name === "workspace_path")) {
    db.exec("ALTER TABLE video_production_attempts ADD COLUMN workspace_path TEXT");
  }
  if (!attemptColumns.some((column) => column.name === "execution_action")) {
    db.exec("ALTER TABLE video_production_attempts ADD COLUMN execution_action TEXT");
  }
  if (!attemptColumns.some((column) => column.name === "worker_input_digest")) {
    db.exec("ALTER TABLE video_production_attempts ADD COLUMN worker_input_digest TEXT");
  }
  ensureVideoProductionRbacSchema(db);
  ensureVideoProductionRegistrySchema(db);
}
