import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { PragmaPaths, withFileLock } from "@pragma/core";

import type { PluginCredentialStore } from "./plugin-credential-store.ts";
import { createPluginStore } from "./plugin-store.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PluginStore", () => {
  it("inspects, installs, configures, and resolves a prebuilt plugin", async () => {
    const root = await temporaryRoot();
    const zipPath = join(root, "example.zip");
    await writeFile(zipPath, pluginZip());
    const credentials = memoryCredentials();
    const paths = new PragmaPaths({ pragmaHome: root });
    const store = createPluginStore({
      builtInPluginsPath: join(root, "built-ins"),
      userPluginsPath: join(root, "plugins"),
      paths,
      credentials,
      isReferenced: async () => false,
    });

    const inspection = await store.inspectZip(zipPath);
    expect(inspection.manifest.id).toBe("example");
    const installed = await store.importZip({
      sourcePath: zipPath,
      expectedHash: inspection.contentHash,
    });
    expect(installed.origin).toBe("user");
    expect((await store.list()).map((plugin) => plugin.ref)).toEqual(["plugin:example@1.0.0"]);
    await expect(
      store.updateDefaults({ ref: installed.ref, config: { typo: true }, secrets: {} }),
    ).rejects.toThrow("config is invalid");

    await store.updateDefaults({
      ref: installed.ref,
      config: { enabled: false },
      secrets: { token: "secret-value" },
    });
    const resolved = await store.resolve({ ref: installed.ref });
    expect(resolved.userConfig).toEqual({ enabled: false, token: "secret-value" });
    expect(resolved.packageFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(resolved.verificationFingerprint).toMatch(/^[a-f0-9]{64}$/);
    await expect(store.inspect({ ref: installed.ref })).resolves.toMatchObject({
      ref: installed.ref,
      status: "ready",
      packageFingerprint: resolved.packageFingerprint,
      issues: [],
    });
    const overridden = await store.resolve({ ref: installed.ref, config: { enabled: true } });
    expect(overridden.verificationFingerprint).not.toBe(resolved.verificationFingerprint);
    await store.setSecrets({ "binding:expert-a": "token-a", "binding:expert-b": "token-b" });
    const [expertA, expertB] = await Promise.all([
      store.resolve({
        ref: installed.ref,
        config: { enabled: true },
        secretBindings: { token: "binding:expert-a" },
      }),
      store.resolve({
        ref: installed.ref,
        config: { enabled: false },
        secretBindings: { token: "binding:expert-b" },
      }),
    ]);
    expect(expertA.userConfig).toEqual({ enabled: true, token: "token-a" });
    expect(expertB.userConfig).toEqual({ enabled: false, token: "token-b" });
    await expect(
      store.updateDefaults({
        ref: installed.ref,
        config: { enabled: false },
        secrets: { token: null },
      }),
    ).rejects.toThrow("config is invalid");
    expect((await store.resolve({ ref: installed.ref })).userConfig).toMatchObject({
      token: "secret-value",
    });
    await expect(
      readFile(paths.pluginConfigState(installed.ref), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      ref: installed.ref,
      config: { enabled: false },
      secretBindings: { token: expect.stringMatching(/^binding:/) },
    });
    await expect(readFile(join(paths.pluginStateRoot(), "catalog.json"), "utf8")).rejects.toThrow();
    expect(await readFile(join(resolved.source, "index.mjs"), "utf8")).toContain("export default");
  });

  it("stores concurrent plugin defaults in independent config files and ignores legacy catalog", async () => {
    const root = await temporaryRoot();
    const paths = new PragmaPaths({ pragmaHome: root });
    const credentials = memoryCredentials();
    const store = createPluginStore({
      builtInPluginsPath: join(root, "built-ins"),
      userPluginsPath: join(root, "plugins"),
      paths,
      credentials,
      isReferenced: async () => false,
    });
    const firstZip = join(root, "first.zip");
    const secondZip = join(root, "second.zip");
    await mkdir(paths.pluginStateRoot(), { recursive: true });
    await Promise.all([
      writeFile(firstZip, pluginZip(undefined, "first")),
      writeFile(secondZip, pluginZip(undefined, "second")),
      writeFile(
        join(paths.pluginStateRoot(), "catalog.json"),
        JSON.stringify({
          schemaVersion: 1,
          plugins: { "plugin:first@1.0.0": { config: { enabled: false } } },
        }),
      ),
    ]);
    const [firstInspection, secondInspection] = await Promise.all([
      store.inspectZip(firstZip),
      store.inspectZip(secondZip),
    ]);
    const [first, second] = await Promise.all([
      store.importZip({ sourcePath: firstZip, expectedHash: firstInspection.contentHash }),
      store.importZip({ sourcePath: secondZip, expectedHash: secondInspection.contentHash }),
    ]);

    await Promise.all([
      store.updateDefaults({ ref: first.ref, config: { enabled: true }, secrets: { token: "a" } }),
      store.updateDefaults({
        ref: second.ref,
        config: { enabled: false },
        secrets: { token: "b" },
      }),
    ]);

    const [firstState, secondState] = await Promise.all([
      readFile(paths.pluginConfigState(first.ref), "utf8").then(JSON.parse),
      readFile(paths.pluginConfigState(second.ref), "utf8").then(JSON.parse),
    ]);
    expect(firstState).toMatchObject({ ref: first.ref, config: { enabled: true } });
    expect(secondState).toMatchObject({ ref: second.ref, config: { enabled: false } });
    expect(paths.pluginConfigState(first.ref)).not.toBe(paths.pluginConfigState(second.ref));

    await store.remove(first.ref);
    await expect(readFile(paths.pluginConfigState(first.ref), "utf8")).rejects.toThrow();
    await expect(readFile(paths.pluginConfigState(second.ref), "utf8")).resolves.toContain(
      second.ref,
    );
  });

  it("serializes removal before a queued update without recreating orphan state", async () => {
    const root = await temporaryRoot();
    const paths = new PragmaPaths({ pragmaHome: root });
    const credentials = memoryCredentials();
    const store = createPluginStore({
      builtInPluginsPath: join(root, "built-ins"),
      userPluginsPath: join(root, "plugins"),
      paths,
      credentials,
      isReferenced: async () => false,
    });
    const zipPath = join(root, "example.zip");
    await writeFile(zipPath, pluginZip());
    const inspection = await store.inspectZip(zipPath);
    const installed = await store.importZip({
      sourcePath: zipPath,
      expectedHash: inspection.contentHash,
    });
    await store.updateDefaults({
      ref: installed.ref,
      config: { enabled: true },
      secrets: { token: "initial-token" },
    });
    const state = JSON.parse(await readFile(paths.pluginConfigState(installed.ref), "utf8")) as {
      readonly secretBindings: { readonly token: string };
    };

    let releaseLock!: () => void;
    let lockAcquired!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const heldLock = withFileLock(paths.pluginMutationLock(installed.ref), async () => {
      lockAcquired();
      await release;
    });
    await acquired;

    const removal = store.remove(installed.ref);
    const update = store.updateDefaults({
      ref: installed.ref,
      config: { enabled: false },
      secrets: { token: "late-token" },
    });
    releaseLock();
    await heldLock;

    await removal;
    await expect(update).rejects.toThrow(`Plugin is not installed: ${installed.ref}`);
    await expect(readFile(paths.pluginConfigState(installed.ref), "utf8")).rejects.toThrow();
    await expect(store.list()).resolves.toEqual([]);
    await expect(credentials.has(state.secretBindings.token)).resolves.toBe(false);
  });

  it("rejects a plugin entry with external imports", async () => {
    const root = await temporaryRoot();
    const zipPath = join(root, "invalid.zip");
    await writeFile(
      zipPath,
      pluginZip('import value from "external-package"; export default value;'),
    );
    const store = createPluginStore({
      builtInPluginsPath: join(root, "built-ins"),
      userPluginsPath: join(root, "plugins"),
      paths: new PragmaPaths({ pragmaHome: root }),
      credentials: memoryCredentials(),
      isReferenced: async () => false,
    });
    await expect(store.inspectZip(zipPath)).rejects.toThrow("self-contained ESM");
  });

  it("rejects symbolic links in plugin ZIPs", async () => {
    const root = await temporaryRoot();
    const zipPath = join(root, "linked.zip");
    await writeFile(
      zipPath,
      zipSync({
        ...pluginFiles(),
        linked: [strToU8("index.mjs"), { os: 3, attrs: 0o120777 << 16 }],
      }),
    );
    const store = createPluginStore({
      builtInPluginsPath: join(root, "built-ins"),
      userPluginsPath: join(root, "plugins"),
      paths: new PragmaPaths({ pragmaHome: root }),
      credentials: memoryCredentials(),
      isReferenced: async () => false,
    });
    await expect(store.inspectZip(zipPath)).rejects.toThrow("symbolic links");
  });
});

