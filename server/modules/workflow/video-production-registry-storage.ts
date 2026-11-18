import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, link, lstat, mkdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type VideoProductionAssetType = "visual_reference" | "footage" | "audio" | "continuity";

export interface StoredVideoProductionAsset {
  projectId: string;
  storageKey: string;
  sha256: string;
  byteSize: number;
  contentType: string;
}

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const PROJECT_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const CONTENT_TYPE_SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  "image/png": (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/webp": (bytes) => bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP",
  "video/mp4": (bytes) => bytes.length >= 8 && bytes.toString("ascii", 4, 8) === "ftyp",
  "video/webm": (bytes) => bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
  "audio/wav": (bytes) => bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE",
  "audio/ogg": (bytes) => bytes.toString("ascii", 0, 4) === "OggS",
  "audio/mpeg": (bytes) => bytes.toString("ascii", 0, 3) === "ID3" || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0),
};

function fail(code: string): never {
  throw new Error(code);
}

function validateAssetKind(type: VideoProductionAssetType, contentType: string): void {
  if (!Object.hasOwn(CONTENT_TYPE_SIGNATURES, contentType)) fail("video_production_asset_type_unsupported");
  if ((type === "visual_reference" || type === "continuity") && !contentType.startsWith("image/")) {
    fail("video_production_asset_kind_mismatch");
  }
  if (type === "footage" && !contentType.startsWith("video/")) fail("video_production_asset_kind_mismatch");
  if (type === "audio" && !contentType.startsWith("audio/")) fail("video_production_asset_kind_mismatch");
}

async function resolveProjectDirectory(storageRoot: string, projectId: string): Promise<{ root: string; project: string }> {
  if (!PROJECT_KEY.test(projectId)) fail("video_production_project_id_invalid");
  await mkdir(storageRoot, { recursive: true });
  const root = await realpath(storageRoot);
  const project = path.join(root, projectId);
  await mkdir(project, { recursive: true });
  const projectStat = await lstat(project);
  if (projectStat.isSymbolicLink() || !projectStat.isDirectory()) fail("video_production_asset_path_invalid");
  const canonicalProject = await realpath(project);
  if (path.dirname(canonicalProject) !== root) fail("video_production_asset_path_escape");
  return { root, project: canonicalProject };
}

async function hashFile(filePath: string): Promise<{ sha256: string; byteSize: number }> {
  const digest = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteSize += bytes.length;
    digest.update(bytes);
  }
  return { sha256: digest.digest("hex"), byteSize };
}

/** Stores uploaded bytes in an immutable, content-addressed per-project directory. No caller path is accepted. */
export async function storeVideoProductionAsset(
  storageRoot: string,
  input: { projectId: string; assetType: VideoProductionAssetType; contentType: string; source: Readable; maxBytes?: number },
): Promise<StoredVideoProductionAsset> {
  validateAssetKind(input.assetType, input.contentType);
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > DEFAULT_MAX_BYTES) fail("video_production_asset_limit_invalid");
  const { project } = await resolveProjectDirectory(storageRoot, input.projectId);
  const temporary = path.join(project, `.incoming-${randomUUID()}`);
  const digest = createHash("sha256");
  let byteSize = 0;
  const signature = Buffer.alloc(32);
  let signatureLength = 0;
  const meter = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteSize += bytes.length;
      if (byteSize > maxBytes) {
        callback(new Error("video_production_asset_too_large"));
        return;
      }
      digest.update(bytes);
      if (signatureLength < signature.length) {
        const count = Math.min(signature.length - signatureLength, bytes.length);
        bytes.copy(signature, signatureLength, 0, count);
        signatureLength += count;
      }
      callback(null, bytes);
    },
  });

  try {
    await pipeline(input.source, meter, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    if (byteSize === 0) fail("video_production_asset_empty");
    const signatureBytes = signature.subarray(0, signatureLength);
    if (!CONTENT_TYPE_SIGNATURES[input.contentType](signatureBytes)) fail("video_production_asset_signature_mismatch");
    const sha256 = digest.digest("hex");
    const destination = path.join(project, sha256);
    try {
      await link(temporary, destination);
      await chmod(destination, 0o444);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const destinationStat = await lstat(destination);
      if (destinationStat.isSymbolicLink() || !destinationStat.isFile()) fail("video_production_asset_path_invalid");
      const existing = await hashFile(destination);
      if (existing.sha256 !== sha256 || existing.byteSize !== byteSize) fail("video_production_asset_hash_conflict");
    }
    const canonicalDestination = await realpath(destination);
    if (path.dirname(canonicalDestination) !== project) fail("video_production_asset_path_escape");
    return { projectId: input.projectId, storageKey: `${input.projectId}/${sha256}`, sha256, byteSize, contentType: input.contentType };
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Reopens only a server-generated project/hash key and verifies the stored bytes before manifest inclusion. */
export async function verifyVideoProductionAsset(
  storageRoot: string,
  input: { projectId: string; storageKey: string; sha256: string; byteSize: number },
): Promise<boolean> {
  if (!PROJECT_KEY.test(input.projectId) || !/^[a-f0-9]{64}$/.test(input.sha256) || input.storageKey !== `${input.projectId}/${input.sha256}`) return false;
  try {
    const { project } = await resolveProjectDirectory(storageRoot, input.projectId);
    const filePath = path.join(project, input.sha256);
    const fileStat = await lstat(filePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) return false;
    const canonical = await realpath(filePath);
    if (path.dirname(canonical) !== project) return false;
    const current = await hashFile(canonical);
    return current.sha256 === input.sha256 && current.byteSize === input.byteSize && (await stat(canonical)).isFile();
  } catch {
    return false;
  }
}
