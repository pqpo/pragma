import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PRAGMA_MANAGEMENT_BINDING_REF,
  PRAGMA_MANAGEMENT_CAPABILITY_REVISION,
  createPragmaManagementTools,
} from "@pragma/built-in-agents";
import {
  createStaticRuntimeResolver,
  snapshotRuntimeFeatures,
  type Expert,
} from "@pragma/core";
import { createRuntimeTestFeatures } from "@pragma/core/testing";
import { formatPragmaYaml, loadPragmaProject } from "@pragma/interpreter";
import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";

import { createDesktopAdapterHost } from "./mission-adapter-host.ts";
import { createContextStoreStore } from "../context-stores/context-store-store.ts";
import { desktopContextBindingRef } from "../../platform/bindings/desktop-binding-ref.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("Desktop Pragma adapter Host", () => {
  it("does not resolve the management binding when no management ports are installed", async () => {
    const host = createDesktopAdapterHost(
      {} as Parameters<typeof createDesktopAdapterHost>[0],
      "/unused",
    );

    await expect(host.resolveBinding(PRAGMA_MANAGEMENT_BINDING_REF)).resolves.toBeUndefined();
  });

  it("fingerprints the complete management tool contract including approvals", async () => {
    const pragmaManagement = { knowledgeRevisions: {} as never };
    const pragmaManagementScope = {
      missionId: "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b",
      workspacePath: "/workspace/one",
    };
    const host = createDesktopAdapterHost(
      { pragmaManagement, pragmaManagementScope } as unknown as Parameters<
        typeof createDesktopAdapterHost
      >[0],
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
    });

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
