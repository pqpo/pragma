/**
 * Node-only application boundary shared by Desktop Main and the CLI.
 *
 * Concrete storage, runtime factories, keychains, and filesystem access are
 * injected by application composition roots. This package must not import a
 * concrete Runtime adapter or an application UI.
 */
export const LOCAL_HOST_APPLICATION_PROTOCOL = "pragma.local-host/v1" as const;

export type LocalHostApplicationPort = Readonly<{
  readonly protocol: typeof LOCAL_HOST_APPLICATION_PROTOCOL;
  readonly integrationCapability: () => Promise<IntegrationCapability>;
}>;
import type { IntegrationCapability } from "@pragma/shared/integration";
