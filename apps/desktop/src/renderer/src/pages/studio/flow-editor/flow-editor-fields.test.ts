import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { newSchemaField, objectSchemaToFields } from "../JsonSchemaFieldsEditor.tsx";
import { createEmptyFlow } from "./flow-model.ts";
import {
  RuntimeBindingEditor,
  flowRuntimeProfile,
  nextHumanOptionNumber,
  removeHumanOption,
  validateFlowRuntimeSelections,
} from "./flow-editor-fields.tsx";
import { runtimeResources } from "./flow-editor-test-fixtures.ts";

describe("flow-editor-fields", () => {
  it("allows every Human option to be removed while keeping new values unique", () => {
    const initial = [
      { value: "option_1", label: "Option 1" },
      { value: "option_2", label: "Option 2" },
    ];

    const oneOption = removeHumanOption(initial, 0);
    const noOptions = removeHumanOption(oneOption, 0);

    expect(oneOption).toEqual([{ value: "option_2", label: "Option 2" }]);
    expect(noOptions).toEqual([]);
    expect(nextHumanOptionNumber(oneOption)).toBe(1);
    expect(nextHumanOptionNumber(initial)).toBe(3);
  });

  it("preserves structured-output field identity when the parent echoes a cloned schema", () => {
    const field = {
      ...newSchemaField(),
      name: "summary",
      value: {
        type: "object" as const,
        fields: [{ ...newSchemaField(), name: "details" }],
      },
    };
    const schema = {
      type: "object" as const,
      properties: {
        summary: {
          type: "object" as const,
          properties: { details: { type: "string" as const } },
          required: ["details"],
          additionalProperties: false as const,
        },
      },
      required: ["summary"],
      additionalProperties: false as const,
    };

    const echoed = objectSchemaToFields(structuredClone(schema), [field]);

    expect(echoed[0]?.id).toBe(field.id);
    expect(echoed[0]?.value.fields[0]?.id).toBe(field.value.fields[0]?.id);
  });

  it("shows actual Runtime environments and requires a model for a Runtime override", () => {
    const resources = runtimeResources();
    const runtime = {
      id: "codex-local",
      isDefault: true,
      kind: "codex",
      displayName: "Codex Local",
      status: "available" as const,
      models: [
        {
          id: "gpt-5.6",
          displayName: "GPT-5.6",
          provider: {
            kind: "runtime-managed" as const,
            id: "openai",
            displayName: "OpenAI",
          },
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(RuntimeBindingEditor, {
        value: undefined,
        allowModel: true,
        targetKind: "expert",
        targetRef: "expert:1xddvess309a6gme",
        resources,
        runtimes: [runtime],
        onSupportingResource: () => undefined,
        onChange: () => undefined,
      }),
    );

    expect(html).toContain("Codex Local");
    expect(html).not.toContain("Writer Runtime");

    const generated = flowRuntimeProfile(runtime);
    const flow = createEmptyFlow("7g0mkg5w480wvfgt");
    flow.spec.graph.start = "writer";
    flow.spec.graph.steps.writer = {
      expert: { ref: "expert:1xddvess309a6gme" },
      runtime: { ref: `runtime-profile:${generated.metadata.id}` },
    };
    flow.spec.graph.transitions.writer = { end: true };

    expect(validateFlowRuntimeSelections(flow, [...resources, generated])).toEqual([
      expect.objectContaining({
        stepId: "writer",
        message: "Choose a model when overriding the node Runtime.",
      }),
    ]);

    flow.spec.graph.steps.writer!.runtime!.modelSelection = {
      model: { providerId: "openai", modelId: "gpt-5.6" },
    };
    expect(validateFlowRuntimeSelections(flow, [...resources, generated])).toEqual([]);
  });
});
