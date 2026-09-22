import { createHash } from "node:crypto";

import { z } from "zod";
import { SecretRefSchema } from "@pragma/shared/integration";

import { CapabilityHealthSchema, CapabilityIdSchema } from "../../../shared/contracts/index.ts";

const LegacyCapabilityMutationJournalStageSchema = z.enum([
  "revision-pending",
  "revision-written",
  "project-propagated",
  "system-experts-propagated",
]);

export const CapabilityMutationJournalV1Schema = z
  .object({
    schemaVersion: z.literal("pragma.capability-revision-propagation/v1"),
    capabilityId: z.string().uuid(),
    targetRevision: z.number().int().positive(),
    stage: LegacyCapabilityMutationJournalStageSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    projectRevision: z.number().int().positive().optional(),
    previousHealth: CapabilityHealthSchema,
  })
  .strict();

export const CapabilityMutationJournalV2Schema = z
  .object({
    schemaVersion: z.literal("pragma.capability-mutation/v2"),
    mutationId: z.string().uuid(),
    mutationType: z.enum(["update", "skill-update", "retry", "bundle-append", "delete"]),
    capabilityId: CapabilityIdSchema,
    baseRevision: z.number().int().nonnegative(),
    targetRevision: z.number().int().positive(),
    targetRevisionRange: z
      .object({ from: z.number().int().positive(), to: z.number().int().positive() })
      .strict(),
    candidateContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    stagingPath: z.string().min(1).optional(),
    stage: LegacyCapabilityMutationJournalStageSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    projectRevision: z.number().int().positive().optional(),
    previousHealth: CapabilityHealthSchema,
    errorCode: z.string().min(1).optional(),
    retryable: z.boolean().optional(),
    propagate: z.boolean().default(true),
    credentialMutation: z
      .object({
        mutationId: z.string().uuid(),
        capabilityId: CapabilityIdSchema,
        previousRefs: z.array(SecretRefSchema),
        nextRefs: z.array(SecretRefSchema),
      })
      .strict()
      .optional(),
    targetHealth: CapabilityHealthSchema.optional(),
  })
  .strict();

export const CapabilityMutationJournalSchema = CapabilityMutationJournalV2Schema.omit({
  projectRevision: true,
  propagate: true,
  schemaVersion: true,
  stage: true,
})
  .extend({
    schemaVersion: z.literal("pragma.capability-mutation/v3"),
    stage: z.enum(["revision-pending", "revision-written"]),
  })
  .strict();

export type CapabilityMutationJournal = z.infer<typeof CapabilityMutationJournalSchema>;

export const capabilityMutationJournalV1ToV2Step = {
  fromVersion: "pragma.capability-revision-propagation/v1",
  toVersion: "pragma.capability-mutation/v2",
  inputSchema: CapabilityMutationJournalV1Schema,
  outputSchema: CapabilityMutationJournalV2Schema,
  migrate(input: unknown): z.infer<typeof CapabilityMutationJournalV2Schema> {
    const legacy = CapabilityMutationJournalV1Schema.parse(input);
    return CapabilityMutationJournalV2Schema.parse({
      schemaVersion: "pragma.capability-mutation/v2",
      mutationId: stableLegacyMutationId(legacy.capabilityId, legacy.targetRevision),
      mutationType: "update",
      capabilityId: legacy.capabilityId,
      baseRevision: legacy.previousHealth.revision,
      targetRevision: legacy.targetRevision,
      targetRevisionRange: { from: legacy.targetRevision, to: legacy.targetRevision },
      candidateContentHash: hashContent(`legacy:${legacy.capabilityId}:${legacy.targetRevision}`),
      stage: legacy.stage,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
      ...(legacy.projectRevision === undefined ? {} : { projectRevision: legacy.projectRevision }),
      previousHealth: legacy.previousHealth,
    });
  },
} as const;

export const capabilityMutationJournalV2ToV3Step = {
  fromVersion: "pragma.capability-mutation/v2",
  toVersion: "pragma.capability-mutation/v3",
  inputSchema: CapabilityMutationJournalV2Schema,
  outputSchema: CapabilityMutationJournalSchema,
  migrate(input: unknown): CapabilityMutationJournal {
    const legacy = CapabilityMutationJournalV2Schema.parse(input);
    const rest: Record<string, unknown> = { ...legacy };
    delete rest["projectRevision"];
    delete rest["propagate"];
    return CapabilityMutationJournalSchema.parse({
      ...rest,
      schemaVersion: "pragma.capability-mutation/v3",
      stage: legacy.stage === "revision-pending" ? "revision-pending" : "revision-written",
    });
  },
} as const;

export const capabilityMutationJournalMigrations = [
  capabilityMutationJournalV1ToV2Step,
  capabilityMutationJournalV2ToV3Step,
] as const;

export function migrateCapabilityMutationJournal(input: unknown): CapabilityMutationJournal {
  const current = CapabilityMutationJournalSchema.safeParse(input);
  if (current.success) return current.data;
  const v2 = CapabilityMutationJournalV2Schema.safeParse(input);
  if (v2.success) return capabilityMutationJournalV2ToV3Step.migrate(v2.data);
  return capabilityMutationJournalV2ToV3Step.migrate(
    capabilityMutationJournalV1ToV2Step.migrate(input),
  );
}

function stableLegacyMutationId(capabilityId: string, revision: number): string {
  const value = createHash("sha256").update(`${capabilityId}:${revision}`).digest("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

function hashContent(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
