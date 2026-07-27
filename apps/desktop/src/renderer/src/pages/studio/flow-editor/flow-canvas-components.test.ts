import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PaletteItem, edgeTypes, nodeTypes } from "./flow-canvas-components.tsx";

describe("flow-canvas-components", () => {
  it("registers every custom canvas node and edge renderer", () => {
    expect(Object.keys(nodeTypes)).toEqual(["step", "logic", "terminal"]);
    expect(Object.keys(edgeTypes)).toEqual(["workflow"]);
  });

  it("renders palette entries as draggable canvas sources", () => {
    const html = renderToStaticMarkup(
      createElement(PaletteItem, {
        kind: "logic",
        label: "Condition",
        icon: createElement("span", null, "?"),
      }),
    );

    expect(html).toContain('class="flow-palette-item is-logic"');
    expect(html).toContain('draggable="true"');
    expect(html).toContain("Condition");
  });
});
