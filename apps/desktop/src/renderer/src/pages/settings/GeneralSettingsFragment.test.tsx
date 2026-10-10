import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GeneralSettingsFragment } from "./GeneralSettingsFragment.tsx";

describe("General settings", () => {
  it("shows one shared process environment policy in the General tab", () => {
    const html = renderToStaticMarkup(<GeneralSettingsFragment />);

    expect(html).toContain("Runtime environment variables");
    expect(html).toContain("Loading environment settings");
    expect(html).not.toContain("Full environment access");
  });
});
