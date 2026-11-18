import type { VideoProductionStageKey } from "./video-production.ts";

export type VideoStudioRoleKey = "production_manager" | "director" | "screenwriter" | "art_director" | "video_producer" | "editor" | "sound_producer" | "qa_supervisor";
export type VideoStudioAction =
  | "studio.read" | "plan.update" | "task.assign" | "change.request" | "production.monitor"
  | "creative.approve" | "pilot.approve" | "picture_lock" | "screenplay.write" | "shot_spec.write" | "visual.manage"
  | "take.review" | "footage.submit" | "generation.manage" | "edit.manage" | "audio.manage" | "qa.final"
  | "regeneration.request"
  | "project.greenlight" | "budget.override" | "release.final";

export interface VideoStudioAgentProfile {
  id: string;
  roleKey: VideoStudioRoleKey;
  displayName: string;
  departmentId: string;
  departmentName: string;
  responsibilities: readonly string[];
  inputs: readonly string[];
  outputs: readonly string[];
  allowedTools: readonly string[];
  approvalBoundaries: readonly string[];
  actions: readonly VideoStudioAction[];
}

export const VIDEO_STUDIO_DEPARTMENTS = [
  { id: "operations", name: "Production Management", sortOrder: 1 },
  { id: "planning", name: "Creative Development", sortOrder: 2 },
  { id: "design", name: "AI Visual Production", sortOrder: 3 },
  { id: "dev", name: "Post-production & Sound", sortOrder: 4 },
  { id: "qa", name: "Quality Assurance", sortOrder: 5 },
  { id: "devsecops", name: "Studio Technology", sortOrder: 6 },
] as const;

export const VIDEO_STUDIO_PROFILES: readonly VideoStudioAgentProfile[] = [
  { id: "video_production-seed-5", roleKey: "production_manager", displayName: "Dami", departmentId: "operations", departmentName: "Production Management", responsibilities: ["Receive briefs", "Prepare plans", "Assign tasks", "Track progress and quota", "Escalate approvals", "Report to CEO", "Request regeneration for rejected shots"], inputs: ["CEO directive", "Brief", "Team updates", "Rejected take review"], outputs: ["Plan", "Assignments", "Status report", "Idempotent regeneration request"], allowedTools: ["brief.read", "plan.write", "task.assign", "progress.read", "regeneration.request"], approvalBoundaries: ["Cannot approve CEO greenlight, budget override, or final release"], actions: ["studio.read", "plan.update", "task.assign", "change.request", "production.monitor", "regeneration.request"] },
  { id: "video_production-role-director", roleKey: "director", displayName: "Rian", departmentId: "planning", departmentName: "Creative Development", responsibilities: ["Creative direction", "Review script, storyboard, animatic and rough cut", "Approve picture lock and pilot"], inputs: ["Approved brief", "Scripts", "Storyboard", "Cuts"], outputs: ["Creative decisions", "Picture lock"], allowedTools: ["creative.review", "creative.approve", "pilot.approve"], approvalBoundaries: ["Cannot approve CEO greenlight or release"], actions: ["studio.read", "creative.approve", "pilot.approve", "picture_lock"] },
  { id: "video_production-role-screenwriter", roleKey: "screenwriter", displayName: "Haru", departmentId: "planning", departmentName: "Creative Development", responsibilities: ["Write screenplay and dialogue", "Break down scenes", "Prepare storyboard and shot list"], inputs: ["Approved brief", "Director notes"], outputs: ["Screenplay", "Scene breakdown", "Storyboard", "Shot specification"], allowedTools: ["script.write", "shot_spec.write"], approvalBoundaries: ["Cannot approve own screenplay"], actions: ["studio.read", "screenplay.write", "shot_spec.write"] },
  { id: "video_production-role-art-director", roleKey: "art_director", displayName: "Yuna", departmentId: "design", departmentName: "AI Visual Production", responsibilities: ["Maintain visual bible and references", "Check continuity", "Review takes"], inputs: ["Approved script", "Shot specification", "Submitted takes"], outputs: ["Visual bible", "Continuity notes", "Take review"], allowedTools: ["visual.manage", "take.review"], approvalBoundaries: ["Cannot approve CEO or final QA decisions"], actions: ["studio.read", "visual.manage", "take.review"] },
  { id: "video_production-role-video-producer", roleKey: "video_producer", displayName: "Miro", departmentId: "design", departmentName: "AI Visual Production", responsibilities: ["Submit footage by shot", "Track generation attempts"], inputs: ["Approved shot specification", "Visual references"], outputs: ["Footage submissions", "Attempt reports"], allowedTools: ["footage.submit", "generation.manage"], approvalBoundaries: ["Cannot approve takes"], actions: ["studio.read", "footage.submit", "generation.manage"] },
  { id: "video_production-role-editor", roleKey: "editor", displayName: "Liam", departmentId: "dev", departmentName: "Post-production & Sound", responsibilities: ["Build animatic and timeline", "Edit rough cut", "Coordinate finishing and render"], inputs: ["Approved footage", "Audio assets"], outputs: ["Animatic", "Timeline", "Rough cut", "Render handoff"], allowedTools: ["edit.manage"], approvalBoundaries: ["Cannot approve CEO release or final QA"], actions: ["studio.read", "edit.manage"] },
  { id: "video_production-role-sound-producer", roleKey: "sound_producer", displayName: "Audio Producer", departmentId: "dev", departmentName: "Post-production & Sound", responsibilities: ["Prepare dialogue guide", "Coordinate voice, music and SFX", "Mix final audio"], inputs: ["Approved script", "Picture edit"], outputs: ["Dialogue guide", "Audio mix"], allowedTools: ["audio.manage"], approvalBoundaries: ["Cannot approve CEO release or final QA"], actions: ["studio.read", "audio.manage"] },
  { id: "video_production-role-qa-supervisor", roleKey: "qa_supervisor", displayName: "Quinn", departmentId: "qa", departmentName: "Quality Assurance", responsibilities: ["Perform independent final QA", "Report defects", "Approve or reject against QA criteria"], inputs: ["Release candidate", "QA criteria"], outputs: ["Defect report", "Final QA decision"], allowedTools: ["qa.final"], approvalBoundaries: ["Cannot approve CEO release"], actions: ["studio.read", "qa.final"] },
];

