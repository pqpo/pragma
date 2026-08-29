import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ContentAddressedStore, PragmaPaths } from "@pragma/core";

export const HISTORICAL_V8_PROJECT_ID = "studio" as const;
export const HISTORICAL_V8_TEAM_ID = "vyv9pwwzaksth2dd" as const;
export const HISTORICAL_V8_FLOW_ID = "t9ne4d8njvvxv2ea" as const;
export const HISTORICAL_V8_PROJECT_FINGERPRINT =
  "bd7c1758d7ad989c43a6a74a35209fb63f0d24fc4c19cb5be030ed961a116403" as const;

/**
 * Supplemental v8 writer-shaped files used only to exercise the historical
 * Expert tool policy migration. The base fixture above remains the exact M7
 * published-project output; this variant adds the v8-only policy field to an
 * otherwise identical project without passing it through current schemas.
 */
export const HISTORICAL_V8_EXPERT_TOOL_PROJECT_FINGERPRINT =
  "54c3c5212b6d34c3c83b74bc74f5f81a828e2c65894d7ef3baf7ae4e22273923" as const;

/**
 * Frozen from the M7 writer at commit 2eb3d5b0, whose compiler write
 * version was pragma.dsl/v8. The source files are intentionally literals:
 * do not rebuild this fixture with the current compiler schemas.
 */
export const HISTORICAL_V8_PROJECT_FILES = new Map<string, string>([
  [
    "runtime-profiles/knr7p5b7qc55wv92.pragma.yaml",
    `apiVersion: pragma/v5
kind: RuntimeProfile
metadata:
  id: knr7p5b7qc55wv92
  name: Historical Codex Runtime
  description: Runtime profile from a published project.
  tags: []
spec:
  adapter: pragma.runtime.profile@v1
  config:
    runtimeId: codex
`,
  ],
  [
    "experts/mrvsehytqfmb814x.pragma.yaml",
    `apiVersion: pragma/v5
kind: Expert
metadata:
  id: mrvsehytqfmb814x
  name: Historical Coordinator
  description: Historical Coordinator from a published project.
  tags: []
  avatarId: pragma.avatar.expert.default
spec:
  scope: Complete the requested task.
  instructions: Respond briefly and clearly.
  runtime:
    ref: runtime-profile:knr7p5b7qc55wv92
  capabilities: []
  toolApprovals: {}
  contextStores: []
  plugins: []
  tools: []
`,
  ],
  [
    "experts/3sfd30h5017wd17d.pragma.yaml",
    `apiVersion: pragma/v5
kind: Expert
metadata:
  id: 3sfd30h5017wd17d
  name: Historical Member
  description: Historical Member from a published project.
  tags: []
  avatarId: pragma.avatar.expert.default
spec:
  scope: Review the requested task.
  instructions: Respond briefly and clearly.
  runtime:
    ref: runtime-profile:knr7p5b7qc55wv92
  capabilities: []
  toolApprovals: {}
  contextStores: []
  plugins: []
  tools: []
`,
  ],
  [
    "teams/vyv9pwwzaksth2dd.pragma.yaml",
    `apiVersion: pragma/v5
kind: ExpertTeam
metadata:
  id: vyv9pwwzaksth2dd
  name: Historical Team
  description: Team from a published project.
  tags: []
  avatarId: pragma.avatar.team.default
spec:
  coordinator:
    ref: expert:mrvsehytqfmb814x
  members:
    - ref: expert:3sfd30h5017wd17d
  contextStores: []
  delegation:
    permissions:
      interact: {}
    maxConcurrency: 2
    maxDepth: 2
    runtimes: {}
    context: context-policy:pragma.fresh@v1
`,
  ],
  [
    "flows/t9ne4d8njvvxv2ea.pragma.yaml",
    `apiVersion: pragma/v5
kind: Flow
metadata:
  id: t9ne4d8njvvxv2ea
  name: Historical Flow
  description: Flow from a published project.
  tags: []
spec:
  limits:
    maxNodeVisits: 1000
  graph:
    start: run
    steps:
      run:
        expert:
          ref: expert:mrvsehytqfmb814x
        prompt:
          segments:
            - text: Return a one-line status.
    loops: {}
    transitions:
      run:
        end: true
`,
  ],
  [
    "pragma.yaml",
    `apiVersion: pragma/v5
kind: Bundle
imports:
  - ./experts/3sfd30h5017wd17d.pragma.yaml
  - ./experts/mrvsehytqfmb814x.pragma.yaml
  - ./flows/t9ne4d8njvvxv2ea.pragma.yaml
  - ./runtime-profiles/knr7p5b7qc55wv92.pragma.yaml
  - ./teams/vyv9pwwzaksth2dd.pragma.yaml
resources: []
`,
  ],
  [
    "pragma.lock.yaml",
    `apiVersion: pragma/v5
kind: Lock
compilerVersion: pragma.dsl/v8
projectFingerprint: bd7c1758d7ad989c43a6a74a35209fb63f0d24fc4c19cb5be030ed961a116403
resources:
  - ref: expert:3sfd30h5017wd17d
    contentHash: 13bb2278461446aaaa6c8b54a82818548c3934f2933e89bdf177f4732ed48667
    source: experts/3sfd30h5017wd17d.pragma.yaml
  - ref: expert:mrvsehytqfmb814x
    contentHash: d481835738c36b8e2b80b0f103a29ea128ff30c1987d205235afa665a34c4098
    source: experts/mrvsehytqfmb814x.pragma.yaml
  - ref: flow:t9ne4d8njvvxv2ea
    contentHash: 7b69216ac179be4bba8a5aee8d23076f696e2c32cd6ccc2d9891b2ade0d0356b
    source: flows/t9ne4d8njvvxv2ea.pragma.yaml
  - ref: runtime-profile:knr7p5b7qc55wv92
    contentHash: eb32735a0b3b1733e60f92c98cce486636144408757ed23aae4de15eb9a32432
    source: runtime-profiles/knr7p5b7qc55wv92.pragma.yaml
  - ref: team:vyv9pwwzaksth2dd
    contentHash: 52c4048ab09fecfd0c7db4b2b3719581aeb5f762557f5cd158a9c9c98f637d0d
    source: teams/vyv9pwwzaksth2dd.pragma.yaml
artifacts: []
`,
  ],
]);

