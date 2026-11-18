import { workerPaths, compositorPackageName, mediaBinary, scrubWorkerEnv } from "./worker-platform.mjs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile, readdir, lstat, realpath, cp, symlink, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

export const SHOTCRAFT_COMMIT = "55eb60d155d703b0267a46a0507f6e268a053ad1";
export const AUTHOR_TOOLS = [
  "list_files",
  "read_file",
  "search_files",
  "write_file",
  "apply_patch",
  "typecheck",
  "render_still",
  "render_video",
  "inspect_media",
];
const MAX_FILE = 8 * 1024 * 1024;
const hash = (data) => createHash("sha256").update(data).digest("hex");

export function boundedLines(stream, maxBytes = 16 * 1024 * 1024) {
  return (async function* () {
    let pending = Buffer.alloc(0);
    for await (const chunk of stream) {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      let index;
      while ((index = pending.indexOf(10)) >= 0) {
        if (index > maxBytes) throw new Error("rpc_line_too_large");
        const line = pending.subarray(0, index).toString("utf8").trim();
        pending = pending.subarray(index + 1);
        if (line) yield line;
      }
      if (pending.length > maxBytes) throw new Error("rpc_line_too_large");
    }
    if (pending.length) yield pending.toString("utf8");
  })();
}

export async function safePath(root, name, write = false) {
  if (typeof name !== "string" || name.length > 1024 || name.includes("\0") || name.includes("\\"))
    throw new Error("path_invalid");
  const canonicalRoot = await realpath(root);
  const target = path.resolve(canonicalRoot, name);
  const relative = path.relative(canonicalRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("path_outside_scope");
  let cursor = canonicalRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    if (part === "node_modules" || part.startsWith(".")) throw new Error("path_reserved");
    cursor = path.join(cursor, part);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error("path_symlink_rejected");
    } catch (error) {
      if (error.code !== "ENOENT" || !write) throw error;
    }
  }
  return target;
}

async function command(executable, args, cwd, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: scrubWorkerEnv(process.env),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("tool_timeout"));
    }, timeout);
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        output += chunk.toString("utf8");
        if (Buffer.byteLength(output) > 128 * 1024) {
          clearTimeout(timer);
          child.kill("SIGKILL");
          reject(new Error("tool_output_too_large"));
        }
      });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, exitCode: code, output });
    });
  });
}

async function walk(root, directory = root, files = []) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name === "node_modules" || item.name.startsWith(".")) continue;
    const full = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error("path_symlink_rejected");
    if (item.isDirectory()) await walk(root, full, files);
    else if (item.isFile()) files.push(path.relative(root, full).replaceAll("\\", "/"));
    if (files.length > 1000) throw new Error("project_too_many_files");
  }
  return files;
}