export const VIDEO_STUDIO_CEO_ACTIONS: readonly VideoStudioAction[] = ["project.greenlight", "budget.override", "release.final"];

export type VideoStudioStageStep =
  | { kind: "agent"; roleKey: VideoStudioRoleKey; action: VideoStudioAction }
  | { kind: "service"; service: "studio_technology"; action: "asset.handoff" | "archive.write" }
  | { kind: "ceo"; action: "project.greenlight" | "release.final" };
export interface VideoStudioStageOwnership { stageKey: VideoProductionStageKey; owners: readonly VideoStudioRoleKey[]; approver: VideoStudioRoleKey | "ceo" | "service" | null; sequence: readonly VideoStudioStageStep[] }
export const VIDEO_STUDIO_STAGE_OWNERSHIP: readonly VideoStudioStageOwnership[] = [
  { stageKey: "intake_planning", owners: ["production_manager", "director"], approver: "ceo", sequence: [{kind:"agent",roleKey:"production_manager",action:"plan.update"},{kind:"agent",roleKey:"director",action:"creative.approve"},{kind:"ceo",action:"project.greenlight"}] },
  { stageKey: "story_development", owners: ["screenwriter"], approver: "director", sequence: [{kind:"agent",roleKey:"screenwriter",action:"screenplay.write"},{kind:"agent",roleKey:"director",action:"creative.approve"}] },
  { stageKey: "visual_preproduction", owners: ["screenwriter", "art_director", "editor"], approver: "director", sequence: [{kind:"agent",roleKey:"screenwriter",action:"shot_spec.write"},{kind:"agent",roleKey:"art_director",action:"visual.manage"},{kind:"agent",roleKey:"editor",action:"edit.manage"},{kind:"agent",roleKey:"director",action:"creative.approve"}] },
  { stageKey: "audio_preproduction", owners: ["sound_producer"], approver: "director", sequence: [{kind:"agent",roleKey:"sound_producer",action:"audio.manage"},{kind:"agent",roleKey:"director",action:"creative.approve"}] },
  { stageKey: "ai_footage_production", owners: ["video_producer"], approver: "art_director", sequence: [{kind:"agent",roleKey:"video_producer",action:"footage.submit"},{kind:"agent",roleKey:"art_director",action:"take.review"},{kind:"agent",roleKey:"director",action:"pilot.approve"}] },
  { stageKey: "asset_handoff_rough_cut", owners: ["editor"], approver: "service", sequence: [{kind:"service",service:"studio_technology",action:"asset.handoff"},{kind:"agent",roleKey:"editor",action:"edit.manage"}] },
  { stageKey: "director_review", owners: ["director"], approver: "director", sequence: [{kind:"agent",roleKey:"director",action:"creative.approve"},{kind:"agent",roleKey:"director",action:"picture_lock"}] },
  { stageKey: "finishing_qa", owners: ["sound_producer", "editor", "qa_supervisor"], approver: "qa_supervisor", sequence: [{kind:"agent",roleKey:"sound_producer",action:"audio.manage"},{kind:"agent",roleKey:"editor",action:"edit.manage"},{kind:"agent",roleKey:"qa_supervisor",action:"qa.final"}] },
  { stageKey: "release_archive", owners: ["production_manager"], approver: "ceo", sequence: [{kind:"agent",roleKey:"production_manager",action:"production.monitor"},{kind:"service",service:"studio_technology",action:"archive.write"},{kind:"ceo",action:"release.final"}] },
];

export const VIDEO_STUDIO_ROLE_BY_KEY = Object.fromEntries(VIDEO_STUDIO_PROFILES.map((profile) => [profile.roleKey, profile])) as Record<VideoStudioRoleKey, VideoStudioAgentProfile>;
