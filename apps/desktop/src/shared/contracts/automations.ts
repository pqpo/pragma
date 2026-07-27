import {
  PragmaAutomationRefSchema,
  PragmaAutomationResourceSchema,
  PragmaScheduleTriggerSchema,
} from "@pragma/interpreter/ast";
import { z } from "zod";

import {
  MissionIdSchema,
  MissionModelOverrideSchema,
  MissionWorkspaceSchema,
} from "./mission-base.ts";
import { DesktopToolPermissionModeSchema } from "./settings.ts";

export const AutomationBindingSchema = z
  .object({
    schemaVersion: z.literal("pragma.automation-binding/v2"),
    automationRef: PragmaAutomationRefSchema,
    revision: z.number().int().positive(),
    generation: z.string().uuid(),
    workspace: MissionWorkspaceSchema,
    placement: z.literal("desktop"),
    toolPermissionMode: DesktopToolPermissionModeSchema,
    modelOverride: MissionModelOverrideSchema.optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const AutomationRunRecordSchema = z
  .object({
    eventId: z.string().min(1).max(500),
    scheduledFor: z.string().datetime(),
    status: z.enum(["queued", "dispatched", "skipped", "failed"]),
    missionId: MissionIdSchema.optional(),
    error: z.string().max(10_000).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const AutomationSummarySchema = z
  .object({
    ref: z.string().min(1),
    resource: PragmaAutomationResourceSchema,
    binding: AutomationBindingSchema.optional(),
    status: z.enum(["scheduled", "disabled", "expired", "needs_attention"]),
    nextRunAt: z.string().datetime().optional(),
    missionId: MissionIdSchema.optional(),
    queueDepth: z.number().int().nonnegative(),
    lastRun: AutomationRunRecordSchema.optional(),
    diagnostic: z.string().max(4_000).optional(),
  })
  .strict();

export const SaveAutomationSchema = z
  .object({
    expectedProjectRevision: z.number().int().nonnegative(),
    resource: PragmaAutomationResourceSchema,
    binding: z
      .object({
        workspace: z.string().trim().min(1).max(2_000),
        toolPermissionMode: DesktopToolPermissionModeSchema,
        modelOverride: MissionModelOverrideSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const DeleteAutomationSchema = z
  .object({
    expectedProjectRevision: z.number().int().nonnegative(),
    ref: PragmaAutomationRefSchema,
  })
  .strict();

export const AutomationActionSchema = z.object({ ref: DeleteAutomationSchema.shape.ref }).strict();

export const PreviewAutomationScheduleSchema = z
  .object({
    trigger: PragmaScheduleTriggerSchema,
    from: z.string().datetime().optional(),
    count: z.number().int().min(1).max(10).default(5),
  })
  .strict();

export const AutomationSchedulePreviewSchema = z
  .object({
    occurrences: z.array(z.string().datetime()).max(10),
  })
  .strict();

export const AutomationAdapterOptionSchema = z
  .object({
    ref: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    sourceMode: z.enum(["signal", "conversation"]),
    placement: z.enum(["desktop", "server", "either"]),
    requiresConnection: z.boolean(),
    supportsSessionReuse: z.boolean(),
  })
  .strict();