export const HISTORICAL_V8_EXPERT_TOOL_PROJECT_FILES = new Map<string, string>(
  [...HISTORICAL_V8_PROJECT_FILES].map(([path, contents]) => {
    if (path === "experts/mrvsehytqfmb814x.pragma.yaml") {
      return [
        path,
        contents.replace(
          "  tools: []\n",
          [
            "  tools:",
            "    - adapter: pragma.tool.call@v1",
            "      target:",
            "        ref: expert:3sfd30h5017wd17d",
            "      tool:",
            "        name: call_reviewer",
            "        description: Call the reviewer",
            "        approval: none",
            "      policy:",
            "        maxConcurrency: 4",
            "        maxDepth: 3",
            "        context: context-policy:pragma.fresh@v1",
            "        runtimes: {}",
            "",
          ].join("\n"),
        ),
      ] as const;
    }
    if (path === "pragma.lock.yaml") {
      return [
        path,
        contents
          .replace(
            "d481835738c36b8e2b80b0f103a29ea128ff30c1987d205235afa665a34c4098",
            "1c728307e1d282044b52b5f94f0aa12ec3bd08767779061ac4ae89c85a5b7383",
          )
          .replace(
            HISTORICAL_V8_PROJECT_FINGERPRINT,
            HISTORICAL_V8_EXPERT_TOOL_PROJECT_FINGERPRINT,
          ),
      ] as const;
    }
    return [path, contents] as const;
  }),
);

export async function writeHistoricalV8PublishedProjectFixture(home: string): Promise<{
  readonly fingerprint: typeof HISTORICAL_V8_PROJECT_FINGERPRINT;
}> {
  const paths = new PragmaPaths({ pragmaHome: home });
  const objects = new ContentAddressedStore(paths.contentObjectsRoot());
  const snapshot = await objects.putSnapshot(
    new Map(
      [...HISTORICAL_V8_PROJECT_FILES].map(([path, contents]) => [
        path,
        Buffer.from(contents, "utf8"),
      ]),
    ),
  );
  const projectPath = join(paths.projectsRoot(), HISTORICAL_V8_PROJECT_ID);
  const createdAt = "2026-08-27T00:00:00.000Z";
  await mkdir(join(projectPath, "revisions"), { recursive: true });
  await writeFile(
    join(projectPath, "revisions", "1.json"),
    `${JSON.stringify({
      schemaVersion: "pragma.project-revision/v5",
      projectId: HISTORICAL_V8_PROJECT_ID,
      revision: 1,
      snapshotHash: snapshot.root.hash,
      projectFingerprint: HISTORICAL_V8_PROJECT_FINGERPRINT,
      compilerVersion: "pragma.dsl/v8",
      createdAt,
    })}\n`,
  );
  await writeFile(
    join(projectPath, "project.json"),
    `${JSON.stringify({
      schemaVersion: "pragma.desktop-project/v5",
      projectId: HISTORICAL_V8_PROJECT_ID,
      headRevision: 1,
      updatedAt: createdAt,
    })}\n`,
  );
  return { fingerprint: HISTORICAL_V8_PROJECT_FINGERPRINT };
}
