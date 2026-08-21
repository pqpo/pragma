import {
  PragmaDiagnosticSchema,
  PragmaExpertIdSchema,
  PragmaForwardCompatibleResourceSchema,
  PragmaLockSchema,
  PragmaProjectChangeSetSchema,
  PragmaResourceRefSchema,
  PragmaExpertTeamResourceSchema,
  PragmaExpertTeamContextVisibilitySchema,
  PragmaContextStoreRefSchema,
  PragmaFlowRunDryEvaluationResourceSchema,
} from "@pragma/interpreter/ast";
import { z } from "zod";

export const PragmaProjectSnapshotSchema = z.object({
  schemaVersion: z.literal("pragma.project-snapshot/v3"),
  projectId: z.string().trim().min(1).max(120),
  revision: z.number().int().nonnegative(),
  compilerVersion: z.string().trim().min(1).optional(),
  resources: z.array(PragmaForwardCompatibleResourceSchema),
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
  resources: z.array(PragmaForwardCompatibleResourceSchema),
});

export const UpsertPragmaResourceSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  resource: PragmaForwardCompatibleResourceSchema,
  requiredUnchangedRefs: z.array(PragmaResourceRefSchema).default([]),
});

const ForwardCompatibleExpertTeamResourceSchema = PragmaForwardCompatibleResourceSchema.refine(
  (resource) => resource.kind === "ExpertTeam",
  "Expected an ExpertTeam resource.",
).transform((resource) => resource as z.infer<typeof PragmaExpertTeamResourceSchema>);

export const DesktopPragmaContextStoreBindingSchema = z
  .object({
    storeId: z.string().trim().min(1).max(200),
    resourceRef: PragmaContextStoreRefSchema,
  })
  .strict();

export const UpsertPragmaExpertTeamSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    resource: ForwardCompatibleExpertTeamResourceSchema,
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
  resource: PragmaForwardCompatibleResourceSchema,
  requiredUnchangedRefs: z.array(PragmaResourceRefSchema).default([]),
});

export const PragmaYamlValidationResultSchema = z.object({
  resource: PragmaForwardCompatibleResourceSchema.optional(),
  diagnostics: z.array(PragmaDiagnosticSchema),
});

const ForwardCompatibleFlowRunDryEvaluationResourceSchema =
  PragmaForwardCompatibleResourceSchema.refine(
    (resource) => resource.kind === "Evaluation" && resource.spec.method.type === "flow-run-dry",
    "Expected a flow-run-dry Evaluation resource.",
  ).transform((resource) => resource as z.infer<typeof PragmaFlowRunDryEvaluationResourceSchema>);

export const RunPragmaEvaluationSchema = z
  .object({
    evaluation: ForwardCompatibleFlowRunDryEvaluationResourceSchema,
  })
  .strict();
