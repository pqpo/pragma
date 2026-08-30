import { z } from "zod";

import { AgentMessageUsageSchema } from "../agent-message.schema.ts";
import {
  EventIdSchema,
  ExecutionIdSchema,
  IsoDateTimeSchema,
  JsonObjectSchema,
  JsonValueSchema,
  MissionIdSchema,
  OpaqueCursorSchema,
} from "./primitives.schema.ts";
import {
  ExecutorReferenceSchema,
  HumanInteractionRequestEnvelopeSchema,
} from "./contracts.schema.ts";
import { IntegrationErrorSchema } from "./error.schema.ts";

/** Status values exposed by the compact Mission summary projection. */
export const MissionSummaryStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
]);

/** Status values exposed by the latest execution result projection. */
export const MissionResultStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "interrupted",
]);

const MissionExecutionSummarySchema = z
  .object({
    id: ExecutionIdSchema,
    status: z.enum([
      "queued",
      "running",
      "waiting",
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
    ]),
  })
  .strict();

const MissionWorkspaceSummarySchema = z.object({ canonicalPath: z.string().min(1) }).strict();

/** Compact, event-free view returned by `mission get --view summary`. */
export const MissionSummarySchema = z
  .object({
    schemaVersion: z.literal("pragma.mission-summary/v1"),
    missionId: MissionIdSchema,
    status: MissionSummaryStatusSchema,
    lifecycleStatus: z.enum(["queued", "active", "completed"]),
    executor: ExecutorReferenceSchema.optional(),
    execution: MissionExecutionSummarySchema.optional(),
    workspace: MissionWorkspaceSummarySchema.optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    eventSequence: z.number().int().nonnegative(),
    cursor: OpaqueCursorSchema,
  })
  .strict();

/** Latest execution view returned by `mission get --view result`. */
export const MissionResultSchema = z
  .object({
    schemaVersion: z.literal("pragma.mission-result/v1"),
    missionId: MissionIdSchema,
    executionId: ExecutionIdSchema.optional(),
    status: MissionResultStatusSchema,
    available: z.boolean(),
    result: JsonValueSchema.optional(),
    usage: AgentMessageUsageSchema.optional(),
    occurredAt: IsoDateTimeSchema.optional(),
    interaction: HumanInteractionRequestEnvelopeSchema.optional(),
    error: IntegrationErrorSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.available && value.status !== "succeeded") {
      context.addIssue({
        code: "custom",
        path: ["available"],
        message: "Only a succeeded Mission result can be available.",
      });
    }
    if (value.status === "succeeded" && value.result === undefined) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "A succeeded Mission result must include result data.",
      });
    }
    if (value.status !== "succeeded" && value.result !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "A non-succeeded Mission result must not include result data.",
      });
    }
    if (value.status === "failed" && value.error === undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "A failed Mission result must include an error.",
      });
    }
    if (value.status !== "failed" && value.error !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Only a failed Mission result can include an error.",
      });
    }
  });

/** One durable Mission event in the paged events projection. */
export const MissionEventViewItemSchema = z
  .object({
    schemaVersion: z.literal("pragma.local-host-mission-event/v1"),
    eventId: EventIdSchema,
    missionId: MissionIdSchema,
    sequence: z.number().int().positive(),
    occurredAt: IsoDateTimeSchema,
    type: z.string().min(1),
    data: JsonObjectSchema,
  })
  .strict();

/** Paged event view returned by `mission get --view events`. */
export const MissionEventsSchema = z
  .object({
    schemaVersion: z.literal("pragma.mission-events/v1"),
    missionId: MissionIdSchema,
    items: z.array(MissionEventViewItemSchema),
    nextCursor: OpaqueCursorSchema.optional(),
  })
  .strict();

export type MissionSummary = z.infer<typeof MissionSummarySchema>;
export type MissionResult = z.infer<typeof MissionResultSchema>;
export type MissionEventViewItem = z.infer<typeof MissionEventViewItemSchema>;
export type MissionEvents = z.infer<typeof MissionEventsSchema>;
