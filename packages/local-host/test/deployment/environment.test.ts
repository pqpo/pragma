import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRAGMA_DSL_WRITE_API_VERSION,
  type PragmaRuntimeProfileResource,
} from "@pragma/interpreter/ast";
import { PragmaPaths } from "@pragma/core";
import { createSecretStore, type OsKeychain } from "../../src/index.ts";
import {
  createModelConnectionService,
  createModelProviderStore,
  createPragmaProjectStore,
  inspectAssetReadiness,
  type CapabilityStore,
  type ContextStoreStore,
  type PluginStore,
} from "../../src/deployment/index.ts";
import type { DesktopRuntimeAvailability } from "../../src/deployment-contracts/index.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pragma-deployment-environment-"));
  roots.push(root);
  const keys = new Map<string, Uint8Array>();
  const keychain: OsKeychain = {
    inspect: async () => ({ status: "ready", backend: "macos-keychain" }),
    get: async (service, account) => keys.get(`${service}/${account}`) ?? null,
    set: async (service, account, value) => {
      keys.set(`${service}/${account}`, value);
    },
    delete: async (service, account) => {
      keys.delete(`${service}/${account}`);
    },
  };
  const paths = new PragmaPaths({ pragmaHome: root });
  const secretStore = createSecretStore({
    root: join(root, "state", "secrets"),
    keychain,
    dataRoot: paths.dataRoot(),
  });
  const configPath = paths.modelProviders();
  const store = createModelProviderStore({ configPath, secretStore });
  const project = createPragmaProjectStore({
    projectsPath: paths.projectsRoot(),
    objectsPath: paths.contentObjectsRoot(),
    projectViewsPath: paths.projectViewsCacheRoot(),
  });
  const service = createModelConnectionService({
    store,
    project,
    discover: async () => ({ ok: true, models: [], message: "Discovered.", source: "provider" }),
    test: async ({ provider }) => ({
      ok: provider.apiKey === "private-key",
      code: "success",
      message: "Verified.",
    }),
  });
  return { root, configPath, store, project, service };
}
const input = {
  presetId: "custom-openai",
  name: "Shared connection",
  protocol: "openai-completions",
  baseUrl: "https://api.example.test/v1",
  apiKey: "private-key",
  requiresApiKey: true,
  models: [
    {
      kind: "embedding" as const,
      id: "embedding-test",
      name: "Embedding",
      api: "openai-embeddings" as const,
      maxInputTokens: 8192,
      cost: { input: 0 },
      capabilitiesSource: "manual" as const,
    },
  ],
};
const profile = (providerId: string): PragmaRuntimeProfileResource => ({
  apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
  kind: "RuntimeProfile",
  metadata: {
    id: "zdkgs0fde4xt00vr",
    name: "Execution environment",
    description: "A deployed Runtime profile.",
    tags: [],
  },
  spec: {
    adapter: "pragma.runtime.profile@v1",
    config: { runtimeId: "codex", providerId, model: "embedding-test" },
  },
});

describe("shared deployment environment", () => {
  it("creates a connection from empty state, isolates credentials and detects stale shared impact", async () => {
    const { configPath, store, project, service } = await fixture();
    const provider = await service.create(input);
    await project.publish({ expectedRevision: 0, resources: [profile(provider.id)] });
    const impact = await service.inspectImpact(provider.id);
    expect(impact).toMatchObject({
      scope: "shared",
      complete: true,
      affectedResourceRefs: ["runtime-profile:zdkgs0fde4xt00vr"],
    });
    const updated = await service.update(
      { ...input, id: provider.id, name: "Updated shared connection" },
      { scope: "shared", expectedImpact: impact.fingerprint },
    );
    expect(updated.revision).toBe(provider.revision + 1);
    await expect(
      service.update(
        { ...input, id: provider.id },
        { scope: "shared", expectedImpact: impact.fingerprint },
      ),
    ).rejects.toMatchObject({ code: "connection_impact_conflict" });
    await expect(
      service.update(
        { ...input, id: provider.id, expectedRevision: provider.revision, apiKey: "rejected-key" },
        { scope: "shared" },
      ),
    ).rejects.toMatchObject({ code: "connection_changed" });
    await expect(service.remove(provider.id)).rejects.toThrow("used by a Runtime Profile");
    expect(await readFile(configPath, "utf8")).not.toContain("private-key");
    expect((await store.resolveProviderWithRevision(provider.id)).provider.apiKey).toBe(
      "private-key",
    );
    expect(
      await service.test({ providerId: provider.id, modelId: "embedding-test" }),
    ).toMatchObject({ ok: true });
  });

  it("uses a store-level revision CAS before changing credentials or configuration", async () => {
    const { store } = await fixture();
    const provider = await store.create(input);
    await store.update({ ...input, id: provider.id, name: "Concurrent change" });
    await expect(
      store.update({
        ...input,
        id: provider.id,
        expectedRevision: provider.revision,
        apiKey: "replacement-key",
      }),
    ).rejects.toMatchObject({ code: "connection_changed" });
    expect((await store.resolveProviderWithRevision(provider.id)).provider.apiKey).toBe(
      "private-key",
    );
  });

  it.each([
    { availability: [] as DesktopRuntimeAvailability[], code: "runtime_missing" },
    {
      availability: [
        {
          id: "codex",
          isDefault: false,
          kind: "local",
          displayName: "Codex",
          status: "available",
          modelDiscoveryError: "Authentication failed.",
        },
      ] as DesktopRuntimeAvailability[],
      code: "model_discovery_failed",
    },
    {
      availability: [
        {
          id: "codex",
          isDefault: false,
          kind: "local",
          displayName: "Codex",
          status: "available",
          models: [],
        },
      ] as DesktopRuntimeAvailability[],
      code: "model_missing",
    },
    {
      availability: [
        {
          id: "codex",
          isDefault: false,
          kind: "local",
          displayName: "Codex",
          status: "unavailable",
          reason: "Harness executable unavailable.",
        },
      ] as DesktopRuntimeAvailability[],
      code: "runtime_unavailable",
    },
  ])("distinguishes $code without default substitution", async ({ availability, code }) => {
    const result = await inspectAssetReadiness([profile("provider")], {
      capabilities: {} as CapabilityStore,
      contextStores: {} as ContextStoreStore,
      plugins: {} as PluginStore,
      runtimes: availability,
    });
    expect(result).toMatchObject([{ status: "missing", code }]);
  });
});
