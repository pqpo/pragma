import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MissionModelOverrideControls } from "../../components/MissionModelOverrideControls.tsx";
import { filterMissionExecutors } from "./HomePage.tsx";

describe("MissionModelOverrideControls", () => {
  it("shows generic defaults before discovery without exposing the Runtime", () => {
    const html = renderToStaticMarkup(
      <MissionModelOverrideControls
        models={[
          {
            id: "deepseek",
            displayName: "PI Runtime",
            provider: {
              kind: "registered",
              id: "provider",
              displayName: "DeepSeek",
            },
            thinking: {
              supportedLevels: [{ value: "high", label: "High" }],
            },
          },
        ]}
        value={{
          providerId: "provider",
          modelId: "deepseek",
          thinkingLevel: "high",
        }}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain("DeepSeek · PI Runtime");
    expect(html).toContain('<option value="high" selected="">High</option>');
    expect(html).toContain("Default model");
    expect(html).toContain("Default thinking depth");
    expect(html).not.toContain("runtimeId");
  });

  it("replaces generic defaults with the asynchronously resolved values", () => {
    const html = renderToStaticMarkup(
      <MissionModelOverrideControls
        models={[
          {
            id: "gpt",
            displayName: "GPT",
            provider: { kind: "registered", id: "openai", displayName: "OpenAI" },
            thinking: {
              supportedLevels: [{ value: "medium", label: "Medium" }],
              defaultLevel: "medium",
            },
          },
        ]}
        defaultValue={{ providerId: "openai", modelId: "gpt", thinkingLevel: "medium" }}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('<option value="" selected="">Default (OpenAI · GPT)</option>');
    expect(html).toContain('<option value="" selected="">Default (Medium)</option>');
  });
});

describe("mission executor search", () => {
  const executors = Array.from({ length: 100 }, (_, index) => ({
    ref: `expert:expert_${index}@1.0.0`,
    name: `Expert ${index}`,
    description: index % 2 === 0 ? "Release work" : "Other work",
    version: "1.0.0",
    kind: "expert" as const,
    origin: "project" as const,
    readOnly: false,
    customized: false,
  }));

  it("shows at most five executors and searches the full catalog", () => {
    expect(filterMissionExecutors(executors, "")).toHaveLength(5);
    const matches = filterMissionExecutors(executors, "Expert 99");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe("Expert 99");
  });
});
