import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InspectorField } from "./flow-inspector-field.tsx";

describe("flow-inspector-field", () => {
  it("associates the field label with its nested control", () => {
    const html = renderToStaticMarkup(
      createElement(InspectorField, {
        label: "Node name",
        children: createElement("input", { defaultValue: "review" }),
      }),
    );

    expect(html).toContain('<label class="flow-inspector-field">');
    expect(html).toContain("<span>Node name</span>");
    expect(html).toContain('value="review"');
  });
});
