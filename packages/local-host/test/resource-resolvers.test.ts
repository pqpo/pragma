import { createServer } from "node:http";
import { once } from "node:events";
import { loadPragmaProject, formatPragmaYaml } from "@pragma/interpreter";
import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { createRuntimeTestFeatures } from "@pragma/core/testing";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  PragmaPaths,
  createStaticRuntimeResolver,
  createMcpToolRegistryPool,
  executeExecutionTool,
  resolveExecutionTools,
  createPragmaLogger,
  snapshotRuntimeFeatures,
  type Expert,
} from "@pragma/core";
import { PRAGMA_MANAGEMENT_BINDING_REF } from "@pragma/built-in-agents";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalHostResourceResolvers } from "../src/resources/resolvers.ts";
import { createSecretStore, type OsKeychain } from "../src/secrets/secret-store.ts";

const packageReads = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("@pragma/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pragma/core")>();
  return {
    ...actual,
    createExpertAgentPluginPackageFingerprint: async (root: string) => {
      packageReads.paths.push(root);
      return await actual.createExpertAgentPluginPackageFingerprint(root);
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  packageReads.paths.length = 0;
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "pragma-resource-reader-"));
  roots.push(home);
  const paths = new PragmaPaths({ pragmaHome: home });
  const values = new Map<string, Uint8Array>();
  const keychain: OsKeychain = {
    inspect: async () => ({ status: "ready", backend: "macos-keychain" }),
    get: async (service, account) => values.get(`${service}:${account}`) ?? null,
    set: async (service, account, value) => {
      values.set(`${service}:${account}`, Uint8Array.from(value));
    },
    delete: async (service, account) => {
      values.delete(`${service}:${account}`);
    },
  };
  const secretStore = createSecretStore({
    root: paths.secretStoreRoot(),
    dataRoot: paths.dataRoot(),
    keychain,
  });
  const resources = createLocalHostResourceResolvers({ pragmaHome: home, secretStore });
  return { home, paths, resources };
}
async function json(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}
function binding(kind: "capability" | "context", id: string) {
  return `binding:desktop-${kind}.${Buffer.from(id).toString("base64url")}` as const;
}

