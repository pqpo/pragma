import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PragmaEvaluationResourceSchema } from "@pragma/evaluation/ast";
import { PragmaFlowResourceSchema } from "@pragma/interpreter/ast";

import { FlowRunDryFragment } from "./FlowRunDryFragment.tsx";

describe("FlowRunDryFragment", () => {
  it("renders persisted cases and transition coverage in a dedicated developer screen", () => {
    const flow = PragmaFlowResourceSchema.parse({
      apiVersion: "pragma/v3",
      kind: "Flow",
      metadata: {
        id: "8h9j0k1m2n3p4q5r",
        name: "Release flow",
        description: "Release a build.",
        tags: [],
      },
      spec: {
        graph: {
          start: "finish",
          steps: {
            finish: {
              human: {
                selectionMode: "single",
                prompt: { segments: [{ text: "Finish?" }] },
                options: [
                  { value: "yes", label: "Yes" },
                  { value: "no", label: "No" },
                ],
              },
            },
          },
          loops: {},
          transitions: { finish: { end: true } },
        },
      },
    });
    const evaluation = PragmaEvaluationResourceSchema.parse({
      apiVersion: "pragma/v3",
      kind: "Evaluation",
      metadata: {
        id: "7h8j9k0m1n2p3q4r",
        name: "Release Run Dry",
        description: "Release flow cases.",
        tags: [],
      },
      spec: {
        target: { ref: "flow:8h9j0k1m2n3p4q5r" },
        method: {
          type: "flow-run-dry",
          cases: [
            {
              id: "finish",
              name: "Finish successfully",
              input: {},
              mocks: {
                finish: {
                  expectInput: {},
                  expectPrompt: "Finish?",
                  output: { selection: "yes" },
                },
              },
              expect: {
                status: "succeeded",
                path: ["finish"],
                output: { selection: "yes" },
              },
            },
          ],
        },
      },
    });

    const html = renderToStaticMarkup(
      <FlowRunDryFragment
        evaluation={evaluation}
        flows={[flow]}
        onBack={() => undefined}
        onRun={async () => ({
          passed: true,
          cases: [],
          coverage: { passed: true, covered: [], required: [], missing: [] },
          summary: { total: 0, passed: 0, failed: 0 },
        })}
        onSave={async () => undefined}
      />,
    );

    expect(html).toContain("Flow run dry cases");
    expect(html).toContain(
      "Use mocks instead of real model, Action, nested Flow, and Human Task results.",
    );
    expect(html).toContain("Finish successfully");
    expect(html).toContain("Required transitions");
    expect(html).toContain("Node mocks (JSON)");
    expect(html).toContain("Run all");
    expect(html).toContain("Save cases");
    expect(html).toContain("flow-run-dry-identity");
    expect(html).toContain("flow-run-dry-form-grid");
    expect(html).toContain("flow-run-dry-case-editor");
    expect(html).toContain("flow-run-dry-static-value");
    expect(html).toContain('Target Flow</span><div class="flow-run-dry-static-value"');
    expect(html).not.toContain("Target Flow</span><select");
    expect(html).not.toContain("<select");
    expect(html).toContain("flow-run-dry-case-delete");
    expect(html).toContain('aria-label="Delete case “Finish successfully”"');
    expect(html).toContain("flow-run-dry-add-case");
    expect(html.indexOf("flow-run-dry-case-item")).toBeLessThan(
      html.indexOf("flow-run-dry-add-case"),
    );
  });
});
