import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StudioPage } from "./StudioPage.tsx";

describe("StudioPage", () => {
  it("renders a resizable secondary navigation", () => {
    const html = renderToStaticMarkup(<StudioPage onTryExpert={() => undefined} />);

    expect(html).toContain('class="studio-navigation"');
    expect(html).toContain('aria-label="Resize navigation"');
    expect(html).toContain('role="separator"');
    expect(html).not.toContain("<span>Revision tasks</span><em>");
  });
});
