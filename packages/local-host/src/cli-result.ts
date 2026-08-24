/** Browser-safe CLI wire re-export. It deliberately avoids the native keychain barrel. */
export {
  CliResultSchema,
  IntegrationErrorCodeSchema,
  IntegrationErrorSchema,
  integrationErrorExitCode,
} from "@pragma/shared/integration";
export type { IntegrationErrorCode } from "@pragma/shared/integration";
