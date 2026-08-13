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
import { createRuntimeTestFeatures } from "@pragma/core/testing";
import { PRAGMA_TEXT_LIMITS } from "@pragma/shared";

import {
  FlowActionRegistry,
  PragmaExpertIdSchema,
  PragmaExpertMetadataSchema,
  PragmaExpertRefSchema,
  PragmaExpertResourceSchema,
  PragmaExpertTeamResourceSchema,
  PragmaExpertTeamInstructionsSchema,
  PragmaExpertTeamMetadataSchema,
  PragmaAutomationResourceSchema,
  PragmaCapabilityMetadataSchema,
  PragmaContextStoreMetadataSchema,
  PragmaFlowMetadataSchema,
  PragmaFlowPromptSchema,
  PragmaFlowResourceSchema,
  PragmaResourceSchema,
  PragmaSemanticResourceIdSchema,
  formatPragmaYaml,
  loadPragmaProject,
  migratePragmaCompilerProjectToCurrent,
  type PragmaExpertResource,
} from "../src/index.ts";

describe("Pragma YAML DSL", () => {
  it("parses agent-judge Evaluations through the top-level resource schema", () => {
    const resource = {
      apiVersion: "pragma/v4",
      kind: "Evaluation",
      metadata: {
        id: "7h8j9k0m1n2p3q4r",
        name: "Tool calling",
        description: "Agent tool-use dataset.",
        tags: ["evaluation"],
      },
      spec: {
        method: {
          type: "agent-judge",
          group: "Agent tool calling",
          execution: { mode: "mock" },
          cases: [
            {
              id: "lookup",
              name: "Lookup",
              prompt: "Look up the customer.",
              criteria: [{ id: "correct", description: "Returns the correct customer." }],
              assertions: { outputContains: [], outputNotContains: [], tools: [] },
              mocks: [],
            },
          ],
        },
      },
    } as const;

    expect(PragmaResourceSchema.parse(resource)).toMatchObject({
      kind: "Evaluation",
      spec: { method: { type: "agent-judge" } },
    });
    expect(
      PragmaResourceSchema.safeParse({
        ...resource,
        spec: { method: { ...resource.spec.method, type: "unknown-evaluation" } },
      }).success,
    ).toBe(false);
  });

  it("validates schedule Automations and forces Flow events into new Missions", () => {
    const resource = {
      apiVersion: "pragma/v4",
      kind: "Automation",
      metadata: {
        id: "bwam4c8ngby9w1w1",
        name: "Weekday review",
        description: "Run a review every weekday",
        tags: [],
      },
      spec: {
        adapter: "pragma.automation.schedule@v1",
        binding: "binding:desktop-automation",
        config: {
          trigger: {
            kind: "calendar",
            frequency: "weekdays",
            time: "09:00",
            timezone: "Asia/Shanghai",
          },
        },
        enabled: true,
        route: {
          executor: { ref: "expert:3sfd30h5017wd17d" },
          input: { kind: "prompt", value: "Review the current work." },
        },
        interaction: { mode: "reuse-session" },
        delivery: { adapter: "pragma.automation.delivery.local@v1" },
      },
    } as const;

    expect(PragmaAutomationResourceSchema.parse(resource)).toMatchObject({
      kind: "Automation",
      spec: { interaction: { mode: "reuse-session" } },
    });
    expect(
      PragmaAutomationResourceSchema.safeParse({
        ...resource,
        spec: {
          ...resource.spec,
          route: {
            executor: { ref: "flow:t9ne4d8njvvxv2ea" },
            input: { kind: "flow", value: { goal: "Review" } },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      PragmaAutomationResourceSchema.safeParse({
        ...resource,
        spec: {
          ...resource.spec,
          route: {
            executor: { ref: "flow:t9ne4d8njvvxv2ea" },
            input: { kind: "flow", value: { goal: "Review" } },
          },
          interaction: { mode: "new-mission" },
        },
      }).success,
    ).toBe(true);
    expect(
      PragmaAutomationResourceSchema.safeParse({
        ...resource,
        spec: {
          ...resource.spec,
          route: {
            executor: { ref: "flow:t9ne4d8njvvxv2ea" },
            input: { kind: "prompt", value: "Review" },
          },
          interaction: { mode: "new-mission" },
        },
      }).success,
    ).toBe(true);
  });

  it("enforces Automation authoring limits at the shared DSL boundary", () => {
    const resource = {
      apiVersion: "pragma/v4",
      kind: "Automation",
      metadata: {
        id: "61207gbst92e9xc4",
        name: "n".repeat(PRAGMA_TEXT_LIMITS.automation.name),
        description: "d".repeat(PRAGMA_TEXT_LIMITS.automation.description),
        tags: [],
      },
      spec: {
        adapter: "pragma.automation.schedule@v1",
        binding: "binding:desktop-automation",
        config: {
          trigger: {
            kind: "calendar",
            frequency: "daily",
            time: "09:00",
            timezone: "UTC",
          },
        },
        enabled: true,
        route: {
          executor: { ref: "expert:3sfd30h5017wd17d" },
          input: {
            kind: "prompt",
            value: "p".repeat(PRAGMA_TEXT_LIMITS.automation.prompt),
          },
        },
        interaction: { mode: "reuse-session" },
        delivery: { adapter: "pragma.automation.delivery.local@v1" },
      },
    } as const;

    expect(PragmaAutomationResourceSchema.safeParse(resource).success).toBe(true);
    for (const candidate of [
      {
        ...resource,
        metadata: {
          ...resource.metadata,
          id: "invalid_id",
        },
      },
      {
        ...resource,
        metadata: {
          ...resource.metadata,
          name: "n".repeat(PRAGMA_TEXT_LIMITS.automation.name + 1),
        },
      },
      {
        ...resource,
        metadata: {
          ...resource.metadata,
          description: "d".repeat(PRAGMA_TEXT_LIMITS.automation.description + 1),
        },
      },
      {
        ...resource,
        spec: {
          ...resource.spec,
          route: {
            ...resource.spec.route,
            input: {
              kind: "prompt" as const,
              value: "p".repeat(PRAGMA_TEXT_LIMITS.automation.prompt + 1),
            },
          },
        },
      },
    ]) {
      expect(PragmaAutomationResourceSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("validates fixed Flow Automation input against the referenced schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-automation-flow-input-"));
    const flow = PragmaFlowResourceSchema.parse({
      apiVersion: "pragma/v4",
      kind: "Flow",
      metadata: {
        id: "t9ne4d8njvvxv2ea",
        name: "Review",
        description: "Reviews one issue",
        tags: [],
      },
      spec: {
        input: {
          schema: {
            type: "object",
            properties: { issueId: { type: "string" } },
            required: ["issueId"],
            additionalProperties: false,
          },
        },
        graph: {
          start: "review",
          steps: {
            review: {
              action: { ref: "action:review@1.0.0" },
            },
          },
          transitions: { review: { end: true } },
        },
      },
    });
    const automation = (
      id: string,
      input:
        | { kind: "prompt"; value: string }
        | {
            kind: "flow";
            value: Record<string, unknown>;
          },
    ) =>
      PragmaAutomationResourceSchema.parse({
        apiVersion: "pragma/v4",
        kind: "Automation",
        metadata: {
          id,
          name: id,
          description: "Runs the review Flow",
          tags: [],
        },
        spec: {
          adapter: "pragma.automation.schedule@v1",
          binding: "binding:desktop-automation",
          config: {
            trigger: {
              kind: "calendar",
              frequency: "daily",
              time: "09:00",
              timezone: "UTC",
            },
          },
          enabled: true,
          route: { executor: { ref: "flow:t9ne4d8njvvxv2ea" }, input },
          interaction: { mode: "new-mission" },
          delivery: { adapter: "pragma.automation.delivery.local@v1" },
        },
      });
    const entry = join(root, "pragma.yaml");
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: "pragma/v4",
        kind: "Bundle",
        imports: [],
        resources: [
          flow,
          automation("n3dhn640ddj7v78e", { kind: "prompt", value: "Review it" }),
          automation("f198ngwwrn1k8284", { kind: "flow", value: {} }),
          automation("ztvrawv2rzx87724", { kind: "flow", value: { issueId: "ISSUE-1" } }),
        ],
      }),
    );

    const diagnostics = await (await loadPragmaProject(entry)).validate();
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "automation.input.kind_invalid",
          path: ["spec", "route", "input"],
        }),
        expect.objectContaining({
          code: "automation.input.schema_invalid",
          path: ["spec", "route", "input", "value", "issueId"],
        }),
      ]),
    );
    expect(
      diagnostics.filter((diagnostic) => diagnostic.code.startsWith("automation.input.")),
    ).toHaveLength(2);
  });

  it("uses prompt variables, automatic result storage, and form-compatible structured output", () => {
    const base = {
      apiVersion: "pragma/v4",
      kind: "Flow",
      metadata: {
        id: "t9ne4d8njvvxv2ea",
        name: "Review",
        description: "Review output",
        tags: [],
      },
      spec: {
        graph: {
          start: "draft",
          steps: {
            draft: {
              expert: { ref: "expert:1xddvess309a6gme" },
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
              expert: { ref: "expert:3sfd30h5017wd17d" },
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
    expect(PragmaSemanticResourceIdSchema.safeParse("1h2j3k4m5n6p7q8r").success).toBe(true);
    expect(PragmaSemanticResourceIdSchema.safeParse("code-reviewer").success).toBe(false);
    expect(PragmaSemanticResourceIdSchema.safeParse("code.reviewer").success).toBe(false);
    const maximumExpertId = "a".repeat(16);
    const oversizedExpertId = "a".repeat(17);
    expect(PragmaExpertIdSchema.safeParse(maximumExpertId).success).toBe(true);
    expect(PragmaExpertIdSchema.safeParse(oversizedExpertId).success).toBe(false);
    expect(PragmaExpertRefSchema.safeParse(`expert:${maximumExpertId}`).success).toBe(true);
    expect(PragmaExpertRefSchema.safeParse(`expert:${oversizedExpertId}`).success).toBe(false);
    expect(PragmaSemanticResourceIdSchema.safeParse(oversizedExpertId).success).toBe(false);
    expect(
      PragmaExpertResourceSchema.safeParse(expertResource(maximumExpertId, "Valid")).success,
    ).toBe(true);
    expect(
      PragmaExpertResourceSchema.safeParse(expertResource(oversizedExpertId, "Invalid")).success,
    ).toBe(false);

    const expert = expertResource("3sfd30h5017wd17d", "Reviews work");
    expect(
      PragmaExpertResourceSchema.safeParse({
        ...expert,
        spec: {
          ...expert.spec,
          scope: "界".repeat(PRAGMA_TEXT_LIMITS.expert.scope),
          instructions: "令".repeat(PRAGMA_TEXT_LIMITS.expert.instructions),
        },
      }).success,
    ).toBe(true);
    expect(
      PragmaExpertResourceSchema.safeParse({
        ...expert,
        spec: {
          ...expert.spec,
          scope: "界".repeat(PRAGMA_TEXT_LIMITS.expert.scope + 1),
        },
      }).success,
    ).toBe(false);
    expect(
      PragmaExpertResourceSchema.safeParse({
        ...expert,
        spec: {
          ...expert.spec,
          instructions: "令".repeat(PRAGMA_TEXT_LIMITS.expert.instructions + 1),
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

  it("applies the shared metadata and prompt limits to every bounded DSL resource", () => {
    const id = "3sfd30h5017wd17d";
    const metadata = (name: string, description: string, tags: readonly string[] = []) => ({
      id,
      name,
      description,
      tags,
    });
    expect(
      PragmaExpertMetadataSchema.safeParse(
        metadata(
          "😀".repeat(PRAGMA_TEXT_LIMITS.expert.name),
          "说".repeat(PRAGMA_TEXT_LIMITS.expert.description),
          Array.from({ length: PRAGMA_TEXT_LIMITS.expert.tags }, () =>
            "标".repeat(PRAGMA_TEXT_LIMITS.expert.tag),
          ),
        ),
      ).success,
    ).toBe(true);
    expect(
      PragmaExpertMetadataSchema.safeParse(
        metadata("Expert", "Description", ["标".repeat(PRAGMA_TEXT_LIMITS.expert.tag + 1)]),
      ).success,
    ).toBe(false);
    expect(
      PragmaExpertMetadataSchema.safeParse(
        metadata(
          "Expert",
          "Description",
          Array.from({ length: PRAGMA_TEXT_LIMITS.expert.tags + 1 }, (_, index) => `tag${index}`),
        ),
      ).success,
    ).toBe(false);

    for (const [schema, limits] of [
      [PragmaExpertTeamMetadataSchema, PRAGMA_TEXT_LIMITS.expertTeam],
      [PragmaFlowMetadataSchema, PRAGMA_TEXT_LIMITS.flow],
      [PragmaCapabilityMetadataSchema, PRAGMA_TEXT_LIMITS.capability],
      [PragmaContextStoreMetadataSchema, PRAGMA_TEXT_LIMITS.contextStore],
    ] as const) {
      expect(
        schema.safeParse(metadata("名".repeat(limits.name), "述".repeat(limits.description)))
          .success,
      ).toBe(true);
      expect(schema.safeParse(metadata("名".repeat(limits.name + 1), "Description")).success).toBe(
        false,
      );
      expect(schema.safeParse(metadata("Name", "述".repeat(limits.description + 1))).success).toBe(
        false,
      );
    }

    expect(
      PragmaExpertTeamInstructionsSchema.safeParse(
        "令".repeat(PRAGMA_TEXT_LIMITS.expertTeam.instructions),
      ).success,
    ).toBe(true);
    expect(
      PragmaFlowPromptSchema.safeParse({
        segments: [
          { text: "甲".repeat(PRAGMA_TEXT_LIMITS.flow.promptTextSegment) },
          { variable: { source: "flow-input", path: ["goal"] } },
          { text: "乙".repeat(PRAGMA_TEXT_LIMITS.flow.promptTextSegment) },
        ],
      }).success,
    ).toBe(true);
    expect(
      PragmaFlowPromptSchema.safeParse({
        segments: [{ text: "甲".repeat(PRAGMA_TEXT_LIMITS.flow.promptTextSegment + 1) }],
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
          "apiVersion: pragma/v4",
          "kind: Bundle",
          "imports:",
          "  - ./flows/review/flow.pragma.yaml",
          "",
        ].join("\n"),
      ),
      writeFile(
        join(root, "flows", "review", "flow.pragma.yaml"),
        [
          "apiVersion: pragma/v4",
          "kind: Flow",
          "metadata:",
          "  id: t9ne4d8njvvxv2ea",
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
    const compiled = await project.compile<Flow>("flow:t9ne4d8njvvxv2ea", {
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
    expect(dumped.files.get("flows/t9ne4d8njvvxv2ea.pragma.yaml")).toContain("kind: Flow");
    expect(dumped.files.get("pragma.lock.yaml")).toContain("compilerVersion: pragma.dsl/v7");
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
        "apiVersion: pragma/v4",
        "kind: Flow",
        "metadata:",
        "  id: a1zhjn7y341f1y3x",
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
    const compiled = await project.compile<Flow>("flow:a1zhjn7y341f1y3x", {
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
        "apiVersion: pragma/v4",
        "kind: Flow",
        "metadata: { id: p5tb2v7ns1tmevx1, name: Invalid, description: Invalid expression }",
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
        apiVersion: "pragma/v4",
        kind: "Bundle",
        imports: [],
        resources: [
          runtimeProfile(),
          expertResource("mrvsehytqfmb814x", "Coordinates delivery"),
          expertResource("3sfd30h5017wd17d", "Reviews delivery"),
          {
            apiVersion: "pragma/v4",
            kind: "ExpertTeam",
            metadata: {
              id: "vyv9pwwzaksth2dd",
              name: "Delivery",
              description: "Coordinates and reviews delivery",
              tags: [],
            },
            spec: {
              coordinator: { ref: "expert:mrvsehytqfmb814x" },
              members: [{ ref: "expert:3sfd30h5017wd17d" }],
              instructions,
              delegation: {},
            },
          },
        ],
      }),
    );

    const project = await loadPragmaProject(entry);
    expect(await project.validate()).toEqual([]);
    const compiled = await project.compile<ExpertTeam>("team:vyv9pwwzaksth2dd", {
      workspace: root,
    });
    expect(compiled.value.instructions).toBe(instructions);
    const dumped = await project.dump(compiled.value, { split: "by-resource" });
    expect(dumped.files.get("teams/vyv9pwwzaksth2dd.pragma.yaml")).toContain(
      `instructions: ${instructions}`,
    );
  });

  it("defaults Team ContextStore visibility to all and rejects empty or unknown visibility", () => {
    const base = {
      apiVersion: "pragma/v4",
      kind: "ExpertTeam",
      metadata: {
        id: "vyv9pwwzaksth2dd",
        name: "Delivery",
        description: "Coordinates delivery",
        tags: [],
      },
      spec: {
        coordinator: { ref: "expert:mrvsehytqfmb814x" },
        members: [{ ref: "expert:3sfd30h5017wd17d" }],
        instructions: "Coordinate delivery.",
        delegation: {},
      },
    } as const;
    const defaultVisibility = PragmaExpertTeamResourceSchema.parse({
      ...base,
      spec: {
        ...base.spec,
        contextStores: [
          {
            ref: "context-store:01h8j2k3m4n5p6q7",
            namespace: "delivery_docs",
          },
        ],
      },
    });
    expect(defaultVisibility.spec.contextStores[0]?.visibility).toEqual({ mode: "all" });

    expect(
      PragmaExpertTeamResourceSchema.safeParse({
        ...base,
        spec: {
          ...base.spec,
          contextStores: [
            {
              ref: "context-store:01h8j2k3m4n5p6q7",
              namespace: "delivery_docs",
              visibility: {
                mode: "blacklist",
                expertIds: ["mrvsehytqfmb814x", "3sfd30h5017wd17d"],
              },
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      PragmaExpertTeamResourceSchema.safeParse({
        ...base,
        spec: {
          ...base.spec,
          contextStores: [
            {
              ref: "context-store:01h8j2k3m4n5p6q7",
              namespace: "delivery_docs",
              visibility: { mode: "whitelist", expertIds: ["0000000000000001"] },
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("keeps the pragma/v4 ExpertTeam avatar field readable", () => {
    const parsed = PragmaExpertTeamResourceSchema.parse({
      apiVersion: "pragma/v4",
      kind: "ExpertTeam",
      metadata: {
        id: "vyv9pwwzaksth2dd",
        avatarId: "pragma.avatar.team.default",
        name: "Delivery",
        description: "Coordinates delivery",
        tags: [],
      },
      spec: {
        coordinator: { ref: "expert:mrvsehytqfmb814x" },
        members: [{ ref: "expert:3sfd30h5017wd17d" }],
        delegation: {},
      },
    });

    expect(parsed.metadata.avatarId).toBe("pragma.avatar.team.default");
  });

  it("enforces an optional content-addressed lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-dsl-lock-"));
    const entry = join(root, "pragma.yaml");
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: "pragma/v4",
        kind: "Bundle",
        imports: [],
        resources: [runtimeProfile(), expertResource("1xddvess309a6gme", "Writes")],
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

  it("rejects an unsupported compiler before reporting schema or lock mismatches", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-dsl-compiler-version-"));
    const entry = join(root, "pragma.yaml");
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: "pragma/v4",
        kind: "Bundle",
        imports: [],
        resources: [runtimeProfile(), expertResource("1xddvess309a6gme", "Writes")],
      }),
    );
    const unlocked = await loadPragmaProject(entry);
    await writeFile(
      join(root, "pragma.lock.yaml"),
      formatPragmaYaml({
        ...unlocked.createLock(),
        compilerVersion: "pragma.dsl/v99",
      }),
    );

    const project = await loadPragmaProject(entry, { requireLock: true });
    expect(await project.validate()).toEqual([
      expect.objectContaining({
        code: "compiler.version_unsupported",
        path: ["compilerVersion"],
      }),
    ]);
    await expect(
      project.compile("expert:1xddvess309a6gme", { workspace: root }),
    ).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({
          code: "compiler.version_unsupported",
        }),
      ],
    });
  });

  it("reports revision metadata and lock compiler disagreement explicitly", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-dsl-compiler-metadata-"));
    const entry = join(root, "pragma.yaml");
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: "pragma/v4",
        kind: "Bundle",
        imports: [],
        resources: [runtimeProfile(), expertResource("1xddvess309a6gme", "Writes")],
      }),
    );
    const unlocked = await loadPragmaProject(entry);
    await writeFile(join(root, "pragma.lock.yaml"), formatPragmaYaml(unlocked.createLock()));

    const project = await loadPragmaProject(entry, {
      requireLock: true,
      revisionCompilerVersion: "pragma.dsl/v2",
    });
    expect(await project.validate()).toEqual([
      expect.objectContaining({ code: "compiler.version_metadata_mismatch" }),
    ]);
  });

  it("rejects unsupported revision compiler metadata even when the lock is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-dsl-compiler-metadata-without-lock-"));
    const entry = join(root, "pragma.yaml");
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: "pragma/v4",
        kind: "Bundle",
        imports: [],
        resources: [runtimeProfile(), expertResource("1xddvess309a6gme", "Writes")],
      }),
    );

    const project = await loadPragmaProject(entry, {
      requireLock: true,
      revisionCompilerVersion: "pragma.dsl/v99",
    });
    expect(await project.validate()).toEqual([
      expect.objectContaining({
        code: "compiler.version_unsupported",
        message: expect.stringContaining("revision metadata"),
        path: ["compilerVersion"],
      }),
    ]);
    await expect(
      project.compile("expert:1xddvess309a6gme", { workspace: root }),
    ).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({
          code: "compiler.version_unsupported",
        }),
      ],
    });
  });

  it("requires pragma.dsl/v2 revisions to be upgraded before normal loading", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-dsl-compiler-v2-"));
    const entry = join(root, "pragma.yaml");
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: "pragma/v4",
        kind: "Bundle",
        imports: [],
        resources: [runtimeProfile(), expertResource("1xddvess309a6gme", "Writes")],
      }),
    );
    const unlocked = await loadPragmaProject(entry);
    await writeFile(
      join(root, "pragma.lock.yaml"),
      formatPragmaYaml({
        ...unlocked.createLock(),
        compilerVersion: "pragma.dsl/v2",
      }),
    );

    const project = await loadPragmaProject(entry, {
      requireLock: true,
      revisionCompilerVersion: "pragma.dsl/v2",
    });
    expect(await project.validate()).toEqual([
      expect.objectContaining({ code: "compiler.version_upgrade_required" }),
    ]);
    await expect(
      project.compile("expert:1xddvess309a6gme", { workspace: root }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "compiler.version_upgrade_required" })],
    });
  });

  it("upgrades a real compiler v2 runDry fixture without preserving the rejected branch", async () => {
    const fixture = join(import.meta.dirname, "fixtures", "compiler-v2-run-dry");
    const files = new Map([
      ["pragma.yaml", await readFile(join(fixture, "pragma.yaml"), "utf8")],
      ["pragma.lock.yaml", await readFile(join(fixture, "pragma.lock.yaml"), "utf8")],
      [
        "flows/8h9j0k1m2n3p4q5r.pragma.yaml",
        await readFile(join(fixture, "flows", "8h9j0k1m2n3p4q5r.pragma.yaml"), "utf8"),
      ],
    ]);

    const migrated = migratePragmaCompilerProjectToCurrent({
      files,
      revisionCompilerVersion: "pragma.dsl/v2",
    });

    expect(migrated).toMatchObject({
      sourceCompilerVersion: "pragma.dsl/v2",
      targetCompilerVersion: "pragma.dsl/v7",
      migrated: true,
    });
    expect(migrated.resources).toEqual([
      expect.objectContaining({
        kind: "Flow",
        spec: expect.not.objectContaining({ runDry: expect.anything() }),
      }),
    ]);
  });

  it("upgrades a project fixture written by compiler v3 to the shared text-limit compiler", async () => {
    const fixture = join(import.meta.dirname, "fixtures", "compiler-v3-text-limits");
    const migrated = migratePragmaCompilerProjectToCurrent({
      files: new Map([
        ["pragma.yaml", await readFile(join(fixture, "pragma.yaml"), "utf8")],
        ["pragma.lock.yaml", await readFile(join(fixture, "pragma.lock.yaml"), "utf8")],
      ]),
      revisionCompilerVersion: "pragma.dsl/v3",
    });

    expect(migrated).toMatchObject({
      sourceCompilerVersion: "pragma.dsl/v3",
      targetCompilerVersion: "pragma.dsl/v7",
      migrated: true,
      resources: [expect.objectContaining({ kind: "Expert" })],
    });
  });

  it("upgrades a compiler v4 ExpertTeam fixture with an empty ContextStore list", async () => {
    const fixture = join(import.meta.dirname, "fixtures", "compiler-v4-expert-team");
    const migrated = migratePragmaCompilerProjectToCurrent({
      files: new Map([
        ["pragma.yaml", await readFile(join(fixture, "pragma.yaml"), "utf8")],
        ["pragma.lock.yaml", await readFile(join(fixture, "pragma.lock.yaml"), "utf8")],
      ]),
      revisionCompilerVersion: "pragma.dsl/v4",
    });

    expect(migrated).toMatchObject({
      sourceCompilerVersion: "pragma.dsl/v4",
      targetCompilerVersion: "pragma.dsl/v7",
      migrated: true,
      resources: [
        expect.objectContaining({
          kind: "ExpertTeam",
          spec: expect.objectContaining({ contextStores: [] }),
        }),
      ],
    });
  });

  it("upgrades a compiler v5 Expert fixture with the default avatar metadata", async () => {
    const fixture = join(import.meta.dirname, "fixtures", "compiler-v5-avatar");
    const migrated = migratePragmaCompilerProjectToCurrent({
      files: new Map([
        ["pragma.yaml", await readFile(join(fixture, "pragma.yaml"), "utf8")],
        ["pragma.lock.yaml", await readFile(join(fixture, "pragma.lock.yaml"), "utf8")],
      ]),
      revisionCompilerVersion: "pragma.dsl/v5",
    });

    expect(migrated).toMatchObject({
      sourceCompilerVersion: "pragma.dsl/v5",
      targetCompilerVersion: "pragma.dsl/v7",
      migrated: true,
      resources: [
        expect.objectContaining({
          apiVersion: "pragma/v4",
          kind: "Expert",
          metadata: expect.objectContaining({ avatarId: "pragma.avatar.expert.default" }),
        }),
      ],
    });
  });

  it("upgrades a compiler v6 flow-run-dry Evaluation fixture to v7", async () => {
    const fixture = join(import.meta.dirname, "fixtures", "compiler-v6-flow-run-dry-evaluation");
    const migrated = migratePragmaCompilerProjectToCurrent({
      files: new Map([
        ["pragma.yaml", await readFile(join(fixture, "pragma.yaml"), "utf8")],
        ["pragma.lock.yaml", await readFile(join(fixture, "pragma.lock.yaml"), "utf8")],
      ]),
      revisionCompilerVersion: "pragma.dsl/v6",
    });

    expect(migrated).toMatchObject({
      sourceCompilerVersion: "pragma.dsl/v6",
      targetCompilerVersion: "pragma.dsl/v7",
      migrated: true,
      resources: [
        expect.objectContaining({
          kind: "Evaluation",
          spec: expect.objectContaining({
            method: expect.objectContaining({ type: "flow-run-dry" }),
          }),
        }),
      ],
    });
  });

  it("rejects an over-limit compiler v3 fixture with the exact field diagnostic", async () => {
    const fixture = join(import.meta.dirname, "fixtures", "compiler-v3-over-limit");
    const files = new Map([
      ["pragma.yaml", await readFile(join(fixture, "pragma.yaml"), "utf8")],
      ["pragma.lock.yaml", await readFile(join(fixture, "pragma.lock.yaml"), "utf8")],
    ]);
    expect(() =>
      migratePragmaCompilerProjectToCurrent({
        files,
        revisionCompilerVersion: "pragma.dsl/v3",
      }),
    ).toThrow(/metadata\.name/u);
  });

  it("rejects compiler migration when a historical v2 source no longer matches its lock", async () => {
    const fixture = join(import.meta.dirname, "fixtures", "compiler-v2-run-dry");
    const flowPath = join(fixture, "flows", "8h9j0k1m2n3p4q5r.pragma.yaml");
    const files = new Map([
      ["pragma.yaml", await readFile(join(fixture, "pragma.yaml"), "utf8")],
      ["pragma.lock.yaml", await readFile(join(fixture, "pragma.lock.yaml"), "utf8")],
      [
        "flows/8h9j0k1m2n3p4q5r.pragma.yaml",
        (await readFile(flowPath, "utf8")).replace("Historical Run Dry", "Tampered"),
      ],
    ]);

    expect(() =>
      migratePragmaCompilerProjectToCurrent({
        files,
        revisionCompilerVersion: "pragma.dsl/v2",
      }),
    ).toThrow(expect.objectContaining({ code: "lock_mismatch" }));
  });

  it("rejects future compiler revisions instead of guessing an upgrade path", () => {
    expect(() =>
      migratePragmaCompilerProjectToCurrent({
        files: new Map(),
        revisionCompilerVersion: "pragma.dsl/v99",
      }),
    ).toThrow(expect.objectContaining({ code: "future_compiler_version" }));
  });

  it("compiles only the target dependency closure while preserving full project diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-dsl-scoped-validation-"));
    const entry = join(root, "pragma.yaml");
    const brokenFlow = {
      apiVersion: "pragma/v4" as const,
      kind: "Flow" as const,
      metadata: {
        id: "t4kw6k4qpw8a7tjw",
        name: "Broken Flow",
        description: "Contains an unrelated ordinary cycle",
        tags: [],
      },
      spec: {
        graph: {
          start: "one",
          steps: {
            one: { action: { ref: "action:one@1.0.0" } },
            two: { action: { ref: "action:two@1.0.0" } },
          },
          transitions: {
            one: "two",
            two: "one",
          },
        },
      },
    };
    const unrelatedEvaluation = {
      apiVersion: "pragma/v4" as const,
      kind: "Evaluation" as const,
      metadata: {
        id: "7k2m9q4v8np6r3dt",
        name: "Missing Flow Evaluation",
        description: "Targets an unrelated missing Flow",
        tags: [],
      },
      spec: {
        target: { ref: "flow:9h0j1k2m3n4p5q6r" },
        method: {
          type: "flow-run-dry" as const,
          cases: [
            {
              id: "missing_flow",
              name: "Missing Flow",
              input: {},
              mocks: {},
              expect: { status: "succeeded" as const, path: [] },
            },
          ],
        },
      },
    };
    const sources = [
      ["runtime.pragma.yaml", runtimeProfile()],
      ["expert.pragma.yaml", expertResource("1xddvess309a6gme", "Independent")],
      ["flow.pragma.yaml", brokenFlow],
      ["evaluation.pragma.yaml", unrelatedEvaluation],
    ] as const;
    for (const [fileName, resource] of sources) {
      await writeFile(join(root, fileName), formatPragmaYaml(resource));
    }
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: "pragma/v4",
        kind: "Bundle",
        imports: sources.map(([fileName]) => `./${fileName}`),
        resources: [],
      }),
    );

    const project = await loadPragmaProject(entry);
    expect(await project.validate()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "flow.graph.cycle.ordinary",
          resourceRef: "flow:t4kw6k4qpw8a7tjw",
        }),
        expect.objectContaining({
          code: "reference.invalid",
          resourceRef: "evaluation:7k2m9q4v8np6r3dt",
        }),
      ]),
    );
    expect(await project.validateFor("expert:1xddvess309a6gme")).toEqual([]);
    await expect(
      project.compile("expert:1xddvess309a6gme", { workspace: root }),
    ).resolves.toMatchObject({ ref: "expert:1xddvess309a6gme" });
  });

  it("turns an Expert, Team, or Flow reference into a tool through a versioned adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-dsl-tool-adapter-"));
    const entry = join(root, "pragma.yaml");
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: "pragma/v4",
        kind: "Bundle",
        imports: [],
        resources: [
          {
            apiVersion: "pragma/v4",
            kind: "Expert",
            metadata: {
              id: "3sfd30h5017wd17d",
              name: "Reviewer",
              description: "Reviews work",
            },
            spec: expertSpec(),
          },
          {
            apiVersion: "pragma/v4",
            kind: "Expert",
            metadata: {
              id: "mrvsehytqfmb814x",
              name: "Lead",
              description: "Leads work",
            },
            spec: {
              ...expertSpec("lead"),
              tools: [
                {
                  adapter: "pragma.tool.call@v1",
                  target: { ref: "expert:3sfd30h5017wd17d" },
                  tool: {
                    name: "call_reviewer",
                    description: "Call the reviewer",
                    approval: "none",
                    timeoutMs: 25,
                  },
                },
                {
                  adapter: "pragma.tool.call@v1",
                  target: { ref: "flow:ffdfk2cczgqjda7q" },
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
            apiVersion: "pragma/v4",
            kind: "Flow",
            metadata: {
              id: "ffdfk2cczgqjda7q",
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
                value: { approved: true },
              },
              graph: {
                start: "approve",
                steps: {
                  approve: {
                    human: {
                      selectionMode: "single",
                      prompt: { segments: [{ text: "Approve?" }] },
                      options: [
                        { value: "approve", label: "Approve" },
                        { value: "reject", label: "Reject" },
                      ],
                    },
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
    const lead = (await project.compile<Expert>("expert:mrvsehytqfmb814x", { workspace: root }))
      .value;
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
        target: expect.objectContaining({ id: "3sfd30h5017wd17d" }),
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

  it("reports the ExpertTeam reference that closes an Expert and Team cycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-resource-team-cycle-"));
    const entry = join(root, "pragma.yaml");
    const lead = expertResource("1xddvess309a6gme", "Leads delivery");
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: "pragma/v4",
        kind: "Bundle",
        imports: [],
        resources: [
          runtimeProfile(),
          {
            ...lead,
            spec: {
              ...lead.spec,
              tools: [
                {
                  adapter: "pragma.tool.call@v1",
                  target: { ref: "team:vyv9pwwzaksth2dd" },
                  tool: {
                    name: "call_delivery_team",
                    description: "Call the delivery team",
                    approval: "none",
                  },
                },
              ],
            },
          },
          expertResource("3sfd30h5017wd17d", "Reviews delivery"),
          {
            apiVersion: "pragma/v4",
            kind: "ExpertTeam",
            metadata: {
              id: "vyv9pwwzaksth2dd",
              name: "Delivery",
              description: "Coordinates delivery",
              tags: [],
            },
            spec: {
              coordinator: { ref: "expert:1xddvess309a6gme" },
              members: [{ ref: "expert:3sfd30h5017wd17d" }],
              delegation: {},
            },
          },
        ],
      }),
    );

    const project = await loadPragmaProject(entry);
    const expectedMessage =
      "Pragma resource definitions must form an acyclic dependency graph: " +
      "team:vyv9pwwzaksth2dd -> expert:1xddvess309a6gme -> team:vyv9pwwzaksth2dd.";
    expect(await project.validate()).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "resource.cycle",
        message: expectedMessage,
        source: project.entryFile,
        path: ["spec", "coordinator", "ref"],
      }),
    ]);
    await expect(project.compile("expert:1xddvess309a6gme", { workspace: root })).rejects.toThrow(
      expectedMessage,
    );
  });

  it("reports the Flow step that closes a Flow and Expert cycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-resource-flow-cycle-"));
    const entry = join(root, "pragma.yaml");
    const expert = expertResource("1xddvess309a6gme", "Runs approval");
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: "pragma/v4",
        kind: "Bundle",
        imports: [],
        resources: [
          runtimeProfile(),
          {
            ...expert,
            spec: {
              ...expert.spec,
              tools: [
                {
                  adapter: "pragma.tool.call@v1",
                  target: { ref: "flow:ffdfk2cczgqjda7q" },
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
            apiVersion: "pragma/v4",
            kind: "Flow",
            metadata: {
              id: "ffdfk2cczgqjda7q",
              name: "Approval",
              description: "Runs approval through an Expert",
              tags: [],
            },
            spec: {
              graph: {
                start: "approve",
                steps: {
                  approve: {
                    expert: { ref: "expert:1xddvess309a6gme" },
                    prompt: { segments: [{ text: "Approve the work." }] },
                  },
                },
                transitions: { approve: { end: true } },
              },
            },
          },
        ],
      }),
    );

    const project = await loadPragmaProject(entry);
    const expectedMessage =
      "Pragma resource definitions must form an acyclic dependency graph: " +
      "flow:ffdfk2cczgqjda7q -> expert:1xddvess309a6gme -> flow:ffdfk2cczgqjda7q.";
    expect(await project.validate()).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "resource.cycle",
        message: expectedMessage,
        source: project.entryFile,
        path: ["spec", "graph", "steps", "approve", "expert", "ref"],
      }),
    ]);
    await expect(project.compile("flow:ffdfk2cczgqjda7q", { workspace: root })).rejects.toThrow(
      expectedMessage,
    );
  });

  it("reports a self-referencing Expert tool at its target path", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-resource-self-cycle-"));
    const entry = join(root, "pragma.yaml");
    const expert = expertResource("1xddvess309a6gme", "Calls itself");
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: "pragma/v4",
        kind: "Bundle",
        imports: [],
        resources: [
          runtimeProfile(),
          {
            ...expert,
            spec: {
              ...expert.spec,
              tools: [
                {
                  adapter: "pragma.tool.call@v1",
                  target: { ref: "expert:1xddvess309a6gme" },
                  tool: {
                    name: "call_self",
                    description: "Call the same Expert",
                    approval: "none",
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    const project = await loadPragmaProject(entry);
    expect(await project.validate()).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "resource.cycle",
        message:
          "Pragma resource definitions must form an acyclic dependency graph: " +
          "expert:1xddvess309a6gme -> expert:1xddvess309a6gme.",
        source: project.entryFile,
        path: ["spec", "tools", 0, "target", "ref"],
      }),
    ]);
  });

  it("allows multiple resources to share an acyclic dependency", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-resource-shared-dependency-"));
    const entry = join(root, "pragma.yaml");
    const lead = expertResource("1xddvess309a6gme", "Leads review");
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: "pragma/v4",
        kind: "Bundle",
        imports: [],
        resources: [
          runtimeProfile(),
          {
            ...lead,
            spec: {
              ...lead.spec,
              tools: [
                {
                  adapter: "pragma.tool.call@v1",
                  target: { ref: "expert:3sfd30h5017wd17d" },
                  tool: {
                    name: "call_reviewer",
                    description: "Call the shared reviewer",
                    approval: "none",
                  },
                },
              ],
            },
          },
          expertResource("3sfd30h5017wd17d", "Reviews work"),
          {
            apiVersion: "pragma/v4",
            kind: "Flow",
            metadata: {
              id: "ffdfk2cczgqjda7q",
              name: "Review",
              description: "Uses the shared reviewer",
              tags: [],
            },
            spec: {
              graph: {
                start: "review",
                steps: {
                  review: {
                    expert: { ref: "expert:3sfd30h5017wd17d" },
                    prompt: { segments: [{ text: "Review the work." }] },
                  },
                },
                transitions: { review: { end: true } },
              },
            },
          },
        ],
      }),
    );

    const project = await loadPragmaProject(entry);
    expect(await project.validate()).toEqual([]);
    await expect(
      project.compile<Expert>("expert:1xddvess309a6gme", { workspace: root }),
    ).resolves.toMatchObject({ ref: "expert:1xddvess309a6gme" });
    await expect(
      project.compile<Flow>("flow:ffdfk2cczgqjda7q", { workspace: root }),
    ).resolves.toMatchObject({ ref: "flow:ffdfk2cczgqjda7q" });
  });

  it("rejects an unmarked control-flow cycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-dsl-cycle-"));
    await writeFile(
      join(root, "flow.pragma.yaml"),
      [
        "apiVersion: pragma/v4",
        "kind: Flow",
        "metadata:",
        "  id: t4kw6k4qpw8a7tjw",
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
        "apiVersion: pragma/v4",
        "kind: Flow",
        "metadata:",
        "  id: 5yts78payhvmtw04",
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
        ...expertResource("0tyw4e02pw3d8vjt", "Strict"),
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
        apiVersion: "pragma/v4",
        kind: "Flow",
        metadata: {
          id: "0r6jyayj2gk3rzba",
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
        "apiVersion: pragma/v4",
        "kind: Flow",
        "metadata:",
        "  id: t4kw6k4qpw8a7tjw",
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
        "apiVersion: pragma/v4",
        "kind: Flow",
        "metadata:",
        "  id: t4kw6k4qpw8a7tjw",
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
        "apiVersion: pragma/v4",
        "kind: Flow",
        "metadata:",
        "  id: 5yts78payhvmtw04",
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
        apiVersion: "pragma/v4",
        kind: "Bundle",
        imports: [],
        resources: [runtimeProfile(), expertResource("1xddvess309a6gme", "Writes")],
      }),
    );
    const project = await loadPragmaProject(entry);
    const runtimes = createStaticRuntimeResolver({
      defaultRuntimeId: "codex",
      runtimes: [
        {
          features: createRuntimeTestFeatures(),
          descriptor: { id: "codex", kind: "test", displayName: "Codex" },
          canUse: () => ({ usable: false, reason: "codex executable is missing" }),
        },
      ],
    });
    const inspection = await project.inspectEnvironment({ workspace: root, runtimes });
    expect(inspection.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: "runtime-profile:knr7p5b7qc55wv92",
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
        apiVersion: "pragma/v4",
        kind: "Bundle",
        imports: [],
        resources: [runtimeProfile(), expertResource("1xddvess309a6gme", "Writes")],
      }),
    );
    const project = await loadPragmaProject(entry);
    const modelSelection = {
      model: { providerId: "deepseek", modelId: "deepseek-chat" },
      thinkingLevel: "high",
    };
    const compiled = await project.compile<Expert>("expert:1xddvess309a6gme", {
      workspace: root,
      runtimes: createStaticRuntimeResolver({
        defaultRuntimeId: "pi",
        runtimes: [
          {
            features: createRuntimeTestFeatures(),
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
        apiVersion: "pragma/v4",
        kind: "Bundle",
        imports: [],
        resources: [runtimeProfile(), expertResource("1xddvess309a6gme", "Writes")],
      }),
    );
    const project = await loadPragmaProject(entry);
    const compile = async (version: string) =>
      await project.compile<Expert>("expert:1xddvess309a6gme", {
        workspace: root,
        runtimes: createStaticRuntimeResolver({
          defaultRuntimeId: "codex",
          runtimes: [
            {
              features: createRuntimeTestFeatures({ enabled: ["modelDiscovery"] }),
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
    const expert: PragmaExpertResource = expertResource("1xddvess309a6gme", "Writes");
    expert.spec.capabilities = [
      { ref: "capability:pcr7npvx0gv8fpka", kind: "tools", tools: ["write"] },
    ];
    expert.spec.toolApprovals = { write: "none", mcp_writer_write: "none" };
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: "pragma/v4",
        kind: "Bundle",
        imports: [],
        resources: [
          runtimeProfile(),
          expert,
          {
            apiVersion: "pragma/v4",
            kind: "Capability",
            metadata: {
              id: "pcr7npvx0gv8fpka",
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
    const compiled = await project.compile<Expert>("expert:1xddvess309a6gme", {
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

  it("rejects duplicate semantic identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-dsl-versions-"));
    await writeFile(
      join(root, "pragma.yaml"),
      formatPragmaYaml({
        apiVersion: "pragma/v4",
        kind: "Bundle",
        imports: [],
        resources: [
          runtimeProfile(),
          structuredClone(runtimeProfile()),
          expertResource("1xddvess309a6gme", "Version one"),
          {
            ...expertResource("1xddvess309a6gme", "Version two"),
            metadata: { ...expertResource("1xddvess309a6gme", "Version two").metadata },
            spec: {
              ...expertSpec(),
              runtime: { ref: "runtime-profile:knr7p5b7qc55wv92" },
            },
          },
        ],
      }),
    );
    const project = await loadPragmaProject(join(root, "pragma.yaml"));
    expect(await project.validate()).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "resource.duplicate" })]),
    );
    expect(
      await project.validateEnvironment({
        workspace: root,
        runtimes: createStaticRuntimeResolver({
          defaultRuntimeId: "other",
          runtimes: [
            {
              features: createRuntimeTestFeatures(),
              descriptor: { id: "other", kind: "test", displayName: "Other" },
              canUse: () => ({ usable: true }),
            },
          ],
        }),
      }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "resource.duplicate" })]));
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
    const expert = expertResource("1xddvess309a6gme", "Plugin writer");
    await writeFile(
      join(root, "pragma.yaml"),
      formatPragmaYaml({
        apiVersion: "pragma/v4",
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
      expect.objectContaining({ expertRef: "expert:1xddvess309a6gme" }),
    );
    const compiled = await project.compile<Expert>("expert:1xddvess309a6gme", {
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
        expertRef: "expert:1xddvess309a6gme",
        ref: "plugin:plugin.context@0.0.0",
        packageFingerprint,
        verificationFingerprint: "b".repeat(64),
      },
    ]);
    await expect(
      project.compile<Expert>("expert:1xddvess309a6gme", {
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
    const expert = expertResource("1xddvess309a6gme", "Plugin writer");
    const result = PragmaExpertResourceSchema.safeParse({
      ...expert,
      spec: {
        ...expert.spec,
        plugins: [{ ref: "plugin:example@1.0.0" }, { ref: "plugin:example@2.0.0" }],
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: "An Expert can activate only one version of plugin example.",
          }),
        ]),
      );
    }
  });

  it("rejects paths and URLs as Expert avatar IDs", () => {
    const expert = expertResource("1xddvess309a6gme", "Avatar writer");
    expect(
      PragmaExpertResourceSchema.safeParse({
        ...expert,
        metadata: { ...expert.metadata, avatarId: "https://example.com/avatar.png" },
      }).success,
    ).toBe(false);
    expect(
      PragmaExpertResourceSchema.safeParse({
        ...expert,
        metadata: { ...expert.metadata, avatarId: "../avatar.png" },
      }).success,
    ).toBe(false);
  });
});

function runtimeProfile() {
  return {
    apiVersion: "pragma/v4" as const,
    kind: "RuntimeProfile" as const,
    metadata: {
      id: "knr7p5b7qc55wv92",
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
    runtime: { ref: "runtime-profile:knr7p5b7qc55wv92" },
    capabilities: [],
    toolApprovals: {},
    contextStores: [],
    plugins: [],
    tools: [],
  };
}

function expertResource(id: string, description: string) {
  return {
    apiVersion: "pragma/v4" as const,
    kind: "Expert" as const,
    metadata: {
      id,
      avatarId: "pragma.avatar.expert.default",
      name: description,
      description,
      tags: [],
    },
    spec: expertSpec(),
  };
}
