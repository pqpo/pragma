import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContentAddressedStore, PragmaPaths } from "@pragma/core";
import { migratePragmaCompilerProjectToCurrent, type PragmaResource } from "@pragma/interpreter";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalHostProjectRevisionReader } from "../src/index.ts";
import {
  HISTORICAL_V8_EXPERT_TOOL_PROJECT_FILES,
  HISTORICAL_V8_PROJECT_FILES,
  HISTORICAL_V8_PROJECT_FINGERPRINT,
  HISTORICAL_V8_PROJECT_ID,
  HISTORICAL_V8_TEAM_ID,
  writeHistoricalV8PublishedProjectFixture,
} from "./fixtures/published-project-v8.ts";

const temporaryHomes: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryHomes
      .splice(0)
      .map(
        async (home) =>
          await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
      ),
  );
});

describe("Local Host project revision reader", { timeout: 30_000 }, () => {
  it("removes the v8 Expert tool context policy during migration", () => {
    const migrated = migratePragmaCompilerProjectToCurrent({
      revisionCompilerVersion: "pragma.dsl/v8",
      files: HISTORICAL_V8_EXPERT_TOOL_PROJECT_FILES,
    });
    const coordinator = migrated.resources.find(
      (resource: PragmaResource) =>
        resource.kind === "Expert" && resource.metadata.id === "mrvsehytqfmb814x",
    );
    expect(coordinator?.kind).toBe("Expert");
    if (coordinator?.kind !== "Expert") throw new Error("Expected the historical coordinator.");
    expect(coordinator.spec.tools[0]?.policy).not.toHaveProperty("context");
  });

  it("derives a v9 compiler view without changing the historical v8 pin", async () => {
    const home = await createHistoricalHome();
    const paths = new PragmaPaths({ pragmaHome: home });
    const reader = createReader(paths);

    const before = await readRevisionManifest(paths);
    const location = await reader.getRevision(HISTORICAL_V8_PROJECT_ID, 1);
    expect(location).toMatchObject({
      projectId: HISTORICAL_V8_PROJECT_ID,
      revision: 1,
      projectFingerprint: HISTORICAL_V8_PROJECT_FINGERPRINT,
      sourceProjectFingerprint: HISTORICAL_V8_PROJECT_FINGERPRINT,
      sourceCompilerVersion: "pragma.dsl/v8",
      compilerVersion: "pragma.dsl/v9",
    });
    expect(location?.compilerViewKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(location?.derivedProjectFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(location?.derivedProjectFingerprint).not.toBe(HISTORICAL_V8_PROJECT_FINGERPRINT);
    expect(location?.rootDir).not.toBe(join(paths.projectViewsCacheRoot(), before.snapshotHash));

    if (location === undefined) throw new Error("Expected the historical revision.");
    const files = await reader.readFiles(location);
    expect(files.get("pragma.lock.yaml")).toContain("compilerVersion: pragma.dsl/v9");
    expect(files.has(".pragma-compiler-view")).toBe(false);
    const project = await reader.openRevision(location);
    try {
      expect(project.listResources()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "Expert" }),
          expect.objectContaining({
            kind: "ExpertTeam",
            metadata: expect.objectContaining({ id: HISTORICAL_V8_TEAM_ID }),
          }),
          expect.objectContaining({ kind: "Flow" }),
        ]),
      );
      const team = project.listResources().find((resource) => resource.kind === "ExpertTeam");
      expect(team).toBeDefined();
      if (team?.kind === "ExpertTeam") {
        expect(team.spec.delegation).not.toHaveProperty("context");
      }
    } finally {
      await project.dispose();
    }

    expect(await readRevisionManifest(paths)).toEqual(before);
    expect(
      await readFile(
        join(paths.projectViewsCacheRoot(), before.snapshotHash, "pragma.lock.yaml"),
        "utf8",
      ),
    ).toContain("compilerVersion: pragma.dsl/v8");
  });

  it("shares one complete derived view across concurrent first reads", async () => {
    const home = await createHistoricalHome();
    const paths = new PragmaPaths({ pragmaHome: home });
    const reader = createReader(paths);
    const locations = await Promise.all(
      Array.from({ length: 12 }, async () => await reader.getRevision(HISTORICAL_V8_PROJECT_ID, 1)),
    );
    expect(locations.every((location) => location?.compilerViewKey !== undefined)).toBe(true);
    expect(new Set(locations.map((location) => location?.compilerViewKey)).size).toBe(1);
    expect(new Set(locations.map((location) => location?.derivedProjectFingerprint)).size).toBe(1);
    const views = (await readdir(paths.projectViewsCacheRoot())).filter((entry) =>
      entry.startsWith("compiler-"),
    );
    expect(views).toHaveLength(1);
  });

  it("rebuilds an interrupted compiler view without changing the source revision", async () => {
    const home = await createHistoricalHome();
    const paths = new PragmaPaths({ pragmaHome: home });
    const reader = createReader(paths);
    const before = await readRevisionManifest(paths);
    const first = await reader.getRevision(HISTORICAL_V8_PROJECT_ID, 1);
    if (first === undefined || first.compilerViewKey === undefined) {
      throw new Error("Expected a derived compiler view.");
    }

    await rm(first.rootDir, { recursive: true, force: true });
    const temporary = join(paths.projectViewsCacheRoot(), `.compiler-${first.compilerViewKey}.tmp`);
    await mkdir(temporary, { recursive: true });
    await writeFile(join(temporary, ".pragma-compiler-view"), "incomplete\n");
    const incompleteTarget = join(
      paths.projectViewsCacheRoot(),
      `compiler-${first.compilerViewKey}`,
    );
    await mkdir(incompleteTarget, { recursive: true });
    await writeFile(join(incompleteTarget, ".pragma-compiler-view"), "incomplete\n");

    const recovered = await reader.getRevision(HISTORICAL_V8_PROJECT_ID, 1);
    expect(recovered?.compilerViewKey).toBe(first.compilerViewKey);
    expect(recovered?.derivedProjectFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    await expect(readFile(join(recovered!.rootDir, "pragma.lock.yaml"), "utf8")).resolves.toContain(
      "compilerVersion: pragma.dsl/v9",
    );
    await expect(readRevisionManifest(paths)).resolves.toEqual(before);
    await expect(readFile(join(temporary, ".pragma-compiler-view"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a future compiler revision before creating a compiler view", async () => {
    const home = await createHistoricalHome();
    const paths = new PragmaPaths({ pragmaHome: home });
    const revisionPath = join(
      paths.projectsRoot(),
      HISTORICAL_V8_PROJECT_ID,
      "revisions",
      "1.json",
    );
    const revision = JSON.parse(await readFile(revisionPath, "utf8")) as Record<string, unknown>;
    revision.compilerVersion = "pragma.dsl/v10";
    await writeFile(revisionPath, `${JSON.stringify(revision)}\n`);
    const reader = createReader(paths);

    await expect(reader.getRevision(HISTORICAL_V8_PROJECT_ID, 1)).rejects.toMatchObject({
      code: "future_compiler_version",
    });
    const views = await readdir(paths.projectViewsCacheRoot()).catch(() => [] as string[]);
    expect(views.filter((entry) => entry.startsWith("compiler-"))).toEqual([]);
  });

  it("fails closed when the historical lock is damaged", async () => {
    const home = await createHistoricalHome();
    const paths = new PragmaPaths({ pragmaHome: home });
    const revision = await readRevisionManifest(paths);
    const rawRoot = join(paths.projectViewsCacheRoot(), revision.snapshotHash);
    const objects = new ContentAddressedStore(paths.contentObjectsRoot());
    await mkdir(rawRoot, { recursive: true });
    await objects.materializeTree(revision.snapshotHash, rawRoot);
    await chmod(join(rawRoot, "pragma.lock.yaml"), 0o644);
    await writeFile(
      join(rawRoot, "pragma.lock.yaml"),
      HISTORICAL_V8_PROJECT_FILES.get("pragma.lock.yaml")!.replace(
        HISTORICAL_V8_PROJECT_FINGERPRINT,
        "deadbeef".repeat(8),
      ),
    );
    const reader = createReader(paths);

    await expect(reader.getRevision(HISTORICAL_V8_PROJECT_ID, 1)).rejects.toMatchObject({
      code: "lock_mismatch",
    });
    const views = await readdir(paths.projectViewsCacheRoot());
    expect(views.filter((entry) => entry.startsWith("compiler-"))).toEqual([]);
  });
});

async function createHistoricalHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "pragma-local-host-v8-revision-"));
  temporaryHomes.push(home);
  await writeHistoricalV8PublishedProjectFixture(home);
  return home;
}

function createReader(paths: PragmaPaths) {
  return createLocalHostProjectRevisionReader({
    projectsPath: paths.projectsRoot(),
    objectsPath: paths.contentObjectsRoot(),
    projectViewsPath: paths.projectViewsCacheRoot(),
  });
}

async function readRevisionManifest(paths: PragmaPaths): Promise<{
  readonly snapshotHash: string;
  readonly projectFingerprint: string;
  readonly compilerVersion: string;
}> {
  return JSON.parse(
    await readFile(
      join(paths.projectsRoot(), HISTORICAL_V8_PROJECT_ID, "revisions", "1.json"),
      "utf8",
    ),
  ) as { snapshotHash: string; projectFingerprint: string; compilerVersion: string };
}
