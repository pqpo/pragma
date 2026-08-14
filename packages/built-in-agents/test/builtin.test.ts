import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  InMemoryContextStore,
  createPragmaLogger,
  createStaticRuntimeResolver,
  registerExpertToolsMcpSession,
  snapshotRuntimeFeatures,
  type Expert,
} from "@pragma/core";
import { createRuntimeTestFeatures } from "@pragma/core/testing";
import { loadPragmaProject, parsePragmaYaml } from "@pragma/interpreter";
import { PragmaCapabilityResourceSchema, PragmaResourceSchema } from "@pragma/interpreter/ast";
import { MEMORY_CURATOR_REF as MEMORY_PLANE_CURATOR_REF } from "@pragma/memory";
import { describe, expect, it } from "vitest";

import { BUILT_IN_AGENT_FILES } from "../src/builtin.generated.ts";
import {
  BUILT_IN_AGENT_REFS,
  BUILT_IN_PRAGMA_REF,
  EVALUATION_JUDGE_EXPERT_REF,
  MEMORY_CURATOR_REF,
  MEMORY_CURATOR_SKILL_DRAFT_BINDING_REF,
  SKILL_EVALUATION_EXPERT_REF,
  SKILL_REVISION_EXPERT_REF,
  STORE_REVISION_EXPERT_REF,
  STORE_REVISION_TARGET_BINDING_REF,
  builtInAgentFingerprint,
  builtInAgentResource,
  compileBuiltInAgent,
  materializeBuiltInAgentBundle,
} from "../src/builtin.ts";
import { PragmaAgentFlowDraftSchema } from "../src/contracts.ts";
import { createPragmaAgentTools } from "../src/tools.ts";

