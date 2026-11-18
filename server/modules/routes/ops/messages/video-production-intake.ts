import { createHash } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Response } from "express";
import { createProjectRouteHelpers } from "../../core/projects/helpers.ts";
import { ingestVideoProductionDirective } from "../../../workflow/video-production.ts";
import { respondVideoProductionError } from "../../core/video-production.ts";
import { VIDEO_PRODUCTION_BRIEF_FIELDS } from "../../../../../shared/video-production.ts";

export function isVideoProductionDirective(
  db: Pick<DatabaseSync, "prepare">,
  body: Record<string, unknown>,
  content: string,
): boolean {
  if (body.workflow_pack_key === "video_production" || /^\s*\[video_production\]/i.test(content)) return true;
  if (typeof body.project_id !== "string") return false;
  const project = db.prepare("SELECT default_pack_key FROM projects WHERE id = ?").get(body.project_id) as
    | { default_pack_key: string }
    | undefined;
  return project?.default_pack_key === "video_production";
}

// A retry without a transport key still identifies the same production request.
// An intentional second production must use a fresh explicit idempotency key.
export function videoProductionIntakeKey(body: Record<string, unknown>, content: string): string {
  const brief =
    body.brief && typeof body.brief === "object" && !Array.isArray(body.brief)
      ? (body.brief as Record<string, unknown>)
      : {};
  return `video-production:${createHash("sha256")
    .update(
      JSON.stringify([
        content.trim(),
        body.project_id ?? null,
        body.project_path ?? null,
        VIDEO_PRODUCTION_BRIEF_FIELDS.map((field) => brief[field] ?? ""),
      ]),
    )
    .digest("hex")}`;
}

export function acceptVideoProductionDirective(
  db: DatabaseSync,
  res: Response,
  body: Record<string, unknown>,
  messageId: string,
  content: string,
) {
  try {
    const normalize = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const helpers = createProjectRouteHelpers({ db, normalizeTextField: normalize });
    let projectPath = normalize(body.project_path);
    const projectId = normalize(body.project_id);
    if (projectId) {
      const project = db.prepare("SELECT project_path FROM projects WHERE id = ?").get(projectId) as
        | { project_path: string }
        | undefined;
      if (!project) {
        res.status(400).json({ error: "project_not_found" });
        return null;
      }
      if (projectPath && helpers.normalizeProjectPathInput(projectPath) !== project.project_path) {
        res.status(409).json({ error: "project_path_mismatch" });
        return null;
      }
      projectPath = project.project_path;
    }
    if (!projectPath || !path.isAbsolute(projectPath)) {
      res.status(400).json({ error: "absolute_project_path_required" });
      return null;
    }
    projectPath = helpers.normalizeProjectPathInput(projectPath)!;
    if (!helpers.isPathInsideAllowedRoots(projectPath)) {
      res.status(400).json({ error: "project_path_outside_allowed_roots" });
      return null;
    }
    const inspection = helpers.inspectDirectoryPath(projectPath);
    if (inspection.exists && !inspection.isDirectory) {
      res.status(400).json({ error: "project_path_not_directory" });
      return null;
    }
    return ingestVideoProductionDirective(db, {
      messageId,
      content,
      projectId,
      projectPath,
      brief: body.brief,
      actorId: "ceo_directive",
      allowProjectBinding: body.workflow_pack_key === "video_production" || /^\s*\[video_production\]/i.test(content),
    });
  } catch (error) {
    respondVideoProductionError(res, error);
    return null;
  }
}
