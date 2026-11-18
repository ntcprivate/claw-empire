import type { DatabaseSync } from "node:sqlite";

type Db = Pick<DatabaseSync, "exec" | "prepare">;

/** Additive Phase 3 persistence. Registry history is append-only; active heads live on scene/shot rows. */
export function ensureVideoProductionRegistrySchema(db: Db): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_video_prod_credential_attempt_insert
    BEFORE INSERT ON video_production_agent_credentials
    WHEN NOT (
      (NEW.attempt_id IS NULL AND NEW.task_id IS NULL AND NEW.plan_version IS NULL)
      OR (NEW.attempt_id IS NOT NULL AND NEW.task_id IS NOT NULL AND NEW.plan_version IS NOT NULL AND EXISTS (
        SELECT 1 FROM video_production_attempts a
        WHERE a.attempt_id=NEW.attempt_id AND a.project_id=NEW.project_id AND a.task_id=NEW.task_id
          AND a.assigned_agent_id=NEW.agent_id AND a.plan_version=NEW.plan_version
      ))
    ) BEGIN SELECT RAISE(ABORT, 'credential_attempt_scope_mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS trg_video_prod_credential_attempt_update
    BEFORE UPDATE OF attempt_id,task_id,plan_version,project_id,agent_id ON video_production_agent_credentials
    WHEN NOT (
      (NEW.attempt_id IS NULL AND NEW.task_id IS NULL AND NEW.plan_version IS NULL)
      OR (NEW.attempt_id IS NOT NULL AND NEW.task_id IS NOT NULL AND NEW.plan_version IS NOT NULL AND EXISTS (
        SELECT 1 FROM video_production_attempts a
        WHERE a.attempt_id=NEW.attempt_id AND a.project_id=NEW.project_id AND a.task_id=NEW.task_id
          AND a.assigned_agent_id=NEW.agent_id AND a.plan_version=NEW.plan_version
      ))
    ) BEGIN SELECT RAISE(ABORT, 'credential_attempt_scope_mismatch'); END;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_video_prod_attempt_actor_scope
      ON video_production_attempts(project_id, task_id, assigned_agent_id, attempt_id, plan_version);

    CREATE TABLE IF NOT EXISTS video_production_scenes (
      project_id TEXT NOT NULL REFERENCES video_productions(project_id) ON DELETE CASCADE,
      scene_id TEXT NOT NULL,
      current_version INTEGER NOT NULL DEFAULT 1 CHECK(current_version > 0),
      sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
      is_required INTEGER NOT NULL DEFAULT 1 CHECK(is_required IN (0,1)),
      deleted_at INTEGER,
      created_by_agent_id TEXT NOT NULL REFERENCES agents(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      attempt_id TEXT NOT NULL REFERENCES video_production_attempts(attempt_id),
      attempt_plan_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, scene_id),
      FOREIGN KEY(project_id, scene_id, current_version)
        REFERENCES video_production_scene_versions(project_id, scene_id, version) DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(project_id, task_id, created_by_agent_id, attempt_id, attempt_plan_version)
        REFERENCES video_production_attempts(project_id, task_id, assigned_agent_id, attempt_id, plan_version)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_video_prod_scenes_active_order
      ON video_production_scenes(project_id, sort_order) WHERE deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS video_production_scene_versions (
      project_id TEXT NOT NULL,
      scene_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
      description TEXT NOT NULL,
      location TEXT NOT NULL,
      characters_json TEXT NOT NULL CHECK(json_valid(characters_json)),
      continuity_json TEXT NOT NULL CHECK(json_valid(continuity_json)),
      created_by_agent_id TEXT NOT NULL REFERENCES agents(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      attempt_id TEXT NOT NULL REFERENCES video_production_attempts(attempt_id),
      attempt_plan_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, scene_id, version),
      FOREIGN KEY(project_id, scene_id) REFERENCES video_production_scenes(project_id, scene_id) ON DELETE CASCADE,
      FOREIGN KEY(project_id, task_id, created_by_agent_id, attempt_id, attempt_plan_version)
        REFERENCES video_production_attempts(project_id, task_id, assigned_agent_id, attempt_id, plan_version)
    );

    CREATE TABLE IF NOT EXISTS video_production_shots (
      project_id TEXT NOT NULL,
      scene_id TEXT NOT NULL,
      shot_id TEXT NOT NULL,
      current_version INTEGER NOT NULL DEFAULT 1 CHECK(current_version > 0),
      sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
      is_required INTEGER NOT NULL DEFAULT 1 CHECK(is_required IN (0,1)),
      deleted_at INTEGER,
      created_by_agent_id TEXT NOT NULL REFERENCES agents(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      attempt_id TEXT NOT NULL REFERENCES video_production_attempts(attempt_id),
      attempt_plan_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, shot_id),
      UNIQUE(project_id, scene_id, shot_id),
      FOREIGN KEY(project_id, shot_id, current_version) REFERENCES video_production_shot_versions(project_id, shot_id, version) DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(project_id, scene_id) REFERENCES video_production_scenes(project_id, scene_id) ON DELETE CASCADE,
      FOREIGN KEY(project_id, task_id, created_by_agent_id, attempt_id, attempt_plan_version)
        REFERENCES video_production_attempts(project_id, task_id, assigned_agent_id, attempt_id, plan_version)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_video_prod_shots_active_order
      ON video_production_shots(project_id, scene_id, sort_order) WHERE deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS video_production_shot_versions (
      project_id TEXT NOT NULL,
      shot_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      scene_id TEXT NOT NULL,
      scene_version INTEGER NOT NULL CHECK(scene_version > 0),
      sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
      action TEXT NOT NULL,
      camera_json TEXT NOT NULL CHECK(json_valid(camera_json)),
      duration_ms INTEGER NOT NULL CHECK(duration_ms > 0),
      references_json TEXT NOT NULL CHECK(json_valid(references_json)),
      created_by_agent_id TEXT NOT NULL REFERENCES agents(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      attempt_id TEXT NOT NULL REFERENCES video_production_attempts(attempt_id),
      attempt_plan_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, shot_id, version),
      UNIQUE(project_id, shot_id, version, scene_id),
      UNIQUE(project_id, shot_id, version, scene_id, scene_version),
      FOREIGN KEY(project_id, shot_id) REFERENCES video_production_shots(project_id, shot_id) ON DELETE CASCADE,
      FOREIGN KEY(project_id, scene_id, scene_version) REFERENCES video_production_scene_versions(project_id, scene_id, version),
      FOREIGN KEY(project_id, task_id, created_by_agent_id, attempt_id, attempt_plan_version)
        REFERENCES video_production_attempts(project_id, task_id, assigned_agent_id, attempt_id, plan_version)
    );

    CREATE TABLE IF NOT EXISTS video_production_assets (
      project_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      shot_id TEXT,
      shot_version INTEGER,
      asset_type TEXT NOT NULL CHECK(asset_type IN ('visual_reference','footage','audio','continuity')),
      storage_key TEXT NOT NULL,
      sha256 TEXT NOT NULL CHECK(length(sha256)=64),
      byte_size INTEGER NOT NULL CHECK(byte_size > 0),
      content_type TEXT NOT NULL,
      metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
      asset_version INTEGER NOT NULL DEFAULT 1 CHECK(asset_version > 0),
      idempotency_key TEXT NOT NULL,
      uploaded_by TEXT NOT NULL REFERENCES agents(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      attempt_id TEXT NOT NULL REFERENCES video_production_attempts(attempt_id),
      attempt_plan_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      CHECK((shot_id IS NULL AND shot_version IS NULL) OR (shot_id IS NOT NULL AND shot_version IS NOT NULL)),
      PRIMARY KEY(project_id, asset_id),
      UNIQUE(project_id, idempotency_key),
      UNIQUE(project_id, asset_id, shot_id, shot_version),
      UNIQUE(project_id, asset_id, asset_type),
      FOREIGN KEY(project_id) REFERENCES video_productions(project_id) ON DELETE CASCADE,
      FOREIGN KEY(project_id, shot_id, shot_version) REFERENCES video_production_shot_versions(project_id, shot_id, version),
      FOREIGN KEY(project_id, task_id, uploaded_by, attempt_id, attempt_plan_version)
        REFERENCES video_production_attempts(project_id, task_id, assigned_agent_id, attempt_id, plan_version)
    );

    CREATE TABLE IF NOT EXISTS video_production_visual_references (
      project_id TEXT NOT NULL REFERENCES video_productions(project_id) ON DELETE CASCADE,
      reference_id TEXT NOT NULL,
      reference_type TEXT NOT NULL CHECK(reference_type IN ('character','location','style','continuity')),
      owner_shot_id TEXT,
      current_version INTEGER NOT NULL DEFAULT 1 CHECK(current_version > 0),
      deleted_at INTEGER,
      created_by_agent_id TEXT NOT NULL REFERENCES agents(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      attempt_id TEXT NOT NULL REFERENCES video_production_attempts(attempt_id),
      attempt_plan_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, reference_id),
      FOREIGN KEY(project_id, reference_id, current_version)
        REFERENCES video_production_visual_reference_versions(project_id, reference_id, version) DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(project_id, owner_shot_id) REFERENCES video_production_shots(project_id, shot_id),
      FOREIGN KEY(project_id, task_id, created_by_agent_id, attempt_id, attempt_plan_version)
        REFERENCES video_production_attempts(project_id, task_id, assigned_agent_id, attempt_id, plan_version)
    );

    CREATE TABLE IF NOT EXISTS video_production_visual_reference_versions (
      project_id TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      asset_id TEXT NOT NULL,
      asset_type TEXT NOT NULL DEFAULT 'visual_reference' CHECK(asset_type='visual_reference'),
      metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
      created_by_agent_id TEXT NOT NULL REFERENCES agents(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      attempt_id TEXT NOT NULL REFERENCES video_production_attempts(attempt_id),
      attempt_plan_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, reference_id, version),
      FOREIGN KEY(project_id, reference_id) REFERENCES video_production_visual_references(project_id, reference_id) ON DELETE CASCADE,
      FOREIGN KEY(project_id, asset_id, asset_type) REFERENCES video_production_assets(project_id, asset_id, asset_type),
      FOREIGN KEY(project_id, task_id, created_by_agent_id, attempt_id, attempt_plan_version)
        REFERENCES video_production_attempts(project_id, task_id, assigned_agent_id, attempt_id, plan_version)
    );

    CREATE TABLE IF NOT EXISTS video_production_takes (
      project_id TEXT NOT NULL,
      take_id TEXT NOT NULL,
      shot_id TEXT NOT NULL,
      shot_version INTEGER NOT NULL,
      take_number INTEGER NOT NULL CHECK(take_number > 0),
      asset_id TEXT NOT NULL,
      asset_type TEXT NOT NULL DEFAULT 'footage' CHECK(asset_type IN ('footage','audio')),
      attempt_metadata_json TEXT NOT NULL CHECK(json_valid(attempt_metadata_json)),
      content_fingerprint TEXT NOT NULL,
      submitted_by TEXT NOT NULL REFERENCES agents(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      attempt_id TEXT NOT NULL REFERENCES video_production_attempts(attempt_id),
      attempt_plan_version INTEGER NOT NULL,
      submitted_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, take_id),
      UNIQUE(project_id, shot_id, shot_version, take_number),
      UNIQUE(project_id, shot_id, shot_version, take_id),
      UNIQUE(project_id, shot_id, shot_version, take_id, asset_id),
      UNIQUE(project_id, shot_id, shot_version, take_id, asset_id, asset_type),
      FOREIGN KEY(project_id, shot_id, shot_version) REFERENCES video_production_shot_versions(project_id, shot_id, version),
      FOREIGN KEY(project_id, asset_id, shot_id, shot_version) REFERENCES video_production_assets(project_id, asset_id, shot_id, shot_version),
      FOREIGN KEY(project_id, asset_id, asset_type) REFERENCES video_production_assets(project_id, asset_id, asset_type),
      FOREIGN KEY(project_id, task_id, submitted_by, attempt_id, attempt_plan_version)
        REFERENCES video_production_attempts(project_id, task_id, assigned_agent_id, attempt_id, plan_version)
    );

    CREATE TABLE IF NOT EXISTS video_production_shot_references (
      project_id TEXT NOT NULL,
      shot_id TEXT NOT NULL,
      shot_version INTEGER NOT NULL,
      reference_key TEXT NOT NULL,
      reference_type TEXT NOT NULL CHECK(reference_type IN ('continuity','visual','shot_dependency')),
      target_shot_id TEXT,
      target_shot_version INTEGER,
      target_asset_id TEXT,
      target_reference_id TEXT,
      target_reference_version INTEGER,
      created_by TEXT NOT NULL REFERENCES agents(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      attempt_id TEXT NOT NULL REFERENCES video_production_attempts(attempt_id),
      attempt_plan_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, shot_id, shot_version, reference_key),
      CHECK((target_shot_id IS NOT NULL AND target_shot_version IS NOT NULL AND target_asset_id IS NULL AND target_reference_id IS NULL AND target_reference_version IS NULL)
         OR (target_shot_id IS NULL AND target_shot_version IS NULL AND target_asset_id IS NOT NULL AND target_reference_id IS NULL AND target_reference_version IS NULL)
         OR (target_shot_id IS NULL AND target_shot_version IS NULL AND target_asset_id IS NULL AND target_reference_id IS NOT NULL AND target_reference_version IS NOT NULL)),
      FOREIGN KEY(project_id, shot_id, shot_version) REFERENCES video_production_shot_versions(project_id, shot_id, version),
      FOREIGN KEY(project_id, target_shot_id, target_shot_version) REFERENCES video_production_shot_versions(project_id, shot_id, version),
      FOREIGN KEY(project_id, target_asset_id) REFERENCES video_production_assets(project_id, asset_id),
      FOREIGN KEY(project_id, target_reference_id, target_reference_version) REFERENCES video_production_visual_reference_versions(project_id, reference_id, version),
      FOREIGN KEY(project_id, task_id, created_by, attempt_id, attempt_plan_version)
        REFERENCES video_production_attempts(project_id, task_id, assigned_agent_id, attempt_id, plan_version)
    );

    CREATE TABLE IF NOT EXISTS video_production_take_reviews (
      project_id TEXT NOT NULL,
      review_id TEXT NOT NULL,
      take_id TEXT NOT NULL,
      shot_id TEXT NOT NULL,
      shot_version INTEGER NOT NULL,
      asset_id TEXT NOT NULL,
      review_number INTEGER NOT NULL CHECK(review_number > 0),
      decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
      feedback TEXT NOT NULL,
      content_fingerprint TEXT NOT NULL,
      reviewer_agent_id TEXT NOT NULL REFERENCES agents(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      attempt_id TEXT NOT NULL REFERENCES video_production_attempts(attempt_id),
      attempt_plan_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, review_id),
      UNIQUE(project_id, take_id, review_number),
      UNIQUE(project_id, review_id, take_id, shot_id, shot_version, asset_id, decision),
      FOREIGN KEY(project_id, shot_id, shot_version, take_id, asset_id) REFERENCES video_production_takes(project_id, shot_id, shot_version, take_id, asset_id),
      FOREIGN KEY(project_id, task_id, reviewer_agent_id, attempt_id, attempt_plan_version)
        REFERENCES video_production_attempts(project_id, task_id, assigned_agent_id, attempt_id, plan_version)
    );

    CREATE TABLE IF NOT EXISTS video_production_approved_takes (
      project_id TEXT NOT NULL,
      shot_id TEXT NOT NULL,
      take_id TEXT NOT NULL,
      shot_version INTEGER NOT NULL,
      asset_id TEXT NOT NULL,
      decision TEXT NOT NULL DEFAULT 'approved' CHECK(decision='approved'),
      review_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, shot_id),
      FOREIGN KEY(project_id, shot_id, shot_version, take_id, asset_id) REFERENCES video_production_takes(project_id, shot_id, shot_version, take_id, asset_id),
      FOREIGN KEY(project_id, review_id, take_id, shot_id, shot_version, asset_id, decision)
        REFERENCES video_production_take_reviews(project_id, review_id, take_id, shot_id, shot_version, asset_id, decision)
    );

    CREATE TABLE IF NOT EXISTS video_production_regeneration_requests (
      project_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      shot_id TEXT NOT NULL,
      shot_version INTEGER NOT NULL,
      rejected_take_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'requested' CHECK(status='requested'),
      requested_by_agent_id TEXT NOT NULL REFERENCES agents(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      attempt_id TEXT NOT NULL REFERENCES video_production_attempts(attempt_id),
      attempt_plan_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, request_id),
      UNIQUE(project_id, idempotency_key),
      FOREIGN KEY(project_id, shot_id, shot_version, rejected_take_id) REFERENCES video_production_takes(project_id, shot_id, shot_version, take_id),
      FOREIGN KEY(project_id, task_id, requested_by_agent_id, attempt_id, attempt_plan_version)
        REFERENCES video_production_attempts(project_id, task_id, assigned_agent_id, attempt_id, plan_version)
    );

    CREATE TABLE IF NOT EXISTS video_production_manifests (
      project_id TEXT NOT NULL REFERENCES video_productions(project_id) ON DELETE CASCADE,
      manifest_id TEXT NOT NULL,
      manifest_version INTEGER NOT NULL CHECK(manifest_version > 0),
      plan_version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('READY')),
      digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256)=64),
      created_by_agent_id TEXT NOT NULL REFERENCES agents(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      attempt_id TEXT NOT NULL REFERENCES video_production_attempts(attempt_id),
      attempt_plan_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, manifest_id),
      UNIQUE(project_id, manifest_version),
      FOREIGN KEY(project_id, plan_version) REFERENCES video_production_plan_versions(project_id, version),
      FOREIGN KEY(project_id, task_id, created_by_agent_id, attempt_id, attempt_plan_version)
        REFERENCES video_production_attempts(project_id, task_id, assigned_agent_id, attempt_id, plan_version)
    );

    CREATE TABLE IF NOT EXISTS video_production_manifest_entries (
      project_id TEXT NOT NULL,
      manifest_id TEXT NOT NULL,
      entry_order INTEGER NOT NULL CHECK(entry_order >= 0),
      scene_id TEXT NOT NULL,
      scene_version INTEGER NOT NULL,
      shot_id TEXT NOT NULL,
      shot_version INTEGER NOT NULL,
      take_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      asset_sha256 TEXT NOT NULL CHECK(length(asset_sha256)=64),
      metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
      PRIMARY KEY(project_id, manifest_id, entry_order),
      UNIQUE(project_id, manifest_id, shot_id),
      FOREIGN KEY(project_id, manifest_id) REFERENCES video_production_manifests(project_id, manifest_id) ON DELETE CASCADE,
      FOREIGN KEY(project_id, shot_id, shot_version, scene_id, scene_version) REFERENCES video_production_shot_versions(project_id, shot_id, version, scene_id, scene_version),
      FOREIGN KEY(project_id, shot_id, shot_version) REFERENCES video_production_shot_versions(project_id, shot_id, version),
      FOREIGN KEY(project_id, shot_id, shot_version, take_id, asset_id) REFERENCES video_production_takes(project_id, shot_id, shot_version, take_id, asset_id)
    );

    CREATE INDEX IF NOT EXISTS idx_video_prod_assets_shot
      ON video_production_assets(project_id, shot_id, shot_version, asset_type);
    CREATE INDEX IF NOT EXISTS idx_video_prod_takes_shot
      ON video_production_takes(project_id, shot_id, shot_version, take_number);
    CREATE INDEX IF NOT EXISTS idx_video_prod_refs_target_shot
      ON video_production_shot_references(project_id, target_shot_id, target_shot_version);
    CREATE INDEX IF NOT EXISTS idx_video_prod_refs_target_visual
      ON video_production_shot_references(project_id, target_reference_id, target_reference_version);
    CREATE INDEX IF NOT EXISTS idx_video_prod_reviews_take
      ON video_production_take_reviews(project_id, take_id, review_number);
  `);

  const credentialColumns = db.prepare("PRAGMA table_info(video_production_agent_credentials)").all() as Array<{ name: string }>;
  if (!credentialColumns.some((column) => column.name === "attempt_id")) {
    db.exec("ALTER TABLE video_production_agent_credentials ADD COLUMN attempt_id TEXT REFERENCES video_production_attempts(attempt_id)");
  }
  if (!credentialColumns.some((column) => column.name === "task_id")) {
    db.exec("ALTER TABLE video_production_agent_credentials ADD COLUMN task_id TEXT REFERENCES tasks(id)");
  }
  if (!credentialColumns.some((column) => column.name === "plan_version")) {
    db.exec("ALTER TABLE video_production_agent_credentials ADD COLUMN plan_version INTEGER");
  }

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_video_prod_scene_versions_no_update
    BEFORE UPDATE ON video_production_scene_versions BEGIN SELECT RAISE(ABORT, 'scene_versions_are_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_video_prod_shot_versions_no_update
    BEFORE UPDATE ON video_production_shot_versions BEGIN SELECT RAISE(ABORT, 'shot_versions_are_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_video_prod_assets_no_update
    BEFORE UPDATE ON video_production_assets BEGIN SELECT RAISE(ABORT, 'assets_are_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_video_prod_takes_no_update
    BEFORE UPDATE ON video_production_takes BEGIN SELECT RAISE(ABORT, 'takes_are_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_video_prod_refs_no_update
    BEFORE UPDATE ON video_production_shot_references BEGIN SELECT RAISE(ABORT, 'shot_references_are_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_video_prod_visual_ref_versions_no_update
    BEFORE UPDATE ON video_production_visual_reference_versions BEGIN SELECT RAISE(ABORT, 'visual_reference_versions_are_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_video_prod_reviews_no_update
    BEFORE UPDATE ON video_production_take_reviews BEGIN SELECT RAISE(ABORT, 'take_reviews_are_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_video_prod_manifests_no_update
    BEFORE UPDATE ON video_production_manifests BEGIN SELECT RAISE(ABORT, 'manifests_are_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_video_prod_manifest_entries_no_update
    BEFORE UPDATE ON video_production_manifest_entries BEGIN SELECT RAISE(ABORT, 'manifest_entries_are_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_video_prod_regeneration_requests_no_update
    BEFORE UPDATE ON video_production_regeneration_requests BEGIN SELECT RAISE(ABORT, 'regeneration_requests_are_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_video_prod_scene_versions_no_delete
    BEFORE DELETE ON video_production_scene_versions WHEN EXISTS(SELECT 1 FROM video_productions WHERE project_id=OLD.project_id)
    BEGIN SELECT RAISE(ABORT, 'scene_versions_are_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_video_prod_shot_versions_no_delete
    BEFORE DELETE ON video_production_shot_versions WHEN EXISTS(SELECT 1 FROM video_productions WHERE project_id=OLD.project_id)
    BEGIN SELECT RAISE(ABORT, 'shot_versions_are_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_video_prod_assets_no_delete
    BEFORE DELETE ON video_production_assets WHEN EXISTS(SELECT 1 FROM video_productions WHERE project_id=OLD.project_id)
    BEGIN SELECT RAISE(ABORT, 'assets_are_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_video_prod_visual_reference_versions_no_delete
    BEFORE DELETE ON video_production_visual_reference_versions WHEN EXISTS(SELECT 1 FROM video_productions WHERE project_id=OLD.project_id)
    BEGIN SELECT RAISE(ABORT, 'visual_reference_versions_are_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_video_prod_takes_no_delete
    BEFORE DELETE ON video_production_takes WHEN EXISTS(SELECT 1 FROM video_productions WHERE project_id=OLD.project_id)
    BEGIN SELECT RAISE(ABORT, 'takes_are_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_video_prod_references_no_delete
    BEFORE DELETE ON video_production_shot_references WHEN EXISTS(SELECT 1 FROM video_productions WHERE project_id=OLD.project_id)
    BEGIN SELECT RAISE(ABORT, 'shot_references_are_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_video_prod_reviews_no_delete
    BEFORE DELETE ON video_production_take_reviews WHEN EXISTS(SELECT 1 FROM video_productions WHERE project_id=OLD.project_id)
    BEGIN SELECT RAISE(ABORT, 'take_reviews_are_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_video_prod_manifests_no_delete
    BEFORE DELETE ON video_production_manifests WHEN EXISTS(SELECT 1 FROM video_productions WHERE project_id=OLD.project_id)
    BEGIN SELECT RAISE(ABORT, 'manifests_are_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_video_prod_manifest_entries_no_delete
    BEFORE DELETE ON video_production_manifest_entries WHEN EXISTS(SELECT 1 FROM video_productions WHERE project_id=OLD.project_id)
    BEGIN SELECT RAISE(ABORT, 'manifest_entries_are_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_video_prod_regeneration_requests_no_delete
    BEFORE DELETE ON video_production_regeneration_requests WHEN EXISTS(SELECT 1 FROM video_productions WHERE project_id=OLD.project_id)
    BEGIN SELECT RAISE(ABORT, 'regeneration_requests_are_immutable'); END;
  `);
}
