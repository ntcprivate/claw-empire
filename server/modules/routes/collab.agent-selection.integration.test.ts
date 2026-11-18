import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerRoutesPartB } from "./collab.ts";

const noop = () => {};
vi.mock("./collab/language-policy.ts", () => ({
  initializeCollabLanguagePolicy: () => ({
    DEPT_KEYWORDS: {}, pickRandom: () => "en", getPreferredLanguage: () => "en", resolveLang: () => "en",
    detectLang: () => "en", l: () => "", pickL: () => "", getFlairs: () => [], getRoleLabel: () => "",
    classifyIntent: () => "", analyzeDirectivePolicy: () => ({}), shouldExecuteDirectiveDelegation: () => false,
    detectTargetDepartments: () => [],
  }),
}));
vi.mock("./collab/chat-response.ts", () => ({ createChatReplyGenerator: () => ({ generateChatReply: noop }) }));
vi.mock("./collab/announcement-response.ts", () => ({ createAnnouncementReplyScheduler: () => ({ generateAnnouncementReply: noop, scheduleAnnouncementReplies: noop }) }));
vi.mock("./collab/project-resolution.ts", () => ({ initializeProjectResolution: () => ({ normalizeTextField: (value: unknown) => String(value ?? ""), resolveProjectFromOptions: noop, buildRoundGoal: noop }) }));
vi.mock("./collab/subtask-delegation.ts", () => ({ initializeSubtaskDelegation: () => ({
  formatTaskSubtaskProgressSummary: noop, hasOpenForeignSubtasks: noop, processSubtaskDelegations: noop, maybeNotifyAllSubtasksComplete: noop,
}) }));
vi.mock("./collab/coordination.ts", () => ({ initializeCollabCoordination: () => ({
  reconcileCrossDeptSubtasks: noop, recoverCrossDeptQueueAfterMissingCallback: noop, startCrossDeptCooperation: noop,
  detectProjectPath: noop, resolveProjectPath: noop, getLatestKnownProjectPath: noop, getDefaultProjectRoot: noop,
  resolveDirectiveProjectPath: noop, stripReportRequestPrefix: noop, detectReportOutputFormat: noop,
  pickPlanningReportAssignee: noop, handleReportRequest: noop,
}) }));
vi.mock("./collab/task-delegation.ts", () => ({ createTaskDelegationHandler: () => noop }));
vi.mock("./collab/direct-chat.ts", () => ({ createDirectChatHandlers: () => ({ scheduleAgentReply: noop, resetDirectChatState: noop }) }));

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function selectors(db: DatabaseSync) {
  const fallback = () => {};
  const ctx = new Proxy({ db, app: {} }, { get(target, property) {
    if (property in target) return target[property as keyof typeof target];
    return fallback;
  } });
  return registerRoutesPartB(ctx as never);
}

function createDatabase(withPackColumn: boolean): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE agents(
    id TEXT PRIMARY KEY,name TEXT,name_ko TEXT,department_id TEXT,role TEXT,status TEXT,created_at INTEGER,
    acts_as_planning_leader INTEGER DEFAULT 0${withPackColumn ? ",workflow_pack_key TEXT" : ""}
  )`);
  return db;
}

describe("registered collaboration agent selectors honor the Video Production boundary", () => {
  it("keeps studio staff out of unscoped legacy fallbacks while explicit Video Production candidates still resolve", () => {
    const db = createDatabase(true);
    const insert = db.prepare("INSERT INTO agents(id,name,department_id,role,status,created_at,acts_as_planning_leader,workflow_pack_key) VALUES(?,?,?,?,?,?,?,?)");
    insert.run("legacy-operations-lead", "Legacy lead", "operations", "team_leader", "idle", 20, 0, "development");
    insert.run("video_production-seed-5", "Dami", "operations", "team_leader", "idle", 1, 0, "video_production");
    insert.run("legacy-planning-junior", "Legacy junior", "planning", "junior", "idle", 20, 0, "development");
    insert.run("video_production-role-screenwriter", "Haru", "planning", "senior", "idle", 1, 0, "video_production");

    const routes = selectors(db);
    expect(routes.findTeamLeader("operations")?.id).toBe("legacy-operations-lead");
    expect(routes.findBestSubordinate("planning", "legacy-operations-lead")?.id).toBe("legacy-planning-junior");
    expect(routes.findTeamLeader("operations", ["video_production-seed-5"])?.id).toBe("video_production-seed-5");
    expect(routes.findBestSubordinate("planning", "legacy-operations-lead", ["video_production-role-screenwriter"])?.id)
      .toBe("video_production-role-screenwriter");
  });

  it("continues to resolve unscoped legacy candidates on older schemas without workflow_pack_key", () => {
    const db = createDatabase(false);
    db.prepare("INSERT INTO agents(id,name,department_id,role,status,created_at) VALUES(?,?,?,?,?,?)")
      .run("legacy-lead", "Legacy lead", "operations", "team_leader", "idle", 1);
    db.prepare("INSERT INTO agents(id,name,department_id,role,status,created_at) VALUES(?,?,?,?,?,?)")
      .run("legacy-junior", "Legacy junior", "planning", "junior", "idle", 1);
    const routes = selectors(db);
    expect(routes.findTeamLeader("operations")?.id).toBe("legacy-lead");
    expect(routes.findBestSubordinate("planning", "legacy-lead")?.id).toBe("legacy-junior");
  });
});
