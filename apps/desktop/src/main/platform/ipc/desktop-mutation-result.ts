import { z } from "zod";

import {
  DesktopMutationErrorSchema,
  DesktopMutationResultSchema,
  type DesktopMutationErrorData,
} from "../../../shared/contracts/index.ts";
import { ExpertDefinitionStoreError } from "../../features/experts/expert-definition-store.ts";
import { MissionOperationError } from "../../features/missions/mission-operation-error.ts";
import {
  PragmaProjectRevisionUnavailableError,
  PragmaProjectStoreError,
} from "../../features/projects/pragma-project-store.ts";

export async function runDesktopMutation<T>(
  operation: () => Promise<T>,
): Promise<ReturnType<typeof DesktopMutationResultSchema.parse>> {
  try {
    return DesktopMutationResultSchema.parse({ ok: true, value: await operation() });
  } catch (error) {
    return DesktopMutationResultSchema.parse({
      ok: false,
      error: serializeDesktopMutationError(error),
    });
  }
}

function serializeDesktopMutationError(error: unknown): DesktopMutationErrorData {
  if (error instanceof PragmaProjectRevisionUnavailableError) {
    return DesktopMutationErrorSchema.parse({
      code: error.code,
      message: error.message,
      diagnostics: error.diagnostics,
      revisionFailure: {
        projectId: error.projectId,
        revision: error.revision,
        stage: error.stage,
        ...(error.sourceCompilerVersion === undefined
          ? {}
          : { sourceCompilerVersion: error.sourceCompilerVersion }),
        ...(error.targetCompilerVersion === undefined
          ? {}
          : { targetCompilerVersion: error.targetCompilerVersion }),
        retryable: error.retryable,
      },
    });
  }
  if (error instanceof PragmaProjectStoreError) {
    return DesktopMutationErrorSchema.parse({
      code: error.code,
      message: error.message,
      diagnostics: error.diagnostics,
      ...(error.conflict === undefined ? {} : { conflict: error.conflict }),
      ...(error.referencedBy.length === 0 ? {} : { referencedBy: error.referencedBy }),
    });
  }
  if (error instanceof ExpertDefinitionStoreError) {
    return DesktopMutationErrorSchema.parse({
      code: error.code,
      message: error.message,
      diagnostics: [],
    });
  }
  if (error instanceof MissionOperationError) {
    return DesktopMutationErrorSchema.parse({
      code: error.code,
      message: error.message,
      diagnostics: [],
    });
  }
  if (error instanceof z.ZodError) {
    return DesktopMutationErrorSchema.parse({
      code: "invalid_request",
      message: error.issues[0]?.message ?? "The request is invalid.",
      diagnostics: [],
    });
  }
  return DesktopMutationErrorSchema.parse({
    code: "internal_error",
    message: error instanceof Error ? error.message : String(error),
    diagnostics: [],
  });
}
