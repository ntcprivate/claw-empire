import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Task } from "../../types";
import TaskCard from "./TaskCard";

vi.mock("../../i18n", () => ({
  useI18n: () => ({ t: (text: { en: string }) => text.en, language: "en", locale: "en-US" }),
}));
vi.mock("../AgentSelect", () => ({ default: () => null }));

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "production-root",
    title: "Launch video",
    description: null,
    department_id: "operations",
    assigned_agent_id: "dami",
    status: "inbox",
    priority: 1,
    task_type: "general",
    workflow_pack_key: "video_production",
    project_path: null,
    result: null,
    started_at: null,
    completed_at: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    workflow_meta_json: JSON.stringify({
      videoProduction: { stage: "intake_planning", state: "WAITING_FOR_APPROVAL", planVersion: 1 },
    }),
    ...overrides,
  };
}

function renderTask(value: Task) {
  return render(
    <TaskCard
      task={value}
      agents={[]}
      departments={[]}
      taskSubtasks={[]}
      onUpdateTask={vi.fn()}
      onDeleteTask={vi.fn()}
      onAssignTask={vi.fn()}
      onRunTask={vi.fn()}
      onStopTask={vi.fn()}
    />,
  );
}

describe("production task approval badge", () => {
  it("shows plan approval state independently of the inbox task status", () => {
    renderTask(task());
    expect(screen.getByLabelText("Production approval status")).toHaveTextContent(
      "Intake & Planning · waiting for approval",
    );
    expect(screen.getByRole("combobox")).toHaveValue("inbox");
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.queryByTitle("Run task")).not.toBeInTheDocument();
    expect(screen.getByText("Manage the brief and CEO approval in Projects.")).toBeInTheDocument();
  });

  it.each(["NEEDS_INFORMATION", "CHANGES_REQUESTED", "APPROVED"])("displays %s from backend metadata", (state) => {
    renderTask(task({ workflow_meta_json: JSON.stringify({ videoProduction: { stage: "intake_planning", state } }) }));
    expect(screen.getByLabelText("Production approval status")).toHaveTextContent(
      state.toLowerCase().replaceAll("_", " "),
    );
  });

  it.each([
    { workflow_pack_key: "video_preprod" as const },
    { source_task_id: "parent" },
    { workflow_meta_json: "broken json" },
    { workflow_meta_json: "null" },
    { workflow_meta_json: JSON.stringify({ videoProduction: { stage: "intake_planning", state: "RUNNING" } }) },
  ])("does not invent approval state for legacy, child or malformed metadata %j", (overrides) => {
    renderTask(task(overrides));
    expect(screen.queryByLabelText("Production approval status")).not.toBeInTheDocument();
    if (overrides.workflow_pack_key === "video_preprod") {
      expect(screen.getByRole("combobox")).toBeEnabled();
      expect(screen.getByTitle("Run task")).toBeInTheDocument();
    }
  });
});
