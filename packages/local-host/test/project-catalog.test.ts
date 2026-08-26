import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ContentAddressedStore,
  createStaticRuntimeResolver,
  PragmaPaths,
  snapshotRuntimeFeatures,
  type RuntimeResolver,
} from "@pragma/core";
import { createRuntimeTestFeatures } from "@pragma/core/testing";
import {
  PRAGMA_DSL_WRITE_API_VERSION,
  PragmaExpertResourceSchema,
  PragmaExpertTeamResourceSchema,
  PragmaFlowResourceSchema,
  PragmaLockSchema,
  PragmaProjectService,
  PragmaRuntimeProfileResourceSchema,
  parsePragmaYaml,
  type PragmaProjectSourceRepository,
  type PragmaResource,
} from "@pragma/interpreter";
import type { WorkspaceSelection } from "@pragma/shared/integration";
import { afterEach, describe, expect, it } from "vitest";

import {
  createLocalHostProjectCatalogFromHome,
  LOCAL_HOST_DEFAULT_PROJECT_ID,
} from "../src/index.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Local Host project catalog", { timeout: 10_000 }, () => {
  it("reads a published revision and compiles exact Team and Flow refs with stable pins", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-local-host-project-"));
    temporaryRoots.push(home);
    const fixture = await writePublishedProject(home);
    const runtimes = createTestRuntimeResolver();
    const catalog = createLocalHostProjectCatalogFromHome({ pragmaHome: home, runtimes });
    const workspace = createWorkspace(home);

    await expect(catalog.listProjects()).resolves.toEqual([
      {
        id: LOCAL_HOST_DEFAULT_PROJECT_ID,
        revision: 1,
        fingerprint: fixture.fingerprint,
      },
    ]);
    const executors = await catalog.listExecutors();
    expect(executors.map((executor) => executor.ref)).toEqual(
      expect.arrayContaining([
        { kind: "team", id: fixture.teamId },
        { kind: "flow", id: fixture.flowId },
      ]),
    );
    expect(executors.filter((executor) => executor.source === "project")).toHaveLength(4);

    const team = await catalog.resolve({
      ref: { kind: "team", id: fixture.teamId },
      workspace,
    });
    expect(team?.descriptor.project).toEqual({
      projectId: LOCAL_HOST_DEFAULT_PROJECT_ID,
      revision: 1,
      fingerprint: fixture.fingerprint,
    });
    expect(team?.definition).toMatchObject({ id: fixture.teamId, kind: "expert-team" });

    const flow = await catalog.resolve({
      ref: { kind: "flow", id: fixture.flowId },
      projectId: LOCAL_HOST_DEFAULT_PROJECT_ID,
      revision: 1,
      workspace,
    });
    expect(flow?.descriptor.project).toEqual(team?.descriptor.project);
    expect(flow?.definition).toMatchObject({ id: fixture.flowId, kind: "flow" });

    await expect(
      catalog.resolve({ ref: { kind: "team", id: "zzzzzzzzzzzzzzzz" }, workspace }),
    ).resolves.toBeUndefined();
    await expect(
      catalog.getProjectRevision(LOCAL_HOST_DEFAULT_PROJECT_ID, 1),
    ).resolves.toMatchObject({
      id: LOCAL_HOST_DEFAULT_PROJECT_ID,
      revision: 1,
      fingerprint: fixture.fingerprint,
      resources: expect.arrayContaining([
        expect.objectContaining({
          kind: "ExpertTeam",
          metadata: expect.objectContaining({ id: fixture.teamId }),
        }),
        expect.objectContaining({
          kind: "Flow",
          metadata: expect.objectContaining({ id: fixture.flowId }),
        }),
      ]),
    });
  });
});

