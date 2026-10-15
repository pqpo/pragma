import { z } from "zod";
import { MissionIdSchema, PayloadHashSchema, JsonValueSchema } from "./primitives.schema.ts";

export const ContentSelectorSchema = z
  .object({
    source: z.enum(["result", "event", "queue"]),
    id: z.string().min(1).max(512),
    fingerprint: PayloadHashSchema,
    start: z.number().int().nonnegative().default(0),
    maxBytes: z.number().int().min(4).max(64_000).default(8_000),
  })
  .strict();
export const MissionContentReferenceSchema = z
  .object({
    schemaVersion: z.literal("pragma.mission-content-reference/v1"),
    missionId: MissionIdSchema,
    source: ContentSelectorSchema.shape.source,
    id: ContentSelectorSchema.shape.id,
    fingerprint: PayloadHashSchema,
    encoding: z.enum(["utf8", "utf8-json"]),
    totalBytes: z.number().int().nonnegative(),
    preview: z.string().max(64_000),
    end: z.number().int().nonnegative(),
  })
  .strict();
export const MissionContentReadSchema = z
  .object({
    schemaVersion: z.literal("pragma.mission-content/v1"),
    missionId: MissionIdSchema,
    source: ContentSelectorSchema.shape.source,
    id: ContentSelectorSchema.shape.id,
    fingerprint: PayloadHashSchema,
    encoding: z.enum(["utf8", "utf8-json"]),
    content: z.string().max(64_000),
    contentRange: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        totalBytes: z.number().int().nonnegative(),
        nextStart: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();
export type ContentSelector = z.infer<typeof ContentSelectorSchema>;
export type MissionContentReference = z.infer<typeof MissionContentReferenceSchema>;
export type MissionContentRead = z.infer<typeof MissionContentReadSchema>;

/** Large otherwise-transient scalar/array events may be persisted for bounded output recovery. */
export const MissionScalarEventDataSchema = z
  .object({
    schemaVersion: z.literal("pragma.mission-event-scalar/v1"),
    value: JsonValueSchema,
  })
  .strict();
