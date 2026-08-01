import {
  EffectiveMemoryPolicySchema,
  MemoryAssetPolicyOverrideSchema,
  MemoryGlobalPolicySchema,
  MemoryModuleDiagnosticSchema,
  MemorySubjectRefSchema,
} from "@pragma/shared";
import { z } from "zod";

export const DesktopMemoryPolicyTargetSchema = MemorySubjectRefSchema.refine(
  (target) =>
    target.type === "pragma.expert" ||
    target.type === "pragma.expert-team" ||
    target.type === "pragma.flow",
  "Memory policy target must be an Expert, ExpertTeam, or Flow.",
);

export const DesktopGlobalMemoryPolicySnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  effectiveFrom: z.string().datetime(),
  policy: MemoryGlobalPolicySchema,
});

export const DesktopAssetMemoryPolicySnapshotSchema = z.object({
  targetRef: DesktopMemoryPolicyTargetSchema,
  revision: z.number().int().nonnegative(),
  effectiveFrom: z.string().datetime(),
  policy: MemoryAssetPolicyOverrideSchema,
  effective: EffectiveMemoryPolicySchema,
});

export const UpdateDesktopGlobalMemoryPolicySchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  policy: MemoryGlobalPolicySchema,
});

export const GetDesktopAssetMemoryPolicySchema = z.object({
  targetRef: DesktopMemoryPolicyTargetSchema,
});

export const UpdateDesktopAssetMemoryPolicySchema = z.object({
  targetRef: DesktopMemoryPolicyTargetSchema,
  expectedRevision: z.number().int().nonnegative(),
  policy: MemoryAssetPolicyOverrideSchema,
});

export const DesktopMemoryPlaneStatusSchema = z.object({
  state: z.enum(["running", "stopped", "degraded"]),
  feed: z.object({
    lastSequence: z.number().int().nonnegative(),
    eventCount: z.number().int().nonnegative(),
  }),
  delivery: z.object({
    pending: z.number().int().nonnegative(),
    quarantined: z.number().int().nonnegative(),
  }),
  lastError: z
    .object({
      code: z.string().min(1),
      occurredAt: z.iso.datetime(),
    })
    .optional(),
  modules: z.array(MemoryModuleDiagnosticSchema),
});
