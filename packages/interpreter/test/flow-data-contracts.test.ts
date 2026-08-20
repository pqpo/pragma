import { PRAGMA_DSL_WRITE_API_VERSION } from "../src/ast/index.ts";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { formatPragmaYaml, loadPragmaProject } from "../src/index.ts";
import {
  PragmaFlowResourceSchema,
  canonicalPragmaResourceRef,
  validatePragmaFlowDataContracts,
  type PragmaFlowResource,
  type PragmaResource,
} from "../src/ast/index.ts";

const ISSUE_OUTPUT = {
  type: "object" as const,
  properties: {
    issue_number: { type: "integer" as const },
    issue_url: { type: "string" as const },
  },
  required: ["issue_number", "issue_url"],
  additionalProperties: false as const,
};

function issueFlow(outputValue?: unknown): PragmaFlowResource {
  return PragmaFlowResourceSchema.parse({
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Flow",
    metadata: {
      id: "spmnna7k705rhjnj",
      name: "Issue report",
      description: "Create and confirm an issue.",
      tags: [],
    },
    spec: {
      output: {
        schema: ISSUE_OUTPUT,
        ...(outputValue === undefined ? {} : { value: outputValue }),
      },
      graph: {
        start: "create_issue",
        steps: {
          create_issue: {
            expert: { ref: "expert:1xddvess309a6gme" },
            prompt: { segments: [{ text: "Create the issue" }] },
            output: { schema: ISSUE_OUTPUT },
          },
          check: {
            human: {
              selectionMode: "single",
              prompt: { segments: [{ text: "Was it resolved?" }] },
              options: [
                { value: "resolved", label: "Resolved" },
                { value: "unresolved", label: "Unresolved" },
              ],
            },
          },
        },
        loops: {},
        transitions: {
          create_issue: "check",
          check: { end: true },
        },
      },
    },
  });
}

