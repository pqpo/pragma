import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StudioPage } from "./StudioPage.tsx";

describe("StudioPage", () => {
  it("renders a resizable secondary navigation", () => {
    const html = renderToStaticMarkup(<StudioPage onTryExpert={() => undefined} />);
    const resourceIndex = html.indexOf("<span>Knowledge bases</span>");
    const distributionIndex = html.indexOf('class="studio-distribution-actions"');
    const squareIndex = html.indexOf("<span>Square</span>");
    const importIndex = html.indexOf("<span>Import</span>");
    const exportIndex = html.indexOf("<span>Export</span>");

    expect(html).toContain('class="studio-navigation"');
    expect(html).toContain('aria-label="Resize navigation"');
    expect(html).toContain('role="separator"');
    expect(html).not.toContain("<span>Revision tasks</span><em>");
    expect(resourceIndex).toBeGreaterThan(-1);
    expect(distributionIndex).toBeGreaterThan(resourceIndex);
    expect(squareIndex).toBeGreaterThan(distributionIndex);
    expect(importIndex).toBeGreaterThan(squareIndex);
    expect(exportIndex).toBeGreaterThan(importIndex);
  });
});
