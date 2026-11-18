import type { Request, Response } from "express";
import { createReadStream } from "node:fs";
import type { RuntimeContext } from "../../../types/runtime-context.ts";
import { getVideoProductionAuthenticatedAgent, isAuthenticated } from "../../../security/auth.ts";
import { VIDEO_PRODUCTION_ASSET_ROOT } from "../../../config/runtime.ts";
import {
  createVideoProductionManifest,
  createVideoProductionScene,
  createVideoProductionShot,
  createVideoProductionTake,
  createVideoProductionVisualReference,
  isVideoProductionManifestCurrent,
  linkVideoProductionShotReference,
  listVideoProductionRegistry,
  registerVideoProductionAsset,
  reorderVideoProductionScenes,
  reorderVideoProductionShots,
  requestVideoProductionRegeneration,
  reviewVideoProductionTake,
  softDeleteVideoProductionScene,
  softDeleteVideoProductionShot,
  updateVideoProductionScene,
  updateVideoProductionShot,
  updateVideoProductionVisualReference,
} from "../../workflow/video-production-registry.ts";
import { getVerifiedVideoProductionAssetPath, storeVideoProductionAsset } from "../../workflow/video-production-registry-storage.ts";
import { VideoProductionPolicyError } from "../../workflow/video-production.ts";

type RegistryContext = Pick<RuntimeContext, "app" | "db"> & { assetRoot?: string };
type RegistryAction = "studio.read" | "screenplay.write" | "shot_spec.write" | "visual.manage" | "footage.submit" | "take.review" | "regeneration.request" | "edit.manage";

function respondError(res: Response, error: unknown): void {
  if (error instanceof VideoProductionPolicyError) {
    res.status(error.status).json({ error: error.code });
    return;
  }
  if (error instanceof Error && /SQLITE_BUSY|SQLITE_LOCKED|database is (?:locked|busy)/i.test(error.message)) {
    res.status(503).json({ error: "storage_busy", retryable: true });
    return;
  }
  throw error;
}

function actorFor(req: Request, projectId: string, action: RegistryAction) {
  const actor = getVideoProductionAuthenticatedAgent(req);
  return actor && actor.projectId === projectId && actor.action === action ? actor : null;
}

function jsonHeader(req: Request, header: string): unknown {
  const raw = req.header(header);
  if (!raw || raw.length > 12_000) throw new VideoProductionPolicyError("video_production_upload_metadata_invalid", 400);
  try { return JSON.parse(raw); } catch { throw new VideoProductionPolicyError("video_production_upload_metadata_invalid", 400); }
}

async function uploadAsset(ctx: RegistryContext, req: Request, res: Response, projectId: string, type: "visual_reference" | "footage") {
  const action = type === "visual_reference" ? "visual.manage" : "footage.submit";
  const actor = actorFor(req, projectId, action);
  if (!actor) return res.status(401).json({ error: "video_production_agent_identity_required" });
  const declaredLength = Number(req.header("content-length"));
  if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0 || declaredLength > 256 * 1024 * 1024) {
    return res.status(413).json({ error: "video_production_asset_too_large" });
  }
  const contentType = req.header("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  const assetId = req.header("x-video-production-asset-id")?.trim() ?? "";
  const idempotencyKey = req.header("idempotency-key")?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(assetId) || !/^[A-Za-z0-9_-]{1,128}$/.test(idempotencyKey)) {
    return res.status(400).json({ error: "video_production_asset_id_invalid" });
  }
  try {
    const metadata = jsonHeader(req, "x-video-production-asset-metadata");
    const shotId = req.header("x-video-production-shot-id")?.trim();
    const shotVersionRaw = req.header("x-video-production-shot-version");
    const shotVersion = shotVersionRaw ? Number(shotVersionRaw) : undefined;
    if ((shotId && !Number.isSafeInteger(shotVersion)) || (!shotId && shotVersionRaw)) {
      return res.status(400).json({ error: "video_production_shot_version_invalid" });
    }
    const assetRoot = ctx.assetRoot ?? VIDEO_PRODUCTION_ASSET_ROOT;
    const stored = await storeVideoProductionAsset(assetRoot, {
      projectId, assetType: type, contentType, source: req, maxBytes: 256 * 1024 * 1024,
    });
    if (stored.byteSize !== declaredLength) return res.status(400).json({ error: "video_production_asset_length_mismatch" });
    const result = await registerVideoProductionAsset(ctx.db, actor, {
      projectId, assetId, assetType: type, stored, metadata, idempotencyKey,
      ...(shotId ? { shotId, shotVersion } : {}),
    }, assetRoot);
    return res.status(201).json({ asset: result, validation: { bytesAndHash: "verified", codecOrCreativeQc: "not_performed" } });
  } catch (error) {
    if (error instanceof Error && /^video_production_asset_(?:too_large|empty|signature_mismatch|type_unsupported|kind_mismatch|path_invalid|path_escape|project_id_invalid)/.test(error.message)) {
      const status = error.message.includes("too_large") ? 413 : 400;
      return res.status(status).json({ error: error.message });
    }
    return respondError(res, error);
  }
}

