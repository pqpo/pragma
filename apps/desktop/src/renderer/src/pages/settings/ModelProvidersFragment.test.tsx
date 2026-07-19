import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProviderEditor, supportedThinkingLevels } from "./ModelProvidersFragment.tsx";

describe("ProviderEditor", () => {
  it("renders configured models as removable cards in a responsive grid", () => {
    const html = renderToStaticMarkup(
      <ProviderEditor
        initialValue={{
          presetId: "deepseek",
          name: "DeepSeek",
          protocol: "openai-completions",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "secret",
          requiresApiKey: true,
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

  it("requires explicit mappings for xhigh and max thinking levels", () => {
    expect(supportedThinkingLevels({ ...model("reasoning"), reasoning: true })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(
      supportedThinkingLevels({
        ...model("extended"),
        reasoning: true,
        thinkingLevelMap: { low: null, xhigh: "xhigh", max: "max" },
      }),
    ).toEqual(["off", "minimal", "medium", "high", "xhigh", "max"]);
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
