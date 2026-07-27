import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PragmaFlowPrompt } from "@pragma/interpreter/ast";

import { createEmptyFlow } from "./flow-model.ts";
import {
  PromptTemplateEditor,
  flowVariableOptions,
  normalizePromptSegments,
  promptSegmentsFromEditorNodes,
} from "./flow-prompt-editor.tsx";
import { flowFixture } from "./flow-editor-test-fixtures.ts";

describe("flow-prompt-editor", () => {
  it("derives native and structured variables and marks branch-only output optional", () => {
    const flow = flowFixture();
    flow.spec.graph.start = "start";
    flow.spec.graph.steps = {
      start: {
        expert: { ref: "expert:caadt9e550f04adk" },
        prompt: { segments: [{ text: "Start" }] },
      },
      scored: {
        expert: { ref: "expert:p176qzwdwbj85253" },
        prompt: { segments: [{ text: "Score" }] },
        output: {
          schema: {
            type: "object",
            properties: { score: { type: "number" }, note: { type: "string" } },
            required: ["score"],
            additionalProperties: false,
          },
        },
      },
      alternate: {
        expert: { ref: "expert:q4k4hz54yzem8ktn" },
        prompt: { segments: [{ text: "Alternate" }] },
      },
      join: {
        expert: { ref: "expert:zz8emaxka43mvhd1" },
        prompt: { segments: [{ text: "Join" }] },
      },
    };
    flow.spec.graph.transitions = {
      start: {
        route: "branch",
        cases: { scored: "scored", alternate: "alternate" },
      },
      scored: "join",
      alternate: "join",
      join: { end: true },
    };

    const options = flowVariableOptions(flow, "join");
    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "start.result", optional: false }),
        expect.objectContaining({ label: "scored.result", optional: true }),
        expect.objectContaining({ label: "scored.result.score", optional: true }),
        expect.objectContaining({ label: "alternate.result", optional: true }),
      ]),
    );
    expect(options.some((option) => option.label === "alternate.result.anything")).toBe(false);
  });

  it("renders prompt variables inline inside one editor instead of creating textareas", () => {
    const flow = createEmptyFlow("prompt_editor");
    flow.spec.graph.start = "writer";
    flow.spec.graph.steps.writer = {
      expert: { ref: "expert:1xddvess309a6gme" },
      prompt: {
        segments: [
          { text: "Use " },
          { variable: { source: "flow-input", path: [] } },
          { text: " and " },
          { variable: { source: "flow-input", path: [] } },
          { text: "." },
        ],
      },
    };
    flow.spec.graph.transitions.writer = { end: true };

    const html = renderToStaticMarkup(
      createElement(PromptTemplateEditor, {
        flow,
        stepId: "writer",
        value: flow.spec.graph.steps.writer!.prompt,
        onChange: () => undefined,
      }),
    );

    expect(html.match(/class="flow-prompt-editor"/g)).toHaveLength(1);
    expect(html.match(/class="flow-variable-chip"/g)).toHaveLength(2);
    expect(html).not.toContain("<textarea");
    expect(html).toContain('contentEditable="true"');
    expect(html).toContain('<div class="flow-inspector-field" role="group"');
    expect(html).not.toContain('<label class="flow-inspector-field"><span>Prompt</span>');
  });

  it("merges adjacent prompt text while preserving inline variable order", () => {
    const variable = { source: "flow-input" as const, path: ["goal"] };
    const segments: PragmaFlowPrompt["segments"] = [
      { text: "Review " },
      { text: "this: " },
      { variable },
      { text: "\nCarefully." },
    ];

    expect(normalizePromptSegments(segments)).toEqual([
      { text: "Review this: " },
      { variable },
      { text: "\nCarefully." },
    ]);
  });

  it("preserves a variable inserted inside an existing prompt text node", () => {
    const variable = { source: "flow-input" as const, path: ["goal"] };
    const textNode = (text: string) =>
      ({
        nodeType: 3,
        textContent: text,
        childNodes: [],
      }) as unknown as Node;
    const elementNode = (
      children: readonly Node[],
      encodedVariable?: PragmaFlowPrompt["segments"][number],
    ) =>
      ({
        nodeType: 1,
        textContent: null,
        childNodes: children,
        dataset:
          encodedVariable !== undefined && "variable" in encodedVariable
            ? { flowVariable: encodeURIComponent(JSON.stringify(encodedVariable.variable)) }
            : {},
      }) as unknown as Node;

    const nestedVariableChip = elementNode([textNode("Flow input.goal"), textNode("×")], {
      variable,
    });
    const textSpan = elementNode([
      textNode("Review "),
      nestedVariableChip,
      textNode(" carefully."),
    ]);

    expect(promptSegmentsFromEditorNodes([textSpan])).toEqual([
      { text: "Review " },
      { variable },
      { text: " carefully." },
    ]);
  });
});
