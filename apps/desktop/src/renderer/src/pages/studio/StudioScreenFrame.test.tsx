import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StudioScreenFrame } from "./StudioScreenFrame.tsx";

describe("StudioScreenFrame", () => {
  it("separates persistent screen chrome from the scrolling body", () => {
    const html = renderToStaticMarkup(
      <StudioScreenFrame
        className="example-screen"
        labelledBy="example-heading"
        header={<h1 id="example-heading">Example</h1>}
      >
        <p>Scrollable content</p>
      </StudioScreenFrame>,
    );

    expect(html).toContain('class="studio-screen example-screen"');
    expect(html).toContain('aria-labelledby="example-heading"');
    expect(html.indexOf('class="studio-screen-header"')).toBeLessThan(
      html.indexOf('class="studio-screen-body"'),
    );
    expect(html).toContain("Scrollable content");
  });
});
