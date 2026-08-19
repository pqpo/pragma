import {
  PragmaDiagnosticSchema,
  PragmaResourceRefSchema,
  PragmaSemanticResourceRefSchema,
} from "@pragma/interpreter/ast";
import { PragmaBundleDependencyReadinessSchema } from "./bundles.ts";
import { z } from "zod";

export const DesktopMutationConflictSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    currentRevision: z.number().int().nonnegative(),
    conflictingRefs: z.array(PragmaResourceRefSchema),
    retryable: z.boolean(),
  })
  .strict();

export const DesktopProjectRevisionFailureSchema = z
  .object({
    projectId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    stage: z.enum(["manifest", "compiler-migration", "validation", "io"]),
    sourceCompilerVersion: z.string().min(1).optional(),
    targetCompilerVersion: z.string().min(1).optional(),
    retryable: z.boolean(),
  })
  .strict();

export const DesktopMutationReferencedResourceSchema = z
  .object({
    ref: PragmaSemanticResourceRefSchema,
    name: z.string().min(1).max(1_000),
  })
  .strict();

export const DesktopBundleSetupErrorSchema = z
  .object({
    rootRef: z.string().trim().min(1).max(500),
    operation: z.enum(["create_mission", "run_mission"]),
    installationId: z.string().uuid().optional(),
    dependencies: z.array(PragmaBundleDependencyReadinessSchema),
  })
  .strict();

export const DesktopMutationErrorSchema = z
  .object({
    code: z.string().trim().min(1).max(100),
    message: z.string().min(1).max(10_000),
    diagnostics: z.array(PragmaDiagnosticSchema).default([]),
    conflict: DesktopMutationConflictSchema.optional(),
    revisionFailure: DesktopProjectRevisionFailureSchema.optional(),
    referencedBy: z.array(DesktopMutationReferencedResourceSchema).optional(),
    bundleSetup: DesktopBundleSetupErrorSchema.optional(),
  })
  .strict();

export const DesktopMutationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: DesktopMutationErrorSchema }).strict(),
]);

export type DesktopMutationErrorData = z.infer<typeof DesktopMutationErrorSchema>;
export type DesktopMutationReferencedResource = z.infer<
  typeof DesktopMutationReferencedResourceSchema
>;
