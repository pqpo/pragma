import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "./App.tsx";

describe("App", () => {
  it("renders the models and providers settings view by default", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Settings");
    expect(html).toContain("Models &amp; Providers");
    expect(html).toContain("Add provider");
    expect(html).toContain("Loading providers…");
    expect(html).not.toContain("Anthropic");
    expect(html).not.toContain("Advanced Settings");
  });

  it("offers both requested settings sections", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Models &amp; Providers");
    expect(html).toContain("Runtime Environments");
    expect(html.match(/aria-selected=/g)?.length).toBe(2);
  });

  it("keeps application navigation non-interactive", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Missions");
    expect(html).toContain("Studio");
    expect(html.match(/disabled=""/g)?.length).toBe(5);
  });

  it("includes an accessible sidebar collapse control", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('aria-label="Collapse navigation"');
  });
});
