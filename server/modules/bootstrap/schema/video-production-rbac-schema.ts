import type { DatabaseSync } from "node:sqlite";

/** Additive Phase 2 RBAC persistence. Permission definitions stay in code. */
export function ensureVideoProductionRbacSchema(db: Pick<DatabaseSync, "exec" | "prepare">): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS video_production_agent_roles (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      role_key TEXT NOT NULL CHECK(role_key IN (
        'production_manager','director','screenwriter','art_director',
        'video_producer','editor','sound_producer','qa_supervisor'
      )),
      bound_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS video_production_project_grants (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      grant_key TEXT NOT NULL CHECK(grant_key IN ('member','coordinator')),
      granted_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER,
      PRIMARY KEY(project_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS video_production_agent_credentials (
      credential_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      scopes_json TEXT NOT NULL,
      issued_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_video_prod_grants_active
      ON video_production_project_grants(project_id, agent_id, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_video_prod_credentials_scope
      ON video_production_agent_credentials(project_id, agent_id, revoked_at, expires_at);
  `);
  const roleColumns = db.prepare("PRAGMA table_info(video_production_agent_roles)").all() as Array<{ name: string }>;
  if (!roleColumns.some((column) => column.name === "bound_by")) {
    db.exec("ALTER TABLE video_production_agent_roles ADD COLUMN bound_by TEXT NOT NULL DEFAULT 'legacy_seed'");
  }
}
