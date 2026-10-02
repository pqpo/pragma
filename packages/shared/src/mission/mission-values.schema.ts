import { z } from "zod";

import { SemanticResourceIdSchema } from "../integration/primitives.schema.ts";

/** Mission bindings still accept UUID identities written before semantic resource IDs. */
const MissionCapabilityIdSchema = z.union([SemanticResourceIdSchema, z.string().uuid()]);

export const MissionWorkspaceSchema = z.object({
  path: z.string().trim().min(1).max(2_000),
  basename: z.string().trim().min(1).max(255),
});

export const MissionModelOverrideSchema = z
  .object({
    providerId: z.string().trim().min(1).max(200),
    modelId: z.string().trim().min(1).max(200),
    thinkingLevel: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const MissionLifecycleStatusSchema = z.enum(["active", "completed"]);

export const MissionExecutionBindingSchema = z.object({
  id: z.string().uuid(),
  inputMessageId: z.string().uuid(),
  sessionId: z.string().uuid().optional(),
  status: z.enum(["queued", "running", "waiting", "succeeded", "failed", "cancelled"]),
  waitReason: z.enum(["experts", "human_input"]).optional(),
  contextMountsFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  environmentFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  resolvedCapabilities: z
    .array(
      z
        .object({
          capabilityId: MissionCapabilityIdSchema,
          resolvedRevision: z.number().int().positive(),
          fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    )
    .optional(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  error: z.string().max(10_000).optional(),
});

export const MissionContextMountSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("context-store"), storeId: z.string().uuid() }).strict(),
  z
    .object({
      kind: z.literal("context-store-draft"),
      draftId: z.string().uuid(),
      revisionJobId: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("skill-revision-draft"),
      draftId: z.string().uuid(),
      revisionJobId: z.string().uuid(),
      capabilityId: MissionCapabilityIdSchema,
    })
    .strict(),
]);

export const MissionContextMountsSchema = z
  .array(MissionContextMountSchema)
  .max(200)
  .superRefine((mounts, context) => {
    const seen = new Set<string>();
    for (const [index, mount] of mounts.entries()) {
      const identity =
        mount.kind === "context-store"
          ? `store:${mount.storeId}`
          : `${mount.kind}:${mount.draftId}`;
      if (seen.has(identity)) {
        context.addIssue({
          code: "custom",
          message: "Mission Context mounts must be unique.",
          path: [index],
        });
      }
      seen.add(identity);
    }
  });

export type MissionWorkspace = z.infer<typeof MissionWorkspaceSchema>;
export type MissionModelOverride = z.infer<typeof MissionModelOverrideSchema>;
export type MissionLifecycleStatus = z.infer<typeof MissionLifecycleStatusSchema>;
export type MissionExecutionBinding = z.infer<typeof MissionExecutionBindingSchema>;
export type MissionContextMount = z.infer<typeof MissionContextMountSchema>;
export type MissionContextMounts = z.infer<typeof MissionContextMountsSchema>;