export async function createAuthoringTools(request, options = {}) {
  const workspace = options.workspace ?? workerPaths.workspace;
  const skillRoot = options.skillRoot ?? workerPaths.skillRoot;
  const dependencies = options.dependencies ?? workerPaths.dependencies;
  const shotHash = hash(`${request.shot.shotId}:v${request.shot.shotVersion}`).slice(0, 24);
  const rootName = `render-${shotHash}`;
  const projectRoot = path.join(workspace, rootName);
  const outputRoot = path.join(workspace, "output");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(path.join(projectRoot, "public"), { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  // Reject symlinks before copying; only immutable, reviewed image content is staged.
  for (const source of ["assets/lib", "demos/_fixtures"]) {
    await walk(path.join(skillRoot, source));
    await cp(path.join(skillRoot, source), path.join(projectRoot, source), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  await symlink(dependencies, path.join(projectRoot, "node_modules"), "junction");
  let referenceImage = null;
  if (request.referenceImage) {
    const image = request.referenceImage;
    const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[image.contentType];
    if (!ext || typeof image.base64 !== "string" || image.base64.length > 12 * 1024 * 1024)
      throw new Error("reference_image_invalid");
    const bytes = Buffer.from(image.base64, "base64");
    if (bytes.toString("base64") !== image.base64) throw new Error("reference_image_encoding_invalid");
    referenceImage = `reference.${ext}`;
    await writeFile(path.join(projectRoot, "public", referenceImage), bytes, { flag: "wx" });
  }
  await writeFile(path.join(projectRoot, "data.json"), JSON.stringify({ ...request, referenceImage }), { flag: "wx" });
  await writeFile(path.join(projectRoot, "approved-shot.json"), JSON.stringify(request.shot), { flag: "wx" });
  await writeFile(
    path.join(projectRoot, "package.json"),
    JSON.stringify(
      {
        name: "claw-authored-shot",
        version: "1.0.0",
        private: true,
        scripts: { render: "remotion render entry.tsx ProductionShot" },
        dependencies: {
          "@remotion/cli": "4.0.429",
          remotion: "4.0.429",
          react: "19.2.0",
          "react-dom": "19.2.0",
          typescript: "5.9.3",
          "@types/react": "19.2.0",
          three: "0.180.0",
          "@types/three": "0.180.0",
          "@react-three/fiber": "9.4.0",
          "@remotion/three": "4.0.429",
          "@remotion/motion-blur": "4.0.429",
          zod: "4.3.6",
        },
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  const resolver = workerPaths.host
    ? createRequire(createRequire(workerPaths.moduleAnchor).resolve("@remotion/cli/package.json"))
    : createRequire(path.join(dependencies, "@remotion/cli/package.json"));
  let lastRender = null;
  let checkedDigest = null;
  let previewCount = 0;
  const projectDigest = async () => {
    const files = await walk(projectRoot);
    const digests = [];
    for (const name of files.sort()) {
      const bytes = await readFile(await safePath(projectRoot, name));
      if (bytes.length > MAX_FILE) throw new Error("file_too_large");
      digests.push(`${name}:${hash(bytes)}`);
    }
    return hash(digests.join("\n"));
  };
  const resolveRead = async (name) => {
    if (typeof name === "string" && name.startsWith("/opt/skills/video-shotcraft/"))
      name = path.join(skillRoot, name.slice("/opt/skills/video-shotcraft/".length));
    if (
      typeof name === "string" &&
      path.isAbsolute(name) &&
      (name === skillRoot || name.startsWith(skillRoot + path.sep))
    )
      return safePath(skillRoot, path.relative(skillRoot, name).split(path.sep).join("/"));
    return safePath(projectRoot, name ?? ".");
  };
  const readText = async (full) => {
    const info = await lstat(full);
    if (!info.isFile() || info.size > MAX_FILE) throw new Error("file_too_large_or_invalid");
    return readFile(full, "utf8");
  };
  async function render(still, params) {
    if (checkedDigest !== (await projectDigest())) throw new Error("typecheck_required_after_source_change");
    const entry = await safePath(projectRoot, "entry.tsx");
    const { bundle } = resolver("@remotion/bundler");
    const { selectComposition, renderStill, renderMedia } = resolver("@remotion/renderer");
    const binariesDirectory = path.dirname(resolver.resolve(compositorPackageName() + "/package.json"));
    const serveUrl = await bundle({
      entryPoint: entry,
      publicDir: path.join(projectRoot, "public"),
      onProgress: () => {},
      webpackOverride: (config) => {
        config.resolve = { ...config.resolve, modules: ["node_modules", dependencies] };
        return config;
      },
    });
    try {
      const browserExecutable = workerPaths.browser;
      const composition = await selectComposition({ serveUrl, id: "ProductionShot", browserExecutable });
      if (
        composition.width !== request.width ||
        composition.height !== request.height ||
        composition.fps !== request.fps ||
        composition.durationInFrames !== request.shot.durationFrames
      )
        throw new Error("composition_does_not_match_approved_shot");
      if (still) {
        const frame = params.frame ?? Math.floor(request.shot.durationFrames / 2);
        if (!Number.isSafeInteger(frame) || frame < 0 || frame >= request.shot.durationFrames)
          throw new Error("frame_invalid");
        const location = path.join(outputRoot, `preview-${previewCount + 1}.jpg`);
        await renderStill({
          serveUrl,
          composition,
          frame,
          output: location,
          browserExecutable,
          imageFormat: "jpeg",
          jpegQuality: 65,
          scale: 0.5,
        });
        const bytes = await readFile(location);
        if (bytes.length > 500_000) throw new Error("preview_too_large");
        previewCount++;
        return {
          path: path.relative(workspace, location),
          image: bytes.toString("base64"),
          mimeType: "image/jpeg",
          frame,
        };
      }
      if (!previewCount) throw new Error("preview_required_before_final_render");
      const location = path.join(outputRoot, `shot-${shotHash}.mp4`);
      await rm(location, { force: true });
      await renderMedia({
        serveUrl,
        composition,
        codec: "h264",
        outputLocation: location,
        browserExecutable,
        binariesDirectory,
        concurrency: 2,
        licenseKey: null,
      });
      const bytes = await readFile(location);
      if (bytes.length > 256 * 1024 * 1024) throw new Error("render_too_large");
      lastRender = {
        digest: await projectDigest(),
        output: `output/shot-${shotHash}.mp4`,
        sha256: hash(bytes),
        byteSize: bytes.length,
      };
      return { output: lastRender.output, sha256: lastRender.sha256, byteSize: lastRender.byteSize };
    } finally {
      await rm(serveUrl, { recursive: true, force: true });
    }
  }
  const tools = {
    async list_files(params) {
      const full = await resolveRead(params.path);
      const items = await readdir(full, { withFileTypes: true });
      return {
        files: items
          .filter((x) => x.name !== "node_modules" && !x.name.startsWith("."))
          .slice(0, 500)
          .map((x) => ({ name: x.name, type: x.isDirectory() ? "directory" : x.isFile() ? "file" : "unsupported" })),
      };
    },
    async read_file(params) {
      const content = await readText(await resolveRead(params.path));
      const offset = params.offset ?? 0;
      const limit = params.limit ?? 20_000;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > content.length ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 20_000
      )
        throw new Error("read_range_invalid");
      const end = offset + limit;
      return { content: content.slice(offset, end), ...(end < content.length ? { nextOffset: end } : {}) };
    },
    async search_files(params) {
      if (typeof params.query !== "string" || !params.query || params.query.length > 200)
        throw new Error("query_invalid");
      const full = await resolveRead(params.path);
      const names = await walk(full);
      const matches = [];
      for (const name of names) {
        const info = await lstat(path.join(full, name));
        if (info.size > MAX_FILE || !/\.(?:md|tsx?|jsx?|json|css|txt)$/i.test(name)) continue;
        const content = await readFile(path.join(full, name), "utf8");
        for (const [index, line] of content.split("\n").entries())
          if (line.includes(params.query)) {
            matches.push({ path: name, line: index + 1, text: line.slice(0, 500) });
            if (matches.length >= 100) return { matches, truncated: true };
          }
      }
      return { matches };
    },
    async write_file(params) {
      if (typeof params.content !== "string" || Buffer.byteLength(params.content) > MAX_FILE)
        throw new Error("file_too_large_or_invalid");
      if (
        params.path === "data.json" ||
        ["data.json", "approved-shot.json", "package.json"].includes(path.basename(String(params.path)))
      )
        throw new Error("approved_spec_read_only");
      const target = await safePath(projectRoot, params.path, true);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, params.content);
      lastRender = null;
      checkedDigest = null;
      previewCount = 0;
      return { written: params.path };
    },
    async apply_patch(params) {
      if (typeof params.oldText !== "string" || !params.oldText || typeof params.newText !== "string")
        throw new Error("patch_invalid");
      const target = await safePath(projectRoot, params.path);
      const original = await readText(target);
      if (original.split(params.oldText).length !== 2) throw new Error("patch_match_not_unique");
      return tools.write_file({ path: params.path, content: original.replace(params.oldText, params.newText) });
    },
    async typecheck() {
      const config = path.join(projectRoot, ".authoring-tsconfig.json");
      await writeFile(
        config,
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            jsx: "react-jsx",
            esModuleInterop: true,
            resolveJsonModule: true,
            skipLibCheck: true,
            noEmit: true,
            strict: true,
            types: ["react"],
            typeRoots: [path.join(dependencies, "@types")],
          },
          files: [path.join(projectRoot, "entry.tsx")],
        }),
      );
      const result = await command(
        process.execPath,
        [path.join(dependencies, "typescript/bin/tsc"), "--project", config],
        projectRoot,
      );
      checkedDigest = result.ok ? await projectDigest() : null;
      return result;
    },
    async render_still(params) {
      return render(true, params);
    },
    async render_video(params) {
      return render(false, params);
    },
    async inspect_media(params) {
      let file;
      if (!params.path || params.path === `output/shot-${shotHash}.mp4`)
        file = path.join(outputRoot, `shot-${shotHash}.mp4`);
      else file = await resolveRead(params.path);
      const bin = path.join(
        path.dirname(resolver.resolve(compositorPackageName() + "/package.json")),
        mediaBinary("ffprobe"),
      );
      return command(bin, ["-v", "error", "-show_format", "-show_streams", "-of", "json", file], projectRoot);
    },
  };
  async function finish() {
    if (!lastRender || lastRender.digest !== (await projectDigest())) throw new Error("validated_render_required");
    const outputBytes = await readFile(path.join(workspace, lastRender.output));
    if (hash(outputBytes) !== lastRender.sha256) throw new Error("render_changed");
    const files = [];
    for (const name of (await walk(projectRoot)).sort()) {
      const bytes = await readFile(await safePath(projectRoot, name));
      if (bytes.length > MAX_FILE) throw new Error("file_too_large");
      files.push({
        path: name,
        encoding: "base64",
        content: bytes.toString("base64"),
        sha256: hash(bytes),
        byteSize: bytes.length,
      });
    }
    const archive = Buffer.from(
      JSON.stringify({
        protocol: "claw-video-project-source-v1",
        attemptId: request.attemptId,
        shotId: request.shot.shotId,
        shotVersion: request.shot.shotVersion,
        entryPoint: "entry.tsx",
        skillCommit: SHOTCRAFT_COMMIT,
        files,
      }),
    );
    if (archive.length > 32 * 1024 * 1024) throw new Error("source_archive_too_large");
    await writeFile(path.join(outputRoot, "project-source.json"), archive, { flag: "wx" });
    const { digest, ...media } = lastRender;
    const result = {
      protocol: "claw-video-worker-v1",
      ok: true,
      operation: "author-shot",
      attemptId: request.attemptId,
      shotId: request.shot.shotId,
      shotVersion: request.shot.shotVersion,
      ...media,
      sourceOutput: `${rootName}/entry.tsx`,
      sourceArchiveOutput: "output/project-source.json",
      sourceArchiveSha256: hash(archive),
      sourceArchiveBytes: archive.length,
    };
    await writeFile(path.join(outputRoot, "result.json"), JSON.stringify(result), { flag: "wx" });
    return result;
  }
  return { tools, finish, projectRoot, skillRoot, referenceImage };
}

export async function runAuthoringSession(request, lines, output, options = {}) {
  const session = await createAuthoringTools(request, options);
  output({
    jsonrpc: "2.0",
    method: "ready",
    params: {
      projectRoot: session.projectRoot,
      skillRoot: session.skillRoot,
      referenceImage: session.referenceImage,
      tools: AUTHOR_TOOLS,
      maxTurns: 25,
    },
  });
  let turns = 0;
  const ids = new Set();
  for await (const line of lines) {
    let rpc;
    try {
      rpc = JSON.parse(line);
      if (
        rpc.jsonrpc !== "2.0" ||
        typeof rpc.id !== "string" ||
        rpc.id.length > 128 ||
        ids.has(rpc.id) ||
        typeof rpc.method !== "string" ||
        !rpc.params ||
        typeof rpc.params !== "object" ||
        Array.isArray(rpc.params)
      )
        throw new Error("rpc_invalid");
      ids.add(rpc.id);
      if (rpc.method === "finish") {
        const result = await session.finish();
        output({ jsonrpc: "2.0", id: rpc.id, result });
        return result;
      }
      if (++turns > 25) throw new Error("authoring_turn_limit");
      if (!AUTHOR_TOOLS.includes(rpc.method)) throw new Error("tool_not_allowed");
      const result = await session.tools[rpc.method](rpc.params);
      if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw new Error("tool_response_too_large");
      output({ jsonrpc: "2.0", id: rpc.id, result });
    } catch (error) {
      output({ jsonrpc: "2.0", id: rpc?.id ?? null, error: { code: -32000, message: error.message } });
      if (turns > 25) throw error;
    }
  }
  throw new Error("authoring_session_incomplete");
}
