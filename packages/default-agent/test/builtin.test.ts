import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createPragmaLogger, registerExpertToolsMcpSession, type Expert } from "@pragma/core";
import { loadPragmaProject, parsePragmaYaml } from "@pragma/interpreter";
import { PragmaCapabilityResourceSchema, PragmaResourceSchema } from "@pragma/interpreter/ast";
import { describe, expect, it } from "vitest";

import { BUILT_IN_PRAGMA_FILES } from "../src/builtin.generated.ts";
import { builtInPragmaResource, materializeBuiltInDefaultAgent } from "../src/builtin.ts";
import { createDefaultAgentTools } from "../src/tools.ts";

describe("built-in Pragma Agent DSL", () => {
  it("loads as a portable pragma/v3 project with the authoring Skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-default-agent-builtin-"));
    const entry = await materializeBuiltInDefaultAgent(root);
    const project = await loadPragmaProject(entry, { rootDir: dirname(entry) });

    expect(await project.validate()).toEqual([]);
    expect(
      project
        .listResources()
        .map((resource) => resource.kind)
        .toSorted(),
    ).toEqual(["Capability", "Capability", "Expert"]);

    const unavailable = async (): Promise<never> => {
      throw new Error("This compile-only test does not execute Pragma tools.");
    };
    const tools = createDefaultAgentTools({
      project: {
        list: unavailable,
        listExpertOptions: unavailable,
        allocateResourceIds: unavailable,
        read: unavailable,
        prepare: unavailable,
        createFlowDraft: unavailable,
        getFlowDraft: unavailable,
        updateFlowDraft: unavailable,
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
        catalog.tools.flatMap((tool) => [
          ...findConflictingReferenceSiblings(tool.inputSchema),
          ...findConflictingReferenceSiblings(tool.outputSchema),
        ]),
      ).toEqual([]);
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
    expect(actual).toEqual(BUILT_IN_PRAGMA_FILES);
  });

  it("teaches the default Agent the Automation field and Flow input limits", () => {
    const reference =
      BUILT_IN_PRAGMA_FILES["skills/author-pragma-dsl/references/automation.md"] ?? "";

    expect(reference).toContain(
      "`metadata.id`: host-allocated 16-character lowercase Crockford Base32.",
    );
    expect(reference).not.toContain("`metadata.version`");
    expect(reference).toContain("`metadata.name`: 1–200 characters");
    expect(reference).toContain("`metadata.description`: 1–4,000 characters");
    expect(reference).toContain("Prompt input: 1–100,000 characters");
    expect(reference).toContain("declares `spec.input.schema`");
    expect(reference).toContain("has no input schema");
  });

  it("teaches the default Agent complete Expert mounts and Runtime reference selection", () => {
    const skill = BUILT_IN_PRAGMA_FILES["skills/author-pragma-dsl/SKILL.md"] ?? "";
    const expertReference =
      BUILT_IN_PRAGMA_FILES["skills/author-pragma-dsl/references/expert.md"] ?? "";
    const resourceReference =
      BUILT_IN_PRAGMA_FILES["skills/author-pragma-dsl/references/resources-and-references.md"] ??
      "";

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

  it("teaches incremental Run Dry authoring with bounded explicit batches", () => {
    const skill = BUILT_IN_PRAGMA_FILES["skills/author-pragma-dsl/SKILL.md"] ?? "";
    const reference = BUILT_IN_PRAGMA_FILES["skills/author-pragma-dsl/references/run-dry.md"] ?? "";

    expect(skill).toContain("generate and upsert exactly one case");
    expect(skill).toContain("at most 10 cases per call");
    expect(skill).toContain("Never emit or pass a complete Evaluation YAML document");
    expect(reference).toContain("run_evaluation_draft");
    expect(reference).toContain("2–10 `upsert_case` operations");
    expect(reference).toContain("Never build, resend, or request the complete Evaluation YAML");
    expect(reference).toContain("`discard_evaluation_draft` before");
    expect(reference).toContain("`discard_flow_draft`");
    expect(reference).not.toContain("run_evaluation`");
  });

  it("materializes an overridden built-in Expert while preserving its bundled dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-default-agent-override-"));
    const resource = builtInPragmaResource();
    resource.metadata.name = "My Pragma";
    resource.spec.instructions = "Use the customized built-in instructions.";
    const optionalCapability = PragmaCapabilityResourceSchema.parse({
      apiVersion: "pragma/v3",
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
    const entry = await materializeBuiltInDefaultAgent(root, resource, [optionalCapability]);
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
    ).toHaveLength(3);
    expect(await project.validate()).toEqual([]);
  });

  it("reuses a completed immutable materialization across concurrent callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-default-agent-cache-"));
    const [first, second] = await Promise.all([
      materializeBuiltInDefaultAgent(root),
      materializeBuiltInDefaultAgent(root),
    ]);
    expect(first).toBe(second);
    const before = await stat(first);
    const third = await materializeBuiltInDefaultAgent(root);
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
