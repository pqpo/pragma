import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  PragmaCapabilityResource,
  PragmaContextStoreResource,
  PragmaExpertResource,
  PragmaExpertTeamResource,
  PragmaFlowResource,
  PragmaRuntimeProfileResource,
  PragmaAutomationResource,
  PragmaEvaluationResource,
} from "@pragma/interpreter/ast";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILT_IN_PRAGMA_REF,
  builtInAgentResource,
  pragmaManagementCapabilityResource,
} from "@pragma/built-in-agents";
import { ContentAddressedStore, derivePragmaResourceId } from "@pragma/core";

import type { ExpertDefinition, UpdateExpertDefinition } from "../../../shared/contracts/index.ts";
import { createExpertDefinitionStore } from "../experts/expert-definition-store.ts";
import { createPragmaProjectStore, PragmaProjectStoreError } from "./pragma-project-store.ts";
import { createDesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import {
  desktopCapabilityBindingRef,
  desktopContextBindingRef,
} from "../../platform/bindings/desktop-binding-ref.ts";

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
    reservedResourceRefs: new Set([BUILT_IN_PRAGMA_REF]),
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

async function projectRevisionFile(
  directory: string,
  revision: number,
  relativePath: string,
): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(directory, "studio", "revisions", `${revision}.json`), "utf8"),
  ) as { readonly snapshotHash: string };
  return await readFile(
    join(directory, ".cache", "views", manifest.snapshotHash, relativePath),
    "utf8",
  );
}

