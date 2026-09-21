import { z } from "zod";

import { CapabilityIdSchema } from "../../../../../../shared/contracts/index.ts";

const MAX_CONFLICT_SUMMARY_FILES = 1_000;

const StoredSummaryV1Schema = z
  .object({
    fingerprint: z.string().min(1).max(128),
    exists: z.boolean(),
    name: z.string().trim().min(1).max(120).optional(),
    files: z.array(z.string().min(1).max(2_000)).max(MAX_CONFLICT_SUMMARY_FILES),
  })
  .strict();

const StoredPortableFilesV1Schema = z
  .object({
    capabilityId: CapabilityIdSchema,
    capabilityRevision: z.number().int().positive(),
    capabilityContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(2_000),
            executable: z.boolean(),
            sha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/u)
              .optional(),
          })
          .strict(),
      )
      .max(MAX_CONFLICT_SUMMARY_FILES),
  })
  .strict();

const PendingRemoteActivationV1Schema = z
  .object({
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(2_000),
            executable: z.boolean(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict(),
      )
      .max(MAX_CONFLICT_SUMMARY_FILES),
  })
  .strict();

export const SkillSyncStateV1Schema = z
  .object({
    schemaVersion: z.literal("pragma.skill-sync-state/v1"),
    sourceKey: z.string().min(1).max(4_000).optional(),
    revision: z.string().optional(),
    resolvedBranch: z.string().optional(),
    syncedAt: z.string().datetime().optional(),
    bases: z.record(z.string(), z.string()),
    portableFiles: z.record(z.string(), StoredPortableFilesV1Schema).default({}),
    pendingRemoteActivations: z.record(z.string(), PendingRemoteActivationV1Schema).default({}),
    ignoredRemote: z.array(z.object({ syncKey: z.string(), name: z.string() }).strict()),
    conflicts: z.record(
      z.string(),
      z
        .object({
          remoteRevision: z.string().min(1),
          local: StoredSummaryV1Schema,
          remote: StoredSummaryV1Schema,
        })
        .strict(),
    ),
    errors: z.record(
      z.string(),
      z
        .object({
          source: z.enum(["local", "remote"]),
          code: z.string().min(1),
          message: z.string().min(1).max(2_000),
          name: z.string().trim().min(1).max(120).optional(),
          capabilityId: CapabilityIdSchema.optional(),
        })
        .strict(),
    ),
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
  })
  .strict();

export type SkillSyncStateV1 = z.infer<typeof SkillSyncStateV1Schema>;
