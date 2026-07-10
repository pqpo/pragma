import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "./App.tsx";

describe("App", () => {
  it("renders the Home dashboard mock", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Continue Working");
    expect(html).toContain("Compile Q3 Revenue Data Synthesis");
    expect(html).toContain("Needs You");
    expect(html).toContain("Recent Artifacts");
  });

  it("keeps all visible controls non-interactive", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("New Mission");
    expect(html).toContain("Missions");
    expect(html).toContain("Review");
    expect(html.match(/disabled=""/g)?.length).toBe(10);
  });
});
