import type { ModelProvider, ModelProviderModel, PragmaDesktopAPI } from "./contracts/index.ts";

export type ProviderDraft = {
  readonly id?: string;
  readonly expectedRevision?: number;
  readonly presetId: string;
  readonly name: string;
  readonly protocol: ModelProvider["protocol"];
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly requiresApiKey: boolean;
  readonly compatibilityProfileId: string;
  readonly models: readonly ModelProviderModel[];
};

export function modelProviderDraft(provider: ModelProvider): ProviderDraft {
  return {
    id: provider.id,
    expectedRevision: provider.revision,
    presetId: provider.presetId,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey: "",
    requiresApiKey: provider.requiresApiKey,
    compatibilityProfileId: provider.compatibilityProfileId ?? "",
    models: provider.models,
  };
}

export async function saveProviderDraft(
  draft: ProviderDraft,
  mode: "create" | "edit",
  api: Pick<PragmaDesktopAPI, "updateModelProvider" | "createModelProvider">,
): Promise<ModelProvider> {
  const input = {
    presetId: draft.presetId,
    name: draft.name,
    protocol: draft.protocol,
    baseUrl: draft.baseUrl,
    requiresApiKey: draft.requiresApiKey,
    ...(draft.compatibilityProfileId === ""
      ? {}
      : { compatibilityProfileId: draft.compatibilityProfileId }),
    models: [...draft.models],
  };
  if (mode === "edit" && draft.id !== undefined) {
    if (draft.expectedRevision === undefined)
      throw new Error("Reopen the connection editor to load its current revision before saving.");
    return await api.updateModelProvider({
      ...input,
      id: draft.id,
      expectedRevision: draft.expectedRevision,
      ...(draft.apiKey.trim() === "" ? {} : { apiKey: draft.apiKey }),
    });
  }
  return await api.createModelProvider({ ...input, apiKey: draft.apiKey });
}
