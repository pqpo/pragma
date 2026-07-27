import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PragmaProjectSnapshot } from "../../../../../shared/contracts/index.ts";
import { FlowEditor, FLOW_ERROR_AUTO_DISMISS_MS } from "./FlowEditor.tsx";
import { flowFixture } from "./flow-editor-test-fixtures.ts";

describe("FlowEditor.integration", () => {
  it("dismisses transient editor errors after five seconds", () => {
    expect(FLOW_ERROR_AUTO_DISMISS_MS).toBe(5_000);
  });

  it("exposes palette items as drag-only controls", () => {
    const html = renderToStaticMarkup(
      createElement(FlowEditor, {
        project: projectFixture(),
        error: null,
        onCancel: () => undefined,
        onSave: async () => true,
      }),
    );

    expect(html).toContain('class="flow-palette-item is-expert" draggable="true"');
    expect(html).not.toContain('<button class="flow-palette-item');
    expect(html).toContain("Drag to canvas");
    expect(html).not.toContain("press Enter");
    expect(html).not.toContain("flow-palette-item is-action");
  });

  it("composes a populated Flow through the extracted canvas modules", () => {
    const html = renderToStaticMarkup(
      createElement(FlowEditor, {
        project: projectFixture(),
        initial: flowFixture(),
        error: null,
        onCancel: () => undefined,
        onSave: async () => true,
      }),
    );

    expect(html).toContain("Review flow");
    expect(html).toContain("Published");
    expect(html).toContain("Validate &amp; publish");
  });
});

function projectFixture(): PragmaProjectSnapshot {
  return {
    schemaVersion: "pragma.project-snapshot/v3",
    projectId: "test-project",
    revision: 0,
    resources: [],
    diagnostics: [],
  };
}
