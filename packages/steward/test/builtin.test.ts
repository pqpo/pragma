import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { Expert } from "@pragma/core";
import { loadPragmaProject, parsePragmaYaml } from "@pragma/interpreter";
import { PragmaResourceSchema } from "@pragma/interpreter/ast";
import { describe, expect, it } from "vitest";

import { BUILT_IN_STEWARD_FILES } from "../src/builtin.generated.ts";
import { materializeBuiltInSteward } from "../src/builtin.ts";
import { createStewardTools } from "../src/tools.ts";

describe("built-in Steward DSL", () => {
  it("loads as a portable pragma/v2 project with the authoring Skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-steward-builtin-"));
    const entry = await materializeBuiltInSteward(root);
    const project = await loadPragmaProject(entry, { rootDir: dirname(entry) });

    expect(await project.validate()).toEqual([]);
    expect(
      project
        .listResources()
        .map((resource) => resource.kind)
        .toSorted(),
    ).toEqual(["Capability", "Capability", "Expert"]);

    const unavailable = async (): Promise<never> => {
      throw new Error("This compile-only test does not execute Steward tools.");
    };
    const tools = createStewardTools({
      project: {
        list: unavailable,
        listExpertOptions: unavailable,
        read: unavailable,
        prepare: unavailable,
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
    const compiled = await project.compile<Expert>("expert:steward@1.0.0", {
      workspace: root,
      environmentId: "test",
      adapterHost: {
        environmentId: "test",
        projectRoot: dirname(entry),
        async resolveBinding(ref) {
          return ref === "binding:pragma.steward-host"
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
    expect(compiled.value.tools?.map((tool) => tool.name)).toHaveLength(11);
    expect(compiled.value.tools?.map((tool) => tool.name)).toContain("list_expert_options");
    expect(compiled.value.skills?.skills[0]?.path).toMatch(/author-pragma-dsl[\\/]SKILL\.md$/);
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
    expect(actual).toEqual(BUILT_IN_STEWARD_FILES);
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
