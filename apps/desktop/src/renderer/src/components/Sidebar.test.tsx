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

  it("hides the Memory top-level entry when memory is disabled", () => {
    expect(renderSidebar(false)).not.toContain('aria-label="Memory"');
  });

  it("shows the Memory top-level entry when memory is enabled", () => {
    expect(renderSidebar(true)).toContain('aria-label="Memory"');
  });
});
