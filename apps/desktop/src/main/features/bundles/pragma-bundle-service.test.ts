import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PragmaPaths } from "@pragma/core";
import {
  canonicalPragmaResourceRef,
  type PragmaCapabilityResource,
  type PragmaExpertResource,
  type PragmaExpertTeamResource,
  type PragmaFlowResource,
  type PragmaRuntimeProfileResource,
} from "@pragma/interpreter/ast";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { DesktopRuntimeAvailability } from "../../../shared/contracts/index.ts";
import type { ContextStoreStore } from "../context-stores/context-store-store.ts";
import type { PluginStore } from "../plugins/plugin-store.ts";
import { createPragmaProjectStore } from "../projects/pragma-project-store.ts";
import { createWorkflowLayoutStore } from "../projects/workflow-layout-store.ts";
import { createPragmaBundleService } from "./pragma-bundle-service.ts";
import {
  makePortableBundleResources,
  rewriteBundleWithResolutions,
} from "./pragma-bundle-resources.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(async (directory) => await rm(directory, { recursive: true, force: true })),
  );
});

describe("PragmaBundleService", () => {
  it("exports a verifiable ZIP with a stable semantic fingerprint", async () => {
    const fixture = await createFixture("source");
    const firstPath = join(fixture.root, "first.pragma");
    const secondPath = join(fixture.root, "second.pragma");

    const first = await fixture.service.exportTo(exportInput(fixture.projectRevision), firstPath);
    const second = await fixture.service.exportTo(exportInput(fixture.projectRevision), secondPath);
    const archive = unzipSync(new Uint8Array(await readFile(firstPath)));

    expect(first.bundleFingerprint).toBe(second.bundleFingerprint);
    expect(Object.keys(archive)).toContain("bundle.json");
    expect(Object.keys(archive)).toContain("pragma.yaml");
    expect(strFromU8(archive["pragma.yaml"]!)).toContain("apiVersion: pragma/v3");
    await expect(fixture.service.inspect(firstPath)).resolves.toMatchObject({
      bundleFingerprint: first.bundleFingerprint,
      root: { ref: "expert:1xddvess309a6gme", name: "Writer" },
      resources: 2,
    });
  });

  it("rejects a bundle whose indexed project file was modified", async () => {
    const fixture = await createFixture("tamper");
    const path = join(fixture.root, "workflow.pragma");
    await fixture.service.exportTo(exportInput(fixture.projectRevision), path);
    const archive = unzipSync(new Uint8Array(await readFile(path)));
    archive["pragma.yaml"] = strToU8(`${strFromU8(archive["pragma.yaml"]!)}\n# tampered\n`);
    await writeFile(path, zipSync(archive));

    await expect(fixture.service.inspect(path)).rejects.toThrow(
      "Bundle file verification failed: pragma.yaml",
    );
  });

  it("accepts only the .pragma transfer format", async () => {
    const fixture = await createFixture("extension");

    await expect(
      fixture.service.inspect(join(fixture.root, "workflow.pragma.bundle")),
    ).rejects.toThrow("Select a .pragma file.");
  });

  it("imports conflicts as a copy and rewrites internal Runtime references", async () => {
    const source = await createFixture("copy-source");
    const path = join(source.root, "workflow.pragma");
    const exported = await source.service.exportTo(exportInput(source.projectRevision), path);
    const target = await createFixture("copy-target", {
      instructions: "A conflicting local instruction.",
      runtimeId: "local-runtime",
    });

    const installation = await target.service.startImport({
      ...importInput(path, exported.bundleFingerprint, target.projectRevision),
      conflicts: [
        { resourceRef: "expert:1xddvess309a6gme", action: "copy" },
        { resourceRef: "runtime-profile:zdkgs0fde4xt00vr", action: "copy" },
      ],
    });
    const snapshot = await target.project.get();
    const copiedExpert = snapshot.resources.find(
      (resource): resource is PragmaExpertResource =>
        resource.kind === "Expert" && canonicalPragmaResourceRef(resource) === installation.rootRef,
    );

    expect(installation.status).toBe("ready");
    expect(installation.rootRef).not.toBe("expert:1xddvess309a6gme");
    expect(copiedExpert?.metadata.name).toContain("(copy)");
    expect(copiedExpert?.spec.runtime?.ref).not.toBe("runtime-profile:zdkgs0fde4xt00vr");
    expect(
      snapshot.resources.some(
        (resource) =>
          resource.kind === "RuntimeProfile" &&
          canonicalPragmaResourceRef(resource) === copiedExpert?.spec.runtime?.ref,
      ),
    ).toBe(true);
    expect(installation.createdResourceRefs).toHaveLength(2);

    await target.service.discardInstallation(installation.id);
    await expect(target.service.listInstallations()).resolves.toEqual([]);
    await expect(target.project.get()).resolves.toMatchObject({
      resources: expect.arrayContaining([
        expect.objectContaining({
          kind: "Expert",
          metadata: expect.objectContaining({ id: "1xddvess309a6gme" }),
        }),
      ]),
    });
    expect((await target.project.get()).resources).toHaveLength(2);
  });

  it("applies a selected Runtime and model during the final import commit", async () => {
    const source = await createFixture("runtime-binding-source");
    const path = join(source.root, "workflow.pragma");
    const exported = await source.service.exportTo(exportInput(source.projectRevision), path);
    const target = await createFixture("runtime-binding-target", {
      instructions: "Existing local expert.",
      runtimes: [
        {
          id: "pi",
          isDefault: true,
          kind: "local",
          displayName: "Pragma Runtime",
          status: "available",
          models: [
            {
              id: "gpt-test",
              displayName: "GPT Test",
              provider: { kind: "registered", id: "openai", displayName: "OpenAI" },
            },
          ],
        },
      ],
    });

    const installation = await target.service.startImport({
      ...importInput(path, exported.bundleFingerprint, target.projectRevision),
      conflicts: [
        { resourceRef: "expert:1xddvess309a6gme", action: "copy" },
        { resourceRef: "runtime-profile:zdkgs0fde4xt00vr", action: "copy" },
      ],
      runtimes: [
        {
          resourceRef: "runtime-profile:zdkgs0fde4xt00vr",
          runtimeId: "pi",
          providerId: "openai",
          modelId: "gpt-test",
        },
      ],
    });
    const importedRuntime = (await target.project.get()).resources.find(
      (resource): resource is PragmaRuntimeProfileResource =>
        resource.kind === "RuntimeProfile" &&
        installation.createdResourceRefs.includes(canonicalPragmaResourceRef(resource)),
    );

    expect(installation.status).toBe("ready");
    expect(importedRuntime?.spec.config).toEqual({
      runtimeId: "pi",
      providerId: "openai",
      model: "gpt-test",
    });
  });

  it("prompts for identical resource conflicts and permits repeated copy imports", async () => {
    const source = await createFixture("repeat-copy-source");
    const path = join(source.root, "workflow.pragma");
    const exported = await source.service.exportTo(exportInput(source.projectRevision), path);
    const target = await createFixture("repeat-copy-target");

    const initialInspection = await target.service.inspect(path);
    expect(initialInspection.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: "expert:1xddvess309a6gme",
          matches: expect.arrayContaining([expect.objectContaining({ kind: "identity" })]),
        }),
        expect.objectContaining({
          ref: "runtime-profile:zdkgs0fde4xt00vr",
          matches: expect.arrayContaining([expect.objectContaining({ kind: "identity" })]),
        }),
      ]),
    );
    await expect(
      target.service.startImport(
        importInput(path, exported.bundleFingerprint, target.projectRevision),
      ),
    ).rejects.toThrow("Choose one import action");

    const first = await target.service.startImport({
      ...importInput(path, exported.bundleFingerprint, target.projectRevision),
      conflicts: [
        { resourceRef: "expert:1xddvess309a6gme", action: "copy" },
        { resourceRef: "runtime-profile:zdkgs0fde4xt00vr", action: "copy" },
      ],
    });
    const repeatedInspection = await target.service.inspect(path);

    expect(first.status).toBe("ready");
    expect(repeatedInspection.alreadyInstalledId).toBeUndefined();
    expect(repeatedInspection.conflicts).not.toHaveLength(0);

    const second = await target.service.startImport({
      ...importInput(path, exported.bundleFingerprint, first.projectRevision),
      conflicts: repeatedInspection.conflicts.map((conflict) => ({
        resourceRef: conflict.ref,
        action: "copy" as const,
      })),
    });
    const snapshot = await target.project.get();

    expect(second.status).toBe("ready");
    expect(second.id).not.toBe(first.id);
    expect(second.rootRef).not.toBe(first.rootRef);
    expect(snapshot.resources).toHaveLength(6);
    expect(
      snapshot.resources
        .filter((resource) => resource.kind === "Expert")
        .map((resource) => resource.metadata.name)
        .toSorted(),
    ).toEqual(["Writer", "Writer (copy 2)", "Writer (copy)"]);
  });

  it("updates normalized name conflicts by retaining local identities", async () => {
    const source = await createFixture("update-source");
    const path = join(source.root, "workflow.pragma");
    const exported = await source.service.exportTo(exportInput(source.projectRevision), path);
    const target = await createFixture("update-target", {
      expertId: "3sfd30h5017wd17d",
      runtimeResourceId: "v3b460tasfhyf22d",
    });

    const installation = await target.service.startImport({
      ...importInput(path, exported.bundleFingerprint, target.projectRevision),
      conflicts: [
        { resourceRef: "expert:1xddvess309a6gme", action: "update" },
        { resourceRef: "runtime-profile:zdkgs0fde4xt00vr", action: "update" },
      ],
    });
    const snapshot = await target.project.get();
    const updated = snapshot.resources.find(
      (resource): resource is PragmaExpertResource =>
        resource.kind === "Expert" && canonicalPragmaResourceRef(resource) === installation.rootRef,
    );

    expect(installation.rootRef).toBe("expert:3sfd30h5017wd17d");
    expect(installation.createdResourceRefs).toEqual([]);
    expect(updated?.spec.runtime?.ref).toBe("runtime-profile:v3b460tasfhyf22d");
    expect(snapshot.resources).toHaveLength(2);
    await expect(target.service.discardInstallation(installation.id)).rejects.toThrow(
      "changed existing project resources",
    );
  });

  it("rewrites only typed DSL identities and leaves opaque plugin config unchanged", () => {
    const sourceExpert = expert("Write verified release notes.");
    sourceExpert.spec.plugins = [
      {
        ref: "plugin:memory@1.0.0",
        config: {
          literalResourceRef: "runtime-profile:zdkgs0fde4xt00vr",
          nested: { zdkgs0fde4xt00vr: "expert:1xddvess309a6gme" },
        },
      },
    ];

    const rewritten = rewriteBundleWithResolutions(
      [sourceExpert, runtime("codex")],
      [expert("Existing"), runtime("codex")],
      [
        { resourceRef: "expert:1xddvess309a6gme", action: "copy" },
        { resourceRef: "runtime-profile:zdkgs0fde4xt00vr", action: "copy" },
      ],
    ).resources;
    const copied = rewritten.find(
      (resource): resource is PragmaExpertResource => resource.kind === "Expert",
    );

    expect(copied?.spec.runtime?.ref).not.toBe(sourceExpert.spec.runtime?.ref);
    expect(copied?.spec.plugins[0]?.config).toEqual(sourceExpert.spec.plugins[0]?.config);
  });

  it("supports mixed copy and update decisions across one resource graph", () => {
    const sourceExpert = expert("Use the imported Runtime.");
    const localExpert = expert("Keep the local Expert.");
    const localRuntime = runtime("codex", "v3b460tasfhyf22d");

    const rewritten = rewriteBundleWithResolutions(
      [sourceExpert, runtime("codex")],
      [localExpert, localRuntime],
      [
        { resourceRef: "expert:1xddvess309a6gme", action: "copy" },
        { resourceRef: "runtime-profile:zdkgs0fde4xt00vr", action: "update" },
      ],
    );
    const copied = rewritten.resources.find(
      (resource): resource is PragmaExpertResource => resource.kind === "Expert",
    );

    expect(rewritten.refMap.get("expert:1xddvess309a6gme")).not.toBe("expert:1xddvess309a6gme");
    expect(rewritten.refMap.get("runtime-profile:zdkgs0fde4xt00vr")).toBe(
      "runtime-profile:v3b460tasfhyf22d",
    );
    expect(copied?.spec.runtime?.ref).toBe("runtime-profile:v3b460tasfhyf22d");
  });

  it("reserves unchanged imported names when naming conflict copies", () => {
    const conflicting = runtime("codex");
    const unchanged = runtime("pi", "v3b460tasfhyf22d");
    unchanged.metadata.name = "Writer Runtime (copy)";

    const rewritten = rewriteBundleWithResolutions(
      [conflicting, unchanged],
      [runtime("codex")],
      [{ resourceRef: "runtime-profile:zdkgs0fde4xt00vr", action: "copy" }],
    );

    expect(
      rewritten.resources
        .filter((resource) => resource.kind === "RuntimeProfile")
        .map((resource) => resource.metadata.name)
        .toSorted(),
    ).toEqual(["Writer Runtime (copy 2)", "Writer Runtime (copy)"]);
  });

  it("removes machine-local Runtime configuration from the portable DSL", () => {
    const source = runtime("codex");
    source.spec.config = {
      runtimeId: "codex",
      providerId: "openai",
      model: "gpt-test",
      executablePath: "/Users/source/bin/codex",
      sessionHome: "C:\\source\\sessions",
    };

    const [portable] = makePortableBundleResources([source]);

    if (portable?.kind !== "RuntimeProfile") throw new Error("Expected a Runtime profile.");
    expect(portable.spec.config).toEqual({
      runtimeId: "codex",
      providerId: "openai",
      model: "gpt-test",
    });
  });

  it("keeps portable adapter config while removing a machine-local binding", () => {
    const [portable] = makePortableBundleResources([portableCapability()]);

    if (portable?.kind !== "Capability") throw new Error("Expected a Capability.");
    expect(portable.spec.binding).toBeUndefined();
    expect(portable.spec.config).toEqual({ key: "portable" });
  });

  it("exports an ExpertTeam whose member uses a bound host capability", async () => {
    const fixture = await createFixture("bound-team");
    const snapshot = await fixture.project.get();
    const sourceExpert = snapshot.resources.find(
      (resource): resource is PragmaExpertResource => resource.kind === "Expert",
    );
    if (sourceExpert === undefined) throw new Error("Expected an Expert.");
    const capability = portableCapability();
    const team = expertTeam();
    const published = await fixture.project.publish({
      expectedRevision: snapshot.revision,
      resources: [
        {
          ...sourceExpert,
          spec: {
            ...sourceExpert.spec,
            capabilities: [{ ref: canonicalPragmaResourceRef(capability), kind: "tools" as const }],
          },
        },
        ...snapshot.resources.filter((resource) => resource.kind !== "Expert"),
        capability,
        team,
      ],
    });
    const path = join(fixture.root, "team.pragma");

    await fixture.service.exportTo(
      {
        ...exportInput(published.revision),
        rootRef: canonicalPragmaResourceRef(team),
      },
      path,
    );
    const archive = unzipSync(new Uint8Array(await readFile(path)));
    const projectFiles = Object.entries(archive)
      .filter(([name]) => name.endsWith(".yaml"))
      .map(([, contents]) => strFromU8(contents))
      .join("\n");

    expect(projectFiles).toContain("key: portable");
    expect(projectFiles).not.toContain("binding:");
  });

  it("rejects foreign and unavailable bindings and gates transitive Flow execution", async () => {
    const source = await createFixture("pending-source");
    const path = join(source.root, "workflow.pragma");
    const exported = await source.service.exportTo(exportInput(source.projectRevision), path);
    const target = await createFixture("pending-target", {
      instructions: "Existing local expert.",
      runtimes: [],
    });
    const installation = await target.service.startImport({
      ...importInput(path, exported.bundleFingerprint, target.projectRevision),
      conflicts: [
        { resourceRef: "expert:1xddvess309a6gme", action: "copy" },
        { resourceRef: "runtime-profile:zdkgs0fde4xt00vr", action: "copy" },
      ],
    });
    const importedRuntimeRef = installation.resourceRefs.find((ref) =>
      ref.startsWith("runtime-profile:"),
    );
    expect(installation.status).toBe("needs_setup");
    expect(importedRuntimeRef).toBeDefined();

    await expect(
      target.service.resolveInstallation({
        installationId: installation.id,
        baseRevision: installation.projectRevision,
        runtimes: [
          {
            resourceRef: "runtime-profile:zdkgs0fde4xt00vr",
            runtimeId: "codex",
            providerId: "openai",
            modelId: "gpt-test",
          },
        ],
        capabilities: [],
        contextStores: [],
        secrets: {},
      }),
    ).rejects.toThrow("not pending in this installation");
    await expect(
      target.service.resolveInstallation({
        installationId: installation.id,
        baseRevision: installation.projectRevision,
        runtimes: [
          {
            resourceRef: importedRuntimeRef!,
            runtimeId: "codex",
            providerId: "openai",
            modelId: "gpt-test",
          },
        ],
        capabilities: [],
        contextStores: [],
        secrets: {},
      }),
    ).rejects.toThrow("unavailable");

    const snapshot = await target.project.get();
    const flow = flowCalling(installation.rootRef);
    await target.project.publish({
      expectedRevision: snapshot.revision,
      resources: [...snapshot.resources, flow],
    });
    await expect(target.service.isRefPending(canonicalPragmaResourceRef(flow))).resolves.toBe(true);
  });

  it("rejects case-insensitive duplicate archive paths before installing anything", async () => {
    const fixture = await createFixture("duplicate-path");
    const path = join(fixture.root, "workflow.pragma");
    await fixture.service.exportTo(exportInput(fixture.projectRevision), path);
    const archive = unzipSync(new Uint8Array(await readFile(path)));
    archive["PRAGMA.YAML"] = archive["pragma.yaml"]!;
    await writeFile(path, zipSync(archive));

    await expect(fixture.service.inspect(path)).rejects.toThrow(
      "Duplicate or non-portable bundle path",
    );
  });

  it("finishes recovered local setup and removes the retained source archive", async () => {
    const source = await createFixture("resolve-source");
    const path = join(source.root, "workflow.pragma");
    const exported = await source.service.exportTo(exportInput(source.projectRevision), path);
    const runtimes: DesktopRuntimeAvailability[] = [];
    const target = await createFixture("resolve-target", {
      instructions: "Existing local expert.",
      runtimes,
    });
    const installation = await target.service.startImport({
      ...importInput(path, exported.bundleFingerprint, target.projectRevision),
      conflicts: [
        { resourceRef: "expert:1xddvess309a6gme", action: "copy" },
        { resourceRef: "runtime-profile:zdkgs0fde4xt00vr", action: "copy" },
      ],
    });
    const runtimeRef = installation.resourceRefs.find((ref) => ref.startsWith("runtime-profile:"));
    expect(runtimeRef).toBeDefined();
    runtimes.push({
      id: "codex",
      isDefault: true,
      kind: "local",
      displayName: "Codex",
      status: "available",
      models: [
        {
          id: "gpt-test",
          displayName: "GPT Test",
          provider: { kind: "registered", id: "openai", displayName: "OpenAI" },
        },
      ],
    });

    const ready = await target.service.resolveInstallation({
      installationId: installation.id,
      baseRevision: installation.projectRevision,
      runtimes: [
        {
          resourceRef: runtimeRef!,
          runtimeId: "codex",
          providerId: "openai",
          modelId: "gpt-test",
        },
      ],
      capabilities: [],
      contextStores: [],
      secrets: {},
    });

    expect(ready.status).toBe("ready");
    await expect(
      stat(target.paths.bundleInstallationArchive(installation.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createFixture(
  name: string,
  overrides: {
    readonly instructions?: string;
    readonly runtimeId?: string;
    readonly expertId?: string;
    readonly runtimeResourceId?: string;
    readonly runtimes?: DesktopRuntimeAvailability[];
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), `pragma-bundle-${name}-`));
  directories.push(root);
  const paths = new PragmaPaths({ pragmaHome: join(root, ".pragma") });
  const project = createPragmaProjectStore({
    projectsPath: paths.projectsRoot(),
    objectsPath: paths.contentObjectsRoot(),
    projectViewsPath: paths.projectViewsCacheRoot(),
    storagePaths: paths,
  });
  const published = await project.publish({
    expectedRevision: 0,
    resources: [
      expert(
        overrides.instructions ?? "Write verified release notes.",
        overrides.expertId,
        overrides.runtimeResourceId,
      ),
      runtime(overrides.runtimeId ?? "codex", overrides.runtimeResourceId),
    ],
  });
  const service = createPragmaBundleService({
    paths,
    project,
    capabilities: {
      list: async () => [],
    } as unknown as CapabilityStore,
    contextStores: {
      list: async () => [],
    } as unknown as ContextStoreStore,
    plugins: {
      list: async () => [],
    } as unknown as PluginStore,
    layouts: createWorkflowLayoutStore({ projectsPath: paths.projectsRoot() }),
    getRuntimes: async () =>
      overrides.runtimes ?? [
        {
          id: "codex",
          isDefault: true,
          kind: "local",
          displayName: "Codex",
          status: "available",
          models: [
            {
              id: "gpt-test",
              displayName: "GPT Test",
              provider: { kind: "registered", id: "openai", displayName: "OpenAI" },
            },
          ],
        },
      ],
  });
  return { root, paths, project, projectRevision: published.revision, service };
}

function exportInput(projectRevision: number) {
  return {
    rootRef: "expert:1xddvess309a6gme" as const,
    projectRevision,
    modules: {
      capabilities: true,
      plugins: true,
      knowledgeBases: false,
      flowLayouts: true,
    },
  };
}

function importInput(
  sourcePath: string,
  expectedFingerprint: string,
  expectedProjectRevision: number,
) {
  return {
    sourcePath,
    expectedFingerprint,
    expectedProjectRevision,
    conflicts: [],
    runtimes: [],
    capabilities: [],
    contextStores: [],
    secrets: {},
  };
}

function expert(
  instructions: string,
  id = "1xddvess309a6gme",
  runtimeResourceId = "zdkgs0fde4xt00vr",
): PragmaExpertResource {
  return {
    apiVersion: "pragma/v3",
    kind: "Expert",
    metadata: {
      id,
      name: "Writer",
      description: "Writes release notes",
      tags: [],
    },
    spec: {
      scope: "Release communication",
      instructions,
      runtime: { ref: `runtime-profile:${runtimeResourceId}` },
      capabilities: [],
      toolApprovals: {},
      contextStores: [],
      plugins: [],
      tools: [],
    },
  };
}

function runtime(runtimeId: string, resourceId = "zdkgs0fde4xt00vr"): PragmaRuntimeProfileResource {
  return {
    apiVersion: "pragma/v3",
    kind: "RuntimeProfile",
    metadata: {
      id: resourceId,
      name: "Writer Runtime",
      description: "Writer runtime profile.",
      tags: ["desktop-managed"],
    },
    spec: {
      adapter: "pragma.runtime.profile@v1",
      config: { runtimeId, providerId: "openai", model: "gpt-test" },
    },
  };
}

function portableCapability(): PragmaCapabilityResource {
  return {
    apiVersion: "pragma/v3",
    kind: "Capability",
    metadata: {
      id: "nv27faxmxpqnxwqr",
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

function expertTeam(): PragmaExpertTeamResource {
  return {
    apiVersion: "pragma/v3",
    kind: "ExpertTeam",
    metadata: {
      id: "p8cbn3cg2avyksn4",
      name: "Reviewers",
      description: "Coordinates review work.",
      tags: [],
    },
    spec: {
      coordinator: { ref: "expert:1xddvess309a6gme" },
      members: [{ ref: "expert:1xddvess309a6gme" }],
      delegation: {
        maxConcurrency: 2,
        maxDepth: 2,
        context: "context-policy:pragma.fresh@v1",
        runtimes: {},
      },
    },
  };
}

function flowCalling(expertRef: string): PragmaFlowResource {
  return {
    apiVersion: "pragma/v3",
    kind: "Flow",
    metadata: {
      id: "qj3t30sa520dvfvj",
      name: "Pending dependency flow",
      description: "Calls an imported Expert.",
      tags: [],
    },
    spec: {
      limits: { maxNodeVisits: 10 },
      graph: {
        start: "run",
        steps: {
          run: {
            expert: { ref: expertRef as `expert:${string}` },
            prompt: { segments: [{ text: "Run." }] },
          },
        },
        transitions: { run: { end: true } },
        loops: {},
      },
    },
  };
}
