import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STORE_REVISION_EXPERT_REF, builtInAgentResource } from "@pragma/built-in-agents";
import {
  createNoopLoggerProvider,
  createStaticRuntimeResolver,
  createExpertAgentPluginPackageFingerprint,
} from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import {
  PRAGMA_DSL_WRITE_API_VERSION,
  PragmaExpertResourceSchema,
  PragmaCapabilityResourceSchema,
  PragmaRuntimeProfileResourceSchema,
} from "@pragma/interpreter/ast";
import { expect, it, vi } from "vitest";
import {
  createLocalHostMissionCompileService,
  createSqliteExecutionStore,
} from "@pragma/local-host";
import { canonicalPragmaResourceRef } from "@pragma/interpreter";

import { missionExecutorSnapshot } from "../../../shared/contracts/index.ts";
import type { PluginStore } from "../plugins/plugin-store.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { CapabilityCredentialStore } from "../capabilities/capability-credential-store.ts";
import { createPragmaProjectStore } from "../projects/pragma-project-store.ts";
import { createMissionStore } from "@pragma/local-host";
import { createDesktopMissionTestApplication } from "./fixtures/desktop-mission-test-application.ts";
import { createDesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import { parseDesktopCapabilityBindingRef } from "../../platform/bindings/desktop-binding-ref.ts";

it("compiles and executes a real published caller of an external system Expert", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-r2-external-system-"));
  const loggerProvider = createNoopLoggerProvider();
  const runtimeProfile = PragmaRuntimeProfileResourceSchema.parse({
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "RuntimeProfile",
    metadata: { id: "rdzgnq05qfqcpqcm", name: "Fixture runtime", description: "Fixture", tags: [] },
    spec: {
      adapter: "pragma.runtime.profile@v1",
      config: { runtimeId: "fake", providerId: "test", model: "test-model" },
    },
  });
  const system = PragmaExpertResourceSchema.parse({
    ...builtInAgentResource(STORE_REVISION_EXPERT_REF),
    spec: {
      scope: "Fixture",
      instructions: "Respond.",
      runtime: { ref: "runtime-profile:rdzgnq05qfqcpqcm" },
      capabilities: [],
      toolApprovals: {},
      contextStores: [],
      plugins: [],
      tools: [],
    },
  });
  const caller = PragmaExpertResourceSchema.parse({
    ...system,
    metadata: { ...system.metadata, id: "1xddvess309a6gme", name: "Caller" },
    spec: {
      ...system.spec,
      tools: [
        {
          adapter: "pragma.tool.call@v1",
          target: { ref: STORE_REVISION_EXPERT_REF },
          tool: { name: "call_system", description: "Call system", approval: "none" },
        },
      ],
    },
  });
  const project = createPragmaProjectStore({
    projectsPath: join(root, "projects"),
    reservedResourceRefs: new Set([STORE_REVISION_EXPERT_REF]),
    externalResources: () => [system],
    loggerProvider,
  });
  const snapshot = await project.publish({
    expectedRevision: 0,
    resources: [runtimeProfile, caller],
  });
  const missions = createMissionStore({ missionsPath: join(root, "missions") });
  const mission = await missions.create({
    workspace: { path: root, basename: "fixture" },
    goal: "Run caller",
    project: { id: snapshot.projectId, revision: snapshot.revision },
    executor: missionExecutorSnapshot(caller),
  });
  const runtime = defineRuntimeTestDriver<never, { id: string }>({
    descriptor: { id: "fake", kind: "test", displayName: "Fixture" },
    createSession: ({ systemSessionId }) => ({ id: systemSessionId }),
    readSession: (session) => ({ runtimeSessionId: session.id }),
    startTurn: (session) => ({ outputText: "done", runtimeSessionId: session.id }),
    mapEvent: () => ({ events: [] }),
  });
  const source = vi.fn(
    async ({
      mission: request,
      runtimes,
    }: Parameters<
      NonNullable<Parameters<typeof createDesktopMissionTestApplication>[0]["systemExecutorSource"]>
    >[0]) =>
      request.executor.ref === STORE_REVISION_EXPERT_REF
        ? {
            ref: STORE_REVISION_EXPERT_REF,
            expertResource: system,
            additionalResources: [runtimeProfile],
            environmentId: "desktop",
            definitionStateRoot: join(root, "built-ins"),
            workspace: root,
            pragmaHome: join(root, "home"),
            runtimes,
            loggerProvider,
          }
        : undefined,
  );
  const runner = createDesktopMissionTestApplication({
    missions,
    project,
    loggerProvider,
    capabilityStore: {} as CapabilityStore,
    capabilityCredentials: {} as CapabilityCredentialStore,
    capabilitiesPath: join(root, "capabilities"),
    pragmaHome: join(root, "home"),
    runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
    getSystemExecutorResource: (ref) => (ref === STORE_REVISION_EXPERT_REF ? system : undefined),
    getSystemExecutorFingerprint: (ref) =>
      ref === STORE_REVISION_EXPERT_REF ? "system-fixture" : undefined,
    systemExecutorSource: source,
  });
  try {
    await runner.startRun(mission.id);
    await vi.waitFor(
      async () => expect((await missions.get(mission.id)).execution?.status).toBe("succeeded"),
      { timeout: 10_000 },
    );
    expect(
      source.mock.calls.some(([input]) => input.mission.executor.ref === STORE_REVISION_EXPERT_REF),
    ).toBe(true);
    expect(
      (await project.getRevision(snapshot.revision)).resources.map(
        (resource) => resource.metadata.id,
      ),
    ).not.toContain(system.metadata.id);
  } finally {
    await runner.stopLocalController(mission.id);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

it("includes a real system customization Capability in warm identity and invalidates its active authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-system-capability-authority-"));
  try {
    const registry = createDesktopSystemExpertRegistry();
    const capabilityId = "11111111-1111-4111-8111-111111111111";
    await registry.update(STORE_REVISION_EXPERT_REF, {
      name: "Customized Revision",
      description: "Fixture",
      tags: [],
      additionalInstructions: "",
      capabilities: [{ kind: "tools", capabilityId, toolNames: ["search_docs"] }],
      toolApprovals: {},
      plugins: [],
      contextStoreMounts: [],
      resourceTools: [],
    });
    const expert = registry.getResource(STORE_REVISION_EXPERT_REF)!;
    const capabilityRef = expert.spec.capabilities.find(
      (binding) => binding.ref !== "capability:0000000000manage",
    )!.ref;
    expect(registry.getDependencyResource(capabilityRef)).toMatchObject({ kind: "Capability" });
    expect(registry.getDependencyResource("capability:0000000000000001")).toBeUndefined();
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const snapshot = await project.ensurePublished();
    const loggerProvider = createNoopLoggerProvider();
    const runtimes = createStaticRuntimeResolver({
      defaultRuntimeId: "fake",
      runtimes: [
        defineRuntimeTestDriver({
          descriptor: { id: "fake", kind: "test", displayName: "Fixture" },
          createSession: () => ({}),
          startTurn: () => ({ outputText: "done" }),
          mapEvent: () => ({ events: [] }),
        }),
      ],
    });
    let activeRevision = 1;
    const resolve = vi.fn(async () => ({
      capabilityId,
      resolvedRevision: activeRevision,
      fingerprint: String(activeRevision).repeat(64),
    }));
    const compile = vi.fn();
    const service = createLocalHostMissionCompileService({
      environmentId: "desktop",
      pragmaHome: root,
      loggerProvider,
      revisionSource: {
        getRevision: async (_id, revision) => await project.getRevision(revision),
        withProject: async (pin, operation) => {
          const opened = await project.openRevision(pin.revision);
          try {
            return await operation(opened);
          } finally {
            await opened.dispose();
          }
        },
      },
      capabilityAuthority: { getCapabilityId: parseDesktopCapabilityBindingRef, resolve },
      adapterHost: () => ({
        environmentId: "desktop",
        projectRoot: root,
        resolveBinding: async (ref) => ({
          ref,
          revision: String(activeRevision),
          fingerprint: String(activeRevision).repeat(64),
          value: { contribution: { tools: [] } },
        }),
        resolveSecret: async () => undefined,
        resolveArtifact: async () => {
          throw new Error("Unexpected artifact.");
        },
      }),
      onCompile: compile,
      systemExecutors: {
        getResource: registry.getResource,
        getDependencyResource: registry.getDependencyResource,
        fingerprint: registry.fingerprint,
        prepare: async (request, _runtimes, _purpose, adapterHost) =>
          request.executor.ref === STORE_REVISION_EXPERT_REF
            ? {
                ref: STORE_REVISION_EXPERT_REF,
                expertResource: expert,
                adapterHost,
                additionalResources: registry.getAdditionalResources(STORE_REVISION_EXPERT_REF),
                environmentId: "desktop",
                definitionStateRoot: join(root, "built-ins"),
                workspace: root,
                pragmaHome: root,
                runtimes,
                loggerProvider,
              }
            : undefined,
      },
    });
    const request = {
      id: "custom-system-authority",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: {
        kind: "expert",
        ref: canonicalPragmaResourceRef(expert),
        name: expert.metadata.name,
      },
      workspace: { path: root },
      contextMounts: [],
    };
    const initial = await service.prepare(service.createRequestScope(request), runtimes);
    const compilation = await initial.ensureCompiled();
    expect(compilation.capabilities).toEqual([
      { capabilityId, resolvedRevision: 1, fingerprint: "1".repeat(64) },
    ]);
    const owner = { hasOwner: true, ...compilation };
    expect(
      (await service.prepare(service.createRequestScope(request), runtimes, owner)).cacheHit,
    ).toBe(true);
    expect(compile).toHaveBeenCalledTimes(1);
    const registryFingerprint = registry.fingerprint(STORE_REVISION_EXPERT_REF);
    activeRevision = 2;
    const changed = await service.prepare(service.createRequestScope(request), runtimes, owner);
    expect(registry.fingerprint(STORE_REVISION_EXPERT_REF)).toBe(registryFingerprint);
    expect(changed.cacheHit).toBe(false);
    expect(changed.definitionChanged).toBe(true);
    expect(changed.identity).not.toBe(compilation.identity);
    expect(changed.capabilities).toEqual([
      { capabilityId, resolvedRevision: 2, fingerprint: "2".repeat(64) },
    ]);
    expect(compile).toHaveBeenCalledTimes(2);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

it.each(["secret", "plugin"] as const)(
  "recompiles a retained Desktop owner when its %s authority rotates",
  async (authority) => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-secret-owner-"));
    const loggerProvider = createNoopLoggerProvider();
    const runtimeProfile = PragmaRuntimeProfileResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "RuntimeProfile",
      metadata: { id: "rdzgnq05qfqcpqcm", name: "Fixture", description: "Fixture", tags: [] },
      spec: {
        adapter: "pragma.runtime.profile@v1",
        config: { runtimeId: "fake", providerId: "test", model: "test-model" },
      },
    });
    const capability = PragmaCapabilityResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Capability",
      metadata: { id: "pcr7npvx0gv8fpka", name: "HTTP fixture", description: "Fixture", tags: [] },
      spec: {
        adapter: "pragma.capability.http@v1",
        binding: "binding:inline.http",
        config: {
          serverKey: "fixture",
          tools: [
            { name: "read", description: "Read", method: "GET", path: "/read", parameters: [] },
          ],
        },
      },
    });
    const expert = PragmaExpertResourceSchema.parse({
      ...builtInAgentResource(STORE_REVISION_EXPERT_REF),
      metadata: {
        ...builtInAgentResource(STORE_REVISION_EXPERT_REF).metadata,
        id: "1xddvess309a6gme",
        name: "Secret owner",
      },
      spec: {
        scope: "Fixture",
        instructions: "Respond.",
        runtime: { ref: "runtime-profile:rdzgnq05qfqcpqcm" },
        capabilities: [{ ref: "capability:pcr7npvx0gv8fpka", kind: "tools" }],
        toolApprovals: {},
        contextStores: [],
        plugins: [],
        tools: [],
      },
    });
    const pluginRoot = join(root, "plugin");
    let plugins: Pick<PluginStore, "inspect" | "resolve"> | undefined;
    if (authority === "plugin") {
      const manifest = {
        schemaVersion: "pragma.plugin/v2",
        id: "example",
        version: "1.0.0",
        name: "Example",
        description: "Owner fixture",
        tags: [],
        runtime: { type: "expert-agent-plugin", entry: "index.mjs", trust: "trusted-host" },
        capabilities: [],
        configuration: { type: "object", properties: {}, additionalProperties: false },
        permissions: { filesystem: [], shell: [], network: [], environment: [] },
      };
      await mkdir(pluginRoot);
      await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify(manifest));
      await writeFile(
        join(pluginRoot, "package.json"),
        JSON.stringify({ name: "example", version: "1.0.0", type: "module" }),
      );
      await writeFile(
        join(pluginRoot, "index.mjs"),
        `export default { id: "example", name: "Example", description: "Owner fixture", version: "1.0.0", tags: [], manifest: ${JSON.stringify(manifest)}, setup: () => ({}) };\n`,
      );
      const resolved = async () => ({
        ref: "plugin:example@1.0.0" as const,
        source: pluginRoot,
        packageFingerprint: await createExpertAgentPluginPackageFingerprint(pluginRoot),
        verificationFingerprint: "c".repeat(64),
        // Model the Desktop managed package port. Immutable user packages
        // correctly reject changing bytes under the same id/version.
        cachePolicy: "host-managed" as const,
        userConfig: {},
      });
      plugins = {
        resolve: vi.fn(resolved),
        inspect: vi.fn(async () => ({
          ...(await resolved()),
          status: "ready" as const,
          issues: [],
        })),
      };
      expert.spec.plugins = [{ ref: "plugin:example@1.0.0" }];
    }
    const project = createPragmaProjectStore({
      projectsPath: join(root, "projects"),
      loggerProvider,
    });
    const published = await project.publish({
      expectedRevision: 0,
      resources: [runtimeProfile, capability, expert],
    });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "fixture" },
      goal: "Read",
      project: { id: published.projectId, revision: published.revision },
      executor: missionExecutorSnapshot(expert),
    });
    let secret: string | undefined = "credential-one";
    const reads = vi.fn(async () => secret);
    const fingerprints = vi.fn(async () =>
      createHash("sha256")
        .update(secret ?? "missing")
        .digest("hex"),
    );
    const runtime = defineRuntimeTestDriver<never, { id: string }>({
      descriptor: { id: "fake", kind: "test", displayName: "Fixture" },
      createSession: ({ systemSessionId }) => ({ id: systemSessionId }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn: (session) => ({ outputText: "done", runtimeSessionId: session.id }),
      mapEvent: () => ({ events: [] }),
    });
    const executions = createSqliteExecutionStore({ pragmaHome: join(root, "home") });
    const runner = createDesktopMissionTestApplication({
      missions,
      executionStore: executions,
      project,
      loggerProvider,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome: join(root, "home"),
      runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
      ...(plugins === undefined ? {} : { plugins: plugins as PluginStore }),
      resolveSecret: reads,
      secretFingerprint: fingerprints,
      adapterHostForMission: (_mission, fallback) => ({
        ...fallback,
        resolveBinding: async (ref) =>
          ref === "binding:inline.http"
            ? {
                ref,
                revision: "1",
                fingerprint: "b".repeat(64),
                value: {
                  baseUrl: "https://example.test",
                  auth: { type: "bearer", secretRef: "secret.inline-http" },
                },
              }
            : await fallback.resolveBinding(ref),
      }),
    });
    const settle = async () =>
      await vi.waitFor(
        async () => expect((await missions.get(mission.id)).execution?.status).toBe("succeeded"),
        { timeout: 10_000 },
      );
    try {
      await runner.startRun(mission.id);
      await settle();
      const initialState = (await missions.get(mission.id)).execution!;
      const initialSession = initialState.sessionId;
      const initialEnvironment = (await executions.get(initialState.id))?.environment;
      expect(initialEnvironment).toBeDefined();
      reads.mockClear();
      if (plugins !== undefined) vi.mocked(plugins.resolve).mockClear();
      await runner.sendMessage({ id: mission.id, requestId: randomUUID(), content: "Warm" });
      await settle();
      expect((await missions.get(mission.id)).execution?.sessionId).toBe(initialSession);
      expect(reads).not.toHaveBeenCalled();
      if (plugins !== undefined) {
        expect(plugins.resolve).not.toHaveBeenCalled();
        await appendFile(join(pluginRoot, "index.mjs"), "\n// package rotation\n");
      } else secret = "credential-two";
      await runner.sendMessage({ id: mission.id, requestId: randomUUID(), content: "Rotated" });
      await settle();
      expect(reads).toHaveBeenCalled();
      expect((await missions.get(mission.id)).execution?.sessionId).not.toBe(initialSession);
      const currentExecution = (await missions.get(mission.id)).execution!;
      expect((await executions.get(currentExecution.id))?.environment?.fingerprint).not.toBe(
        initialEnvironment?.fingerprint,
      );
      expect((await executions.get(initialState.id))?.environment).toEqual(initialEnvironment);
      if (plugins !== undefined) {
        expect(plugins.resolve).toHaveBeenCalled();
        await rm(pluginRoot, { recursive: true });
      } else secret = undefined;
      await expect(
        runner.sendMessage({ id: mission.id, requestId: randomUUID(), content: "Deleted" }),
      ).rejects.toThrow();
      expect(fingerprints).toHaveBeenCalledWith("secret.inline-http");
    } finally {
      await runner.stopLocalController(mission.id);
      executions.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  },
  30_000,
);
