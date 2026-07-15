import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PragmaExpertResource, PragmaFlowResource } from "@pragma/interpreter/ast";
import { afterEach, describe, expect, it } from "vitest";

import { createExpertDefinitionStore } from "./expert-definition-store.ts";
import { createPragmaProjectStore, PragmaProjectStoreError } from "./pragma-project-store.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(async (directory) => await rm(directory, { recursive: true, force: true })),
  );
});

async function stores() {
  const directory = await mkdtemp(join(tmpdir(), "pragma-project-store-"));
  directories.push(directory);
  const project = createPragmaProjectStore({ projectsPath: directory });
  return { directory, project, experts: createExpertDefinitionStore({ project }) };
}

describe("PragmaProjectStore", () => {
  it("publishes immutable YAML revisions containing experts, teams, and flows", async () => {
    const { directory, project } = await stores();
    const expert = exampleExpert();
    const flow = exampleFlow();
    const first = await project.publish({ expectedRevision: 0, resources: [expert, flow] });

    expect(first.revision).toBe(1);
    expect(first.resources.map((resource) => resource.kind)).toEqual(["Expert", "Flow"]);
    expect(first.lock?.resources).toHaveLength(2);
    expect(
      await readFile(join(directory, "studio/revisions/1/experts/writer.pragma.yaml"), "utf8"),
    ).toContain("kind: Expert");
    expect(await readFile(join(directory, "studio/manifest.yaml"), "utf8")).toContain(
      "revision: 1",
    );

    await expect(
      project.publish({ expectedRevision: 0, resources: [expert] }),
    ).rejects.toMatchObject({
      code: "revision_conflict",
    } satisfies Partial<PragmaProjectStoreError>);
  });

  it("rejects invalid cross-resource references without publishing a revision", async () => {
    const { project } = await stores();
    const flow = exampleFlow();
    flow.spec.graph.steps["write"] = {
      expert: { ref: "expert:missing@1.0.0" },
      version: "1.0.0",
    };
    await expect(project.publish({ expectedRevision: 0, resources: [flow] })).rejects.toMatchObject(
      {
        code: "project_invalid",
      } satisfies Partial<PragmaProjectStoreError>,
    );
    expect((await project.get()).revision).toBe(0);
  });

  it("validates a Flow candidate against the current project without publishing it", async () => {
    const { project } = await stores();
    await project.publish({ expectedRevision: 0, resources: [exampleExpert(), exampleFlow()] });
    const candidate = exampleFlow();
    candidate.spec.graph.steps["write"] = {
      expert: { ref: "expert:missing@1.0.0" },
      version: "1.0.0",
    };
    candidate.spec.graph.transitions["write"] = { end: true };

    const result = await project.validateCandidate({ expectedRevision: 1, resource: candidate });

    expect(result.resource).toEqual(candidate);
    expect(result.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
    expect((await project.get()).revision).toBe(1);
  });

  it("backs the Desktop expert form with YAML resources and no JSON migration path", async () => {
    const { directory, experts } = await stores();
    const created = await experts.create({
      id: "writer",
      name: "Writer",
      description: "Writes release notes",
      tags: ["writing"],
      version: "1.0.0",
      scope: "Release communication",
      model: null,
      capabilities: [],
      contextStoreMounts: [],
      plugins: [],
      toolApprovals: {},
    });
    expect(created.id).toBe("writer");
    expect(await experts.list()).toHaveLength(1);
    expect(
      await readFile(join(directory, "studio/revisions/1/experts/writer.pragma.yaml"), "utf8"),
    ).toContain("scope: Release communication");
  });

  it("recovers an unpublished revision directory left by an interrupted publish", async () => {
    const { directory, project } = await stores();
    const orphan = join(directory, "studio/revisions/1");
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "orphan.txt"), "incomplete");

    const published = await project.publish({ expectedRevision: 0, resources: [exampleExpert()] });

    expect(published.revision).toBe(1);
    await expect(readFile(join(orphan, "orphan.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves portable runtime and capability declarations outside the Desktop form model", async () => {
    const { project, experts } = await stores();
    const expert = exampleExpert();
    expert.spec.runtime = { id: "remote-runtime", model: "remote-model" };
    expert.spec.capabilities = [{ ref: "capability:portable@v1", kind: "skill" }];
    await project.publish({ expectedRevision: 0, resources: [expert] });

    const view = await experts.get("writer");
    expect(view.model).toBeNull();
    expect(view.resourceRuntime).toEqual(expert.spec.runtime);
    expect(view.opaqueCapabilities).toEqual(expert.spec.capabilities);
    await experts.update("writer", {
      name: view.name,
      description: "Updated without losing portable fields",
      tags: view.tags,
      version: view.version,
      scope: view.scope,
      instructions: view.instructions,
      model: view.model,
      capabilities: view.capabilities,
      toolApprovals: view.toolApprovals,
      plugins: view.plugins,
      contextStoreMounts: view.contextStoreMounts,
      resourceTools: view.resourceTools,
      resourceRuntime: view.resourceRuntime,
      opaqueCapabilities: view.opaqueCapabilities,
    });

    const stored = (await project.get()).resources.find(
      (resource) => resource.kind === "Expert" && resource.metadata.id === "writer",
    );
    expect(stored?.kind === "Expert" ? stored.spec.runtime : undefined).toEqual(
      expert.spec.runtime,
    );
    expect(stored?.kind === "Expert" ? stored.spec.capabilities : undefined).toEqual(
      expert.spec.capabilities,
    );
  });
});

function exampleExpert(): PragmaExpertResource {
  return {
    apiVersion: "pragma/v1",
    kind: "Expert",
    metadata: {
      id: "writer",
      version: "1.0.0",
      name: "Writer",
      description: "Writes release notes",
      tags: [],
    },
    spec: {
      scope: "Release communication",
      capabilities: [],
      toolApprovals: {},
      contextStores: [],
      plugins: [],
      tools: [],
    },
  };
}

function exampleFlow(): PragmaFlowResource {
  return {
    apiVersion: "pragma/v1",
    kind: "Flow",
    metadata: {
      id: "release",
      version: "1.0.0",
      name: "Release",
      description: "Build release notes",
      tags: [],
    },
    spec: {
      limits: { maxNodeVisits: 100 },
      graph: {
        start: "finish",
        steps: {
          finish: { action: { ref: "action:finish@v1" }, version: "1.0.0" },
        },
        loops: {},
        transitions: { finish: { end: true } },
      },
    },
  };
}
