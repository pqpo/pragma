import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PragmaPaths } from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { PRAGMA_DSL_WRITE_API_VERSION, type PragmaResource } from "@pragma/interpreter/ast";
import {
  createPragmaBundleService,
  createPragmaProjectStore,
  createRuntimeEnvironmentService,
  createRuntimeEnvironmentStore,
  createWorkflowLayoutStore,
  getTargetRuntimeAvailability,
  invalidateTargetRuntimeAvailability,
  type CapabilityStore,
  type ContextStoreStore,
  type PluginStore,
} from "@pragma/local-host/deployment";
import { afterEach, expect, it, vi } from "vitest";
import { createBundleExecutorReadiness } from "./bundle-executor-readiness.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

it("uses model-aware Bundle readiness for both Mission creation and execution, and recovers without reimport", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-bundle-mission-readiness-"));
  roots.push(root);
  const paths = new PragmaPaths({ pragmaHome: join(root, ".pragma") });
  let discoveryError = false;
  let modelMissing = false;
  let usable = true;
  const listModels = vi.fn(async () => {
    if (discoveryError) throw new Error("Authentication expired");
    return modelMissing
      ? []
      : [
          {
            id: "gpt-test",
            displayName: "GPT Test",
            provider: { kind: "runtime-managed" as const, id: "openai", displayName: "OpenAI" },
          },
        ];
  });
  const runtimes = createRuntimeEnvironmentService({
    store: createRuntimeEnvironmentStore({
      pragmaHome: join(root, ".pragma"),
      builtIns: [
        {
          schemaVersion: "pragma.runtime-environment/v1",
          id: "pi",
          displayName: "Pi",
          origin: "built-in",
          adapter: { id: "test.runtime", version: "v1" },
          config: {},
        },
      ],
    }),
    factories: [
      {
        id: "test.runtime",
        version: "v1",
        create: (environment) =>
          defineRuntimeTestDriver({
            descriptor: { id: environment.id, kind: "test", displayName: environment.displayName },
            canUse: () => ({ usable }),
            listModels,
            createSession: () => ({}),
            startTurn: () => ({ outputText: "" }),
            mapEvent: () => ({ events: [] }),
          }),
      },
    ],
  });
  const resources: PragmaResource[] = [
    {
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "RuntimeProfile",
      metadata: {
        id: "zdkgs0fde4xt00vr",
        name: "Writer Runtime",
        description: "Writer runtime",
        tags: [],
      },
      spec: {
        adapter: "pragma.runtime.profile@v1",
        config: { runtimeId: "pi", providerId: "openai", model: "gpt-test" },
      },
    },
    {
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Expert",
      metadata: {
        id: "1xddvess309a6gme",
        name: "Writer",
        avatarId: "pragma.avatar.expert.default",
        description: "Writer",
        tags: [],
      },
      spec: {
        scope: "Writing",
        instructions: "Write release notes",
        runtime: { ref: "runtime-profile:zdkgs0fde4xt00vr" },
        capabilities: [],
        contextStores: [],
        tools: [],
        toolApprovals: {},
        plugins: [],
      },
    },
  ];
  const project = createPragmaProjectStore({ projectsPath: paths.projectsRoot() });
  const snapshot = await project.publish({ expectedRevision: 0, resources });
  // This Bundle has no capabilities, context stores or plugins; only their empty catalogs are needed.
  const bundles = createPragmaBundleService({
    paths,
    project,
    capabilities: { list: async () => [] } as unknown as CapabilityStore,
    contextStores: { list: async () => [] } as unknown as ContextStoreStore,
    plugins: { list: async () => [] } as unknown as PluginStore,
    layouts: createWorkflowLayoutStore({ projectsPath: paths.projectsRoot() }),
    getRuntimes: () => getTargetRuntimeAvailability(runtimes, ["pi"], { includeModels: true }),
  });
  const ref = "expert:1xddvess309a6gme";
  const path = join(root, "writer.pragma");
  await bundles.exportTo(
    {
      rootRef: ref,
      projectRevision: snapshot.revision,
      modules: { capabilities: false, knowledgeBases: false, plugins: false, flowLayouts: false },
    },
    path,
  );
  const inspection = await bundles.inspect(path);
  const installation = await bundles.startImport({
    sourcePath: path,
    rootRef: ref,
    expectedFingerprint: inspection.bundleFingerprint,
    expectedProjectFingerprint: inspection.projectFingerprint,
    expectedProjectRevision: inspection.projectRevision,
    conflicts: inspection.conflicts.map((conflict) => ({
      resourceRef: conflict.ref,
      action: "keep_local",
    })),
    runtimes: [],
    capabilities: [],
    contextStores: [],
    secrets: {},
  });
  expect(installation).toMatchObject({ status: "ready", pending: [] });
  const assertReady = createBundleExecutorReadiness({ project, runtimes, bundles });
  for (const operation of ["create_mission", "run_mission"] as const) {
    await expect(assertReady(ref, operation)).resolves.toBeUndefined();
  }
  const current = await project.get();
  await project.publish({
    expectedRevision: current.revision,
    resources: current.resources.map((resource) =>
      resource.kind === "RuntimeProfile"
        ? {
            ...resource,
            spec: {
              ...resource.spec,
              config: {
                ...(resource.spec.config as Record<string, unknown>),
                thinkingLevel: "high",
              },
            },
          }
        : resource,
    ),
  });
  await expect(assertReady(ref, "create_mission")).rejects.toMatchObject({
    dependencies: [expect.objectContaining({ code: "thinking_level_unavailable" })],
  });
  await project.publish({
    expectedRevision: (await project.get()).revision,
    resources: current.resources,
  });
  discoveryError = true;
  invalidateTargetRuntimeAvailability(runtimes);
  await expect(assertReady(ref, "create_mission")).rejects.toMatchObject({
    code: "bundle_setup_required",
    dependencies: [expect.objectContaining({ code: "model_discovery_failed" })],
  });
  discoveryError = false;
  // Failed discovery is not cached, so repairing the environment immediately restores admission.
  await expect(assertReady(ref, "run_mission")).resolves.toBeUndefined();
  modelMissing = true;
  invalidateTargetRuntimeAvailability(runtimes);
  await expect(assertReady(ref, "run_mission")).rejects.toMatchObject({
    dependencies: [expect.objectContaining({ code: "model_missing" })],
  });
  expect(await bundles.recheckInstallation(installation.id)).toMatchObject({
    status: "needs_setup",
    pending: [expect.objectContaining({ code: "model_missing" })],
  });
  usable = false;
  invalidateTargetRuntimeAvailability(runtimes);
  await expect(assertReady(ref, "create_mission")).rejects.toMatchObject({
    dependencies: [expect.objectContaining({ code: "runtime_unavailable" })],
  });
  usable = true;
  modelMissing = false;
  invalidateTargetRuntimeAvailability(runtimes);
  await expect(assertReady(ref, "create_mission")).resolves.toBeUndefined();
  expect(await bundles.recheckInstallation(installation.id)).toMatchObject({
    status: "ready",
    pending: [],
  });
}, 30_000);
