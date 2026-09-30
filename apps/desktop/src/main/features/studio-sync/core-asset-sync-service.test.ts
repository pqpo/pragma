import { parsePragmaYaml } from "@pragma/interpreter";
import { readSyncRepository } from "./asset-sync-repository.ts";
import { execFile } from "node:child_process";
import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  hashSnapshotContent,
  type ContextStoreStore,
} from "../context-stores/context-store-store.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import {
  createPragmaProjectStore,
  PragmaProjectStoreError,
} from "../projects/pragma-project-store.ts";
import type { WorkflowLayoutStore } from "../projects/workflow-layout-store.ts";
import { createCoreAssetSyncService } from "./core-asset-sync-service.ts";
import { unavailableCoreAssetRuntimeBindings } from "./core-asset-sync-service.ts";
import {
  bindExistingDesktopContextResource,
  createDesktopCapabilityResource,
  createDesktopContextResource,
} from "../../platform/bindings/desktop-bound-resource-policy.ts";
import { createAssetTransferService } from "../asset-transfer/asset-transfer-service.ts";
import {
  canonicalPragmaResourceRef,
  PRAGMA_DSL_WRITE_API_VERSION,
  type PragmaResource,
} from "@pragma/interpreter/ast";

const exec = promisify(execFile);
const storeId = "f13af121-439b-4bad-8fe4-8b7dc27554d3";
const skillId = "0df66ebd-69bb-4656-82e5-5634a3878139";
const remote = "ssh://git@pragma.test/assets.git";
const roots: string[] = [];
afterEach(async () => {
  delete process.env.GIT_CONFIG_GLOBAL;
  delete process.env.GIT_CONFIG_NOSYSTEM;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pragma-core-sync-test-"));
  roots.push(root);
  const bare = join(root, "assets.git");
  const seed = join(root, "seed");
  await exec("git", ["init", "--bare", bare]);
  await mkdir(seed);
  await exec("git", ["-C", seed, "init", "-b", "main"]);
  await writeFile(join(seed, "README.md"), "Core asset repository\n");
  await exec("git", ["-C", seed, "add", "README.md"]);
  await exec("git", [
    "-C",
    seed,
    "-c",
    "user.name=Pragma Test",
    "-c",
    "user.email=test@pragma.test",
    "commit",
    "-m",
    "Initialize",
  ]);
  await exec("git", ["-C", seed, "remote", "add", "origin", bare]);
  await exec("git", ["-C", seed, "push", "origin", "main"]);
  await exec("git", ["-C", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
  const config = join(root, "gitconfig");
  await writeFile(
    config,
    `[url "file://${root}/"]\n\tinsteadOf = ssh://git@pragma.test/\n[user]\n\tname = Configured User\n\temail = configured@pragma.test\n`,
  );
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  return root;
}

function device(
  root: string,
  name?: string,
  initialSkillRoot?: string,
  initialResources: readonly PragmaResource[] = [],
  initialLayout?: {
    nodes: Record<string, { x: number; y: number }>;
    viewport: { x: number; y: number; zoom: number };
  },
  projectOverride?: PragmaProjectStore,
  capabilitiesOverride?: CapabilityStore,
  reportNameResolutionIssue?: (issue: {
    code: string;
    resourceKey: string;
    resourceKind: string;
    bindingId: string;
  }) => void,
) {
  let description = "Docs";
  let value = name;
  let revision = 1;
  let skillRoot = initialSkillRoot;
  let projectRevision = 1;
  let resources = [...initialResources];
  let layout = initialLayout;
  const skillCapability = () => ({
    manifest: { id: skillId, latestRevision: 1 },
    definition: {
      kind: "skill",
      name: "review-notes",
      description: "Review notes",
      contentHash: "a".repeat(64),
      executablePaths: [],
    },
    managedBy: "user",
  });
  const stores = {
    exists: async () => value !== undefined,
    list: async () =>
      value === undefined
        ? []
        : [
            {
              id: storeId,
              name: value,
              description,
              contentRevision: revision,
              snapshotHash: hashSnapshotContent([], []),
            },
          ],
    getSnapshot: async () => ({ revision, directories: [], files: [] }),
    createFromSnapshot: async (input: { name: string }) => {
      value = input.name;
      return { id: storeId };
    },
    appendSnapshot: async (input: { name?: string }) => {
      value = input.name ?? value;
      revision += 1;
      return { id: storeId };
    },
    remove: async () => {
      value = undefined;
    },
  } as unknown as ContextStoreStore;
  const fakeProject = {
    projectId: "studio",
    get: async () => ({ projectId: "studio", revision: projectRevision, resources }),
    validateChanges: async () => [],
    remove: async (input: { ref: string }) => {
      resources = resources.filter(
        (resource) => canonicalPragmaResourceRef(resource) !== input.ref,
      );
      projectRevision += 1;
      return { projectId: "studio", revision: projectRevision, resources };
    },
    apply: async (input: { upserts: PragmaResource[]; removals: string[] }) => {
      const remove = new Set([...input.removals, ...input.upserts.map(canonicalPragmaResourceRef)]);
      resources = [
        ...resources.filter((resource) => !remove.has(canonicalPragmaResourceRef(resource))),
        ...input.upserts,
      ];
      projectRevision += 1;
      return { projectId: "studio", revision: projectRevision, resources };
    },
  } as unknown as PragmaProjectStore;
  const project = projectOverride ?? fakeProject;
  const layouts = {
    get: async () =>
      layout === undefined ? null : { ...layout, projectId: "studio", flowId: "t1e73vjvctx49gkq" },
    save: async (value: typeof layout) => {
      layout = value;
      return value;
    },
  } as unknown as WorkflowLayoutStore;
  const capabilities =
    capabilitiesOverride ??
    ({
      list: async () => (skillRoot === undefined ? [] : [skillCapability()]),
      skillFilesPath: async () => skillRoot,
      publishNewSkillRevisionCandidate: async (input: { sourcePath: string }) => {
        const destination = join(root, "restored-skill");
        await cp(input.sourcePath, destination, { recursive: true });
        skillRoot = destination;
        return skillCapability();
      },
    } as unknown as CapabilityStore);
  const service = createCoreAssetSyncService({
    configurationPath: join(root, "settings.json"),
    statePath: join(root, "state.json"),
    project,
    layouts,
    stores,
    capabilities,
    getRuntimes: async () => [],
    ...(reportNameResolutionIssue === undefined ? {} : { reportNameResolutionIssue }),
  });
  return {
    service,
    name: () => value,
    setDescription: (next: string) => {
      description = next;
    },
    rename: (next: string) => {
      value = next;
      revision += 1;
    },
    remove: () => {
      value = undefined;
    },
    skillRoot: () => skillRoot,
    resources: () => resources,
    replaceResources: (next: readonly PragmaResource[]) => {
      resources = [...next];
      projectRevision += 1;
    },
    layout: () => layout,
  };
}

describe("core asset Git synchronization", { timeout: 30_000 }, () => {
  it("preserves a binding rebound while another orphan cleanup changes the head", async () => {
    const first = createDesktopContextResource({ owner: "project-expert", storeId });
    const second = createDesktopContextResource({ owner: "system-expert-customization", storeId });
    const restoredId = "1a8c2051-10e0-489a-bc9e-41a2ca0805ce";
    const rebound = bindExistingDesktopContextResource(second, restoredId);
    let resources = [first, second];
    let revision = 1;
    const removed: string[] = [];
    const project = {
      get: async () => ({ projectId: "studio", revision, resources }),
      remove: async ({ ref }: { ref: string }) => {
        removed.push(ref);
        resources = [rebound];
        revision += 1;
        throw new PragmaProjectStoreError("revision_conflict", "Concurrent binding restore.");
      },
    } as unknown as PragmaProjectStore;
    const transfer = createAssetTransferService({
      project,
      stores: {
        list: async () => [],
        exists: async (id: string) => id === restoredId,
      } as unknown as ContextStoreStore,
      capabilities: { list: async () => [] } as unknown as CapabilityStore,
      layouts: {} as WorkflowLayoutStore,
      reportNameResolutionFailure: (_key, kind, bindingId) => ({
        code: "core_asset_sync.name_unresolved",
        resourceKey: _key,
        resourceKind: kind,
        bindingId,
      }),
    });
    const result = await transfer.collectAssets();
    expect(removed).toEqual([canonicalPragmaResourceRef(first)]);
    expect(resources).toEqual([rebound]);
    expect(result.items.get(`knowledge:${canonicalPragmaResourceRef(second)}`)?.data).toEqual(
      rebound,
    );
  });

  it.each(["", "   "])(
    "synchronizes empty knowledge descriptions through the DSL binding boundary (%j)",
    async (description) => {
      const root = await fixture();
      const binding = createDesktopContextResource({ owner: "project-expert", storeId });
      const local = device(join(root, "local"), "Team docs", undefined, [binding]);
      local.setDescription(description);
      await expect(local.service.overview()).resolves.toBeDefined();
      await local.service.configure({
        remote,
        branch: "main",
        autoPush: false,
        pushDeletions: false,
      });
      const synchronized = await local.service.sync();
      expect(synchronized.status, synchronized.error).toBe("ready");
      const checkout = join(root, "assert-files");
      await exec("git", ["clone", barePath(root), checkout]);
      const data = { items: [...(await readSyncRepository(checkout, true)).values()] } as {
        items: {
          kind: string;
          data: { metadata?: { description: string }; description?: string };
        }[];
      };
      expect(
        data.items.find((item) => item.kind === "knowledge" && item.data.metadata !== undefined)
          ?.data.metadata?.description,
      ).toBe(binding.metadata.description);
      expect(
        data.items.find((item) => item.kind === "knowledge" && item.data.metadata === undefined)
          ?.data.description,
      ).toBe(description.trim());
      expect((await local.service.sync()).status).toBe("ready");
    },
  );

  it.each(["revision_conflict", "resource_not_found"] as const)(
    "refreshes the overview head when another reader retires an orphan with %s",
    async (code) => {
      const root = await fixture();
      const binding = createDesktopContextResource({ owner: "project-expert", storeId });
      let resources = [binding];
      let revision = 1;
      const project = {
        projectId: "studio",
        get: async () => ({ projectId: "studio", revision, resources }),
        remove: async () => {
          resources = [];
          revision += 1;
          throw new PragmaProjectStoreError(code, "Another reader removed the binding.");
        },
      } as unknown as PragmaProjectStore;
      const local = device(join(root, "local"), undefined, undefined, [], undefined, project);
      const configured = await local.service.configure({
        remote,
        branch: "main",
        autoPush: false,
        pushDeletions: false,
      });
      expect(configured.status, configured.error).toBe("ready");
      const overview = await local.service.overview();
      expect(overview.items).toEqual([]);
      expect((await project.get()).resources).toEqual([]);
    },
  );

  it("reports a rejected push, keeps assets pending and recovers on retry", async () => {
    const root = await fixture();
    const local = device(join(root, "local"), "Team docs");
    const hook = join(barePath(root), "hooks", "pre-receive");
    await writeFile(
      hook,
      `#!/bin/sh\necho 'https://user:${"s".repeat(2_100)}@example.test/repo' >&2\necho 'Branch policy rejected this upload' >&2\nexit 1\n`,
    );
    await chmod(hook, 0o700);
    const failed = await local.service.configure({
      remote,
      branch: "main",
      autoPush: true,
      pushDeletions: false,
    });
    expect(failed.status).toBe("error");
    expect(failed.error).toContain("Git push failed:");
    expect(failed.error).toContain("Branch policy rejected this upload");
    expect(failed.error).toContain("https://[redacted]@example.test/repo");
    expect(failed.error).not.toContain("s".repeat(100));
    expect(failed.items.some((item) => item.status === "pending")).toBe(true);
    expect(failed.syncedAt).toBeUndefined();
    expect((await local.service.overview()).error).toBe(failed.error);

    await rm(hook);
    const retried = await local.service.sync();
    expect(retried.status, retried.error).toBe("ready");
    expect(retried.error).toBeUndefined();
    expect(retried.syncedAt).toBeDefined();
    expect(retried.items.every((item) => item.status === "synced")).toBe(true);
  });

  it("uses the configured Git identity for core asset commits", async () => {
    const root = await fixture();
    const local = device(join(root, "local"), "Team docs");

    expect(
      (
        await local.service.configure({
          remote,
          branch: "main",
          autoPush: true,
          pushDeletions: false,
        })
      ).status,
    ).toBe("ready");

    const { stdout } = await exec("git", [
      "--git-dir",
      barePath(root),
      "log",
      "-1",
      "--format=%an%n%ae",
      "main",
    ]);
    expect(stdout.trim().split("\n")).toEqual(["Configured User", "configured@pragma.test"]);
  });

  it("resolves bound resource names from their authoritative local assets", async () => {
    const root = await fixture();
    const capabilityId = "5c98c888-e972-4b7c-a92c-00461dd41e3e";
    const context = createDesktopContextResource({ owner: "project-expert", storeId });
    const capability = createDesktopCapabilityResource({
      owner: "project-expert",
      capabilityId,
    });
    const capabilities = {
      list: async () => [
        {
          manifest: { id: capabilityId, latestRevision: 1 },
          definition: {
            kind: "mcp_server",
            name: "Web Search",
            description: "Search the web",
            connection: {
              transport: "stdio",
              command: "search",
              args: [],
              env: {},
              secretEnv: {},
            },
            timeoutMs: 30_000,
            tools: [],
          },
          managedBy: "user",
        },
      ],
    } as unknown as CapabilityStore;
    const local = device(
      join(root, "local"),
      "Team docs",
      undefined,
      [context, capability],
      undefined,
      undefined,
      capabilities,
    );

    const overview = await local.service.configure({
      remote,
      branch: "main",
      autoPush: true,
      pushDeletions: false,
    });

    expect(
      overview.items.find((item) => item.key === `knowledge:${canonicalPragmaResourceRef(context)}`)
        ?.name,
    ).toBe("Team docs");
    expect(
      overview.items.find(
        (item) => item.key === `capability:${canonicalPragmaResourceRef(capability)}`,
      )?.name,
    ).toBe("Web Search");
  });

  it("preserves authoritative local names that resemble generated binding placeholders", async () => {
    const root = await fixture();
    const capabilityId = "5c98c888-e972-4b7c-a92c-00461dd41e3e";
    const context = createDesktopContextResource({ owner: "project-expert", storeId });
    const capability = createDesktopCapabilityResource({
      owner: "project-expert",
      capabilityId,
    });
    const capabilities = {
      list: async () => [
        {
          manifest: { id: capabilityId, latestRevision: 1 },
          definition: {
            kind: "mcp_server",
            name: `Capability ${capabilityId}`,
            description: "Legitimate placeholder-shaped capability name",
            connection: {
              transport: "stdio",
              command: "search",
              args: [],
              env: {},
              secretEnv: {},
            },
            timeoutMs: 30_000,
            tools: [],
          },
          managedBy: "user",
        },
      ],
    } as unknown as CapabilityStore;
    const issues: { resourceKey: string }[] = [];
    const local = device(
      join(root, "local"),
      `Context ${storeId}`,
      undefined,
      [context, capability],
      undefined,
      undefined,
      capabilities,
      (issue) => issues.push(issue),
    );

    const overview = await local.service.configure({
      remote,
      branch: "main",
      autoPush: true,
      pushDeletions: false,
    });
    const contextItem = overview.items.find(
      (item) => item.key === `knowledge:${canonicalPragmaResourceRef(context)}`,
    );
    const capabilityItem = overview.items.find(
      (item) => item.key === `capability:${canonicalPragmaResourceRef(capability)}`,
    );

    expect(contextItem).toMatchObject({ name: `Context ${storeId}`, status: "synced" });
    expect(capabilityItem).toMatchObject({
      name: `Capability ${capabilityId}`,
      status: "synced",
    });
    expect(issues).toEqual([]);
  });

  it("uses a friendly name and logs a diagnostic for an unavailable binding", async () => {
    const root = await fixture();
    const context = createDesktopContextResource({ owner: "project-expert", storeId });
    const issues: {
      code: string;
      resourceKey: string;
      resourceKind: string;
      bindingId: string;
    }[] = [];
    const local = device(
      join(root, "local"),
      undefined,
      undefined,
      [
        context,
        {
          apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
          kind: "ExpertTeam",
          metadata: {
            id: "p8cbn3cg2avyksn4",
            name: "Team",
            description: "Knowledge team",
            tags: [],
            avatarId: "pragma.avatar.team.default",
          },
          spec: {
            coordinator: { ref: "expert:1xddvess309a6gme" },
            members: [{ ref: "expert:1xddvess309a6gme" }],
            contextStores: [
              {
                ref: canonicalPragmaResourceRef(context),
                namespace: "docs",
                required: true,
                visibility: { mode: "all" },
              },
            ],
            delegation: {
              permissions: { interact: {} },
              maxConcurrency: 2,
              maxDepth: 2,
              runtimes: {},
            },
          },
        },
      ],
      undefined,
      undefined,
      undefined,
      (issue) => issues.push(issue),
    );

    const overview = await local.service.configure({
      remote,
      branch: "main",
      autoPush: true,
      pushDeletions: false,
    });

    expect(
      overview.items.find((item) => item.key === `knowledge:${canonicalPragmaResourceRef(context)}`)
        ?.name,
    ).toBe("Unavailable knowledge base");
    expect(
      overview.items.find((item) => item.key === `knowledge:${canonicalPragmaResourceRef(context)}`)
        ?.status,
    ).toBe("error");
    expect(issues).toEqual([
      {
        code: "core_asset_sync.name_unresolved",
        resourceKey: `knowledge:${canonicalPragmaResourceRef(context)}`,
        resourceKind: "context-store",
        bindingId: storeId,
      },
    ]);
    await expect(
      exec("git", [
        "--git-dir",
        barePath(root),
        "show",
        `main:pragma-sync/context-stores/${context.metadata.id}.pragma.yaml`,
      ]),
    ).rejects.toThrow();
  });

  it("hides bare ids retained by historical sync state and reports both binding kinds", async () => {
    const root = await fixture();
    const localRoot = join(root, "local");
    const capabilityId = "5c98c888-e972-4b7c-a92c-00461dd41e3e";
    const context = createDesktopContextResource({ owner: "project-expert", storeId });
    const capability = createDesktopCapabilityResource({
      owner: "project-expert",
      capabilityId,
    });
    const contextKey = `knowledge:${canonicalPragmaResourceRef(context)}`;
    const capabilityKey = `capability:${canonicalPragmaResourceRef(capability)}`;
    const issues: { code: string; resourceKey: string }[] = [];
    const local = device(
      localRoot,
      undefined,
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      (issue) => issues.push(issue),
    );
    const configuration = { remote, branch: "main", autoPush: true, pushDeletions: false };
    await local.service.configure(configuration);
    const statePath = join(localRoot, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      remoteItems: Record<string, unknown>;
      ignoredRemote: string[];
    };
    state.remoteItems = {
      [contextKey]: {
        kind: "knowledge",
        name: `Context ${storeId}`,
        fingerprint: "a".repeat(64),
      },
      [capabilityKey]: {
        kind: "capability",
        name: `Capability ${capabilityId}`,
        fingerprint: "b".repeat(64),
      },
    };
    state.ignoredRemote = [contextKey, capabilityKey];
    await writeFile(statePath, JSON.stringify(state));

    const overview = await local.service.overview();

    expect(overview.items.find((item) => item.key === contextKey)?.name).toBe(
      "Unavailable knowledge base",
    );
    expect(overview.items.find((item) => item.key === capabilityKey)?.name).toBe(
      "Unavailable capability",
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "core_asset_sync.name_unresolved",
          resourceKey: contextKey,
        }),
        expect.objectContaining({
          code: "core_asset_sync.name_unresolved",
          resourceKey: capabilityKey,
        }),
      ]),
    );
  });

  it("publishes one device, restores another, and flags concurrent edits", async () => {
    const root = await fixture();
    const first = device(join(root, "first"), "Team docs");
    const second = device(join(root, "second"));
    const configuration = { remote, branch: "main", autoPush: true, pushDeletions: false };
    const published = await first.service.configure(configuration);
    expect(published.status).toBe("ready");
    expect(published.items.find((item) => item.key === `knowledge:${storeId}`)?.status).toBe(
      "synced",
    );
    const restored = await second.service.configure(configuration);
    expect(restored.status).toBe("ready");
    expect(second.name()).toBe("Team docs");
    first.rename("First device docs");
    second.rename("Second device docs");
    expect((await first.service.sync()).status).toBe("ready");
    const conflict = await second.service.sync();
    expect(conflict.status).toBe("conflict");
    expect(conflict.items.find((item) => item.key === `knowledge:${storeId}`)?.status).toBe(
      "conflict",
    );
    const resolved = await second.service.resolve(`knowledge:${storeId}`, "remote");
    expect(resolved.status).toBe("ready");
    expect(second.name()).toBe("First device docs");
    const check = join(root, "inspect");
    await exec("git", ["clone", barePath(root), check]);
    expect(await readFile(join(check, "README.md"), "utf8")).toContain("Core asset repository");
  });

  it("keeps a locally deleted asset in Git until explicitly restored", async () => {
    const root = await fixture();
    const local = device(join(root, "local"), "Shared docs");
    const configuration = { remote, branch: "main", autoPush: true, pushDeletions: false };
    await local.service.configure(configuration);
    local.remove();
    const overview = await local.service.sync();
    expect(overview.items.find((item) => item.key === `knowledge:${storeId}`)?.status).toBe(
      "ignored_remote",
    );
    expect(local.name()).toBeUndefined();
    await local.service.restore(`knowledge:${storeId}`);
    expect(local.name()).toBe("Shared docs");
  });

  it("separates Context bindings from Knowledge while preserving the readable store name", async () => {
    const root = await fixture();
    const binding = createDesktopContextResource({ owner: "project-expert", storeId });
    const local = device(join(root, "local"), "Team docs", undefined, [binding]);
    const overview = await local.service.configure({
      remote,
      branch: "main",
      autoPush: true,
      pushDeletions: false,
    });

    expect(
      overview.items.find(
        (item) => item.key === `knowledge:${canonicalPragmaResourceRef(binding)}`,
      ),
    ).toMatchObject({
      assetKey: `context:${storeId}`,
      assetKind: "context",
      assetName: "Team docs",
    });
    expect(overview.items.find((item) => item.key === `knowledge:${storeId}`)).toMatchObject({
      assetKey: `knowledge:${storeId}`,
      assetKind: "knowledge",
      assetName: "Team docs",
    });
  });

  it("shows a locally deleted asset as restorable after a pull-only refresh", async () => {
    const root = await fixture();
    const local = device(join(root, "local"), "Shared docs");
    await local.service.configure({
      remote,
      branch: "main",
      autoPush: false,
      pushDeletions: false,
    });
    local.remove();
    expect(
      (await local.service.overview()).items.find((item) => item.key === `knowledge:${storeId}`)
        ?.status,
    ).toBe("ignored_remote");
    const overview = await local.service.refresh();
    expect(overview.items.find((item) => item.key === `knowledge:${storeId}`)?.status).toBe(
      "ignored_remote",
    );
    expect(
      (await local.service.overview()).items.find((item) => item.key === `knowledge:${storeId}`)
        ?.status,
    ).toBe("ignored_remote");
    await local.service.restore(`knowledge:${storeId}`);
    expect(local.name()).toBe("Shared docs");
  });

  it("rejects a remote asset key that is not a valid identity", async () => {
    const root = await fixture();
    const source = device(join(root, "source"), "Shared docs");
    await source.service.configure({
      remote,
      branch: "main",
      autoPush: true,
      pushDeletions: false,
    });
    const checkout = join(root, "invalid");
    await exec("git", ["clone", barePath(root), checkout]);
    const manifestPath = join(checkout, "pragma-sync", "knowledge-bases", storeId, "metadata.yaml");
    const manifest = parsePragmaYaml(await readFile(manifestPath, "utf8")) as { id: string };
    manifest.id = "../../invalid";
    await writeFile(
      manifestPath,
      `id: ${manifest.id}\nname: Invalid\ndescription: ''\ndirectories: []\nfiles: []\n`,
    );
    await exec("git", ["-C", checkout, "add", "pragma-sync"]);
    await exec("git", [
      "-C",
      checkout,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@pragma.test",
      "commit",
      "-m",
      "Invalid identity",
    ]);
    await exec("git", ["-C", checkout, "push", "origin", "main"]);
    const target = device(join(root, "target"));
    expect(
      (
        await target.service.configure({
          remote,
          branch: "main",
          autoPush: true,
          pushDeletions: false,
        })
      ).status,
    ).toBe("error");
    expect(target.name()).toBeUndefined();
  });

  it("keeps local assets when the remote manifest disappears", async () => {
    const root = await fixture();
    const local = device(join(root, "local"), "Shared docs");
    const configuration = { remote, branch: "main", autoPush: true, pushDeletions: false };
    await local.service.configure(configuration);
    const checkout = join(root, "missing-manifest");
    await exec("git", ["clone", barePath(root), checkout]);
    await exec("git", ["-C", checkout, "rm", "pragma-sync/sync.yaml"]);
    await exec("git", [
      "-C",
      checkout,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@pragma.test",
      "commit",
      "-m",
      "Remove manifest",
    ]);
    await exec("git", ["-C", checkout, "push", "origin", "main"]);
    expect((await local.service.refresh()).status).toBe("error");
    expect(local.name()).toBe("Shared docs");
  });

  it("does not upload local changes when synchronization is removed", async () => {
    const root = await fixture();
    const local = device(join(root, "local"), "Shared docs");
    await local.service.configure({ remote, branch: "main", autoPush: true, pushDeletions: false });
    local.rename("Local only");
    await local.service.removeConfiguration();
    expect((await local.service.overview()).status).toBe("unconfigured");
    const checkout = join(root, "after-removal");
    await exec("git", ["clone", barePath(root), checkout]);
    expect(
      await readFile(
        join(checkout, "pragma-sync", "knowledge-bases", storeId, "metadata.yaml"),
        "utf8",
      ),
    ).toContain("Shared docs");
  });

  it("propagates future deletions only when enabled", async () => {
    const root = await fixture();
    const first = device(join(root, "first"), "Shared docs");
    const second = device(join(root, "second"));
    const configuration = { remote, branch: "main", autoPush: true, pushDeletions: true };
    await first.service.configure(configuration);
    await second.service.configure(configuration);
    first.remove();
    expect((await first.service.sync()).status).toBe("ready");
    expect((await second.service.refresh()).status).toBe("ready");
    expect(second.name()).toBeUndefined();
  });

  it("does not upload deletions made before enabling deletion uploads", async () => {
    const root = await fixture();
    const local = device(join(root, "local"), "Shared docs");
    const base = { remote, branch: "main", autoPush: true };
    await local.service.configure({ ...base, pushDeletions: false });
    local.remove();
    expect(
      (await local.service.sync()).items.find((item) => item.key === `knowledge:${storeId}`)
        ?.status,
    ).toBe("ignored_remote");
    const enabled = await local.service.configure({ ...base, pushDeletions: true });
    expect(enabled.items.find((item) => item.key === `knowledge:${storeId}`)?.status).toBe(
      "ignored_remote",
    );
    const restored = device(join(root, "restored"));
    await restored.service.configure({ ...base, pushDeletions: false });
    expect(restored.name()).toBe("Shared docs");
  });

  it("grandfathers a local deletion even when deletion uploads are enabled before the next sync", async () => {
    const root = await fixture();
    const local = device(join(root, "local"), "Shared docs");
    const base = { remote, branch: "main", autoPush: true };
    await local.service.configure({ ...base, pushDeletions: false });
    local.remove();
    await local.service.configure({ ...base, pushDeletions: true });
    const restored = device(join(root, "restored"));
    await restored.service.configure({ ...base, pushDeletions: false });
    expect(restored.name()).toBe("Shared docs");
  });

  it("reads remote identity metadata for overview without reconciling or rewriting v1 state", async () => {
    const root = await fixture();
    const capabilityId = "5c98c888-e972-4b7c-a92c-00461dd41e3e";
    const binding = createDesktopCapabilityResource({
      owner: "project-expert",
      capabilityId,
      name: "Search binding",
    });
    let description = "Initial definition";
    const capabilities = {
      list: async () => [
        {
          manifest: { id: capabilityId, latestRevision: 1 },
          definition: {
            kind: "mcp_server" as const,
            name: "Search definition",
            description,
            connection: {
              transport: "stdio" as const,
              command: "search",
              args: [],
              env: {},
              secretEnv: {},
            },
            timeoutMs: 30_000,
            tools: [],
          },
          managedBy: "user",
        },
      ],
    } as unknown as CapabilityStore;
    const configuration = { remote, branch: "main", autoPush: true, pushDeletions: false };
    const source = device(
      join(root, "source"),
      undefined,
      undefined,
      [binding],
      undefined,
      undefined,
      capabilities,
    );
    await source.service.configure(configuration);

    const observerRoot = join(root, "observer");
    await mkdir(observerRoot);
    await writeFile(
      join(observerRoot, "settings.json"),
      JSON.stringify({ schemaVersion: "pragma.asset-sync-settings/v1", ...configuration }),
    );
    await cp(join(root, "source", "state.json"), join(observerRoot, "state.json"));
    const observer = device(observerRoot);
    const stateBefore = await readFile(join(observerRoot, "state.json"), "utf8");

    description = "Changed remotely";
    await source.service.sync();
    const overview = await observer.service.overview();

    expect(
      overview.items.filter((item) => item.assetKey === `capability:${capabilityId}`),
    ).toHaveLength(2);
    expect(observer.resources()).toEqual([]);
    expect(await readFile(join(observerRoot, "state.json"), "utf8")).toBe(stateBefore);
    const stored = JSON.parse(stateBefore) as {
      remoteItems: Record<string, Record<string, unknown>>;
    };
    expect(
      Object.values(stored.remoteItems).every(
        (item) => Object.keys(item).sort().join(",") === "fingerprint,kind,name",
      ),
    ).toBe(true);
  });

  it("resolves offline canonical binding identity without matching display names", async () => {
    const root = await fixture();
    const capabilityId = "5c98c888-e972-4b7c-a92c-00461dd41e3e";
    const binding = createDesktopCapabilityResource({
      owner: "project-expert",
      capabilityId,
      name: "Binding alias",
    });
    const capabilities = {
      list: async () => [
        {
          manifest: { id: capabilityId, latestRevision: 1 },
          definition: {
            kind: "mcp_server" as const,
            name: "Different definition name",
            description: "Search",
            connection: {
              transport: "stdio" as const,
              command: "search",
              args: [],
              env: {},
              secretEnv: {},
            },
            timeoutMs: 30_000,
            tools: [],
          },
          managedBy: "user",
        },
      ],
    } as unknown as CapabilityStore;
    const source = device(
      join(root, "source"),
      undefined,
      undefined,
      [binding],
      undefined,
      undefined,
      capabilities,
    );
    const configuration = { remote, branch: "main", autoPush: true, pushDeletions: false };
    await source.service.configure(configuration);
    const offlineRoot = join(root, "offline");
    await mkdir(offlineRoot);
    const unavailableRemote = "ssh://git@pragma.test/missing-assets.git";
    await writeFile(
      join(offlineRoot, "settings.json"),
      JSON.stringify({
        schemaVersion: "pragma.asset-sync-settings/v1",
        ...configuration,
        remote: unavailableRemote,
      }),
    );
    const state = JSON.parse(await readFile(join(root, "source", "state.json"), "utf8")) as {
      source: string;
    };
    state.source = JSON.stringify([unavailableRemote, "main"]);
    await writeFile(join(offlineRoot, "state.json"), JSON.stringify(state));

    const overview = await device(offlineRoot).service.overview();
    expect(
      overview.items.filter((item) => item.assetKey === `capability:${capabilityId}`),
    ).toHaveLength(2);
  });

  it("updates the incoming Expert graph before removing a selected Capability tool", async () => {
    const root = await fixture();
    const capabilityId = "5c98c888-e972-4b7c-a92c-00461dd41e3e";
    const binding = createDesktopCapabilityResource({
      owner: "project-expert",
      capabilityId,
      name: "Search",
    });
    const expert = (tools: string[]) =>
      ({
        apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
        kind: "Expert",
        metadata: {
          id: "1xddvess309a6gme",
          name: "Writer",
          description: "Writes",
          tags: [],
          avatarId: "pragma.avatar.expert.default",
        },
        spec: {
          scope: "Writing",
          instructions: "Write.",
          runtime: { ref: "runtime-profile:zdkgs0fde4xt00vr" },
          capabilities: [{ ref: canonicalPragmaResourceRef(binding), kind: "tools", tools }],
          toolApprovals: {},
          contextStores: [],
          plugins: [],
          tools: [],
        },
      }) as PragmaResource;
    const definition = (tools: string[]) => ({
      kind: "mcp_server" as const,
      name: "Search",
      description: "Search",
      connection: {
        transport: "stdio" as const,
        command: "search",
        args: [],
        env: {},
        secretEnv: {},
      },
      timeoutMs: 30_000,
      tools: tools.map((name) => ({ name, schemaHash: "0".repeat(64) })),
    });
    let sourceTools = ["old", "keep"];
    const sourceCapabilities = {
      list: async () => [
        {
          manifest: { id: capabilityId, latestRevision: 1 },
          definition: definition(sourceTools),
          managedBy: "user",
        },
      ],
    } as unknown as CapabilityStore;
    const source = device(
      join(root, "source"),
      undefined,
      undefined,
      [binding, expert(sourceTools)],
      undefined,
      undefined,
      sourceCapabilities,
    );
    const configuration = { remote, branch: "main", autoPush: true, pushDeletions: false };
    const sourceOverview = await source.service.configure(configuration);
    expect(sourceOverview.status).toBe("ready");
    expect(
      sourceOverview.items.filter((item) => item.assetKey === `capability:${capabilityId}`),
    ).toHaveLength(2);
    expect(
      sourceOverview.items
        .filter((item) => item.assetKey === `capability:${capabilityId}`)
        .map((item) => item.assetName),
    ).toEqual(["Search", "Search"]);
    let targetTools = ["old", "keep"];
    const targetCapabilities = {
      list: async () => [
        {
          manifest: { id: capabilityId, latestRevision: 1 },
          definition: definition(targetTools),
          managedBy: "user",
        },
      ],
      update: async (input: { definition: ReturnType<typeof definition> }) => {
        const available = new Set(input.definition.tools.map((tool) => tool.name));
        const selected = target
          .resources()
          .flatMap((resource) =>
            resource.kind === "Expert"
              ? resource.spec.capabilities.flatMap((reference) =>
                  reference.kind === "tools" ? (reference.tools ?? []) : [],
                )
              : [],
          );
        if (selected.some((tool) => !available.has(tool)))
          throw new Error("old Expert still selects removed tool");
        targetTools = input.definition.tools.map((tool) => tool.name);
      },
    } as unknown as CapabilityStore;
    const target = device(
      join(root, "target"),
      undefined,
      undefined,
      [binding, expert(["old", "keep"])],
      undefined,
      undefined,
      targetCapabilities,
    );
    expect((await target.service.configure(configuration)).status).toBe("ready");
    sourceTools = ["keep"];
    source.replaceResources([binding, expert(["keep"])]);
    expect((await source.service.sync()).status).toBe("ready");
    expect((await target.service.refresh()).status).toBe("ready");
    expect(targetTools).toEqual(["keep"]);
    expect(
      target.resources().find((resource) => resource.kind === "Expert")?.spec.capabilities,
    ).toEqual([{ ref: canonicalPragmaResourceRef(binding), kind: "tools", tools: ["keep"] }]);
  });

  it("restores Skill contents at the original Capability ID", async () => {
    const root = await fixture();
    const source = join(root, "source-skill");
    await mkdir(source);
    await writeFile(
      join(source, "SKILL.md"),
      "---\nname: review-notes\ndescription: Review notes\n---\n# Review notes\n",
    );
    const first = device(join(root, "first"), undefined, source);
    const second = device(join(root, "second"));
    const configuration = { remote, branch: "main", autoPush: true, pushDeletions: false };
    expect((await first.service.configure(configuration)).status).toBe("ready");
    expect((await second.service.configure(configuration)).status).toBe("ready");
    expect(await readFile(join(second.skillRoot()!, "SKILL.md"), "utf8")).toContain("Review notes");
    expect(
      (await second.service.overview()).items.find((item) => item.key === `skill:${skillId}`)
        ?.status,
    ).toBe("synced");
  });

  it("restores Expert, Team, Flow and layout while flagging a missing local model", async () => {
    const root = await fixture();
    const runtime = {
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "RuntimeProfile",
      metadata: {
        id: "zdkgs0fde4xt00vr",
        name: "Writer Runtime",
        description: "Runtime",
        tags: ["desktop-managed"],
      },
      spec: {
        adapter: "pragma.runtime.profile@v1",
        config: { runtimeId: "codex", providerId: "openai", model: "gpt-test" },
      },
    } as PragmaResource;
    const expert = {
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Expert",
      metadata: {
        id: "1xddvess309a6gme",
        name: "Writer",
        description: "Writes",
        tags: [],
        avatarId: "pragma.avatar.expert.default",
      },
      spec: {
        scope: "Writing",
        instructions: "Write.",
        runtime: { ref: "runtime-profile:zdkgs0fde4xt00vr" },
        capabilities: [],
        toolApprovals: {},
        contextStores: [],
        plugins: [],
        tools: [],
      },
    } as PragmaResource;
    const team = {
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "ExpertTeam",
      metadata: {
        id: "p8cbn3cg2avyksn4",
        name: "Writers",
        description: "Team",
        tags: [],
        avatarId: "pragma.avatar.team.default",
      },
      spec: {
        coordinator: { ref: "expert:1xddvess309a6gme" },
        members: [{ ref: "expert:1xddvess309a6gme" }],
        contextStores: [],
        delegation: { permissions: { interact: {} }, maxConcurrency: 2, maxDepth: 2, runtimes: {} },
      },
    } as PragmaResource;
    const flow = {
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Flow",
      metadata: { id: "t1e73vjvctx49gkq", name: "Release", description: "Flow", tags: [] },
      spec: {
        limits: { maxNodeVisits: 100 },
        graph: {
          start: "finish",
          steps: { finish: { action: { ref: "action:finish@v1" } } },
          loops: {},
          transitions: { finish: { end: true } },
        },
      },
    } as PragmaResource;
    const firstProject = createPragmaProjectStore({ projectsPath: join(root, "first-project") });
    await firstProject.publish({ expectedRevision: 0, resources: [runtime, expert, team, flow] });
    const secondProject = createPragmaProjectStore({ projectsPath: join(root, "second-project") });
    const first = device(
      join(root, "first"),
      undefined,
      undefined,
      [],
      { nodes: { finish: { x: 2, y: 4 } }, viewport: { x: 0, y: 0, zoom: 1 } },
      firstProject,
    );
    const second = device(join(root, "second"), undefined, undefined, [], undefined, secondProject);
    const configuration = { remote, branch: "main", autoPush: true, pushDeletions: false };
    expect((await first.service.configure(configuration)).status).toBe("ready");
    const restored = await second.service.configure(configuration);
    expect(restored.status).toBe("ready");
    expect((await secondProject.get()).resources.map(canonicalPragmaResourceRef)).toEqual(
      expect.arrayContaining([
        "expert:1xddvess309a6gme",
        "team:p8cbn3cg2avyksn4",
        "flow:t1e73vjvctx49gkq",
      ]),
    );
    expect(second.layout()?.nodes.finish).toEqual({ x: 2, y: 4 });
    expect(
      restored.items
        .filter((item) => item.assetKey === "flow:t1e73vjvctx49gkq")
        .map((item) => item.kind)
        .sort(),
    ).toEqual(["flow", "flow-layout"]);
    expect(
      restored.items.find((item) => item.key === "expert:expert:1xddvess309a6gme")?.status,
    ).toBe("needs_attention");

    const current = await firstProject.get();
    const renamedFlow = {
      ...flow,
      metadata: { ...flow.metadata, name: "Deploy" },
    } as PragmaResource;
    await firstProject.publish({
      expectedRevision: current.revision,
      resources: [runtime, expert, team, renamedFlow],
    });
    await first.service.sync();
    const refreshed = await second.service.refresh();
    expect(
      refreshed.items.find((item) => item.key === "flow-layout:t1e73vjvctx49gkq")?.assetName,
    ).toBe("Deploy");
  });

  it("finds an unavailable harness through an Expert's RuntimeProfile", () => {
    const expert = {
      kind: "Expert",
      metadata: { id: "2qgbztga4kz2qz51" },
      spec: {
        runtime: { ref: "runtime-profile:7k2m9q4v8np6r3dt" },
        capabilities: [],
        contextStores: [],
        tools: [],
      },
    } as unknown as PragmaResource;
    const profile = {
      kind: "RuntimeProfile",
      metadata: { id: "7k2m9q4v8np6r3dt", name: "Code model" },
      spec: { config: { runtimeId: "codex", providerId: "openai", model: "missing-model" } },
    } as unknown as PragmaResource;
    expect(
      unavailableCoreAssetRuntimeBindings("expert:2qgbztga4kz2qz51", [expert, profile], []),
    ).toEqual([{ ref: "runtime-profile:7k2m9q4v8np6r3dt", name: "Code model" }]);
  });
});

function barePath(root: string): string {
  return join(root, "assets.git");
}
