import { z } from "zod";

// Historical unversioned envelopes; their embedded DSL apiVersion is the storage generation.
const diagnostic = z.object({
  severity: z.enum(["incomplete", "warning", "error"]),
  code: z.string().min(1),
  message: z.string().min(1),
  path: z.array(z.union([z.string(), z.number()])).default([]),
});
const draft = z.object({
  draftId: z.string().uuid(),
  baseProjectRevision: z.number().int().nonnegative(),
  draftRevision: z.number().int().nonnegative(),
  resource: z.unknown(),
  diagnostics: z.array(diagnostic),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
const evaluation = draft.extend({ sourceEvaluationRef: z.string().optional() });
const changeSet = z.object({
  changeSetId: z.string().uuid(),
  projectRevision: z.number().int().nonnegative(),
  diagnostics: z.array(z.unknown()),
  changes: z.array(
    z.object({
      ref: z.string().min(1),
      kind: z.enum(["created", "updated"]),
      source: z.string().min(1),
    }),
  ),
  review: z.unknown().optional(),
  createdAt: z.string().datetime(),
});
export const historicalAuthoringSchemas = {
  flow: draft,
  evaluation,
  candidate: z
    .object({
      changeSet,
      resources: z.array(z.unknown()),
      dslDraftId: z.string().uuid().optional(),
      dslDraftMissionId: z.string().uuid().optional(),
    })
    .refine(
      (value) => (value.dslDraftId === undefined) === (value.dslDraftMissionId === undefined),
    ),
  "flow-mutation": z
    .object({
      schemaVersion: z.literal("pragma.flow-command-mutation/v1"),
      expectedDraftRevision: z.number().int().nonnegative(),
      draft,
    })
    .strict(),
  "evaluation-mutation": z
    .object({
      schemaVersion: z.literal("pragma.evaluation-command-mutation/v1"),
      expectedDraftRevision: z.number().int().nonnegative(),
      draft: evaluation,
    })
    .strict(),
} as const;
