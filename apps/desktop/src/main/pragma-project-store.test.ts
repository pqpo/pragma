import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  PragmaCapabilityResource,
  PragmaExpertResource,
  PragmaExpertTeamResource,
  PragmaFlowResource,
  PragmaRuntimeProfileResource,
} from "@pragma/interpreter/ast";
import { afterEach, describe, expect, it } from "vitest";
import { BUILT_IN_STEWARD_REF, builtInStewardResource } from "@pragma/steward";

import { createExpertDefinitionStore } from "./expert-definition-store.ts";
import { createPragmaProjectStore, PragmaProjectStoreError } from "./pragma-project-store.ts";
import { createDesktopSystemExpertRegistry } from "./system-expert-registry.ts";

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
  const project = createPragmaProjectStore({
    projectsPath: directory,
    reservedResourceRefs: new Set([BUILT_IN_STEWARD_REF]),
  });
  return {
    directory,
    project,
    experts: createExpertDefinitionStore({
      project,
      systemExperts: createDesktopSystemExpertRegistry(),
      validateModel: async () => undefined,
    }),
  };
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

  it("rejects Expert submissions without a runtime and explicit model", async () => {
    const { project } = await stores();
    const missingRuntime = exampleExpert();
    delete missingRuntime.spec.runtime;
    await expect(
      project.publish({ expectedRevision: 0, resources: [missingRuntime] }),
    ).rejects.toMatchObject({
      code: "project_invalid",
      diagnostics: [expect.objectContaining({ message: "Runtime is required." })],
    });

    const runtime = exampleRuntime();
    runtime.spec.config = { runtimeId: "codex" };
    await expect(
      project.publish({ expectedRevision: 0, resources: [runtime, exampleExpert()] }),
    ).rejects.toMatchObject({
      code: "project_invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ message: "Model provider is required." }),
        expect.objectContaining({ message: "Model is required." }),
      ]),
    });
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
      instructions: "Write verified release notes.",
      model: { runtimeId: "codex", providerId: "openai", modelId: "gpt-test" },
      capabilities: [],
      contextStoreMounts: [],
      plugins: [],
      toolApprovals: {},
    });
    expect(created.id).toBe("writer");
    expect(await experts.list()).toHaveLength(2);
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
      instructions: "Write verified release notes.",
      model: { runtimeId: "codex", providerId: "openai", modelId: "gpt-test" },
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
        instructions: "Write verified release notes.",
        model: { runtimeId: "codex", providerId: "openai", modelId: "gpt-test" },
        capabilities: [],
        contextStoreMounts: [],
        plugins: [],
        toolApprovals: {},
      });
    await create("1.0.0");
    await create("2.0.0");

    expect((await experts.list()).map((expert) => expert.ref).toSorted()).toEqual([
      BUILT_IN_STEWARD_REF,
      "expert:writer@1.0.0",
      "expert:writer@2.0.0",
    ]);
    await experts.remove("expert:writer@1.0.0");
    const refs = (await project.get()).resources.map(
      (resource) => `${resource.kind}:${resource.metadata.id}@${resource.metadata.version}`,
    );
    expect(refs).not.toContain("Expert:writer@1.0.0");
    expect(refs).not.toContain("RuntimeProfile:writer_runtime@1.0.0");
    expect(refs).toContain("Expert:writer@2.0.0");
    expect(refs).toContain("RuntimeProfile:writer_runtime@2.0.0");
  });

  it("blocks deletion of referenced Experts and every write path for system Experts", async () => {
    const { project, experts } = await stores();
    const flow = exampleFlow();
    flow.spec.graph.steps["finish"] = {
      expert: { ref: "expert:writer@1.0.0" },
      version: "1.0.0",
    };
    await project.publish({
      expectedRevision: 0,
      resources: [exampleRuntime(), exampleExpert(), flow],
    });

    await expect(experts.remove("expert:writer@1.0.0")).rejects.toMatchObject({
      code: "expert_referenced",
    });
    await expect(
      project.upsert({ expectedRevision: 1, resource: builtInStewardResource() }),
    ).rejects.toMatchObject({ code: "built_in_readonly" });
    await expect(experts.remove(BUILT_IN_STEWARD_REF)).rejects.toMatchObject({
      code: "built_in_readonly",
    });
    expect((await project.get()).revision).toBe(1);
  });

  it("blocks deletion of Teams and Flows referenced by another Flow", async () => {
    const { project } = await stores();
    const team = exampleTeam();
    const teamConsumer = exampleFlow();
    teamConsumer.metadata = {
      ...teamConsumer.metadata,
      id: "team_consumer",
      name: "Team consumer",
    };
    teamConsumer.spec.graph.steps["finish"] = {
      team: { ref: "team:reviewers@1.0.0" },
      version: "1.0.0",
    };
    const child = exampleFlow();
    child.metadata = { ...child.metadata, id: "child", name: "Child flow" };
    const parent = exampleFlow();
    parent.metadata = { ...parent.metadata, id: "parent", name: "Parent flow" };
    parent.spec.graph.steps["finish"] = {
      flow: { ref: "flow:child@1.0.0" },
      version: "1.0.0",
    };
    await project.publish({
      expectedRevision: 0,
      resources: [exampleRuntime(), exampleExpert(), team, teamConsumer, child, parent],
    });

    await expect(
      project.remove({ expectedRevision: 1, ref: "team:reviewers@1.0.0" }),
    ).rejects.toMatchObject({ code: "resource_referenced" });
    await expect(
      project.remove({ expectedRevision: 1, ref: "flow:child@1.0.0" }),
    ).rejects.toMatchObject({ code: "resource_referenced" });
    expect((await project.get()).revision).toBe(1);
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
    expect(view.executionProfile).toEqual({
      mode: "pinned",
      model: {
        runtimeId: "remote-runtime",
        providerId: "remote-provider",
        modelId: "remote-model",
      },
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
      model:
        view.executionProfile.mode === "pinned"
          ? view.executionProfile.model
          : (() => {
              throw new Error("Project expert must use a pinned model.");
            })(),
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
      ref: "runtime-profile:writer_runtime@1.0.0",
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
      instructions: "Write verified release notes.",
      runtime: { ref: "runtime-profile:writer_runtime@1.0.0" },
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
      id: "writer_runtime",
      version: "1.0.0",
      name: "Writer Runtime",
      description: "Writer runtime profile.",
      tags: [],
    },
    spec: {
      adapter: "pragma.runtime.profile@v1",
      config: { runtimeId: "codex", providerId: "openai", model: "gpt-test" },
    },
  };
}

function exampleTeam(): PragmaExpertTeamResource {
  return {
    apiVersion: "pragma/v2",
    kind: "ExpertTeam",
    metadata: {
      id: "reviewers",
      version: "1.0.0",
      name: "Reviewers",
      description: "Coordinates review work.",
      tags: [],
    },
    spec: {
      coordinator: { ref: "expert:writer@1.0.0" },
      members: [{ ref: "expert:writer@1.0.0" }],
      delegation: {
        maxConcurrency: 2,
        maxDepth: 2,
        context: "context-policy:pragma.fresh@v1",
        runtimes: {},
      },
    },
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
