import { request } from "./core";

import type { VideoProductionBrief, VideoProductionSnapshot } from "../../shared/video-production";
import type { VideoStudioAgentProfile, VideoStudioStageOwnership } from "../../shared/video-studio-organization";

export type VideoProductionResponse = { production: VideoProductionSnapshot | null };
export type VideoProductionOrganizationResponse = {
  production: VideoProductionSnapshot;
  configured: boolean;
  profiles: readonly VideoStudioAgentProfile[];
  agents: Array<{ id: string; name: string; name_ko: string | null; department_id: string; role: string; role_key: string; bound_by: string; created_at: number }>;
  departments: Array<{ department_id: string; name: string; name_ko: string; icon: string; color: string; sort_order: number }>;
  stages: readonly VideoStudioStageOwnership[];
  grants: Array<{ agent_id: string; grant_key: string; granted_by: string; created_at: number; revoked_at: number | null; role_key: string; name: string; department_id: string }>;
};

export type VideoProductionRegistryResponse = {
  registry: {
    production: Record<string, unknown>;
    scenes: Array<Record<string, unknown>>;
    shots: Array<Record<string, unknown>>;
    takes: Array<Record<string, unknown>>;
    assets: Array<Record<string, unknown>>;
    visualReferences: Array<Record<string, unknown>>;
    dependencies: Array<Record<string, unknown>>;
    regenerationRequests: Array<Record<string, unknown>>;
    manifests: Array<Record<string, unknown>>;
  };
};

function productionPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/video-production`;
}

export function getVideoProduction(projectId: string): Promise<VideoProductionResponse> {
  return request(productionPath(projectId));
}

/** CEO session is read-only here; agent write credentials are never transported by the UI. */
export function getVideoProductionRegistry(projectId: string): Promise<VideoProductionRegistryResponse> {
  return request(`${productionPath(projectId)}/registry`);
}

export function getVideoProductionOrganization(projectId: string): Promise<VideoProductionOrganizationResponse> {
  return request(`${productionPath(projectId)}/organization`);
}

export function setupVideoProductionOrganization(): Promise<{ ok: boolean; departments: number; agents: number }> {
  return request("/api/video-production/organization/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
}

export function grantVideoProductionAgent(projectId: string, agentId: string, grantKey: "member" | "coordinator" = "member") {
  return request(`${productionPath(projectId)}/agents/${encodeURIComponent(agentId)}/grant`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_key: grantKey }),
  });
}

export function revokeVideoProductionAgent(projectId: string, agentId: string) {
  return request(`${productionPath(projectId)}/agents/${encodeURIComponent(agentId)}/grant`, { method: "DELETE" });
}

export function saveVideoProductionPlan(
  projectId: string,
  brief: VideoProductionBrief,
  expectedVersion: number,
): Promise<VideoProductionResponse> {
  return request(`${productionPath(projectId)}/plan`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brief, expectedVersion }),
  });
}

export function decideVideoProductionPlan(
  projectId: string,
  version: number,
  decision: "approve" | "request_changes",
  note?: string,
): Promise<VideoProductionResponse> {
  return request(`${productionPath(projectId)}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version, decision, note }),
  });
}
