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

    expect(html).toContain("Experts");
    expect(html).toContain("Expert teams");
    expect(html).toContain("Capabilities");
    expect(html.match(/>0</g)?.length).toBe(4);
  });

  it("keeps unavailable application navigation disabled", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Missions");
    expect(html).toContain("Studio");
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });

  it("includes an accessible sidebar collapse control", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('aria-label="Collapse navigation"');
  });
});
