import { z } from "zod";

export const VideoProductionSceneContentSchema = z.object({
  description: z.string().trim().min(1).max(5000),
  location: z.string().trim().min(1).max(500),
  characters: z.array(z.string().trim().min(1).max(160)).max(64),
  continuity: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const VideoProductionShotContentSchema = z.object({
  action: z.string().trim().min(1).max(3000),
  camera: z.record(z.string(), z.unknown()).default({}),
  durationMs: z.number().int().min(100).max(10 * 60 * 1000),
  required: z.boolean().default(true),
}).strict();

export const VideoProductionTakeMetadataSchema = z.object({
  model: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(12000),
  generationParameters: z.record(z.string(), z.unknown()).default({}),
  reportedValidation: z.object({
    width: z.number().int().positive().max(16384).optional(),
    height: z.number().int().positive().max(16384).optional(),
    frameRate: z.number().positive().max(240).optional(),
    durationMs: z.number().int().positive().max(10 * 60 * 1000).optional(),
  }).strict().default({}),
}).strict();

export const VideoProductionVisualReferenceSchema = z.object({
  referenceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  referenceType: z.enum(["character", "location", "style", "continuity"]),
  name: z.string().trim().min(1).max(240),
  metadata: z.record(z.string(), z.unknown()).default({}),
  ownerShotId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable().default(null),
}).strict();

export const VideoProductionAssetMetadataSchema = z.object({
  label: z.string().trim().min(1).max(240),
  technicalMetadata: z.object({
    width: z.number().int().positive().max(16384).optional(),
    height: z.number().int().positive().max(16384).optional(),
    frameRate: z.number().positive().max(240).optional(),
    durationMs: z.number().int().positive().max(10 * 60 * 1000).optional(),
    channels: z.number().int().positive().max(64).optional(),
    sampleRateHz: z.number().int().positive().max(768000).optional(),
  }).strict().default({}),
}).strict();

export const VideoProductionReferenceLinkSchema = z.object({
  referenceKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  referenceType: z.enum(["continuity", "visual", "shot_dependency"]),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("shot"), shotId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), version: z.number().int().positive() }).strict(),
    z.object({ kind: z.literal("asset"), assetId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict(),
    z.object({ kind: z.literal("visual_reference"), referenceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), version: z.number().int().positive() }).strict(),
  ]),
}).strict();

export type VideoProductionSceneContent = z.infer<typeof VideoProductionSceneContentSchema>;
export type VideoProductionShotContent = z.infer<typeof VideoProductionShotContentSchema>;
export type VideoProductionTakeMetadata = z.infer<typeof VideoProductionTakeMetadataSchema>;
export type VideoProductionAssetMetadata = z.infer<typeof VideoProductionAssetMetadataSchema>;
export type VideoProductionReferenceLink = z.infer<typeof VideoProductionReferenceLinkSchema>;
