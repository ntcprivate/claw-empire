import type { ChildProcess } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { StringDecoder } from "node:string_decoder";
import { createTrustedVideoProductionAttemptActor } from "./video-production-rbac.ts";
import { getVideoProductionAgentProvider, requestVideoProductionJson } from "./video-production-provider-broker.ts";
import { VideoProductionPolicyError } from "./video-production.ts";

export const MIRO_AUTHORING_MAX_TURNS = 25;
export const MIRO_AUTHORING_TIMEOUT_MS = 20 * 60_000;
const TOOLS = new Set([
  "list_files",
  "read_file",
  "search_files",
  "write_file",
  "apply_patch",
  "typecheck",
  "render_still",
  "render_video",
  "inspect_media",
]);
type Db = Pick<DatabaseSync, "prepare" | "exec">;
type Image = { mimeType: "image/jpeg" | "image/png" | "image/webp"; data: string };

/** One outstanding request at a time. stdout is exclusively bounded NDJSON;
 * legacy stage notifications are ignored, malformed RPC responses fail closed. */
export function createMiroWorkerRpc(child: ChildProcess, signal: AbortSignal) {
  let sequence = 0;
  let buffer = "";
  let closed = false;
  const decoder = new StringDecoder("utf8");
  let pending:
    | {
        id: string;
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  function fail(error: Error) {
    closed = true;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      pending = undefined;
    }
  }
  function data(chunk: Buffer) {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) {
      fail(new Error("miro_worker_response_too_large"));
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let value: any;
      try {
        value = JSON.parse(line);
      } catch {
        fail(new Error("miro_worker_invalid_ndjson"));
        return;
      }
      if (value.jsonrpc !== "2.0" || value.id === undefined) continue;
      if (!pending || value.id !== pending.id) {
        fail(new Error("miro_worker_response_id_mismatch"));
        return;
      }
      const call = pending;
      pending = undefined;
      clearTimeout(call.timer);
      if (value.error) call.resolve({ error: value.error });
      else if (Object.hasOwn(value, "result")) call.resolve(value.result);
      else {
        call.reject(new Error("miro_worker_response_invalid"));
        closed = true;
      }
    }
  }
  const close = () => fail(new Error("miro_worker_closed"));
  const abort = () => fail(new Error("miro_authoring_cancelled"));
  child.stdout?.on("data", data);
  child.once("close", close);
  child.once("error", fail);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return {
    call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      if (closed || signal.aborted || !child.stdin?.writable)
        return Promise.reject(new Error("miro_worker_unavailable"));
      if (pending) return Promise.reject(new Error("miro_worker_request_in_flight"));
      const id = String(++sequence);
      const encoded = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      if (Buffer.byteLength(encoded) > 1024 * 1024) return Promise.reject(new Error("miro_worker_request_too_large"));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error("miro_worker_tool_timeout")), 300_000);
        pending = { id, resolve, reject, timer };
        child.stdin!.write(encoded, (error) => {
          if (error) fail(new Error("miro_worker_write_failed"));
        });
      });
    },
    dispose() {
      fail(new Error("miro_worker_session_disposed"));
      child.stdout?.off("data", data);
      child.off("close", close);
      child.off("error", fail);
      signal.removeEventListener("abort", abort);
    },
  };
}

