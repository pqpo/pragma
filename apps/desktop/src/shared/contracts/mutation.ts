import { PragmaDiagnosticSchema, PragmaResourceRefSchema } from "@pragma/interpreter/ast";
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

export const DesktopMutationErrorSchema = z
  .object({
    code: z.string().trim().min(1).max(100),
    message: z.string().min(1).max(10_000),
    diagnostics: z.array(PragmaDiagnosticSchema).default([]),
    conflict: DesktopMutationConflictSchema.optional(),
    revisionFailure: DesktopProjectRevisionFailureSchema.optional(),
  })
  .strict();

export const DesktopMutationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: DesktopMutationErrorSchema }).strict(),
]);

export type DesktopMutationErrorData = z.infer<typeof DesktopMutationErrorSchema>;

export class DesktopMutationError extends Error {
  readonly code: string;
  readonly diagnostics: DesktopMutationErrorData["diagnostics"];
  readonly conflict: DesktopMutationErrorData["conflict"];
  readonly revisionFailure: DesktopMutationErrorData["revisionFailure"];

  constructor(input: DesktopMutationErrorData) {
    super(input.message);
    this.name = "DesktopMutationError";
    this.code = input.code;
    this.diagnostics = input.diagnostics;
    this.conflict = input.conflict;
    this.revisionFailure = input.revisionFailure;
  }
}
