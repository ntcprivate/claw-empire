import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VIDEO_PRODUCTION_STAGES, type VideoProductionSnapshot } from "../../../shared/video-production";
import { ApiRequestError } from "../../api/core";
import { decideVideoProductionPlan, getVideoProduction, getVideoProductionOrganization, getVideoProductionRegistry, saveVideoProductionPlan, setupVideoProductionOrganization, grantVideoProductionAgent } from "../../api/video-production";
import VideoProductionPanel from "./VideoProductionPanel";

vi.mock("../../api/video-production", () => ({
  getVideoProduction: vi.fn(),
  saveVideoProductionPlan: vi.fn(),
  decideVideoProductionPlan: vi.fn(),
  getVideoProductionOrganization: vi.fn(),
  getVideoProductionRegistry: vi.fn(),
  setupVideoProductionOrganization: vi.fn(),
  grantVideoProductionAgent: vi.fn(),
  revokeVideoProductionAgent: vi.fn(),
}));

function snapshot(state: VideoProductionSnapshot["state"] = "WAITING_FOR_APPROVAL"): VideoProductionSnapshot {
  return {
    project_id: "project-1",
    source_message_id: "message-1",
    root_task_id: "root-1",
    manager_agent_id: "dami",
    state,
    plan_version: 1,
    approved_version: null,
    brief: {
      title: "Studio launch",
      objective: "Introduce studio",
      targetAudience: "Creators",
      duration: "30s",
      aspectRatio: "16:9",
      language: "Vietnamese",
      style: "Documentary",
      deliveryPlatform: "YouTube",
      constraints: "",
    },
    missing_fields: [],
    decisions: [],
    stages: VIDEO_PRODUCTION_STAGES.map((stage, index) => ({
      ...stage,
      inputs: [...stage.inputs],
      outputs: [...stage.outputs],
      order: index + 1,
      status: index === 0 ? (state === "APPROVED" ? "COMPLETED" : "WAITING_FOR_APPROVAL") : "NOT_IMPLEMENTED",
      implemented: index === 0,
      task_id: index === 0 ? "root-1" : null,
    })),
  };
}

