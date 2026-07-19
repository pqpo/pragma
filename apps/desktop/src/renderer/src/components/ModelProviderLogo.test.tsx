import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MODEL_PROVIDER_PRESETS } from "../../../shared/model-provider-presets.ts";
import { hasModelProviderLogo, ModelProviderLogo } from "./ModelProviderLogo.tsx";

describe("ModelProviderLogo", () => {
  it("has a real brand logo for every named provider preset", () => {
    const providerPresets = MODEL_PROVIDER_PRESETS.filter(
      (preset) => preset.id !== "custom-openai",
    );

    expect(providerPresets.every((preset) => hasModelProviderLogo(preset.id))).toBe(true);

    for (const preset of providerPresets) {
      const html = renderToStaticMarkup(<ModelProviderLogo presetId={preset.id} />);
      expect(html).toContain("<img");
      expect(html).not.toContain("<svg");
    }
  });

  it("uses a generic icon for custom providers", () => {
    const html = renderToStaticMarkup(<ModelProviderLogo presetId="custom-openai" />);

    expect(html).toContain("<svg");
    expect(html).not.toContain("<img");
  });
});
