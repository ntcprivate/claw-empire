import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { storeVideoProductionAsset, verifyVideoProductionAsset } from "./video-production-registry-storage.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function tempRoot(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "vp-registry-storage-"));
  directories.push(directory);
  return path.join(directory, "asset-root");
}

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("isolated-test-image"),
]);

describe("Video Production asset storage", () => {
  it("stores actual bytes by project and content hash and verifies them before manifest use", async () => {
    const root = tempRoot();
    const asset = await storeVideoProductionAsset(root, {
      projectId: "project-a", assetType: "visual_reference", contentType: "image/png", source: Readable.from([PNG_BYTES]),
    });
    expect(asset).toMatchObject({ projectId: "project-a", byteSize: PNG_BYTES.length, storageKey: `project-a/${asset.sha256}` });
    expect(asset.sha256).toHaveLength(64);
    expect(await verifyVideoProductionAsset(root, asset)).toBe(true);
    chmodSync(path.join(root, asset.storageKey), 0o644);
    writeFileSync(path.join(root, asset.storageKey), "tampered");
    expect(await verifyVideoProductionAsset(root, asset)).toBe(false);
  });

  it("rejects path-shaped project IDs, mismatched media signatures and oversized streams", async () => {
    const root = tempRoot();
    await expect(storeVideoProductionAsset(root, {
      projectId: "../outside", assetType: "visual_reference", contentType: "image/png", source: Readable.from([PNG_BYTES]),
    })).rejects.toThrow("video_production_project_id_invalid");
    await expect(storeVideoProductionAsset(root, {
      projectId: "project-a", assetType: "visual_reference", contentType: "image/png", source: Readable.from([Buffer.from("not a png")]),
    })).rejects.toThrow("video_production_asset_signature_mismatch");
    await expect(storeVideoProductionAsset(root, {
      projectId: "project-a", assetType: "visual_reference", contentType: "image/png", source: Readable.from([PNG_BYTES]), maxBytes: 8,
    })).rejects.toThrow("video_production_asset_too_large");
    await expect(storeVideoProductionAsset(root, {
      projectId: "project-a", assetType: "visual_reference", contentType: "toString", source: Readable.from([PNG_BYTES]),
    })).rejects.toThrow("video_production_asset_type_unsupported");
  });

  it("rejects a project directory redirected through a symlink", async () => {
    const root = tempRoot();
    const project = path.join(root, "project-a");
    const outside = path.join(path.dirname(root), "outside-project");
    writeFileSync(path.join(path.dirname(root), "outside-placeholder"), "x");
    try {
      symlinkSync(path.dirname(root), project, "junction");
    } catch {
      return;
    }
    await expect(storeVideoProductionAsset(root, {
      projectId: "project-a", assetType: "visual_reference", contentType: "image/png", source: Readable.from([PNG_BYTES]),
    })).rejects.toThrow("video_production_asset_path_invalid");
    expect(outside).toBeDefined();
  });
});