export async function runMiroAuthoringSession(input: {
  db: Db;
  taskId: string;
  attemptId: string;
  child: ChildProcess;
  signal?: AbortSignal;
  requestModel?: typeof requestVideoProductionJson;
}): Promise<{ turns: number }> {
  const timeout = AbortSignal.timeout(MIRO_AUTHORING_TIMEOUT_MS);
  const lifetime = new AbortController();
  const signal = AbortSignal.any([timeout, lifetime.signal, ...(input.signal ? [input.signal] : [])]);
  const onWorkerClosed = () => lifetime.abort();
  input.child.once("close", onWorkerClosed);
  input.child.once("error", onWorkerClosed);
  const rpc = createMiroWorkerRpc(input.child, signal);
  const authorize = () => {
    if (signal.aborted) throw new Error("miro_authoring_cancelled_or_timed_out");
    const actor = createTrustedVideoProductionAttemptActor(input.db, input.attemptId, "footage.submit");
    if (actor.taskId !== input.taskId) throw new VideoProductionPolicyError("production_attempt_snapshot_mismatch");
    return actor;
  };
  try {
    const actor = authorize();
    const started = input.db
      .prepare(
        `UPDATE video_production_attempts SET detail_json=json_set(detail_json,'$.authoringTurns',0),updated_at=?
      WHERE attempt_id=? AND task_id=? AND state='RUNNING' AND execution_action='footage.submit'
      AND json_type(detail_json,'$.authoringTurns') IS NULL`,
      )
      .run(Date.now(), input.attemptId, input.taskId);
    if (started.changes !== 1) throw new Error("miro_authoring_session_already_started");
    const job = input.db
      .prepare(
        `SELECT sv.action,sv.camera_json,p.brief_json FROM video_production_stage_jobs j
      JOIN video_productions p ON p.project_id=j.project_id
      JOIN video_production_shot_versions sv ON sv.project_id=j.project_id AND sv.shot_id=j.shot_id AND sv.version=j.shot_version
      WHERE j.task_id=?`,
      )
      .get(input.taskId);
    // SKILL is always read through the same isolated tool boundary as later files.
    const skill = await rpc.call("read_file", { path: "/opt/skills/video-shotcraft/SKILL.md" });
    if (
      !skill ||
      typeof skill !== "object" ||
      !("content" in skill) ||
      typeof skill.content !== "string" ||
      !skill.content ||
      "nextOffset" in skill
    )
      throw new Error("miro_shotcraft_skill_unavailable");
    const history: Array<{ tool: string; arguments?: unknown; result: unknown }> = [
      { tool: "read_file", result: skill },
    ];
    const skillContext = JSON.stringify(skill);
    if (skillContext.length > 24000) throw new Error("miro_shotcraft_entry_skill_context_too_large");
    let preview: Image[] | undefined;
    let rendered = false;
    for (let turn = 1; turn <= MIRO_AUTHORING_MAX_TURNS; turn++) {
      authorize();
      const claim = input.db
        .prepare(
          `UPDATE video_production_attempts SET detail_json=json_set(detail_json,'$.authoringTurns',?),updated_at=?
        WHERE attempt_id=? AND task_id=? AND state='RUNNING' AND execution_action='footage.submit'
        AND json_extract(detail_json,'$.authoringTurns')=?`,
        )
        .run(turn, Date.now(), input.attemptId, input.taskId, turn - 1);
      if (claim.changes !== 1) throw new Error("miro_authoring_turn_claim_lost");
      const { provider, model } = getVideoProductionAgentProvider(input.db, actor.agentId);
      const recent = history.slice(1);
      while (recent.length > 1 && JSON.stringify(recent).length > 26000) recent.shift();
      if (JSON.stringify(recent).length > 26000) {
        const latest = recent[0];
        recent[0] = {
          tool: latest.tool,
          arguments: { omitted: "oversized tool arguments" },
          result: { truncated: true, excerpt: JSON.stringify(latest.result).slice(0, 8000) },
        };
      }
      const prompt = [
        "Author the exact approved shot using video-shotcraft in the isolated workspace. Return one JSON object {tool,arguments} or {done:true}.",
        "Tools: list_files {path}; read_file {path,offset?,limit?} (continue at nextOffset if present); search_files {path,query}; write_file {path,content}; apply_patch {path,oldText,newText}; typecheck {}; render_still {frame}; render_video {}; inspect_media {path}.",
        "Paths are relative to the render project root. The complete read-only skill is /opt/skills/video-shotcraft. assets/lib and demos/_fixtures are already staged. Read selected shot cards and their demo implementations before authoring. Write entry.tsx with Composition id ProductionShot and match approved dimensions/fps/duration from data.json. No shell, network, package installation, publishing or external video generation.",
        "Use typecheck, render_still, inspect the preview and revise before render_video. done is valid only after successful render_video of unchanged source. Finish within the remaining turns. Tool errors may be corrected. Never place credentials or other project data in outputs.",
        `Turn ${turn}/${MIRO_AUTHORING_MAX_TURNS}; approved shot/brief: ${JSON.stringify(job).slice(0, 8000)}`,
        `Shotcraft entry skill (read through worker): ${skillContext}`,
        `Recent tool history (old entries compacted): ${JSON.stringify(recent)}`,
      ].join("\n\n");
      const response = await (input.requestModel ?? requestVideoProductionJson)({
        provider,
        model,
        prompt,
        images: preview,
        authoring: true,
        timeoutMs: 120_000,
        signal,
      });
      authorize();
      preview = undefined;
      if (!response || typeof response !== "object" || Array.isArray(response))
        throw new Error("miro_authoring_response_invalid");
      const action = response as { done?: boolean; tool?: string; arguments?: Record<string, unknown> };
      if (action.done === true) {
        if (!rendered) throw new Error("miro_authoring_render_required");
        const finished = await rpc.call("finish");
        if (finished && typeof finished === "object" && "error" in finished)
          throw new Error("miro_authoring_finish_rejected");
        // finish may immediately close the worker. Ownership was checked before
        // finish; no more provider calls or writable tools follow this boundary.
        input.child.stdin?.end();
        return { turns: turn };
      }
      if (
        !action.tool ||
        !TOOLS.has(action.tool) ||
        !action.arguments ||
        typeof action.arguments !== "object" ||
        Array.isArray(action.arguments)
      )
        throw new Error("miro_authoring_tool_invalid");
      if (turn === MIRO_AUTHORING_MAX_TURNS) throw new Error("miro_authoring_turn_limit");
      const result = await rpc.call(action.tool, action.arguments);
      authorize();
      if (action.tool === "write_file" || action.tool === "apply_patch") rendered = false;
      if (action.tool === "render_video" && !(result && typeof result === "object" && "error" in result))
        rendered = true;
      const record = { tool: action.tool, arguments: action.arguments, result };
      if (result && typeof result === "object") {
        const image = result as { image?: string; mimeType?: Image["mimeType"] };
        if (
          image.image &&
          image.mimeType &&
          image.image.length <= 700000 &&
          ["image/png", "image/jpeg", "image/webp"].includes(image.mimeType)
        ) {
          preview = [{ data: image.image, mimeType: image.mimeType }];
          record.result = { ...result, image: "[preview supplied to model]" };
        }
      }
      history.push(record);
      while (history.length > 10) history.splice(1, 1);
    }
    throw new Error("miro_authoring_turn_limit");
  } finally {
    input.child.off("close", onWorkerClosed);
    input.child.off("error", onWorkerClosed);
    rpc.dispose();
    input.child.stdin?.end();
  }
}