describe("PragmaProjectStore", () => {
  it("allows the canonical fixed resource but rejects modified copies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-project-fixed-resource-"));
    directories.push(directory);
    const fixed = pragmaManagementCapabilityResource();
    if (fixed.kind !== "Capability") throw new Error("Expected the fixed Capability resource.");
    const project = createPragmaProjectStore({
      projectsPath: directory,
      fixedResources: [fixed],
    });
    const published = await project.publish({ expectedRevision: 0, resources: [fixed] });

    await expect(
      project.upsert({
        baseRevision: published.revision,
        resource: {
          ...fixed,
          metadata: { ...fixed.metadata, name: "Modified system resource" },
        },
      }),
    ).rejects.toMatchObject({ code: "built_in_readonly" });
  });

  it("publishes the initial empty project before it is pinned by a Mission", async () => {
    const { directory, project } = await stores();

    expect((await project.get()).revision).toBe(0);

    const initial = await project.ensurePublished();
    const existing = await project.ensurePublished();
    await Promise.all(Array.from({ length: 20 }, async () => await project.get()));

    expect(initial).toMatchObject({ revision: 1, resources: [] });
    expect(existing).toMatchObject({ revision: 1, resources: [] });
    await expect(readdir(join(directory, ".cache", "project-view-leases"))).resolves.toEqual([]);
  });

  it("shares the first published revision across concurrent project stores", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-project-store-concurrent-"));
    directories.push(directory);
    const first = createPragmaProjectStore({ projectsPath: directory });
    const second = createPragmaProjectStore({ projectsPath: directory });

    const revisions = await Promise.all([first.ensurePublished(), second.ensurePublished()]);

    expect(revisions.map((snapshot) => snapshot.revision)).toEqual([1, 1]);
    expect((await first.get()).revision).toBe(1);
  });

  it("migrates every immutable v3 revision to short IDs without changing revision numbers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-project-v3-migration-"));
    directories.push(directory);
    await seedLegacyProject(directory, [legacyFlowSource("release", "1.0.0")]);
    const project = createPragmaProjectStore({ projectsPath: directory });

    const migrated = await project.get();
    const expectedId = derivePragmaResourceId("studio\0Flow\0release");

    expect(migrated).toMatchObject({
      revision: 1,
      resources: [
        expect.objectContaining({
          apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
          kind: "Flow",
          metadata: expect.objectContaining({ id: expectedId, name: "Release" }),
        }),
      ],
    });
    await expect(project.readIdentityMigrations()).resolves.toEqual([
      { kind: "Flow", sourceId: "release", targetId: expectedId },
    ]);
    expect(await readFile(join(directory, "studio", "project.json"), "utf8")).toContain(
      "pragma.desktop-project/v4",
    );
  });

  it("migrates every historical revision while preserving revision numbers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-project-v3-revisions-migration-"));
    directories.push(directory);
    await seedLegacyProjectRevisions(directory, [
      [legacyFlowSource("release", "1.0.0")],
      [legacyFlowSource("release", "2.0.0")],
    ]);
    const project = createPragmaProjectStore({ projectsPath: directory });

    const head = await project.get();
    const first = await project.openRevision(1);
    const expectedId = derivePragmaResourceId("studio\0Flow\0release");

    expect(head).toMatchObject({ revision: 2 });
    expect(first.listResources()).toEqual([
      expect.objectContaining({
        apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
        metadata: expect.objectContaining({ id: expectedId }),
      }),
    ]);
    await expect(
      readFile(join(directory, "studio", "revisions", "1.json"), "utf8"),
    ).resolves.toContain('"revision": 1');
    await expect(
      readFile(join(directory, "studio", "revisions", "2.json"), "utf8"),
    ).resolves.toContain('"revision": 2');
  });

  it("migrates legacy Runtime keys and drops redundant coordinator delegation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-project-v3-team-migration-"));
    directories.push(directory);
    await seedLegacyProject(directory, [
      legacyExpertSource("cn_coding_platform", "Coding"),
      legacyExpertSource("reviewer", "Reviewer"),
      legacyRuntimeSource(),
      legacyTeamSource(),
    ]);

    const migrated = await createPragmaProjectStore({ projectsPath: directory }).get();
    const codingId = derivePragmaResourceId("studio\0Expert\0cn_coding_platform");
    const runtimeId = derivePragmaResourceId("studio\0RuntimeProfile\0desktop_runtime");
    const team = migrated.resources.find(
      (resource): resource is PragmaExpertTeamResource => resource.kind === "ExpertTeam",
    );

    expect(team?.spec.delegation.permissions.spawn).toBeUndefined();
    expect(team?.spec.delegation.runtimes).toEqual({
      [codingId]: `runtime-profile:${runtimeId}`,
    });
  });

  it("migrates host Flow layouts with the Interpreter identity mapping", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-project-v3-layout-migration-"));
    directories.push(directory);
    await seedLegacyProject(directory, [legacyFlowSource("release", "1.0.0")]);
    await mkdir(join(directory, "studio", "layouts", "legacy"), { recursive: true });
    await writeFile(
      join(directory, "studio", "layouts", "legacy", "release.json"),
      `${JSON.stringify({
        schemaVersion: "pragma.desktop-flow-layout/v1",
        flowId: "release",
        flowVersion: "1.0.0",
        viewport: { x: 1, y: 2, zoom: 1 },
      })}\n`,
    );

    await createPragmaProjectStore({ projectsPath: directory }).get();

    const flowId = derivePragmaResourceId("studio\0Flow\0release");
    const layout = JSON.parse(
      await readFile(join(directory, "studio", "layouts", "flows", `${flowId}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(layout).toMatchObject({
      schemaVersion: "pragma.desktop-flow-layout/v2",
      flowId,
      viewport: { x: 1, y: 2, zoom: 1 },
    });
    expect(layout).not.toHaveProperty("flowVersion");
  });

  it("ignores legacy Flow layouts whose v2 Flow no longer exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-project-v3-orphan-layout-migration-"));
    directories.push(directory);
    await seedLegacyProject(directory, [legacyFlowSource("release", "1.0.0")]);
    await mkdir(join(directory, "studio", "layouts", "legacy"), { recursive: true });
    await writeFile(
      join(directory, "studio", "layouts", "legacy", "untitled_flow_2.json"),
      `${JSON.stringify({
        schemaVersion: "pragma.desktop-flow-layout/v1",
        flowId: "untitled_flow_2",
        flowVersion: "1.0.0",
        viewport: { x: 1, y: 2, zoom: 1 },
      })}\n`,
    );

    const migrated = await createPragmaProjectStore({ projectsPath: directory }).get();

    expect(migrated.revision).toBe(1);
    await expect(
      readFile(
        join(
          directory,
          "studio",
          "layouts",
          "flows",
          `${derivePragmaResourceId("studio\0Flow\0untitled_flow_2")}.json`,
        ),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails a conflicting v3 migration before replacing the legacy project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-project-v3-conflict-"));
    directories.push(directory);
    await seedLegacyProject(directory, [
      legacyFlowSource("release", "1.0.0"),
      legacyFlowSource("release", "2.0.0"),
    ]);
    const project = createPragmaProjectStore({ projectsPath: directory });

    await expect(project.get()).rejects.toMatchObject({ code: "unsupported_format" });
    expect(await readFile(join(directory, "studio", "project.json"), "utf8")).toContain(
      "pragma.desktop-project/v3",
    );
  });

  it("restores the v3 backup after an interrupted migration and retries safely", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-project-v3-recovery-"));
    directories.push(directory);
    await seedLegacyProject(directory, [legacyFlowSource("release", "1.0.0")]);
    const projectPath = join(directory, "studio");
    const backupPath = `${projectPath}.v3-backup-interrupted`;
    await rename(projectPath, backupPath);
    await writeFile(
      join(directory, ".studio.v3-to-v4.json"),
      `${JSON.stringify({
        schemaVersion: "pragma.desktop-project-migration/v1",
        projectId: "studio",
        sourceSchema: "pragma.desktop-project/v3",
        targetSchema: "pragma.desktop-project/v4",
        backupPath,
      })}\n`,
    );

    const migrated = await createPragmaProjectStore({ projectsPath: directory }).get();

    expect(migrated.revision).toBe(1);
    await expect(readFile(join(directory, ".studio.v3-to-v4.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("clears the journal after a failed migration rollback so a later retry can succeed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-project-v3-retry-"));
    directories.push(directory);
    await seedLegacyProject(directory, [legacyFlowSource("release", "1.0.0")]);
    const invalidLayout = join(directory, "studio", "layouts", "invalid.json");
    await mkdir(dirname(invalidLayout), { recursive: true });
    await writeFile(invalidLayout, "not-json");

    await expect(
      createPragmaProjectStore({ projectsPath: directory }).get(),
    ).rejects.toBeInstanceOf(SyntaxError);
    await expect(readFile(join(directory, ".studio.v3-to-v4.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(directory, "studio", "project.json"), "utf8")).toContain(
      "pragma.desktop-project/v3",
    );

    await rm(invalidLayout);
    const migrated = await createPragmaProjectStore({ projectsPath: directory }).get();

    expect(migrated.revision).toBe(1);
    expect(await readFile(join(directory, "studio", "project.json"), "utf8")).toContain(
      "pragma.desktop-project/v4",
    );
  });

  it("opens only requested compiler v2 revisions through a derived view without rewriting storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-project-v4-compiler-migration-"));
    directories.push(directory);
    await seedCompilerV2ProjectRevisions(directory, 2);

    const project = createPragmaProjectStore({ projectsPath: directory });
    const head = await project.get();
    expect(
      (await readdir(join(directory, ".cache", "views"))).filter((name) =>
        name.startsWith("compiler-"),
      ),
    ).toHaveLength(1);
    const first = await project.openRevision(1);

    expect(head.revision).toBe(2);
    expect(first.listResources()).toEqual([
      expect.objectContaining({
        kind: "Flow",
        spec: expect.not.objectContaining({ runDry: expect.anything() }),
      }),
    ]);
    expect(await readFile(join(directory, "studio", "project.json"), "utf8")).toContain(
      "pragma.desktop-project/v4",
    );
    expect(await readFile(join(directory, "studio", "revisions", "1.json"), "utf8")).toContain(
      '"revision":1',
    );
    expect(await projectRevisionFile(directory, 1, "pragma.lock.yaml")).toContain(
      "compilerVersion: pragma.dsl/v2",
    );
    const compilerViews = (await readdir(join(directory, ".cache", "views"))).filter((name) =>
      name.startsWith("compiler-"),
    );
    expect(compilerViews).toHaveLength(1);
    await expect(
      readFile(join(directory, ".cache", "views", compilerViews[0]!, "pragma.lock.yaml"), "utf8"),
    ).resolves.toContain("compilerVersion: pragma.dsl/v9");
    expect((await readdir(directory)).some((name) => name.startsWith("studio.v4-backup-"))).toBe(
      false,
    );
  });

  it("writes one new v5 revision while preserving mixed v4 history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-project-mixed-storage-"));
    directories.push(directory);
    await seedCompilerV2ProjectRevisions(directory, 2);
    const firstManifestPath = join(directory, "studio", "revisions", "1.json");
    const secondManifestPath = join(directory, "studio", "revisions", "2.json");
    const firstBefore = await readFile(firstManifestPath, "utf8");
    const secondBefore = await readFile(secondManifestPath, "utf8");

    const project = createPragmaProjectStore({ projectsPath: directory });
    const head = await project.get();
    const published = await project.publish({
      expectedRevision: head.revision,
      resources: head.resources,
    });

    expect(published.revision).toBe(3);
    expect(await readFile(firstManifestPath, "utf8")).toBe(firstBefore);
    expect(await readFile(secondManifestPath, "utf8")).toBe(secondBefore);
    expect(await readFile(firstManifestPath, "utf8")).toContain("pragma.project-revision/v4");
    expect(await readFile(secondManifestPath, "utf8")).toContain("pragma.project-revision/v4");
    expect(await readFile(join(directory, "studio", "revisions", "3.json"), "utf8")).toContain(
      "pragma.project-revision/v5",
    );
    expect(await readFile(join(directory, "studio", "project.json"), "utf8")).toContain(
      "pragma.desktop-project/v5",
    );
  });

  it("rejects artifacts that collide with compiler view metadata", async () => {
    const { project } = await stores();

    await expect(
      project.publish({
        expectedRevision: 0,
        resources: [],
        artifacts: new Map([[".pragma-compiler-view", "user content"]]),
      }),
    ).rejects.toMatchObject({
      code: "project_invalid",
      message: "Project file path is reserved for checkout metadata: .pragma-compiler-view",
    });
  });

  it("reads an already-current compiler v4 revision from a v4 storage manifest without rewriting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-project-v4-current-compiler-"));
    directories.push(directory);
    const original = createPragmaProjectStore({ projectsPath: directory });
    await original.publish({
      expectedRevision: 0,
      resources: [exampleRuntime(), exampleExpert()],
    });
    const projectManifestPath = join(directory, "studio", "project.json");
    const revisionManifestPath = join(directory, "studio", "revisions", "1.json");
    const projectManifest = JSON.parse(await readFile(projectManifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    const revisionManifest = JSON.parse(await readFile(revisionManifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      projectManifestPath,
      `${JSON.stringify({ ...projectManifest, schemaVersion: "pragma.desktop-project/v4" })}\n`,
    );
    await writeFile(
      revisionManifestPath,
      `${JSON.stringify({ ...revisionManifest, schemaVersion: "pragma.project-revision/v4" })}\n`,
    );

    const migrated = await createPragmaProjectStore({ projectsPath: directory }).get();

    expect(migrated).toMatchObject({ revision: 1 });
    expect(await readFile(projectManifestPath, "utf8")).toContain("pragma.desktop-project/v4");
    expect(await projectRevisionFile(directory, 1, "pragma.lock.yaml")).toContain(
      "compilerVersion: pragma.dsl/v9",
    );
  });

  it("does not inspect or migrate revision history when the store is constructed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-project-cold-construction-"));
    directories.push(directory);
    await seedCompilerV2ProjectRevisions(directory, 2);
    const manifestPath = join(directory, "studio", "project.json");
    const manifestBefore = await readFile(manifestPath, "utf8");

    createPragmaProjectStore({ projectsPath: directory });

    await expect(readFile(manifestPath, "utf8")).resolves.toBe(manifestBefore);
    await expect(readdir(join(directory, ".cache", "views"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("scopes an invalid current revision manifest to that revision", async () => {
    const { directory, project } = await stores();
    await project.publish({
      expectedRevision: 0,
      resources: [exampleRuntime(), exampleExpert()],
    });
    await writeFile(
      join(directory, "studio", "revisions", "1.json"),
      `${JSON.stringify({
        schemaVersion: "pragma.project-revision/v5",
        projectId: "studio",
        revision: 1,
      })}\n`,
    );

    await expect(project.openRevision(1)).rejects.toMatchObject({
      code: "project_revision_unavailable",
      projectId: "studio",
      revision: 1,
      stage: "manifest",
      message: expect.stringContaining("Project revision manifest is invalid: studio@1."),
    });
  });

  it("rolls back an interrupted eager compiler migration and opens the requested revision lazily", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-project-v4-recovery-"));
    directories.push(directory);
    await seedCompilerV2ProjectRevisions(directory, 1);
    const projectPath = join(directory, "studio");
    const backupPath = `${projectPath}.v4-backup-interrupted`;
    await rename(projectPath, backupPath);
    await writeFile(
      join(directory, ".studio.v4-to-v5.json"),
      `${JSON.stringify({
        schemaVersion: "pragma.desktop-project-migration/v1",
        projectId: "studio",
        sourceSchema: "pragma.desktop-project/v4",
        targetSchema: "pragma.desktop-project/v5",
        backupPath,
      })}\n`,
    );

    const migrated = await createPragmaProjectStore({ projectsPath: directory }).get();

    expect(migrated.revision).toBe(1);
    await expect(readFile(join(directory, ".studio.v4-to-v5.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(directory, "studio", "project.json"), "utf8")).toContain(
      "pragma.desktop-project/v4",
    );
  });

  it("reports a missing interrupted-migration backup without touching unrelated storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-project-v4-missing-backup-"));
    directories.push(directory);
    await writeFile(
      join(directory, ".studio.v4-to-v5.json"),
      `${JSON.stringify({
        schemaVersion: "pragma.desktop-project-migration/v1",
        projectId: "studio",
        sourceSchema: "pragma.desktop-project/v4",
        targetSchema: "pragma.desktop-project/v5",
        backupPath: join(directory, "missing-backup"),
      })}\n`,
    );

    await expect(createPragmaProjectStore({ projectsPath: directory }).get()).rejects.toMatchObject(
      {
        code: "project_revision_unavailable",
        projectId: "studio",
        revision: 0,
        stage: "io",
      },
    );
    await expect(readFile(join(directory, ".studio.v4-to-v5.json"), "utf8")).resolves.toContain(
      "missing-backup",
    );
  });

  it("keeps the compiler v2 project untouched when its historical lock is invalid", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-project-v4-invalid-lock-"));
    directories.push(directory);
    await seedCompilerV2ProjectRevisions(directory, 1, {
      flowSource: COMPILER_V2_FLOW_SOURCE.replace("Historical Run Dry", "Tampered"),
    });

    await expect(createPragmaProjectStore({ projectsPath: directory }).get()).rejects.toMatchObject(
      {
        code: "project_revision_unavailable",
        stage: "compiler-migration",
        message: expect.stringContaining("does not match its lock"),
      },
    );
    expect(await readFile(join(directory, "studio", "project.json"), "utf8")).toContain(
      "pragma.desktop-project/v4",
    );
    await expect(readFile(join(directory, ".studio.v4-to-v5.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports current diagnostics without rejecting a valid historical compiler migration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-project-historical-diagnostics-"));
    directories.push(directory);
    await seedCompilerV2ProjectRevisions(directory, 1, {
      flowSource: COMPILER_V2_MISSING_EXPERT_FLOW_SOURCE,
      lockSource: COMPILER_V2_MISSING_EXPERT_LOCK_SOURCE,
      projectFingerprint: COMPILER_V2_MISSING_EXPERT_PROJECT_FINGERPRINT,
    });

    const snapshot = await createPragmaProjectStore({ projectsPath: directory }).get();

    expect(snapshot).toMatchObject({
      revision: 1,
      diagnostics: [
        expect.objectContaining({
          severity: "error",
          code: "reference.invalid",
          resourceRef: "flow:8h9j0k1m2n3p4q5r",
        }),
      ],
    });
    expect(await readFile(join(directory, "studio", "project.json"), "utf8")).toContain(
      "pragma.desktop-project/v4",
    );
  });

  it("materializes one compiler migration view across concurrent project stores", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-project-compiler-view-concurrent-"));
    directories.push(directory);
    await seedCompilerV2ProjectRevisions(directory, 1);
    const stores = Array.from({ length: 20 }, () =>
      createPragmaProjectStore({ projectsPath: directory }),
    );

    const snapshots = await Promise.all(stores.map(async (project) => await project.get()));

    expect(snapshots).toHaveLength(20);
    expect(snapshots.every((snapshot) => snapshot.revision === 1)).toBe(true);
    expect(
      (await readdir(join(directory, ".cache", "views"))).filter((name) =>
        name.startsWith("compiler-"),
      ),
    ).toHaveLength(1);
  });

  it("isolates an unsupported future compiler to its revision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-project-future-compiler-"));
    directories.push(directory);
    const project = createPragmaProjectStore({ projectsPath: directory });
    await project.publish({
      expectedRevision: 0,
      resources: [exampleRuntime(), exampleExpert()],
    });
    await project.publish({
      expectedRevision: 1,
      resources: [exampleRuntime(), exampleExpert(), exampleFlow()],
    });
    const firstManifestPath = join(directory, "studio", "revisions", "1.json");
    const firstManifest = JSON.parse(await readFile(firstManifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      firstManifestPath,
      `${JSON.stringify({ ...firstManifest, compilerVersion: "pragma.dsl/v999" })}\n`,
    );

    await expect(project.get()).resolves.toMatchObject({ revision: 2 });
    await expect(project.openRevision(1)).rejects.toMatchObject({
      code: "project_revision_unavailable",
      projectId: "studio",
      revision: 1,
      stage: "compiler-migration",
      sourceCompilerVersion: "pragma.dsl/v999",
    });
    await expect(project.openRevision(2)).resolves.toBeDefined();
  });

  it("materializes one cold snapshot view across concurrent project stores", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-project-view-concurrent-"));
    directories.push(directory);
    const first = createPragmaProjectStore({ projectsPath: directory });
    const published = await first.publish({
      expectedRevision: 0,
      resources: [exampleRuntime(), exampleExpert()],
    });
    const revision = JSON.parse(
      await readFile(join(directory, "studio/revisions/1.json"), "utf8"),
    ) as { readonly snapshotHash: string };
    await rm(join(directory, ".cache/views", revision.snapshotHash), {
      recursive: true,
      force: true,
    });
    const second = createPragmaProjectStore({ projectsPath: directory });

    const projects = await Promise.all(
      Array.from(
        { length: 20 },
        async (_, index) =>
          await (index % 2 === 0 ? first : second).openRevision(published.revision),
      ),
    );

    expect(projects.every((project) => project.listResources().length === 2)).toBe(true);
    await expect(
      readFile(join(directory, ".cache/views", revision.snapshotHash, ".pragma-snapshot"), "utf8"),
    ).resolves.toBe(`${revision.snapshotHash}\n`);
  });

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
    const revision = JSON.parse(
      await readFile(join(directory, "studio/revisions/1.json"), "utf8"),
    ) as { snapshotHash: string };
    expect(revision.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(directory, "studio/project.json"), "utf8")).toContain(
      '"headRevision": 1',
    );

    await expect(
      project.publish({ expectedRevision: 0, resources: [exampleRuntime(), expert] }),
    ).rejects.toMatchObject({
      code: "revision_conflict",
    } satisfies Partial<PragmaProjectStoreError>);
  });

  it("applies Flow support profiles atomically and prunes them after the last reference is removed", async () => {
    const { project } = await stores();
    const flowRuntime: PragmaRuntimeProfileResource = {
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "RuntimeProfile",
      metadata: {
        id: "w640he159ex8q8rd",
        name: "Codex Flow Runtime",
        description: "Desktop-managed Flow Runtime.",
        tags: ["desktop-managed", "flow-runtime-override"],
      },
      spec: {
        adapter: "pragma.runtime.profile@v1",
        config: { runtimeId: "codex" },
      },
    };
    const flow = exampleFlow();
    flow.spec.graph.start = "write";
    flow.spec.graph.steps = {
      write: {
        expert: { ref: "expert:1xddvess309a6gme" },
        prompt: { segments: [{ text: "Write." }] },
        runtime: {
          ref: "runtime-profile:w640he159ex8q8rd",
          modelSelection: { model: { providerId: "openai", modelId: "gpt-test" } },
        },
      },
    };
    flow.spec.graph.transitions = { write: { end: true } };

    const first = await project.apply({
      baseRevision: 0,
      upserts: [exampleRuntime(), exampleExpert(), flowRuntime, flow],
    });
    expect(first.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "RuntimeProfile",
          metadata: expect.objectContaining({ id: "w640he159ex8q8rd" }),
        }),
      ]),
    );

    delete flow.spec.graph.steps.write!.runtime;
    const second = await project.apply({
      baseRevision: first.revision,
      upserts: [flow],
    });
    expect(
      second.resources.some(
        (resource) =>
          resource.kind === "RuntimeProfile" && resource.metadata.id === "w640he159ex8q8rd",
      ),
    ).toBe(false);
  });

  it("rejects invalid cross-resource references without publishing a revision", async () => {
    const { project } = await stores();
    const flow = exampleFlow();
    flow.spec.graph.steps["write"] = {
      expert: { ref: "expert:2c2m5rysve831d7t" },
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

    const diagnostics = await project.validateChanges({
      baseRevision: 0,
      upserts: [missingRuntime],
    });
    expect(diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: "Runtime is required." })]),
    );
    await expect(
      project.apply({ baseRevision: 0, upserts: [missingRuntime] }),
    ).rejects.toMatchObject({ code: "project_invalid" });
    expect((await project.get()).revision).toBe(0);

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
      expert: { ref: "expert:2c2m5rysve831d7t" },
    };
    candidate.spec.graph.transitions["write"] = { end: true };

    const result = await project.validateCandidate({ baseRevision: 1, resource: candidate });

    expect(result.resource).toEqual(candidate);
    expect(result.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
    expect((await project.get()).revision).toBe(1);
  });

  it("backs the Desktop expert form with YAML resources and no JSON migration path", async () => {
    const { directory, experts } = await stores();
    const created = await experts.create({
      baseRevision: 0,
      requiredUnchangedRefs: [],
      avatarId: "pragma.avatar.expert.writer",
      name: "Writer",
      description: "Writes release notes",
      tags: ["writing"],
      scope: "Release communication",
      instructions: "Write verified release notes.",
      model: { runtimeId: "codex", providerId: "openai", modelId: "gpt-test" },
      capabilities: [],
      contextStoreMounts: [],
      plugins: [],
      toolApprovals: {},
    });
    expect(created.id).toMatch(/^[0-9a-hjkmnp-tv-z]{16}$/);
    expect(created.avatarId).toBe("pragma.avatar.expert.writer");
    expect(await experts.list()).toHaveLength(3);
    const opened = await projectRevisionFile(directory, 1, `experts/${created.id}.pragma.yaml`);
    expect(opened).toContain("scope: Release communication");
    expect(opened).toContain("avatarId: pragma.avatar.expert.writer");

    const updated = await experts.update(
      created.ref,
      expertUpdate(created, "Writes verified release notes for customers"),
    );
    expect(updated.avatarId).toBe("pragma.avatar.expert.writer");
  });

  it("preserves project-local artifacts when the Desktop form publishes a later revision", async () => {
    const { directory, project, experts } = await stores();
    await project.publish({
      expectedRevision: 0,
      resources: [],
      artifacts: new Map([["assets/guide.md", "# Project guide\n"]]),
    });
    await experts.create({
      baseRevision: 1,
      requiredUnchangedRefs: [],
      name: "Writer",
      description: "Writes release notes",
      tags: ["writing"],
      scope: "Release communication",
      instructions: "Write verified release notes.",
      model: { runtimeId: "codex", providerId: "openai", modelId: "gpt-test" },
      capabilities: [],
      contextStoreMounts: [],
      plugins: [],
      toolApprovals: {},
    });

    await expect(projectRevisionFile(directory, 2, "assets/guide.md")).resolves.toBe(
      "# Project guide\n",
    );
  });

  it("blocks deletion of referenced Experts and every write path for system Experts", async () => {
    const { project, experts } = await stores();
    const flow = exampleFlow();
    flow.spec.graph.steps["finish"] = {
      expert: { ref: "expert:1xddvess309a6gme" },
    };
    await project.publish({
      expectedRevision: 0,
      resources: [exampleRuntime(), exampleExpert(), flow],
    });

    await expect(experts.remove("expert:1xddvess309a6gme")).rejects.toMatchObject({
      code: "expert_referenced",
    });
    await expect(
      project.upsert({ baseRevision: 1, resource: builtInAgentResource(BUILT_IN_PRAGMA_REF) }),
    ).rejects.toMatchObject({ code: "built_in_readonly" });
    await expect(experts.remove(BUILT_IN_PRAGMA_REF)).rejects.toMatchObject({
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
      id: "n37vf3n8d5g3j195",
      name: "Team consumer",
    };
    teamConsumer.spec.graph.steps["finish"] = {
      team: { ref: "team:p8cbn3cg2avyksn4" },
    };
    const child = exampleFlow();
    child.metadata = { ...child.metadata, id: "ceq0qxcgdv75wg6b", name: "Child flow" };
    const parent = exampleFlow();
    parent.metadata = { ...parent.metadata, id: "3th2yww0c5q3m65t", name: "Parent flow" };
    parent.spec.graph.steps["finish"] = {
      flow: { ref: "flow:ceq0qxcgdv75wg6b" },
    };
    await project.publish({
      expectedRevision: 0,
      resources: [exampleRuntime(), exampleExpert(), team, teamConsumer, child, parent],
    });

    await expect(
      project.remove({ baseRevision: 1, ref: "team:p8cbn3cg2avyksn4" }),
    ).rejects.toMatchObject({
      code: "resource_referenced",
      referencedBy: [{ ref: "flow:n37vf3n8d5g3j195", name: "Team consumer" }],
    });
    await expect(
      project.remove({ baseRevision: 1, ref: "flow:ceq0qxcgdv75wg6b" }),
    ).rejects.toMatchObject({
      code: "resource_referenced",
      referencedBy: [{ ref: "flow:3th2yww0c5q3m65t", name: "Parent flow" }],
    });
    expect((await project.get()).revision).toBe(1);
  });

  it("blocks deletion of an executor referenced by an Automation", async () => {
    const { project } = await stores();
    await project.publish({
      expectedRevision: 0,
      resources: [exampleRuntime(), exampleExpert(), exampleAutomation()],
    });

    await expect(
      project.remove({ baseRevision: 1, ref: "expert:1xddvess309a6gme" }),
    ).rejects.toMatchObject({ code: "resource_referenced" });
    expect((await project.get()).revision).toBe(1);
  });

  it("creates an independent Evaluation and protects its target Flow", async () => {
    const { project } = await stores();
    const flow = exampleFlow();
    const evaluation: PragmaEvaluationResource = {
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Evaluation",
      metadata: {
        id: "7h8j9k0m1n2p3q4r",
        name: "Release Run Dry",
        description: "Tests the release flow.",
        tags: ["run-dry"],
      },
      spec: {
        target: { ref: `flow:${flow.metadata.id}` },
        method: {
          type: "flow-run-dry",
          cases: [
            {
              id: "finish",
              name: "Finish",
              input: {},
              mocks: { finish: { expectInput: {}, output: { ok: true } } },
              expect: { status: "succeeded", path: ["finish"], output: { ok: true } },
            },
          ],
        },
      },
    };

    const published = await project.publish({
      expectedRevision: 0,
      resources: [flow, evaluation],
    });

    expect(published.resources.map((resource) => resource.kind)).toContain("Evaluation");
    await expect(
      project.remove({ baseRevision: published.revision, ref: `flow:${flow.metadata.id}` }),
    ).rejects.toMatchObject({
      code: "resource_referenced",
      message:
        "This resource is used by another Expert, Expert Team, Flow, or Evaluation. Remove those dependencies before deleting it.",
      referencedBy: [{ ref: "evaluation:7h8j9k0m1n2p3q4r", name: "Release Run Dry" }],
    });
  });

  it("ignores an unpublished legacy revision directory", async () => {
    const { directory, project } = await stores();
    const orphan = join(directory, "studio/revisions/1");
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "orphan.txt"), "incomplete");

    const published = await project.publish({
      expectedRevision: 0,
      resources: [exampleRuntime(), exampleExpert()],
    });

    expect(published.revision).toBe(1);
    await expect(readFile(join(orphan, "orphan.txt"), "utf8")).resolves.toBe("incomplete");
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

  it("rebases stale changes when another project revision changed a different Flow", async () => {
    const { project } = await stores();
    const release = exampleFlow();
    const delivery = exampleFlow("delivery");
    const initial = await project.publish({
      expectedRevision: 0,
      resources: [release, delivery],
    });

    delivery.metadata.description = "Changed by a background Mission";
    const background = await project.apply({
      baseRevision: initial.revision,
      upserts: [delivery],
    });
    release.metadata.description = "Changed in the Flow editor";

    await expect(
      project.validateChanges({
        baseRevision: initial.revision,
        upserts: [release],
      }),
    ).resolves.toEqual([]);
    const saved = await project.apply({
      baseRevision: initial.revision,
      upserts: [release],
    });

    expect(saved.revision).toBe(background.revision + 1);
    expect(
      saved.resources
        .filter((resource) => resource.kind === "Flow")
        .map((resource) => [resource.metadata.id, resource.metadata.description]),
    ).toEqual(
      expect.arrayContaining([
        ["t1e73vjvctx49gkq", "Changed in the Flow editor"],
        ["ceq0qxcgdv75wg6b", "Changed by a background Mission"],
      ]),
    );
  });

  it("serializes concurrent changes to different Flows by rebasing the losing writer", async () => {
    const { directory, project } = await stores();
    const release = exampleFlow();
    const delivery = exampleFlow("delivery");
    const initial = await project.publish({
      expectedRevision: 0,
      resources: [release, delivery],
    });
    const background = createPragmaProjectStore({ projectsPath: directory });
    release.metadata.description = "Changed in the Flow editor";
    delivery.metadata.description = "Changed by a background Mission";

    const [foregroundResult, backgroundResult] = await Promise.all([
      project.apply({ baseRevision: initial.revision, upserts: [release] }),
      background.apply({ baseRevision: initial.revision, upserts: [delivery] }),
    ]);

    expect(new Set([foregroundResult.revision, backgroundResult.revision])).toEqual(
      new Set([initial.revision + 1, initial.revision + 2]),
    );
    const saved = await project.get();
    expect(saved.revision).toBe(initial.revision + 2);
    expect(
      saved.resources
        .filter((resource) => resource.kind === "Flow")
        .map((resource) => [resource.metadata.id, resource.metadata.description]),
    ).toEqual(
      expect.arrayContaining([
        ["t1e73vjvctx49gkq", "Changed in the Flow editor"],
        ["ceq0qxcgdv75wg6b", "Changed by a background Mission"],
      ]),
    );
  });

  it("reports the exact Flow ref when stale changes overlap", async () => {
    const { project } = await stores();
    const release = exampleFlow();
    const initial = await project.publish({ expectedRevision: 0, resources: [release] });
    const background = structuredClone(release);
    background.metadata.description = "Changed by a background Mission";
    await project.apply({
      baseRevision: initial.revision,
      upserts: [background],
    });
    release.metadata.description = "Changed in the Flow editor";

    const expectedConflict = {
      code: "revision_conflict",
      conflict: {
        baseRevision: initial.revision,
        currentRevision: initial.revision + 1,
        conflictingRefs: ["flow:t1e73vjvctx49gkq"],
        retryable: false,
      },
    } satisfies Partial<PragmaProjectStoreError>;
    await expect(
      project.validateChanges({
        baseRevision: initial.revision,
        upserts: [release],
      }),
    ).rejects.toMatchObject(expectedConflict);
    await expect(
      project.apply({
        baseRevision: initial.revision,
        upserts: [release],
      }),
    ).rejects.toMatchObject(expectedConflict);
  });

  it("rebases stale changes to different Expert Teams and conflicts on the same Team", async () => {
    const { project } = await stores();
    const reviewers = exampleTeam();
    const publishers = exampleTeam("publishers");
    const initial = await project.publish({
      expectedRevision: 0,
      resources: [exampleRuntime(), exampleExpert(), reviewers, publishers],
    });

    publishers.metadata.description = "Changed by a background Mission";
    await project.apply({
      baseRevision: initial.revision,
      upserts: [publishers],
    });
    reviewers.metadata.description = "Changed in the Team editor";
    const saved = await project.apply({
      baseRevision: initial.revision,
      upserts: [reviewers],
    });

    expect(
      saved.resources
        .filter((resource) => resource.kind === "ExpertTeam")
        .map((resource) => [resource.metadata.id, resource.metadata.description]),
    ).toEqual(
      expect.arrayContaining([
        ["p8cbn3cg2avyksn4", "Changed in the Team editor"],
        ["r8ggx4n4219hrc2p", "Changed by a background Mission"],
      ]),
    );

    const staleReviewers = structuredClone(reviewers);
    staleReviewers.metadata.description = "Another foreground edit";
    await expect(
      project.apply({
        baseRevision: initial.revision,
        upserts: [staleReviewers],
      }),
    ).rejects.toMatchObject({
      code: "revision_conflict",
      conflict: {
        baseRevision: initial.revision,
        currentRevision: initial.revision + 2,
        conflictingRefs: ["team:p8cbn3cg2avyksn4"],
        retryable: false,
      },
    } satisfies Partial<PragmaProjectStoreError>);
  });

  it("rebases stale edits to different Experts and conflicts on the same Expert", async () => {
    const { project, experts } = await stores();
    const initial = await project.publish({
      expectedRevision: 0,
      resources: [
        exampleRuntime(),
        exampleExpert(),
        exampleRuntime("reviewer"),
        exampleExpert("reviewer"),
      ],
    });
    const writer = await experts.get("expert:1xddvess309a6gme");
    const reviewer = await experts.get("expert:3sfd30h5017wd17d");

    await experts.update(reviewer.ref, expertUpdate(reviewer, "Changed by a background Mission"));
    const savedWriter = await experts.update(
      writer.ref,
      expertUpdate(writer, "Changed in the Expert editor"),
    );

    expect(savedWriter.description).toBe("Changed in the Expert editor");
    const saved = await project.get();
    expect(saved.revision).toBe(initial.revision + 2);
    expect(
      saved.resources
        .filter((resource) => resource.kind === "Expert")
        .map((resource) => [resource.metadata.id, resource.metadata.description]),
    ).toEqual(
      expect.arrayContaining([
        ["1xddvess309a6gme", "Changed in the Expert editor"],
        ["3sfd30h5017wd17d", "Changed by a background Mission"],
      ]),
    );

    await expect(
      experts.update(writer.ref, expertUpdate(writer, "Another foreground edit")),
    ).rejects.toMatchObject({
      code: "revision_conflict",
      conflict: {
        baseRevision: writer.revision,
        currentRevision: initial.revision + 2,
        conflictingRefs: ["expert:1xddvess309a6gme"],
        retryable: false,
      },
    } satisfies Partial<PragmaProjectStoreError>);
  });

  it("reuses migrated desktop Capability identities when an Expert adds a skill", async () => {
    const { project, experts } = await stores();
    const existingCapabilityId = "009405fc-3ade-4df2-8e4b-eccab29e78c4";
    const removedCapabilityId = "15ce47d6-217c-44b1-a830-61b086e8c61a";
    const addedCapabilityId = "40bb8846-dba0-4662-9fd0-9e5d865741c8";
    const migratedResourceId = derivePragmaResourceId(
      `studio\0Capability\0capability_${existingCapabilityId.replaceAll("-", "")}`,
    );
    const optionResourceId = derivePragmaResourceId(
      `default-agent:capability:${existingCapabilityId}`,
    );
    const removedResourceId = derivePragmaResourceId(
      `studio\0Capability\0capability_${removedCapabilityId.replaceAll("-", "")}`,
    );
    const writer = exampleExpert();
    const reviewer = exampleExpert("reviewer");
    writer.spec.capabilities = [
      { ref: `capability:${migratedResourceId}`, kind: "skill" },
      { ref: `capability:${removedResourceId}`, kind: "tools", tools: ["run"] },
    ];
    reviewer.spec.capabilities = [{ ref: `capability:${migratedResourceId}`, kind: "skill" }];
    await project.publish({
      expectedRevision: 0,
      resources: [
        exampleRuntime(),
        writer,
        exampleRuntime("reviewer"),
        reviewer,
        desktopManagedCapability(existingCapabilityId, optionResourceId, {
          name: "aone-km",
          tags: ["desktop-managed", "default-agent-option"],
          revision: 2,
        }),
        desktopManagedCapability(existingCapabilityId, migratedResourceId),
        desktopManagedCapability(removedCapabilityId, removedResourceId),
      ],
    });
    const opened = await experts.get("expert:1xddvess309a6gme");

    const saved = await experts.update(opened.ref, {
      ...expertUpdate(opened, "Adds a newly installed skill"),
      capabilities: [
        ...opened.capabilities.filter(
          (capability) => capability.capabilityId !== removedCapabilityId,
        ),
        { kind: "skill", capabilityId: addedCapabilityId, revision: 1 },
      ],
    });

    expect(saved.capabilities).toEqual([
      { kind: "skill", capabilityId: existingCapabilityId, revision: 1 },
      { kind: "skill", capabilityId: addedCapabilityId, revision: 1 },
    ]);
    await expect(experts.get("expert:3sfd30h5017wd17d")).resolves.toMatchObject({
      capabilities: [{ kind: "skill", capabilityId: existingCapabilityId, revision: 1 }],
    });
    const resources = (await project.get()).resources;
    expect(
      resources.filter(
        (resource) =>
          resource.kind === "Capability" &&
          resource.metadata.name === `Capability ${existingCapabilityId}`,
      ),
    ).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ id: migratedResourceId }) }),
    ]);
    expect(resources).toContainEqual(
      expect.objectContaining({
        kind: "Capability",
        metadata: expect.objectContaining({ id: optionResourceId, name: "aone-km" }),
      }),
    );
    expect(resources).toContainEqual(
      expect.objectContaining({
        kind: "Capability",
        metadata: expect.objectContaining({
          id: derivePragmaResourceId(`desktop-managed:capability:${addedCapabilityId}`),
          name: `Capability ${addedCapabilityId}`,
        }),
      }),
    );
    expect(resources.some((resource) => resource.metadata.id === removedResourceId)).toBe(false);
  });

  it("uses the exact Default Agent Capability option when creating an Expert", async () => {
    const { project, experts } = await stores();
    const existingCapabilityId = "009405fc-3ade-4df2-8e4b-eccab29e78c4";
    const addedCapabilityId = "40bb8846-dba0-4662-9fd0-9e5d865741c8";
    const migratedResourceId = derivePragmaResourceId(
      `studio\0Capability\0capability_${existingCapabilityId.replaceAll("-", "")}`,
    );
    const optionResourceId = derivePragmaResourceId(
      `default-agent:capability:${existingCapabilityId}`,
    );
    const writer = exampleExpert();
    writer.spec.capabilities = [{ ref: `capability:${migratedResourceId}`, kind: "skill" }];
    await project.publish({
      expectedRevision: 0,
      resources: [
        exampleRuntime(),
        writer,
        desktopManagedCapability(existingCapabilityId, migratedResourceId),
        desktopManagedCapability(existingCapabilityId, optionResourceId, {
          name: "aone-km",
          tags: ["desktop-managed", "default-agent-option"],
          revision: 2,
        }),
      ],
    });

    const created = await experts.create({
      baseRevision: 1,
      requiredUnchangedRefs: [],
      name: "Reviewer",
      description: "Reviews changes with shared guidance.",
      tags: ["review"],
      scope: "Review code changes.",
      instructions: "Review the requested changes.",
      model: { runtimeId: "codex", providerId: "openai", modelId: "gpt-test" },
      capabilities: [
        { kind: "skill", capabilityId: existingCapabilityId, revision: 2 },
        { kind: "skill", capabilityId: addedCapabilityId, revision: 1 },
      ],
      contextStoreMounts: [],
      plugins: [],
      toolApprovals: {},
    });

    expect(created.capabilities).toHaveLength(2);
    const resources = (await project.get()).resources;
    expect(
      resources.filter(
        (resource) =>
          resource.kind === "Capability" &&
          resource.metadata.name === `Capability ${existingCapabilityId}`,
      ),
    ).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ id: migratedResourceId }) }),
    ]);
    expect(
      resources.find(
        (resource) => resource.kind === "Expert" && resource.metadata.id === created.id,
      ),
    ).toMatchObject({
      spec: {
        capabilities: [
          { ref: `capability:${optionResourceId}`, kind: "skill" },
          {
            ref: `capability:${derivePragmaResourceId(
              `desktop-managed:capability:${addedCapabilityId}`,
            )}`,
            kind: "skill",
          },
        ],
      },
    });
  });

  it("reuses the ContextStore resource referenced by the current Expert", async () => {
    const { project, experts } = await stores();
    const storeId = "3ffca805-d1f0-446c-a113-4dd33f226d35";
    const migratedResourceId = derivePragmaResourceId(
      `studio\0ContextStore\0context_${storeId.replaceAll("-", "")}`,
    );
    const writer = exampleExpert();
    const reviewer = exampleExpert("reviewer");
    writer.spec.contextStores = [
      {
        ref: `context-store:${migratedResourceId}`,
        namespace: migratedResourceId,
        required: true,
      },
    ];
    reviewer.spec.contextStores = [
      {
        ref: `context-store:${migratedResourceId}`,
        namespace: migratedResourceId,
        required: true,
      },
    ];
    await project.publish({
      expectedRevision: 0,
      resources: [
        exampleRuntime(),
        writer,
        exampleRuntime("reviewer"),
        reviewer,
        desktopManagedContextStore(storeId, migratedResourceId),
      ],
    });
    const opened = await experts.get("expert:1xddvess309a6gme");

    const saved = await experts.update(
      opened.ref,
      expertUpdate(opened, "Keeps the migrated ContextStore identity"),
    );

    expect(saved.contextStoreMounts).toEqual([{ storeId, enabled: true, priority: 0 }]);
    await expect(experts.get("expert:3sfd30h5017wd17d")).resolves.toMatchObject({
      contextStoreMounts: [{ storeId, enabled: true, priority: 0 }],
    });
    const resources = (await project.get()).resources;
    expect(
      resources.filter(
        (resource) =>
          resource.kind === "ContextStore" && resource.metadata.name === `Context ${storeId}`,
      ),
    ).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ id: migratedResourceId }) }),
    ]);
    expect(
      resources.find(
        (resource) => resource.kind === "Expert" && resource.metadata.id === writer.metadata.id,
      ),
    ).toMatchObject({
      spec: {
        contextStores: [
          {
            ref: `context-store:${migratedResourceId}`,
            namespace: migratedResourceId,
            required: true,
          },
        ],
      },
    });
  });

  it("does not create a revision for an identical snapshot", async () => {
    const { directory, project } = await stores();
    const resources = [exampleRuntime(), exampleExpert()];
    const first = await project.publish({ expectedRevision: 0, resources });
    const second = await project.publish({ expectedRevision: 1, resources });

    expect(second.revision).toBe(first.revision);
    await expect(
      readFile(join(directory, "studio", "revisions", "2.json"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reads and preserves portable Expert capabilities and context stores", async () => {
    const { project, experts } = await stores();
    const expert = exampleExpert();
    expert.spec.runtime = { ref: "runtime-profile:20k21q9j9wexjv50" };
    expert.spec.capabilities = [{ ref: "capability:nv27faxmxpqnxwqr", kind: "skill" }];
    expert.spec.contextStores = [
      { ref: "context-store:1ymdp8c7rvxs4d3v", namespace: "project_docs", required: true },
    ];
    await project.publish({
      expectedRevision: 0,
      resources: [remoteRuntime(), portableCapability(), portableContextStore(), expert],
    });

    const view = await experts.get("expert:1xddvess309a6gme");
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
    expect(view.contextStoreMounts).toEqual([]);
    expect(view.opaqueContextStores).toEqual(expert.spec.contextStores);
    await experts.update("expert:1xddvess309a6gme", {
      baseRevision: view.revision,
      name: view.name,
      description: "Updated without losing portable fields",
      tags: view.tags,
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
      opaqueContextStores: view.opaqueContextStores,
    });

    const stored = (await project.get()).resources.find(
      (resource) => resource.kind === "Expert" && resource.metadata.id === "1xddvess309a6gme",
    );
    expect(stored?.kind === "Expert" ? stored.spec.runtime : undefined).toEqual({
      ref: "runtime-profile:20k21q9j9wexjv50",
    });
    expect(stored?.kind === "Expert" ? stored.spec.capabilities : undefined).toEqual(
      expert.spec.capabilities,
    );
    expect(stored?.kind === "Expert" ? stored.spec.contextStores : undefined).toEqual(
      expert.spec.contextStores,
    );
  });
});

function exampleExpert(id = "writer"): PragmaExpertResource {
  const resourceId = id === "writer" ? "1xddvess309a6gme" : "3sfd30h5017wd17d";
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Expert",
    metadata: {
      id: resourceId,
      avatarId: "pragma.avatar.expert.default",
      name: id === "writer" ? "Writer" : "Reviewer",
      description: "Writes release notes",
      tags: [],
    },
    spec: {
      scope: "Release communication",
      instructions: "Write verified release notes.",
      runtime: {
        ref:
          id === "writer" ? "runtime-profile:zdkgs0fde4xt00vr" : "runtime-profile:v3b460tasfhyf22d",
      },
      capabilities: [],
      toolApprovals: {},
      contextStores: [],
      plugins: [],
      tools: [],
    },
  };
}

function exampleRuntime(expertId = "writer"): PragmaRuntimeProfileResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "RuntimeProfile",
    metadata: {
      id: expertId === "writer" ? "zdkgs0fde4xt00vr" : "v3b460tasfhyf22d",
      name: `${expertId === "writer" ? "Writer" : "Reviewer"} Runtime`,
      description: "Writer runtime profile.",
      tags: ["desktop-managed"],
    },
    spec: {
      adapter: "pragma.runtime.profile@v1",
      config: { runtimeId: "codex", providerId: "openai", model: "gpt-test" },
    },
  };
}

function exampleTeam(id = "reviewers"): PragmaExpertTeamResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "ExpertTeam",
    metadata: {
      id: id === "reviewers" ? "p8cbn3cg2avyksn4" : "r8ggx4n4219hrc2p",
      avatarId: "pragma.avatar.team.default",
      name: id === "reviewers" ? "Reviewers" : "Publishers",
      description: "Coordinates review work.",
      tags: [],
    },
    spec: {
      coordinator: { ref: "expert:1xddvess309a6gme" },
      members: [{ ref: "expert:1xddvess309a6gme" }],
      contextStores: [],
      delegation: {
        permissions: { interact: {} },
        maxConcurrency: 2,
        maxDepth: 2,
        runtimes: {},
      },
    },
  };
}

function remoteRuntime(): PragmaRuntimeProfileResource {
  return {
    ...exampleRuntime(),
    metadata: { ...exampleRuntime().metadata, id: "20k21q9j9wexjv50", name: "Remote Runtime" },
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
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
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

function desktopManagedCapability(
  capabilityId: string,
  resourceId: string,
  metadata: {
    readonly name?: string;
    readonly tags?: string[];
    readonly revision?: number;
  } = {},
): PragmaCapabilityResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Capability",
    metadata: {
      id: resourceId,
      name: metadata.name ?? `Capability ${capabilityId}`,
      description: "Desktop-managed capability binding.",
      tags: metadata.tags ?? ["desktop-managed"],
    },
    spec: {
      adapter: "pragma.capability.host@v1",
      binding: desktopCapabilityBindingRef(capabilityId, metadata.revision ?? 1),
      config: { key: capabilityId },
    },
  };
}

function desktopManagedContextStore(
  storeId: string,
  resourceId: string,
): PragmaContextStoreResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "ContextStore",
    metadata: {
      id: resourceId,
      name: `Context ${storeId}`,
      description: "Desktop-managed context store binding.",
      tags: ["desktop-managed"],
    },
    spec: {
      adapter: "pragma.context.host@v1",
      binding: desktopContextBindingRef(storeId),
      config: { key: storeId },
    },
  };
}

function portableContextStore(): PragmaContextStoreResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "ContextStore",
    metadata: {
      id: "1ymdp8c7rvxs4d3v",
      name: "Portable context",
      description: "Portable project context.",
      tags: [],
    },
    spec: {
      adapter: "pragma.context.static@v1",
      config: { entries: [] },
    },
  };
}

function exampleFlow(id = "release"): PragmaFlowResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Flow",
    metadata: {
      id: id === "release" ? "t1e73vjvctx49gkq" : "ceq0qxcgdv75wg6b",
      name: id === "release" ? "Release" : "Delivery",
      description: "Build release notes",
      tags: [],
    },
    spec: {
      limits: { maxNodeVisits: 100 },
      graph: {
        start: "finish",
        steps: {
          finish: { action: { ref: "action:finish@v1" } },
        },
        loops: {},
        transitions: { finish: { end: true } },
      },
    },
  };
}

function exampleAutomation(): PragmaAutomationResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Automation",
    metadata: {
      id: "hrxn3mv2e991j2rj",
      name: "Daily review",
      description: "Runs the writer every day",
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
        executor: { ref: "expert:1xddvess309a6gme" },
        input: { kind: "prompt", value: "Review the current work." },
      },
      interaction: { mode: "reuse-session" },
      delivery: { adapter: "pragma.automation.delivery.local@v1" },
    },
  };
}

function expertUpdate(definition: ExpertDefinition, description: string): UpdateExpertDefinition {
  if (definition.executionProfile.mode !== "pinned") {
    throw new Error("Project Expert must use a pinned model.");
  }
  return {
    baseRevision: definition.revision,
    name: definition.name,
    description,
    tags: definition.tags,
    scope: definition.scope,
    instructions: definition.instructions,
    model: definition.executionProfile.model,
    capabilities: definition.capabilities,
    toolApprovals: definition.toolApprovals,
    plugins: definition.plugins,
    contextStoreMounts: definition.contextStoreMounts,
    resourceTools: definition.resourceTools,
    opaqueCapabilities: definition.opaqueCapabilities,
    opaqueContextStores: definition.opaqueContextStores,
  };
}

async function seedLegacyProject(directory: string, sources: readonly string[]): Promise<void> {
  await seedLegacyProjectRevisions(directory, [sources]);
}

const COMPILER_V2_FLOW_SOURCE = `apiVersion: pragma/v3
kind: Flow
metadata:
  id: 8h9j0k1m2n3p4q5r
  name: Historical Run Dry
  description: Compiler v2 fixture with the removed runDry branch.
  tags: []
spec:
  limits:
    maxNodeVisits: 1000
  graph:
    start: finish
    steps:
      finish:
        action:
          ref: action:finish@v1
    loops: {}
    transitions:
      finish:
        end: true
  runDry:
    cases: []
`;

const COMPILER_V2_ENTRY_SOURCE = `apiVersion: pragma/v3
kind: Bundle
imports:
  - ./flows/8h9j0k1m2n3p4q5r.pragma.yaml
resources: []
`;

const COMPILER_V2_LOCK_SOURCE = `apiVersion: pragma/v3
kind: Lock
compilerVersion: pragma.dsl/v2
projectFingerprint: 33e69dc432c7d321b1a0280144bdab0105b82a8f9270bf7067871dfc7f966ff8
resources:
  - ref: flow:8h9j0k1m2n3p4q5r
    contentHash: eec635492a253e33328ae04586548877b5e4631d56b8723d950aa4db0b7aaa4c
    source: flows/8h9j0k1m2n3p4q5r.pragma.yaml
artifacts: []
`;

const COMPILER_V2_MISSING_EXPERT_FLOW_SOURCE = `apiVersion: pragma/v3
kind: Flow
metadata:
  id: 8h9j0k1m2n3p4q5r
  name: Historical Missing Expert
  description: Compiler v2 fixture with current semantic diagnostics.
  tags: []
spec:
  limits:
    maxNodeVisits: 1000
  graph:
    start: finish
    steps:
      finish:
        expert:
          ref: expert:1xddvess309a6gme
        prompt:
          segments:
            - text: Review the historical revision.
    loops: {}
    transitions:
      finish:
        end: true
  runDry:
    cases: []
`;

const COMPILER_V2_MISSING_EXPERT_PROJECT_FINGERPRINT =
  "fb76fac3a3898599bf250173f46206864b3827294240227995ce2fbbce3d6950";

const COMPILER_V2_MISSING_EXPERT_LOCK_SOURCE = `apiVersion: pragma/v3
kind: Lock
compilerVersion: pragma.dsl/v2
projectFingerprint: ${COMPILER_V2_MISSING_EXPERT_PROJECT_FINGERPRINT}
resources:
  - ref: flow:8h9j0k1m2n3p4q5r
    contentHash: 1231764fa7640e110838cc4eaf43b9d11af94fdb3dd3ccbf3cd580a183c13013
    source: flows/8h9j0k1m2n3p4q5r.pragma.yaml
artifacts: []
`;

async function seedCompilerV2ProjectRevisions(
  directory: string,
  revisionCount: number,
  overrides: {
    readonly flowSource?: string;
    readonly lockSource?: string;
    readonly projectFingerprint?: string;
  } = {},
): Promise<void> {
  const objects = new ContentAddressedStore(join(directory, ".storage", "objects"));
  const createdAt = "2026-07-29T00:00:00.000Z";
  await mkdir(join(directory, "studio", "revisions"), { recursive: true });
  await writeFile(
    join(directory, "studio", "project.json"),
    `${JSON.stringify({
      schemaVersion: "pragma.desktop-project/v4",
      projectId: "studio",
      headRevision: revisionCount,
      updatedAt: createdAt,
    })}\n`,
  );
  for (let revision = 1; revision <= revisionCount; revision += 1) {
    const snapshot = await objects.putSnapshot(
      new Map([
        ["pragma.yaml", Buffer.from(COMPILER_V2_ENTRY_SOURCE, "utf8")],
        ["pragma.lock.yaml", Buffer.from(overrides.lockSource ?? COMPILER_V2_LOCK_SOURCE, "utf8")],
        [
          "flows/8h9j0k1m2n3p4q5r.pragma.yaml",
          Buffer.from(overrides.flowSource ?? COMPILER_V2_FLOW_SOURCE, "utf8"),
        ],
      ]),
    );
    await writeFile(
      join(directory, "studio", "revisions", `${revision}.json`),
      `${JSON.stringify({
        schemaVersion: "pragma.project-revision/v4",
        projectId: "studio",
        revision,
        ...(revision === 1 ? {} : { parentRevision: revision - 1 }),
        snapshotHash: snapshot.root.hash,
        projectFingerprint:
          overrides.projectFingerprint ??
          "33e69dc432c7d321b1a0280144bdab0105b82a8f9270bf7067871dfc7f966ff8",
        compilerVersion: "pragma.dsl/v2",
        createdAt,
      })}\n`,
    );
  }
}

async function seedLegacyProjectRevisions(
  directory: string,
  revisions: readonly (readonly string[])[],
): Promise<void> {
  const objects = new ContentAddressedStore(join(directory, ".storage", "objects"));
  await mkdir(join(directory, "studio", "revisions"), { recursive: true });
  await writeFile(
    join(directory, "studio", "project.json"),
    `${JSON.stringify({
      schemaVersion: "pragma.desktop-project/v3",
      projectId: "studio",
      headRevision: revisions.length,
    })}\n`,
  );
  for (const [revisionIndex, sources] of revisions.entries()) {
    const files = new Map<string, Uint8Array>(
      sources.map((source, sourceIndex) => [
        `flows/release@${sourceIndex + 1}.pragma.yaml`,
        Buffer.from(source, "utf8"),
      ]),
    );
    const snapshot = await objects.putSnapshot(files);
    await writeFile(
      join(directory, "studio", "revisions", `${revisionIndex + 1}.json`),
      `${JSON.stringify({
        schemaVersion: "pragma.project-revision/v3",
        snapshotHash: snapshot.root.hash,
      })}\n`,
    );
  }
}

function legacyFlowSource(id: string, version: string): string {
  return `apiVersion: pragma/v2
kind: Flow
metadata:
  id: ${id}
  version: ${version}
  name: Release
  description: Builds a release
  tags: []
spec:
  limits:
    maxNodeVisits: 10
  graph:
    start: finish
    steps:
      finish:
        action:
          ref: action:finish@v1
        version: 1.0.0
    loops: {}
    transitions:
      finish:
        end: true
`;
}

function legacyExpertSource(id: string, name: string): string {
  return `apiVersion: pragma/v2
kind: Expert
metadata:
  id: ${id}
  version: 1.0.0
  name: ${name}
  description: Legacy ${name} expert
  tags: []
spec:
  scope: Work on ${name} tasks.
  instructions: Complete the assigned work.
  capabilities: []
  toolApprovals: {}
  contextStores: []
  plugins: []
  tools: []
`;
}

function legacyTeamSource(): string {
  return `apiVersion: pragma/v2
kind: ExpertTeam
metadata:
  id: coding_team
  version: 1.0.0
  name: Coding Team
  description: Legacy coding team
  tags: []
spec:
  coordinator:
    ref: expert:cn_coding_platform@1.0.0
  members:
    - ref: expert:reviewer@1.0.0
  delegation:
    allow:
      cn_coding_platform: [reviewer]
    maxConcurrency: 2
    maxDepth: 2
    context: context-policy:pragma.fresh@v1
    runtimes:
      cn_coding_platform: runtime-profile:desktop_runtime@1.0.0
`;
}

function legacyRuntimeSource(): string {
  return `apiVersion: pragma/v2
kind: RuntimeProfile
metadata:
  id: desktop_runtime
  version: 1.0.0
  name: Desktop Runtime
  description: Legacy Desktop Runtime profile
  tags: []
spec:
  adapter: pragma.runtime.profile@v1
  config:
    runtimeId: codex
    providerId: openai
    model: gpt-test
`;
}
