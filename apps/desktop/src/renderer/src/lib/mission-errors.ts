import { DesktopMutationErrorSchema } from "../../../shared/contracts/mutation.ts";

import { localizedBundleMutationError } from "./bundle-errors.ts";
import { errorMessage } from "./errors.ts";

const MISSION_ERROR_TRANSLATION_KEYS: Readonly<Record<string, string>> = {
  mission_not_found: "errorMissionNotFound",
  mission_active: "errorOperationInProgress",
  mission_operation_in_progress: "errorOperationInProgress",
  unsupported_schema: "errorStorageVersion",
  timeline_invalid: "errorHistoryUnavailable",
  projection_invalid: "errorHistoryUnavailable",
  message_conflict: "errorMessageConflict",
  config_invalid: "errorConfigurationInvalid",
  invalid_request: "errorInvalidRequest",
  COMMAND_ACCEPTANCE_TIMEOUT: "errorOperationInProgress",
  COMMAND_RESULT_TIMEOUT: "errorOperationInProgress",
};

export function localizedMissionError(
  error: unknown,
  translate: (key: string, options?: Record<string, unknown>) => string,
): string {
  const parsed = DesktopMutationErrorSchema.safeParse(error);
  if (parsed.success) {
    if (parsed.data.code === "bundle_setup_required") {
      return localizedBundleMutationError(error, translate);
    }
    const translationKey = MISSION_ERROR_TRANSLATION_KEYS[parsed.data.code];
    if (translationKey !== undefined) return translate(translationKey);
  }
  const message = parsed.success ? parsed.data.message : errorMessage(error);
  if (/(?:^|\s)idempotency conflict(?::|\s)/iu.test(message)) {
    return translate("errorInternalStateConflict");
  }
  if (
    /Mission timeline (?:record|sequence|execution|has|is)/iu.test(message) ||
    /Mission execution projection/iu.test(message)
  ) {
    return translate("errorHistoryUnavailable");
  }
  if (/Unsupported Mission (?:schema|projection schema)/iu.test(message)) {
    return translate("errorStorageVersion");
  }
  return message;
}
