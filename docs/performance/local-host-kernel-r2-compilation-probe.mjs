import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, URL } from "node:url";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { setTimeout } from "node:timers";

// Run serially, after building the selected checkout:
// pnpm exec tsx docs/performance/local-host-kernel-r2-compilation-probe.mjs \
//   --checkout /path/to/checkout --samples 20 --output /tmp/r2-compile.json
// The same script runs against main and R2. It uses isolated real Host stores
// and a fake Runtime; it does not measure models, renderer, or product acceptance.
const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2)
  argumentsByName.set(process.argv[index], process.argv[index + 1]);
const checkout = resolve(argumentsByName.get("--checkout") ?? process.cwd());
const output = resolve(argumentsByName.get("--output") ?? "/tmp/pragma-r2-compilation.json");
const samples = Number(argumentsByName.get("--samples") ?? 20);
const scenarios = [
  "warm",
  "permission-invalidation",
  "model-invalidation",
  "capability-invalidation",
  "credential-invalidation",
  "system-invalidation",
  "context-mount-invalidation",
];
const scenario = argumentsByName.get("--scenario");
if (scenario !== undefined && !scenarios.includes(scenario)) throw new Error("Unknown --scenario.");
if (!Number.isSafeInteger(samples) || samples < 1) throw new Error("--samples must be positive.");
const load = (path) => import(pathToFileURL(join(checkout, path)).href);
const core = await load("packages/core/dist/index.js");
const host = await load("packages/local-host/dist/index.js");
const testing = await load("packages/core/dist/testing/index.js");
const ast = await load("packages/interpreter/dist/ast/index.js");
const builtIns = await load("packages/built-in-agents/dist/index.js");
const { PragmaProjectImpl } = await load("packages/interpreter/dist/compiler/project-instance.js");
const interpreter = await load("packages/interpreter/dist/index.js");
const { createCapabilityStore } = await load(
  "apps/desktop/src/main/features/capabilities/capability-store.ts",
);
const { createContextStoreStore } = await load(
  "apps/desktop/src/main/features/context-stores/context-store-store.ts",
);
const { desktopCapabilityBindingRef } = await load(
  "apps/desktop/src/main/platform/bindings/desktop-binding-ref.ts",
);
const { referencedPragmaResourceRefs } = await load(
  "apps/desktop/src/main/features/projects/pragma-resource-references.ts",
);
const { getTargetRuntimeAvailability } = await load(
  "apps/desktop/src/main/features/runtimes/runtime-availability.ts",
);
const { createRuntimeEnvironmentService } = await load(
  "apps/desktop/src/main/features/runtimes/runtime-environment-service.ts",
);
const { createRuntimeEnvironmentStore } = await load(
  "apps/desktop/src/main/features/runtimes/runtime-environment-store.ts",
);
const { createPragmaProjectStore } = await load(
  "apps/desktop/src/main/features/projects/pragma-project-store.ts",
);
const { createMissionStore } = await load(
  "apps/desktop/src/main/features/missions/mission-store.ts",
);
const { createMissionRunner } = await load(
  "apps/desktop/src/main/features/missions/mission-runner.ts",
);
const { missionExecutorSnapshot } = await load("apps/desktop/src/shared/contracts/index.ts");
const root = await mkdtemp(join(tmpdir(), "pragma-r2-compilation-"));
const sourcePaths = [
  "apps/desktop/src/main/features/missions/mission-runner-composition.ts",
  "packages/local-host/src/missions/compile-service.ts",
  "packages/local-host/src/missions/runtime-readiness.ts",
  "packages/local-host/src/project-catalog.ts",
  "packages/local-host/src/built-in-executors.ts",
  "packages/local-host/src/node-mission-compiler.ts",
  "packages/local-host/src/resources/resolvers.ts",
  "packages/local-host/src/resources/capability-reader.ts",
  "packages/local-host/src/resources/context-store-reader.ts",
  "apps/desktop/src/main/features/projects/pragma-project-store.ts",
  "apps/desktop/src/main/features/runtimes/runtime-availability.ts",
  "apps/desktop/src/main/features/runtimes/runtime-environment-service.ts",
  "packages/interpreter/src/compiler/project-compile.ts",
  "packages/built-in-agents/src/builtin.ts",
];
const digest = async () => {
  const hash = createHash("sha256");
  const files = [];
  for (const path of sourcePaths) {
    try {
      const contents = await readFile(join(checkout, path));
      files.push(path);
      hash.update(path).update("\0").update(contents).update("\0");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { sha256: hash.digest("hex"), files };
};
const report = {
  schemaVersion: "pragma.r2-compilation-probe/v1",
  startedAt: new Date().toISOString(),
  node: process.version,
  cpu: cpus()[0]?.model,
  probeSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim(),
  sourceBefore: await digest(),
  scope:
    "Desktop Mission composition, isolated real Project/Mission/Capability/ContextStore/SQLite stores, fake Runtime and fixture verification/credential ports. Cold first run, retained-owner send, Capability/credential/system/model/permission/Context mount invalidation. No real model, renderer, Memory/Automation background load or performance acceptance.",
  counterMeaning:
    "Read counts are API calls, not physical I/O. projectHeadReads wraps ProjectStore.get. dslCompilerCalls wraps the real Interpreter PragmaProjectImpl.compile prototype for both project and built-in executors; storeCompileCalls/openedProjectCompileCalls identify entrypoints and must not be added to dslCompilerCalls. Cache flags and phases come from production logs. Readiness traverses the actual target closure on each side but Runtime health is a fixture port; plugin reads remain zero because this fixture declares no plugin.",
  scenario: scenario ?? "all",
  samplesPerScenario: samples,
  operations: [],
  assertions: [],
  errors: [],
};
let counters;
let phases;
let runner;
let executionStore;
const missionIds = [];
const instrument = (target, name, counter, after) => {
  if (typeof target[name] !== "function") return;
  const original = target[name].bind(target);
  target[name] = async (...args) => {
    if (counters) counters[counter]++;
    const result = await original(...args);
    return after ? after(result) : result;
  };
};
const originalDslCompile = PragmaProjectImpl.prototype.compile;
PragmaProjectImpl.prototype.compile = async function (...args) {
  if (counters) counters.dslCompilerCalls++;
  return await originalDslCompile.apply(this, args);
};
const untilSettled = async (missions, id, previousExecution) => {
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    const mission = await missions.get(id);
    if (mission.execution?.id !== previousExecution && mission.execution?.status === "succeeded")
      return mission;
    if (mission.execution?.status === "failed") throw new Error("Fake Runtime Mission failed.");
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error("Mission did not settle within 20 seconds.");
};
try {
  await mkdir(join(root, "workspace"), { recursive: true });
  const systemRef = builtIns.STORE_REVISION_EXPERT_REF;
  const project = createPragmaProjectStore({
    projectsPath: join(root, "projects"),
    reservedResourceRefs: new Set([systemRef]),
  });
  let credentialGeneration = 1;
  const credentials = {
    get: async () => undefined,
    overlay: () => ({ get: async () => undefined }),
    fingerprint: async () => {
      if (counters) counters.credentialFingerprints++;
      return `fixture-credential-generation-${credentialGeneration}`;
    },
    prepareMany: async () => undefined,
    activate: async () => undefined,
    finalize: async () => undefined,
    rollback: async () => undefined,
    pending: async () => undefined,
    removeCapability: async () => undefined,
  };
  const commitFixtureMutation = async (input) => {
    await input.validateCurrent?.();
    await input.prepareCredentials?.();
    return await input.commit();
  };
  const capabilities = createCapabilityStore({
    capabilitiesPath: join(root, "capabilities"),
    credentials,
    verify: async (definition) => ({
      definition,
      health: { status: "ready", checkedAt: new Date().toISOString() },
    }),
    mutations: {
      publish: commitFixtureMutation,
      publishHealth: commitFixtureMutation,
      mutate: commitFixtureMutation,
    },
    isReferenced: async () => false,
  });
  const makeCapabilityDefinition = (version) => ({
    kind: "code_service",
    name: "Fixture calculator",
    description: "Isolated probe tool",
    language: "javascript",
    timeoutMs: 1_000,
    tool: {
      name: "compile_probe",
      description: "Return a fixture value",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: {
        type: "object",
        properties: { version: { type: "number" } },
        required: ["version"],
        additionalProperties: false,
      },
      source: `function main() { return { version: ${version} }; }`,
    },
  });
  const capability = await capabilities.create(
    { definition: makeCapabilityDefinition(1), credentials: {} },
    { id: "00000000-0000-4000-8000-000000000001" },
  );
  const capabilityResourceId = "pcr7npvx0gv8fpka";
  instrument(capabilities, "resolveActive", "activeCapabilityReads");
  const contextStores = createContextStoreStore({ storesPath: join(root, "context-stores") });
  const contextA = await contextStores.create({
    mode: "blank",
    name: "Fixture A",
    description: "Probe Context A",
  });
  const contextB = await contextStores.create({
    mode: "blank",
    name: "Fixture B",
    description: "Probe Context B",
  });
  await contextStores.createFile(contextA.id, "rules.md", "Fixture A");
  await contextStores.createFile(contextB.id, "rules.md", "Fixture B");
  instrument(contextStores, "get", "contextStoreReads");
  const expert = {
    apiVersion: ast.PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Expert",
    metadata: {
      id: "1xddvess309a6gme",
      avatarId: "pragma.avatar.expert.default",
      name: "Compilation probe",
      description: "Isolated compilation fixture",
      tags: [],
    },
    spec: {
      scope: "Probe",
      instructions: "Return done.",
      runtime: { ref: "runtime-profile:rdzgnq05qfqcpqcm" },
      capabilities: [
        { ref: `capability:${capabilityResourceId}`, kind: "tools", tools: ["compile_probe"] },
      ],
      toolApprovals: { compile_probe: "none" },
      contextStores: [],
      plugins: [],
      tools: [
        {
          adapter: "pragma.tool.call@v1",
          target: { ref: systemRef },
          tool: {
            name: "call_system_probe",
            description: "Call fixture system resource",
            approval: "ask",
          },
        },
      ],
    },
  };
  const snapshot = await project.publish({
    expectedRevision: 0,
    resources: [
      expert,
      {
        apiVersion: ast.PRAGMA_DSL_WRITE_API_VERSION,
        kind: "Capability",
        metadata: {
          id: capabilityResourceId,
          name: "Fixture calculator",
          description: "Isolated probe tool",
          tags: [],
        },
        spec: {
          adapter: "pragma.capability.host@v1",
          binding: desktopCapabilityBindingRef(capability.manifest.id),
          config: { key: capability.manifest.id },
        },
      },
      {
        apiVersion: ast.PRAGMA_DSL_WRITE_API_VERSION,
        kind: "RuntimeProfile",
        metadata: {
          id: "rdzgnq05qfqcpqcm",
          name: "Probe Runtime",
          description: "Probe Runtime",
          tags: [],
        },
        spec: {
          adapter: "pragma.runtime.profile@v1",
          config: { runtimeId: "pi", providerId: "test", model: "test-model" },
        },
      },
    ],
  });
  instrument(project, "getRevision", "projectRevisionReads");
  instrument(project, "get", "projectHeadReads");
  instrument(project, "compile", "storeCompileCalls");
  instrument(project, "openRevision", "projectOpens", (opened) => {
    instrument(opened, "compile", "openedProjectCompileCalls");
    return opened;
  });
  const missions = createMissionStore({ missionsPath: join(root, "missions") });
  const runtime = testing.defineRuntimeTestDriver({
    descriptor: { id: "pi", kind: "fake", displayName: "Fake" },
    features: testing.createRuntimeTestFeatures({
      enabled: ["availability", "modelDiscovery", "resume", "close", "mcp", "permissions"],
    }),
    canUse: async () => {
      if (counters) counters.runtimeHealthProbes++;
      return { usable: true };
    },
    createSession: () => ({ id: randomUUID() }),
    restoreSession: (context) => ({ id: context.request.runtimeSession.id }),
    readSession: (session) => ({ runtimeSessionId: session.id }),
    startTurn: () => ({ outputText: "done" }),
    closeSession: () => undefined,
    listModels: async () => {
      if (counters) counters.modelCatalogReads++;
      return ["test-model", ...Array.from({ length: samples }, (_, index) => `probe-${index}`)].map(
        (id) => ({
          id,
          displayName: id,
          provider: { kind: "runtime-managed", id: "test", displayName: "Fixture" },
          thinking: { supportedLevels: [{ value: "low", label: "Low" }] },
        }),
      );
    },
    mapEvent: () => ({ events: [] }),
  });
  const runtimes = createRuntimeEnvironmentService({
    store: createRuntimeEnvironmentStore({
      pragmaHome: join(root, "state"),
      builtIns: [
        {
          schemaVersion: "pragma.runtime-environment/v1",
          id: "pi",
          adapter: { id: "probe.runtime", version: "v1" },
          displayName: "Fake",
          origin: "built-in",
          config: {},
        },
      ],
    }),
    factories: [{ id: "probe.runtime", version: "v1", create: () => runtime }],
  });
  let systemVersion = 1;
  const systemResource = () => ({
    ...expert,
    metadata: {
      ...expert.metadata,
      id: systemRef.slice("expert:".length),
      name: "System compilation fixture",
    },
    spec: {
      ...expert.spec,
      instructions: `System fixture version ${systemVersion}`,
      capabilities: [],
      toolApprovals: {},
      tools: [],
    },
  });
  const runtimeResource = snapshot.resources.find((resource) => resource.kind === "RuntimeProfile");
  const systemSource = (mission, systemRuntimes, adapterHost) => {
    if (mission.executor.ref !== systemRef) return undefined;
    return {
      ref: systemRef,
      environmentId: "desktop",
      definitionStateRoot: join(root, "definitions"),
      workspace: mission.workspace.path,
      pragmaHome: join(root, "state"),
      runtimes: systemRuntimes,
      adapterHost,
      loggerProvider,
      expertResource: systemResource(),
      additionalResources: [runtimeResource],
    };
  };
  const loggerProvider = core.createLoggerProvider({
    handler: {
      write: (record) => {
        if (phases && ["mission.prepare_phase", "mission.performance"].includes(record.event))
          phases.push({ event: record.event, ...record.attributes });
      },
    },
  });
  runner = createMissionRunner({
    missions,
    project,
    capabilityStore: capabilities,
    capabilityCredentials: credentials,
    contextStores,
    capabilitiesPath: join(root, "capabilities"),
    pragmaHome: join(root, "state"),
    runtimes,
    getSystemExecutorResource: (ref) => (ref === systemRef ? systemResource() : undefined),
    getSystemExecutorFingerprint: (ref) =>
      ref === systemRef
        ? builtIns.builtInAgentFingerprint(systemRef, systemResource(), [runtimeResource])
        : undefined,
    ...(report.sourceBefore.files.includes("packages/local-host/src/missions/compile-service.ts")
      ? {
          systemExecutorSource: async ({ mission, runtimes, adapterHost }) =>
            systemSource(mission, runtimes, adapterHost),
        }
      : {
          compileSystemExecutor: async ({ mission, runtimes, adapterHost }) => {
            const source = systemSource(mission, runtimes, adapterHost);
            return source === undefined ? undefined : await builtIns.compileBuiltInAgent(source);
          },
        }),
    assertExecutorReady: async (ref, scope) => {
      if (counters) counters.readinessRequests++;
      const revision = scope === undefined ? await project.get() : await scope.getRevision();
      const byRef = new Map(
        revision.resources.map((resource) => [
          interpreter.canonicalPragmaResourceRef(resource),
          resource,
        ]),
      );
      const visited = new Set();
      const pending = [ref];
      const targetRuntimes = new Set();
      while (pending.length) {
        const current = pending.pop();
        if (visited.has(current)) continue;
        visited.add(current);
        const resource =
          byRef.get(current) ?? (current === systemRef ? systemResource() : undefined);
        if (!resource) continue;
        if (resource.kind === "RuntimeProfile" && resource.spec.config.runtimeId)
          targetRuntimes.add(resource.spec.config.runtimeId);
        pending.push(...referencedPragmaResourceRefs([resource]));
      }
      const availability = await getTargetRuntimeAvailability(runtimes, [...targetRuntimes]);
      if (availability.some((value) => value.status !== "available"))
        throw new Error("Fixture Runtime unavailable.");
    },
    hostContextStores: [{ namespace: "memory", store: new core.InMemoryContextStore() }],
    loggerProvider,
    executionStore: (executionStore ??= host.createSqliteExecutionStore({
      pragmaHome: join(root, "state"),
    })),
  });
  const measure = async (group, sample, mission, operation) => {
    const previousExecution = (await missions.get(mission.id)).execution?.id;
    counters = {
      projectRevisionReads: 0,
      projectHeadReads: 0,
      projectOpens: 0,
      storeCompileCalls: 0,
      openedProjectCompileCalls: 0,
      activeCapabilityReads: 0,
      credentialFingerprints: 0,
      contextStoreReads: 0,
      dslCompilerCalls: 0,
      readinessRequests: 0,
      runtimeHealthProbes: 0,
      modelCatalogReads: 0,
      pluginReads: 0,
    };
    phases = [];
    const started = performance.now();
    await operation();
    const preparationMs = performance.now() - started;
    const reads = { ...counters };
    const preparationPhases = [...phases];
    counters = undefined;
    phases = undefined;
    const settled = await untilSettled(missions, mission.id, previousExecution);
    report.operations.push({
      group,
      sample,
      preparationMs,
      counters: reads,
      phases: preparationPhases,
      sourcePin: settled.project,
      compilationEnvironment: {
        fingerprint: settled.execution?.environmentFingerprint,
        capabilities: settled.execution?.resolvedCapabilities,
      },
    });
    return settled;
  };
  let warmMission;
  const coldSamples = scenario === undefined ? samples : 1;
  for (let sample = 0; sample < coldSamples; sample++) {
    const mission = await missions.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Compile isolated probe",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: missionExecutorSnapshot(expert),
    });
    missionIds.push(mission.id);
    warmMission = await measure("cold", sample, mission, () => runner.run(mission.id));
    if (sample !== coldSamples - 1) await runner.stopLocalController(mission.id);
  }
  for (const group of scenario === undefined ? scenarios : [scenario]) {
    for (let sample = 0; sample < samples; sample++) {
      if (group !== "warm") {
        const current = await missions.get(warmMission.id);
        await missions.updateOptions(warmMission.id, {
          toolPermissionMode:
            group === "permission-invalidation"
              ? current.toolPermissionMode === "full-access"
                ? "request-approval"
                : "full-access"
              : current.toolPermissionMode,
          modelOverride:
            group === "model-invalidation"
              ? { providerId: "test", modelId: `probe-${sample}`, thinkingLevel: "low" }
              : current.modelOverride,
        });
        if (group === "capability-invalidation") {
          const active = await capabilities.get(capability.manifest.id);
          const next = await capabilities.update({
            id: capability.manifest.id,
            baseRevision: active.manifest.latestRevision,
            definition: makeCapabilityDefinition(active.manifest.latestRevision + 1),
            credentials: {},
          });
          await capabilities.ensureActiveRevision(
            capability.manifest.id,
            next.manifest.latestRevision,
          );
        }
        if (group === "credential-invalidation") credentialGeneration++;
        if (group === "system-invalidation") systemVersion++;
        if (group === "context-mount-invalidation")
          await missions.updateContextMounts(warmMission.id, [
            { kind: "context-store", storeId: sample % 2 === 0 ? contextA.id : contextB.id },
          ]);
      }
      warmMission = await measure(group, sample, warmMission, () =>
        runner.sendMessage({ id: warmMission.id, content: "Continue", requestId: randomUUID() }),
      );
    }
  }
  for (const operation of report.operations) {
    const expectedCompile = operation.group !== "warm";
    report.assertions.push({
      group: operation.group,
      sample: operation.sample,
      id: expectedCompile ? "expected_compile_miss" : "warm_owner_skips_dsl_compile",
      passed: expectedCompile
        ? operation.counters.dslCompilerCalls > 0
        : operation.counters.dslCompilerCalls === 0,
      actual: operation.counters.dslCompilerCalls,
    });
    report.assertions.push({
      group: operation.group,
      sample: operation.sample,
      id: "source_pin_preserved",
      passed:
        operation.sourcePin.id === snapshot.projectId &&
        operation.sourcePin.revision === snapshot.revision,
    });
    if (report.sourceBefore.files.includes("packages/local-host/src/missions/compile-service.ts")) {
      report.assertions.push({
        group: operation.group,
        sample: operation.sample,
        id: "pinned_revision_shared_with_readiness",
        passed:
          operation.counters.projectHeadReads === 0 &&
          operation.counters.projectRevisionReads === 1,
        actual: {
          headReads: operation.counters.projectHeadReads,
          pinnedReads: operation.counters.projectRevisionReads,
        },
      });
    }
  }
  if (report.assertions.some((assertion) => !assertion.passed)) process.exitCode = 1;
} catch (error) {
  report.errors.push({
    name: error.name,
    message: error.message.replaceAll(root, "[isolated-root]"),
  });
  process.exitCode = 1;
} finally {
  PragmaProjectImpl.prototype.compile = originalDslCompile;
  if (runner)
    for (const id of missionIds) {
      try {
        await runner.stopLocalController(id);
      } catch (error) {
        report.errors.push({ stage: "cleanup", name: error.name, message: error.message });
        process.exitCode = 1;
      }
    }
  await executionStore?.close();
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  report.sourceAfter = await digest();
  report.sourceUnchanged = report.sourceBefore.sha256 === report.sourceAfter.sha256;
  if (!report.sourceUnchanged) process.exitCode = 1;
  report.completedAt = new Date().toISOString();
  report.completeProbePassed = process.exitCode !== 1;
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(`${output}\n`);
}
