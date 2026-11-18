import { z } from "zod";
import { VideoProductionSceneContentSchema } from "./video-production-registry.ts";
import { VIENEU_SPEED_MAX, VIENEU_SPEED_MIN, VIENEU_VOICES } from "./vieneu-speech.ts";

export const HaruScreenplayOutputSchema = z.object({
  title: z.string().trim().min(1).max(240),
  logline: z.string().trim().min(1).max(2000),
  screenplay: z.string().trim().min(1).max(48_000),
  scenes: z.array(z.object({
    sceneId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    content: VideoProductionSceneContentSchema,
  }).strict()).min(1).max(40),
}).strict();

export const CreativeReviewOutputSchema = z.object({
  decision: z.enum(["approved", "changes_requested"]),
  feedback: z.string().trim().min(1).max(5000),
}).strict();

export const FinalQaOutputSchema = z.object({
  decision: z.enum(["approved", "changes_requested"]),
  feedback: z.string().trim().min(1).max(5000),
  issues: z.array(z.object({
    scope: z.enum(["shot", "audio", "subtitle", "continuity", "technical", "other"]),
    shotId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
    timeMs: z.number().int().min(0).max(600_000).optional(),
    detail: z.string().trim().min(1).max(1500),
  }).strict()).max(100),
}).strict().superRefine((value, context) => {
  if (value.decision === "changes_requested" && value.issues.length === 0) {
    context.addIssue({ code: "custom", message: "QA changes must identify at least one targeted defect", path: ["issues"] });
  }
});

export const ShotSpecOutputSchema = z.object({
  scenes: z.array(z.object({
    sceneId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    shots: z.array(z.object({
      shotId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      action: z.string().trim().min(1).max(2000),
      camera: z.record(z.string(), z.unknown()).default({}),
      durationMs: z.number().int().min(500).max(60_000),
      required: z.boolean().default(true),
    }).strict()).min(1).max(12),
  }).strict()).min(1).max(40),
}).strict();

export const ContinuityPackageOutputSchema = z.object({
  notes: z.array(z.object({
    scope: z.enum(["character", "location", "prop", "color", "camera"]),
    subject: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(2000),
    sceneIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).min(1).max(40),
  }).strict()).min(1).max(100),
  referenceRequests: z.array(z.object({
    referenceType: z.enum(["character", "location", "prop", "style"]),
    subject: z.string().trim().min(1).max(120),
    brief: z.string().trim().min(1).max(1000),
  }).strict()).max(50),
}).strict();

export const TimelinePlanOutputSchema = z.object({
  shots: z.array(z.object({
    shotId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    shotVersion: z.number().int().positive(),
    durationMs: z.number().int().min(500).max(60_000),
    transitionAfter: z.enum(["cut", "crossfade"]).default("cut"),
    transitionDurationMs: z.number().int().min(0).max(2000).default(0),
    subtitleText: z.string().max(2000).default(""),
  }).strict()).min(1).max(120),
}).strict();

export const AudioScriptOutputSchema = z.object({
  narration: z.string().trim().min(1).max(40_000),
  voice: z.enum(VIENEU_VOICES),
  speed: z.number().min(VIENEU_SPEED_MIN).max(VIENEU_SPEED_MAX).default(1),
}).strict();

export type HaruScreenplayOutput = z.infer<typeof HaruScreenplayOutputSchema>;
export type CreativeReviewOutput = z.infer<typeof CreativeReviewOutputSchema>;
export type ShotSpecOutput = z.infer<typeof ShotSpecOutputSchema>;
export type ContinuityPackageOutput = z.infer<typeof ContinuityPackageOutputSchema>;
export type TimelinePlanOutput = z.infer<typeof TimelinePlanOutputSchema>;
export type AudioScriptOutput = z.infer<typeof AudioScriptOutputSchema>;
