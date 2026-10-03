import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUILT_IN_PRAGMA_REF } from "@pragma/built-in-agents";
import {
  ContentAddressedStore,
  createNoopLoggerProvider,
  createStaticRuntimeResolver,
  PragmaPaths,
} from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import {
  canonicalPragmaResourceRef,
  parsePragmaYaml,
  PragmaLockSchema,
  PragmaProjectService,
} from "@pragma/interpreter";
import { afterEach, expect, it } from "vitest";

import { createLocalHostNodeMissionCompiler } from "../src/node-mission-compiler.ts";
import { createLocalHostProjectCatalogFromHome } from "../src/project-catalog.ts";
import { createPublishedProjectResources } from "./fixtures/published-project.ts";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function publishedCaller(target: string) {
  const home = await mkdtemp(join(tmpdir(), "pragma-node-external-system-"));
  homes.push(home);
  const resources = [...createPublishedProjectResources()];
  const caller = resources.find((resource) => resource.kind === "Expert")!;
  if (caller.kind !== "Expert") throw new Error("Missing caller.");
  caller.spec.tools = [
    {
      adapter: "pragma.tool.call@v1",
      target: { ref: target },
      tool: { name: "call_system", description: "Call system", approval: "none" },
    },
  ];
  const service = new PragmaProjectService({
    externalResourceRefs: new Set([target]),
    repository: {
      getHead: async () => undefined,
      getRevision: async () => undefined,
      readFiles: async () => new Map(),
      commit: async () => {
        throw new Error("Read-only fixture.");
      },
    },
  });
  const files = await service.renderProjectFiles({ resources });
  const lock = PragmaLockSchema.parse(parsePragmaYaml(files.get("pragma.lock.yaml")!));
  const paths = new PragmaPaths({ pragmaHome: home });
  const snapshot = await new ContentAddressedStore(paths.contentObjectsRoot()).putSnapshot(
    new Map([...files].map(([path, content]) => [path, Buffer.from(content)])),
  );
  const projectRoot = join(paths.projectsRoot(), "studio");
  await mkdir(join(projectRoot, "revisions"), { recursive: true });
  const date = new Date().toISOString();
  await writeFile(
    join(projectRoot, "project.json"),
    JSON.stringify({
      schemaVersion: "pragma.desktop-project/v5",
      projectId: "studio",
      headRevision: 1,
      updatedAt: date,
    }),
  );
  await writeFile(
    join(projectRoot, "revisions", "1.json"),
    JSON.stringify({
      schemaVersion: "pragma.project-revision/v5",
      projectId: "studio",
      revision: 1,
      snapshotHash: snapshot.root.hash,
      projectFingerprint: lock.projectFingerprint,
      compilerVersion: lock.compilerVersion,
      createdAt: date,
    }),
  );
  const runtimes = createStaticRuntimeResolver({
    defaultRuntimeId: "codex",
    runtimes: [
      defineRuntimeTestDriver({
        descriptor: { id: "codex", kind: "test", displayName: "Fixture" },
        canUse: async () => ({ usable: true }),
        createSession: () => ({}),
        startTurn: () => ({ outputText: "done" }),
        mapEvent: () => ({ events: [] }),
      }),
    ],
  });
  return { home, runtimes, caller };
}

it("loads and compiles a real published caller through the Node default registered system refs", async () => {
  const f = await publishedCaller(BUILT_IN_PRAGMA_REF);
  const compiler = createLocalHostNodeMissionCompiler({
    pragmaHome: f.home,
    runtimes: f.runtimes,
    loggerProvider: createNoopLoggerProvider(),
    resources: {
      adapterHost: () => ({
        environmentId: "cli",
        projectRoot: f.home,
        resolveBinding: async (ref) => ({
          ref,
          revision: "fixture",
          fingerprint: "a".repeat(64),
          value: { contribution: { tools: [] } },
        }),
        resolveSecret: async () => undefined,
        resolveArtifact: async () => {
          throw new Error("Unexpected artifact.");
        },
      }),
    },
  });
  const prepared = await compiler.prepare(
    compiler.service.createRequestScope({
      id: "external-system-caller",
      project: { id: "studio", revision: 1 },
      executor: {
        kind: "expert",
        ref: canonicalPragmaResourceRef(f.caller),
        name: f.caller.metadata.name,
      },
      workspace: { path: f.home },
      contextMounts: [],
    }),
  );
  expect((await prepared.ensureCompiled()).compiled.value.id).toBe(f.caller.metadata.id);
  const catalog = createLocalHostProjectCatalogFromHome({
    pragmaHome: f.home,
    runtimes: f.runtimes,
  });
  expect((await catalog.listExecutors()).map((executor) => executor.ref.id)).toContain(
    f.caller.metadata.id,
  );
});

it("continues to reject unregistered external refs in the real Node revision loader", async () => {
  const unknown = "expert:0000000000000001";
  const f = await publishedCaller(unknown);
  const compiler = createLocalHostNodeMissionCompiler({ pragmaHome: f.home, runtimes: f.runtimes });
  const location = await compiler.reader.getRevision("studio", 1);
  if (location === undefined) throw new Error("Missing published fixture.");
  const project = await compiler.reader.openRevision(location);
  try {
    await expect(project.validateFor(canonicalPragmaResourceRef(f.caller))).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "reference.invalid",
          message: expect.stringContaining(unknown),
        }),
      ]),
    );
    await expect(
      project.compile(canonicalPragmaResourceRef(f.caller), {
        runtimes: f.runtimes,
        workspace: f.home,
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "reference.invalid" })]),
    });
  } finally {
    await project.dispose();
  }
});