describe("Node resource readers shared with Desktop", () => {
  it("reads the active historical Capability, preserves an unactivated candidate, and refreshes credential identity", async () => {
    const { home, paths, resources } = await fixture();
    const historical = JSON.parse(
      await readFile(
        new URL("./fixtures/resources/capability-manifest-v2.json", import.meta.url),
        "utf8",
      ),
    ) as { readonly id: string };
    const root = join(paths.dataRoot(), "capabilities", historical.id);
    await json(join(root, "capability.json"), historical);
    const definition = {
      kind: "http_service",
      name: "Historical HTTP",
      description: "",
      baseUrl: "https://example.test",
      auth: { type: "none" },
      timeoutMs: 30000,
      tools: [
        { name: "read", description: "Read example", method: "GET", path: "/read", parameters: [] },
      ],
    };
    await json(join(root, "revisions", "000001", "definition.json"), definition);
    await json(join(root, "health.json"), {
      revision: 1,
      status: "ready",
      checkedAt: "2026-10-01T00:00:00.000Z",
    });
    const first = await resources.capabilityAuthority.resolve(historical.id);
    const manifest = JSON.parse(await readFile(join(root, "capability.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(manifest).toMatchObject({ schemaVersion: "pragma.capability/v4", activeRevision: 1 });
    expect(manifest).not.toHaveProperty("origin");
    expect(await readFile(join(root, "migration-backups", "capability.v2.json"), "utf8")).toContain(
      "pragma.capability/v2",
    );
    const unchanged = await readFile(join(root, "capability.json"), "utf8");
    expect(await resources.capabilityAuthority.resolve(historical.id)).toEqual(first);
    expect(await readFile(join(root, "capability.json"), "utf8")).toBe(unchanged);
    await json(join(root, "capability.json"), { ...manifest, latestRevision: 2 });
    await json(join(root, "revisions", "000002", "definition.json"), {
      ...definition,
      name: "Unactivated candidate",
    });
    await json(join(root, "health.json"), {
      revision: 2,
      status: "needs_attention",
      checkedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(await resources.capabilityAuthority.resolve(historical.id)).toEqual(first);
    await resources.capabilityCredentials.setMany(historical.id, { token: "private-token" });
    const next = await resources.capabilityAuthority.resolve(historical.id);
    expect(next.resolvedRevision).toBe(1);
    expect(next.fingerprint).not.toBe(first.fingerprint);
    expect(JSON.stringify(next)).not.toContain("private-token");
    const host = resources.adapterHost({ id: "mission-a", workspace: { path: home } });
    expect(await host.resolveBinding(binding("capability", historical.id))).toMatchObject({
      revision: "1",
      value: {
        contribution: {
          mcp: {
            mcpServers: {
              historical_http_01234567: {
                allowTools: ["read"],
                toolApprovals: { read: { mode: "ask" } },
              },
            },
          },
        },
      },
    });
    const pending = await resources.capabilityCredentials.prepareMany(historical.id, {
      token: "replacement",
    });
    await expect(resources.capabilityAuthority.resolve(historical.id)).rejects.toThrow(
      "completing an active environment change",
    );
    if (pending !== undefined) await resources.capabilityCredentials.rollback(pending);
  });

  it("compiles real Host MCP defaults for full access, explicit policies, and manual retry", async () => {
    const { home, paths, resources } = await fixture();
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(requests === 1 ? 503 : 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: requests > 1 }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const pool = createMcpToolRegistryPool();
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing test port");
      const id = "00000000-0000-4000-8000-000000000032";
      const root = join(paths.dataRoot(), "capabilities", id);
      await json(join(root, "capability.json"), {
        schemaVersion: "pragma.capability/v4",
        id,
        runtimeKey: "docs",
        name: "Docs",
        kind: "http_service",
        latestRevision: 1,
        activeRevision: 1,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      });
      await json(join(root, "revisions", "000001", "definition.json"), {
        kind: "http_service",
        name: "Docs",
        description: "",
        auth: { type: "none" },
        baseUrl: `http://127.0.0.1:${address.port}`,
        timeoutMs: 30000,
        tools: [
          {
            name: "searchDocChunk",
            description: "Search",
            method: "GET",
            path: "/read",
            parameters: [],
          },
          { name: "write", description: "Write", method: "POST", path: "/write", parameters: [] },
        ],
      });
      await json(join(root, "health.json"), {
        revision: 1,
        status: "ready",
        checkedAt: "2026-10-01T00:00:00.000Z",
      });
      const entry = join(home, "pragma.yaml");
      const capabilityRef = "capability:pcr7npvx0gv8fpka";
      const compile = async (
        mode: string,
        approvals: Record<string, "none" | "ask" | "required"> = {},
      ) => {
        await writeFile(
          entry,
          formatPragmaYaml({
            apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
            kind: "Bundle",
            imports: [],
            resources: [
              {
                apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
                kind: "Expert",
                metadata: {
                  id: "1xddvess309a6gme",
                  name: "Search",
                  description: "Search documents",
                  tags: [],
                },
                spec: {
                  scope: "application",
                  instructions: "Search",
                  tools: [],
                  plugins: [],
                  contextStores: [],
                  capabilities: [
                    { ref: capabilityRef, kind: "tools", tools: ["searchDocChunk", "write"] },
                  ],
                  toolApprovals: approvals,
                },
              },
              {
                apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
                kind: "Capability",
                metadata: {
                  id: "pcr7npvx0gv8fpka",
                  name: "Docs",
                  description: "Document tools",
                  tags: [],
                },
                spec: {
                  adapter: "pragma.capability.host@v1",
                  binding: binding("capability", id),
                  config: { key: "docs" },
                },
              },
            ],
          }),
        );
        const project = await loadPragmaProject(entry);
        expect(await project.validate()).toEqual([]);
        return (
          await project.compile<Expert>("expert:1xddvess309a6gme", {
            workspace: home,
            adapterHost: resources.adapterHost({ id: "mission", workspace: { path: home } }),
            expertExecutionProfiles: {
              "1xddvess309a6gme": { runtimeId: "test", permissionModeId: mode },
            },
            runtimes: createStaticRuntimeResolver({
              defaultRuntimeId: "test",
              runtimes: [
                {
                  descriptor: {
                    id: "test",
                    kind: "test",
                    displayName: "Test",
                    permissionModes: {
                      defaultModeId: "full-access",
                      modes: [
                        {
                          id: "full-access",
                          label: "Full",
                          description: "Full",
                          available: true,
                          defaultMcpApproval: "none",
                        },
                        {
                          id: "request-approval",
                          label: "Ask",
                          description: "Ask",
                          available: true,
                        },
                      ],
                    },
                  },
                  features: snapshotRuntimeFeatures(createRuntimeTestFeatures()),
                  canUse: () => ({ usable: true }),
                },
              ],
            }),
          })
        ).value;
      };
      const approvalHandler = vi.fn(async () => ({
        kind: "tool_approval" as const,
        approved: false,
      }));
      const executeSearch = async (agent: Expert) => {
        const lease = await pool.acquire(agent.mcp);
        try {
          const tool = resolveExecutionTools({
            agent,
            getContext: () => undefined,
            mcpTools: lease.registry.tools,
          }).tools.find((candidate) => candidate.name === "mcp_docs_searchDocChunk")!.tool;
          return await executeExecutionTool({
            agent,
            tool,
            toolCallId: "search",
            args: {},
            signal: undefined,
            humanInteractionHandler: approvalHandler,
            logger: createPragmaLogger(undefined, { component: "test" }),
            state: {},
          });
        } finally {
          await lease.release();
        }
      };
      await expect(executeSearch(await compile("full-access"))).resolves.toMatchObject({
        isError: true,
        details: { status: 503 },
      });
      // A manual retry recompiles the same pinned capability after the failed call.
      await expect(executeSearch(await compile("full-access"))).resolves.toMatchObject({
        content: [{ type: "text", text: '{"ok":true}' }],
      });
      expect(approvalHandler).not.toHaveBeenCalled();
      expect(requests).toBe(2);
      // Explicit asking policies still invoke the real approval gate and denial has no side effects.
      for (const approval of ["ask", "required"] as const) {
        await expect(
          executeSearch(await compile("full-access", { mcp_docs_searchDocChunk: approval })),
        ).resolves.toMatchObject({ isError: true });
      }
      expect(approvalHandler).toHaveBeenCalledTimes(2);
      expect(requests).toBe(2);
      for (const [mode, configured, expected] of [
        ["full-access", undefined, "none"],
        ["request-approval", undefined, "ask"],
        ["full-access", "ask", "ask"],
        ["full-access", "required", "required"],
        ["request-approval", "none", "none"],
      ] as const) {
        const expert = await compile(
          mode,
          configured === undefined ? {} : { mcp_docs_searchDocChunk: configured },
        );
        expect(expert.mcp?.mcpServers["docs"]?.toolApprovals?.["searchDocChunk"]?.mode).toBe(
          expected,
        );
        expect(expert.mcp?.mcpServers["docs"]?.toolApprovals?.["write"]?.mode).toBe("required");
      }
      const cannotBypassWrite = await compile("full-access", { mcp_docs_write: "none" });
      expect(cannotBypassWrite.mcp?.mcpServers["docs"]?.toolApprovals?.["write"]?.mode).toBe(
        "required",
      );
    } finally {
      await pool.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("opens and upgrades a real historical ContextStore without Desktop running", async () => {
    const { home, paths, resources } = await fixture();
    const id = "00000000-0000-4000-8000-000000000031";
    const root = join(paths.contextStoresRoot(), id);
    await mkdir(dirname(root), { recursive: true });
    await cp(new URL("./fixtures/resources/context-store-v3/", import.meta.url), root, {
      recursive: true,
    });
    const host = resources.adapterHost({ id: "mission-a", workspace: { path: home } });
    const resolved = await host.resolveBinding(binding("context", id));
    expect(resolved?.value).toMatchObject({ storeName: "Historical v3 knowledge" });
    const store = (
      resolved?.value as { store: { readContext: (request: { id: string }) => Promise<unknown> } }
    ).store;
    expect(await store.readContext({ id: "Architecture Notes.md" })).toMatchObject({ ok: true });
    const authority = await readFile(join(root, "store.json"), "utf8");
    expect(JSON.parse(authority)).toMatchObject({
      schemaVersion: "pragma.context-store/v5",
      writeApprovalMode: "required",
      contentRevision: 1,
    });
    expect((await host.resolveBinding(binding("context", id)))?.fingerprint).toBe(
      resolved?.fingerprint,
    );
    expect(await readFile(join(root, "store.json"), "utf8")).toBe(authority);
    await json(join(root, "store.json"), {
      ...JSON.parse(authority),
      schemaVersion: "pragma.context-store/v999",
    });
    await expect(host.resolveBinding(binding("context", id))).rejects.toThrow("unsupported schema");
  });

  it("resolves an installed plugin with persisted config and SecretStore handles, and notices secret replacement", async () => {
    const { paths, resources } = await fixture();
    const root = join(paths.pluginsRoot(), "example", "1.0.0");
    await json(join(root, "plugin.json"), {
      schemaVersion: "pragma.plugin/v2",
      id: "example",
      version: "1.0.0",
      name: "Example",
      description: "Example plugin",
      tags: [],
      runtime: { type: "expert-agent-plugin", entry: "index.mjs", trust: "trusted-host" },
      capabilities: [],
      configuration: {
        type: "object",
        properties: {
          enabled: { type: "boolean", default: true },
          token: { type: "string", "x-pragma-secret": true },
        },
        required: ["token"],
        additionalProperties: false,
      },
      permissions: { filesystem: [], shell: [], network: [], environment: [] },
    });
    await writeFile(join(root, "index.mjs"), "export default { id: 'example' };\n");
    await json(join(root, "package.json"), { type: "module", name: "example", version: "1.0.0" });
    await json(join(paths.pluginsRoot(), "unrelated-broken", "1.0.0", "plugin.json"), {
      invalid: true,
    });
    const ref = "plugin:example@1.0.0";
    await json(paths.pluginConfigState(ref), {
      schemaVersion: 1,
      ref,
      config: { enabled: false },
      secretBindings: { token: "binding:example-token" },
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    await resources.pluginCredentials.set("binding:example-token", "secret-one");
    const inspected = await resources.plugins.inspect({ binding: { ref } });
    expect(packageReads.paths).toEqual([root]);
    expect(inspected).toMatchObject({ status: "ready", issues: [] });
    expect(JSON.stringify(inspected)).not.toContain("secret-one");
    const resolved = await resources.plugins.resolve({
      binding: { ref, config: { enabled: true } },
    });
    expect(resolved.userConfig).toEqual({ enabled: true, token: "secret-one" });
    expect(packageReads.paths).toEqual([root, root]);
    expect(resolved.packageFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(resolved.cachePolicy).toBe("immutable");
    await resources.pluginCredentials.set("binding:example-token", "secret-two");
    expect(
      (await resources.plugins.inspect({ binding: { ref } })).verificationFingerprint,
    ).not.toBe(inspected.verificationFingerprint);
    // Historical layout plus the canonical install must preserve the original
    // duplicate-ref rejection, without fingerprinting either conflicting copy.
    const legacyRoot = join(paths.pluginsRoot(), "historical-layout", "installed");
    await cp(root, legacyRoot, { recursive: true });
    const beforeConflict = [...packageReads.paths];
    await expect(resources.plugins.resolve({ binding: { ref } })).rejects.toMatchObject({
      code: "version_conflict",
    });
    expect(packageReads.paths).toEqual(beforeConflict);
    await rm(legacyRoot, { recursive: true });
    await resources.plugins.resolve({ binding: { ref } });
    expect(packageReads.paths).toEqual([...beforeConflict, root]);
  });

  it("diagnoses unsupported management/artifact/secret preparation and keeps stop preparation independent of missing credentials", async () => {
    const { home, resources } = await fixture();
    const request = { id: "mission-a", workspace: { path: home } };
    const host = resources.adapterHost(request);
    await expect(host.resolveBinding(PRAGMA_MANAGEMENT_BINDING_REF)).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      diagnosticCode: "management_ports_unavailable",
    });
    await expect(host.resolveSecret("binding:missing")).rejects.toMatchObject({
      diagnosticCode: "secret_binding_unavailable",
    });
    await expect(
      host.resolveArtifact({
        type: "external",
        uri: "https://example.test/artifact",
        integrity: "sha256:" + "a".repeat(64),
      } as Parameters<typeof host.resolveArtifact>[0]),
    ).rejects.toMatchObject({ diagnosticCode: "external_artifact_resolver_unavailable" });
    expect(
      await resources
        .adapterHost(request, "stop")
        .resolveBinding(binding("capability", randomUUID())),
    ).toMatchObject({ revision: "stop", value: { contribution: { tools: [] } } });
  });
});
