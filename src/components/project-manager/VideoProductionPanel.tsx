import { useEffect, useRef, useState } from "react";
import type { VideoProductionBrief, VideoProductionSnapshot } from "../../../shared/video-production";
import { createNextVideoProductionStageJob, decideVideoProductionPlan, getVideoProduction, getVideoProductionOrganization, getVideoProductionRegistry, releaseVideoProduction, saveVideoProductionPlan, setupVideoProductionOrganization, grantVideoProductionAgent, revokeVideoProductionAgent, videoProductionFinalMediaUrl, type VideoProductionOrganizationResponse, type VideoProductionRegistryResponse } from "../../api/video-production";
import { runTask } from "../../api/organization-projects";
import { isApiRequestError } from "../../api/core";
import type { Agent } from "../../types";

const BRIEF_FIELDS: Array<{ key: keyof VideoProductionBrief; label: string }> = [
  { key: "title", label: "Title" },
  { key: "objective", label: "Objective" },
  { key: "targetAudience", label: "Target audience" },
  { key: "duration", label: "Duration" },
  { key: "aspectRatio", label: "Aspect ratio" },
  { key: "language", label: "Language" },
  { key: "style", label: "Style" },
  { key: "deliveryPlatform", label: "Delivery platform" },
  { key: "constraints", label: "Constraints (optional)" },
];

function blankBrief(): VideoProductionBrief {
  return {
    title: "",
    objective: "",
    targetAudience: "",
    duration: "",
    aspectRatio: "",
    language: "",
    style: "",
    deliveryPlatform: "",
    constraints: "",
  };
}

const statusLabel = (status: string) => status.toLowerCase().replaceAll("_", " ");
function displayJson(value: unknown): string {
  if (typeof value !== "string") return value == null ? "—" : JSON.stringify(value);
  try { return JSON.stringify(JSON.parse(value)); } catch { return value; }
}

