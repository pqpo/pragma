import type { ResolvedModelProvider } from "@pragma/core";
import { probePiModelProvider } from "@pragma/runtime-pi";
import type { ModelThinkingLevel } from "@pragma/shared";

import type { ModelConnectionTestResult, ModelProviderModel } from "../shared/desktop-api.ts";

export async function testProviderModel(options: {
  readonly provider: ResolvedModelProvider;
  readonly model: ModelProviderModel;
  readonly thinkingLevel?: ModelThinkingLevel | undefined;
}): Promise<ModelConnectionTestResult> {
  return await probePiModelProvider({
    provider: options.provider,
    modelId: options.model.id,
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
  });
}
