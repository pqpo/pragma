import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  createExpertAgentPluginPackageFingerprint,
  createStaticRuntimeResolver,
  type Expert,
  type ExpertTeam,
  type Flow,
} from "@pragma/core";

import {
  FlowActionRegistry,
  PRAGMA_EXPERT_ID_MAX_LENGTH,
  PRAGMA_EXPERT_INSTRUCTIONS_MAX_LENGTH,
  PRAGMA_EXPERT_SCOPE_MAX_LENGTH,
  PragmaExpertIdSchema,
  PragmaExpertRefSchema,
  PragmaExpertResourceSchema,
  PragmaFlowResourceSchema,
  PragmaSemanticResourceIdSchema,
  formatPragmaYaml,
  loadPragmaProject,
  type PragmaExpertResource,
} from "../src/index.ts";

describe("Pragma YAML DSL", () => {
  it("uses prompt variables, automatic result storage, and form-compatible structured output", () => {
    const base = {
      apiVersion: "pragma/v2",
      kind: "Flow",
      metadata: {
        id: "review",
        version: "1.0.0",
        name: "Review",
        description: "Review output",
        tags: [],
      },
      spec: {
        graph: {
          start: "draft",
          steps: {
            draft: {
              expert: { ref: "expert:writer@1.0.0" },
              version: "1.0.0",
              prompt: { segments: [{ text: "Write a draft" }] },
              output: {
                schema: {
                  type: "object",
                  properties: { score: { type: "number" } },
                  required: ["score"],
                  additionalProperties: false,
                },
              },
            },
            review: {
              expert: { ref: "expert:reviewer@1.0.0" },
              version: "1.0.0",
              prompt: {
                segments: [
                  { text: "Review score " },
                  {
                    variable: {
                      source: "node-output",
                      nodeId: "draft",
                      path: ["score"],
                    },
                  },
                ],
              },
            },
          },
          loops: {},
          transitions: { draft: "review", review: { end: true } },
        },
      },
    } as const;
    expect(PragmaFlowResourceSchema.safeParse(base).success).toBe(true);
    expect(
      PragmaFlowResourceSchema.safeParse({
        ...base,
        spec: {
          ...base.spec,
          graph: {
            ...base.spec.graph,
            steps: {
              ...base.spec.graph.steps,
              draft: { ...base.spec.graph.steps.draft, save: "state.draft" },
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it("uses one semantic ID rule and bounded required Expert text", () => {
    expect(PragmaSemanticResourceIdSchema.safeParse("code_reviewer_2").success).toBe(true);
    expect(PragmaSemanticResourceIdSchema.safeParse("code-reviewer").success).toBe(false);
    expect(PragmaSemanticResourceIdSchema.safeParse("code.reviewer").success).toBe(false);
    const maximumExpertId = "a".repeat(PRAGMA_EXPERT_ID_MAX_LENGTH);
    const oversizedExpertId = "a".repeat(PRAGMA_EXPERT_ID_MAX_LENGTH + 1);
    expect(PragmaExpertIdSchema.safeParse(maximumExpertId).success).toBe(true);
    expect(PragmaExpertIdSchema.safeParse(oversizedExpertId).success).toBe(false);
    expect(PragmaExpertRefSchema.safeParse(`expert:${maximumExpertId}@1.0.0`).success).toBe(true);
    expect(PragmaExpertRefSchema.safeParse(`expert:${oversizedExpertId}@1.0.0`).success).toBe(
      false,
    );
    expect(PragmaSemanticResourceIdSchema.safeParse(oversizedExpertId).success).toBe(true);
    expect(
      PragmaExpertResourceSchema.safeParse(expertResource(maximumExpertId, "Valid")).success,
    ).toBe(true);
    expect(
      PragmaExpertResourceSchema.safeParse(expertResource(oversizedExpertId, "Invalid")).success,
    ).toBe(false);

    const expert = expertResource("reviewer", "Reviews work");
    expect(
      PragmaExpertResourceSchema.safeParse({
        ...expert,
        spec: {
          ...expert.spec,
          scope: "界".repeat(PRAGMA_EXPERT_SCOPE_MAX_LENGTH),
          instructions: "令".repeat(PRAGMA_EXPERT_INSTRUCTIONS_MAX_LENGTH),
        },
      }).success,
    ).toBe(true);
    expect(
      PragmaExpertResourceSchema.safeParse({
        ...expert,
        spec: {
          ...expert.spec,
          scope: "界".repeat(PRAGMA_EXPERT_SCOPE_MAX_LENGTH + 1),
        },
      }).success,
    ).toBe(false);
    expect(
      PragmaExpertResourceSchema.safeParse({
        ...expert,
        spec: {
          ...expert.spec,
          instructions: "令".repeat(PRAGMA_EXPERT_INSTRUCTIONS_MAX_LENGTH + 1),
        },
      }).success,
    ).toBe(false);
    expect(
      PragmaExpertResourceSchema.safeParse({
        ...expert,
        spec: { ...expert.spec, instructions: undefined },
      }).success,
    ).toBe(false);
  });

  it("loads split resources, compiles an explicit loop, and dumps stable YAML", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-dsl-"));
    await mkdir(join(root, "flows", "review"), { recursive: true });
    await Promise.all([
      writeFile(
        join(root, "pragma.yaml"),
        [
          "apiVersion: pragma/v2",
          "kind: Bundle",
          "imports:",
          "  - ./flows/review/flow.pragma.yaml",
          "",
        ].join("\n"),
      ),
      writeFile(
        join(root, "flows", "review", "flow.pragma.yaml"),
        [
          "apiVersion: pragma/v2",
          "kind: Flow",
          "metadata:",
          "  id: review",
          "  version: 1.0.0",
          "  name: Review",
          "  description: Review until approved",
          "spec:",
          "  graph:",
          "    $include: ./graph.pragma.yaml",
          "",
        ].join("\n"),
      ),
      writeFile(
        join(root, "flows", "review", "graph.pragma.yaml"),
        [
          "start: review",
          "steps:",
          "  review:",
          "    action:",
          "      ref: action:review@1.0.0",
          "  decide:",
          "    action:",
          "      ref: action:decide@1.0.0",
          "loops:",
          "  revision:",
          "    entry: review",
          "    maxIterations: 3",
          "transitions:",
          "  review: decide",
          "  decide:",
          "    route: decision",
          "    cases:",
          "      revise:",
          "        repeat:",
          "          loop: revision",
          "          goto: review",
          "    fallback: { end: true }",
          "",
        ].join("\n"),
      ),
    ]);
    const actions = new FlowActionRegistry()
      .register({
        id: "review",
        version: "1.0.0",
        description: "review",
        execute: () => "reviewed",
      })
      .register({
        id: "decide",
        version: "1.0.0",
        description: "decide",
        execute: () => ({ decision: "revise" }),
      });

    const project = await loadPragmaProject(join(root, "pragma.yaml"));
    expect(await project.validate()).toEqual([]);
    const compiled = await project.compile<Flow>("flow:review@1.0.0", {
      workspace: root,
      actions,
    });
    expect(compiled.value.loops.get("revision")).toMatchObject({
      entryStepId: "review",
      maxIterations: 3,
    });
    const decide = compiled.value.transitions.get("decide");
    expect(decide).toMatchObject({ type: "route", field: "decision" });
    expect(decide?.type === "route" ? decide.cases.get("revise") : undefined).toMatchObject({
      type: "repeat",
      loopId: "revision",
    });
    const dumped = await project.dump(compiled.value, { split: "by-resource" });
    expect(dumped.files.get("flows/review@1.0.0.pragma.yaml")).toContain("kind: Flow");
    expect(dumped.files.get("pragma.lock.yaml")).toContain("compilerVersion: pragma.dsl/v2");
    const single = await project.dump(compiled.value, { split: "single" });
    await writeFile(join(root, "single.yaml"), single.files.get("pragma.yaml")!);
    expect((await loadPragmaProject(join(root, "single.yaml"))).listResources()).toHaveLength(1);
  });

  it("accepts a direct repeat transition and resolves canonical Flow expressions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-direct-repeat-"));
    const entry = join(root, "flow.pragma.yaml");
    await writeFile(
      entry,
      [
        "apiVersion: pragma/v2",
        "kind: Flow",
        "metadata:",
        "  id: retry",
        "  version: 1.0.0",
        "  name: Retry",
        "  description: Direct bounded repeat",
        "spec:",
        "  graph:",
        "    start: work",
        "    steps:",
        "      work:",
        "        action: { ref: action:work@1.0.0 }",
        '        input: { goal: "$flow.input.goal", summary: "{{ flow.input.goal }} / {{ state.previous }}" }',
        "      decide: { action: { ref: action:decide@1.0.0 } }",
        "    loops:",
        "      retry: { entry: work, maxIterations: 2 }",
        "    transitions:",
        "      work: decide",
        "      decide: { repeat: { loop: retry, goto: work } }",
        "",
      ].join("\n"),
    );
    const actions = new FlowActionRegistry()
      .register({ id: "work", version: "1.0.0", description: "work", execute: () => null })
      .register({ id: "decide", version: "1.0.0", description: "decide", execute: () => null });
    const project = await loadPragmaProject(entry);
    expect(await project.validate()).toEqual([]);
    const compiled = await project.compile<Flow>("flow:retry@1.0.0", {
      workspace: root,
      actions,
    });
    expect(compiled.value.transitions.get("decide")).toMatchObject({
      type: "repeat",
      loopId: "retry",
    });
    const input = compiled.value.steps.get("work")!.options.input;
    expect(typeof input).toBe("function");
    expect(
      (input as (context: { state: Record<string, unknown>; flowInput: unknown }) => unknown)({
        state: { previous: "done" },
        flowInput: { goal: "ship" },
      }),
    ).toEqual({ goal: "ship", summary: "ship / done" });
  });

  it("rejects JavaScript-style Flow interpolation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-invalid-expression-"));
    const entry = join(root, "flow.pragma.yaml");
    await writeFile(
      entry,
      [
        "apiVersion: pragma/v2",
        "kind: Flow",
        "metadata: { id: invalid_expression, version: 1.0.0, name: Invalid, description: Invalid expression }",
        "spec:",
        "  graph:",
        "    start: work",
        "    steps:",
        '      work: { action: { ref: action:work@1.0.0 }, input: "${flow.input.goal}" }',
        "    loops: {}",
        "    transitions: { work: { end: true } }",
        "",
      ].join("\n"),
    );
    const project = await loadPragmaProject(entry);
    expect(await project.validate()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "flow.expression.invalid", severity: "error" }),
      ]),
    );
  });

  it("compiles and dumps optional ExpertTeam instructions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-team-instructions-"));
    const entry = join(root, "pragma.yaml");
    const instructions = "Share evidence, surface uncertainty, and verify work before handoff.";
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: "pragma/v2",
        kind: "Bundle",
        imports: [],
        resources: [
          runtimeProfile(),
          expertResource("lead", "Coordinates delivery"),
          expertResource("reviewer", "Reviews delivery"),
          {
            apiVersion: "pragma/v2",
            kind: "ExpertTeam",
            metadata: {
              id: "delivery",
              version: "1.0.0",
              name: "Delivery",
              description: "Coordinates and reviews delivery",
              tags: [],
            },
            spec: {
              coordinator: { ref: "expert:lead@1.0.0" },
              members: [{ ref: "expert:reviewer@1.0.0" }],
              instructions,
              delegation: {},
            },
          },
        ],
      }),
    );

    const project = await loadPragmaProject(entry);
    expect(await project.validate()).toEqual([]);
    const compiled = await project.compile<ExpertTeam>("team:delivery@1.0.0", {
      workspace: root,
    });
    expect(compiled.value.instructions).toBe(instructions);
    const dumped = await project.dump(compiled.value, { split: "by-resource" });
    expect(dumped.files.get("teams/delivery@1.0.0.pragma.yaml")).toContain(
      `instructions: ${instructions}`,
    );
  });

  it("enforces an optional content-addressed lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-dsl-lock-"));
    const entry = join(root, "pragma.yaml");
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: "pragma/v2",
        kind: "Bundle",
        imports: [],
        resources: [runtimeProfile(), expertResource("writer", "Writes")],
      }),
    );
    const unlocked = await loadPragmaProject(entry);
    await writeFile(join(root, "pragma.lock.yaml"), formatPragmaYaml(unlocked.createLock()));
    expect(await (await loadPragmaProject(entry, { requireLock: true })).validate()).toEqual([]);
    await writeFile(entry, (await readFile(entry, "utf8")).replace("Writes", "Writes well"));
    expect(await (await loadPragmaProject(entry, { requireLock: true })).validate()).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "lock.mismatch" })]),
    );
  });

  it("turns an Expert, Team, or Flow reference into a tool through a versioned adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-dsl-tool-adapter-"));
    const entry = join(root, "pragma.yaml");
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: "pragma/v2",
        kind: "Bundle",
        imports: [],
        resources: [
          {
            apiVersion: "pragma/v2",
            kind: "Expert",
            metadata: {
              id: "reviewer",
              version: "1.0.0",
              name: "Reviewer",
              description: "Reviews work",
            },
            spec: expertSpec(),
          },
          {
            apiVersion: "pragma/v2",
            kind: "Expert",
            metadata: {
              id: "lead",
              version: "1.0.0",
              name: "Lead",
              description: "Leads work",
            },
            spec: {
              ...expertSpec("lead"),
              tools: [
                {
                  adapter: "pragma.tool.call@v1",
                  target: { ref: "expert:reviewer@1.0.0" },
                  tool: {
                    name: "call_reviewer",
                    description: "Call the reviewer",
                    approval: "none",
                    timeoutMs: 25,
                  },
                },
                {
                  adapter: "pragma.tool.call@v1",
                  target: { ref: "flow:approval@1.0.0" },
                  tool: {
                    name: "call_approval",
                    description: "Call the approval flow",
                    approval: "none",
                  },
                },
              ],
            },
          },
          {
            apiVersion: "pragma/v2",
            kind: "Flow",
            metadata: {
              id: "approval",
              version: "1.0.0",
              name: "Approval",
              description: "Collects approval",
              tags: [],
            },
            spec: {
              input: {
                schema: {
                  type: "object",
                  properties: { proposal: { type: "string" } },
                  required: ["proposal"],
                  additionalProperties: false,
                },
              },
              output: {
                schema: {
                  type: "object",
                  properties: { approved: { type: "boolean" } },
                  required: ["approved"],
                  additionalProperties: false,
                },
              },
              graph: {
                start: "approve",
                steps: {
                  approve: {
                    human: { kind: "approval", prompt: "Approve?" },
                    version: "1.0.0",
                  },
                },
                transitions: { approve: { end: true } },
              },
            },
          },
          runtimeProfile(),
        ],
      }),
    );
    const project = await loadPragmaProject(entry);
    const lead = (await project.compile<Expert>("expert:lead@1.0.0", { workspace: root })).value;
    const tool = lead.tools?.find((candidate) => candidate.name === "call_reviewer");
    const invokeResource = vi.fn(
      async (request: {
        readonly target: unknown;
        readonly input: unknown;
        readonly signal?: AbortSignal | undefined;
      }): Promise<unknown> => {
        void request;
        return { accepted: true };
      },
    );
    const result = await tool!.call({ prompt: "Review this" }, undefined, {
      execution: { executionId: "execution", invocationId: "invocation", depth: 0, invokeResource },
    });

    expect(result.isError).not.toBe(true);
    expect(result.details).toEqual({ accepted: true });
    expect(invokeResource).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { prompt: "Review this" },
        target: expect.objectContaining({ id: "reviewer", version: "1.0.0" }),
      }),
    );

    invokeResource.mockResolvedValueOnce(undefined);
    const empty = await tool!.call({}, undefined, {
      execution: { executionId: "execution", invocationId: "invocation", depth: 0, invokeResource },
    });
    expect(empty).toMatchObject({ text: "null", details: undefined });

    invokeResource.mockResolvedValueOnce(1n);
    const invalid = await tool!.call({}, undefined, {
      execution: { executionId: "execution", invocationId: "invocation", depth: 0, invokeResource },
    });
    expect(invalid).toMatchObject({
      isError: true,
      details: { code: "resource_call_failed" },
    });
    invokeResource.mockImplementationOnce(
      async (request) =>
        await new Promise<never>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
            once: true,
          });
        }),
    );
    const timedOut = await tool!.call({}, undefined, {
      execution: { executionId: "execution", invocationId: "invocation", depth: 0, invokeResource },
    });
    expect(timedOut).toMatchObject({
      isError: true,
      details: { code: "resource_call_timeout" },
    });
    const flowTool = lead.tools?.find((candidate) => candidate.name === "call_approval");
    expect(flowTool?.inputSchema).toEqual({
      type: "object",
      properties: { proposal: { type: "string" } },
      required: ["proposal"],
      additionalProperties: false,
    });
    expect(flowTool?.outputSchema).toEqual({
      type: "object",
      properties: { approved: { type: "boolean" } },
      required: ["approved"],
      additionalProperties: false,
    });
  });

  it("rejects an unmarked control-flow cycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-dsl-cycle-"));
    await writeFile(
      join(root, "flow.pragma.yaml"),
      [
        "apiVersion: pragma/v2",
        "kind: Flow",
        "metadata:",
        "  id: invalid",
        "  version: 1.0.0",
        "  name: Invalid",
        "  description: Invalid cycle",
        "spec:",
        "  graph:",
        "    start: one",
        "    steps:",
        "      one:",
        "        action: { ref: action:one@1.0.0 }",
        "      two:",
        "        action: { ref: action:two@1.0.0 }",
        "    transitions:",
        "      one: two",
        "      two: one",
        "",
      ].join("\n"),
    );
    const project = await loadPragmaProject(join(root, "flow.pragma.yaml"));
    expect(await project.validate()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "flow.graph.cycle.ordinary", severity: "error" }),
      ]),
    );
  });

  it("rejects unknown DSL fields and prototype-sensitive save paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-dsl-strict-"));
    await writeFile(
      join(root, "flow.pragma.yaml"),
      [
        "apiVersion: pragma/v2",
        "kind: Flow",
        "metadata:",
        "  id: unsafe",
        "  version: 1.0.0",
        "  name: Unsafe",
        "  description: Unsafe state path",
        "spec:",
        "  graph:",
        "    start: one",
        "    steps:",
        "      one:",
        "        action: { ref: action:one@1.0.0 }",
        "        save: state.__proto__.polluted",
        "    transitions:",
        "      one: { end: true }",
        "",
      ].join("\n"),
    );
    const project = await loadPragmaProject(join(root, "flow.pragma.yaml"));
    expect(await project.validate()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "schema.invalid", severity: "error" }),
      ]),
    );
    expect(
      PragmaExpertResourceSchema.safeParse({
        ...expertResource("strict", "Strict"),
        spec: { ...expertSpec(), toolApprovalz: { shell: "required" } },
      }).success,
    ).toBe(false);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("rejects Flow contracts outside the bounded object schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-flow-schema-"));
    await writeFile(
      join(root, "flow.pragma.yaml"),
      formatPragmaYaml({
        apiVersion: "pragma/v2",
        kind: "Flow",
        metadata: {
          id: "invalid_schema",
          version: "1.0.0",
          name: "Invalid schema",
          description: "Invalid JSON Schema",
          tags: [],
        },
        spec: {
          input: { schema: { type: "definitely-not-a-json-schema-type" } },
          graph: {
            start: "one",
            steps: { one: { action: { ref: "action:one@1.0.0" } } },
            transitions: { one: { end: true } },
          },
        },
      }),
    );
    const project = await loadPragmaProject(join(root, "flow.pragma.yaml"));
    expect(await project.validate()).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "schema.invalid" })]),
    );
  });

  it("does not let a repeat edge hide an ordinary edge with the same endpoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-dsl-multigraph-"));
    await writeFile(
      join(root, "flow.pragma.yaml"),
      [
        "apiVersion: pragma/v2",
        "kind: Flow",
        "metadata:",
        "  id: invalid",
        "  version: 1.0.0",
        "  name: Invalid",
        "  description: Mixed repeat and ordinary edge",
        "spec:",
        "  graph:",
        "    start: one",
        "    steps:",
        "      one: { action: { ref: action:one@1.0.0 } }",
        "      two: { action: { ref: action:two@1.0.0 } }",
        "    loops:",
        "      retry: { entry: one, maxIterations: 2 }",
        "    transitions:",
        "      one: two",
        "      two:",
        "        route: choice",
        "        cases:",
        "          unsafe: one",
        "          retry: { repeat: { loop: retry, goto: one } }",
        "        fallback: { end: true }",
        "",
      ].join("\n"),
    );
    const project = await loadPragmaProject(join(root, "flow.pragma.yaml"));
    expect(await project.validate()).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "flow.graph.cycle.ordinary" })]),
    );
  });

  it("requires loop onLimit transitions to leave the loop region", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-dsl-loop-limit-"));
    await writeFile(
      join(root, "flow.pragma.yaml"),
      [
        "apiVersion: pragma/v2",
        "kind: Flow",
        "metadata:",
        "  id: invalid",
        "  version: 1.0.0",
        "  name: Invalid",
        "  description: Loop limit cycles forever",
        "spec:",
        "  graph:",
        "    start: one",
        "    steps:",
        "      one: { action: { ref: action:one@1.0.0 } }",
        "      two: { action: { ref: action:two@1.0.0 } }",
        "    loops:",
        "      retry:",
        "        entry: one",
        "        maxIterations: 2",
        "        onLimit: one",
        "    transitions:",
        "      one: two",
        "      two: { repeat: { loop: retry, goto: one } }",
        "",
      ].join("\n"),
    );
    const project = await loadPragmaProject(join(root, "flow.pragma.yaml"));
    expect(await project.validate()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "flow.graph.loop.on_limit_not_exit" }),
      ]),
    );
  });

  it("rejects includes that escape the project root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pragma-dsl-path-"));
    const root = join(parent, "project");
    await mkdir(root);
    await writeFile(join(parent, "outside.yaml"), "start: nowhere\n");
    await writeFile(
      join(root, "flow.pragma.yaml"),
      [
        "apiVersion: pragma/v2",
        "kind: Flow",
        "metadata:",
        "  id: unsafe",
        "  version: 1.0.0",
        "  name: Unsafe",
        "  description: Unsafe include",
        "spec:",
        "  graph:",
        "    $include: ../outside.yaml",
        "",
      ].join("\n"),
    );
    const project = await loadPragmaProject(join(root, "flow.pragma.yaml"));
    expect(await project.validate()).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "source.parse" })]),
    );
  });

  it("marks registered but unusable RuntimeProfiles as unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-runtime-unusable-"));
    const entry = join(root, "pragma.yaml");
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: "pragma/v2",
        kind: "Bundle",
        imports: [],
        resources: [runtimeProfile(), expertResource("writer", "Writes")],
      }),
    );
    const project = await loadPragmaProject(entry);
    const runtimes = createStaticRuntimeResolver({
      defaultRuntimeId: "codex",
      runtimes: [
        {
          descriptor: { id: "codex", kind: "test", displayName: "Codex" },
          canUse: () => ({ usable: false, reason: "codex executable is missing" }),
        },
      ],
    });
    const inspection = await project.inspectEnvironment({ workspace: root, runtimes });
    expect(inspection.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: "runtime-profile:default_runtime@1.0.0",
          status: "needs_attention",
        }),
      ]),
    );
    expect(inspection.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "environment.runtime_unavailable",
          message: expect.stringContaining("executable is missing"),
        }),
      ]),
    );
  });

  it("lets a root execution override replace an unavailable Expert RuntimeProfile", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-runtime-override-"));
    const entry = join(root, "pragma.yaml");
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: "pragma/v2",
        kind: "Bundle",
        imports: [],
        resources: [runtimeProfile(), expertResource("writer", "Writes")],
      }),
    );
    const project = await loadPragmaProject(entry);
    const modelSelection = {
      model: { providerId: "deepseek", modelId: "deepseek-chat" },
      thinkingLevel: "high",
    };
    const compiled = await project.compile<Expert>("expert:writer@1.0.0", {
      workspace: root,
      runtimes: createStaticRuntimeResolver({
        defaultRuntimeId: "pi",
        runtimes: [
          {
            descriptor: { id: "pi", kind: "test", displayName: "Pi" },
            canUse: () => ({ usable: true }),
          },
        ],
      }),
      rootExecutionOverride: { runtimeId: "pi", modelSelection },
    });

    expect(compiled.rootRuntimeId).toBe("pi");
    expect(compiled.value.defaultRuntimeId).toBe("pi");
    expect(compiled.value.models?.default).toEqual(modelSelection);
  });

  it("fingerprints the verified Runtime installation identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-runtime-fingerprint-"));
    const entry = join(root, "pragma.yaml");
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: "pragma/v2",
        kind: "Bundle",
        imports: [],
        resources: [runtimeProfile(), expertResource("writer", "Writes")],
      }),
    );
    const project = await loadPragmaProject(entry);
    const compile = async (version: string) =>
      await project.compile<Expert>("expert:writer@1.0.0", {
        workspace: root,
        runtimes: createStaticRuntimeResolver({
          defaultRuntimeId: "codex",
          runtimes: [
            {
              descriptor: { id: "codex", kind: "test", displayName: "Codex" },
              canUse: () => ({ usable: true, details: { version } }),
              listModels: async () => [
                {
                  id: "model",
                  displayName: "Model",
                  provider: { kind: "runtime-managed", id: "test", displayName: "Test" },
                  default: true,
                },
              ],
            },
          ],
        }),
      });
    expect((await compile("1.0.0")).environmentFingerprint.value).not.toBe(
      (await compile("2.0.0")).environmentFingerprint.value,
    );
  });

  it("never downgrades capability-owned MCP approval requirements", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mcp-approvals-"));
    const entry = join(root, "pragma.yaml");
    const expert: PragmaExpertResource = expertResource("writer", "Writes");
    expert.spec.capabilities = [
      { ref: "capability:writer_tools@1.0.0", kind: "tools", tools: ["write"] },
    ];
    expert.spec.toolApprovals = { write: "none", mcp_writer_write: "none" };
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: "pragma/v2",
        kind: "Bundle",
        imports: [],
        resources: [
          runtimeProfile(),
          expert,
          {
            apiVersion: "pragma/v2",
            kind: "Capability",
            metadata: {
              id: "writer_tools",
              version: "1.0.0",
              name: "Writer tools",
              description: "Writes data",
              tags: [],
            },
            spec: {
              adapter: "pragma.capability.host@v1",
              binding: "binding:writer-tools",
              config: { key: "writer-tools" },
            },
          },
        ],
      }),
    );
    const project = await loadPragmaProject(entry);
    const compiled = await project.compile<Expert>("expert:writer@1.0.0", {
      workspace: root,
      adapterHost: {
        environmentId: "test",
        projectRoot: root,
        async resolveBinding(ref) {
          return {
            ref,
            revision: "1",
            fingerprint: "a".repeat(64),
            value: {
              contribution: {
                mcp: {
                  mcpServers: {
                    writer: {
                      name: "Writer",
                      transport: "in-process",
                      inProcess: {
                        listTools: async () => [{ name: "write" }],
                        callTool: async () => ({ ok: true }),
                      },
                      toolApprovals: { write: { mode: "required" } },
                    },
                  },
                },
              },
            },
          };
        },
        async resolveArtifact() {
          throw new Error("unused");
        },
        async resolveSecret() {
          return undefined;
        },
      },
    });
    expect(compiled.value.mcp?.mcpServers["writer"]?.toolApprovals?.["write"]?.mode).toBe(
      "required",
    );
  });

  it("links multiple versions of the same resource by exact reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-dsl-versions-"));
    await writeFile(
      join(root, "pragma.yaml"),
      formatPragmaYaml({
        apiVersion: "pragma/v2",
        kind: "Bundle",
        imports: [],
        resources: [
          runtimeProfile(),
          { ...runtimeProfile(), metadata: { ...runtimeProfile().metadata, version: "2.0.0" } },
          expertResource("writer", "Version one"),
          {
            ...expertResource("writer", "Version two"),
            metadata: { ...expertResource("writer", "Version two").metadata, version: "2.0.0" },
            spec: {
              ...expertSpec(),
              runtime: { ref: "runtime-profile:default_runtime@2.0.0" },
            },
          },
        ],
      }),
    );
    const project = await loadPragmaProject(join(root, "pragma.yaml"));
    expect(await project.validate()).toEqual([]);
    expect(
      (await project.compile<Expert>("expert:writer@1.0.0", { workspace: root })).value.version,
    ).toBe("1.0.0");
    expect(
      (await project.compile<Expert>("expert:writer@2.0.0", { workspace: root })).value.version,
    ).toBe("2.0.0");
    expect(
      await project.validateEnvironment({
        workspace: root,
        runtimes: createStaticRuntimeResolver({
          defaultRuntimeId: "other",
          runtimes: [
            {
              descriptor: { id: "other", kind: "test", displayName: "Other" },
              canUse: () => ({ usable: true }),
            },
          ],
        }),
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "environment.runtime_unavailable" }),
      ]),
    );
  });

  it("resolves exact plugin references and fingerprints the environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-dsl-plugin-"));
    const pluginRoot = join(root, "plugin");
    await mkdir(pluginRoot);
    const pluginManifest = {
      schemaVersion: "pragma.plugin/v2",
      id: "plugin.context",
      name: "Plugin context",
      description: "Test plugin",
      version: "0.0.0",
      tags: [],
      runtime: {
        type: "expert-agent-plugin",
        entry: "./index.mjs",
        trust: "trusted-host",
      },
      capabilities: [],
      configuration: { type: "object", properties: {}, additionalProperties: false },
      permissions: { filesystem: [], shell: [], network: [], environment: [] },
    };
    await Promise.all([
      writeFile(join(pluginRoot, "plugin.json"), JSON.stringify(pluginManifest)),
      writeFile(
        join(pluginRoot, "package.json"),
        JSON.stringify({ name: "plugin.context", version: "0.0.0", type: "module" }),
      ),
      writeFile(
        join(pluginRoot, "index.mjs"),
        `export default { id: "plugin.context", name: "Plugin context", description: "Test plugin", version: "0.0.0", tags: [], manifest: ${JSON.stringify(pluginManifest)}, setup: () => ({}) };`,
      ),
    ]);
    const packageFingerprint = await createExpertAgentPluginPackageFingerprint(pluginRoot);
    const expert = expertResource("writer", "Plugin writer");
    await writeFile(
      join(root, "pragma.yaml"),
      formatPragmaYaml({
        apiVersion: "pragma/v2",
        kind: "Bundle",
        imports: [],
        resources: [
          runtimeProfile(),
          {
            ...expert,
            spec: {
              ...expert.spec,
              plugins: [{ ref: "plugin:plugin.context@0.0.0", config: {} }],
            },
          },
        ],
      }),
    );
    const project = await loadPragmaProject(join(root, "pragma.yaml"));
    const inspectPlugin = vi.fn(async ({ binding }: { binding: { ref: string } }) => ({
      ref: binding.ref as `plugin:${string}@${string}`,
      status: "ready" as const,
      packageFingerprint,
      verificationFingerprint: "b".repeat(64),
      issues: [],
    }));
    await expect(
      project.validateEnvironment({
        workspace: root,
        plugins: { inspect: inspectPlugin, resolve: async () => Promise.reject(new Error()) },
      }),
    ).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "environment.plugin_unavailable" })]),
    );
    expect(inspectPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ expertRef: "expert:writer@1.0.0" }),
    );
    const compiled = await project.compile<Expert>("expert:writer@1.0.0", {
      workspace: root,
      pragmaHome: join(root, ".pragma"),
      plugins: {
        inspect: inspectPlugin,
        async resolve() {
          return {
            ref: "plugin:plugin.context@0.0.0" as const,
            source: pluginRoot,
            packageFingerprint,
            userConfig: {},
            verificationFingerprint: "b".repeat(64),
          };
        },
      },
    });
    expect(compiled.value.pluginLoadIssues).toBeUndefined();
    expect(compiled.environmentFingerprint.plugins).toEqual([
      {
        expertRef: "expert:writer@1.0.0",
        ref: "plugin:plugin.context@0.0.0",
        packageFingerprint,
        verificationFingerprint: "b".repeat(64),
      },
    ]);
    await expect(
      project.compile<Expert>("expert:writer@1.0.0", {
        workspace: root,
        plugins: {
          inspect: inspectPlugin,
          async resolve() {
            return {
              ref: "plugin:wrong@1.0.0" as const,
              source: pluginRoot,
              packageFingerprint,
              userConfig: {},
              verificationFingerprint: "b".repeat(64),
            };
          },
        },
      }),
    ).rejects.toThrow("returned plugin:wrong@1.0.0");
  });

  it("rejects multiple versions of one plugin in an Expert", () => {
    const expert = expertResource("writer", "Plugin writer");
    const result = PragmaExpertResourceSchema.safeParse({
      ...expert,
      spec: {
        ...expert.spec,
        plugins: [{ ref: "plugin:memory@1.0.0" }, { ref: "plugin:memory@2.0.0" }],
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: "An Expert can activate only one version of plugin memory.",
          }),
        ]),
      );
    }
  });
});

function runtimeProfile() {
  return {
    apiVersion: "pragma/v2" as const,
    kind: "RuntimeProfile" as const,
    metadata: {
      id: "default_runtime",
      version: "1.0.0",
      name: "Default Runtime",
      description: "Default test runtime",
      tags: [],
    },
    spec: {
      adapter: "pragma.runtime.profile@v1",
      config: { runtimeId: "codex" },
    },
  };
}

function expertSpec(scope = "writing") {
  return {
    scope,
    instructions: "Write concise text.",
    runtime: { ref: "runtime-profile:default_runtime@1.0.0" },
    capabilities: [],
    toolApprovals: {},
    contextStores: [],
    plugins: [],
    tools: [],
  };
}

function expertResource(id: string, description: string) {
  return {
    apiVersion: "pragma/v2" as const,
    kind: "Expert" as const,
    metadata: { id, version: "1.0.0", name: "Writer", description, tags: [] },
    spec: expertSpec(),
  };
}
