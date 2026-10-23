import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SKILL_REVISION_EXPERT_REF,
  STORE_REVISION_EXPERT_REF,
  builtInAgentResource,
} from "@pragma/built-in-agents";
import {
  createNoopLoggerProvider,
  createStaticRuntimeResolver,
  createExpertAgentPluginPackageFingerprint,
  resolveExecutionTools,
  type ExpertAgentAutomaticHumanInteractionHandler,
  type RuntimeNativeSessionContext,
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
import type { PluginStore } from "@pragma/local-host/deployment";
import type { CapabilityStore } from "@pragma/local-host/deployment";
import type { CapabilityCredentialStore } from "../capabilities/capability-credential-store.ts";
import { createPragmaProjectStore } from "@pragma/local-host/deployment";
import { createMissionStore } from "@pragma/local-host";
import { createDesktopMissionTestApplication } from "./fixtures/desktop-mission-test-application.ts";
import { createDesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import { parseDesktopCapabilityBindingRef } from "../../platform/bindings/desktop-binding-ref.ts";
import {
  isMemoryRevisionPlanningRun,
  memoryRevisionPlanningResource,
} from "../memory/memory-revision-planning-resource.ts";
import { createDesktopAdapterHost } from "./mission-adapter-host.ts";

it.each([
  [STORE_REVISION_EXPERT_REF, "knowledge-plan"],
  [SKILL_REVISION_EXPERT_REF, "skill-plan"],
] as const)(
  "keeps %s Memory planning noninteractive on first execution, manual retry and correction",
  async (ref, jobPrefix) => {
    const root = await mkdtemp(join(tmpdir(), "pragma-memory-planning-tools-"));
    const pragmaHome = join(root, "home");
    const resource = builtInAgentResource(ref);
    const original = structuredClone(resource);
    const planning = memoryRevisionPlanningResource(resource);
    let turns = 0;
    const observedTools: string[][] = [];
    const automaticInteraction = vi.fn<ExpertAgentAutomaticHumanInteractionHandler>(
      async (request) =>
        request.kind === "user_question"
          ? {
              kind: "user_question",
              answered: true,
              answers: { "Choose a target": "Existing target" },
            }
          : { kind: "tool_approval", approved: true, updatedInput: request.input },
    );
    const runtime = defineRuntimeTestDriver<never, { context: RuntimeNativeSessionContext }>({
      descriptor: { id: "fake", kind: "test", displayName: "Fixture" },
      createSession: (context) => ({ context }),
      readSession: () => ({ runtimeSessionId: "planning-native" }),
      startTurn: async (session) => {
        observedTools.push(
          resolveExecutionTools({
            agent: session.context.agent,
            getContext: () => session.context.runContext,
          }).tools.map((tool) => tool.name),
        );
        // Native callbacks bypass resolveExecutionTools, as in Claude ACP and
        // OpenCode. They must settle without falling into a human-input wait.
        const interact = session.context.request.humanInteractionHandler!;
        const question = await interact({
          kind: "user_question",
          toolName: "askUserQuestion",
          questions: [{ question: "Choose a target", header: "Target", kind: "text", options: [] }],
        });
        const approval = await interact({
          kind: "tool_approval",
          toolName: "native_write",
          input: {},
        });
        const planningTurn = turns < 3;
        expect(question).toMatchObject({ kind: "user_question", answered: !planningTurn });
        expect(approval).toMatchObject({ kind: "tool_approval", approved: !planningTurn });
        if (++turns === 1) throw new Error("planning_runtime_failure");
        return { outputText: '{"action":"skip"}', runtimeSessionId: "planning-native" };
      },
      mapEvent: () => ({ events: [] }),
    });
    const runtimes = createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" });
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const snapshot = await project.ensurePublished();
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const createPlanningMission = () =>
      missions.create({
        workspace: { path: root, basename: "fixture" },
        goal: "Plan from supplied Memory and return JSON",
        project: { id: snapshot.projectId, revision: snapshot.revision },
        executor: missionExecutorSnapshot(resource),
        origin: { type: "system-memory", jobId: `${jobPrefix}:${"a".repeat(64)}` },
        toolPermissionMode: "request-approval",
      });
    let mission = await createPlanningMission();
    const interactiveAdapterHost = createDesktopAdapterHost(
      {
        capabilityStore: {} as CapabilityStore,
        capabilityCredentials: {} as CapabilityCredentialStore,
        capabilitiesPath: join(root, "capabilities"),
        pragmaHome,
        pragmaManagement: { knowledgeRevisions: {} as never, skillRevisions: {} as never },
      },
      root,
    );
    const runner = createDesktopMissionTestApplication({
      missions,
      project,
      pragmaHome,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      runtimes,
      loggerProvider: createNoopLoggerProvider(),
      automaticHumanInteractionHandler: automaticInteraction,
      getSystemExecutorResource: () => resource,
      systemExecutorSource: async ({ mission: current }) => ({
        ref,
        expertResource: isMemoryRevisionPlanningRun(current.origin, current.executor.ref)
          ? planning
          : resource,
        adapterHost: interactiveAdapterHost,
        environmentId: "desktop-memory-revision-planning",
        definitionStateRoot: join(root, "definitions"),
        workspace: root,
        pragmaHome,
        runtimes,
        rootExecutionOverride: { runtimeId: "fake" },
      }),
    });
    const settle = async (status: "failed" | "succeeded", executionId?: string) => {
      await vi.waitFor(
        async () => {
          const current = await missions.get(mission.id);
          expect(current.execution?.status, current.execution?.error).toBe(status);
          if (executionId !== undefined) expect(current.execution?.id).toBe(executionId);
        },
        { timeout: 10_000 },
      );
      return (await missions.get(mission.id)).execution!;
    };
    try {
      await runner.startRun(mission.id);
      await settle("failed");
      // The planner removes each failed temporary Mission. A manual job retry
      // admits a fresh planning Mission through the same compilation path.
      await runner.delete(mission.id);
      mission = await createPlanningMission();
      await runner.startRun(mission.id);
      const retried = await settle("succeeded");
      const continued = await runner.continueInternalMemoryMission({
        id: mission.id,
        previousExecutionId: retried.id,
        requestId: randomUUID(),
        content: "Correct the planning response in the same conversation.",
      });
      const corrected = await settle("succeeded", continued.executionId);
      expect(corrected.sessionId).toBe(retried.sessionId);
      expect(observedTools).toHaveLength(3);
      for (const tools of observedTools) expect(tools).not.toContain("askUserQuestion");
      expect(automaticInteraction).not.toHaveBeenCalled();
      expect(await runner.listHumanInteractions(mission.id)).toEqual([]);
      await runner.delete(mission.id);

      // Ordinary user revisions keep both managed tools and native interactions.
      mission = await missions.create({
        workspace: { path: root, basename: "fixture" },
        goal: "Revise interactively",
        project: { id: snapshot.projectId, revision: snapshot.revision },
        executor: missionExecutorSnapshot(resource),
      });
      await runner.startRun(mission.id);
      await settle("succeeded");
      expect(observedTools[3]).toContain("askUserQuestion");
      expect(automaticInteraction).toHaveBeenCalledTimes(2);
      expect(resource).toEqual(original);
    } finally {
      await runner.stopLocalController(mission.id);
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  },
  30_000,
);

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
  "refreshes %s authority while retaining the original Desktop Session",
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
      restoreSession: ({ request }) => ({ id: request.runtimeSession!.id }),
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
      expect((await missions.get(mission.id)).execution?.sessionId).toBe(initialSession);
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
