import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Sidebar } from "./Sidebar.tsx";

describe("Sidebar", () => {
  const renderSidebar = (memoryEnabled: boolean) =>
    renderToStaticMarkup(
      <Sidebar
        activeView="home"
        collapsed={false}
        memoryEnabled={memoryEnabled}
        onNavigate={() => undefined}
        onToggle={() => undefined}
      />,
    );

  it("merges mission navigation into Home", () => {
    const html = renderSidebar(false);
    expect(html).toContain('aria-label="Home"');
    expect(html).not.toContain('aria-label="Missions"');
  });

  it("hides the Memory top-level entry when memory is disabled", () => {
    expect(renderSidebar(false)).not.toContain('aria-label="Memory"');
  });

  it("shows the Memory top-level entry when memory is enabled", () => {
    expect(renderSidebar(true)).toContain('aria-label="Memory"');
  });

  it.each([false, true])("shows accessible attention dots with collapsed=%s", (collapsed) => {
    const html = renderToStaticMarkup(
      <Sidebar
        activeView="home"
        collapsed={collapsed}
        memoryEnabled
        attention={{ home: true, studio: true, memory: true }}
        onNavigate={() => undefined}
        onToggle={() => undefined}
      />,
    );
    expect(html.match(/class="navigation-attention-dot"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Unread messages or pending actions"');
    expect(html).toContain('aria-label="Home, Unread messages or pending actions"');
  });
});
