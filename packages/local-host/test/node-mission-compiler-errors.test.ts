import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  assertExecutableDefinition,
  createStaticRuntimeResolver,
  fingerprintExpertExecutionDefinition,
  PragmaPaths,
  type ExpertDefinition,
  type IExpertAgentMcpConfig,
} from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { BUILT_IN_PRAGMA_REF } from "@pragma/built-in-agents";
import {
  canonicalPragmaResourceRef,
  formatPragmaYaml,
  FlowActionRegistry,
  loadPragmaProject,
  PragmaDslError,
  type PragmaResource,
} from "@pragma/interpreter";
import {
  PragmaCapabilityResourceSchema,
  PragmaContextStoreResourceSchema,
} from "@pragma/interpreter/ast";
import { createIntegrationError, IntegrationErrorSchema } from "@pragma/shared/integration";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalHostNodeMissionCompiler } from "../src/node-mission-compiler.ts";
import type { LocalHostProjectRevisionReader } from "../src/project-revision.ts";
import { CapabilityCredentialStoreError } from "../src/resources/capability-credential-store.ts";
import { PluginStoreError } from "../src/resources/plugin-resolver.ts";
import { createLocalHostResourceResolvers } from "../src/resources/resolvers.ts";
import { LegacyCredentialMigrationError } from "../src/secrets/legacy-credential-migration.ts";
import {
  createSecretStore,
  SecretStoreError,
  type OsKeychain,
} from "../src/secrets/secret-store.ts";
import { createPublishedProjectResources } from "./fixtures/published-project.ts";

