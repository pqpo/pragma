import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MissionModelOverrideControls } from "./HomePage.tsx";

describe("MissionModelOverrideControls", () => {
  it("lists available models and thinking levels for Expert missions", () => {
    const html = renderToStaticMarkup(
      <MissionModelOverrideControls
        runtimes={[
          {
            id: "pi",
            revision: 1,
            origin: "built-in",
            adapter: { id: "pragma.runtime.pi", version: "v1" },
            isDefault: true,
            kind: "cloud-pi-agent",
            displayName: "PI Runtime",
            status: "available",
            models: [
              {
                id: "deepseek",
                displayName: "DeepSeek",
                provider: {
                  kind: "registered",
                  id: "provider",
                  displayName: "DeepSeek",
                },
                thinking: {
                  supportedLevels: [{ value: "high", label: "High" }],
                },
              },
            ],
          },
        ]}
        value={{
          runtimeId: "pi",
          providerId: "provider",
          modelId: "deepseek",
          thinkingLevel: "high",
        }}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain("PI Runtime · DeepSeek · DeepSeek");
    expect(html).toContain('<option value="high" selected="">High</option>');
    expect(html).toContain("Use executor default");
  });
});
