import { createIntegrationError } from "@pragma/local-host/wire";

import type { CliLocalHost } from "../commands/types.ts";

export function createCliLocalHost(
  input: { readonly localHost?: CliLocalHost } = {},
): CliLocalHost {
  return input.localHost ?? createUnavailableLocalHost();
}

function createUnavailableLocalHost(): CliLocalHost {
  const unavailable = async (): Promise<never> => {
    throw createIntegrationError({
      code: "DEPENDENCY_UNAVAILABLE",
      category: "dependency",
      message: "The Desktop Local Host is unavailable.",
    });
  };
  return {
    integrationCapability: unavailable,
    listExecutors: unavailable,
    getMission: unavailable,
    listMissions: unavailable,
    listSharedBoard: unavailable,
    readSharedBoard: unavailable,
    searchSharedBoard: unavailable,
    listMissionQueue: unavailable,
  };
}
