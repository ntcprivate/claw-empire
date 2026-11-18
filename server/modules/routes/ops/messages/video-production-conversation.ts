import type { DatabaseSync } from "node:sqlite";
import type { Response } from "express";
import { getVideoProduction, saveVideoProductionPlan } from "../../../workflow/video-production.ts";
import { respondVideoProductionError } from "../../core/video-production.ts";
import type { VideoProductionSnapshot } from "../../../../../shared/video-production.ts";

// A structured brief reply uses the existing conversation transport. Free-form
// discussion is still handled by the normal agent conversation; it is never approval.
export function trySaveVideoProductionBriefReply(
  db: DatabaseSync,
  res: Response,
  input: {
    projectId: string | null;
    agentId: string;
    content: string;
    messageId: string;
    onSaved?: (production: VideoProductionSnapshot) => void;
  },
): boolean {
  if (!input.projectId || !/^\s*\[VIDEO_BRIEF\]/i.test(input.content)) return false;
  const production = getVideoProduction(db, input.projectId);
  if (!production || production.manager_agent_id !== input.agentId) return false;
  let reply: unknown;
  try {
    reply = JSON.parse(input.content.replace(/^\s*\[VIDEO_BRIEF\]\s*/i, ""));
  } catch {
    res.status(400).json({ error: "invalid_video_brief_reply_json" });
    return true;
  }
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) {
    res.status(400).json({ error: "invalid_video_brief_reply" });
    return true;
  }
  const body = reply as Record<string, unknown>;
  if (!body.brief || typeof body.brief !== "object" || Array.isArray(body.brief)) {
    res.status(400).json({ error: "invalid_brief" });
    return true;
  }
  try {
    const updated = saveVideoProductionPlan(db, input.projectId, {
      brief: { ...production.brief, ...body.brief },
      expectedVersion: body.expectedVersion as number,
      actorId: "ceo_conversation",
    });
    input.onSaved?.(updated);
    res.json({ ok: true, id: input.messageId, production: updated });
  } catch (error) {
    respondVideoProductionError(res, error);
  }
  return true;
}
