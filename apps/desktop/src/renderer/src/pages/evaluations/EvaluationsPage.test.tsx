import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createEmptyFlow } from "../studio/flow-editor/flow-model.ts";
import { createFlowRunDryEvaluation, EvaluationsPage } from "./EvaluationsPage.tsx";

describe("EvaluationsPage", () => {
  it("keeps the loading state inset after removing the page tabs", () => {
    const html = renderToStaticMarkup(<EvaluationsPage />);

    expect(html).toContain('class="studio-empty-copy evaluations-page-loading"');
    expect(html).not.toContain('class="agent-evaluation-tabs"');
  });

  it("creates a standalone Run Dry draft for the selected Flow", () => {
    const flow = {
      ...createEmptyFlow("8h9j0k1m2n3p4q5r"),
      metadata: {
        id: "8h9j0k1m2n3p4q5r",
        name: "Release flow",
        description: "Release a build.",
        tags: [],
      },
    };

    expect(createFlowRunDryEvaluation("7h8j9k0m1n2p3q4r", flow)).toMatchObject({
      kind: "Evaluation",
      metadata: {
        id: "7h8j9k0m1n2p3q4r",
        name: "Release flow Run Dry",
        tags: ["run-dry"],
      },
      spec: {
        target: { ref: "flow:8h9j0k1m2n3p4q5r" },
        method: {
          type: "flow-run-dry",
          cases: [{ id: "case_1", name: "Case 1" }],
        },
      },
    });
  });
});