describe("Flow data contracts", () => {
  it("rejects a Human terminal result that cannot satisfy the Flow output contract", () => {
    expect(validatePragmaFlowDataContracts(issueFlow())).toEqual([
      expect.objectContaining({
        code: "flow.output.terminal_incompatible",
        stepId: "check",
        path: ["spec", "graph", "transitions", "check"],
      }),
    ]);
  });

  it("accepts an explicit result mapping from a required upstream structured output", () => {
    const flow = issueFlow({
      issue_number: "$state.nodes.create_issue.result.issue_number",
      issue_url: "$state.nodes.create_issue.result.issue_url",
    });

    expect(validatePragmaFlowDataContracts(flow)).toEqual([]);
  });

  it("checks every possible terminal path instead of validating only one End edge", () => {
    const flow = issueFlow();
    flow.spec.graph.transitions.create_issue = {
      route: "issue_url",
      cases: { immediate: { end: true } },
      fallback: "check",
    };

    expect(validatePragmaFlowDataContracts(flow)).toEqual([
      expect.objectContaining({
        code: "flow.output.terminal_incompatible",
        stepId: "check",
      }),
    ]);
  });

  it("validates Flow input fields in Human prompts", () => {
    const flow = issueFlow({
      issue_number: "$state.nodes.create_issue.result.issue_number",
      issue_url: "$state.nodes.create_issue.result.issue_url",
    });
    flow.spec.input = {
      schema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
    };
    flow.spec.graph.steps.check!.human!.prompt = {
      segments: [
        {
          variable: {
            source: "flow-input",
            path: ["missing"],
          },
        },
      ],
    };

    expect(validatePragmaFlowDataContracts(flow)).toEqual([
      expect.objectContaining({
        code: "flow.prompt.variable_path_invalid",
        stepId: "check",
        path: ["spec", "graph", "steps", "check", "human", "prompt", "segments", 0, "variable"],
      }),
    ]);
  });

  it("validates each routing stage against its node output fields", () => {
    const flow = issueFlow({
      issue_number: "$state.nodes.create_issue.result.issue_number",
      issue_url: "$state.nodes.create_issue.result.issue_url",
    });
    flow.spec.graph.transitions.create_issue = {
      route: "missing",
      cases: { next: "check" },
      fallback: { end: true },
    };

    expect(validatePragmaFlowDataContracts(flow)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "flow.route.field_invalid",
          stepId: "create_issue",
          path: ["spec", "graph", "transitions", "create_issue"],
        }),
      ]),
    );
  });

  it("requires complete type-aware routes in the canonical validator", () => {
    const flow = issueFlow({
      issue_number: "$state.nodes.create_issue.result.issue_number",
      issue_url: "$state.nodes.create_issue.result.issue_url",
    });
    flow.spec.graph.steps.create_issue!.output = {
      schema: {
        type: "object",
        properties: {
          ...ISSUE_OUTPUT.properties,
          labels: { type: "array", items: { type: "string" } },
          has_issue: { type: "boolean" },
          outcome: { type: "string" },
        },
        required: ["issue_number", "issue_url", "labels", "has_issue", "outcome"],
        additionalProperties: false,
      },
    };

    flow.spec.graph.transitions.create_issue = {
      route: "labels",
      branches: [],
      fallback: "check",
    };
    expect(validatePragmaFlowDataContracts(flow)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "flow.route.branches_missing",
          stepId: "create_issue",
        }),
      ]),
    );

    flow.spec.graph.transitions.create_issue = {
      route: "has_issue",
      cases: { true: { end: true } },
    };
    expect(validatePragmaFlowDataContracts(flow)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "flow.route.boolean_incomplete",
          stepId: "create_issue",
        }),
      ]),
    );

    flow.spec.graph.transitions.create_issue = {
      route: "outcome",
      cases: { success: { end: true } },
    };
    expect(validatePragmaFlowDataContracts(flow)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "flow.route.fallback_missing",
          stepId: "create_issue",
        }),
      ]),
    );
  });

  it("validates every nested Flow input mapping against the target input contract", () => {
    const child = PragmaFlowResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Flow",
      metadata: {
        id: "7k2m9q4v8np6r3dt",
        name: "Child",
        description: "Typed child Flow.",
        tags: [],
      },
      spec: {
        input: {
          schema: {
            type: "object",
            properties: { goal: { type: "string" } },
            required: ["goal"],
            additionalProperties: false,
          },
        },
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
    const parent = PragmaFlowResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Flow",
      metadata: {
        id: "t9ne4d8njvvxv2ea",
        name: "Parent",
        description: "Typed parent Flow.",
        tags: [],
      },
      spec: {
        input: {
          schema: {
            type: "object",
            properties: { goal: { type: "number" } },
            required: ["goal"],
            additionalProperties: false,
          },
        },
        graph: {
          start: "child",
          steps: {
            child: { flow: { ref: canonicalPragmaResourceRef(child) } },
          },
          loops: {},
          transitions: { child: { end: true } },
        },
      },
    });
    const resources = new Map<string, PragmaResource>([[canonicalPragmaResourceRef(child), child]]);

    expect(
      validatePragmaFlowDataContracts(parent, {
        resolveResource: (ref) => resources.get(ref),
      }),
    ).toEqual([
      expect.objectContaining({
        code: "flow.contract.type_mismatch",
        stepId: "child",
        path: ["spec", "graph", "steps", "child", "input"],
      }),
    ]);
  });

  it("surfaces terminal contract failures through project validation before save", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-flow-contract-"));
    const entry = join(root, "pragma.yaml");
    await writeFile(entry, formatPragmaYaml(issueFlow()));

    const diagnostics = await (await loadPragmaProject(entry)).validate();

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "flow.output.terminal_incompatible",
          path: ["spec", "graph", "transitions", "check"],
        }),
      ]),
    );
  });
});
