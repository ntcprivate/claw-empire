import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMiroWorkerRpc, runMiroAuthoringSession } from "./video-production-miro-session.ts";
import * as rbac from "./video-production-rbac.ts";
import * as broker from "./video-production-provider-broker.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});
function childHarness(reply?: (method: string, params: any) => unknown) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
  }) as unknown as ChildProcess;
  const calls: any[] = [];
  child.stdin!.on("data", (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString());
    calls.push(request);
    if (reply)
      queueMicrotask(() =>
        child.stdout!.emit(
          "data",
          Buffer.from(
            JSON.stringify({ jsonrpc: "2.0", id: request.id, result: reply(request.method, request.params) }) + "\n",
          ),
        ),
      );
  });
  return { child, calls };
}
function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE video_production_attempts(attempt_id TEXT,task_id TEXT,state TEXT,execution_action TEXT,detail_json TEXT,updated_at INTEGER);
    INSERT INTO video_production_attempts VALUES('attempt','task','RUNNING','footage.submit','{}',0);
    CREATE TABLE video_production_stage_jobs(task_id TEXT,project_id TEXT,shot_id TEXT,shot_version INTEGER);
    INSERT INTO video_production_stage_jobs VALUES('task','project','shot',1);
    CREATE TABLE video_productions(project_id TEXT,brief_json TEXT);
    INSERT INTO video_productions VALUES('project','{"title":"Vietnamese demo"}');
    CREATE TABLE video_production_shot_versions(project_id TEXT,shot_id TEXT,version INTEGER,action TEXT,camera_json TEXT);
    INSERT INTO video_production_shot_versions VALUES('project','shot',1,'Open garden','{}');`);
  vi.spyOn(rbac, "createTrustedVideoProductionAttemptActor").mockReturnValue({
    taskId: "task",
    agentId: "miro",
    projectId: "project",
    planVersion: 1,
  } as any);
  vi.spyOn(broker, "getVideoProductionAgentProvider").mockReturnValue({
    provider: { enabled: 1, type: "custom" },
    model: "fixture",
  } as any);
  return db;
}

describe("Miro bounded NDJSON authoring session", () => {
  it("preserves the complete entry skill and valid recent-history JSON after many large reads", async () => {
    const db = fixture();
    const h = childHarness((method, params) =>
      method === "read_file"
        ? { content: params.path.endsWith("SKILL.md") ? "IMMUTABLE_SKILL_ENTRY" : "card".repeat(4000) }
        : { ok: true },
    );
    const actions: unknown[] = [
      ...Array.from({ length: 7 }, (_, index) => ({ tool: "read_file", arguments: { path: `card-${index}.md` } })),
      { tool: "render_video", arguments: {} },
      { done: true },
    ];
    const prompts: string[] = [];
    const requestModel = vi.fn(async (input: Parameters<typeof broker.requestVideoProductionJson>[0]) => {
      prompts.push(input.prompt);
      return actions.shift();
    });
    await runMiroAuthoringSession({ db, taskId: "task", attemptId: "attempt", child: h.child, requestModel });
    for (const prompt of prompts) {
      expect(prompt).toContain("IMMUTABLE_SKILL_ENTRY");
      expect(prompt.length).toBeLessThanOrEqual(64000);
      expect(() => JSON.parse(prompt.split("Recent tool history (old entries compacted): ")[1])).not.toThrow();
    }
    expect(JSON.parse(prompts[7].split("Recent tool history (old entries compacted): ")[1])).toHaveLength(1);
  });

  it("aborts a provider request when the owning worker closes", async () => {
    const db = fixture();
    const h = childHarness(() => ({ content: "skill" }));
    let observed: AbortSignal | undefined;
    const requestModel = vi.fn(async (input: Parameters<typeof broker.requestVideoProductionJson>[0]) => {
      observed = input.signal;
      return new Promise((_resolve, reject) => {
        input.signal!.addEventListener("abort", () => reject(new Error("provider aborted")), { once: true });
        queueMicrotask(() => h.child.emit("close", 2));
      });
    });
    await expect(
      runMiroAuthoringSession({ db, taskId: "task", attemptId: "attempt", child: h.child, requestModel }),
    ).rejects.toThrow("provider aborted");
    expect(observed?.aborted).toBe(true);
    expect(h.calls.map((call) => call.method)).toEqual(["read_file"]);
  });

  it("reads isolated skills then writes, sees preview and renders through multiple provider turns", async () => {
    const db = fixture();
    const transport = childHarness((method) =>
      method === "read_file"
        ? { content: "Read selected shot cards before authoring." }
        : method === "render_still"
          ? { image: "YQ==", mimeType: "image/png" }
          : { ok: true },
    );
    const actions = [
      { tool: "read_file", arguments: { path: "/opt/skills/video-shotcraft/references/shots/card.md" } },
      { tool: "write_file", arguments: { path: "entry.tsx", content: "export const shot = 1;" } },
      { tool: "typecheck", arguments: {} },
      { tool: "render_still", arguments: { frame: 12 } },
      { tool: "render_video", arguments: {} },
      { done: true },
    ];
    const requestModel = vi.fn(async (_input: Parameters<typeof broker.requestVideoProductionJson>[0]) =>
      actions.shift(),
    );
    const result = await runMiroAuthoringSession({
      db,
      taskId: "task",
      attemptId: "attempt",
      child: transport.child,
      requestModel: requestModel as any,
    });
    expect(result.turns).toBe(6);
    expect(transport.calls.map((call) => call.method)).toEqual([
      "read_file",
      "read_file",
      "write_file",
      "typecheck",
      "render_still",
      "render_video",
      "finish",
    ]);
    expect(requestModel.mock.calls[4][0]).toMatchObject({
      images: [{ data: "YQ==", mimeType: "image/png" }],
      timeoutMs: 120000,
      authoring: true,
    });
    expect(
      db.prepare("SELECT json_extract(detail_json,'$.authoringTurns') AS turns FROM video_production_attempts").get(),
    ).toEqual({ turns: 6 });
  });

  it("does not replay an interrupted authoring session or call a paid model", async () => {
    const db = fixture();
    db.exec("UPDATE video_production_attempts SET detail_json='{\"authoringTurns\":3}'");
    const transport = childHarness(() => ({ ok: true }));
    const requestModel = vi.fn();
    await expect(
      runMiroAuthoringSession({ db, taskId: "task", attemptId: "attempt", child: transport.child, requestModel }),
    ).rejects.toThrow("already_started");
    expect(requestModel).not.toHaveBeenCalled();
    expect(transport.calls).toHaveLength(0);
  });

  it("bounds the authoring loop to 25 model turns and never sends finish without completion", async () => {
    const db = fixture();
    const transport = childHarness(() => ({ content: "skill" }));
    const requestModel = vi.fn(async () => ({ tool: "list_files", arguments: {} }));
    await expect(
      runMiroAuthoringSession({ db, taskId: "task", attemptId: "attempt", child: transport.child, requestModel }),
    ).rejects.toThrow("turn_limit");
    expect(requestModel).toHaveBeenCalledTimes(25);
    expect(transport.calls).toHaveLength(25);
    expect(transport.calls.some((call) => call.method === "finish")).toBe(false);
  });

  it("requires a successful render and rejects unsupported tools", async () => {
    for (const action of [{ done: true }, { tool: "generate_video", arguments: {} }]) {
      const db = fixture();
      const transport = childHarness(() => ({ content: "skill" }));
      await expect(
        runMiroAuthoringSession({
          db,
          taskId: "task",
          attemptId: "attempt",
          child: transport.child,
          requestModel: vi.fn(async () => action),
        }),
      ).rejects.toThrow(/render_required|tool_invalid/);
      expect(transport.calls.map((call) => call.method)).toEqual(["read_file"]);
    }
  });

  it("returns correctable tool errors to the model rather than claiming successful rendering", async () => {
    const db = fixture();
    const transport = childHarness((method) =>
      method === "read_file" ? { content: "skill" } : { error: { message: "typecheck failed" } },
    );
    const actions = [{ tool: "render_video", arguments: {} }, { done: true }];
    await expect(
      runMiroAuthoringSession({
        db,
        taskId: "task",
        attemptId: "attempt",
        child: transport.child,
        requestModel: vi.fn(async () => actions.shift()),
      }),
    ).rejects.toThrow("render_required");
  });

  it("rechecks ownership after every model response before invoking any tool", async () => {
    const db = fixture();
    const transport = childHarness(() => ({ content: "skill" }));
    const requestModel = vi.fn(async () => {
      vi.mocked(rbac.createTrustedVideoProductionAttemptActor).mockImplementation(() => {
        throw new Error("revoked");
      });
      return { tool: "write_file", arguments: { path: "entry.tsx", content: "late" } };
    });
    await expect(
      runMiroAuthoringSession({ db, taskId: "task", attemptId: "attempt", child: transport.child, requestModel }),
    ).rejects.toThrow("revoked");
    expect(transport.calls).toHaveLength(1);
  });

  it("matches fragmented NDJSON responses and rejects wrong IDs", async () => {
    const h = childHarness();
    const controller = new AbortController();
    const rpc = createMiroWorkerRpc(h.child, controller.signal);
    const first = rpc.call("read_file", { path: "entry.tsx" });
    h.child.stdout!.emit("data", Buffer.from('{"jsonrpc":"2.0","id":"1","res'));
    h.child.stdout!.emit("data", Buffer.from('ult":{"content":"Đẹp"}}\n'));
    await expect(first).resolves.toEqual({ content: "Đẹp" });
    const second = rpc.call("read_file");
    h.child.stdout!.emit("data", Buffer.from('{"jsonrpc":"2.0","id":"99","result":{}}\n'));
    await expect(second).rejects.toThrow("id_mismatch");
    rpc.dispose();
  });

  it("aborts a pending worker request without killing a possibly live container", async () => {
    const h = childHarness();
    const controller = new AbortController();
    const rpc = createMiroWorkerRpc(h.child, controller.signal);
    const request = rpc.call("render_video");
    controller.abort();
    await expect(request).rejects.toThrow("cancelled");
    rpc.dispose();
  });
});
