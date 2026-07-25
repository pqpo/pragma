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
} from "@pragma/interpreter/ast";
import { afterEach, describe, expect, it } from "vitest";
import { BUILT_IN_PRAGMA_REF, builtInPragmaResource } from "@pragma/default-agent";
import { ContentAddressedStore, derivePragmaResourceId } from "@pragma/core";

import type { ExpertDefinition, UpdateExpertDefinition } from "../shared/desktop-api.ts";
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
          apiVersion: "pragma/v3",
          kind: "Flow",
          metadata: expect.objectContaining({ id: expectedId, name: "Release" }),
        }),
      ],
    });
    expect(await readFile(join(directory, "studio", "project.json"), "utf8")).toContain(
      "pragma.desktop-project/v4",
    );
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
      apiVersion: "pragma/v3",
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
    expect(await experts.list()).toHaveLength(2);
    const opened = await projectRevisionFile(directory, 1, `experts/${created.id}.pragma.yaml`);
    expect(opened).toContain("scope: Release communication");
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
      project.upsert({ baseRevision: 1, resource: builtInPragmaResource() }),
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
    ).rejects.toMatchObject({ code: "resource_referenced" });
    await expect(
      project.remove({ baseRevision: 1, ref: "flow:ceq0qxcgdv75wg6b" }),
    ).rejects.toMatchObject({ code: "resource_referenced" });
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
      ref: "runtime-profile:zdkgs0fde4xt00vr",
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
    apiVersion: "pragma/v3",
    kind: "Expert",
    metadata: {
      id: resourceId,
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
    apiVersion: "pragma/v3",
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
    apiVersion: "pragma/v3",
    kind: "ExpertTeam",
    metadata: {
      id: id === "reviewers" ? "p8cbn3cg2avyksn4" : "r8ggx4n4219hrc2p",
      name: id === "reviewers" ? "Reviewers" : "Publishers",
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

function portableContextStore(): PragmaContextStoreResource {
  return {
    apiVersion: "pragma/v3",
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
    apiVersion: "pragma/v3",
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
    apiVersion: "pragma/v3",
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
  const objects = new ContentAddressedStore(join(directory, ".storage", "objects"));
  const files = new Map<string, Uint8Array>(
    sources.map((source, index) => [
      `flows/release@${index + 1}.pragma.yaml`,
      Buffer.from(source, "utf8"),
    ]),
  );
  const snapshot = await objects.putSnapshot(files);
  await mkdir(join(directory, "studio", "revisions"), { recursive: true });
  await writeFile(
    join(directory, "studio", "project.json"),
    `${JSON.stringify({
      schemaVersion: "pragma.desktop-project/v3",
      projectId: "studio",
      headRevision: 1,
    })}\n`,
  );
  await writeFile(
    join(directory, "studio", "revisions", "1.json"),
    `${JSON.stringify({
      schemaVersion: "pragma.project-revision/v3",
      snapshotHash: snapshot.root.hash,
    })}\n`,
  );
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
