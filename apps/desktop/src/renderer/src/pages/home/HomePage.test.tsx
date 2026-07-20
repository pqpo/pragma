import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MissionModelOverrideControls } from "../../components/MissionModelOverrideControls.tsx";

describe("MissionModelOverrideControls", () => {
  it("lists models without exposing or changing their Runtime", () => {
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
    expect(html).toContain("Use executor default");
    expect(html).not.toContain("runtimeId");
  });
});