export default function VideoProductionPanel({ projectId, agents = [] }: { projectId: string; agents?: Agent[] }) {
  const [production, setProduction] = useState<VideoProductionSnapshot | null>(null);
  const [organization, setOrganization] = useState<VideoProductionOrganizationResponse | null>(null);
  const [organizationError, setOrganizationError] = useState<string | null>(null);
  const [organizationSaving, setOrganizationSaving] = useState(false);
  const [registry, setRegistry] = useState<VideoProductionRegistryResponse["registry"] | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [registryRefresh, setRegistryRefresh] = useState(0);
  const [brief, setBrief] = useState<VideoProductionBrief>(blankBrief);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [organizationRefresh, setOrganizationRefresh] = useState(0);
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setLoading(true);
    setProduction(null);
    setOrganization(null);
    setOrganizationError(null);
    setBrief(blankBrief());
    setNote("");
    setError(null);
    setNotice(null);
    setSaving(false);
    setLoadFailed(false);
    getVideoProduction(projectId)
      .then(({ production: snapshot }) => {
        if (generation.current !== current) return;
        setProduction(snapshot);
        setBrief(snapshot?.brief ?? blankBrief());
      })
      .catch((err: unknown) => {
        if (generation.current === current) {
          setLoadFailed(true);
          setError(err instanceof Error ? err.message : "Unable to load production.");
        }
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      generation.current = current + 1;
    };
  }, [projectId, refresh]);

  useEffect(() => {
    const current = generation.current;
    getVideoProductionOrganization(projectId)
      .then((snapshot) => { if (generation.current === current) { setOrganization(snapshot); setOrganizationError(null); } })
      .catch((err: unknown) => { if (generation.current === current) setOrganizationError(err instanceof Error ? err.message : "Unable to load studio organization."); });
  }, [projectId, organizationRefresh]);

  useEffect(() => {
    let active = true;
    setRegistry(null);
    setRegistryError(null);
    getVideoProductionRegistry(projectId)
      .then(({ registry: value }) => { if (active) setRegistry(value); })
      .catch((err: unknown) => { if (active) setRegistryError(err instanceof Error ? err.message : "Unable to load the shot registry."); });
    return () => { active = false; };
  }, [projectId, registryRefresh]);

  useEffect(() => {
    if (production?.automation?.state !== "RUNNING") return;
    let active = true;
    let pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void Promise.all([getVideoProduction(projectId), getVideoProductionRegistry(projectId)])
        .then(([snapshot, assets]) => {
          if (!active) return;
          setProduction(snapshot.production);
          setRegistry(assets.registry);
        })
        .catch(() => { if (active) setRegistryError("Unable to refresh automatic production status. Use Refresh to reconnect."); })
        .finally(() => { pending = false; });
    }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [projectId, production?.automation?.state]);

  async function mutate(action: "save" | "approve" | "request_changes") {
    const current = generation.current;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { production: snapshot } =
        action === "save"
          ? await saveVideoProductionPlan(projectId, brief, production?.plan_version ?? 0)
          : await decideVideoProductionPlan(projectId, production!.plan_version, action, note.trim() || undefined);
      if (generation.current !== current) return;
      setProduction(snapshot);
      setBrief(snapshot?.brief ?? blankBrief());
      setNote("");
      setNotice(
        action === "save"
          ? "Brief and plan saved. Review the current version before approving."
          : action === "approve"
            ? "Plan approved. Production will continue automatically until CEO approval is needed or an error occurs."
            : "Changes requested. Revise the brief and submit a new plan version.",
      );
    } catch (err) {
      if (generation.current !== current) return;
      if (isApiRequestError(err) && err.status === 409) {
        setError("This plan changed. The latest version has been loaded; review it before submitting again.");
        try {
          const { production: snapshot } = await getVideoProduction(projectId);
          if (generation.current !== current) return;
          setProduction(snapshot);
          setBrief(snapshot?.brief ?? blankBrief());
        } catch {
          if (generation.current === current) {
            setLoadFailed(true);
            setError("This plan changed, but refreshing failed. Reload production before submitting again.");
          }
        }
      } else setError(err instanceof Error ? err.message : "Unable to update production.");
    } finally {
      if (generation.current === current) setSaving(false);
    }
  }

  async function updateOrganization(action: "setup" | "grant" | "revoke", agentId?: string, grantKey: "member" | "coordinator" = "member") {
    const current = generation.current;
    setOrganizationSaving(true);
    setOrganizationError(null);
    try {
      if (action === "setup") await setupVideoProductionOrganization();
      else if (agentId) {
        if (action === "grant") await grantVideoProductionAgent(projectId, agentId, grantKey);
        else await revokeVideoProductionAgent(projectId, agentId);
      }
      const snapshot = await getVideoProductionOrganization(projectId);
      if (generation.current === current) setOrganization(snapshot);
    } catch (err) {
      if (generation.current === current) setOrganizationError(err instanceof Error ? err.message : "Unable to update studio organization.");
    } finally { if (generation.current === current) setOrganizationSaving(false); }
  }

  const manager = agents.find((agent) => agent.id === production?.manager_agent_id);
  const currentStage = production?.stages.find((stage) => stage.status !== "COMPLETED");
  const dirty = production ? BRIEF_FIELDS.some(({ key }) => brief[key] !== production.brief[key]) : true;
  const canDecide = production?.state === "WAITING_FOR_APPROVAL" && !dirty && !saving && !loading && !loadFailed;
  const currentFinalCut = registry?.stageArtifacts.find((artifact) => artifact.artifact_type === "final_cut" && artifact.stage_key === "asset_handoff_rough_cut");
  const finalCutPins = currentFinalCut ? (() => { try { return JSON.parse(String(currentFinalCut.content_text)) as Record<string, unknown>; } catch { return {}; } })() : {};
  const latestDirectorDecision = currentFinalCut ? registry?.stageDecisions.find((decision) => decision.target_artifact_id === currentFinalCut.artifact_id && decision.stage_key === "director_review") : undefined;
  const qaEvidence = registry?.stageArtifacts.find((artifact) => artifact.artifact_type === "qa_evidence" && (() => { try { return JSON.parse(String(artifact.content_text)).finalCutArtifactId === currentFinalCut?.artifact_id; } catch { return false; } })());
  const qaPins = qaEvidence ? (() => { try { return JSON.parse(String(qaEvidence.content_text)) as Record<string, unknown>; } catch { return {}; } })() : {};
  const latestQaDecision = qaEvidence ? registry?.stageDecisions.find((decision) => decision.target_artifact_id === qaEvidence.artifact_id && decision.stage_key === "finishing_qa") : undefined;
  const canRelease = Boolean(currentFinalCut && latestDirectorDecision?.decision === "approved" && qaEvidence && latestQaDecision?.decision === "approved" && !registry?.finalRelease);

  async function runNextJob() {
    const current = generation.current;
    setWorkflowBusy(true); setError(null); setNotice(null);
    try {
      const { task } = await createNextVideoProductionStageJob(projectId);
      await runTask(task.id);
      if (generation.current === current) { setNotice("Production started. Eligible stage jobs will continue automatically until CEO approval is needed or an error occurs."); setRegistryRefresh((value) => value + 1); setRefresh((value) => value + 1); }
    } catch (err) { if (generation.current === current) setError(err instanceof Error ? err.message : "Unable to start the next production job."); }
    finally { if (generation.current === current) setWorkflowBusy(false); }
  }

  async function approveFinalRelease() {
    if (!canRelease) return;
    const current = generation.current;
    setWorkflowBusy(true); setError(null);
    try {
      await releaseVideoProduction(projectId, {
        finalCutArtifactId: String(currentFinalCut?.artifact_id ?? ""),
        finalAssetId: String(finalCutPins.finalAssetId ?? ""), finalAssetSha256: String(finalCutPins.finalAssetSha256 ?? ""),
        manifestId: String(finalCutPins.manifestId ?? ""), manifestDigest: String(finalCutPins.manifestDigest ?? ""),
        timelineArtifactId: String(finalCutPins.timelineArtifactId ?? ""), timelineSha256: String(finalCutPins.timelineSha256 ?? ""),
        timelineSourceArtifactId: String(finalCutPins.timelineSourceArtifactId ?? ""), timelineSourceSha256: String(finalCutPins.timelineSourceSha256 ?? ""),
        audioCuesArtifactId: String(finalCutPins.audioCuesArtifactId ?? ""), audioAssetId: String(finalCutPins.audioAssetId ?? ""), audioSha256: String(finalCutPins.audioSha256 ?? ""),
        directorDecisionId: String(latestDirectorDecision?.decision_id ?? ""), qaArtifactId: String(qaEvidence?.artifact_id ?? ""),
        qaArtifactSha256: String(qaEvidence?.content_sha256 ?? ""), qaDecisionId: String(latestQaDecision?.decision_id ?? ""),
      });
      if (generation.current === current) { setNotice("Final release approved and pinned."); setRegistryRefresh((value) => value + 1); setRefresh((value) => value + 1); }
    } catch (err) { if (generation.current === current) setError(err instanceof Error ? err.message : "Unable to approve final release."); }
    finally { if (generation.current === current) setWorkflowBusy(false); }
  }

  return (
    <section
      aria-label="Video production"
      className="min-w-0 rounded-xl border border-slate-700 bg-slate-800/40 p-4 text-xs text-slate-200"
    >
      <h4 className="text-sm font-semibold text-white">Video production</h4>
      {loading ? (
        <p role="status" className="mt-3 text-slate-400">
          Loading production…
        </p>
      ) : (
        <>
          {error && (
            <p role="alert" className="mt-3 whitespace-pre-wrap text-rose-300">
              {error}
            </p>
          )}
          {loadFailed && (
            <button
              type="button"
              onClick={() => setRefresh((value) => value + 1)}
              className="mt-2 rounded-md border border-slate-500 px-3 py-2"
            >
              Reload production
            </button>
          )}
          {notice && (
            <p role="status" className="mt-3 text-emerald-300">
              {notice}
            </p>
          )}
          {production ? (
            <div className="mt-3 space-y-1">
              <p>Production Manager: {production.manager_name ?? manager?.name ?? production.manager_agent_id}</p>
              <p className="break-all text-slate-400">Agent ID: {production.manager_agent_id}</p>
              <p className="break-all text-slate-400">Source directive ID: {production.source_message_id}</p>
              <p>
                Plan version {production.plan_version} · {statusLabel(production.state)}
              </p>
              {currentStage && (
                <p>
                  Current stage: {currentStage.label} · {statusLabel(currentStage.status)}
                </p>
              )}
              {production.state === "WAITING_FOR_APPROVAL" && (
                <p className="text-amber-300">Awaiting CEO approval. Production has not started.</p>
              )}
              {production.missing_fields.length > 0 && (
                <p className="text-amber-300">Information needed: {production.missing_fields.join(", ")}</p>
              )}
            </div>
          ) : (
            <p className="mt-3 text-slate-400">
              Send a CEO Directive marked [video_production] for this project to begin intake and prepare a production
              plan.
            </p>
          )}

          <form
            className="mt-4 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate("save");
            }}
          >
            <fieldset disabled={!production || saving || loadFailed} className="grid gap-3 sm:grid-cols-2">
              <legend className="mb-2 font-semibold">Project brief</legend>
              {BRIEF_FIELDS.map(({ key, label }) => (
                <label
                  key={key}
                  className={key === "objective" || key === "constraints" ? "space-y-1 sm:col-span-2" : "space-y-1"}
                >
                  <span className="block text-slate-300">{label}</span>
                  <textarea
                    rows={key === "objective" || key === "constraints" ? 2 : 1}
                    value={brief[key]}
                    onChange={(event) => setBrief((previous) => ({ ...previous, [key]: event.target.value }))}
                    className="block w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 text-slate-100 focus:border-emerald-500 focus:outline-none disabled:opacity-50"
                  />
                </label>
              ))}
            </fieldset>
            <button
              disabled={!production || saving || loadFailed}
              className="rounded-md bg-emerald-700 px-3 py-2 font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
              type="submit"
            >
              {saving ? "Saving…" : "Submit brief / revise plan"}
            </button>
            {dirty && production?.state === "WAITING_FOR_APPROVAL" && (
              <p className="text-amber-300">Submit your brief changes before approving the plan.</p>
            )}
          </form>

          {production && (
            <>
              <h5 className="mt-5 font-semibold text-white">Production plan</h5>
              <ol className="mt-2 divide-y divide-slate-700">
                {production.stages.map((stage) => (
                  <li key={stage.key} className="py-3">
                    <div className="flex flex-wrap justify-between gap-2">
                      <span>
                        {stage.order}. {stage.label}
                      </span>
                      <span className={stage.status === "COMPLETED" ? "text-emerald-300" : "text-slate-400"}>
                        {statusLabel(stage.status)}
                      </span>
                    </div>
                    <p className="mt-1 text-slate-400">Owner: {stage.owner_role}</p>
                    <p className="mt-1 break-words text-slate-400">Inputs: {stage.inputs.join("; ") || "—"}</p>
                    <p className="mt-1 break-words text-slate-400">Outputs: {stage.outputs.join("; ") || "—"}</p>
                    {stage.approval_required && <p className="mt-1 text-amber-300">{stage.key === "intake_planning" || stage.key === "release_archive" ? "CEO approval required" : "Assigned agent review required"}</p>}
                  </li>
                ))}
              </ol>
              {production.automation && <p role="status" className="mt-3 text-slate-300">Automatic production: {production.automation.state === "RUNNING" ? "running; eligible jobs continue automatically" : production.automation.state === "WAITING_CEO" ? "awaiting CEO approval" : production.automation.state.toLowerCase()}{production.automation.reason && ` · ${production.automation.reason}`}</p>}
              {production.state === "APPROVED" && !registry?.finalRelease && production.automation?.state !== "WAITING_CEO" && <button type="button" disabled={workflowBusy || !registry || production.automation?.state === "RUNNING"} onClick={() => void runNextJob()} className="mt-3 rounded-md bg-emerald-700 px-3 py-2 text-white disabled:opacity-50">{workflowBusy ? "Working…" : production.automation?.state === "RUNNING" ? "Production continues automatically" : "Run next approved stage job"}</button>}
              <label className="mt-4 block space-y-1">
                <span>Decision note</span>
                <textarea
                  value={note}
                  disabled={!canDecide}
                  onChange={(event) => setNote(event.target.value)}
                  className="block w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 disabled:opacity-50"
                />
              </label>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!canDecide}
                  onClick={() => void mutate("approve")}
                  className="rounded-md bg-emerald-700 px-3 py-2 text-white hover:bg-emerald-600 disabled:opacity-50"
                >
                  Approve plan v{production.plan_version}
                </button>
                <button
                  type="button"
                  disabled={!canDecide}
                  onClick={() => void mutate("request_changes")}
                  className="rounded-md border border-slate-500 px-3 py-2 hover:bg-slate-700 disabled:opacity-50"
                >
                  Request changes
                </button>
              </div>
            </>
          )}
        </>
      )}

      {organizationError && <div className="mt-3 flex items-center gap-2"><p role="alert" className="text-rose-300">{organizationError}</p><button type="button" onClick={() => setOrganizationRefresh((value) => value + 1)} className="underline">Retry organization</button></div>}
      {organization && (
        <div className="mt-4 rounded-lg border border-slate-700 p-3">
          <h5 className="font-semibold text-white">Studio roles and project access</h5>
          {!organization.configured && <div className="mt-2 flex flex-wrap items-center gap-2">
            <p className="text-amber-300">Studio organization has not been configured.</p>
            <button type="button" disabled={organizationSaving} onClick={() => void updateOrganization("setup")} className="rounded border border-emerald-600 px-2 py-1 text-emerald-200 disabled:opacity-50">
              {organizationSaving ? "Configuring…" : "Configure studio"}
            </button>
          </div>}
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {organization.agents.map((agent) => {
              const profile = organization.profiles.find((item) => item.roleKey === agent.role_key);
              const grant = organization.grants.find((item) => item.agent_id === agent.id && item.revoked_at === null);
              const department = organization.departments.find((item) => item.department_id === agent.department_id);
              return <li key={agent.id} className="rounded border border-slate-700 p-2">
                <span className="font-medium">{agent.name}</span> · {agent.role_key.replaceAll("_", " ")}
                <span className="block text-slate-400">{department?.name ?? profile?.departmentName ?? agent.department_id} · {grant ? grant.grant_key : "no project grant"}</span>
                {grant?.agent_id === production?.manager_agent_id ? null : grant
                  ? <button type="button" disabled={organizationSaving} onClick={() => void updateOrganization("revoke", agent.id)} className="mt-1 text-amber-300 underline disabled:opacity-50">Revoke project access</button>
                  : <button type="button" disabled={organizationSaving} onClick={() => void updateOrganization("grant", agent.id, agent.role_key === "production_manager" ? "coordinator" : "member")} className="mt-1 text-emerald-300 underline disabled:opacity-50">Grant project access</button>}
                {profile && <details className="mt-2 text-slate-400"><summary className="cursor-pointer">Responsibilities and boundaries</summary>
                  <p className="mt-1">Responsibilities: {profile.responsibilities.join("; ")}</p>
                  <p>Inputs: {profile.inputs.join("; ")}</p><p>Outputs: {profile.outputs.join("; ")}</p>
                  <p>Tools: {profile.allowedTools.join("; ")}</p><p>Approval limits: {profile.approvalBoundaries.join("; ")}</p>
                </details>}
              </li>;
            })}
          </ul>
          <p className="mt-3 text-slate-400">Studio Technology services: Backend, Asset Registry, Render Worker. Execution remains behind verified worker readiness and supported stage gates.</p>
          <h6 className="mt-4 font-semibold text-white">Stage ownership (planning metadata)</h6>
          <ol className="mt-2 space-y-1 text-slate-300">
            {organization.stages.map((stage) => <li key={stage.stageKey}>
              {stage.stageKey.replaceAll("_", " ")}: {stage.sequence.map((step) => step.kind === "agent" ? step.roleKey.replaceAll("_", " ") : step.kind === "ceo" ? "CEO" : "Studio Technology service").join(" → ")}
            </li>)}
          </ol>
          <p className="mt-2 text-slate-400">Ownership is policy metadata; a stage runs only when its fixed executor and isolation checks pass.</p>
        </div>
      )}
      <div className="mt-4 rounded-lg border border-slate-700 p-3" aria-label="Shot and asset registry">
        <div className="flex items-center justify-between gap-2">
          <h5 className="font-semibold text-white">Shot and asset registry · read only</h5>
          <button type="button" onClick={() => setRegistryRefresh((value) => value + 1)} className="underline">Refresh</button>
        </div>
        {registryError ? <p role="alert" className="mt-2 text-rose-300">{registryError}</p> : !registry ? <p role="status" className="mt-2 text-slate-400">Loading registry…</p> : (
          <>
            <p className="mt-2 text-slate-400">{registry.scenes.length} scenes · {registry.shots.length} shots · {registry.takes.length} takes · {registry.assets.length} assets</p>
            {registry.scenes.length === 0 && <p className="mt-2 text-slate-400">No scenes have been registered.</p>}
            <ol className="mt-2 space-y-2">
              {registry.scenes.map((scene) => {
                const sceneId = String(scene.scene_id);
                const sceneShots = registry.shots.filter((shot) => shot.scene_id === sceneId);
                return <li key={sceneId} className="rounded border border-slate-700 p-2">
                  <p className="font-medium text-white">Scene {String(scene.sort_order)} · {String(scene.description ?? sceneId)}</p>
                  <p className="text-slate-400">Location: {String(scene.location ?? "—")} · Characters: {displayJson(scene.characters_json)} · Continuity: {displayJson(scene.continuity_json)}</p>
                  <ol className="mt-2 space-y-1 pl-4">
                    {sceneShots.map((shot) => {
                      const shotId = String(shot.shot_id);
                      const shotTakes = registry.takes.filter((take) => take.shot_id === shotId);
                      const approved = shotTakes.find((take) => Number(take.current_approved) === 1);
                      const stale = registry.dependencies.some((dependency) => dependency.shot_id === shotId && dependency.stale === true);
                      return <li key={shotId}>
                        <span className="text-slate-200">Shot {String(shot.sort_order)} · {String(shot.action ?? shotId)}</span>
                        <span className="ml-2 text-slate-400">{approved ? `approved: ${String(approved.take_id)}` : "awaiting approved take"}{stale ? " · continuity stale" : ""}</span>
                        <p className="text-slate-500">{shotTakes.length} take(s) · {String(shot.duration_ms ?? 0)} ms · continuity {stale ? "stale" : "current"}</p>
                        {shotTakes.map((take) => <details key={String(take.take_id)} className="ml-2 text-slate-400">
                          <summary className="cursor-pointer">Take {String(take.take_number)} · {String(take.latest_decision ?? "not reviewed")} · asset v{String(take.shot_version)}</summary>
                          <p className="break-all">ID: {String(take.take_id)} · SHA-256: {String(take.sha256 ?? "—")}</p>
                          <p>Model/prompt metadata: {displayJson(take.attempt_metadata_json)}</p>
                          <p>Review by {String(take.latest_reviewer ?? "—")}: {String(take.latest_feedback ?? "No review recorded.")}</p>
                          <p>Registered by {String(take.submitted_by ?? "—")} · {String(take.byte_size ?? 0)} bytes · {String(take.content_type ?? "unknown type")}</p>
                        </details>)}
                      </li>;
                    })}
                  </ol>
                </li>;
              })}
            </ol>
            <h6 className="mt-3 font-medium text-white">Visual references</h6>
            {registry.visualReferences.length ? <ul>{registry.visualReferences.map((reference) => <li key={String(reference.reference_id)} className="text-slate-400">{String(reference.reference_type)} · v{String(reference.current_version)} · {String(reference.sha256)}</li>)}</ul> : <p className="text-slate-400">No visual references.</p>}
            <h6 className="mt-3 font-medium text-white">Regeneration requests and manifests</h6>
            <ul className="text-slate-400">
              {registry.regenerationRequests.map((item) => <li key={String(item.request_id)}>Shot {String(item.shot_id)} · {String(item.status)} · {String(item.request_id)}</li>)}
              {registry.manifests.map((item) => <li key={String(item.manifest_id)}>Manifest v{String(item.manifest_version)} · {item.current === true ? "current" : "stale"} · {String(item.digest_sha256)}</li>)}
            </ul>
            {currentFinalCut && <section className="mt-4 rounded border border-slate-700 p-3">
              <h6 className="font-semibold text-white">Final cut and independent review</h6>
              <p className="mt-1 text-slate-400">Final asset {String(finalCutPins.finalAssetId ?? "—")} · SHA-256 {String(finalCutPins.finalAssetSha256 ?? "—")}</p>
              <p className="break-all text-slate-500">Manifest {String(finalCutPins.manifestDigest ?? "—")} · Timeline plan {String(finalCutPins.timelineSha256 ?? "—")} · Render source {String(finalCutPins.timelineSourceSha256 ?? "—")} · Audio {String(finalCutPins.audioSha256 ?? "—")}</p>
              <video className="mt-2 max-h-96 w-full" controls preload="metadata" src={videoProductionFinalMediaUrl(projectId, String(finalCutPins.finalAssetId ?? ""))}>Final video preview</video>
              <p className="text-slate-400">Rian: {String(latestDirectorDecision?.decision ?? "awaiting review")}</p>
              {qaEvidence && <><p className="text-slate-400">Quinn: {String(latestQaDecision?.decision ?? "awaiting QA decision")} · {String(qaPins.feedback ?? "")}</p><p className="break-words text-slate-500">QA issues: {displayJson(qaPins.issues)}</p></>}
              {registry.finalRelease ? <><p className="text-emerald-300">Released · {String(registry.finalRelease.final_asset_sha256)}</p><a className="mt-2 inline-block underline" href={videoProductionFinalMediaUrl(projectId, String(registry.finalRelease.final_asset_id))} download="final-video.mp4">Download released MP4</a></> : canRelease ? <button type="button" disabled={workflowBusy} onClick={() => void approveFinalRelease()} className="mt-2 rounded bg-emerald-700 px-3 py-2 text-white disabled:opacity-50">Approve pinned final release</button> : <p className="text-amber-300">Awaiting Rian’s current cut approval and Quinn’s current QA approval.</p>}
            </section>}
            <p className="mt-2 text-slate-500">Registry content is read only for the CEO. Release approval pins the exact MP4, manifest, timeline, audio, and QA evidence. Technical validation does not replace codec or creative review.</p>
          </>
        )}
      </div>
    </section>
  );
}
