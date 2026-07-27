import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
        runDry: {
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
        flow={flow}
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
    expect(html).toContain("Finish successfully");
    expect(html).toContain("Required transitions");
    expect(html).toContain("Node mocks (JSON)");
    expect(html).toContain("Run all");
  });
});