async function writePublishedProject(home: string): Promise<{
  readonly teamId: string;
  readonly flowId: string;
  readonly fingerprint: string;
}> {
  const teamId = "vyv9pwwzaksth2dd";
  const flowId = "t9ne4d8njvvxv2ea";
  const expertId = "mrvsehytqfmb814x";
  const memberId = "3sfd30h5017wd17d";
  const resources: readonly PragmaResource[] = [
    PragmaRuntimeProfileResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "RuntimeProfile",
      metadata: {
        id: "knr7p5b7qc55wv92",
        name: "Historical Codex Runtime",
        description: "Runtime profile from the published fixture.",
        tags: [],
      },
      spec: {
        adapter: "pragma.runtime.profile@v1",
        config: { runtimeId: "codex" },
      },
    }),
    PragmaExpertResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Expert",
      metadata: {
        id: expertId,
        avatarId: "pragma.avatar.expert.default",
        name: "Historical Coordinator",
        description: "Coordinator from the published fixture.",
        tags: [],
      },
      spec: {
        scope: "Complete the requested short task.",
        instructions: "Respond briefly and clearly.",
        runtime: { ref: "runtime-profile:knr7p5b7qc55wv92" },
        capabilities: [],
        toolApprovals: {},
        contextStores: [],
        plugins: [],
        tools: [],
      },
    }),
    PragmaExpertResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Expert",
      metadata: {
        id: memberId,
        avatarId: "pragma.avatar.expert.default",
        name: "Historical Member",
        description: "Member from the published fixture.",
        tags: [],
      },
      spec: {
        scope: "Review the requested short task.",
        instructions: "Respond briefly and clearly.",
        runtime: { ref: "runtime-profile:knr7p5b7qc55wv92" },
        capabilities: [],
        toolApprovals: {},
        contextStores: [],
        plugins: [],
        tools: [],
      },
    }),
    PragmaExpertTeamResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "ExpertTeam",
      metadata: {
        id: teamId,
        avatarId: "pragma.avatar.team.default",
        name: "Historical Team",
        description: "Team from the published fixture.",
        tags: [],
      },
      spec: {
        coordinator: { ref: `expert:${expertId}` },
        members: [{ ref: `expert:${memberId}` }],
        contextStores: [],
        delegation: {
          permissions: { interact: {} },
          maxConcurrency: 2,
          maxDepth: 2,
          context: "context-policy:pragma.fresh@v1",
          runtimes: {},
        },
      },
    }),
    PragmaFlowResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Flow",
      metadata: {
        id: flowId,
        name: "Historical Flow",
        description: "Flow from the published fixture.",
        tags: [],
      },
      spec: {
        graph: {
          start: "run",
          steps: {
            run: {
              expert: { ref: `expert:${expertId}` },
              prompt: { segments: [{ text: "Return a one-line status." }] },
            },
          },
          transitions: { run: { end: true } },
        },
      },
    }),
  ];
  const service = new PragmaProjectService({ repository: emptyRepository() });
  const files = await service.renderProjectFiles({ resources });
  const lock = PragmaLockSchema.parse(parsePragmaYaml(files.get("pragma.lock.yaml")!));
  const paths = new PragmaPaths({ pragmaHome: home });
  const objects = new ContentAddressedStore(paths.contentObjectsRoot());
  const snapshot = await objects.putSnapshot(
    new Map([...files].map(([path, contents]) => [path, Buffer.from(contents, "utf8")])),
  );
  const projectPath = join(paths.projectsRoot(), LOCAL_HOST_DEFAULT_PROJECT_ID);
  const createdAt = new Date().toISOString();
  await mkdir(join(projectPath, "revisions"), { recursive: true });
  await writeFile(
    join(projectPath, "revisions", "1.json"),
    `${JSON.stringify({
      schemaVersion: "pragma.project-revision/v5",
      projectId: LOCAL_HOST_DEFAULT_PROJECT_ID,
      revision: 1,
      snapshotHash: snapshot.root.hash,
      projectFingerprint: lock.projectFingerprint,
      compilerVersion: lock.compilerVersion,
      createdAt,
    })}\n`,
  );
  await writeFile(
    join(projectPath, "project.json"),
    `${JSON.stringify({
      schemaVersion: "pragma.desktop-project/v5",
      projectId: LOCAL_HOST_DEFAULT_PROJECT_ID,
      headRevision: 1,
      updatedAt: createdAt,
    })}\n`,
  );
  return { teamId, flowId, fingerprint: lock.projectFingerprint };
}

function emptyRepository(): PragmaProjectSourceRepository {
  return {
    getHead: async () => undefined,
    getRevision: async () => undefined,
    readFiles: async () => new Map(),
    commit: async () => {
      throw new Error("The test repository is read-only.");
    },
  };
}

function createTestRuntimeResolver(): RuntimeResolver {
  return createStaticRuntimeResolver({
    defaultRuntimeId: "codex",
    runtimes: [
      {
        features: snapshotRuntimeFeatures(createRuntimeTestFeatures()),
        descriptor: { id: "codex", kind: "test", displayName: "Codex fixture" },
        canUse: () => ({ usable: true }),
      },
    ],
  });
}

function createWorkspace(home: string): WorkspaceSelection {
  return {
    schemaVersion: "pragma.integration-workspace/v1",
    requestedPath: home,
    canonicalPath: home,
    displayName: "fixture",
    identityHash: `sha256:${"d".repeat(64)}`,
    access: { exists: true, readable: true, writable: true },
    source: "explicit",
  };
}
