import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTaskRunRoute } from "./execution-run.ts";
import { registerTaskSubtaskRoutes } from "./subtasks.ts";
import { registerTaskExecutionControlRoutes } from "./execution-control.ts";
import { registerAgentSpawnRoute } from "../agents/spawn.ts";
import { createExecutionStartTaskTools } from "../../../workflow/orchestration/execution-start-task.ts";
import { registerVideoProductionRoutes } from "../video-production.ts";

type Handler = (req: any, res: any) => unknown;
const openDatabases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close();
});

function harness() {
  const db = new DatabaseSync(":memory:");
  openDatabases.push(db);
  db.exec(`
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,status TEXT,workflow_pack_key TEXT,workflow_meta_json TEXT,project_id TEXT);
    INSERT INTO tasks VALUES('root','Production plan','inbox','video_production',NULL,NULL);
    CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,cli_provider TEXT,department_id TEXT,current_task_id TEXT,status TEXT);
    INSERT INTO agents VALUES('dami','Dami','codex','planning','root','idle');
    CREATE TABLE departments(id TEXT PRIMARY KEY,name TEXT,prompt TEXT);
  `);
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, handler: Handler) => routes.set(`GET ${path}`, handler),
    post: (path: string, handler: Handler) => routes.set(`POST ${path}`, handler),
    put: (path: string, handler: Handler) => routes.set(`PUT ${path}`, handler),
    patch: (path: string, handler: Handler) => routes.set(`PATCH ${path}`, handler),
    delete: (path: string, handler: Handler) => routes.set(`DELETE ${path}`, handler),
  };
  const launch = vi.fn(() => {
    throw new Error("External launch must never be reached");
  });
  const log = vi.fn();
  const deps = {
    app,
    db,
    resolveLang: () => "en",
    appendTaskLog: log,
    spawnCliAgent: launch,
    launchApiProviderAgent: launch,
    launchHttpAgent: launch,
    createWorktree: launch,
  };
  return { db, routes, deps, launch, log };
}

function response() {
  return {
    statusCode: 200,
    payload: null as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };
}

describe("video production execution admission", () => {
  it("requires a CEO session before production /run admission or side effects", () => {
    const h = harness();
    registerTaskRunRoute(h.deps as any);
    const res = response();
    h.routes.get("POST /api/tasks/:id/run")!({ params: { id: "root" }, body: {}, method: "POST", header: () => undefined }, res);
    expect(res.statusCode).toBe(401);
    expect(res.payload.error).toBe("unauthorized");
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.db.prepare("SELECT status FROM tasks WHERE id='root'").get()).toEqual({ status: "inbox" });
  });

  it("requires a CEO session before production cancellation controls", () => {
    const h = harness();
    registerVideoProductionRoutes(h.deps as any);
    const res = response();
    h.routes.get("POST /api/tasks/:id/video-production/cancel")!({
      params: { id: "root" }, body: { attempt_id: "attempt" }, method: "POST", header: () => undefined,
    }, res);
    expect(res.statusCode).toBe(401);
    expect(res.payload.error).toBe("unauthorized");
  });

  it("blocks internal execution callbacks before task/agent state mutation", () => {
    const h = harness();
    const start = createExecutionStartTaskTools(h.deps as any).startTaskExecutionForAgent;
    expect(() => start("root", { id: "dami", name: "Dami" }, "planning", "Production Management")).not.toThrow();
    expect(h.log).toHaveBeenCalledWith("root", "system", expect.stringContaining("video_production_not_registered"));
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.db.prepare("SELECT status FROM agents WHERE id='dami'").get()).toEqual({ status: "idle" });
  });

  it("blocks raw agent spawn before launching a managed task", () => {
    const h = harness();
    registerAgentSpawnRoute(h.deps as any);
    const res = response();
    h.routes.get("POST /api/agents/:id/spawn")!({ params: { id: "dami" }, body: {} }, res);
    expect(res.statusCode).toBe(409);
    expect(res.payload.error).toBe("video_production_not_registered");
    expect(h.launch).not.toHaveBeenCalled();
  });

  it.each([
    "POST /api/tasks/:id/assign",
    "POST /api/tasks/:id/subtasks",
    "POST /api/tasks/:id/stop",
    "POST /api/tasks/:id/resume",
  ])("blocks generic production mutation via %s", (route) => {
    const h = harness();
    registerTaskSubtaskRoutes(h.deps as any);
    registerTaskExecutionControlRoutes(h.deps as any);
    const res = response();
    h.routes.get(route)!({ params: { id: "root" }, body: { agent_id: "other", title: "Injected" } }, res);
    expect(res.statusCode).toBe(409);
    expect(res.payload.error).toBe("video_production_managed_task");
    expect(h.launch).not.toHaveBeenCalled();
  });
});
