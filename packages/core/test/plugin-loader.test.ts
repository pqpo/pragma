import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ExpertAgentPluginLoadError,
  createExpertAgentPluginPackageFingerprint,
  loadExpertAgentPlugins,
  prepareExpertAgentPluginSource,
} from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Expert plugin loading", () => {
  it("fails closed by default and supports explicit diagnostic collection", async () => {
    const pragmaHome = await temporaryRoot("pragma-home");
    await expect(
      loadExpertAgentPlugins({ agentId: "agent", pragmaHome, sources: ["/missing/plugin"] }),
    ).rejects.toBeInstanceOf(ExpertAgentPluginLoadError);
    await expect(
      loadExpertAgentPlugins({
        agentId: "agent",
        pragmaHome,
        sources: ["/missing/plugin"],
        pluginFailurePolicy: "collect",
      }),
    ).resolves.toMatchObject({
      pluginEntries: [],
      issues: [{ code: "invalid_source" }],
    });
  });

  it("verifies exact references and package fingerprints", async () => {
    const source = await createPluginPackage({ id: "identity", version: "1.0.0" });
    const pragmaHome = await temporaryRoot("pragma-home");
    const packageFingerprint = await createExpertAgentPluginPackageFingerprint(source);
    await expect(
      loadExpertAgentPlugins({
        agentId: "agent",
        pragmaHome,
        sources: [
          {
            source,
            expectedRef: "plugin:identity@1.0.0",
            packageFingerprint,
          },
        ],
      }),
    ).resolves.toMatchObject({ pluginEntries: [{ entry: { id: "identity" } }], issues: [] });
    await expect(
      loadExpertAgentPlugins({
        agentId: "other-agent",
        pragmaHome,
        sources: [{ source, expectedRef: "plugin:identity@2.0.0", packageFingerprint }],
      }),
    ).rejects.toMatchObject({ issues: [{ code: "identity_conflict" }] });
  });

  it("treats id and version as immutable across different package bytes", async () => {
    const first = await createPluginPackage({ id: "immutable", version: "1.0.0", marker: "one" });
    const second = await createPluginPackage({ id: "immutable", version: "1.0.0", marker: "two" });
    const pragmaHome = await temporaryRoot("pragma-home");
    await loadExpertAgentPlugins({ agentId: "agent", pragmaHome, sources: [first] });
    await expect(
      loadExpertAgentPlugins({ agentId: "agent", pragmaHome, sources: [second] }),
    ).rejects.toMatchObject({ issues: [{ code: "identity_conflict" }] });
  });

  it("isolates host-managed package revisions by fingerprint without changing the ref", async () => {
    const first = await createPluginPackage({ id: "built-in", version: "0.0.0", marker: "one" });
    const second = await createPluginPackage({ id: "built-in", version: "0.0.0", marker: "two" });
    const pragmaHome = await temporaryRoot("pragma-home");
    const firstFingerprint = await createExpertAgentPluginPackageFingerprint(first);
    const secondFingerprint = await createExpertAgentPluginPackageFingerprint(second);
    const firstInstalled = await prepareExpertAgentPluginSource(
      {
        source: first,
        expectedRef: "plugin:built-in@0.0.0",
        packageFingerprint: firstFingerprint,
        cachePolicy: "host-managed",
      },
      { agentId: "agent", pragmaHome },
    );
    const secondInstalled = await prepareExpertAgentPluginSource(
      {
        source: second,
        expectedRef: "plugin:built-in@0.0.0",
        packageFingerprint: secondFingerprint,
        cachePolicy: "host-managed",
      },
      { agentId: "agent", pragmaHome },
    );

    expect(secondInstalled).not.toBe(firstInstalled);
    await expect(readFile(join(firstInstalled, "index.mjs"), "utf8")).resolves.toContain("one");
    await expect(readFile(join(secondInstalled, "index.mjs"), "utf8")).resolves.toContain("two");
  });

  it("requires explicit immutable identity for host-managed sources", async () => {
    const source = await createPluginPackage({ id: "built-in", version: "0.0.0" });
    await expect(
      prepareExpertAgentPluginSource(
        { source, expectedRef: "plugin:built-in@0.0.0", cachePolicy: "host-managed" },
        { agentId: "agent", pragmaHome: await temporaryRoot("pragma-home") },
      ),
    ).rejects.toThrow("exact ref and package fingerprint");
  });

  it("allows concurrent installation of identical bytes", async () => {
    const source = await createPluginPackage({ id: "concurrent", version: "1.0.0" });
    const pragmaHome = await temporaryRoot("pragma-home");
    const results = await Promise.all(
      Array.from(
        { length: 4 },
        async () =>
          await loadExpertAgentPlugins({ agentId: "agent", pragmaHome, sources: [source] }),
      ),
    );
    expect(results.every((result) => result.pluginEntries.length === 1)).toBe(true);
  });

  it("excludes dependency directories from the installed package", async () => {
    const source = await createPluginPackage({ id: "filtered", version: "1.0.0" });
    await mkdir(join(source, "node_modules", "dependency"), { recursive: true });
    await writeFile(join(source, "node_modules", "dependency", "index.js"), "ignored");
    const installed = await prepareExpertAgentPluginSource(source, {
      agentId: "agent",
      pragmaHome: await temporaryRoot("pragma-home"),
    });
    await expect(stat(join(installed, "node_modules"))).rejects.toThrow();
  });
});

async function createPluginPackage(options: {
  readonly id: string;
  readonly version: string;
  readonly marker?: string;
}): Promise<string> {
  const root = await temporaryRoot("plugin");
  const manifest = {
    schemaVersion: "pragma.plugin/v2",
    id: options.id,
    name: options.id,
    description: `${options.id} plugin`,
    version: options.version,
    tags: [],
    runtime: { type: "expert-agent-plugin", entry: "./index.mjs", trust: "trusted-host" },
    capabilities: [],
    configuration: { type: "object", properties: {}, additionalProperties: false },
    permissions: { filesystem: [], shell: [], network: [], environment: [] },
  };
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: options.id, version: options.version, type: "module" }),
    ),
    writeFile(join(root, "plugin.json"), JSON.stringify(manifest)),
    writeFile(
      join(root, "index.mjs"),
      `export const marker = ${JSON.stringify(options.marker ?? "default")};\nexport default { id: ${JSON.stringify(options.id)}, name: ${JSON.stringify(options.id)}, description: ${JSON.stringify(`${options.id} plugin`)}, version: ${JSON.stringify(options.version)}, tags: [], manifest: ${JSON.stringify(manifest)}, setup: () => ({}) };\n`,
    ),
  ]);
  return root;
}

async function temporaryRoot(kind: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pragma-${kind}-`));
  roots.push(root);
  return root;
}