const roots: string[] = [];
const capabilityId = "pcr7npvx0gv8fpka";
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  kind:
    | "plugin"
    | "capability"
    | "plain"
    | "inline-secret"
    | "context"
    | "installed-plugin"
    | "inline-artifact"
    | "missing-action" = "plain",
  delegation = false,
) {
  const home = await mkdtemp(join(tmpdir(), "pragma-node-compile-errors-"));
  roots.push(home);
  const resources: PragmaResource[] = [...createPublishedProjectResources()];
  const expert = resources.find((resource) => resource.kind === "Expert")!;
  if (expert.kind !== "Expert") throw new Error("Expert fixture missing.");
  if (delegation) {
    const member = resources.filter((candidate) => candidate.kind === "Expert")[1]!;
    const runtime = resources.find((candidate) => candidate.kind === "RuntimeProfile")!;
    if (runtime.kind !== "RuntimeProfile") throw new Error("Runtime missing");
    runtime.spec.config = { runtimeId: "codex", providerId: "test", model: "test-model" };
    expert.spec.tools = [
      {
        adapter: "pragma.tool.delegate@v1",
        targets: [{ ref: canonicalPragmaResourceRef(member) }],
        policy: {
          maxConcurrency: 2,
          maxDepth: 3,
          runtimes: { [member.metadata.id]: canonicalPragmaResourceRef(runtime) },
        },
      },
    ];
  }
  if (kind === "plugin") expert.spec.plugins = [{ ref: "plugin:missing@1.0.0", config: {} }];
  if (kind === "installed-plugin")
    expert.spec.plugins = [{ ref: "plugin:example@1.0.0", config: {} }];
  if (kind === "capability") {
    expert.spec.capabilities = [{ ref: `capability:${capabilityId}`, kind: "tools" }];
    resources.push(
      PragmaCapabilityResourceSchema.parse({
        apiVersion: expert.apiVersion,
        kind: "Capability",
        metadata: {
          id: capabilityId,
          name: "Missing tools",
          description: "Missing tools",
          tags: [],
        },
        spec: {
          adapter: "pragma.capability.host@v1",
          binding: `binding:desktop-capability.${Buffer.from(capabilityId).toString("base64url")}`,
          config: {},
        },
      }),
    );
  }
  if (kind === "inline-secret") {
    expert.spec.capabilities = [{ ref: `capability:${capabilityId}`, kind: "tools" }];
    resources.push(
      PragmaCapabilityResourceSchema.parse({
        apiVersion: expert.apiVersion,
        kind: "Capability",
        metadata: {
          id: capabilityId,
          name: "Inline HTTP",
          description: "HTTP with stored secret",
          tags: [],
        },
        spec: {
          adapter: "pragma.capability.http@v1",
          binding: "binding:inline-http",
          config: {
            serverKey: "inline_http",
            tools: [
              { name: "read", description: "Read", method: "GET", path: "/read", parameters: [] },
            ],
          },
        },
      }),
    );
  }
  if (kind === "inline-artifact") {
    expert.spec.capabilities = [{ ref: `capability:${capabilityId}`, kind: "skill" }];
    resources.push(
      PragmaCapabilityResourceSchema.parse({
        apiVersion: expert.apiVersion,
        kind: "Capability",
        metadata: {
          id: capabilityId,
          name: "Unavailable Skill",
          description: "Remote artifact",
          tags: [],
        },
        spec: {
          adapter: "pragma.capability.skill@v1",
          config: {
            source: {
              type: "uri",
              uri: "https://example.test/missing-skill",
              integrity: `sha256:${"a".repeat(64)}`,
            },
          },
        },
      }),
    );
  }
  const contextId = "00000000-0000-4000-8000-000000000031";
  if (kind === "context") {
    expert.spec.contextStores = [
      { ref: `context-store:${capabilityId}`, namespace: "knowledge", required: true },
    ];
    resources.push(
      PragmaContextStoreResourceSchema.parse({
        apiVersion: expert.apiVersion,
        kind: "ContextStore",
        metadata: {
          id: capabilityId,
          name: "Knowledge",
          description: "Stored knowledge",
          tags: [],
        },
        spec: {
          adapter: "pragma.context.host@v1",
          binding: `binding:desktop-context.${Buffer.from(contextId).toString("base64url")}`,
          config: { key: "knowledge" },
        },
      }),
    );
  }
  if (kind === "missing-action") {
    const flow = resources.find((candidate) => candidate.kind === "Flow")!;
    if (flow.kind !== "Flow") throw new Error("Flow missing");
    flow.spec.graph.steps.run = { action: { ref: "action:test.missing@v1" } };
  }
  const entry = join(home, "pragma.yaml");
  await writeFile(
    entry,
    formatPragmaYaml({ apiVersion: expert.apiVersion, kind: "Bundle", resources }),
  );
  const published = await loadPragmaProject(entry);
  const projectFingerprint = published.createLock().projectFingerprint;
  await published.dispose();
  const location = {
    projectId: "studio",
    revision: 1,
    entryFile: entry,
    projectFingerprint,
  };
  const reader: LocalHostProjectRevisionReader = {
    getHead: async () => location,
    getRevision: async () => location,
    getRevisionByPublicationId: async () => undefined,
    openRevision: async () => await loadPragmaProject(entry),
    readFiles: async () => new Map(),
  };
  const runtimes = createStaticRuntimeResolver({
    defaultRuntimeId: "codex",
    runtimes: [
      defineRuntimeTestDriver({
        descriptor: { id: "codex", kind: "test", displayName: "Compiler fixture" },
        canUse: async () => ({ usable: true }),
        createSession: () => ({}),
        startTurn: () => ({ outputText: "" }),
        mapEvent: () => ({ events: [] }),
      }),
    ],
  });
  const keychainState = { locked: false };
  const secrets = new Map<string, Uint8Array>();
  const keychain: OsKeychain = {
    inspect: async () => ({
      status: keychainState.locked ? "locked" : "ready",
      backend: "macos-keychain",
    }),
    get: async (service, account) => {
      if (keychainState.locked)
        throw new SecretStoreError("SECRET_STORE_LOCKED", "Keychain is locked.");
      return secrets.get(`${service}:${account}`) ?? null;
    },
    set: async (service, account, value) => {
      secrets.set(`${service}:${account}`, Uint8Array.from(value));
    },
    delete: async (service, account) => {
      secrets.delete(`${service}:${account}`);
    },
  };
  const paths = new PragmaPaths({ pragmaHome: home });
  const secretStore = createSecretStore({
    root: paths.secretStoreRoot(),
    dataRoot: paths.dataRoot(),
    keychain,
  });
  const ports = createLocalHostResourceResolvers({ pragmaHome: home, secretStore });
  const adapterHost = ports.adapterHost;
  if (kind === "inline-secret")
    ports.adapterHost = (request, purpose) => {
      const host = adapterHost(request, purpose);
      return {
        ...host,
        resolveBinding: async (ref) =>
          ref === "binding:inline-http"
            ? {
                ref,
                revision: "1",
                fingerprint: "b".repeat(64),
                value: {
                  baseUrl: "https://example.test",
                  auth: { type: "bearer", secretRef: "binding:http-token" },
                },
              }
            : await host.resolveBinding(ref),
      };
    };
  const compiler = createLocalHostNodeMissionCompiler({
    pragmaHome: home,
    reader,
    runtimes,
    resources: ports,
  });
  const request = {
    id: "compiler-boundary",
    project: { id: "studio", revision: 1 },
    executor: {
      kind: "expert" as const,
      ref: canonicalPragmaResourceRef(expert),
      name: expert.metadata.name,
    },
    workspace: { path: home },
    contextMounts: [],
  };
  return { home, compiler, ports, runtimes, request, keychainState, contextId };
}

