import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import os from "node:os";
import { boundedLines, safePath, createAuthoringTools, runAuthoringSession } from "./authoring-tools.mjs";

async function fixture(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claw-tools-"));
  try {
    const workspace = path.join(root, "workspace"),
      skillRoot = path.join(root, "skill"),
      dependencies = path.join(root, "dependencies");
    for (const directory of [
      workspace,
      dependencies,
      path.join(skillRoot, "assets/lib"),
      path.join(skillRoot, "demos/_fixtures"),
    ])
      await mkdir(directory, { recursive: true });
    await writeFile(path.join(skillRoot, "SKILL.md"), "Read me");
    await writeFile(path.join(skillRoot, "assets/lib/helper.ts"), "export const staged = true;");
    await writeFile(path.join(skillRoot, "demos/_fixtures/fixture.ts"), "export const fixture = true;");
    const request = {
      protocol: "claw-video-worker-v1",
      operation: "author-shot",
      attemptId: "b1d6ac07-27be-4bd2-8eca-36a199428d88",
      shot: { shotId: "fixture", shotVersion: 1, durationFrames: 30 },
      fps: 30,
      width: 1280,
      height: 720,
    };
    await fn({ root, request, options: { workspace, skillRoot, dependencies } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("NDJSON handles chunk boundaries, multiple requests and oversized lines", async () => {
  const lines = [];
  for await (const line of boundedLines(Readable.from(['{"id":', '1}\n{"id":2}\n']))) lines.push(JSON.parse(line));
  assert.deepEqual(lines, [{ id: 1 }, { id: 2 }]);
  await assert.rejects(async () => {
    for await (const line of boundedLines(Readable.from(["123456\n"]), 5)) void line;
  }, /too_large/);
});
test("path fence rejects traversal and symlinks", () =>
  fixture(async ({ root }) => {
    await assert.rejects(safePath(root, "../secret"), /outside_scope/);
    await symlink(os.tmpdir(), path.join(root, "escape"), "junction");
    await assert.rejects(safePath(root, "escape/anything", true), /symlink/);
    await assert.rejects(safePath(root, "node_modules/evil", true), /reserved/);
  }));
test("stages reusable libraries and permits confined exact patches only", () =>
  fixture(async ({ request, options }) => {
    const session = await createAuthoringTools(request, options);
    assert.match(await readFile(path.join(session.projectRoot, "assets/lib/helper.ts"), "utf8"), /staged/);
    assert.match(await readFile(path.join(session.projectRoot, "demos/_fixtures/fixture.ts"), "utf8"), /fixture/);
    await session.tools.write_file({ path: "entry.tsx", content: "one two" });
    await session.tools.apply_patch({ path: "entry.tsx", oldText: "two", newText: "three" });
    assert.deepEqual(await session.tools.read_file({ path: "entry.tsx" }), { content: "one three" });
    assert.deepEqual(await session.tools.read_file({ path: "entry.tsx", limit: 4 }), {
      content: "one ",
      nextOffset: 4,
    });
    assert.deepEqual(await session.tools.read_file({ path: "entry.tsx", offset: 4 }), { content: "three" });
    await assert.rejects(session.tools.write_file({ path: "../escape", content: "bad" }), /outside_scope/);
    await assert.rejects(session.tools.write_file({ path: "data.json", content: "bad" }), /read_only/);
    await assert.rejects(session.tools.write_file({ path: "approved-shot.json", content: "bad" }), /read_only/);
    await assert.rejects(
      session.tools.apply_patch({ path: "entry.tsx", oldText: "missing", newText: "bad" }),
      /not_unique/,
    );
    await assert.rejects(session.finish(), /validated_render_required/);
    assert.equal(
      (await session.tools.search_files({ path: ".", query: "staged" })).matches[0].path,
      "assets/lib/helper.ts",
    );
  }));
test("RPC errors are correlated, duplicate ids rejected, and incomplete sessions fail closed", () =>
  fixture(async ({ request, options }) => {
    const messages = [];
    const calls = [
      { jsonrpc: "2.0", id: "1", method: "read_file", params: { path: "data.json" } },
      { jsonrpc: "2.0", id: "1", method: "write_file", params: { path: "bad", content: "bad" } },
      { jsonrpc: "2.0", id: "2", method: "exec", params: {} },
      { jsonrpc: "2.0", id: "3", method: "finish", params: {} },
    ];
    await assert.rejects(
      runAuthoringSession(
        request,
        Readable.from(calls.map((x) => JSON.stringify(x))),
        (x) => messages.push(x),
        options,
      ),
      /session_incomplete/,
    );
    assert.equal(messages[0].method, "ready");
    assert.match(messages[1].result.content, /fixture/);
    assert.match(messages[2].error.message, /rpc_invalid/);
    assert.match(messages[3].error.message, /tool_not_allowed/);
    assert.match(messages[4].error.message, /validated_render_required/);
  }));
test("RPC stops at bounded 25 tool calls", () =>
  fixture(async ({ request, options }) => {
    const messages = [];
    const calls = Array.from({ length: 26 }, (_, id) =>
      JSON.stringify({ jsonrpc: "2.0", id: String(id), method: "list_files", params: { path: "." } }),
    );
    await assert.rejects(
      runAuthoringSession(request, Readable.from(calls), (x) => messages.push(x), options),
      /turn_limit/,
    );
    assert.equal(messages.length, 27);
    assert.match(messages.at(-1).error.message, /turn_limit/);
  }));