export function registerVideoProductionRegistryRoutes(ctx: RegistryContext): void {
  const { app, db } = ctx;
  app.get("/api/projects/:id/video-production/registry", async (req, res) => {
    const projectId = String(req.params.id);
    const actor = actorFor(req, projectId, "studio.read");
    if (!actor && !isAuthenticated(req)) return res.status(401).json({ error: "unauthorized" });
    try { res.json({ registry: await listVideoProductionRegistry(db, projectId, ctx.assetRoot ?? VIDEO_PRODUCTION_ASSET_ROOT) }); } catch (error) { respondError(res, error); }
  });
  app.get("/api/projects/:id/video-production/assets/:assetId/content", async (req, res) => {
    const projectId = String(req.params.id);
    const actor = actorFor(req, projectId, "studio.read");
    if (!actor && !isAuthenticated(req)) return res.status(401).json({ error: "unauthorized" });
    try {
      const assetId = String(req.params.assetId);
      const asset = ctx.db.prepare(`SELECT a.storage_key,a.sha256,a.byte_size,a.content_type
        FROM video_production_assets a WHERE a.project_id=? AND a.asset_id=? AND a.shot_id IS NULL AND a.asset_type='footage'
          AND EXISTS(SELECT 1 FROM video_production_stage_artifacts f WHERE f.project_id=a.project_id AND f.artifact_type='final_cut'
            AND json_extract(f.content_text,'$.finalAssetId')=a.asset_id AND json_extract(f.content_text,'$.finalAssetSha256')=a.sha256)`)
        .get(projectId, assetId) as { storage_key: string; sha256: string; byte_size: number; content_type: string } | undefined;
      if (!asset || asset.content_type !== "video/mp4") return res.status(404).json({ error: "video_production_media_not_found" });
      const assetRoot = ctx.assetRoot ?? VIDEO_PRODUCTION_ASSET_ROOT;
      const filePath = await getVerifiedVideoProductionAssetPath(assetRoot, { projectId, storageKey: asset.storage_key, sha256: asset.sha256, byteSize: asset.byte_size });
      if (!filePath) return res.status(409).json({ error: "video_production_media_integrity_failed" });
      let start = 0;
      let end = asset.byte_size - 1;
      const range = req.header("range");
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) return res.status(416).set("Content-Range", `bytes */${asset.byte_size}`).end();
        if (match[1]) start = Number(match[1]);
        if (match[2]) end = Number(match[2]);
        if (!match[1]) {
          start = Math.max(0, asset.byte_size - end);
          end = asset.byte_size - 1;
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= asset.byte_size) return res.status(416).set("Content-Range", `bytes */${asset.byte_size}`).end();
        end = Math.min(end, asset.byte_size - 1);
        res.status(206).set("Content-Range", `bytes ${start}-${end}/${asset.byte_size}`);
      }
      res.set({ "Content-Type": asset.content_type, "Content-Length": String(end - start + 1), "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
      const stream = createReadStream(filePath, { start, end });
      stream.on("error", () => { if (!res.headersSent) res.status(409).json({ error: "video_production_media_integrity_failed" }); else res.destroy(); });
      res.on("close", () => { if (!res.writableEnded) stream.destroy(); });
      return stream.pipe(res);
    } catch (error) { return respondError(res, error); }
  });
  app.get("/api/projects/:id/video-production/manifests/:manifestId", async (req, res) => {
    const projectId = String(req.params.id);
    const actor = actorFor(req, projectId, "studio.read");
    if (!actor && !isAuthenticated(req)) return res.status(401).json({ error: "unauthorized" });
    const manifestId = String(req.params.manifestId);
    try {
      const manifest = db.prepare("SELECT * FROM video_production_manifests WHERE project_id=? AND manifest_id=?").get(projectId, manifestId);
      if (!manifest) return res.status(404).json({ error: "video_production_manifest_not_found" });
      const entries = db.prepare("SELECT * FROM video_production_manifest_entries WHERE project_id=? AND manifest_id=? ORDER BY entry_order").all(projectId, manifestId);
      res.json({ manifest, current: await isVideoProductionManifestCurrent(db, projectId, manifestId, ctx.assetRoot ?? VIDEO_PRODUCTION_ASSET_ROOT), entries });
    } catch (error) { respondError(res, error); }
  });

  app.post("/api/projects/:id/video-production/scenes", (req, res) => {
    const projectId = String(req.params.id);
    const actor = actorFor(req, projectId, "screenplay.write");
    if (!actor) return res.status(401).json({ error: "video_production_agent_identity_required" });
    try { res.status(201).json({ scene: createVideoProductionScene(db, actor, projectId, req.body ?? {}) }); } catch (error) { respondError(res, error); }
  });
  app.put("/api/projects/:id/video-production/scenes/order", (req, res) => {
    const projectId = String(req.params.id);
    const actor = actorFor(req, projectId, "screenplay.write");
    if (!actor) return res.status(401).json({ error: "video_production_agent_identity_required" });
    try { res.json({ order: reorderVideoProductionScenes(db, actor, projectId, req.body?.scene_ids) }); } catch (error) { respondError(res, error); }
  });
  app.put("/api/projects/:id/video-production/scenes/:sceneId", (req, res) => {
    const projectId = String(req.params.id);
    const actor = actorFor(req, projectId, "screenplay.write");
    if (!actor) return res.status(401).json({ error: "video_production_agent_identity_required" });
    try { res.json({ scene: updateVideoProductionScene(db, actor, projectId, String(req.params.sceneId), Number(req.body?.expectedVersion), req.body ?? {}) }); } catch (error) { respondError(res, error); }
  });
  app.delete("/api/projects/:id/video-production/scenes/:sceneId", (req, res) => {
    const projectId = String(req.params.id);
    const actor = actorFor(req, projectId, "screenplay.write");
    if (!actor) return res.status(401).json({ error: "video_production_agent_identity_required" });
    try { res.json(softDeleteVideoProductionScene(db, actor, projectId, String(req.params.sceneId), Number(req.body?.expectedVersion))); } catch (error) { respondError(res, error); }
  });
  app.post("/api/projects/:id/video-production/scenes/:sceneId/shots", (req, res) => {
    const projectId = String(req.params.id);
    const actor = actorFor(req, projectId, "shot_spec.write");
    if (!actor) return res.status(401).json({ error: "video_production_agent_identity_required" });
    try { res.status(201).json({ shot: createVideoProductionShot(db, actor, projectId, String(req.params.sceneId), req.body ?? {}) }); } catch (error) { respondError(res, error); }
  });
  app.put("/api/projects/:id/video-production/scenes/:sceneId/shots/order", (req, res) => {
    const projectId = String(req.params.id);
    const actor = actorFor(req, projectId, "shot_spec.write");
    if (!actor) return res.status(401).json({ error: "video_production_agent_identity_required" });
    try { res.json({ order: reorderVideoProductionShots(db, actor, projectId, String(req.params.sceneId), req.body?.shot_ids) }); } catch (error) { respondError(res, error); }
  });
  app.put("/api/projects/:id/video-production/shots/:shotId", (req, res) => {
    const projectId = String(req.params.id);
    const actor = actorFor(req, projectId, "shot_spec.write");
    if (!actor) return res.status(401).json({ error: "video_production_agent_identity_required" });
    try { res.json({ shot: updateVideoProductionShot(db, actor, projectId, String(req.params.shotId), Number(req.body?.expectedVersion), req.body?.content) }); } catch (error) { respondError(res, error); }
  });
  app.delete("/api/projects/:id/video-production/shots/:shotId", (req, res) => {
    const projectId = String(req.params.id);
    const actor = actorFor(req, projectId, "shot_spec.write");
    if (!actor) return res.status(401).json({ error: "video_production_agent_identity_required" });
    try { res.json(softDeleteVideoProductionShot(db, actor, projectId, String(req.params.shotId), Number(req.body?.expectedVersion))); } catch (error) { respondError(res, error); }
  });

  app.post("/api/projects/:id/video-production/assets", async (req, res) => { await uploadAsset(ctx, req, res, String(req.params.id), "footage"); });
  app.post("/api/projects/:id/video-production/visual-references/assets", async (req, res) => { await uploadAsset(ctx, req, res, String(req.params.id), "visual_reference"); });
  app.post("/api/projects/:id/video-production/visual-references", (req, res) => {
    const projectId = String(req.params.id);
    const actor = actorFor(req, projectId, "visual.manage");
    if (!actor) return res.status(401).json({ error: "video_production_agent_identity_required" });
    try { res.status(201).json({ reference: createVideoProductionVisualReference(db, actor, projectId, req.body ?? {}) }); } catch (error) { respondError(res, error); }
  });
  app.put("/api/projects/:id/video-production/visual-references/:referenceId/version", (req, res) => {
    const projectId = String(req.params.id);
    const actor = actorFor(req, projectId, "visual.manage");
    if (!actor) return res.status(401).json({ error: "video_production_agent_identity_required" });
    try { res.json({ reference: updateVideoProductionVisualReference(db, actor, projectId, String(req.params.referenceId), Number(req.body?.expectedVersion), req.body ?? {}) }); } catch (error) { respondError(res, error); }
  });
  app.post("/api/projects/:id/video-production/shots/:shotId/references", (req, res) => {
    const projectId = String(req.params.id);
    const actor = actorFor(req, projectId, "visual.manage");
    if (!actor) return res.status(401).json({ error: "video_production_agent_identity_required" });
    try { res.status(201).json({ reference: linkVideoProductionShotReference(db, actor, projectId, String(req.params.shotId), Number(req.body?.expectedShotVersion), req.body?.reference) }); } catch (error) { respondError(res, error); }
  });
  app.post("/api/projects/:id/video-production/shots/:shotId/takes", (req, res) => {
    const projectId = String(req.params.id);
    const actor = actorFor(req, projectId, "footage.submit");
    if (!actor) return res.status(401).json({ error: "video_production_agent_identity_required" });
    try { res.status(201).json({ take: createVideoProductionTake(db, actor, projectId, String(req.params.shotId), req.body ?? {}) }); } catch (error) { respondError(res, error); }
  });
  app.post("/api/projects/:id/video-production/takes/:takeId/review", async (req, res) => {
    const projectId = String(req.params.id);
    const actor = actorFor(req, projectId, "take.review");
    if (!actor) return res.status(401).json({ error: "video_production_agent_identity_required" });
    try { res.json({ review: await reviewVideoProductionTake(db, actor, projectId, String(req.params.takeId), req.body ?? {}, ctx.assetRoot ?? VIDEO_PRODUCTION_ASSET_ROOT) }); } catch (error) { respondError(res, error); }
  });
  app.post("/api/projects/:id/video-production/shots/:shotId/regeneration", (req, res) => {
    const projectId = String(req.params.id);
    const actor = actorFor(req, projectId, "regeneration.request");
    if (!actor) return res.status(401).json({ error: "video_production_agent_identity_required" });
    try { res.status(202).json({ request: requestVideoProductionRegeneration(db, actor, projectId, String(req.params.shotId), req.body ?? {}) }); } catch (error) { respondError(res, error); }
  });
  app.post("/api/projects/:id/video-production/manifests", async (req, res) => {
    const projectId = String(req.params.id);
    const actor = actorFor(req, projectId, "edit.manage");
    if (!actor) return res.status(401).json({ error: "video_production_agent_identity_required" });
    try { res.status(201).json({ manifest: await createVideoProductionManifest(db, actor, projectId, ctx.assetRoot ?? VIDEO_PRODUCTION_ASSET_ROOT) }); } catch (error) { respondError(res, error); }
  });
}
