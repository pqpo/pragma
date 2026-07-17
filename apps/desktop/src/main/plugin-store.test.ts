import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

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
    const store = createPluginStore({
      builtInPluginsPath: join(root, "built-ins"),
      userPluginsPath: join(root, "plugins"),
      statePath: join(root, "state", "catalog.json"),
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
    expect(await readFile(join(resolved.source, "index.mjs"), "utf8")).toContain("export default");
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
      statePath: join(root, "state", "catalog.json"),
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
      statePath: join(root, "state", "catalog.json"),
      credentials: memoryCredentials(),
      isReferenced: async () => false,
    });
    await expect(store.inspectZip(zipPath)).rejects.toThrow("symbolic links");
  });
});

function pluginZip(source = "export default { id: 'example' };"): Uint8Array {
  return zipSync(pluginFiles(source));
}

function pluginFiles(source = "export default { id: 'example' };") {
  const manifest = {
    schemaVersion: "pragma.plugin/v2",
    id: "example",
    name: "Example",
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
    "package.json": strToU8(JSON.stringify({ name: "example", version: "1.0.0", type: "module" })),
    "index.mjs": strToU8(source),
  };
}

function memoryCredentials(): PluginCredentialStore {
  const values = new Map<string, string>();
  return {
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
