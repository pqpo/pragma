import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FlowSettings } from "./flow-inspectors.tsx";
import { flowFixture } from "./flow-editor-test-fixtures.ts";

describe("flow-inspectors", () => {
  it("renders flow metadata and limits through the settings inspector", () => {
    const html = renderToStaticMarkup(
      createElement(FlowSettings, {
        flow: flowFixture(),
        onPatch: () => undefined,
      }),
    );

    expect(html).toContain('value="Review flow"');
    expect(html).toContain("Max node visits");
    expect(html).toContain('value="10"');
  });
});
