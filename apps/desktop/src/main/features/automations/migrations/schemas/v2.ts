import { PragmaAutomationRefSchema } from "@pragma/interpreter/ast";
import { z } from "zod";

import { MissionModelOverrideSchema, MissionWorkspaceSchema } from "@pragma/shared";
import { MissionContextMountsSchema } from "@pragma/shared";
import { DesktopToolPermissionModeSchema } from "@pragma/local-host/deployment-contracts";

export const AutomationBindingV2Schema = z
  .object({
    schemaVersion: z.literal("pragma.automation-binding/v2"),
    automationRef: PragmaAutomationRefSchema,
    revision: z.number().int().positive(),
    generation: z.string().uuid(),
    workspace: MissionWorkspaceSchema,
    placement: z.literal("desktop"),
    toolPermissionMode: DesktopToolPermissionModeSchema,
    modelOverride: MissionModelOverrideSchema.optional(),
    contextMounts: MissionContextMountsSchema.refine(
      (mounts) => mounts.every((mount) => mount.kind === "context-store"),
      "Automation bindings may only mount published Context Stores.",
    ).default([]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
