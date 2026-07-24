import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { Expert } from "@pragma/core";
import { loadPragmaProject, parsePragmaYaml } from "@pragma/interpreter";
import { PragmaCapabilityResourceSchema, PragmaResourceSchema } from "@pragma/interpreter/ast";
import { describe, expect, it } from "vitest";

import { BUILT_IN_PRAGMA_FILES } from "../src/builtin.generated.ts";
import { builtInPragmaResource, materializeBuiltInDefaultAgent } from "../src/builtin.ts";
import { createDefaultAgentTools } from "../src/tools.ts";

describe("built-in Pragma Agent DSL", () => {
  it("loads as a portable pragma/v2 project with the authoring Skill", async () => {
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
        read: unavailable,
        prepare: unavailable,
        createFlowDraft: unavailable,
        getFlowDraft: unavailable,
        updateFlowDraft: unavailable,
        validateFlowDraft: unavailable,
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
    const compiled = await project.compile<Expert>("expert:pragma@1.0.0", {
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
    expect(compiled.value.tools?.map((tool) => tool.name)).toHaveLength(17);
    expect(compiled.value.tools?.map((tool) => tool.name)).toContain("list_expert_options");
    expect(compiled.value.tools?.map((tool) => tool.name)).toContain("update_flow_draft");
    expect(compiled.value.skills?.skills[0]?.path).toMatch(/author-pragma-dsl[\\/]SKILL\.md$/);
    expect(compiled.value).toMatchObject({
      id: "pragma",
      name: "Pragma",
      scope:
        "Accomplish the user's work with the active Runtime, workspace, and available capabilities.",
    });
    expect(compiled.value.instructions).toContain("Your name is Pragma");
    expect(compiled.value.instructions).toContain("identify yourself as Pragma");
    expect(compiled.value.instructions).toContain("default general-purpose Agent");
    expect(compiled.value.instructions).toContain("not the limit of your role");
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

    expect(reference).toContain("`metadata.id`: 1–120 characters");
    expect(reference).toContain("`metadata.version`: 1–100 characters");
    expect(reference).toContain("`metadata.name`: 1–200 characters");
    expect(reference).toContain("`metadata.description`: 1–4,000 characters");
    expect(reference).toContain("Prompt input: 1–100,000 characters");
    expect(reference).toContain("declares `spec.input.schema`");
    expect(reference).toContain("has no input schema");
  });

  it("materializes an overridden built-in Expert while preserving its bundled dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-default-agent-override-"));
    const resource = builtInPragmaResource();
    resource.metadata.name = "My Pragma";
    resource.spec.instructions = "Use the customized built-in instructions.";
    const optionalCapability = PragmaCapabilityResourceSchema.parse({
      apiVersion: "pragma/v2",
      kind: "Capability",
      metadata: {
        id: "desktop_optional",
        version: "1",
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
      .find((candidate) => candidate.kind === "Expert" && candidate.metadata.id === "pragma");

    expect(stored?.metadata.name).toBe("My Pragma");
    expect(stored?.kind === "Expert" ? stored.spec.instructions : undefined).toBe(
      "Use the customized built-in instructions.",
    );
    expect(
      project.listResources().filter((candidate) => candidate.kind === "Capability"),
    ).toHaveLength(3);
    expect(await project.validate()).toEqual([]);
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
