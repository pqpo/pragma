import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ContentAddressedStore, PragmaPaths } from "@pragma/core";
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

export const PUBLISHED_PROJECT_ID = "studio" as const;
export const PUBLISHED_TEAM_ID = "vyv9pwwzaksth2dd" as const;
export const PUBLISHED_FLOW_ID = "t9ne4d8njvvxv2ea" as const;

/** Write the same v5 manifest/CAS layout used by the Desktop publisher. */
export async function writePublishedProjectFixture(home: string): Promise<{
  readonly fingerprint: string;
}> {
  const resources = createPublishedProjectResources();
  const service = new PragmaProjectService({ repository: emptyRepository() });
  const files = await service.renderProjectFiles({ resources });
  const lock = PragmaLockSchema.parse(parsePragmaYaml(files.get("pragma.lock.yaml")!));
  const paths = new PragmaPaths({ pragmaHome: home });
  const objects = new ContentAddressedStore(paths.contentObjectsRoot());
  const snapshot = await objects.putSnapshot(
    new Map([...files].map(([path, contents]) => [path, Buffer.from(contents, "utf8")])),
  );
  const projectPath = join(paths.projectsRoot(), PUBLISHED_PROJECT_ID);
  const createdAt = new Date().toISOString();
  await mkdir(join(projectPath, "revisions"), { recursive: true });
  await writeFile(
    join(projectPath, "revisions", "1.json"),
    `${JSON.stringify({
      schemaVersion: "pragma.project-revision/v5",
      projectId: PUBLISHED_PROJECT_ID,
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
      projectId: PUBLISHED_PROJECT_ID,
      headRevision: 1,
      updatedAt: createdAt,
    })}\n`,
  );
  return { fingerprint: lock.projectFingerprint };
}

export function createPublishedProjectResources(): readonly PragmaResource[] {
  const coordinatorId = "mrvsehytqfmb814x";
  const memberId = "3sfd30h5017wd17d";
  const runtime = PragmaRuntimeProfileResourceSchema.parse({
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "RuntimeProfile",
    metadata: {
      id: "knr7p5b7qc55wv92",
      name: "Historical Codex Runtime",
      description: "Runtime profile from a published project.",
      tags: [],
    },
    spec: {
      adapter: "pragma.runtime.profile@v1",
      config: { runtimeId: "codex" },
    },
  });
  const expert = (id: string, name: string, scope: string) =>
    PragmaExpertResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Expert",
      metadata: {
        id,
        avatarId: "pragma.avatar.expert.default",
        name,
        description: `${name} from a published project.`,
        tags: [],
      },
      spec: {
        scope,
        instructions: "Respond briefly and clearly.",
        runtime: { ref: "runtime-profile:knr7p5b7qc55wv92" },
        capabilities: [],
        toolApprovals: {},
        contextStores: [],
        plugins: [],
        tools: [],
      },
    });
  const team = PragmaExpertTeamResourceSchema.parse({
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "ExpertTeam",
    metadata: {
      id: PUBLISHED_TEAM_ID,
      avatarId: "pragma.avatar.team.default",
      name: "Historical Team",
      description: "Team from a published project.",
      tags: [],
    },
    spec: {
      coordinator: { ref: `expert:${coordinatorId}` },
      members: [{ ref: `expert:${memberId}` }],
      contextStores: [],
      delegation: {
        permissions: { interact: {} },
        maxConcurrency: 2,
        maxDepth: 2,
        runtimes: {},
      },
    },
  });
  const flow = PragmaFlowResourceSchema.parse({
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Flow",
    metadata: {
      id: PUBLISHED_FLOW_ID,
      name: "Historical Flow",
      description: "Flow from a published project.",
      tags: [],
    },
    spec: {
      graph: {
        start: "run",
        steps: {
          run: {
            expert: { ref: `expert:${coordinatorId}` },
            prompt: { segments: [{ text: "Return a one-line status." }] },
          },
        },
        transitions: { run: { end: true } },
      },
    },
  });
  return [
    runtime,
    expert(coordinatorId, "Historical Coordinator", "Complete the requested task."),
    expert(memberId, "Historical Member", "Review the requested task."),
    team,
    flow,
  ];
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
