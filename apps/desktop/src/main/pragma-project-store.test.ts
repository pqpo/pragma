import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  PragmaCapabilityResource,
  PragmaExpertResource,
  PragmaFlowResource,
  PragmaRuntimeProfileResource,
} from "@pragma/interpreter/ast";
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
    const first = await project.publish({
      expectedRevision: 0,
      resources: [exampleRuntime(), expert, flow],
    });

    expect(first.revision).toBe(1);
    expect(first.resources.map((resource) => resource.kind).toSorted()).toEqual([
      "Expert",
      "Flow",
      "RuntimeProfile",
    ]);
    expect(first.lock?.resources).toHaveLength(3);
    expect(
      await readFile(
        join(directory, "studio/revisions/1/experts/writer@1.0.0.pragma.yaml"),
        "utf8",
      ),
    ).toContain("kind: Expert");
    expect(await readFile(join(directory, "studio/manifest.yaml"), "utf8")).toContain(
      "revision: 1",
    );

    await expect(
      project.publish({ expectedRevision: 0, resources: [exampleRuntime(), expert] }),
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
    await project.publish({
      expectedRevision: 0,
      resources: [exampleRuntime(), exampleExpert(), exampleFlow()],
    });
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
      await readFile(
        join(directory, "studio/revisions/1/experts/writer@1.0.0.pragma.yaml"),
        "utf8",
      ),
    ).toContain("scope: Release communication");
  });

  it("preserves project-local artifacts when the Desktop form publishes a later revision", async () => {
    const { directory, project, experts } = await stores();
    await project.publish({
      expectedRevision: 0,
      resources: [],
      artifacts: new Map([["assets/guide.md", "# Project guide\n"]]),
    });
    await experts.create({
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

    await expect(
      readFile(join(directory, "studio/revisions/2/assets/guide.md"), "utf8"),
    ).resolves.toBe("# Project guide\n");
  });

  it("keeps same-id Expert versions independent and only reclaims unreferenced managed dependencies", async () => {
    const { project, experts } = await stores();
    const create = async (version: string) =>
      await experts.create({
        id: "writer",
        name: `Writer ${version}`,
        description: "Writes release notes",
        tags: [],
        version,
        scope: "Release communication",
        model: { runtimeId: "codex", providerId: "openai", modelId: "gpt-test" },
        capabilities: [],
        contextStoreMounts: [],
        plugins: [],
        toolApprovals: {},
      });
    await create("1.0.0");
    await create("2.0.0");

    expect((await experts.list()).map((expert) => expert.ref).toSorted()).toEqual([
      "expert:writer@1.0.0",
      "expert:writer@2.0.0",
    ]);
    await experts.remove("expert:writer@1.0.0");
    const refs = (await project.get()).resources.map(
      (resource) => `${resource.kind}:${resource.metadata.id}@${resource.metadata.version}`,
    );
    expect(refs).not.toContain("Expert:writer@1.0.0");
    expect(refs).not.toContain("RuntimeProfile:writer.runtime@1.0.0");
    expect(refs).toContain("Expert:writer@2.0.0");
    expect(refs).toContain("RuntimeProfile:writer.runtime@2.0.0");
  });

  it("recovers an unpublished revision directory left by an interrupted publish", async () => {
    const { directory, project } = await stores();
    const orphan = join(directory, "studio/revisions/1");
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "orphan.txt"), "incomplete");

    const published = await project.publish({
      expectedRevision: 0,
      resources: [exampleRuntime(), exampleExpert()],
    });

    expect(published.revision).toBe(1);
    await expect(readFile(join(orphan, "orphan.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("serializes compare-and-swap commits across independent repository instances", async () => {
    const { directory } = await stores();
    const first = createPragmaProjectStore({ projectsPath: directory });
    const second = createPragmaProjectStore({ projectsPath: directory });

    const results = await Promise.allSettled([
      first.publish({ expectedRevision: 0, resources: [exampleRuntime()] }),
      second.publish({ expectedRevision: 0, resources: [exampleRuntime()] }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toMatchObject({
      code: "revision_conflict",
    });
    expect((await first.get()).revision).toBe(1);
  });

  it("edits arbitrary runtime profiles while preserving portable capabilities", async () => {
    const { project, experts } = await stores();
    const expert = exampleExpert();
    expert.spec.runtime = { ref: "runtime-profile:remote@1.0.0" };
    expert.spec.capabilities = [{ ref: "capability:portable@2", kind: "skill" }];
    await project.publish({
      expectedRevision: 0,
      resources: [remoteRuntime(), portableCapability(), expert],
    });

    const view = await experts.get("expert:writer@1.0.0");
    expect(view.model).toEqual({
      runtimeId: "remote-runtime",
      providerId: "remote-provider",
      modelId: "remote-model",
    });
    expect(view.resourceRuntime).toEqual(expert.spec.runtime);
    expect(view.opaqueCapabilities).toEqual(expert.spec.capabilities);
    await experts.update("expert:writer@1.0.0", {
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
      opaqueCapabilities: view.opaqueCapabilities,
    });

    const stored = (await project.get()).resources.find(
      (resource) => resource.kind === "Expert" && resource.metadata.id === "writer",
    );
    expect(stored?.kind === "Expert" ? stored.spec.runtime : undefined).toEqual({
      ref: "runtime-profile:writer.runtime@1.0.0",
    });
    expect(stored?.kind === "Expert" ? stored.spec.capabilities : undefined).toEqual(
      expert.spec.capabilities,
    );
  });
});

function exampleExpert(): PragmaExpertResource {
  return {
    apiVersion: "pragma/v2",
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
      runtime: { ref: "runtime-profile:writer.runtime@1.0.0" },
      capabilities: [],
      toolApprovals: {},
      contextStores: [],
      plugins: [],
      tools: [],
    },
  };
}

function exampleRuntime(): PragmaRuntimeProfileResource {
  return {
    apiVersion: "pragma/v2",
    kind: "RuntimeProfile",
    metadata: {
      id: "writer.runtime",
      version: "1.0.0",
      name: "Writer Runtime",
      description: "Writer runtime profile.",
      tags: [],
    },
    spec: { adapter: "pragma.runtime.profile@v1", config: { runtimeId: "codex" } },
  };
}

function remoteRuntime(): PragmaRuntimeProfileResource {
  return {
    ...exampleRuntime(),
    metadata: { ...exampleRuntime().metadata, id: "remote", name: "Remote Runtime" },
    spec: {
      adapter: "pragma.runtime.profile@v1",
      config: {
        runtimeId: "remote-runtime",
        providerId: "remote-provider",
        model: "remote-model",
      },
    },
  };
}

function portableCapability(): PragmaCapabilityResource {
  return {
    apiVersion: "pragma/v2",
    kind: "Capability",
    metadata: {
      id: "portable",
      version: "2",
      name: "Portable Capability",
      description: "Portable host capability.",
      tags: [],
    },
    spec: {
      adapter: "pragma.capability.host@v1",
      binding: "binding:portable",
      config: { key: "portable" },
    },
  };
}

function exampleFlow(): PragmaFlowResource {
  return {
    apiVersion: "pragma/v2",
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