describe("VideoProductionPanel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getVideoProductionOrganization).mockRejectedValue(new Error("Organization not loaded"));
    vi.mocked(getVideoProductionRegistry).mockResolvedValue({ registry: { production: {}, scenes: [], shots: [], takes: [], assets: [], visualReferences: [], dependencies: [], regenerationRequests: [], manifests: [] } });
  });

  it("requires a directive to initiate intake before brief submission is available", async () => {
    vi.mocked(getVideoProduction).mockResolvedValue({ production: null });
    render(<VideoProductionPanel projectId="project-1" />);
    expect(await screen.findByText(/Send a CEO Directive marked/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit brief / revise plan" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Approve plan/ })).not.toBeInTheDocument();
  });

  it("shows pending approval and never presents unimplemented production as completed", async () => {
    vi.mocked(getVideoProduction).mockResolvedValue({ production: snapshot() });
    render(<VideoProductionPanel projectId="project-1" />);
    expect(await screen.findByText("Awaiting CEO approval. Production has not started.")).toBeInTheDocument();
    expect(screen.getByText("Production Manager: dami")).toBeInTheDocument();
    expect(screen.getAllByText("not implemented")).toHaveLength(8);
    expect(screen.getAllByRole("listitem")).toHaveLength(9);
    expect(screen.getByRole("button", { name: "Approve plan v1" })).toBeEnabled();
    expect(screen.queryByText("completed")).not.toBeInTheDocument();
  });

  it("submits edited brief with expected version and blocks approval of unsaved changes", async () => {
    const user = userEvent.setup();
    vi.mocked(getVideoProduction).mockResolvedValue({ production: snapshot() });
    vi.mocked(saveVideoProductionPlan).mockResolvedValue({ production: { ...snapshot(), plan_version: 2 } });
    render(<VideoProductionPanel projectId="project-1" />);
    await user.type(await screen.findByLabelText("Title"), " revised");
    expect(screen.getByRole("button", { name: "Approve plan v1" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Submit brief / revise plan" }));
    await waitFor(() =>
      expect(saveVideoProductionPlan).toHaveBeenCalledWith(
        "project-1",
        expect.objectContaining({ title: "Studio launch revised" }),
        1,
      ),
    );
    expect(await screen.findByRole("button", { name: "Approve plan v2" })).toBeEnabled();
  });

  it("sends explicit approval with displayed version without starting later stages", async () => {
    const user = userEvent.setup();
    vi.mocked(getVideoProduction).mockResolvedValue({ production: snapshot() });
    vi.mocked(decideVideoProductionPlan).mockResolvedValue({ production: snapshot("APPROVED") });
    render(<VideoProductionPanel projectId="project-1" />);
    await user.click(await screen.findByRole("button", { name: "Approve plan v1" }));
    expect(decideVideoProductionPlan).toHaveBeenCalledWith("project-1", 1, "approve", undefined);
    expect(
      await screen.findByText("Plan approved. Later production stages are not implemented in Phase 1."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("not implemented")).toHaveLength(8);
    expect(screen.getByRole("button", { name: "Approve plan v1" })).toBeDisabled();
  });

  it("refreshes after a stale decision and requires a new explicit action", async () => {
    const user = userEvent.setup();
    vi.mocked(getVideoProduction)
      .mockResolvedValueOnce({ production: snapshot() })
      .mockResolvedValueOnce({ production: { ...snapshot(), plan_version: 2 } });
    vi.mocked(decideVideoProductionPlan).mockRejectedValue(
      new ApiRequestError("stale_plan", { status: 409, url: "/decision" }),
    );
    render(<VideoProductionPanel projectId="project-1" />);
    await user.click(await screen.findByRole("button", { name: "Approve plan v1" }));
    expect(await screen.findByText("This plan changed. The latest version has been loaded; review it before submitting again.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Approve plan v2" })).toBeEnabled();
    expect(decideVideoProductionPlan).toHaveBeenCalledTimes(1);
  });

  it("requests changes with CEO note", async () => {
    const user = userEvent.setup();
    vi.mocked(getVideoProduction).mockResolvedValue({ production: snapshot() });
    vi.mocked(decideVideoProductionPlan).mockResolvedValue({ production: snapshot("CHANGES_REQUESTED") });
    render(<VideoProductionPanel projectId="project-1" />);
    await user.type(await screen.findByLabelText("Decision note"), "Shorten to 20 seconds");
    await user.click(screen.getByRole("button", { name: "Request changes" }));
    expect(decideVideoProductionPlan).toHaveBeenCalledWith("project-1", 1, "request_changes", "Shorten to 20 seconds");
    expect(await screen.findByText(/Changes requested. Revise/)).toBeInTheDocument();
  });

  it("shows missing information and keeps approval disabled", async () => {
    vi.mocked(getVideoProduction).mockResolvedValue({
      production: { ...snapshot("NEEDS_INFORMATION"), missing_fields: ["duration"] },
    });
    render(<VideoProductionPanel projectId="project-1" />);
    expect(await screen.findByText("Information needed: duration")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve plan v1" })).toBeDisabled();
  });

  it("recovers from load failure without enabling mutations against unknown state", async () => {
    const user = userEvent.setup();
    vi.mocked(getVideoProduction)
      .mockRejectedValueOnce(new Error("Unavailable"))
      .mockResolvedValueOnce({ production: snapshot() });
    render(<VideoProductionPanel projectId="project-1" />);
    expect(await screen.findByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit brief / revise plan" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Reload production" }));
    expect(await screen.findByRole("button", { name: "Approve plan v1" })).toBeEnabled();
  });

  it("configures from the server and preserves unsaved brief edits when project access changes", async () => {
    const user = userEvent.setup();
    const organization = {
      production: snapshot(), configured: true,
      profiles: [{ id: "dami", roleKey: "production_manager", displayName: "Dami", departmentName: "Production Management", responsibilities: ["Coordinate production"], inputs: ["Brief"], outputs: ["Plan"], allowedTools: ["plan.write"], approvalBoundaries: ["Cannot release"], actions: ["studio.read", "plan.update", "task.assign"] }],
      agents: [{ id: "dami", name: "Dami", name_ko: null, department_id: "operations", role: "team_leader", role_key: "production_manager", bound_by: "ceo_session", created_at: 1 }],
      departments: [{ department_id: "operations", name: "Production Management", name_ko: "제작 관리", icon: "P", color: "#a26b36", sort_order: 1 }],
      stages: [], grants: [],
    } as never;
    vi.mocked(getVideoProduction).mockResolvedValue({ production: snapshot() });
    vi.mocked(getVideoProductionOrganization).mockResolvedValue(organization);
    vi.mocked(grantVideoProductionAgent).mockResolvedValue({ ok: true } as never);
    render(<VideoProductionPanel projectId="project-1" />);
    const title = await screen.findByLabelText("Title");
    await user.type(title, " revised");
    await user.click(await screen.findByRole("button", { name: "Grant project access" }));
    expect(grantVideoProductionAgent).toHaveBeenCalledWith("project-1", "dami", "coordinator");
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Studio launch revised"));
    expect(screen.getByRole("button", { name: "Submit brief / revise plan" })).toBeEnabled();
    expect(screen.getByText(/Responsibilities: Coordinate production/)).toBeInTheDocument();
  });

  it("offers explicit CEO organization setup when the server reports it is not configured", async () => {
    const user = userEvent.setup();
    const organization = { production: snapshot(), configured: false, profiles: [], agents: [], departments: [], stages: [], grants: [] };
    const unconfigured = organization as never;
    const configured = { ...organization, configured: true } as never;
    vi.mocked(getVideoProduction).mockResolvedValue({ production: snapshot() });
    vi.mocked(getVideoProductionOrganization).mockResolvedValueOnce(unconfigured).mockResolvedValue(configured);
    vi.mocked(setupVideoProductionOrganization).mockResolvedValue({ ok: true, departments: 6, agents: 8 });
    render(<VideoProductionPanel projectId="project-1" />);
    await user.click(await screen.findByRole("button", { name: "Configure studio" }));
    await waitFor(() => expect(setupVideoProductionOrganization).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("Studio organization has not been configured.")).not.toBeInTheDocument());
  });

  it("shows the persisted registry as CEO read-only data and offers refresh only", async () => {
    vi.mocked(getVideoProduction).mockResolvedValue({ production: snapshot() });
    vi.mocked(getVideoProductionRegistry).mockResolvedValue({ registry: {
      production: {},
      scenes: [{ scene_id: "scene-1", sort_order: 0, description: "Arrival", location: "Gate", characters_json: '["Ari"]' }],
      shots: [{ shot_id: "shot-1", scene_id: "scene-1", sort_order: 0, action: "Ari enters", duration_ms: 2200 }],
      takes: [{ take_id: "take-1", shot_id: "shot-1", take_number: 1, shot_version: 2, current_approved: 1, latest_decision: "approved", latest_reviewer: "yuna", latest_feedback: "Continuity matches", submitted_by: "miro", sha256: "hash-1", byte_size: 12, content_type: "video/mp4", attempt_metadata_json: '{"model":"fixture","prompt":"wide entry"}' }], assets: [], visualReferences: [], dependencies: [{ shot_id: "shot-1", stale: true }], regenerationRequests: [],
      manifests: [{ manifest_id: "manifest-1", manifest_version: 1, current: true, digest_sha256: "abc" }],
    } });
    render(<VideoProductionPanel projectId="project-1" />);
    expect(await screen.findByRole("heading", { name: "Shot and asset registry · read only" })).toBeInTheDocument();
    expect(await screen.findByText("Scene 0 · Arrival")).toBeInTheDocument();
    expect(screen.getByText(/approved: take-1/)).toBeInTheDocument();
    expect(screen.getAllByText(/continuity stale/)).toHaveLength(2);
    expect(screen.getByText(/Manifest v1 · current/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByText(/Take 1 · approved/));
    expect(screen.getByText(/Review by yuna: Continuity matches/)).toBeInTheDocument();
    expect(screen.getByText(/Model\/prompt metadata:/)).toHaveTextContent('"wide entry"');
    expect(screen.queryByRole("button", { name: /approve take|review take|upload asset|regenerate/i })).not.toBeInTheDocument();
  });
});
