import { createBuiltInModelProviderDriverRegistry, probeModelProvider } from "@pragma/core";

import type {
  ModelConnectionTestResult,
  ModelProvider,
  ModelProviderModel,
} from "../shared/desktop-api.ts";

export async function testProviderModel(options: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly protocol: ModelProvider["protocol"];
  readonly model: ModelProviderModel;
  readonly fetchImpl?: typeof fetch;
}): Promise<ModelConnectionTestResult> {
  return await probeModelProvider({
    api: options.protocol,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    model: options.model,
    drivers: createBuiltInModelProviderDriverRegistry({ fetch: options.fetchImpl }),
  });
}