describe("built-in Pragma Agent DSL", () => {
  it("defines all six built-in Agents as canonical DSL Experts", () => {
    expect(BUILT_IN_AGENT_REFS).toHaveLength(6);
    expect(BUILT_IN_AGENT_REFS.map((ref) => builtInAgentResource(ref).metadata.id)).toEqual(
      BUILT_IN_AGENT_REFS.map((ref) => ref.slice("expert:".length)),
    );
    expect(BUILT_IN_AGENT_REFS).toContain(MEMORY_PLANE_CURATOR_REF);
  });

  it("loads as a portable pragma/v4 project with the authoring Skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-default-agent-builtin-"));
    const entry = await materializeBuiltInAgentBundle(root);
    const project = await loadPragmaProject(entry, { rootDir: dirname(entry) });

    expect(await project.validate()).toEqual([]);
    expect(
      project
        .listResources()
        .map((resource) => resource.kind)
        .toSorted(),
    ).toEqual([
      "Capability",
      "Capability",
      "Capability",
      "ContextStore",
      "Expert",
      "Expert",
      "Expert",
      "Expert",
      "Expert",
      "Expert",
    ]);

    const unavailable = async (): Promise<never> => {
      throw new Error("This compile-only test does not execute Pragma tools.");
    };
    let updatedOperationCount = 0;
    const tools = createPragmaAgentTools({
      project: {
        list: unavailable,
        listExpertOptions: unavailable,
        allocateResourceIds: unavailable,
        read: unavailable,
        prepare: unavailable,
        createFlowDraft: unavailable,
        getFlowDraft: unavailable,
        updateFlowDraft: async (input) => {
          updatedOperationCount = input.operations.length;
          return flowDraft();
        },
        validateFlowDraft: unavailable,
        createEvaluationDraft: unavailable,
        getEvaluationDraft: unavailable,
        updateEvaluationDraft: unavailable,
        runEvaluationDraft: unavailable,
        prepareEvaluationDraft: unavailable,
        discardEvaluationDraft: unavailable,
        prepareFlowDraft: unavailable,
        discardFlowDraft: unavailable,
        getChangeSet: unavailable,
        commit: unavailable,
      },
      tasks: {
        list: unavailable,
        get: unavailable,
        submit: unavailable,
        sendMessage: unavailable,
        listWorkItems: unavailable,
        interrupt: unavailable,
      },
    });
    const compiled = await project.compile<Expert>("expert:0000000000pragma", {
      workspace: root,
      environmentId: "test",
      adapterHost: {
        environmentId: "test",
        projectRoot: dirname(entry),
        async resolveBinding(ref) {
          return ref === "binding:pragma.default-agent-host"
            ? {
                ref,
                revision: "1",
                fingerprint: "a".repeat(64),
                value: { contribution: { tools } },
              }
            : undefined;
        },
        async resolveArtifact(source) {
          throw new Error(`Unexpected artifact: ${JSON.stringify(source)}`);
        },
        async resolveSecret() {
          return undefined;
        },
      },
    });
    expect(compiled.value.tools?.map((tool) => tool.name)).toHaveLength(24);
    expect(compiled.value.tools?.map((tool) => tool.name)).toContain("list_expert_options");
    expect(compiled.value.tools?.map((tool) => tool.name)).toContain("update_flow_draft");
    expect(compiled.value.tools?.map((tool) => tool.name)).toContain("run_evaluation_draft");
    expect(compiled.value.tools?.map((tool) => tool.name)).not.toContain("run_evaluation");
    expect(compiled.value.skills?.skills[0]?.path).toMatch(/author-pragma-dsl[\\/]SKILL\.md$/);
    expect(compiled.value).toMatchObject({
      id: "0000000000pragma",
      name: "Pragma",
      scope:
        "Accomplish the user's work with the active Runtime, workspace, and available capabilities.",
    });
    expect(compiled.value.instructions).toContain("Your name is Pragma");
    expect(compiled.value.instructions).toContain("identify yourself as Pragma");
    expect(compiled.value.instructions).toContain("default general-purpose Agent");
    expect(compiled.value.instructions).toContain("not the limit of your role");

    for (const ref of [
      MEMORY_CURATOR_REF,
      STORE_REVISION_EXPERT_REF,
      SKILL_REVISION_EXPERT_REF,
      SKILL_EVALUATION_EXPERT_REF,
      EVALUATION_JUDGE_EXPERT_REF,
    ]) {
      const hidden = await project.compile<Expert>(ref, {
        workspace: root,
        environmentId: "test",
        adapterHost: {
          environmentId: "test",
          projectRoot: dirname(entry),
          async resolveBinding(bindingRef) {
            if (bindingRef === MEMORY_CURATOR_SKILL_DRAFT_BINDING_REF) {
              return {
                ref: bindingRef,
                revision: "1",
                fingerprint: "c".repeat(64),
                value: { contribution: { tools: [] } },
              };
            }
            return bindingRef === STORE_REVISION_TARGET_BINDING_REF
              ? {
                  ref: bindingRef,
                  revision: "1",
                  fingerprint: "b".repeat(64),
                  value: { store: new InMemoryContextStore() },
                }
              : undefined;
          },
          async resolveArtifact(source) {
            throw new Error(`Unexpected artifact: ${JSON.stringify(source)}`);
          },
          async resolveSecret() {
            return undefined;
          },
        },
      });
      expect(hidden.value.id).toBe(ref.slice("expert:".length));
      expect(hidden.value.tools ?? []).toEqual([]);
    }

    const draftToolNames = ["begin_skill_draft", "put_skill_file", "submit_skill_draft"];
    const memoryWithDraftTools = await project.compile<Expert>(MEMORY_CURATOR_REF, {
      workspace: root,
      environmentId: "test-skill",
      adapterHost: {
        environmentId: "test-skill",
        projectRoot: dirname(entry),
        async resolveBinding(bindingRef) {
          if (bindingRef !== MEMORY_CURATOR_SKILL_DRAFT_BINDING_REF) return undefined;
          return {
            ref: bindingRef,
            revision: "skill",
            fingerprint: "d".repeat(64),
            value: {
              contribution: {
                tools: draftToolNames.map((name) => ({
                  name,
                  description: name,
                  inputSchema: { type: "object" },
                  approval: { mode: "none" as const },
                  async call() {
                    return { text: "{}" };
                  },
                })),
              },
            },
          };
        },
        async resolveArtifact(source) {
          throw new Error(`Unexpected artifact: ${JSON.stringify(source)}`);
        },
        async resolveSecret() {
          return undefined;
        },
      },
    });
    expect(memoryWithDraftTools.value.tools?.map((tool) => tool.name)).toEqual(draftToolNames);
    expect(memoryWithDraftTools.value.toolPolicy).toMatchObject({
      deniedTools: ["askUserQuestion"],
    });

    const memoryRegistration = await registerExpertToolsMcpSession({
      agent: memoryWithDraftTools.value,
      getContext: () => undefined,
      logger: createPragmaLogger(undefined, {
        component: "runtime.adapter",
        scope: { agentId: memoryWithDraftTools.value.id },
      }),
      state: {},
    });
    const memoryClient = new Client(
      { name: "memory-curator-tool-policy-test", version: "1.0.0" },
      { capabilities: {} },
    );
    try {
      await memoryClient.connect(
        new StreamableHTTPClientTransport(new URL(memoryRegistration.url)),
      );
      const catalog = await memoryClient.listTools();
      expect(catalog.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(draftToolNames),
      );
      expect(catalog.tools.map((tool) => tool.name)).not.toContain("askUserQuestion");
    } finally {
      await memoryClient.close().catch(() => undefined);
      await memoryRegistration.dispose();
    }

    const registration = await registerExpertToolsMcpSession({
      agent: compiled.value,
      getContext: () => undefined,
      logger: createPragmaLogger(undefined, {
        component: "runtime.adapter",
        scope: { agentId: compiled.value.id },
      }),
      state: {},
    });
    const client = new Client(
      { name: "pragma-default-agent-schema-test", version: "1.0.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(registration.url)));
      const catalog = await client.listTools();
      expect(catalog.tools.map((tool) => tool.name)).toContain("create_flow_draft");
      expect(catalog.tools.map((tool) => tool.name)).toContain("update_flow_draft");
      expect(
        catalog.tools.find((tool) => tool.name === "update_flow_draft")?.inputSchema,
      ).toMatchObject({
        properties: {
          operations: {
            anyOf: [{ type: "array", minItems: 1, maxItems: 50 }, { type: "string" }],
            description: expect.stringContaining("native JSON array"),
          },
        },
      });
      expect(
        catalog.tools.find((tool) => tool.name === "create_evaluation_draft")?.inputSchema,
      ).toMatchObject({
        type: "object",
        properties: {
          mode: { type: "string", enum: ["create", "edit"] },
          expectedProjectRevision: { type: "integer", minimum: 0 },
          metadata: { type: "object" },
          targetRef: { type: "string" },
          evaluationRef: { type: "string" },
        },
        required: ["mode", "expectedProjectRevision"],
        additionalProperties: false,
      });
      expect(
        catalog.tools.flatMap((tool) => [
          ...findConflictingReferenceSiblings(tool.inputSchema),
          ...findConflictingReferenceSiblings(tool.outputSchema),
        ]),
      ).toEqual([]);
      const recovered = await client.callTool({
        name: "update_flow_draft",
        arguments: {
          draftId: "4fc96ef9-1825-447d-a17f-d820f6fd4855",
          expectedDraftRevision: 0,
          operations: '\n[{"type":"remove_step","stepId":"review"}]\n',
        },
      });
      expect(recovered.isError).not.toBe(true);
      expect(recovered.structuredContent).toMatchObject({
        applied: { operationCount: 1, stepsChanged: ["review"] },
        diagnostics: [expect.objectContaining({ code: "flow_draft.operations_string_coerced" })],
      });
      expect(updatedOperationCount).toBe(1);
    } finally {
      await client.close().catch(() => undefined);
      await registration.dispose();
    }
  });

  it("keeps generated assets byte-identical to the DSL source tree", async () => {
    const dslRoot = join(dirname(fileURLToPath(import.meta.url)), "../dsl");
    const files = await filesAt(dslRoot);
    const actual = Object.fromEntries(
      await Promise.all(
        files.map(async (path) => [
          relative(dslRoot, path).replaceAll("\\", "/"),
          normalizeLineEndings(await readFile(path, "utf8")),
        ]),
      ),
    );
    expect(actual).toEqual(BUILT_IN_AGENT_FILES);
  });

  it("teaches the default Agent the Automation field and Flow input limits", () => {
    const reference =
      BUILT_IN_AGENT_FILES["skills/author-pragma-dsl/references/automation.md"] ?? "";

    expect(reference).toContain(
      "`metadata.id`: host-allocated 16-character lowercase Crockford Base32.",
    );
    expect(reference).not.toContain("`metadata.version`");
    expect(reference).toContain("`metadata.name`: 1–50 Unicode characters");
    expect(reference).toContain("`metadata.description`: 1–500 Unicode characters");
    expect(reference).toContain("Prompt input: 1–100,000 characters");
    expect(reference).toContain("declares `spec.input.schema`");
    expect(reference).toContain("has no input schema");
  });

  it("teaches the default Agent complete Expert mounts and Runtime reference selection", () => {
    const skill = BUILT_IN_AGENT_FILES["skills/author-pragma-dsl/SKILL.md"] ?? "";
    const expertReference =
      BUILT_IN_AGENT_FILES["skills/author-pragma-dsl/references/expert.md"] ?? "";
    const resourceReference =
      BUILT_IN_AGENT_FILES["skills/author-pragma-dsl/references/resources-and-references.md"] ?? "";

    expect(skill).toContain("Its `sources` input is");
    expect(skill).toContain("always an array with one complete YAML document per item");
    expect(expertReference).toContain("namespace: project_docs");
    expect(expertReference).toContain(
      "It is not derived from the ContextStore ID, binding, or `config.key`.",
    );
    expect(resourceReference).toContain("Otherwise use the Host");
    expect(resourceReference).toContain(
      "option's `runtimeProfileRef`; `prepare_dsl_changes` adds that dependency automatically.",
    );
  });

  it("teaches compact Flow draft updates with native operation arrays", () => {
    const skill = BUILT_IN_AGENT_FILES["skills/author-pragma-dsl/SKILL.md"] ?? "";
    const reference = BUILT_IN_AGENT_FILES["skills/author-pragma-dsl/references/flow.md"] ?? "";

    expect(skill).toContain("Pass `operations` as a native JSON array");
    expect(skill).toContain("string parsing is only a recovery path");
    expect(skill).toContain("compact revision summary");
    expect(reference).toContain("`update_flow_draft.operations` as a native JSON array");
    expect(reference).toContain("use `get_flow_draft`");
  });

  it("teaches incremental Run Dry authoring with bounded explicit batches", () => {
    const skill = BUILT_IN_AGENT_FILES["skills/author-pragma-dsl/SKILL.md"] ?? "";
    const reference = BUILT_IN_AGENT_FILES["skills/author-pragma-dsl/references/run-dry.md"] ?? "";

    expect(skill).toContain("generate and upsert exactly one case");
    expect(skill).toContain("ask whether the user wants to create a test set and run it");
    expect(skill).toContain("user may skip");
    expect(skill).toContain("prepare_evaluation_draft");
    expect(skill).toContain("commit changes only the");
    expect(skill).toContain("Evaluation; it is never part of `prepare_flow_draft`");
    expect(skill).not.toContain("without waiting for the user");
    expect(skill).toContain("Never emit or pass a complete Evaluation");
    expect(reference).toContain("run_evaluation_draft");
    expect(reference).toContain("2–10 `upsert_case` operations");
    expect(reference).toContain("This is the submit-and-save operation");
    expect(reference).toContain("commits only the canonical `evaluation:<id>` resource");
    expect(reference).toContain("never creates an Evaluation implicitly");
    expect(reference).toContain("Never build, resend, or request the complete Evaluation YAML");
    expect(reference).not.toContain("targetFlowDraftId");
    expect(reference).not.toContain("created atomically");
    expect(reference).not.toContain("run_evaluation`");
  });

  it("materializes an overridden built-in Expert while preserving its bundled dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-default-agent-override-"));
    const resource = builtInAgentResource(BUILT_IN_PRAGMA_REF);
    resource.metadata.name = "My Pragma";
    resource.spec.instructions = "Use the customized built-in instructions.";
    const optionalCapability = PragmaCapabilityResourceSchema.parse({
      apiVersion: "pragma/v4",
      kind: "Capability",
      metadata: {
        id: "fdabjmg2tasep93t",
        name: "Desktop optional capability",
        description: "An optional capability embedded by Desktop.",
        tags: ["desktop-managed"],
      },
      spec: {
        adapter: "pragma.capability.host@v1",
        binding: "binding:desktop-capability.test.1",
        config: { key: "desktop_optional" },
      },
    });
    const entry = await materializeBuiltInAgentBundle(root, resource, [optionalCapability]);
    const project = await loadPragmaProject(entry, { rootDir: dirname(entry) });
    const stored = project
      .listResources()
      .find(
        (candidate) => candidate.kind === "Expert" && candidate.metadata.id === "0000000000pragma",
      );

    expect(stored?.metadata.name).toBe("My Pragma");
    expect(stored?.kind === "Expert" ? stored.spec.instructions : undefined).toBe(
      "Use the customized built-in instructions.",
    );
    expect(
      project.listResources().filter((candidate) => candidate.kind === "Capability"),
    ).toHaveLength(4);
    expect(await project.validate()).toEqual([]);
  });

  it("isolates each Agent fingerprint from unrelated Expert customizations", () => {
    const customizedPragma = builtInAgentResource(BUILT_IN_PRAGMA_REF);
    customizedPragma.spec.instructions = "Customized Pragma instructions.";

    expect(builtInAgentFingerprint(BUILT_IN_PRAGMA_REF, customizedPragma)).not.toBe(
      builtInAgentFingerprint(BUILT_IN_PRAGMA_REF),
    );
    expect(builtInAgentFingerprint(MEMORY_CURATOR_REF, customizedPragma)).toBe(
      builtInAgentFingerprint(MEMORY_CURATOR_REF),
    );
  });

  it("compiles every hidden Agent from its isolated dependency closure", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-built-in-agent-isolated-"));
    const runtimes = createStaticRuntimeResolver({
      defaultRuntimeId: "test-runtime",
      runtimes: [
        {
          features: snapshotRuntimeFeatures(createRuntimeTestFeatures()),
          descriptor: { id: "test-runtime", kind: "test", displayName: "Test Runtime" },
          canUse: () => ({ usable: true }),
        },
      ],
    });

    for (const ref of [
      MEMORY_CURATOR_REF,
      STORE_REVISION_EXPERT_REF,
      SKILL_REVISION_EXPERT_REF,
      SKILL_EVALUATION_EXPERT_REF,
      EVALUATION_JUDGE_EXPERT_REF,
    ]) {
      const compiled = await compileBuiltInAgent({
        ref,
        environmentId: "test-host",
        definitionStateRoot: join(root, "definitions"),
        workspace: root,
        pragmaHome: root,
        runtimes,
        adapterHost: {
          environmentId: "ignored-external-id",
          projectRoot: root,
          async resolveBinding(bindingRef) {
            if (bindingRef === MEMORY_CURATOR_SKILL_DRAFT_BINDING_REF) {
              return {
                ref: bindingRef,
                revision: "1",
                fingerprint: "d".repeat(64),
                value: { contribution: { tools: [] } },
              };
            }
            return bindingRef === STORE_REVISION_TARGET_BINDING_REF
              ? {
                  ref: bindingRef,
                  revision: "1",
                  fingerprint: "c".repeat(64),
                  value: { store: new InMemoryContextStore() },
                }
              : undefined;
          },
          async resolveArtifact(source) {
            throw new Error(`Unexpected artifact: ${JSON.stringify(source)}`);
          },
          async resolveSecret() {
            return undefined;
          },
        },
      });
      expect(compiled.value.id).toBe(ref.slice("expert:".length));
    }
  });

  it("reuses a completed immutable materialization across concurrent callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-default-agent-cache-"));
    const [first, second] = await Promise.all([
      materializeBuiltInAgentBundle(root),
      materializeBuiltInAgentBundle(root),
    ]);
    expect(first).toBe(second);
    const before = await stat(first);
    const third = await materializeBuiltInAgentBundle(root);
    expect(third).toBe(first);
    expect((await stat(third)).mtimeMs).toBe(before.mtimeMs);
    await expect(readFile(join(dirname(first), ".complete"), "utf8")).resolves.toMatch(
      /^[a-f0-9]{64}\n$/,
    );
  });

  it("keeps every YAML example in the Skill structurally valid", async () => {
    const dslRoot = join(dirname(fileURLToPath(import.meta.url)), "../dsl");
    const references = (await filesAt(join(dslRoot, "skills/author-pragma-dsl/references"))).filter(
      (path) => path.endsWith(".md"),
    );
    for (const path of references) {
      const source = await readFile(path, "utf8");
      for (const match of source.matchAll(/```yaml\n([\s\S]*?)```/g)) {
        expect(PragmaResourceSchema.safeParse(parsePragmaYaml(match[1]!)).success, path).toBe(true);
      }
    }
  });
});

