import { z } from "zod";

import {
  DesktopMutationErrorSchema,
  DesktopMutationResultSchema,
  type DesktopMutationErrorData,
} from "../../../shared/contracts/index.ts";
import { IntegrationErrorSchema } from "@pragma/shared/integration";
import { ExpertDefinitionStoreError } from "../../features/experts/expert-definition-store.ts";
import { MissionStoreError } from "../../features/missions/mission-store.ts";
import { BundleSetupRequiredError } from "../../features/bundles/pragma-bundle-errors.ts";
import { CapabilityStoreError } from "../../features/capabilities/capability-store.ts";
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
  const integrationError = IntegrationErrorSchema.safeParse(error);
  if (integrationError.success) {
    return DesktopMutationErrorSchema.parse({
      code: integrationError.data.code,
      message: integrationError.data.message,
      category: integrationError.data.category,
      retryable: integrationError.data.retryable,
      ...(integrationError.data.details === undefined
        ? {}
        : { details: integrationError.data.details }),
      ...(integrationError.data.causeId === undefined
        ? {}
        : { causeId: integrationError.data.causeId }),
      diagnostics: [],
    });
  }
  if (error instanceof BundleSetupRequiredError) {
    return DesktopMutationErrorSchema.parse({
      code: error.code,
      message: error.message,
      diagnostics: [],
      bundleSetup: {
        rootRef: error.rootRef,
        operation: error.operation,
        ...(error.installationId === undefined ? {} : { installationId: error.installationId }),
        dependencies: error.dependencies,
      },
    });
  }
  if (error instanceof CapabilityStoreError) {
    return DesktopMutationErrorSchema.parse({
      code: error.code,
      message: error.message,
      diagnostics: [],
    });
  }
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
  if (error instanceof MissionStoreError) {
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