async function installPlugin(f: Awaited<ReturnType<typeof fixture>>) {
  const paths = new PragmaPaths({ pragmaHome: f.home });
  const root = join(paths.pluginsRoot(), "example", "1.0.0");
  const manifest = {
    schemaVersion: "pragma.plugin/v2",
    id: "example",
    version: "1.0.0",
    name: "Example",
    description: "Installed plugin cache authority",
    tags: [],
    runtime: { type: "expert-agent-plugin", entry: "index.mjs", trust: "trusted-host" },
    capabilities: [],
    configuration: {
      type: "object",
      properties: {
        enabled: { type: "boolean", default: true },
        token: { type: "string", "x-pragma-secret": true },
        backupToken: { type: "string", "x-pragma-secret": true },
      },
      required: ["token", "backupToken"],
      additionalProperties: false,
    },
    permissions: { filesystem: [], shell: [], network: [], environment: [] },
  };
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "plugin.json"), JSON.stringify(manifest));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "example", version: "1.0.0", type: "module" }),
  );
  await writeFile(
    join(root, "index.mjs"),
    `export default { id: "example", name: "Example", description: "Installed plugin cache authority", version: "1.0.0", tags: [], manifest: ${JSON.stringify(manifest)}, setup: () => ({}) };\n`,
  );
  const statePath = paths.pluginConfigState("plugin:example@1.0.0");
  await mkdir(dirname(statePath), { recursive: true });
  const state = {
    schemaVersion: 1,
    ref: "plugin:example@1.0.0",
    config: { enabled: false },
    secretBindings: { token: "binding:plugin-token", backupToken: "binding:plugin-backup-token" },
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  await writeFile(statePath, JSON.stringify(state));
  await f.ports.pluginCredentials.set("binding:plugin-token", "plugin-private-first");
  await f.ports.pluginCredentials.set("binding:plugin-backup-token", "plugin-private-backup");
  const unrelated = join(paths.pluginsRoot(), "unrelated", "1.0.0");
  await mkdir(unrelated, { recursive: true });
  await writeFile(join(unrelated, "plugin.json"), "invalid-unrelated-manifest");
  return { root, statePath, state, unrelated };
}

