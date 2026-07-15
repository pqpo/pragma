import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { Expert, Flow } from "@pragma/core";

import { FlowActionRegistry, formatPragmaYaml, loadPragmaProject } from "../src/index.ts";

describe("Pragma YAML DSL", () => {
  it("loads split resources, compiles an explicit loop, and dumps stable YAML", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-dsl-"));
    await mkdir(join(root, "flows", "review"), { recursive: true });
    await Promise.all([
      writeFile(
        join(root, "pragma.yaml"),
        [
          "apiVersion: pragma/v1",
          "kind: Bundle",
          "imports:",
          "  - ./flows/review/flow.pragma.yaml",
          "",
        ].join("\n"),
      ),
      writeFile(
        join(root, "flows", "review", "flow.pragma.yaml"),
        [
          "apiVersion: pragma/v1",
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
    const compiled = await project.compile<Flow>("flow:review", { workspace: root, actions });
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
    expect(dumped.files.get("flows/review.pragma.yaml")).toContain("kind: Flow");
    expect(dumped.files.get("pragma.lock.yaml")).toContain("compilerVersion: pragma.dsl/v1");
    const single = await project.dump(compiled.value, { split: "single" });
    await writeFile(join(root, "single.yaml"), single.files.get("pragma.yaml")!);
    expect((await loadPragmaProject(join(root, "single.yaml"))).listResources()).toHaveLength(1);
  });

  it("enforces an optional content-addressed lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-dsl-lock-"));
    const entry = join(root, "expert.pragma.yaml");
    await writeFile(
      entry,
      [
        "apiVersion: pragma/v1",
        "kind: Expert",
        "metadata: { id: writer, version: 1.0.0, name: Writer, description: Writes }",
        "spec: { scope: writing }",
        "",
      ].join("\n"),
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
        apiVersion: "pragma/v1",
        kind: "Bundle",
        imports: [],
        resources: [
          {
            apiVersion: "pragma/v1",
            kind: "Expert",
            metadata: {
              id: "reviewer",
              version: "1.0.0",
              name: "Reviewer",
              description: "Reviews work",
            },
            spec: { scope: "review" },
          },
          {
            apiVersion: "pragma/v1",
            kind: "Expert",
            metadata: {
              id: "lead",
              version: "1.0.0",
              name: "Lead",
              description: "Leads work",
            },
            spec: {
              scope: "lead",
              tools: [
                {
                  adapter: "pragma.tool.call@v1",
                  target: { ref: "expert:reviewer@1.0.0" },
                  tool: {
                    name: "call_reviewer",
                    description: "Call the reviewer",
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
    const lead = (await project.compile<Expert>("expert:lead@1.0.0", { workspace: root })).value;
    const tool = lead.tools?.find((candidate) => candidate.name === "call_reviewer");
    const invokeResource = vi.fn(async () => ({ accepted: true }));
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
  });

  it("rejects an unmarked control-flow cycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-dsl-cycle-"));
    await writeFile(
      join(root, "flow.pragma.yaml"),
      [
        "apiVersion: pragma/v1",
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
        expect.objectContaining({ code: "flow.graph.invalid", severity: "error" }),
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
        "apiVersion: pragma/v1",
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
});