function pluginZip(source = "export default { id: 'example' };", id = "example"): Uint8Array {
  return zipSync(pluginFiles(source, id));
}

function pluginFiles(source = "export default { id: 'example' };", id = "example") {
  const manifest = {
    schemaVersion: "pragma.plugin/v2",
    id,
    name: id,
    description: "Example plugin",
    version: "1.0.0",
    tags: ["test"],
    runtime: {
      type: "expert-agent-plugin",
      entry: "./index.mjs",
      trust: "trusted-host",
    },
    capabilities: [],
    configuration: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description: "Whether the plugin is enabled.",
          default: true,
        },
        token: {
          type: "string",
          description: "Authentication token.",
          minLength: 1,
          "x-pragma-secret": true,
        },
      },
      required: ["token"],
      additionalProperties: false,
    },
    permissions: { filesystem: [], shell: [], network: [], environment: [] },
  };
  return {
    "plugin.json": strToU8(JSON.stringify(manifest)),
    "package.json": strToU8(JSON.stringify({ name: id, version: "1.0.0", type: "module" })),
    "index.mjs": strToU8(source),
  };
}

function memoryCredentials(): PluginCredentialStore {
  const values = new Map<string, string>();
  return {
    async applyChanges(changes) {
      for (const ref of changes.remove ?? []) values.delete(ref);
      for (const [ref, value] of Object.entries(changes.set ?? {})) values.set(ref, value);
    },
    async set(ref, value) {
      values.set(ref, value);
    },
    async get(ref) {
      return values.get(ref);
    },
    async has(ref) {
      return values.has(ref);
    },
    async remove(ref) {
      values.delete(ref);
    },
    async removePrefix(prefix) {
      for (const ref of values.keys()) if (ref.startsWith(prefix)) values.delete(ref);
    },
    async fingerprint(refs) {
      return refs
        .map((ref) => `${ref}:${values.get(ref) ?? ""}`)
        .join("|")
        .padEnd(64, "0")
        .slice(0, 64);
    },
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-plugin-store-"));
  roots.push(root);
  return root;
}
