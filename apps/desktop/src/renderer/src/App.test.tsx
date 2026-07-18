import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "./App.tsx";

describe("App", () => {
  it("renders the Steward Home by default", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("PRAGMA STEWARD");
    expect(html).toContain("What would you like to orchestrate?");
    expect(html).toContain("Create or update an Expert");
    expect(html).toContain("PI Runtime");
    expect(html).toContain('aria-label="Model"');
    expect(html).toContain('aria-label="Thinking depth"');
    expect(html).toContain("Manage runtimes");
    expect(html).toContain("Studio");
  });

  it("offers every available application destination", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Home");
    expect(html).toContain("Missions");
    expect(html).toContain("Studio");
    expect(html).toContain("Settings");
  });

  it("keeps every application navigation destination enabled", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Missions");
    expect(html).toContain("Studio");
    expect(html).not.toContain("Inbox");
    expect(html).not.toContain("Alex Chen");
    expect(html).not.toContain('class="navigation-item" type="button" disabled');
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
