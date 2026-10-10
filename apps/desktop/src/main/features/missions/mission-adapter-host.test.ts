import { createHash } from "node:crypto";
import * as pragmaCommandDistribution from "../built-in-agents/pragma-command-distribution.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PRAGMA_MANAGEMENT_BINDING_REF,
  PRAGMA_MANAGEMENT_CAPABILITY_REVISION,
  createPragmaManagementTools,
} from "@pragma/built-in-agents";
import { createStaticRuntimeResolver, snapshotRuntimeFeatures, type Expert } from "@pragma/core";
import { createRuntimeTestFeatures } from "@pragma/core/testing";
import { formatPragmaYaml, loadPragmaProject } from "@pragma/interpreter";
import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";

import { createSecretStore } from "@pragma/local-host";
import { createLocalHostResourceResolvers } from "@pragma/local-host/resources";

import { createDesktopAdapterHost } from "./mission-adapter-host.ts";
import { createContextStoreStore } from "../context-stores/context-store-store.ts";
import { desktopContextBindingRef } from "../../platform/bindings/desktop-binding-ref.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("Desktop Pragma adapter Host", () => {
  it("resolves persisted Secret bindings through the same credential authority as Node", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-secret-port-"));
    temporaryRoots.push(root);
    const keys = new Map<string, Uint8Array>();
    const secretStore = createSecretStore({
      root: join(root, "data", "secrets"),
      dataRoot: join(root, "data"),
      keychain: {
        inspect: async () => ({ status: "ready", backend: "macos-keychain" }),
        get: async (service, account) => keys.get(`${service}:${account}`) ?? null,
        set: async (service, account, value) => {
          keys.set(`${service}:${account}`, Uint8Array.from(value));
        },
        delete: async (service, account) => {
          keys.delete(`${service}:${account}`);
        },
      },
    });
    const resources = createLocalHostResourceResolvers({ pragmaHome: root, secretStore });
    const ref = "secret:fixture-http-token";
    await resources.pluginCredentials.set(ref, "fixture-private-value");
    const desktop = createDesktopAdapterHost(
      {
        capabilityStore: {} as never,
        capabilityCredentials: {} as never,
        capabilitiesPath: root,
        resolveSecret: (target) => resources.pluginCredentials.get(target),
      },
      root,
    );
    const node = resources.adapterHost({ id: "fixture", workspace: { path: root } });
    expect(await desktop.resolveSecret(ref)).toBe(await node.resolveSecret(ref));
    await expect(desktop.resolveSecret("secret:missing")).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      diagnosticCode: "secret_binding_unavailable",
      resourceRef: "secret:missing",
    });
    const locked = new Error("fixture-keychain-locked");
    const unavailable = createDesktopAdapterHost(
      {
        capabilityStore: {} as never,
        capabilityCredentials: {} as never,
        capabilitiesPath: root,
        resolveSecret: vi.fn(async () => {
          throw locked;
        }),
      },
      root,
    );
    await expect(unavailable.resolveSecret(ref)).rejects.toBe(locked);
  });

  it("does not resolve the management binding when no management ports are installed", async () => {
    const host = createDesktopAdapterHost(
      {} as Parameters<typeof createDesktopAdapterHost>[0],
      "/unused",
    );

    await expect(host.resolveBinding(PRAGMA_MANAGEMENT_BINDING_REF)).resolves.toBeUndefined();
  });

  it.each(["unscoped", "stop"] as const)(
    "does not prepare a command launcher for %s bindings",
    async (mode) => {
      const prepare = vi.spyOn(pragmaCommandDistribution, "prepareDesktopPragmaCommand");
      const host = createDesktopAdapterHost(
        {
          capabilityStore: {} as never,
          capabilityCredentials: {} as never,
          capabilitiesPath: "/unused",
          pragmaManagement: { knowledgeRevisions: {} as never },
          ...(mode === "stop"
            ? {
                purpose: "stop" as const,
                pragmaManagementScope: { missionId: "stop-mission", workspacePath: "/workspace" },
              }
            : {}),
        },
        "/workspace",
      );
      const binding = await host.resolveBinding(PRAGMA_MANAGEMENT_BINDING_REF);
      expect(prepare).not.toHaveBeenCalled();
      expect(binding?.value).not.toHaveProperty("contribution.hooks");
    },
  );

  it("fingerprints the complete management tool contract including approvals", async () => {
    const prepare = vi
      .spyOn(pragmaCommandDistribution, "prepareDesktopPragmaCommand")
      .mockResolvedValue("/private/commands");
    const pragmaManagement = { knowledgeRevisions: {} as never };
    const pragmaManagementScope = {
      missionId: "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b",
      workspacePath: "/workspace/one",
    };
    const host = createDesktopAdapterHost(
      {
        pragmaManagement,
        pragmaManagementScope,
        pragmaHome: "/private/pragma",
      } as unknown as Parameters<typeof createDesktopAdapterHost>[0],
      "/unused",
    );
    const tools = createPragmaManagementTools(pragmaManagement, pragmaManagementScope);
    const expectedFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          scope: pragmaManagementScope,
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            approval: tool.approval,
          })),
        }),
      )
      .digest("hex");

    await expect(host.resolveBinding(PRAGMA_MANAGEMENT_BINDING_REF)).resolves.toMatchObject({
      revision: String(PRAGMA_MANAGEMENT_CAPABILITY_REVISION),
      fingerprint: expectedFingerprint,
      value: { contribution: { hooks: { beforeSessionCreate: expect.any(Function) } } },
    });
    expect(prepare).toHaveBeenCalledWith({ cacheRoot: "/private/pragma/cache" });

    const otherHost = createDesktopAdapterHost(
      {
        pragmaManagement,
        pragmaManagementScope: {
          ...pragmaManagementScope,
          missionId: "4fc96ef9-1825-447d-a17f-d820f6fd4855",
        },
      } as unknown as Parameters<typeof createDesktopAdapterHost>[0],
      "/unused",
    );
    const [first, second] = await Promise.all([
      host.resolveBinding(PRAGMA_MANAGEMENT_BINDING_REF),
      otherHost.resolveBinding(PRAGMA_MANAGEMENT_BINDING_REF),
    ]);
    expect(first?.fingerprint).not.toBe(second?.fingerprint);
  });

  it("opens a real file Context store at the composition boundary", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pragma-desktop-file-context-"));
    temporaryRoots.push(rootDir);
    await writeFile(join(rootDir, "rules.md"), "# Rules\nKeep boundaries explicit.\n", "utf8");
    const host = createDesktopAdapterHost(
      {} as Parameters<typeof createDesktopAdapterHost>[0],
      rootDir,
    );

    const store = host.openFileContextStore?.({ rootDir });
    await expect(store?.readContext({ id: "rules.md" })).resolves.toMatchObject({
      ok: true,
      value: { content: "# Rules\nKeep boundaries explicit.\n" },
    });
  });

  it("changes the compiled environment fingerprint when latest knowledge changes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pragma-desktop-context-fingerprint-"));
    temporaryRoots.push(rootDir);
    const contextStores = createContextStoreStore({ storesPath: join(rootDir, "context-stores") });
    const context = await contextStores.create({
      mode: "blank",
      name: "Project knowledge",
      description: "Shared project guidance.",
    });
    await contextStores.createFile(context.id, "guide.md", "# First revision\n");
    const contextResourceId = "1ymdp8c7rvxs4d3v";
    const binding = desktopContextBindingRef(context.id);
    const expertResource = (id: string, name: string) => ({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Expert",
      metadata: {
        id,
        avatarId: "pragma.avatar.expert.default",
        name,
        description: "Uses project knowledge.",
        tags: [],
      },
      spec: {
        scope: "Writing",
        instructions: "Use the mounted knowledge.",
        runtime: { ref: "runtime-profile:rdzgnq05qfqcpqcm" },
        capabilities: [],
        toolApprovals: {},
        contextStores: [
          {
            ref: `context-store:${contextResourceId}`,
            namespace: "project_knowledge",
            required: true,
          },
        ],
        plugins: [],
        tools: [],
      },
    });
    const entry = join(rootDir, "pragma.yaml");
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
        kind: "Bundle",
        imports: [],
        resources: [
          {
            apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
            kind: "RuntimeProfile",
            metadata: {
              id: "rdzgnq05qfqcpqcm",
              name: "Test runtime",
              description: "Runtime for fingerprint verification.",
              tags: [],
            },
            spec: {
              adapter: "pragma.runtime.profile@v1",
              config: { runtimeId: "test", providerId: "test", model: "test-model" },
            },
          },
          {
            apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
            kind: "ContextStore",
            metadata: {
              id: contextResourceId,
              name: "Project knowledge",
              description: "Desktop-managed knowledge.",
              tags: ["desktop-managed"],
            },
            spec: {
              adapter: "pragma.context.host@v1",
              binding,
              config: { key: context.id },
            },
          },
          expertResource("1xddvess309a6gme", "Writer"),
          expertResource("3sfd30h5017wd17d", "Reviewer"),
        ],
      }),
      "utf8",
    );
    const project = await loadPragmaProject(entry);
    const adapterHost = createDesktopAdapterHost(
      {
        contextStores,
        capabilityStore: {} as never,
        capabilityCredentials: {} as never,
        capabilitiesPath: join(rootDir, "capabilities"),
      },
      rootDir,
    );
    const runtimes = createStaticRuntimeResolver({
      defaultRuntimeId: "test",
      runtimes: [
        {
          features: snapshotRuntimeFeatures(createRuntimeTestFeatures()),
          descriptor: { id: "test", kind: "test", displayName: "Test" },
          canUse: () => ({ usable: true }),
        },
      ],
    });
    const expertRefs = ["expert:1xddvess309a6gme", "expert:3sfd30h5017wd17d"] as const;
    const compile = async (expertRef: (typeof expertRefs)[number]) =>
      await project.compile<Expert>(expertRef, {
        workspace: rootDir,
        adapterHost,
        runtimes,
      });

    const before = await Promise.all(expertRefs.map(compile));
    const currentContent = await contextStores.getContent(context.id, "guide.md");
    if (currentContent.revision === undefined) throw new Error("Managed content has no revision.");
    await contextStores.updateFile(
      context.id,
      "guide.md",
      "# Second revision\n",
      currentContent.metadata,
      currentContent.revision,
    );
    const after = await Promise.all(expertRefs.map(compile));
    const contextRef = `context-store:${contextResourceId}`;
    const contextFingerprint = (compiled: (typeof before)[number]) => {
      const resource = compiled.environmentFingerprint.resources.find(
        (candidate) => candidate.ref === contextRef,
      );
      if (resource === undefined) throw new Error("Compiled context fingerprint is missing.");
      return resource;
    };
    const beforeResources = before.map(contextFingerprint);
    const afterResources = after.map(contextFingerprint);

    expect(binding).toBe(desktopContextBindingRef(context.id));
    expect(new Set(beforeResources.map((resource) => resource.bindingRevision)).size).toBe(1);
    expect(new Set(afterResources.map((resource) => resource.bindingRevision)).size).toBe(1);
    for (const [index, compiled] of after.entries()) {
      expect(compiled.environmentFingerprint.value).not.toBe(
        before[index]!.environmentFingerprint.value,
      );
      expect(afterResources[index]!.bindingRevision).not.toBe(
        beforeResources[index]!.bindingRevision,
      );
      expect(afterResources[index]!.verificationFingerprint).not.toBe(
        beforeResources[index]!.verificationFingerprint,
      );
    }
  });
});
