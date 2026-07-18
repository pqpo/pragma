import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "./App.tsx";

describe("App", () => {
  it("renders the expert directory by default", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Studio");
    expect(html).toContain("Reusable specialists available to your missions.");
    expect(html).toContain("Create expert");
    expect(html).toContain("Search experts");
    expect(html).toContain("0 experts");
  });

  it("offers the Studio collections with their counts", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).not.toContain("Overview");
    expect(html).toContain("Experts");
    expect(html).toContain("Expert teams");
    expect(html).toContain("Flows");
    expect(html).toContain("Capabilities");
    expect(html).toContain("Plugins");
    expect(html.match(/>0</g)?.length).toBe(6);
  });

  it("keeps unavailable application navigation disabled", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Missions");
    expect(html).toContain("Studio");
    expect(html).not.toContain("Inbox");
    expect(html).not.toContain("Alex Chen");
    expect(html.match(/disabled=""/g)?.length).toBe(1);
  });

  it("keeps the accessible sidebar collapse control in a compact footer", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('aria-label="Collapse navigation"');
    expect(html).toContain('class="sidebar-footer"');
    expect(html.indexOf('class="sidebar-footer"')).toBeGreaterThan(
      html.indexOf('aria-label="Main navigation"'),
    );
  });

  it("provides a frameless window drag region above the application shell", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('class="window-drag-region"');
  });
});
