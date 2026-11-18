import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { VideoProductionPolicyError } from "./video-production.ts";

export const MAX_SOURCE_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function fail(): never {
  throw new VideoProductionPolicyError("production_source_archive_invalid", 409);
}

/** Resolve every component, rejecting both symlinks and path aliases. Never
 * materialize archive paths: the worker's archive is untrusted input. */
async function confinedFile(root: string, relative: string): Promise<string> {
  if (
    !relative ||
    relative.length > 500 ||
    relative.includes("\\") ||
    relative.includes(":") ||
    relative.includes("\0") ||
    relative.startsWith("/") ||
    relative.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part))
  )
    fail();
  let current = root;
  const parts = relative.split("/");
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (i === parts.length - 1 ? !info.isFile() : !info.isDirectory())) fail();
  }
  const resolved = await realpath(current);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) fail();
  return resolved;
}

export type SourceArchiveReference = {
  storageKey: string;
  sha256: string;
  byteSize: number;
  skillCommit: string;
  fileCount: number;
};

/** Verifies the exact authored project and preserves its complete bounded
 * archive in immutable storage before the attempt workspace may be cleaned. */
export async function importMiroSourceArchive(input: {
  workspacePath: string;
  storageRoot: string;
  projectId: string;
  attemptId: string;
  shotId: string;
  shotVersion: number;
  renderHash: string;
  sourceText: string;
  sourceArchiveOutput: unknown;
  sourceArchiveSha256: unknown;
  sourceArchiveBytes: unknown;
}): Promise<SourceArchiveReference> {
  if (
    !/^[a-f0-9]{24}$/.test(input.renderHash) ||
    input.sourceArchiveOutput !== "output/project-source.json" ||
    typeof input.sourceArchiveSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.sourceArchiveSha256) ||
    !Number.isSafeInteger(input.sourceArchiveBytes) ||
    Number(input.sourceArchiveBytes) < 1 ||
    Number(input.sourceArchiveBytes) > MAX_SOURCE_ARCHIVE_BYTES
  )
    fail();
  const workspace = await realpath(input.workspacePath);
  const archivePath = await confinedFile(workspace, "output/project-source.json");
  const info = await lstat(archivePath);
  if (info.size !== input.sourceArchiveBytes || info.size > MAX_SOURCE_ARCHIVE_BYTES) fail();
  const bytes = await readFile(archivePath);
  if (bytes.length !== info.size || digest(bytes) !== input.sourceArchiveSha256) fail();
  let archive: Record<string, any> = {};
  try {
    archive = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail();
  }
  if (
    !archive ||
    archive.protocol !== "claw-video-project-source-v1" ||
    archive.attemptId !== input.attemptId ||
    archive.shotId !== input.shotId ||
    archive.shotVersion !== input.shotVersion ||
    archive.entryPoint !== "entry.tsx" ||
    typeof archive.skillCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(archive.skillCommit) ||
    !Array.isArray(archive.files) ||
    !archive.files.length ||
    archive.files.length > 1000
  )
    fail();
  const projectRoot = path.join(workspace, `render-${input.renderHash}`);
  if ((await lstat(projectRoot)).isSymbolicLink() || !(await lstat(projectRoot)).isDirectory()) fail();
  const canonicalProject = await realpath(projectRoot);
  const seen = new Set<string>();
  let hasEntry = false;
  let totalBytes = 0;
  for (const file of archive.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      seen.has(file.path.toLowerCase()) ||
      file.encoding !== "base64" ||
      typeof file.content !== "string" ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.byteSize) ||
      file.byteSize < 0 ||
      file.byteSize > MAX_SOURCE_FILE_BYTES ||
      file.content.length > Math.ceil(MAX_SOURCE_FILE_BYTES / 3) * 4
    )
      fail();
    if (file.path.split("/").includes("node_modules")) fail();
    seen.add(file.path.toLowerCase());
    const raw = Buffer.from(file.content, "base64");
    totalBytes += raw.length;
    if (
      raw.toString("base64") !== file.content ||
      raw.length !== file.byteSize ||
      digest(raw) !== file.sha256 ||
      totalBytes > MAX_SOURCE_ARCHIVE_BYTES
    )
      fail();
    const actualPath = await confinedFile(canonicalProject, file.path);
    if ((await lstat(actualPath)).size !== raw.length) fail();
    const actual = await readFile(actualPath);
    if (!actual.equals(raw)) fail();
    if (file.path === "entry.tsx") {
      if (raw.toString("utf8") !== input.sourceText) fail();
      hasEntry = true;
    }
  }
  if (!hasEntry) fail();
  // Mirror the worker's archive inventory: only dependencies installed in the
  // image and dot-prefixed scratch files are excluded. A partial archive must
  // never become the only surviving source after workspace cleanup.
  let visited = 0;
  const inventory = async (relative = ""): Promise<void> => {
    if (++visited > 2000 || relative.length > 500) fail();
    for (const entry of await readdir(path.join(canonicalProject, relative), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail();
      if (entry.isDirectory()) await inventory(child);
      else if (!entry.isFile() || !seen.has(child.toLowerCase())) fail();
    }
  };
  await inventory();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.projectId)) fail();
  await mkdir(input.storageRoot, { recursive: true });
  const root = await realpath(input.storageRoot);
  const directory = path.join(root, input.projectId);
  await mkdir(directory, { recursive: true });
  if (
    (await lstat(directory)).isSymbolicLink() ||
    !(await lstat(directory)).isDirectory() ||
    path.dirname(await realpath(directory)) !== root
  )
    fail();
  const target = path.join(directory, input.sourceArchiveSha256);
  const temporary = path.join(directory, `.source-${randomUUID()}`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o444);
    try {
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (
      (await lstat(target)).isSymbolicLink() ||
      !(await lstat(target)).isFile() ||
      !bytes.equals(await readFile(target))
    )
      fail();
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    storageKey: `${input.projectId}/${input.sourceArchiveSha256}`,
    sha256: input.sourceArchiveSha256,
    byteSize: bytes.length,
    skillCommit: archive.skillCommit,
    fileCount: archive.files.length,
  };
}
