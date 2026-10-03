import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createNoopLoggerProvider,
  createStaticRuntimeResolver,
  defineExpert,
  fingerprintExpertExecutionDefinition,
  type ExpertDefinition,
  type RuntimeResolver,
} from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import {
  BUILT_IN_PRAGMA_REF,
  STORE_REVISION_EXPERT_REF,
  SKILL_REVISION_EXPERT_REF,
  builtInAgentResource,
  type BuiltInAgentRef,
} from "@pragma/built-in-agents";
import {
  canonicalPragmaResourceRef,
  formatPragmaYaml,
  loadPragmaProject,
  type CompiledResource,
  type InvocableResource,
  type PragmaAdapterHost,
  type PragmaProject,
  type PragmaExpertResource,
  type PragmaCompileOptions,
} from "@pragma/interpreter";
import { PragmaCapabilityResourceSchema } from "@pragma/interpreter/ast";
import { describe, expect, it, vi } from "vitest";

import {
  createLocalHostMissionCompileService,
  missionCompilationEnvironmentSnapshot,
  missionCompileContextMountsFingerprint,
  type LocalHostMissionCompileRequest,
  type LocalHostMissionRevision,
  type LocalHostMissionRevisionSource,
} from "../src/missions/compile-service.ts";
import { createPublishedProjectResources } from "./fixtures/published-project.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const capabilityId = "pcr7npvx0gv8fpka";

async function fixture(
  overrides: Partial<
    Parameters<typeof createLocalHostMissionCompileService<LocalHostMissionCompileRequest>>[0]
  > = {},
) {
  const resources = [...createPublishedProjectResources()];
  const expert = resources.find((resource) => resource.kind === "Expert")!;
  if (expert.kind !== "Expert") throw new Error("Missing Expert fixture.");
  expert.spec.capabilities = [{ ref: `capability:${capabilityId}`, kind: "tools" }];
  resources.push(
    PragmaCapabilityResourceSchema.parse({
      apiVersion: expert.apiVersion,
      kind: "Capability",
      metadata: { id: capabilityId, name: "Fixture tools", description: "Fixture tools", tags: [] },
      spec: {
        adapter: "pragma.capability.host@v1",
        binding: `binding:fixture.${capabilityId}`,
        config: { key: "fixture" },
      },
    }),
  );
  const request: LocalHostMissionCompileRequest = {
    id: "mission-a",
    project: { id: "studio", revision: 1 },
    executor: {
      kind: "expert",
      ref: canonicalPragmaResourceRef(expert),
      name: expert.metadata.name,
    },
    workspace: { path: "/isolated/mission-a" },
    toolPermissionMode: "request-approval",
    contextMounts: [],
  };
  const definition = await defineExpert({
    id: expert.metadata.id,
    name: expert.metadata.name,
    description: expert.metadata.description,
    tags: [],
    scope: "Fixture",
    workspace: request.workspace.path,
    loggerProvider: createNoopLoggerProvider(),
  });
  const compiled: CompiledResource<InvocableResource> = {
    ref: request.executor.ref as CompiledResource<InvocableResource>["ref"],
    value: definition,
    fingerprint: "d".repeat(64),
    projectFingerprint: "b".repeat(64),
    environmentFingerprint: {
      environmentId: "preserved-host-id",
      projectFingerprint: "b".repeat(64),
      value: "e".repeat(64),
      resources: [],
      plugins: [],
    },
    rootRuntimeId: "codex",
    dependencies: [],
  };
  const revision: LocalHostMissionRevision = {
    projectId: "studio",
    revision: 1,
    resources,
    projectFingerprint: "c".repeat(64),
    derivedProjectFingerprint: "b".repeat(64),
    snapshotHash: "f".repeat(64),
  };
  const getRevision = vi.fn(async () => revision);
  const compile = vi.fn(async (...input: [string?, PragmaCompileOptions?]) => {
    void input;
    return compiled;
  });
  const withProjectCalls = vi.fn();
  const withProject: LocalHostMissionRevisionSource["withProject"] = async (pin, run, snapshot) => {
    withProjectCalls(pin, run, snapshot);
    return await run({
      compile,
      entryFile: "/isolated/project/pragma.yaml",
    } as unknown as PragmaProject);
  };
  let active = { capabilityId, resolvedRevision: 1, fingerprint: "a".repeat(64) };
  const resolve = vi.fn(async (id: string) => {
    if (id !== capabilityId) throw new Error(`Unexpected Capability: ${id}`);
    return { ...active };
  });
  const adapterHost = vi.fn(async () => ({}) as PragmaAdapterHost);
  const phase = vi.fn();
  const systemFingerprints = new Map<string, string>();
  const service = createLocalHostMissionCompileService({
    revisionSource: { getRevision, withProject },
    environmentId: "preserved-host-id",
    adapterHost,
    capabilityAuthority: {
      getCapabilityId: (binding) =>
        binding.startsWith("binding:fixture.")
          ? binding.slice("binding:fixture.".length)
          : undefined,
      resolve,
    },
    onPhase: phase,
    systemExecutors: {
      fingerprint: (ref) => systemFingerprints.get(ref),
      prepare: async () => undefined,
    },
    ...overrides,
  });
  return {
    service,
    request,
    revision,
    compiled,
    getRevision,
    compile,
    withProject: withProjectCalls,
    resolve,
    adapterHost,
    phase,
    expert,
    systemFingerprints,
    runtimes: {} as RuntimeResolver,
    setActive: (value: typeof active) => (active = value),
  };
}

