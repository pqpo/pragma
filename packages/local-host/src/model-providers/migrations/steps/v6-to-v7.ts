import { ModelProvidersV6Schema, type ModelProvidersV6 } from "../schemas/v6.ts";
export const modelProvidersV6ToV7Step = {
  fromVersion: 6,
  toVersion: 7,
  inputSchema: ModelProvidersV6Schema,
  migrate(value: ModelProvidersV6) {
    return {
      ...value,
      schemaVersion: 7 as const,
      providers: value.providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model) => ({ ...model, kind: "generation" as const })),
      })),
    };
  },
} as const;