describe("Node Mission compiler error boundary", () => {
  it.each(["expert", "team", "flow"] as const)(
    "compiles %s stop metadata without reading broken Plugin or execution resource ports",
    async (kind) => {
      const f = await fixture("installed-plugin", true);
      const installed = await installPlugin(f);
      const snapshot = await f.compiler.service.createRequestScope(f.request).getRevision();
      const resource = snapshot.resources.find(
        (candidate) =>
          candidate.kind ===
          (kind === "expert" ? "Expert" : kind === "team" ? "ExpertTeam" : "Flow"),
      )!;
      const request = {
        ...f.request,
        executor: {
          kind,
          ref: canonicalPragmaResourceRef(resource),
          name: resource.metadata.name,
        },
      };
      const original = await f.compiler.service.compile(
        f.compiler.service.createRequestScope(request),
        f.runtimes,
      );
      // Stop compilation retains the definition contract needed by Core recovery.
      const resolve = vi.spyOn(f.ports.plugins, "resolve");
      const inspect = vi.spyOn(f.ports.plugins, "inspect");
      const credentials = vi.spyOn(f.ports.pluginCredentials, "get");
      const adapter = f.ports.adapterHost;
      const bindings = vi.fn(async () => {
        throw new Error("Execution binding unavailable");
      });
      const secrets = vi.fn(async () => {
        throw new Error("Secret Store locked");
      });
      const artifacts = vi.fn(async () => {
        throw new Error("Artifact missing");
      });
      const compiler = createLocalHostNodeMissionCompiler({
        pragmaHome: f.home,
        reader: f.compiler.reader,
        runtimes: f.runtimes,
        resources: {
          ...f.ports,
          adapterHost: (input, purpose) => ({
            ...adapter(input, purpose),
            resolveBinding: bindings,
            resolveSecret: secrets,
            resolveArtifact: artifacts,
          }),
        },
      });
      for (const damage of ["corrupted", "locked", "missing"] as const) {
        if (damage === "corrupted")
          await writeFile(join(installed.root, "plugin.json"), "corrupted package");
        if (damage === "locked") f.keychainState.locked = true;
        if (damage === "missing") await rm(installed.root, { recursive: true });
        const stopped = await compiler.compileForStop(compiler.service.createRequestScope(request));
        expect(stopped.ref).toBe(original.ref);
        expect(stopped.fingerprint).toBe(original.fingerprint);
        expect(stopped.projectFingerprint).toBe(original.projectFingerprint);
        expect(stopped.environmentFingerprint.value).not.toBe(
          original.environmentFingerprint.value,
        );
        expect(() => assertExecutableDefinition(stopped.value)).toThrow("stop-only");
        if (kind !== "flow")
          expect(fingerprintExpertExecutionDefinition(stopped.value as ExpertDefinition)).toBe(
            fingerprintExpertExecutionDefinition(original.value as ExpertDefinition),
          );
      }
      expect(resolve).not.toHaveBeenCalled();
      expect(inspect).not.toHaveBeenCalled();
      expect(credentials).not.toHaveBeenCalled();
      expect(bindings).not.toHaveBeenCalled();
      expect(secrets).not.toHaveBeenCalled();
      expect(artifacts).not.toHaveBeenCalled();
      // A Host without Plugin execution support still has enough metadata to stop.
      const withoutPlugins = createLocalHostNodeMissionCompiler({
        pragmaHome: f.home,
        reader: f.compiler.reader,
        runtimes: f.runtimes,
        resources: { ...f.ports, plugins: undefined },
      });
      await expect(
        withoutPlugins.compileForStop(withoutPlugins.service.createRequestScope(request)),
      ).resolves.toMatchObject({ ref: original.ref });
    },
  );

  it("builds stop-only Task metadata without requiring the execution FlowAction registry", async () => {
    const f = await fixture("missing-action");
    const snapshot = await f.compiler.service.createRequestScope(f.request).getRevision();
    const resource = snapshot.resources.find((candidate) => candidate.kind === "Flow")!;
    const request = {
      ...f.request,
      executor: {
        kind: "flow",
        ref: canonicalPragmaResourceRef(resource),
        name: resource.metadata.name,
      },
    };
    const actions = new FlowActionRegistry().register({
      id: "test.missing",
      version: "v1",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      execute: vi.fn(async () => ({})),
    });
    const project = await f.compiler.reader.openRevision(
      (await f.compiler.reader.getRevision("studio", 1))!,
    );
    try {
      const resolve = vi.spyOn(actions, "resolve");
      const compiled = await project.compile(request.executor.ref as `flow:${string}`, {
        workspace: f.home,
        compilationPurpose: "stop",
        runtimes: f.runtimes,
        actions,
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(() => assertExecutableDefinition(compiled.value)).toThrow("stop-only");
      if (!("kind" in compiled.value) || compiled.value.kind !== "flow")
        throw new Error("Flow missing");
      const task = compiled.value.steps.get("run")!.definition;
      if (!("kind" in task) || task.kind !== "task") throw new Error("Task missing");
      expect(() => task.handler({} as never)).toThrow("stop-only");
    } finally {
      await project.dispose();
    }
    await expect(
      f.compiler.compileForStop(f.compiler.service.createRequestScope(request)),
    ).resolves.toMatchObject({ ref: request.executor.ref });
    await expect(
      f.compiler.prepare(f.compiler.service.createRequestScope(request)),
    ).rejects.toBeDefined();
  });

  it("stops with a missing external Skill artifact without claiming execution readiness", async () => {
    const f = await fixture("inline-artifact");
    const adapter = f.ports.adapterHost;
    const resolveArtifact = vi.fn(async () => {
      throw new Error("Artifact missing");
    });
    const compiler = createLocalHostNodeMissionCompiler({
      pragmaHome: f.home,
      reader: f.compiler.reader,
      runtimes: f.runtimes,
      resources: {
        ...f.ports,
        adapterHost: (input, purpose) => ({ ...adapter(input, purpose), resolveArtifact }),
      },
    });
    const stopped = await compiler.compileForStop(compiler.service.createRequestScope(f.request));
    expect(() => assertExecutableDefinition(stopped.value)).toThrow("stop-only");
    expect(resolveArtifact).not.toHaveBeenCalled();
    await expect(
      compiler.prepare(compiler.service.createRequestScope(f.request)),
    ).rejects.toBeDefined();
    expect(resolveArtifact).toHaveBeenCalledTimes(1);
  });

  it("skips inline HTTP Secret, binding and artifact resolution for stop while execute remains fail closed", async () => {
    const f = await fixture("inline-secret");
    await f.ports.pluginCredentials.set("binding:http-token", "stop-test-private-token");
    await f.compiler.service.compile(f.compiler.service.createRequestScope(f.request), f.runtimes);
    await f.ports.pluginCredentials.remove("binding:http-token");
    const gets = vi.spyOn(f.ports.pluginCredentials, "get");
    const fingerprints = vi.spyOn(f.ports, "secretFingerprint");
    for (const locked of [false, true]) {
      f.keychainState.locked = locked;
      await expect(
        f.compiler.compileForStop(f.compiler.service.createRequestScope(f.request)),
      ).resolves.toMatchObject({ ref: f.request.executor.ref });
    }
    expect(gets).not.toHaveBeenCalled();
    expect(fingerprints).not.toHaveBeenCalled();
    await expect(
      f.compiler.prepare(f.compiler.service.createRequestScope(f.request)),
    ).rejects.toBeDefined();
  });

  it("invalidates a persisted Plugin Secret mapping swap without changing its historical verification hash", async () => {
    const f = await fixture("installed-plugin");
    const installed = await installPlugin(f);
    const binding = { ref: "plugin:example@1.0.0" };
    const before = await f.ports.plugins.inspect({ binding });
    const resolvedBefore = await f.ports.plugins.resolve({ binding });
    const first = await (
      await f.compiler.prepare(f.compiler.service.createRequestScope(f.request))
    ).ensureCompiled();
    await writeFile(
      installed.statePath,
      JSON.stringify({
        ...installed.state,
        secretBindings: {
          token: "binding:plugin-backup-token",
          backupToken: "binding:plugin-token",
        },
      }),
    );
    const after = await f.ports.plugins.inspect({ binding });
    const resolvedAfter = await f.ports.plugins.resolve({ binding });
    expect(after.packageFingerprint).toBe(before.packageFingerprint);
    expect(after.verificationFingerprint).toBe(before.verificationFingerprint);
    expect(after.bindingFingerprint).not.toBe(before.bindingFingerprint);
    expect(resolvedAfter.bindingFingerprint).toBe(after.bindingFingerprint);
    expect(resolvedBefore.userConfig).toMatchObject({
      token: "plugin-private-first",
      backupToken: "plugin-private-backup",
    });
    expect(resolvedAfter.userConfig).toMatchObject({
      token: "plugin-private-backup",
      backupToken: "plugin-private-first",
    });
    const next = await f.compiler.prepare(f.compiler.service.createRequestScope(f.request), {
      hasOwner: true,
      identity: first.identity,
      definitionFingerprint: first.definitionFingerprint,
      capabilities: first.capabilities,
      secrets: first.secrets,
      plugins: first.plugins,
    });
    expect(next.cacheHit).toBe(false);
    expect(next.definitionChanged).toBe(true);
    expect((await next.ensureCompiled()).plugins).not.toEqual(first.plugins);
    expect(JSON.stringify(next.plugins)).not.toContain("plugin-private-");
  });

  it("invalidates a real installed Plugin for persisted defaults, Secret and package changes while ignoring unrelated bad packages", async () => {
    const f = await fixture("installed-plugin");
    const installed = await installPlugin(f);
    const prepare = (owner?: Parameters<typeof f.compiler.prepare>[1]) =>
      f.compiler.prepare(f.compiler.service.createRequestScope(f.request), owner);
    const initial = await (await prepare()).ensureCompiled();
    const ownerFor = (compilation: typeof initial) => ({
      hasOwner: true,
      identity: compilation.identity,
      definitionFingerprint: compilation.definitionFingerprint,
      capabilities: compilation.capabilities,
      secrets: compilation.secrets,
      plugins: compilation.plugins,
    });
    expect(initial.plugins).toHaveLength(1);
    expect(initial.plugins[0]).toMatchObject({
      expertRef: f.request.executor.ref,
      binding: { ref: "plugin:example@1.0.0" },
    });
    expect(JSON.stringify(initial.plugins)).not.toContain("plugin-private-first");
    const reads = vi.spyOn(f.ports.pluginCredentials, "get");
    const resolves = vi.spyOn(f.ports.plugins, "resolve");
    expect((await prepare(ownerFor(initial))).cacheHit).toBe(true);
    expect(reads).not.toHaveBeenCalled();
    expect(resolves).not.toHaveBeenCalled();
    await writeFile(join(installed.unrelated, "index.mjs"), "unrelated invalid entry");
    expect((await prepare(ownerFor(initial))).cacheHit).toBe(true);
    expect(resolves).not.toHaveBeenCalled();
    await writeFile(
      installed.statePath,
      JSON.stringify({ ...installed.state, config: { enabled: true } }),
    );
    const configured = await prepare(ownerFor(initial));
    expect(configured.cacheHit).toBe(false);
    expect(configured.definitionChanged).toBe(true);
    const configuredCompilation = await configured.ensureCompiled();
    expect(configuredCompilation.plugins).not.toEqual(initial.plugins);
    await f.ports.pluginCredentials.set("binding:plugin-token", "plugin-private-second");
    const rotated = await prepare(ownerFor(configuredCompilation));
    expect(rotated.cacheHit).toBe(false);
    expect(rotated.definitionChanged).toBe(true);
    const rotatedCompilation = await rotated.ensureCompiled();
    expect(rotatedCompilation.plugins).not.toEqual(configuredCompilation.plugins);
    expect(JSON.stringify(rotatedCompilation.plugins)).not.toContain("plugin-private-second");
    await writeFile(
      join(installed.root, "index.mjs"),
      `${await readFile(join(installed.root, "index.mjs"), "utf8")}\n// Changed target package\n`,
    );
    const resolvesBeforePackageChange = resolves.mock.calls.length;
    // User-installed packages keep Core's immutable same-ref policy. A changed
    // package must invalidate warm reuse and reach its existing fail-closed loader.
    await expect(prepare(ownerFor(rotatedCompilation))).rejects.toThrow("identity_conflict");
    expect(resolves.mock.calls.length).toBeGreaterThan(resolvesBeforePackageChange);
  });

  it("invalidates a warm inline HTTP executor for persisted Secret replacement and deletion", async () => {
    const f = await fixture("inline-secret");
    const ref = "binding:http-token";
    await f.ports.pluginCredentials.set(ref, "first-private-token");
    const prepare = (owner?: Parameters<typeof f.compiler.prepare>[1]) =>
      f.compiler.prepare(f.compiler.service.createRequestScope(f.request), owner);
    const first = await (await prepare()).ensureCompiled();
    const owner = {
      hasOwner: true,
      identity: first.identity,
      definitionFingerprint: first.definitionFingerprint,
      capabilities: first.capabilities,
      secrets: first.secrets,
      plugins: first.plugins,
    };
    const reads = vi.spyOn(f.ports.pluginCredentials, "get");
    expect((await prepare(owner)).cacheHit).toBe(true);
    expect(reads).not.toHaveBeenCalled();
    await f.ports.pluginCredentials.set(ref, "second-private-token");
    const replacement = await prepare(owner);
    expect(replacement.cacheHit).toBe(false);
    expect(replacement.definitionChanged).toBe(true);
    const second = await replacement.ensureCompiled();
    expect(second.secrets).not.toEqual(first.secrets);
    expect(second.secrets).toEqual([{ ref, fingerprint: await f.ports.secretFingerprint(ref) }]);
    expect(JSON.stringify(second.secrets)).not.toContain("private-token");
    const fetch = vi.fn(
      async () => new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetch);
    const server = (second.compiled.value as { mcp?: IExpertAgentMcpConfig }).mcp?.mcpServers?.[
      "inline_http"
    ]?.inProcess;
    expect(server).toBeDefined();
    await server!.callTool("read", {});
    expect(fetch).toHaveBeenCalledWith(
      "https://example.test/read",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer second-private-token" }),
      }),
    );
    await f.ports.pluginCredentials.remove(ref);
    await expect(prepare({ ...owner, secrets: second.secrets })).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      details: { diagnosticCode: "secret_binding_unavailable" },
    });
  });

  it("retries an inline Secret changed while Interpreter was capturing its HTTP credential", async () => {
    const f = await fixture("inline-secret");
    const ref = "binding:http-token";
    await f.ports.pluginCredentials.set(ref, "before-private-token");
    const get = f.ports.pluginCredentials.get.bind(f.ports.pluginCredentials);
    const reads = vi
      .spyOn(f.ports.pluginCredentials, "get")
      .mockImplementationOnce(async (binding) => {
        const value = await get(binding);
        await f.ports.pluginCredentials.set(ref, "after-private-token");
        return value;
      });
    const prepared = await f.compiler.prepare(f.compiler.service.createRequestScope(f.request));
    const compiled = await prepared.ensureCompiled();
    expect(reads).toHaveBeenCalledTimes(2);
    expect(compiled.secrets).toEqual([{ ref, fingerprint: await f.ports.secretFingerprint(ref) }]);
    expect(JSON.stringify(compiled.secrets)).not.toContain("private-token");
    const fetch = vi.fn(
      async () => new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetch);
    const server = (compiled.compiled.value as { mcp?: IExpertAgentMcpConfig }).mcp?.mcpServers?.[
      "inline_http"
    ]?.inProcess;
    await server!.callTool("read", {});
    expect(fetch).toHaveBeenCalledWith(
      "https://example.test/read",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer after-private-token" }),
      }),
    );
  });

  it("preserves a locked persisted inline Secret through actual Interpreter compilation", async () => {
    const f = await fixture("inline-secret");
    await f.ports.pluginCredentials.set("binding:http-token", "private-http-token");
    f.keychainState.locked = true;
    const error = await f.compiler
      .prepare(f.compiler.service.createRequestScope(f.request))
      .catch((failure: unknown) => failure);
    expect(IntegrationErrorSchema.parse(error)).toMatchObject({
      code: "SECRET_STORE_LOCKED",
      details: {
        diagnosticCode: "SECRET_STORE_LOCKED",
        diagnostics: [expect.objectContaining({ code: "environment.resource_unavailable" })],
      },
    });
    expect(JSON.stringify(error)).not.toContain("private-http-token");
    expect(JSON.stringify(error)).not.toContain("cause");
  });

  it("distinguishes missing and invalid persisted ContextStore through actual Interpreter compilation", async () => {
    const f = await fixture("context");
    const prepare = () => f.compiler.prepare(f.compiler.service.createRequestScope(f.request));
    await expect(prepare()).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      details: { diagnosticCode: "store_not_found" },
    });
    const root = join(new PragmaPaths({ pragmaHome: f.home }).contextStoresRoot(), f.contextId);
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "store.json"),
      JSON.stringify({ schemaVersion: "pragma.context-store/v999" }),
    );
    await expect(prepare()).rejects.toMatchObject({
      code: "STORAGE_CORRUPTED",
      details: { diagnosticCode: "config_invalid" },
    });
  });

  it("preserves a canonical plain-object failure thrown by an inline Secret port", async () => {
    const f = await fixture("inline-secret");
    const canonical = createIntegrationError({
      code: "KEYCHAIN_UNAVAILABLE",
      category: "dependency",
      message: "Keychain unavailable.",
    });
    vi.spyOn(f.ports.pluginCredentials, "get").mockRejectedValue(canonical);
    await expect(f.compiler.prepare(f.compiler.service.createRequestScope(f.request))).rejects.toBe(
      canonical,
    );
  });

  it("reports real built-in management resource absence through Interpreter diagnostics", async () => {
    const f = await fixture();
    const scope = f.compiler.service.createRequestScope({
      ...f.request,
      executor: { kind: "expert", ref: BUILT_IN_PRAGMA_REF, name: "Pragma" },
    });
    await expect(f.compiler.prepare(scope)).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      details: {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: "environment.resource_unavailable",
            message: expect.stringContaining("management_ports_unavailable"),
          }),
        ]),
      },
    });
  });

  it("maps actual plugin lookup failures during eager and warm-owner lazy compilation", async () => {
    const f = await fixture("plugin");
    const scope = f.compiler.service.createRequestScope(f.request);
    const check = {
      code: "DEPENDENCY_UNAVAILABLE",
      details: { diagnosticCode: "plugin_not_found" },
    };
    await expect(f.compiler.prepare(scope)).rejects.toMatchObject(check);
    const identity = await f.compiler.service.identity(
      scope,
      await f.compiler.service.capabilities(scope),
    );
    const prepared = await f.compiler.prepare(scope, {
      hasOwner: true,
      identity,
      secrets: [],
      plugins: [],
    });
    expect(prepared.cacheHit).toBe(true);
    await expect(prepared.ensureCompiled()).rejects.toMatchObject(check);
  });

  it("keeps a real missing authority and invalid persisted data distinguishable", async () => {
    const f = await fixture("capability");
    await expect(
      f.compiler.prepare(f.compiler.service.createRequestScope(f.request)),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      details: { diagnosticCode: "capability_not_found" },
    });
    const root = join(
      new PragmaPaths({ pragmaHome: f.home }).dataRoot(),
      "capabilities",
      capabilityId,
    );
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "capability.json"),
      JSON.stringify({ schemaVersion: "pragma.capability/v99" }),
    );
    await expect(
      f.compiler.prepare(f.compiler.service.createRequestScope(f.request)),
    ).rejects.toMatchObject({
      code: "STORAGE_CORRUPTED",
      details: { diagnosticCode: "config_invalid" },
    });
  });

  it.each([
    [
      new PluginStoreError("version_conflict", "Duplicate plugin installation."),
      "DEPENDENCY_UNAVAILABLE",
    ],
    [new SecretStoreError("SECRET_STORE_LOCKED", "Secret store is locked."), "SECRET_STORE_LOCKED"],
    [
      new SecretStoreError("KEYCHAIN_UNAVAILABLE", "Keychain is unavailable."),
      "KEYCHAIN_UNAVAILABLE",
    ],
    [
      new LegacyCredentialMigrationError("SECRET_MIGRATION_REQUIRED", "Migration required."),
      "SECRET_MIGRATION_REQUIRED",
    ],
    [
      new CapabilityCredentialStoreError(
        "migration_required",
        "Legacy credentials require migration.",
      ),
      "SECRET_MIGRATION_REQUIRED",
    ],
    [
      new CapabilityCredentialStoreError("unsupported_version", "Future credential version."),
      "STORAGE_VERSION_UNSUPPORTED",
    ],
  ])("preserves direct resource credential diagnosis %s", async (error, code) => {
    const f = await fixture("capability");
    vi.spyOn(f.ports.capabilityAuthority, "resolve").mockRejectedValue(error);
    const result = await f.compiler
      .prepare(f.compiler.service.createRequestScope(f.request))
      .catch((failure: unknown) => failure);
    expect(IntegrationErrorSchema.parse(result)).toMatchObject({
      code,
      details: { diagnosticCode: error.code },
    });
    expect(JSON.stringify(result)).not.toContain("cause");
  });

  it("preserves canonical failures and maps readiness failures through the same boundary", async () => {
    const f = await fixture();
    const unavailable = createIntegrationError({
      code: "RUNTIME_UNAVAILABLE",
      category: "dependency",
      message: "Runtime unavailable.",
    });
    vi.spyOn(f.runtimes, "bind").mockRejectedValueOnce(unavailable);
    await expect(
      f.compiler.assertReady(f.compiler.service.createRequestScope(f.request)),
    ).rejects.toBe(unavailable);
    vi.spyOn(f.runtimes, "bind").mockRejectedValueOnce(
      new SecretStoreError("SECRET_STORE_LOCKED", "Locked."),
    );
    await expect(
      f.compiler.assertReady(f.compiler.service.createRequestScope(f.request)),
    ).rejects.toMatchObject({ code: "SECRET_STORE_LOCKED" });
  });

  it("does not replace unrelated DSL validation failures with a dependency diagnosis", async () => {
    const f = await fixture();
    const failure = new PragmaDslError("Invalid DSL.", [
      { severity: "error", code: "schema.invalid", message: "Invalid DSL.", path: [] },
    ]);
    vi.spyOn(f.runtimes, "bind").mockRejectedValue(failure);
    await expect(f.compiler.prepare(f.compiler.service.createRequestScope(f.request))).rejects.toBe(
      failure,
    );
  });

  it.each(["environment.resource_unavailable", "environment.plugin_unavailable"])(
    "retains Interpreter diagnosis %s at the Node readiness boundary",
    async (code) => {
      const f = await fixture();
      const failure = new PragmaDslError("A resource is unavailable.", [
        {
          code,
          severity: "error",
          message: "Stable resource diagnosis.",
          path: ["spec", "plugins", 0],
        },
      ]);
      vi.spyOn(f.runtimes, "bind").mockRejectedValue(failure);
      const result = await f.compiler
        .assertReady(f.compiler.service.createRequestScope(f.request))
        .catch((error: unknown) => error);
      expect(IntegrationErrorSchema.parse(result)).toMatchObject({
        code: "DEPENDENCY_UNAVAILABLE",
        details: {
          diagnostics: [
            {
              code,
              message: "Stable resource diagnosis.",
              path: ["spec", "plugins", 0],
              severity: "error",
            },
          ],
        },
      });
    },
  );
});
