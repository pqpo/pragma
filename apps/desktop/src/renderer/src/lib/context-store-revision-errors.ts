import { errorMessage } from "./errors.ts";

export function localizedContextStoreRevisionError(
  error: unknown,
  translate: (key: string, options?: Record<string, unknown>) => string,
): string {
  const details = readErrorDetails(error);
  const message = details.message;

  if (
    details.code === "model_not_configured" ||
    /built-in runtime has no configured model|no configured model|no model is configured/iu.test(
      message,
    )
  ) {
    return translate("revisionErrorModelNotConfigured");
  }
  if (
    details.code === "model_unavailable" ||
    /runtime model is unavailable|model provider is not registered|unknown .* model/iu.test(message)
  ) {
    return translate("revisionErrorModelUnavailable");
  }
  if (
    details.code === "runtime_unavailable" ||
    /runtime (?:environment )?(?:is not active|is unavailable)|runtime does not expose/iu.test(
      message,
    )
  ) {
    return translate("revisionErrorRuntimeUnavailable");
  }
  if (details.code === "timeout" || /timed out|\btimeout\b/iu.test(message)) {
    return translate("revisionErrorTimeout");
  }
  if (
    details.code === "revision_conflict" ||
    /revision task changed|revision conflict|refresh and try again/iu.test(message)
  ) {
    return translate("revisionErrorConflict");
  }
  if (details.code === "invalid_state" || /only a task .* can be/iu.test(message)) {
    return translate("revisionErrorStateChanged");
  }
  if (details.code === "profile_conflict" || /revision agent profile changed/iu.test(message)) {
    return translate("revisionErrorProfileConflict");
  }
  if (
    details.code === "apply_failed" ||
    details.code === "apply_recovery_failed" ||
    details.code === "apply_recovery_invalid"
  ) {
    return translate("revisionErrorApplyFailed");
  }
  return translate("revisionErrorGeneric");
}

function readErrorDetails(error: unknown): { readonly code?: string; readonly message: string } {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { readonly code?: unknown; readonly message?: unknown };
    return {
      ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
      message: typeof candidate.message === "string" ? candidate.message : errorMessage(error),
    };
  }
  return { message: errorMessage(error) };
}
