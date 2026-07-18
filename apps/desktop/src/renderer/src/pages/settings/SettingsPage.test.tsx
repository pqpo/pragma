import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SettingsPage } from "./SettingsPage.tsx";

describe("SettingsPage", () => {
  it("uses a fixed navigation and content frame without a redundant page title", () => {
    const html = renderToStaticMarkup(<SettingsPage />);

    expect(html).toContain('class="settings-navigation"');
    expect(html).toContain('class="settings-content"');
    expect(html).toContain('class="settings-screen-header"');
    expect(html).toContain('class="settings-screen-body"');
    expect(html).not.toContain("<h1>Settings</h1>");
  });
});
