import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { registerTaskCrudRoutes } from "./crud.ts";

type RouteHandler = (req: any, res: any) => any;

type FakeResponse = {
  statusCode: number;
  payload: unknown;
  status: (code: number) => FakeResponse;
  json: (body: unknown) => FakeResponse;
};

function createFakeResponse(): FakeResponse {
  return {
    statusCode: 200,
    payload: null,
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

function createTaskCrudHarness(): { db: DatabaseSync; routes: Map<string, RouteHandler> } {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      department_id TEXT,
      assigned_agent_id TEXT,
      project_id TEXT,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      workflow_pack_key TEXT NOT NULL DEFAULT 'development',
      workflow_meta_json TEXT,
      output_format TEXT,
      project_path TEXT,
      base_branch TEXT,
      result TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      source_task_id TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      avatar_emoji TEXT
    );
    CREATE TABLE departments (
      id TEXT PRIMARY KEY,
      name TEXT,
      icon TEXT
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT,
      core_goal TEXT,
      project_path TEXT,
      default_pack_key TEXT NOT NULL DEFAULT 'development',
      last_used_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      delegated_task_id TEXT
    );
  `);

  const routes = new Map<string, RouteHandler>();
  const app = {
    get(path: string, handler: RouteHandler) {
      routes.set(`GET ${path}`, handler);
      return this;
    },
    post(path: string, handler: RouteHandler) {
      routes.set(`POST ${path}`, handler);
      return this;
    },
    patch(path: string, handler: RouteHandler) {
      routes.set(`PATCH ${path}`, handler);
      return this;
    },
    delete(path: string, handler: RouteHandler) {
      routes.set(`DELETE ${path}`, handler);
      return this;
    },
  };

  registerTaskCrudRoutes({
    app: app as any,
    db: db as any,
    nowMs: () => Date.now(),
    firstQueryValue: (value: unknown) => {
      if (typeof value === "string") return value;
      if (Array.isArray(value)) {
        const first = value.find((item) => typeof item === "string");
        return typeof first === "string" ? first : undefined;
      }
      return undefined;
    },
    reconcileCrossDeptSubtasks: () => {},
    normalizeTextField: (raw: unknown) => {
      if (typeof raw !== "string") return null;
      const trimmed = raw.trim();
      return trimmed.length > 0 ? trimmed : null;
    },
    recordTaskCreationAudit: () => {},
    appendTaskLog: () => {},
    broadcast: () => {},
    setTaskCreationAuditCompletion: () => {},
    clearTaskWorkflowState: () => {},
    endTaskExecutionSession: () => {},
    activeProcesses: new Map(),
    stopRequestedTasks: new Set(),
    killPidTree: () => {},
    logsDir: "/tmp",
  });

  return { db, routes };
}

describe("managed video production task policy", () => {
  it.each([
    { workflow_pack_key: "video_production" },
    { workflow_pack_key: "development", workflow_meta_json: { videoProduction: {} } },
    { workflow_pack_key: "development", project_id: "studio" },
  ])("rejects generic creation into production: %j", (body) => {
    const { db, routes } = createTaskCrudHarness();
    try {
      db.prepare(
        "INSERT INTO projects(id, project_path, default_pack_key) VALUES('studio','/studio','video_production')",
      ).run();
      const res = createFakeResponse();
      routes.get("POST /api/tasks")!({ body: { title: "Bypass", ...body } }, res);
      expect(res.statusCode).toBe(409);
      expect(db.prepare("SELECT count(*) AS count FROM tasks").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it.each([
    { workflow_pack_key: "development", workflow_meta_json: null },
    { status: "done" },
    { assigned_agent_id: "other" },
    { project_id: null },
  ])("rejects generic state/identity mutation: %j", (body) => {
    const { db, routes } = createTaskCrudHarness();
    try {
      db.prepare(
        "INSERT INTO tasks(id,title,status,priority,task_type,workflow_pack_key,created_at,updated_at) VALUES('root','Plan','inbox',0,'documentation','video_production',1,1)",
      ).run();
      const res = createFakeResponse();
      routes.get("PATCH /api/tasks/:id")!({ params: { id: "root" }, body }, res);
      expect(res.statusCode).toBe(409);
      expect(db.prepare("SELECT status,workflow_pack_key,assigned_agent_id FROM tasks WHERE id='root'").get()).toEqual({
        status: "inbox",
        workflow_pack_key: "video_production",
        assigned_agent_id: null,
      });
    } finally {
      db.close();
    }
  });

  it("rejects production conversion and deletion through generic routes", () => {
    const { db, routes } = createTaskCrudHarness();
    try {
      db.prepare(
        "INSERT INTO tasks(id,title,status,priority,task_type,workflow_pack_key,created_at,updated_at) VALUES('task','Plan','inbox',0,'general','development',1,1)",
      ).run();
      const convert = createFakeResponse();
      routes.get("PATCH /api/tasks/:id")!(
        { params: { id: "task" }, body: { workflow_pack_key: " video_production " } },
        convert,
      );
      expect(convert.statusCode).toBe(409);
      db.prepare("UPDATE tasks SET workflow_pack_key='video_production' WHERE id='task'").run();
      const remove = createFakeResponse();
      routes.get("DELETE /api/tasks/:id")!({ params: { id: "task" } }, remove);
      expect(remove.statusCode).toBe(409);
      expect(db.prepare("SELECT count(*) AS count FROM tasks").get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });
});

describe("task CRUD workflow pack filter", () => {
  it("GET /api/tasks는 workflow_pack_key 필터를 적용한다", () => {
    const { db, routes } = createTaskCrudHarness();
    try {
      db.prepare(
        `
          INSERT INTO tasks (
            id, title, description, department_id, assigned_agent_id, project_id,
            status, priority, task_type, workflow_pack_key, workflow_meta_json, output_format,
            project_path, base_branch, result, started_at, completed_at, source_task_id, hidden, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        "task-report-1",
        "Report task",
        null,
        null,
        null,
        null,
        "inbox",
        1,
        "general",
        "report",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        0,
        1,
        1,
      );
      db.prepare(
        `
          INSERT INTO tasks (
            id, title, description, department_id, assigned_agent_id, project_id,
            status, priority, task_type, workflow_pack_key, workflow_meta_json, output_format,
            project_path, base_branch, result, started_at, completed_at, source_task_id, hidden, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        "task-dev-1",
        "Dev task",
        null,
        null,
        null,
        null,
        "inbox",
        1,
        "general",
        "development",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        0,
        1,
        1,
      );

      const handler = routes.get("GET /api/tasks");
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.({ query: { workflow_pack_key: "report" } }, res);

      expect(res.statusCode).toBe(200);
      const payload = res.payload as { tasks: Array<{ id: string; workflow_pack_key: string }> };
      expect(payload.tasks).toHaveLength(1);
      expect(payload.tasks[0]).toMatchObject({
        id: "task-report-1",
        workflow_pack_key: "report",
      });
    } finally {
      db.close();
    }
  });

  it("GET /api/tasks는 invalid workflow_pack_key에 400을 반환한다", () => {
    const { db, routes } = createTaskCrudHarness();
    try {
      const handler = routes.get("GET /api/tasks");
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.({ query: { workflow_pack_key: "invalid-pack" } }, res);

      expect(res.statusCode).toBe(400);
      expect(res.payload).toEqual({ error: "invalid_workflow_pack_key" });
    } finally {
      db.close();
    }
  });

  it("POST /api/tasks는 workflow_pack_key 미지정 시 프로젝트 default_pack_key를 상속한다", () => {
    const { db, routes } = createTaskCrudHarness();
    try {
      db.prepare(
        `
          INSERT INTO projects (id, name, core_goal, project_path, default_pack_key)
          VALUES (?, ?, ?, ?, ?)
        `,
      ).run("project-novel", "Novel Project", "goal", "/tmp/novel-project", "novel");

      const handler = routes.get("POST /api/tasks") as RouteHandler | undefined;
      expect(handler).toBeTypeOf("function");

      const res = createFakeResponse();
      handler?.(
        {
          body: {
            title: "Project-default pack task",
            project_id: "project-novel",
          },
        },
        res,
      );

      expect(res.statusCode).toBe(200);
      const payload = res.payload as { task: { workflow_pack_key: string; project_id: string; project_path: string } };
      expect(payload.task.workflow_pack_key).toBe("novel");
      expect(payload.task.project_id).toBe("project-novel");
      expect(payload.task.project_path).toBe("/tmp/novel-project");
    } finally {
      db.close();
    }
  });
});
