import { expect, it, vi } from "vitest";
import { createSubtaskRoutingTools } from "./subtask-routing.ts";

vi.mock("../../routes/core/tasks/execution-run-auto-assign.ts", () => ({
  resolveConstrainedAgentScopeForTask: () => null,
}));

it("keeps the voiceover, render, and audio QA routes fixed during planning reroutes", async () => {
  const task = { title: "History video", department_id: "planning", workflow_pack_key: "video_preprod" };
  const subtasks = [
    { id: "voice", title: "[VIDEO_VOICEOVER] Narration", status: "blocked", target_department_id: "voice_audio" },
    { id: "render", title: "[VIDEO_FINAL_RENDER] Render", status: "blocked", target_department_id: "dev" },
    { id: "qa", title: "[VIDEO_AUDIO_QA] Sync verification", status: "blocked", target_department_id: "qa" },
    { id: "design", title: "Find licensed illustrations", status: "pending", target_department_id: null },
  ];
  const run = vi.fn();
  const db = {
    prepare(sql: string) {
      return {
        get: () => task,
        all: () => (sql.includes("FROM subtasks") ? subtasks : [{ id: "design", name: "Design", name_ko: "" }]),
        run,
      };
    },
  };
  const runAgentOneShot = vi.fn(async (_agent: unknown, _prompt: string) => ({
    text: JSON.stringify({
      assignments: subtasks.map(({ id }) => ({
        subtask_id: id,
        target_department_id: id === "design" ? "design" : null,
      })),
    }),
  }));
  const routing = createSubtaskRoutingTools({
    db,
    DEPT_KEYWORDS: {},
    detectTargetDepartments: () => [],
    runAgentOneShot,
    resolveProjectPath: () => process.cwd(),
    resolveLang: () => "en",
    findTeamLeader: (department) => ({ id: `${department}-leader` }),
    getDeptName: () => "Design",
    pickL: (choices) => choices[0],
    l: (_ko, en) => en,
    broadcast: vi.fn(),
    appendTaskLog: vi.fn(),
    notifyCeo: vi.fn(),
  });

  await routing.rerouteSubtasksByPlanningLeader("video", "planning", "planned");

  expect(runAgentOneShot).toHaveBeenCalledOnce();
  const [, prompt] = runAgentOneShot.mock.calls[0];
  expect(prompt).toContain("Find licensed illustrations");
  expect(prompt).not.toMatch(/\[VIDEO_/);
  expect(run).toHaveBeenCalledExactlyOnceWith(
    "design",
    "blocked",
    "Waiting for Design collaboration",
    "design-leader",
    "design",
  );
});
