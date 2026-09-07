import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ModelProviderEditorPage,
  ProviderEditor,
  reconcileDiscoveredModels,
  supportedThinkingLevels,
} from "./ModelProvidersFragment.tsx";

describe("ProviderEditor", () => {
  it("renders configured models as removable cards in a responsive grid", () => {
    const html = renderToStaticMarkup(
      <ProviderEditor
        mode="edit"
        initialValue={{
          id: "00000000-0000-4000-8000-000000000001",
          presetId: "deepseek",
          name: "DeepSeek",
          protocol: "openai-completions",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "secret",
          requiresApiKey: true,
          compatibilityProfileId: "",
          models: [model("deepseek-v4-flash"), model("deepseek-v4-pro")],
        }}
        onCancel={() => undefined}
        onSaved={() => undefined}
      />,
    );

    expect(html).toContain("provider-wizard-steps");
    expect(html).toContain("Configure connection");
    expect(html).toContain("https://api.deepseek.com/v1");
  });

  it("uses a three-step flow for creation and a two-step flow for editing", () => {
    const createHtml = renderToStaticMarkup(
      <ProviderEditor
        mode="create"
        initialValue={{
          presetId: "",
          name: "",
          protocol: "openai-completions",
          baseUrl: "",
          apiKey: "",
          requiresApiKey: true,
          compatibilityProfileId: "",
          models: [],
        }}
        onCancel={() => undefined}
        onSaved={() => undefined}
      />,
    );
    const editHtml = renderToStaticMarkup(
      <ProviderEditor
        mode="edit"
        initialValue={{
          id: "00000000-0000-4000-8000-000000000001",
          presetId: "deepseek",
          name: "DeepSeek",
          protocol: "openai-completions",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "",
          requiresApiKey: true,
          compatibilityProfileId: "",
          models: [model("deepseek-v4-flash")],
        }}
        onCancel={() => undefined}
        onSaved={() => undefined}
      />,
    );

    expect(createHtml.match(/provider-wizard-step-index/g)).toHaveLength(3);
    expect(createHtml).toContain("Choose a provider");
    expect(editHtml.match(/provider-wizard-step-index/g)).toHaveLength(2);
    expect(editHtml).toContain("Configure connection");
    expect(editHtml).not.toContain("Choose a provider");
  });

  it("renders create and edit flows as dedicated settings pages", () => {
    const html = renderToStaticMarkup(
      <ModelProviderEditorPage
        mode="edit"
        draft={{
          id: "00000000-0000-4000-8000-000000000001",
          presetId: "deepseek",
          name: "DeepSeek",
          protocol: "openai-completions",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "",
          requiresApiKey: true,
          compatibilityProfileId: "",
          models: [model("deepseek-v4-flash")],
        }}
        onBack={() => undefined}
        onSaved={() => undefined}
      />,
    );

    expect(html).toContain('class="settings-panel settings-screen provider-editor-screen"');
    expect(html).toContain("Back to Models &amp; Providers");
    expect(html).toContain("Edit DeepSeek");
    expect(html).toContain('class="provider-editor-surface"');
  });

  it("uses the runtime-neutral declared thinking levels", () => {
    expect(supportedThinkingLevels({ ...model("reasoning"), reasoning: true })).toEqual([]);
    expect(
      supportedThinkingLevels({
        ...model("extended"),
        reasoning: true,
        thinking: { supportedLevels: ["off", "medium", "xhigh", "max"] },
      }),
    ).toEqual(["off", "medium", "xhigh", "max"]);
  });

  it("refreshes discovered image input unless the user explicitly overrode it", () => {
    const discovered = {
      ...model("qwen3.7-plus"),
      input: ["text", "image"] as ("text" | "image")[],
      capabilitiesSource: "provider" as const,
    };
    expect(reconcileDiscoveredModels([model("qwen3.7-plus")], [discovered])).toEqual([
      expect.objectContaining({ input: ["text", "image"], capabilitiesSource: "provider" }),
    ]);
    expect(
      reconcileDiscoveredModels(
        [{ ...model("qwen3.7-plus"), inputOverride: ["text"] }],
        [discovered],
      ),
    ).toEqual([expect.objectContaining({ input: ["text"], inputOverride: ["text"] })]);
  });

  it("refreshes discovered token limits but preserves manual values", () => {
    const discovered = {
      ...model("qwen3.8-max"),
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      contextWindowSource: "catalog" as const,
      maxTokensSource: "catalog" as const,
    };

    expect(reconcileDiscoveredModels([model("qwen3.8-max")], [discovered])).toEqual([
      expect.objectContaining({ contextWindow: 1_000_000, maxTokens: 131_072 }),
    ]);
    expect(
      reconcileDiscoveredModels(
        [
          {
            ...model("qwen3.8-max"),
            contextWindow: 256_000,
            contextWindowSource: "manual",
          },
        ],
        [discovered],
      ),
    ).toEqual([
      expect.objectContaining({
        contextWindow: 256_000,
        contextWindowSource: "manual",
        maxTokens: 131_072,
      }),
    ]);
  });
});

function model(id: string) {
  return {
    id,
    name: id,
    api: "openai-completions" as const,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    capabilitiesSource: "manual" as const,
  };
}
