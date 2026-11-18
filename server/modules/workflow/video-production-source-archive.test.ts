import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importMiroSourceArchive, MAX_SOURCE_ARCHIVE_BYTES } from "./video-production-source-archive.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "miro-source-"));
  roots.push(root);
  const workspacePath = path.join(root, "workspace");
  const renderHash = "a".repeat(24);
  const projectRoot = path.join(workspacePath, `render-${renderHash}`);
  await mkdir(path.join(projectRoot, "assets", "lib"), { recursive: true });
  await mkdir(path.join(workspacePath, "output"));
  const sourceText = 'import {x} from "./assets/lib/example"; export default x;';
  const files = [
    { path: "entry.tsx", content: sourceText },
    { path: "assets/lib/example.tsx", content: "export const x = 1;" },
  ];
  const archive = {
    protocol: "claw-video-project-source-v1",
    attemptId: "attempt-1",
    shotId: "shot-1",
    shotVersion: 2,
    entryPoint: "entry.tsx",
    skillCommit: "b".repeat(40),
    files: files.map((file) => {
      const raw = Buffer.from(file.content);
      return {
        path: file.path,
        encoding: "base64",
        content: raw.toString("base64"),
        byteSize: raw.length,
        sha256: hash(raw),
      };
    }),
  };
  for (const file of files) await writeFile(path.join(projectRoot, file.path), file.content);
  const input = {
    workspacePath,
    storageRoot: path.join(root, "storage"),
    projectId: "project-1",
    attemptId: "attempt-1",
    shotId: "shot-1",
    shotVersion: 2,
    renderHash,
    sourceText,
    sourceArchiveOutput: "output/project-source.json",
    sourceArchiveSha256: "",
    sourceArchiveBytes: 0,
  };
  const save = async () => {
    const bytes = Buffer.from(JSON.stringify(archive));
    await writeFile(path.join(workspacePath, "output", "project-source.json"), bytes);
    input.sourceArchiveSha256 = hash(bytes);
    input.sourceArchiveBytes = bytes.length;
  };
  await save();
  return { root, input, archive, save, projectRoot };
}

describe("Miro authored project source archive", () => {
  it("preserves all source dependencies and imported bytes after workspace cleanup and is idempotent", async () => {
    const f = await fixture();
    const first = await importMiroSourceArchive(f.input);
    expect(first).toMatchObject({
      fileCount: 2,
      skillCommit: "b".repeat(40),
      storageKey: `project-1/${f.input.sourceArchiveSha256}`,
    });
    expect(await importMiroSourceArchive(f.input)).toEqual(first);
    await rm(f.input.workspacePath, { recursive: true, force: true });
    const preserved = JSON.parse(await readFile(path.join(f.input.storageRoot, first.storageKey), "utf8"));
    expect(preserved.files.map((file: { path: string }) => file.path)).toEqual(["entry.tsx", "assets/lib/example.tsx"]);
  });
  it.each(["attemptId", "shotId", "shotVersion", "entryPoint", "skillCommit"])(
    "rejects mismatched identity or entry %s",
    async (field) => {
      const f = await fixture();
      (f.archive as Record<string, unknown>)[field] = field === "shotVersion" ? 9 : "invalid";
      await f.save();
      await expect(importMiroSourceArchive(f.input)).rejects.toThrow("production_source_archive_invalid");
    },
  );
  it("rejects archive corruption, oversized declarations, mismatched entry source and modified dependency", async () => {
    const f = await fixture();
    await expect(importMiroSourceArchive({ ...f.input, sourceArchiveSha256: "c".repeat(64) })).rejects.toThrow();
    await expect(
      importMiroSourceArchive({ ...f.input, sourceArchiveBytes: MAX_SOURCE_ARCHIVE_BYTES + 1 }),
    ).rejects.toThrow();
    await expect(importMiroSourceArchive({ ...f.input, sourceText: "another entry" })).rejects.toThrow();
    await writeFile(path.join(f.projectRoot, "assets/lib/example.tsx"), "modified!");
    await expect(importMiroSourceArchive(f.input)).rejects.toThrow();
  });
  it.each([
    "../outside",
    "/absolute",
    "C:/outside",
    "assets\\outside",
    "assets/../outside",
    "assets//outside",
    "node_modules/pkg/index.js",
  ])("rejects unsafe archive path %s", async (unsafe) => {
    const f = await fixture();
    f.archive.files[1].path = unsafe;
    await f.save();
    await expect(importMiroSourceArchive(f.input)).rejects.toThrow("production_source_archive_invalid");
  });
  it("rejects duplicate aliases and missing entry", async () => {
    const f = await fixture();
    f.archive.files[1].path = "ENTRY.TSX";
    await f.save();
    await expect(importMiroSourceArchive(f.input)).rejects.toThrow();
    f.archive.files = [];
    await f.save();
    await expect(importMiroSourceArchive(f.input)).rejects.toThrow();
  });
  it("rejects an incomplete archive that drops an authored dependency", async () => {
    const f = await fixture();
    f.archive.files = f.archive.files.slice(0, 1);
    await f.save();
    await expect(importMiroSourceArchive(f.input)).rejects.toThrow("production_source_archive_invalid");
  });
  it("rejects source symlinks and an existing corrupted immutable object", async () => {
    const f = await fixture();
    const reference = await importMiroSourceArchive(f.input);
    const target = path.join(f.input.storageRoot, reference.storageKey);
    await chmod(target, 0o600);
    await writeFile(target, "corrupted");
    await expect(importMiroSourceArchive(f.input)).rejects.toThrow();
    const actual = path.join(f.projectRoot, "assets/lib");
    const outside = path.join(f.root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "example.tsx"), "export const x = 1;");
    await rm(actual, { recursive: true });
    await symlink(outside, actual, process.platform === "win32" ? "junction" : "dir");
    await expect(importMiroSourceArchive(f.input)).rejects.toThrow("production_source_archive_invalid");
  });
});
