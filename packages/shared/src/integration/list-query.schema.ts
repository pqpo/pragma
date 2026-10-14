import { z } from "zod";
import { JsonValueSchema, OpaqueCursorSchema } from "./primitives.schema.ts";

export const ListPageRequestSchema = z
  .object({
    limit: z.number().int().min(1).max(200),
    cursor: OpaqueCursorSchema.optional(),
    maxContentBytes: z.number().int().min(4).max(64_000).optional(),
  })
  .strict();

/** Explicitly paged results, never inferred from an items wrapper. */
export const ListPageResultSchema = z
  .object({
    schemaVersion: z.literal("pragma.list-page/v1"),
    items: z.array(JsonValueSchema),
    nextCursor: OpaqueCursorSchema.optional(),
  })
  .strict();

export type ListPageRequest = z.infer<typeof ListPageRequestSchema>;
export type ListPageResult = z.infer<typeof ListPageResultSchema>;

export const MissionListRequestSchema = ListPageRequestSchema.extend({
  status: z
    .enum([
      "active",
      "completed",
      "queued",
      "running",
      "waiting",
      "succeeded",
      "failed",
      "cancelled",
    ])
    .optional(),
  executor: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
});
export const ExecutorListRequestSchema = ListPageRequestSchema.extend({
  executorKind: z.enum(["expert", "team", "flow"]),
  selector: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  status: z.enum(["ready", "needs_attention", "unavailable"]).optional(),
  project: z.string().min(1).optional(),
});
export type MissionListRequest = z.infer<typeof MissionListRequestSchema>;
export type ExecutorListRequest = z.infer<typeof ExecutorListRequestSchema>;

/** Full 256-bit query and result bindings, plus a 48-bit offset. */
export const IntegrationListCursorSchema = z
  .string()
  .regex(/^p2\.[A-Za-z0-9_-]{94}$/u)
  .max(97);
