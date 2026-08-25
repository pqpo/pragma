/** Browser-safe CLI wire re-export. It deliberately avoids the native keychain barrel. */
export {
  BoardListResultSchema,
  BoardReadResultSchema,
  BoardSearchResultSchema,
  CliEventSchema,
  CliEventStreamSchema,
  CliResultSchema,
  createIntegrationError,
  ExecutorDescriptorSchema,
  IntegrationErrorCodeSchema,
  IntegrationErrorRetryPolicies,
  IntegrationErrorSchema,
  integrationErrorExitCode,
} from "@pragma/shared/integration";
export type { IntegrationError, IntegrationErrorCode, JsonValue } from "@pragma/shared/integration";
