import {
  PragmaDiagnosticSchema,
  PragmaExpertIdSchema,
  PragmaLockSchema,
  PragmaProjectChangeSetSchema,
  PragmaResourceRefSchema,
  PragmaResourceSchema,
  PragmaExpertTeamResourceSchema,
  PragmaExpertTeamContextVisibilitySchema,
  PragmaContextStoreRefSchema,
} from "@pragma/interpreter/ast";
import { PragmaEvaluationResourceSchema } from "@pragma/evaluation/ast";
import { z } from "zod";

export const PragmaProjectSnapshotSchema = z.object({
  schemaVersion: z.literal("pragma.project-snapshot/v3"),
  projectId: z.string().trim().min(1).max(120),
  revision: z.number().int().nonnegative(),
  compilerVersion: z.string().trim().min(1).optional(),
  resources: z.array(PragmaResourceSchema),
  diagnostics: z.array(PragmaDiagnosticSchema),
  lock: PragmaLockSchema.optional(),
  projectFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  updatedAt: z.string().datetime().optional(),
});

export const PublishPragmaProjectSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  resources: z.array(PragmaResourceSchema),
});

export const UpsertPragmaResourceSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  resource: PragmaResourceSchema,
  requiredUnchangedRefs: z.array(PragmaResourceRefSchema).default([]),
});

export const DesktopPragmaContextStoreBindingSchema = z
  .object({
    storeId: z.string().trim().min(1).max(200),
    resourceRef: PragmaContextStoreRefSchema,
  })
  .strict();

export const UpsertPragmaExpertTeamSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    resource: PragmaExpertTeamResourceSchema,
    contextStores: z.array(
      z
        .object({
          storeId: z.string().trim().min(1).max(200),
          visibility: PragmaExpertTeamContextVisibilitySchema,
        })
        .strict(),
    ),
    requiredUnchangedRefs: z.array(PragmaResourceRefSchema).default([]),
  })
  .strict();

export const AllocatePragmaResourceIdResultSchema = z.object({
  id: PragmaExpertIdSchema,
});

export const PragmaProjectChangesSchema = PragmaProjectChangeSetSchema;

export const PragmaProjectChangesValidationResultSchema = z
  .object({
    diagnostics: z.array(PragmaDiagnosticSchema),
  })
  .strict();

export const DeletePragmaResourceSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  ref: PragmaResourceRefSchema,
});

export const ValidatePragmaYamlSchema = z.object({ source: z.string().max(2_000_000) });

export const ValidatePragmaResourceSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  resource: PragmaResourceSchema,
  requiredUnchangedRefs: z.array(PragmaResourceRefSchema).default([]),
});

export const PragmaYamlValidationResultSchema = z.object({
  resource: PragmaResourceSchema.optional(),
  diagnostics: z.array(PragmaDiagnosticSchema),
});

export const RunPragmaEvaluationSchema = z
  .object({
    evaluation: PragmaEvaluationResourceSchema,
  })
  .strict();
