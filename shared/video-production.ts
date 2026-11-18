export const VIDEO_PRODUCTION_PACK = "video_production";

export interface VideoProductionBrief {
  title: string;
  objective: string;
  targetAudience: string;
  duration: string;
  aspectRatio: string;
  language: string;
  style: string;
  deliveryPlatform: string;
  constraints: string;
}

export const VIDEO_PRODUCTION_BRIEF_FIELDS = [
  "title",
  "objective",
  "targetAudience",
  "duration",
  "aspectRatio",
  "language",
  "style",
  "deliveryPlatform",
  "constraints",
] as const;

export const VIDEO_PRODUCTION_STAGES = [
  {
    key: "intake_planning",
    label: "Intake & Planning",
    owner_role: "Production Manager",
    inputs: ["CEO directive", "Project brief"],
    outputs: ["Project brief", "Production plan"],
    approval_required: true,
  },
  {
    key: "story_development",
    label: "Story Development",
    owner_role: "Creative Development",
    inputs: ["Approved production plan"],
    outputs: ["Script", "Story treatment"],
    approval_required: true,
  },
  {
    key: "visual_preproduction",
    label: "Visual Pre-production",
    owner_role: "AI Visual Production",
    inputs: ["Approved script"],
    outputs: ["Storyboard", "Visual design"],
    approval_required: true,
  },
  {
    key: "audio_preproduction",
    label: "Audio Pre-production",
    owner_role: "Post-production & Sound",
    inputs: ["Approved script"],
    outputs: ["Audio plan"],
    approval_required: true,
  },
  {
    key: "ai_footage_production",
    label: "AI Footage Production",
    owner_role: "AI Visual Production",
    inputs: ["Approved storyboard"],
    outputs: ["Footage assets"],
    approval_required: false,
  },
  {
    key: "asset_handoff_rough_cut",
    label: "Asset Handoff & Rough Cut",
    owner_role: "Post-production & Sound",
    inputs: ["Footage assets", "Audio assets"],
    outputs: ["Rough cut"],
    approval_required: false,
  },
  {
    key: "director_review",
    label: "Director Review",
    owner_role: "Production Manager",
    inputs: ["Rough cut"],
    outputs: ["Director decision"],
    approval_required: true,
  },
  {
    key: "finishing_qa",
    label: "Finishing & QA",
    owner_role: "Quality Assurance",
    inputs: ["Approved rough cut"],
    outputs: ["QA report", "Final master"],
    approval_required: true,
  },
  {
    key: "release_archive",
    label: "Release & Archive",
    owner_role: "Studio Technology",
    inputs: ["Approved final master"],
    outputs: ["Release package", "Archive record"],
    approval_required: true,
  },
] as const;

export type VideoProductionStageKey = (typeof VIDEO_PRODUCTION_STAGES)[number]["key"];
export type VideoProductionState = "NEEDS_INFORMATION" | "WAITING_FOR_APPROVAL" | "CHANGES_REQUESTED" | "APPROVED";
export type VideoProductionStageStatus =
  | "NEEDS_INFORMATION"
  | "WAITING_FOR_APPROVAL"
  | "CHANGES_REQUESTED"
  | "COMPLETED"
  | "NOT_IMPLEMENTED"
  | "BLOCKED"
  | "READY"
  | "RUNNING"
  | "FAILED"
  | "PAUSED";
export interface VideoProductionStage {
  key: VideoProductionStageKey;
  label: string;
  order: number;
  owner_role: string;
  status: VideoProductionStageStatus;
  implemented: boolean;
  task_id: string | null;
  inputs: string[];
  outputs: string[];
  approval_required: boolean;
}
export interface VideoProductionDecision {
  version: number;
  decision: "approve" | "request_changes";
  note: string;
  actor_id: string;
  created_at: number;
}
export interface VideoProductionSnapshot {
  automation?: {
    state: "RUNNING" | "WAITING_CEO" | "ERROR" | "PAUSED" | "COMPLETED";
    reason: string | null;
    task_id: string | null;
    plan_version: number;
  } | null;
  project_id: string;
  source_message_id: string;
  root_task_id: string;
  manager_agent_id: string;
  manager_name?: string;
  state: VideoProductionState;
  plan_version: number;
  approved_version: number | null;
  brief: VideoProductionBrief;
  missing_fields: string[];
  stages: VideoProductionStage[];
  decisions: VideoProductionDecision[];
}