function findConflictingReferenceSiblings(
  schema: unknown,
  path: readonly (string | number)[] = [],
): readonly string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((value, index) =>
      findConflictingReferenceSiblings(value, [...path, index]),
    );
  }
  if (schema === null || typeof schema !== "object") return [];

  const record = schema as Record<string, unknown>;
  const conflicts =
    typeof record["$ref"] === "string" &&
    ["allOf", "anyOf", "oneOf", "type", "properties", "items"].some(
      (keyword) => record[keyword] !== undefined,
    )
      ? [path.join(".")]
      : [];

  return [
    ...conflicts,
    ...Object.entries(record).flatMap(([key, value]) =>
      findConflictingReferenceSiblings(value, [...path, key]),
    ),
  ];
}

async function filesAt(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await filesAt(target)));
    else files.push(target);
  }
  return files.toSorted();
}

function normalizeLineEndings(source: string): string {
  return source.replaceAll("\r\n", "\n");
}

function flowDraft() {
  return PragmaAgentFlowDraftSchema.parse({
    draftId: "4fc96ef9-1825-447d-a17f-d820f6fd4855",
    baseProjectRevision: 0,
    draftRevision: 1,
    resource: {
      apiVersion: "pragma/v4",
      kind: "Flow",
      metadata: {
        id: "8h9j0k1m2n3p4q5r",
        name: "Review Flow",
        description: "Reviews a change.",
        tags: [],
      },
      spec: { graph: { steps: {}, transitions: {}, loops: {} } },
    },
    diagnostics: [],
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:01.000Z",
  });
}
