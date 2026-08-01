import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SIDEBAR_WIDTH_PREFERENCES } from "../lib/sidebar-width-preference.ts";
import { SidebarResizeHandle } from "./SidebarResizeHandle.tsx";

describe("SidebarResizeHandle", () => {
  it("exposes its current width and fixed bounds as an accessible separator", () => {
    const html = renderToStaticMarkup(
      <SidebarResizeHandle
        label="Resize navigation"
        width={280}
        preference={SIDEBAR_WIDTH_PREFERENCES.main}
        onResize={() => undefined}
      />,
    );

    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-valuemin="200"');
    expect(html).toContain('aria-valuemax="360"');
    expect(html).toContain('aria-valuenow="280"');
  });
});