describe("Local Host Mission compile orchestration", () => {
  it("preserves real Interpreter definitions, hashes and pins for equivalent Host bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-r2-compile-equivalence-"));
    let project: PragmaProject | undefined;
    try {
      const resources = createPublishedProjectResources();
      const target = resources.find((resource) => resource.kind === "Expert")!;
      const entry = join(root, "pragma.yaml");
      await writeFile(
        entry,
        formatPragmaYaml({
          apiVersion: target.apiVersion,
          kind: "Bundle",
          imports: [],
          resources,
        }),
      );
      project = await loadPragmaProject(entry);
      const loggerProvider = createNoopLoggerProvider();
      const runtimes = createStaticRuntimeResolver({
        defaultRuntimeId: "codex",
        runtimes: [
          defineRuntimeTestDriver({
            descriptor: { id: "codex", kind: "test", displayName: "Codex fixture" },
            createSession: () => ({}),
            startTurn: () => ({ outputText: "" }),
            mapEvent: () => ({ events: [] }),
          }),
        ],
      });
      const adapterHost: PragmaAdapterHost = {
        environmentId: "equivalence",
        projectRoot: root,
        resolveArtifact: async () => {
          throw new Error("Fixture has no artifacts.");
        },
        resolveBinding: async () => undefined,
        resolveSecret: async () => undefined,
      };
      const ref = canonicalPragmaResourceRef(target) as CompiledResource<InvocableResource>["ref"];
      const direct = await project.compile<InvocableResource>(ref, {
        workspace: root,
        projectRoot: root,
        environmentId: "equivalence",
        adapterHost,
        runtimes,
        loggerProvider,
      });
      const request: LocalHostMissionCompileRequest = {
        id: "real-compile",
        project: { id: "studio", revision: 7 },
        executor: { kind: "expert", ref, name: target.metadata.name },
        workspace: { path: root },
        contextMounts: [],
      };
      const revision: LocalHostMissionRevision = {
        projectId: "studio",
        revision: 7,
        resources,
        projectFingerprint: direct.projectFingerprint,
      };
      const getRevision = vi.fn(async () => revision);
      const loaded = project;
      const service = createLocalHostMissionCompileService({
        environmentId: "equivalence",
        adapterHost: () => adapterHost,
        loggerProvider,
        revisionSource: { getRevision, withProject: async (_pin, run) => await run(loaded) },
      });
      const prepared = await service.compileStable(service.createRequestScope(request), runtimes);
      expect(prepared.compiled).toMatchObject({
        ref: direct.ref,
        fingerprint: direct.fingerprint,
        projectFingerprint: direct.projectFingerprint,
        environmentFingerprint: direct.environmentFingerprint,
        dependencies: direct.dependencies,
        rootRuntimeId: direct.rootRuntimeId,
      });
      expect(prepared.definitionFingerprint).toBe(
        fingerprintExpertExecutionDefinition(direct.value as ExpertDefinition),
      );
      expect(getRevision).toHaveBeenCalledExactlyOnceWith("studio", 7);
      expect(request.project).toEqual({ id: "studio", revision: 7 });
    } finally {
      await project?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("preserves the Desktop identity serialization and Execution environment hash", async () => {
    const f = await fixture();
    const scope = f.service.createRequestScope(f.request);
    const active = await f.service.capabilities(scope);
    // The field order and null rules are the original Desktop protocol input.
    const expected = hash({
      project: f.request.project,
      executor: f.request.executor,
      contextMounts: hash([]),
      systemExecutorFingerprints: [],
      toolPermissionMode: "request-approval",
      modelOverride: null,
      capabilities: active,
    });
    expect(await f.service.identity(scope, active)).toBe(expected);
    expect(missionCompilationEnvironmentSnapshot(f.compiled, active)).toEqual({
      fingerprint: hash({ compiledEnvironment: "e".repeat(64), capabilities: active }),
      resources: [
        { kind: "capability", id: capabilityId, revision: 1, fingerprint: "a".repeat(64) },
      ],
    });
    expect(missionCompilationEnvironmentSnapshot(f.compiled, active, [], [])).toEqual(
      missionCompilationEnvironmentSnapshot(f.compiled, active),
    );
  });

  it("shares one pinned Revision across readiness, identities and stable compilation", async () => {
    const f = await fixture();
    const scope = f.service.createRequestScope(f.request);
    await Promise.all([f.service.runtimeIds(scope), f.service.capabilities(scope)]);
    expect(await f.service.runtimeIds(scope)).toEqual(["codex"]);
    const result = await f.service.prepare(scope, f.runtimes);
    expect(result.cacheHit).toBe(false);
    expect(result.compiled).toBe(f.compiled);
    expect(f.getRevision).toHaveBeenCalledExactlyOnceWith("studio", 1);
    expect(f.compile).toHaveBeenCalledOnce();
    expect(f.withProject).toHaveBeenCalledWith(f.request.project, expect.any(Function), f.revision);
    expect(result.identity).toBe(await f.service.identity(scope, result.capabilities));
    expect((await result.ensureCompiled()).definitionFingerprint).toBe(
      fingerprintExpertExecutionDefinition(f.compiled.value as ExpertDefinition),
    );
    expect(f.compile).toHaveBeenCalledOnce();
    expect(f.revision.snapshotHash).toBe("f".repeat(64));
    expect(f.revision.projectFingerprint).toBe("c".repeat(64));
  });

  it("tracks transitive system fingerprints and ignores unrelated resource bindings", async () => {
    const f = await fixture();
    const systemRef = "expert:3sfd30h5017wd17d" as const;
    f.expert.spec.tools = [
      {
        adapter: "pragma.tool.call@v1",
        target: { ref: systemRef },
        tool: { name: "call_system", description: "Call system Expert", approval: "ask" },
      },
    ];
    f.systemFingerprints.set(systemRef, "system-version-1");
    const initial = await f.service.prepare(f.service.createRequestScope(f.request), f.runtimes);
    const identities = await f.service.identity(
      f.service.createRequestScope(f.request),
      initial.capabilities,
    );
    expect(identities).toBe(
      hash({
        project: f.request.project,
        executor: f.request.executor,
        contextMounts: hash([]),
        systemExecutorFingerprints: [[systemRef, "system-version-1"]],
        toolPermissionMode: "request-approval",
        modelOverride: null,
        capabilities: initial.capabilities,
      }),
    );
    f.resolve.mockClear();
    f.systemFingerprints.set(systemRef, "system-version-2");
    const changed = await f.service.prepare(f.service.createRequestScope(f.request), f.runtimes, {
      hasOwner: true,
      identity: initial.identity,
      secrets: initial.secrets,
      plugins: initial.plugins,
    });
    expect(changed.cacheHit).toBe(false);
    expect(changed.identity).not.toBe(initial.identity);
    expect(f.resolve.mock.calls.every(([id]) => id === capabilityId)).toBe(true);
  });

  it("checks mutable authority on a warm hit and defers successor compilation", async () => {
    const f = await fixture();
    const initial = await f.service.prepare(f.service.createRequestScope(f.request), f.runtimes);
    f.compile.mockClear();
    f.resolve.mockClear();
    f.getRevision.mockClear();
    const warm = await f.service.prepare(f.service.createRequestScope(f.request), f.runtimes, {
      hasOwner: true,
      identity: initial.identity,
      secrets: initial.secrets,
      plugins: initial.plugins,
    });
    expect(warm.cacheHit).toBe(true);
    expect(warm.compiled).toBeUndefined();
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith(capabilityId);
    expect(f.getRevision).toHaveBeenCalledOnce();
    expect(f.compile).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([warm.ensureCompiled(), warm.ensureCompiled()]);
    expect(first).toBe(second);
    expect(f.compile).toHaveBeenCalledOnce();
  });

  it("invalidates an owner identity for active revision, credentials, model, thinking, permissions and mounts", async () => {
    const f = await fixture();
    const initial = await f.service.prepare(f.service.createRequestScope(f.request), f.runtimes);
    const changes: LocalHostMissionCompileRequest[] = [
      { ...f.request, modelOverride: { providerId: "test", modelId: "model-a" } },
      {
        ...f.request,
        modelOverride: { providerId: "test", modelId: "model-a", thinkingLevel: "high" },
      },
      { ...f.request, toolPermissionMode: "full-access" },
      { ...f.request, contextMounts: [{ kind: "context-store", storeId: "j35188zs37g69g0n" }] },
    ];
    for (const request of changes) {
      const result = await f.service.prepare(f.service.createRequestScope(request), f.runtimes, {
        hasOwner: true,
        identity: initial.identity,
        secrets: initial.secrets,
        plugins: initial.plugins,
      });
      expect(result.cacheHit).toBe(false);
      expect(result.identity).not.toBe(initial.identity);
    }
    for (const active of [
      { capabilityId, resolvedRevision: 2, fingerprint: "a".repeat(64) },
      { capabilityId, resolvedRevision: 1, fingerprint: "9".repeat(64) },
    ]) {
      f.setActive(active);
      expect(
        (
          await f.service.prepare(f.service.createRequestScope(f.request), f.runtimes, {
            hasOwner: true,
            identity: initial.identity,
            secrets: initial.secrets,
            plugins: initial.plugins,
          })
        ).cacheHit,
      ).toBe(false);
    }
  });

  it("retries changing Capability authority at most three times without accepting an unstable result", async () => {
    const f = await fixture();
    let revision = 0;
    f.resolve.mockImplementation(async () => ({
      capabilityId,
      resolvedRevision: ++revision,
      fingerprint: "a".repeat(64),
    }));
    await expect(
      f.service.compileStable(f.service.createRequestScope(f.request), f.runtimes),
    ).rejects.toThrow("changed repeatedly");
    expect(f.compile).toHaveBeenCalledTimes(3);
    expect(f.resolve).toHaveBeenCalledTimes(6);
    expect(f.getRevision).toHaveBeenCalledOnce();
    f.resolve.mockImplementation(async () => ({
      capabilityId,
      resolvedRevision: 8,
      fingerprint: "a".repeat(64),
    }));
    await expect(
      f.service.compileStable(f.service.createRequestScope(f.request), f.runtimes),
    ).resolves.toMatchObject({ capabilities: [{ resolvedRevision: 8 }] });
    expect(f.compile).toHaveBeenCalledTimes(4);
  });

  it("retries a system customization changed during compilation instead of caching an old definition with its new identity", async () => {
    const f = await fixture();
    const systemRef = BUILT_IN_PRAGMA_REF;
    f.expert.spec.tools = [
      {
        adapter: "pragma.tool.call@v1",
        target: { ref: systemRef },
        tool: { name: "system", description: "Call system", approval: "none" },
      },
    ];
    f.systemFingerprints.set(systemRef, "old");
    f.compile.mockImplementationOnce(async () => {
      f.systemFingerprints.set(systemRef, "new");
      return f.compiled;
    });
    const result = await f.service.prepare(f.service.createRequestScope(f.request), f.runtimes);
    expect(f.compile).toHaveBeenCalledTimes(2);
    expect(result.identity).toBe(
      await f.service.identity(f.service.createRequestScope(f.request), result.capabilities),
    );
    f.compile.mockImplementation(async () => {
      f.systemFingerprints.set(systemRef, `${f.compile.mock.calls.length}`);
      return f.compiled;
    });
    await expect(
      f.service.compileStable(f.service.createRequestScope(f.request), f.runtimes),
    ).rejects.toThrow("changed repeatedly");
    expect(f.compile).toHaveBeenCalledTimes(5);
  });

  it("guards actual overlay Secret reads with hashes, upgrades unknown owner guards and invalidates unchanged definitions", async () => {
    let token = "first-private-token";
    const read = vi.fn(async () => token);
    const baseRead = vi.fn(async () => "unused-base-token");
    const f = await fixture({
      adapterHost: () => ({
        environmentId: "test",
        projectRoot: "/tmp",
        resolveSecret: baseRead,
        resolveBinding: async () => undefined,
        resolveArtifact: async () => {
          throw new Error("No artifact");
        },
      }),
      adaptAdapterHost: (_request, base) => ({ ...base, resolveSecret: read }),
    });
    f.compile.mockImplementation(async (_ref, options) => {
      await options!.adapterHost!.resolveSecret("credential:actual");
      return f.compiled;
    });
    const first = await f.service.prepare(f.service.createRequestScope(f.request), f.runtimes);
    expect(first.secrets).toEqual([{ ref: "credential:actual", fingerprint: hash(token) }]);
    expect(JSON.stringify(first.secrets)).not.toContain(token);
    expect(f.service.secretsFor(f.compiled)).toBe(first.secrets);
    const originalSnapshot = missionCompilationEnvironmentSnapshot(
      f.compiled,
      first.capabilities,
      first.secrets,
    );
    const originalSnapshotFingerprint = originalSnapshot.fingerprint;
    const legacy = await f.service.prepare(f.service.createRequestScope(f.request), f.runtimes, {
      hasOwner: true,
      identity: first.identity,
      capabilities: first.capabilities,
      definitionFingerprint: first.definitionFingerprint,
    });
    expect(legacy.cacheHit).toBe(false);
    expect(legacy.definitionChanged).toBe(true);
    const owner = { hasOwner: true, ...legacy };
    const calls = f.compile.mock.calls.length;
    expect(
      (await f.service.prepare(f.service.createRequestScope(f.request), f.runtimes, owner))
        .cacheHit,
    ).toBe(true);
    expect(f.compile).toHaveBeenCalledTimes(calls);
    token = "rotated-private-token";
    const changed = await f.service.prepare(
      f.service.createRequestScope(f.request),
      f.runtimes,
      owner,
    );
    expect(changed.identity).toBe(first.identity);
    expect(changed.definitionFingerprint).toBe(first.definitionFingerprint);
    expect(changed.definitionChanged).toBe(true);
    expect(changed.cacheHit).toBe(false);
    expect(
      missionCompilationEnvironmentSnapshot(f.compiled, changed.capabilities, changed.secrets)
        .fingerprint,
    ).not.toBe(originalSnapshotFingerprint);
    expect(originalSnapshot.fingerprint).toBe(originalSnapshotFingerprint);
    expect(baseRead).not.toHaveBeenCalled();
  });

  it("retries Secret rotation during the read and rejects repeated Secret instability", async () => {
    let generation = 0;
    let rotate = true;
    const read = vi.fn(async () => {
      const captured = `token-${generation}`;
      if (rotate) {
        generation += 1;
        rotate = false;
      }
      return captured;
    });
    const fingerprint = vi.fn(async () => `metadata-${generation}`);
    const f = await fixture({
      secretFingerprint: fingerprint,
      adapterHost: () => ({
        environmentId: "test",
        projectRoot: "/tmp",
        resolveSecret: read,
        resolveBinding: async () => undefined,
        resolveArtifact: async () => {
          throw new Error("No artifact");
        },
      }),
    });
    f.compile.mockImplementation(async (_ref, options) => {
      await options!.adapterHost!.resolveSecret("credential:actual");
      return f.compiled;
    });
    const result = await f.service.compileStable(
      f.service.createRequestScope(f.request),
      f.runtimes,
    );
    expect(f.compile).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.secrets).toEqual([{ ref: "credential:actual", fingerprint: "metadata-1" }]);
    fingerprint.mockImplementation(async () => `metadata-${generation++}`);
    await expect(
      f.service.compileStable(f.service.createRequestScope(f.request), f.runtimes),
    ).rejects.toThrow("changed repeatedly");
    expect(f.compile).toHaveBeenCalledTimes(5);
  });

  it("checks actual Plugin guards through inspect on cloned owner metadata without resolving the entry", async () => {
    let version = "initial";
    let bindingFingerprint = "original-binding";
    const inspect = vi.fn(async () => ({
      ref: "plugin:fixture@1" as const,
      status: "ready" as const,
      packageFingerprint: version,
      verificationFingerprint: version,
      bindingFingerprint,
      issues: [],
    }));
    const resolve = vi.fn(async () => ({
      ref: "plugin:fixture@1" as const,
      source: "/unused/plugin.mjs",
      packageFingerprint: version,
      verificationFingerprint: version,
      bindingFingerprint,
      userConfig: {},
    }));
    const f = await fixture({ plugins: { inspect, resolve } });
    f.compile.mockImplementation(async (_ref, options) => {
      await options!.plugins!.resolve({
        expertRef: f.request.executor.ref as `expert:${string}`,
        binding: { ref: "plugin:fixture@1" },
      });
      return f.compiled;
    });
    const first = await f.service.prepare(f.service.createRequestScope(f.request), f.runtimes);
    const owner = { hasOwner: true, ...first, plugins: structuredClone(first.plugins) };
    expect(f.service.pluginsFor(f.compiled)).toBe(first.plugins);
    resolve.mockClear();
    inspect.mockClear();
    const warm = await f.service.prepare(
      f.service.createRequestScope(f.request),
      f.runtimes,
      owner,
    );
    expect(warm.cacheHit).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledOnce();
    const firstEnvironment = missionCompilationEnvironmentSnapshot(
      f.compiled,
      first.capabilities,
      first.secrets,
      first.plugins,
    );
    bindingFingerprint = "swapped-secret-paths";
    const mappingChanged = await f.service.prepare(
      f.service.createRequestScope(f.request),
      f.runtimes,
      owner,
    );
    expect(mappingChanged.cacheHit).toBe(false);
    expect(mappingChanged.identity).toBe(first.identity);
    expect(mappingChanged.definitionChanged).toBe(true);
    expect(
      missionCompilationEnvironmentSnapshot(
        f.compiled,
        mappingChanged.capabilities,
        mappingChanged.secrets,
        mappingChanged.plugins,
      ).fingerprint,
    ).not.toBe(firstEnvironment.fingerprint);
    resolve.mockClear();
    version = "changed-config-or-package";
    const changed = await f.service.prepare(
      f.service.createRequestScope(f.request),
      f.runtimes,
      owner,
    );
    expect(changed.cacheHit).toBe(false);
    expect(changed.identity).toBe(first.identity);
    expect(changed.definitionChanged).toBe(true);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("retries Plugin rotation while resolving and rejects continuously changing Plugin authority", async () => {
    let generation = 0;
    const inspect = vi.fn(async () => ({
      ref: "plugin:fixture@1" as const,
      status: "ready" as const,
      packageFingerprint: `${generation}`,
      verificationFingerprint: `${generation}`,
      issues: [],
    }));
    const resolve = vi.fn(async () => {
      const captured = generation;
      if (generation === 0) generation += 1;
      return {
        ref: "plugin:fixture@1" as const,
        source: "/unused/plugin.mjs",
        packageFingerprint: `${captured}`,
        verificationFingerprint: `${captured}`,
        userConfig: {},
      };
    });
    const f = await fixture({ plugins: { inspect, resolve } });
    f.compile.mockImplementation(async (_ref, options) => {
      await options!.plugins!.resolve({
        expertRef: f.request.executor.ref as `expert:${string}`,
        binding: { ref: "plugin:fixture@1" },
      });
      return f.compiled;
    });
    await f.service.compileStable(f.service.createRequestScope(f.request), f.runtimes);
    expect(resolve).toHaveBeenCalledTimes(2);
    resolve.mockImplementation(async () => {
      const captured = generation++;
      return {
        ref: "plugin:fixture@1" as const,
        source: "/unused/plugin.mjs",
        packageFingerprint: `${captured}`,
        verificationFingerprint: `${captured}`,
        userConfig: {},
      };
    });
    await expect(
      f.service.compileStable(f.service.createRequestScope(f.request), f.runtimes),
    ).rejects.toThrow("changed repeatedly");
    expect(resolve).toHaveBeenCalledTimes(5);
  });

  it("applies a root system model override while preserving its Runtime and isolating child models", async () => {
    const f = await systemFixture();
    try {
      const root = f.resources.get(BUILT_IN_PRAGMA_REF)!;
      root.spec.tools = [callTargets([STORE_REVISION_EXPERT_REF])];
      const compiled = await f.service.compile(
        f.service.createRequestScope({
          ...f.request,
          modelOverride: { providerId: "override", modelId: "root", thinkingLevel: "high" },
        }),
        f.runtimes,
      );
      expect(compiled.rootRuntimeId).toBe("codex");
      expect(compiled.value).toMatchObject({
        models: {
          default: { model: { providerId: "override", modelId: "root" }, thinkingLevel: "high" },
        },
      });
      expect(
        f.preparedRequests.map((request) => [request.executor.ref, request.modelOverride]),
      ).toEqual([
        [BUILT_IN_PRAGMA_REF, { providerId: "override", modelId: "root", thinkingLevel: "high" }],
        [STORE_REVISION_EXPERT_REF, undefined],
      ]);
    } finally {
      await f.dispose();
    }
  });

  it("compiles a shared external system dependency only once across parallel targets", async () => {
    const f = await systemFixture();
    try {
      f.resources.get(BUILT_IN_PRAGMA_REF)!.spec.tools = [
        callTargets([STORE_REVISION_EXPERT_REF, SKILL_REVISION_EXPERT_REF]),
      ];
      f.resources.get(STORE_REVISION_EXPERT_REF)!.spec.tools = [
        callTargets([SKILL_REVISION_EXPERT_REF]),
      ];
      await f.service.compile(f.service.createRequestScope(f.request), f.runtimes);
      expect(
        f.preparedRequests.filter((request) => request.executor.ref === SKILL_REVISION_EXPERT_REF),
      ).toHaveLength(1);
    } finally {
      await f.dispose();
    }
  });

  it("keeps an explicit system RuntimeProfile when only the root model is overridden", async () => {
    const f = await systemFixture(true);
    try {
      const bind = vi.spyOn(f.runtimes, "bind");
      const compiled = await f.service.compile(
        f.service.createRequestScope({
          ...f.request,
          modelOverride: { providerId: "override", modelId: "root" },
        }),
        f.runtimes,
      );
      expect(compiled.rootRuntimeId).toBe("pi");
      expect(bind).toHaveBeenCalledWith({
        runtimeId: "pi",
        modelSelection: { model: { providerId: "override", modelId: "root" } },
      });
    } finally {
      await f.dispose();
    }
  });

  it("rejects parallel sibling external cycles instead of waiting on mutually pending compilations", async () => {
    const f = await systemFixture();
    try {
      f.resources.get(BUILT_IN_PRAGMA_REF)!.spec.tools = [
        callTargets([STORE_REVISION_EXPERT_REF, SKILL_REVISION_EXPERT_REF]),
      ];
      f.resources.get(STORE_REVISION_EXPERT_REF)!.spec.tools = [
        callTargets([SKILL_REVISION_EXPERT_REF]),
      ];
      f.resources.get(SKILL_REVISION_EXPERT_REF)!.spec.tools = [
        callTargets([STORE_REVISION_EXPERT_REF]),
      ];
      await expect(
        f.service.compile(f.service.createRequestScope(f.request), f.runtimes),
      ).rejects.toThrow("Cyclic external resource dependency");
    } finally {
      await f.dispose();
    }
  });

  it("rejects a wrong source pin or compiler view fingerprint", async () => {
    const f = await fixture();
    f.getRevision.mockResolvedValueOnce({ ...f.revision, revision: 2 });
    await expect(
      f.service.prepare(f.service.createRequestScope(f.request), f.runtimes),
    ).rejects.toThrow("pin mismatch");
    expect(f.compile).not.toHaveBeenCalled();
    f.compile.mockResolvedValueOnce({ ...f.compiled, projectFingerprint: "8".repeat(64) });
    await expect(
      f.service.compile(f.service.createRequestScope(f.request), f.runtimes),
    ).rejects.toThrow("derived compiler view");
  });

  it("sorts mounts, retains draft distinctions and isolates request-specific Host bindings", async () => {
    const f = await fixture();
    const mounts: LocalHostMissionCompileRequest["contextMounts"] = [
      { kind: "context-store-draft", draftId: "draft" },
      { kind: "context-store", storeId: "j35188zs37g69g0n" },
    ];
    expect(missionCompileContextMountsFingerprint({ contextMounts: mounts })).toBe(
      missionCompileContextMountsFingerprint({ contextMounts: [...mounts].reverse() }),
    );
    expect(missionCompileContextMountsFingerprint({ contextMounts: mounts })).not.toBe(
      missionCompileContextMountsFingerprint({
        contextMounts: [
          { kind: "context-store-draft", draftId: "draft", revisionJobId: "job" },
          mounts[1]!,
        ],
      }),
    );
    const other = { ...f.request, id: "mission-b", workspace: { path: "/isolated/mission-b" } };
    await f.service.prepare(f.service.createRequestScope(f.request), f.runtimes);
    await f.service.prepare(f.service.createRequestScope(other), f.runtimes);
    expect(f.adapterHost).toHaveBeenNthCalledWith(1, f.request, "execute");
    expect(f.adapterHost).toHaveBeenNthCalledWith(2, other, "execute");
    expect(f.compile).toHaveBeenCalledTimes(2);
  });
});

function callTargets(refs: readonly string[]): PragmaExpertResource["spec"]["tools"][number] {
  return {
    adapter: "pragma.tool.delegate@v1",
    targets: refs.map((ref) => ({ ref })),
  };
}

async function systemFixture(explicitRuntime = false) {
  const home = await mkdtemp(join(tmpdir(), "pragma-compile-review-"));
  const refs = [BUILT_IN_PRAGMA_REF, STORE_REVISION_EXPERT_REF, SKILL_REVISION_EXPERT_REF] as const;
  const resources = new Map<string, PragmaExpertResource>(
    refs.map((ref) => {
      const resource = structuredClone(builtInAgentResource(ref));
      resource.spec.capabilities = [];
      resource.spec.contextStores = [];
      resource.spec.plugins = [];
      resource.spec.tools = [];
      return [ref, resource];
    }),
  );
  const runtimeProfile = structuredClone(
    createPublishedProjectResources().find((resource) => resource.kind === "RuntimeProfile")!,
  );
  if (runtimeProfile.kind !== "RuntimeProfile") throw new Error("Missing Runtime profile");
  runtimeProfile.spec.config = { runtimeId: "pi" };
  if (explicitRuntime)
    resources.get(BUILT_IN_PRAGMA_REF)!.spec.runtime = {
      ref: canonicalPragmaResourceRef(runtimeProfile),
    };
  const runtimes = createStaticRuntimeResolver({
    defaultRuntimeId: "codex",
    runtimes: [
      defineRuntimeTestDriver({
        descriptor: { id: "codex", kind: "test", displayName: "Fixture" },
        createSession: () => ({}),
        startTurn: () => ({ outputText: "done" }),
        mapEvent: () => ({ events: [] }),
      }),
      defineRuntimeTestDriver({
        descriptor: { id: "pi", kind: "test", displayName: "Explicit Runtime" },
        createSession: () => ({}),
        startTurn: () => ({ outputText: "done" }),
        mapEvent: () => ({ events: [] }),
      }),
    ],
  });
  const request: LocalHostMissionCompileRequest = {
    id: "system",
    project: { id: "studio", revision: 1 },
    executor: { kind: "expert", ref: BUILT_IN_PRAGMA_REF, name: "Pragma" },
    workspace: { path: home },
    contextMounts: [],
  };
  const preparedRequests: LocalHostMissionCompileRequest[] = [];
  const service = createLocalHostMissionCompileService({
    environmentId: "review",
    pragmaHome: home,
    loggerProvider: createNoopLoggerProvider(),
    adapterHost: () => ({
      environmentId: "review",
      projectRoot: home,
      resolveBinding: async () => undefined,
      resolveSecret: async () => undefined,
      resolveArtifact: async () => {
        throw new Error("Unexpected artifact");
      },
    }),
    revisionSource: {
      getRevision: async () => {
        throw new Error("System source must not read project");
      },
      withProject: async () => {
        throw new Error("System source must not compile project");
      },
    },
    systemExecutors: {
      getResource: (ref) => resources.get(ref),
      prepare: async (current, resolver, _purpose, adapterHost) => {
        preparedRequests.push(current);
        return {
          ref: current.executor.ref as BuiltInAgentRef,
          expertResource: resources.get(current.executor.ref)!,
          additionalResources: explicitRuntime ? [runtimeProfile] : [],
          environmentId: "review",
          definitionStateRoot: join(home, "definitions"),
          workspace: home,
          pragmaHome: home,
          runtimes: resolver,
          adapterHost,
          ...(explicitRuntime
            ? {}
            : {
                rootExecutionOverride: {
                  runtimeId: "codex",
                  modelSelection: { model: { providerId: "profile", modelId: "default" } },
                },
              }),
        };
      },
    },
  });
  return {
    request,
    resources,
    runtimes,
    service,
    preparedRequests,
    dispose: () => rm(home, { recursive: true, force: true }),
  };
}
