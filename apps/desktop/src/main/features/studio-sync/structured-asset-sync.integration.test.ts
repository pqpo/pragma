import { createAssetGitService } from "../asset-git/asset-git-service.ts";
import { PragmaPaths } from "@pragma/core";
import { createAutomationService } from "../automations/automation-service.ts";
import { createAutomationStore, createAutomationBinding } from "../automations/automation-store.ts";
import type { WorkflowLayoutStore } from "@pragma/local-host/deployment";
import type { CapabilityVerifier } from "@pragma/local-host/deployment";
import {
  createDesktopCapabilityResource,
  createDesktopContextResource,
} from "../../platform/bindings/desktop-bound-resource-policy.ts";
import { formatPragmaYaml, parsePragmaYaml } from "@pragma/interpreter";
import {
  canonicalPragmaResourceRef,
  PRAGMA_DSL_WRITE_API_VERSION,
  PragmaForwardCompatibleResourceSchema,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createContextStoreStore,
  hashSnapshotContent,
  type ContextStoreStore,
} from "@pragma/local-host/deployment";
import { createPragmaProjectStore, type PragmaProjectStore } from "@pragma/local-host/deployment";
import { createWorkflowLayoutStore } from "@pragma/local-host/deployment";
import { createCapabilityStore, type CapabilityStore } from "@pragma/local-host/deployment";
import { createCapabilityCredentialStore } from "../capabilities/capability-credential-store.ts";
import {
  createCapabilityRevisionCoordinator,
  type CapabilityRevisionCoordinator,
} from "@pragma/local-host/deployment";
import { createDesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import { createTestSecretStore } from "../credentials/test-secret-store.ts";
import { createCoreAssetSyncService } from "./core-asset-sync-service.ts";
import { readSyncRepository, writeSyncRepository } from "./asset-sync-repository.ts";
import {
  CoreAssetSyncItemSchema,
  AutomationResourceSchema,
} from "../../../shared/contracts/index.ts";
import { appendTransferredKnowledge } from "@pragma/local-host/deployment";
import { migrateSyncDslItem } from "./migrations/dsl-fingerprints.ts";
import { journalMigrationChain } from "./migrations/index.ts";

const exec = promisify(execFile);
const temporary: string[] = [];
const remote = "ssh://git@pragma.test/assets.git";
const configuration = { remote, branch: "main", autoPush: false };
const originalGlobal = process.env.GIT_CONFIG_GLOBAL;
const originalSystem = process.env.GIT_CONFIG_NOSYSTEM;
afterEach(async () => {
  if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = originalGlobal;
  if (originalSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = originalSystem;
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pragma-structured-integration-"));
  temporary.push(root);
  const bare = join(root, "assets.git");
  await exec("git", ["init", "--bare", "--initial-branch=main", bare]);
  const config = join(root, "gitconfig");
  await writeFile(
    config,
    `[url "file://${root}/"]\n insteadOf = ssh://git@pragma.test/\n[user]\n name = Pragma Test\n email = test@pragma.test\n`,
  );
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  return {
    root,
    bare,
    head: async () => (await exec("git", ["--git-dir", bare, "rev-parse", "main"])).stdout.trim(),
  };
}
function device(
  root: string,
  interruptCreate: boolean | "skill" | "capability" | "project" = false,
  beforeList?: () => Promise<void>,
  beforeLayoutSave?: () => Promise<void>,
  verify?: CapabilityVerifier,
  projectHooks?: {
    afterSourceRestored?: Parameters<typeof createAssetGitService>[0]["afterSourceRestored"];
    onAutomationsImported?: Parameters<
      typeof createCoreAssetSyncService
    >[0]["onAutomationsImported"];
    beforeGet?: (project: PragmaProjectStore) => Promise<void>;
    afterValidation?: (project: PragmaProjectStore) => Promise<void>;
    beforeApply?: (project: PragmaProjectStore) => Promise<void>;
    afterApply?: (project: PragmaProjectStore) => Promise<void>;
  },
) {
  const project = createPragmaProjectStore({ projectsPath: join(root, "data", "projects") });
  const stores = createContextStoreStore({
    storesPath: join(root, "data", "context-stores"),
    project,
  });
  const layouts = createWorkflowLayoutStore({ projectsPath: join(root, "data", "projects") });
  const { secretStore } = createTestSecretStore(join(root, "data", "secrets"));
  const credentials = createCapabilityCredentialStore({
    configPath: join(root, "data", "credentials.json"),
    secretStore,
  });
  const coordinatorRef: { current?: CapabilityRevisionCoordinator } = {};
  const capabilities = createCapabilityStore({
    capabilitiesPath: join(root, "data", "capabilities"),
    credentials,
    verify:
      verify ??
      (async (definition) => ({
        definition,
        health: { status: "ready", checkedAt: new Date().toISOString() },
      })),
    mutations: {
      publish: async (input) => await coordinatorRef.current!.publish(input),
      publishHealth: async (input) => await coordinatorRef.current!.publishHealth(input),
      mutate: async (input) => await coordinatorRef.current!.mutate(input),
    },
    isReferenced: async () => false,
  });
  coordinatorRef.current = createCapabilityRevisionCoordinator({
    journalRoot: join(root, "state", "capability-journals"),
    capabilities,
    project,
    credentials,
    systemExperts: createDesktopSystemExpertRegistry(),
  });
  let interrupted = false;
  const importStores = new Proxy(stores, {
    get(target, property, receiver) {
      if (property === "list" && beforeList)
        return async () => {
          await beforeList();
          return await target.list();
        };
      if (property !== "createFromSnapshot") return Reflect.get(target, property, receiver);
      return async (...args: Parameters<ContextStoreStore["createFromSnapshot"]>) => {
        const value = await target.createFromSnapshot(...args);
        if (interruptCreate === true && !interrupted) {
          interrupted = true;
          throw new Error("Injected interruption after durable Knowledge creation.");
        }
        return value;
      };
    },
  });
  const interruptAfter = <T extends object>(target: T, property: keyof T, enabled: boolean): T =>
    new Proxy(target, {
      get(owner, key, receiver) {
        const member = Reflect.get(owner, key, receiver);
        if (key !== property || !enabled || typeof member !== "function") return member;
        return async (...args: unknown[]) => {
          const value = await Reflect.apply(member, owner, args);
          if (!interrupted) {
            interrupted = true;
            throw new Error(`Injected interruption after ${String(property)}.`);
          }
          return value;
        };
      },
    });
  const importCapabilities = interruptAfter(
    interruptAfter(capabilities, "publishNewSkillRevisionCandidate", interruptCreate === "skill"),
    "create",
    interruptCreate === "capability",
  );
  const importProject = new Proxy(interruptAfter(project, "apply", interruptCreate === "project"), {
    get(target, property, receiver) {
      if (property === "get" && projectHooks?.beforeGet)
        return async (...args: Parameters<PragmaProjectStore["get"]>) => {
          await projectHooks.beforeGet!(project);
          return await target.get(...args);
        };
      if (property === "validateChanges" && projectHooks?.afterValidation)
        return async (...args: Parameters<PragmaProjectStore["validateChanges"]>) => {
          const diagnostics = await target.validateChanges(...args);
          await projectHooks.afterValidation!(project);
          return diagnostics;
        };
      if (property === "apply" && (projectHooks?.beforeApply || projectHooks?.afterApply))
        return async (...args: Parameters<PragmaProjectStore["apply"]>) => {
          await projectHooks.beforeApply?.(project);
          const value = await target.apply(...args);
          await projectHooks.afterApply?.(project);
          return value;
        };
      return Reflect.get(target, property, receiver);
    },
  });
  const importLayouts = new Proxy(layouts, {
    get(target, property, receiver) {
      if (property !== "save" || !beforeLayoutSave) return Reflect.get(target, property, receiver);
      return async (...args: Parameters<WorkflowLayoutStore["save"]>) => {
        await beforeLayoutSave();
        return await target.save(...args);
      };
    },
  });
  const assetGit = createAssetGitService({
    stateRoot: join(root, "state", "asset-git"),
    stores,
    capabilities,
    afterSourceRestored: projectHooks?.afterSourceRestored,
  });
  const options = {
    assetGit,
    ...(projectHooks?.onAutomationsImported
      ? { onAutomationsImported: projectHooks.onAutomationsImported }
      : {}),
    configurationPath: join(root, "state", "asset-sync", "settings.json"),
    statePath: join(root, "state", "asset-sync", "state.json"),
    project: importProject,
    layouts: importLayouts,
    stores: importStores,
    capabilities: importCapabilities,
    getRuntimes: async () => [],
  };
  return {
    root,
    assetGit,
    stores,
    project,
    layouts,
    capabilities,
    credentials,
    service: createCoreAssetSyncService(options),
    restart: () => createCoreAssetSyncService(options),
  };
}

function resources(storeId?: string): PragmaResource[] {
  const context = storeId
    ? createDesktopContextResource({ owner: "project-expert", storeId })
    : undefined;
  const runtime: PragmaResource = {
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
      config: { runtimeId: "codex", providerId: "openai", model: "test" },
    },
  };
  const expert: PragmaResource = {
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
      instructions: "Write",
      runtime: { ref: "runtime-profile:zdkgs0fde4xt00vr" },
      capabilities: [],
      toolApprovals: {},
      contextStores: context
        ? [
            {
              ref: canonicalPragmaResourceRef(context) as `context-store:${string}`,
              namespace: "docs",
              required: true,
            },
          ]
        : [],
      plugins: [
        {
          ref: "plugin:example@1.0.0",
          config: { format: "markdown", options: { depth: 3 } },
          secretBindings: { token: "binding:example-token" },
        },
      ],
      tools: [],
    },
  };
  const flow: PragmaResource = {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Flow",
    metadata: { id: "t1e73vjvctx49gkq", name: "Release", description: "Flow", tags: [] },
    spec: {
      limits: { maxNodeVisits: 100 },
      graph: {
        start: "finish",
        steps: {
          finish: {
            expert: { ref: "expert:1xddvess309a6gme" },
            prompt: { segments: [{ text: "Write" }] },
          },
        },
        loops: {},
        transitions: { finish: { end: true } },
      },
    },
  };
  return [...(context ? [context] : []), runtime, expert, flow];
}
const initialLayout = {
  schemaVersion: "pragma.desktop-flow-layout/v2" as const,
  projectId: "studio",
  flowId: "t1e73vjvctx49gkq",
  nodes: { finish: { x: 1, y: 2 } },
  viewport: { x: 0, y: 0, zoom: 1 },
  updatedAt: "2026-09-29T00:00:00.000Z",
};
async function addKnowledge(stores: ContextStoreStore, name: string, content = "# Original\n") {
  const store = await stores.create({ mode: "blank", name, description: "Knowledge" });
  await stores.createFile(store.id, "guide.md", content, { trigger: "manual", priority: "high" });
  await stores.createFolder(store.id, "empty");
  return (await stores.list()).find((entry) => entry.id === store.id)!;
}
async function append(stores: ContextStoreStore, id: string, content: string) {
  const snapshot = await stores.getSnapshot(id);
  const files = snapshot.files.map((file) => ({ ...file, content }));
  await stores.appendSnapshot(
    {
      storeId: id,
      baseRevision: snapshot.revision,
      baseSnapshotHash: snapshot.snapshotHash,
      snapshotHash: hashSnapshotContent(files, snapshot.directories),
      directories: snapshot.directories,
      files,
      summary: "Edit",
    },
    "user",
  );
}
async function addSkill(capabilities: CapabilityStore, root: string, arbitraryScripts = false) {
  const sourcePath = join(root, "skill-source");
  await mkdir(join(sourcePath, "scripts"), { recursive: true });
  await mkdir(join(sourcePath, "references"));
  await writeFile(
    join(sourcePath, "SKILL.md"),
    "---\nname: audit\ndescription: Audit code\n---\n\nAudit changes.\n",
  );
  await writeFile(join(sourcePath, "scripts", "check.mjs"), "export const check = true;\n", {
    mode: 0o700,
  });
  if (arbitraryScripts) {
    await writeFile(
      join(sourcePath, "scripts/check.py"),
      "raise RuntimeError('must not execute')\n",
      { mode: 0o700 },
    );
    await writeFile(join(sourcePath, "scripts/check.sh"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await writeFile(
      join(sourcePath, "scripts/check.mjs"),
      "import 'axios'; import('node:child_process'); fetch('/'); throw new Error('must not execute');\n",
    );
    await writeFile(join(sourcePath, "requirements.txt"), "requests\n");
  }
  await writeFile(join(sourcePath, "references", "sample.bin"), Buffer.from([0, 255, 128]));
  return await capabilities.importSkill({ sourcePath });
}

function automation(): Extract<PragmaResource, { kind: "Automation" }> {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Automation",
    metadata: { id: "m9a8n9nxvvyb4j01", name: "Daily review", description: "Review", tags: [] },
    spec: {
      adapter: "pragma.automation.schedule@v1",
      binding: "binding:desktop-automation",
      enabled: true,
      config: { trigger: { kind: "calendar", frequency: "daily", time: "09:00", timezone: "UTC" } },
      route: {
        executor: { ref: "expert:1xddvess309a6gme" },
        input: { kind: "prompt", value: "Review" },
      },
      interaction: { mode: "new-mission" },
      delivery: { adapter: "pragma.automation.delivery.local@v1" },
    },
  };
}

describe("structured asset sync with real Git and domain stores", { timeout: 60_000 }, () => {
  it("synchronizes Automation definitions, resolves edits and restores and propagates deletion", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const b = device(join(git.root, "b"));
    const original = automation();
    const ref = canonicalPragmaResourceRef(original);
    const key = `automation:${ref}`;
    const read = async (owner: typeof a) =>
      (await owner.project.get()).resources.find(
        (resource) => canonicalPragmaResourceRef(resource) === ref,
      );
    const edit = async (owner: typeof a, name: string) =>
      owner.project.upsert({
        baseRevision: (await owner.project.get()).revision,
        resource: { ...original, metadata: { ...original.metadata, name } },
      });
    await a.project.publish({ expectedRevision: 0, resources: [...resources(), original] });
    expect((await a.service.configure(configuration)).status).toBe("ready");
    const yaml = (
      await exec("git", [
        "--git-dir",
        git.bare,
        "show",
        `main:pragma-sync/automations/${original.metadata.id}.pragma.yaml`,
      ])
    ).stdout;
    expect(parsePragmaYaml(yaml)).toEqual(original);
    const imported = await b.service.configure(configuration);
    expect(imported.status, imported.error).toBe("ready");
    expect(imported.items.find((item) => item.key === key)).toMatchObject({
      kind: "automation",
      assetKind: "automation",
      assetKey: ref,
      assetName: "Daily review",
      status: "synced",
    });
    expect(await read(b)).toEqual(original);
    const head = await git.head();
    expect((await b.service.sync()).status).toBe("ready");
    expect(await git.head()).toBe(head);

    await edit(a, "From A");
    await edit(b, "From B");
    expect((await a.service.sync()).status).toBe("ready");
    expect((await b.service.sync()).items.find((item) => item.key === key)?.status).toBe(
      "conflict",
    );
    expect((await b.service.resolve(key, "remote")).status).toBe("ready");
    expect((await read(b))?.metadata.name).toBe("From A");
    await edit(b, "Return from B");
    expect((await b.service.sync()).status).toBe("ready");
    expect((await a.service.automatic()).status).toBe("ready");
    expect((await read(a))?.metadata.name).toBe("Return from B");

    await a.project.remove({ baseRevision: (await a.project.get()).revision, ref });
    expect((await a.service.restore(key)).status).toBe("ready");
    expect((await read(a))?.metadata.name).toBe("Return from B");
    await a.project.remove({ baseRevision: (await a.project.get()).revision, ref });
    expect((await a.service.sync()).status).toBe("ready");
    expect((await b.service.sync()).status).toBe("ready");
    expect(await read(b)).toBeUndefined();
    expect((await b.service.overview()).items.some((item) => item.key === key)).toBe(false);
  });

  it("replays interrupted Automation imports and retains executor dependencies", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const b = device(join(git.root, "b"), "project");
    const original = automation();
    await a.project.publish({ expectedRevision: 0, resources: [...resources(), original] });
    expect((await a.service.configure(configuration)).status).toBe("ready");
    expect((await b.service.configure(configuration)).status).toBe("error");
    const revision = (await b.project.get()).revision;
    const recovered = await b.restart().sync();
    expect(recovered.status, recovered.error).toBe("ready");
    expect((await b.project.get()).revision).toBe(revision);
    expect((await b.project.get()).resources).toContainEqual(original);
    expect(recovered.items.find((item) => item.kind === "automation")?.readiness?.status).toBe(
      "needs_attention",
    );
    // Remove the entire graph in a single publication, including the executor.
    await a.project.apply({
      baseRevision: (await a.project.get()).revision,
      upserts: [],
      removals: (await a.project.get()).resources.map(canonicalPragmaResourceRef),
    });
    expect((await a.service.sync()).status).toBe("ready");
    expect((await b.restart().sync()).status).toBe("ready");
    expect((await b.project.get()).resources).toEqual([]);
  });

  it.each([false, true])(
    "restores swapped Git associations across asset kinds (interrupted: %s)",
    async (interrupt) => {
      const git = await fixture();
      const a = device(join(git.root, "a"));
      let armed = false;
      const b = device(join(git.root, "b"), false, undefined, undefined, undefined, {
        afterSourceRestored: async () => {
          if (armed) {
            armed = false;
            throw new Error("Interrupted source publication");
          }
        },
      });
      const x = { kind: "knowledge" as const, id: (await addKnowledge(a.stores, "X")).id };
      const y = {
        kind: "skill" as const,
        id: (await addSkill(a.capabilities, a.root, true)).manifest.id,
      };
      const sourceX = { remote: "ssh://git@pragma.test/x.git", branch: "main" };
      const sourceY = { remote: "ssh://git@pragma.test/y.git", branch: "main" };
      await a.assetGit.restoreSource(x, sourceX);
      await a.assetGit.restoreSource(y, sourceY);
      expect((await a.service.configure(configuration)).status).toBe("ready");
      expect((await b.service.configure(configuration)).status).toBe("ready");
      await a.assetGit.unbind(x);
      await a.assetGit.unbind(y);
      await a.assetGit.restoreSource(x, sourceY);
      await a.assetGit.restoreSource(y, sourceX);
      expect((await a.service.sync()).status).toBe("ready");
      armed = interrupt;
      if (interrupt) expect((await b.service.sync()).status).toBe("error");
      const result = await b.restart().sync();
      expect(result.status, result.error).toBe("ready");
      expect(await b.assetGit.source(x)).toEqual(sourceY);
      expect(await b.assetGit.source(y)).toEqual(sourceX);
      await expect(
        b.assetGit.restoreSources([
          { target: x, source: sourceX, expected: sourceY },
          { target: y, source: sourceY, expected: { ...sourceX, branch: "stale" } },
        ]),
      ).rejects.toThrow("changed during restore");
      expect(await b.assetGit.source(x)).toEqual(sourceY);
      expect(await b.assetGit.source(y)).toEqual(sourceX);
      await expect(
        b.assetGit.restoreSources([
          { target: x, source: sourceX, expected: sourceY },
          { target: y, source: sourceX, expected: sourceX },
        ]),
      ).rejects.toThrow("already associated");
      expect(await b.assetGit.source(x)).toEqual(sourceY);
      expect(await b.assetGit.source(y)).toEqual(sourceX);
      expect((await b.stores.getSnapshot(x.id)).revision).toBe(1);
      expect((await b.capabilities.get(y.id)).manifest.latestRevision).toBe(1);
    },
  );

  it.each(["broken-json", "future-record", "future-journal"] as const)(
    "isolates unreadable Git associations (%s) and recovers after repair",
    async (failure) => {
      const git = await fixture();
      const a = device(join(git.root, "a"));
      const broken = await addKnowledge(a.stores, "Broken config");
      const healthy = await addKnowledge(a.stores, "Healthy content");
      const source = { remote: "ssh://git@pragma.test/x.git", branch: "main" };
      await a.assetGit.restoreSource({ kind: "knowledge", id: broken.id }, source);
      expect((await a.service.configure(configuration)).status).toBe("ready");
      const remotePath = `main:pragma-sync/knowledge-bases/${broken.id}/git.yaml`;
      const remoteBefore = (await exec("git", ["--git-dir", git.bare, "show", remotePath])).stdout;
      const path =
        join(a.root, "state", "asset-git", "knowledge", `${broken.id}.json`) +
        (failure === "future-journal" ? ".journal" : "");
      const original = failure === "future-journal" ? undefined : await readFile(path);
      const damaged =
        failure === "broken-json"
          ? "{"
          : JSON.stringify({
              schemaVersion: `pragma.asset-git${failure === "future-journal" ? "-journal" : ""}/v999`,
            });
      await writeFile(path, damaged);
      const overview = await a.service.overview();
      expect(overview.status).toBe("error");
      expect(
        overview.items.find((item) => item.key === `knowledge-git:${broken.id}`),
      ).toMatchObject({
        assetName: "Broken config",
        status: "error",
        message: expect.stringContaining("asset_git.source_unavailable"),
      });
      const head = await git.head();
      await append(a.stores, healthy.id, "# Healthy unpublished update");
      const result = await a.restart().sync();
      expect(result.status).toBe("error");
      expect(result.items.find((item) => item.key === `knowledge:${healthy.id}`)?.status).toBe(
        "synced",
      );
      expect(await git.head()).not.toBe(head);
      expect((await exec("git", ["--git-dir", git.bare, "show", remotePath])).stdout).toBe(
        remoteBefore,
      );
      expect(await readFile(path, "utf8")).toBe(damaged);
      await a.stores.remove(healthy.id);
      const removed = await a.restart().sync();
      expect(removed.status).toBe("error");
      expect(removed.items.some((item) => item.key === `knowledge:${healthy.id}`)).toBe(false);
      expect(
        (
          await exec("git", [
            "--git-dir",
            git.bare,
            "ls-tree",
            "-r",
            "--name-only",
            "main",
            `pragma-sync/knowledge-bases/${healthy.id}`,
          ])
        ).stdout,
      ).toBe("");
      expect(await readFile(path, "utf8")).toBe(damaged);
      if (original) await writeFile(path, original);
      else await rm(path);
      const repaired = await a.restart().sync();
      expect(repaired.status, repaired.error).toBe("ready");
      expect(await a.assetGit.source({ kind: "knowledge", id: broken.id })).toEqual(source);
    },
  );

  it("defers an unreadable Git association during import replay while publishing unrelated changes", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    let armed = false;
    const b = device(join(git.root, "b"), false, undefined, undefined, undefined, {
      afterSourceRestored: async () => {
        if (armed) {
          armed = false;
          throw new Error("Interrupted source publication");
        }
      },
    });
    const broken = await addKnowledge(a.stores, "Broken config");
    const healthy = await addKnowledge(a.stores, "Healthy content");
    const target = { kind: "knowledge" as const, id: broken.id };
    const source = { remote: "ssh://git@pragma.test/x.git", branch: "main" };
    await a.assetGit.restoreSource(target, source);
    await a.service.configure(configuration);
    await b.service.configure(configuration);
    const statePath = join(b.root, "state/asset-sync/state.json");
    const baseline = JSON.parse(await readFile(statePath, "utf8")).bases[
      `knowledge-git:${broken.id}`
    ];
    const changed = { ...source, branch: "release" };
    await a.assetGit.restoreSource(target, changed);
    expect((await a.service.sync()).status).toBe("ready");
    armed = true;
    expect((await b.service.sync()).status).toBe("error");
    const path = join(b.root, "state", "asset-git", "knowledge", `${broken.id}.json`);
    const original = await readFile(path);
    await writeFile(path, "{");
    await append(b.stores, healthy.id, "# Unrelated local update");
    const result = await b.restart().sync();
    expect(result.status).toBe("error");
    expect(result.items.find((item) => item.key === `knowledge:${healthy.id}`)?.status).toBe(
      "synced",
    );
    expect(JSON.parse(await readFile(statePath, "utf8")).bases[`knowledge-git:${broken.id}`]).toBe(
      baseline,
    );
    expect(await readFile(path, "utf8")).toBe("{");
    await writeFile(path, original);
    const repaired = await b.restart().sync();
    expect(repaired.status, repaired.error).toBe("ready");
    expect(await b.assetGit.source(target)).toEqual(changed);
  });

  it("reports a never-synced unreadable Git association without inventing a baseline", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const broken = await addKnowledge(a.stores, "Broken config");
    const healthy = await addKnowledge(a.stores, "Healthy content");
    const path = join(a.root, "state", "asset-git", "knowledge", `${broken.id}.json`);
    await mkdir(join(a.root, "state", "asset-git", "knowledge"), { recursive: true });
    await writeFile(path, "{");
    const result = await a.service.configure(configuration);
    expect(result.status).toBe("error");
    expect(result.items.find((item) => item.key === `knowledge-git:${broken.id}`)?.status).toBe(
      "error",
    );
    expect(result.items.find((item) => item.key === `knowledge:${healthy.id}`)?.status).toBe(
      "synced",
    );
    const state = JSON.parse(await readFile(join(a.root, "state/asset-sync/state.json"), "utf8"));
    expect(state.bases[`knowledge-git:${broken.id}`]).toBeUndefined();
    expect(state.remoteItems[`knowledge-git:${broken.id}`]).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe("{");
  });

  it.each(["knowledge", "skill"] as const)(
    "synchronizes %s Git associations with conflict choices and unbinding",
    async (kind) => {
      const git = await fixture();
      const a = device(join(git.root, "a"));
      const b = device(join(git.root, "b"));
      const id =
        kind === "knowledge"
          ? (await addKnowledge(a.stores, "Shared docs")).id
          : (await addSkill(a.capabilities, a.root, true)).manifest.id;
      const target = { kind, id };
      const first = { remote: "ssh://git@pragma.test/individual.git", branch: "main" };
      await exec("git", [
        "init",
        "--bare",
        "--initial-branch=main",
        join(git.root, "individual.git"),
      ]);
      await a.assetGit.bind({ target, source: first });
      expect((await a.assetGit.sync(target)).status).toBe("synced");
      expect((await a.service.configure(configuration)).status).toBe("ready");
      const path = `pragma-sync/${kind === "knowledge" ? "knowledge-bases" : "skills"}/${id}/git.yaml`;
      expect(
        parsePragmaYaml(
          (await exec("git", ["--git-dir", git.bare, "show", `main:${path}`])).stdout,
        ),
      ).toEqual(first);
      const imported = await b.service.configure(configuration);
      expect(imported.status, imported.error).toBe("ready");
      expect(await b.assetGit.source(target)).toEqual(first);
      const sourceStatus = await b.assetGit.status(target);
      expect(sourceStatus.status).toBe("pending");
      expect(sourceStatus.syncedAt).toBeUndefined();
      const restoredSync = await b.assetGit.sync(target);
      expect(restoredSync.status, restoredSync.error).toBe("synced");
      const key = `${kind}-git:${id}`;
      expect(imported.items.find((item) => item.key === key)).toMatchObject({
        assetKey: `${kind}:${id}`,
        assetKind: kind,
        status: "synced",
      });
      const revision = async () =>
        kind === "knowledge"
          ? (await b.stores.getSnapshot(id)).revision
          : (await b.capabilities.get(id)).manifest.latestRevision;
      const initialRevision = await revision();
      const head = await git.head();
      expect((await b.restart().sync()).status).toBe("ready");
      expect(await git.head()).toBe(head);
      const fromA = { ...first, branch: "from-a" };
      await a.assetGit.restoreSource(target, fromA, first);
      await b.assetGit.restoreSource(target, { ...first, branch: "from-b" }, first);
      expect((await a.service.sync()).status).toBe("ready");
      expect((await b.service.sync()).items.find((item) => item.key === key)?.status).toBe(
        "conflict",
      );
      expect((await b.service.resolve(key, "remote")).status).toBe("ready");
      expect(await b.assetGit.source(target)).toEqual(fromA);
      expect(await revision()).toBe(initialRevision);
      await expect(
        b.assetGit.restoreSource(target, first, { ...first, branch: "stale" }),
      ).rejects.toThrow("changed during restore");
      expect(await b.assetGit.source(target)).toEqual(fromA);
      await a.assetGit.unbind(target);
      const unbound = await a.service.sync();
      expect(unbound.status, unbound.error).toBe("ready");
      expect((await b.service.sync()).status).toBe("ready");
      expect(await b.assetGit.source(target)).toBeUndefined();
      expect(await revision()).toBe(initialRevision);
      await a.assetGit.restoreSource(target, first);
      expect((await a.service.sync()).status).toBe("ready");
      expect((await b.service.sync()).status).toBe("ready");
      expect(await b.assetGit.source(target)).toEqual(first);
      if (kind === "knowledge") await a.stores.remove(id);
      else await a.capabilities.remove(id);
      expect((await a.service.sync()).status).toBe("ready");
      const deleted = await b.service.sync();
      expect(deleted.status, deleted.error).toBe("ready");
      expect(await b.assetGit.source(target)).toBeUndefined();
      expect(await (kind === "knowledge" ? b.stores.exists(id) : b.capabilities.exists(id))).toBe(
        false,
      );
    },
  );

  it.each(["knowledge", "skill"] as const)(
    "restores %s Git associations after interrupted asset publication",
    async (kind) => {
      const git = await fixture();
      const a = device(join(git.root, "a"));
      const b = device(join(git.root, "b"), kind === "knowledge" ? true : "skill");
      const id =
        kind === "knowledge"
          ? (await addKnowledge(a.stores, "Shared docs")).id
          : (await addSkill(a.capabilities, a.root, true)).manifest.id;
      const target = { kind, id };
      const source = { remote: "ssh://git@pragma.test/individual.git", branch: "release" };
      await a.assetGit.restoreSource(target, source);
      expect((await a.service.configure(configuration)).status).toBe("ready");
      expect((await b.service.configure(configuration)).status).toBe("error");
      expect(await b.assetGit.source(target)).toBeUndefined();
      const recovered = await b.restart().sync();
      expect(recovered.status, recovered.error).toBe("ready");
      expect(await b.assetGit.source(target)).toEqual(source);
      const revision =
        kind === "knowledge"
          ? (await b.stores.getSnapshot(id)).revision
          : (await b.capabilities.get(id)).manifest.latestRevision;
      expect(revision).toBe(1);
    },
  );

  it.each(["input", "executor"] as const)(
    "refreshes imported Automation schedules and resets changed sessions once across journal replay (%s)",
    async (change) => {
      const git = await fixture();
      const a = device(join(git.root, "a"));
      const schedulerRef: { current?: ReturnType<typeof createAutomationService> } = {};
      let interruptRefresh = false;
      const b = device(join(git.root, "b"), false, undefined, undefined, undefined, {
        onAutomationsImported: async (changes, operationId) => {
          await schedulerRef.current?.refresh(
            changes.map((change) => ({
              previous: change.local
                ? AutomationResourceSchema.parse(change.local.data)
                : undefined,
              current: change.remote
                ? AutomationResourceSchema.parse(change.remote.data)
                : undefined,
            })),
            operationId,
          );
          if (interruptRefresh) {
            interruptRefresh = false;
            throw new Error("Interrupted after scheduler refresh");
          }
        },
      });
      let current = automation();
      current.spec.interaction.mode = "reuse-session";
      current = PragmaForwardCompatibleResourceSchema.parse({
        ...current,
        futureMetadata: { preserved: true },
      }) as typeof current;
      const ref = canonicalPragmaResourceRef(current);
      await a.project.publish({ expectedRevision: 0, resources: [...resources(), current] });
      await a.service.configure(configuration);
      await b.service.configure(configuration);
      const paths = new PragmaPaths({ pragmaHome: b.root });
      const store = createAutomationStore(paths, b.project.projectId);
      expect(await store.getBinding(ref)).toBeUndefined();
      const binding = await store.saveBinding(
        createAutomationBinding({
          automationRef: ref,
          rotateGeneration: true,
          workspace: { path: b.root, basename: "b" },
        }),
      );
      type Options = Parameters<typeof createAutomationService>[0];
      const scheduler = createAutomationService({
        paths,
        project: b.project,
        store,
        missions: {
          backfillAutomationOrigin: vi.fn(async () => undefined),
        } as unknown as Options["missions"],
        creator: {} as Options["creator"],
        application: {} as Options["application"],
        now: () => new Date("2026-07-23T08:00:00.000Z"),
      });
      schedulerRef.current = scheduler;
      const publish = async () => {
        await a.project.upsert({
          baseRevision: (await a.project.get()).revision,
          resource: current,
        });
        expect((await a.service.sync()).status).toBe("ready");
      };
      try {
        await scheduler.start();
        await store.updateState(ref, binding.generation, (state) => ({
          ...state,
          missionId: "7b143dfa-16d9-45dd-8275-839565ac691f",
        }));
        expect((await store.getState(ref, binding.generation)).nextRunAt).toBe(
          "2026-07-23T09:00:00.000Z",
        );
        current = {
          ...current,
          spec: {
            ...current.spec,
            config: {
              trigger: { kind: "calendar", frequency: "daily", time: "10:00", timezone: "UTC" },
            },
          },
        };
        await publish();
        expect((await b.service.sync()).status).toBe("ready");
        expect((await store.getBinding(ref))?.generation).toBe(binding.generation);
        expect((await store.getState(ref, binding.generation)).nextRunAt).toBe(
          "2026-07-23T10:00:00.000Z",
        );

        if (change === "executor") {
          const expert = resources().find((resource) => resource.kind === "Expert")!;
          await a.project.upsert({
            baseRevision: (await a.project.get()).revision,
            resource: {
              ...expert,
              metadata: { ...expert.metadata, id: "2xddvess309a6gme", name: "Other writer" },
            },
          });
        }
        current = {
          ...current,
          spec: {
            ...current.spec,
            route:
              change === "input"
                ? { ...current.spec.route, input: { kind: "prompt", value: "New input" } }
                : { ...current.spec.route, executor: { ref: "expert:2xddvess309a6gme" } },
          },
        };
        await publish();
        interruptRefresh = true;
        expect((await b.service.sync()).status).toBe("error");
        const rotated = (await store.getBinding(ref))!;
        expect(rotated.generation).not.toBe(binding.generation);
        expect(rotated.workspace).toEqual(binding.workspace);
        expect(
          (await b.project.get()).resources.find((resource) => resource.kind === "Automation"),
        ).toHaveProperty("futureMetadata", { preserved: true });
        expect((await b.restart().sync()).status).toBe("ready");
        expect((await store.getBinding(ref))?.generation).toBe(rotated.generation);
        expect((await store.getState(ref, rotated.generation)).missionId).toBeUndefined();

        current = { ...current, spec: { ...current.spec, enabled: false } };
        await publish();
        expect((await b.service.sync()).status).toBe("ready");
        expect((await store.getState(ref, rotated.generation)).nextRunAt).toBeUndefined();
      } finally {
        scheduler.stop();
      }
    },
  );

  it.each(["unchanged", "local", "remote", "both", "local-delete", "remote-delete"] as const)(
    "retains historical checkpoint semantics across DSL migration with %s changes",
    async (change) => {
      const git = await fixture();
      const history = join(import.meta.dirname, "migrations/fixtures/v1");
      const journal = JSON.parse(await readFile(join(history, "restore-journal.json"), "utf8"));
      const legacy = CoreAssetSyncItemSchema.parse(journal.changes[0].remote);
      const current = PragmaForwardCompatibleResourceSchema.parse(migrateSyncDslItem(legacy).data);
      if (current.kind !== "RuntimeProfile") throw new Error("Expected historical RuntimeProfile");
      const a = device(join(git.root, "a"));
      await a.project.publish({ expectedRevision: 0, resources: [current] });
      if (change === "local" || change === "both")
        await a.project.upsert({
          baseRevision: (await a.project.get()).revision,
          resource: {
            ...current,
            spec: {
              ...current.spec,
              config: { model: "local-edit", runtimeId: "codex", providerId: "openai" },
            },
          },
        });
      if (change === "local-delete")
        await a.project.apply({
          baseRevision: (await a.project.get()).revision,
          removals: [canonicalPragmaResourceRef(current)],
          upserts: [],
        });
      const seed = join(git.root, "checkpoint-seed");
      await mkdir(seed);
      await exec("git", ["-C", seed, "init", "-b", "main"]);
      await writeSyncRepository(seed, new Map([[legacy.key, migrateSyncDslItem(legacy)]]));
      const path = join(seed, "pragma-sync/runtime-profiles", `${current.metadata.id}.pragma.yaml`);
      const raw = legacy.data as { spec: { config: Record<string, unknown> } };
      if (change === "remote" || change === "both") raw.spec.config.model = "remote-edit";
      if (change === "remote-delete") await rm(path);
      else await writeFile(path, formatPragmaYaml(raw));
      await exec("git", ["-C", seed, "add", "."]);
      await exec("git", ["-C", seed, "commit", "-m", "Historical checkpoint resource"]);
      await exec("git", ["-C", seed, "push", git.bare, "main"]);
      const owner = join(a.root, "state/asset-sync");
      await mkdir(owner, { recursive: true });
      for (const name of ["settings.json", "state.json"])
        await writeFile(join(owner, name), await readFile(join(history, name)));
      const result = await a.service.sync();
      expect(result.status, result.error).toBe(change === "both" ? "conflict" : "ready");
      const resources = (await a.project.get()).resources;
      if (change.endsWith("delete")) expect(resources).toEqual([]);
      else {
        expect(resources).toHaveLength(1);
        expect(resources[0]).toMatchObject({
          apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
          spec: {
            config: {
              model:
                change === "remote"
                  ? "remote-edit"
                  : change === "local" || change === "both"
                    ? "local-edit"
                    : "test",
            },
          },
        });
      }
      const repeated = await a.restart().sync();
      expect(repeated.status, repeated.error).toBe(result.status);
    },
  );

  it.each([false, true])(
    "imports historical DSL from real Git and retries without duplicate publication after interruption=%s",
    async (interrupted) => {
      const git = await fixture();
      const seed = join(git.root, "legacy-dsl-seed");
      const path = "experts/v2vt1v01vzz6j24q.pragma.yaml";
      const original = await readFile(
        new URL(
          "../../../../../../packages/interpreter/test/fixtures/compiler-v9-expert-permissions/experts/v2vt1v01vzz6j24q.pragma.yaml",
          import.meta.url,
        ),
        "utf8",
      );
      const runtime = resources().find((resource) => resource.kind === "RuntimeProfile")!;
      runtime.metadata.name = "Historical expert Runtime";
      const historical = parsePragmaYaml(original) as { spec: Record<string, unknown> };
      // The execution-snapshot fixture has no runtime; bind one for ordinary Project import.
      const legacy = formatPragmaYaml({
        ...historical,
        spec: { ...historical.spec, runtime: { ref: canonicalPragmaResourceRef(runtime) } },
      });
      await mkdir(join(seed, "pragma-sync", "experts"), { recursive: true });
      await exec("git", ["-C", seed, "init", "-b", "main"]);
      await writeFile(
        join(seed, "pragma-sync/sync.yaml"),
        "schemaVersion: pragma.asset-sync-repository/v2\n",
      );
      await writeFile(join(seed, "pragma-sync", path), legacy);
      await mkdir(join(seed, "pragma-sync/runtime-profiles"));
      await writeFile(
        join(seed, "pragma-sync/runtime-profiles/zdkgs0fde4xt00vr.pragma.yaml"),
        formatPragmaYaml(runtime),
      );
      await exec("git", ["-C", seed, "add", "."]);
      await exec("git", ["-C", seed, "commit", "-m", "Historical DSL writer output"]);
      await exec("git", ["-C", seed, "push", git.bare, "main"]);
      const historicalHead = await git.head();
      const a = device(join(git.root, "a"), interrupted ? "project" : false);
      const first = await a.service.configure(configuration);
      expect(first.status, first.error).toBe(interrupted ? "error" : "ready");
      const published = await a.project.get();
      expect(published.resources).toHaveLength(2);
      expect(published.resources).toEqual(
        expect.arrayContaining([
          { ...(parsePragmaYaml(legacy) as object), apiVersion: PRAGMA_DSL_WRITE_API_VERSION },
          runtime,
        ]),
      );
      if (interrupted) {
        expect(await git.head()).toBe(historicalHead);
        const journal = JSON.parse(
          await readFile(join(a.root, "state/asset-sync/restore-journal.json"), "utf8"),
        );
        expect(JSON.stringify(journal)).toContain(PRAGMA_DSL_WRITE_API_VERSION);
      }
      const retry = await a.restart().sync();
      expect(retry.status, retry.error).toBe("ready");
      expect((await a.project.get()).revision).toBe(published.revision);
      expect((await a.restart().sync()).status).toBe("ready");
      expect((await a.project.get()).revision).toBe(published.revision);
      expect(await git.head()).toBe(historicalHead);
      // Reading alone is not an outgoing change. A subsequent local edit publishes current DSL.
      await a.project.publish({
        expectedRevision: published.revision,
        resources: published.resources.map((resource) =>
          resource.kind === "Expert"
            ? { ...resource, spec: { ...resource.spec, instructions: "Edited after migration" } }
            : resource,
        ),
      });
      const outgoing = await a.service.sync();
      expect(outgoing.status, outgoing.error).toBe("ready");
      const check = join(git.root, "inspect-dsl-upgrade");
      await exec("git", ["clone", git.bare, check]);
      expect(await readFile(join(check, "pragma-sync", path), "utf8")).toContain(
        `apiVersion: ${PRAGMA_DSL_WRITE_API_VERSION}`,
      );
      expect(
        (await exec("git", ["-C", check, "show", `${historicalHead}:pragma-sync/${path}`])).stdout,
      ).toBe(legacy);
    },
  );

  it.each(["knowledge", "skill"] as const)(
    "preserves an unreadable local %s authority instead of deleting its Git backup",
    async (kind) => {
      const git = await fixture();
      const a = device(join(git.root, "a"));
      const id =
        kind === "knowledge"
          ? (await addKnowledge(a.stores, "Protected docs")).id
          : (await addSkill(a.capabilities, a.root)).manifest.id;
      const independent = await addKnowledge(a.stores, "Independent docs");
      await a.service.configure(configuration);
      const statePath = join(a.root, "state/asset-sync/state.json");
      const before = JSON.parse(await readFile(statePath, "utf8"));
      await writeFile(
        join(
          a.root,
          "data",
          kind === "knowledge" ? "context-stores" : "capabilities",
          id,
          kind === "knowledge" ? "store.json" : "capability.json",
        ),
        "{}",
      );
      await append(a.stores, independent.id, "# Independent edit");
      const result = await a.service.sync();
      expect(result.items.find((item) => item.key === `${kind}:${id}`)).toMatchObject({
        status: "error",
      });
      expect(result.items.find((item) => item.key === `knowledge:${independent.id}`)?.status).toBe(
        "synced",
      );
      const state = JSON.parse(await readFile(statePath, "utf8"));
      expect(state.bases[`${kind}:${id}`]).toBe(before.bases[`${kind}:${id}`]);
      const check = join(git.root, "inspect-unreadable");
      await exec("git", ["clone", git.bare, check]);
      expect((await readSyncRepository(check, true)).has(`${kind}:${id}`)).toBe(true);
    },
  );

  it.each([
    ["sync", "local"],
    ["sync", "remote"],
    ["refresh", "local"],
    ["refresh", "remote"],
    ["automatic", "local"],
    ["automatic", "remote"],
  ] as const)(
    "isolates incoming referenced deletions during %s and resolves with %s while automatic upload is disabled",
    async (entry, choice) => {
      const git = await fixture();
      const a = device(join(git.root, "a"));
      const original = resources().filter((resource) => resource.kind !== "Flow");
      await a.project.publish({ expectedRevision: 0, resources: original });
      const knowledge = await addKnowledge(a.stores, "Independent docs");
      await a.service.configure(configuration);
      const b = device(join(git.root, "b"));
      await b.service.configure(configuration);
      const expert = original.find((resource) => resource.kind === "Expert")!;
      const runtime = original.find((resource) => resource.kind === "RuntimeProfile")!;
      await b.project.upsert({
        baseRevision: (await b.project.get()).revision,
        resource: { ...expert, spec: { ...expert.spec, instructions: "Local instructions" } },
      });
      await a.project.apply({
        baseRevision: (await a.project.get()).revision,
        upserts: [],
        removals: original.map(canonicalPragmaResourceRef),
      });
      await append(a.stores, knowledge.id, "# Independent remote update");
      await a.service.sync();
      const result = await b.service[entry]();
      expect(result.status, result.error).toBe("conflict");
      expect(result.error).toBeUndefined();
      for (const resource of original)
        expect(
          result.items.find(
            (item) =>
              item.key ===
              `${resource.kind === "Expert" ? "expert" : "runtime-profile"}:${canonicalPragmaResourceRef(resource)}`,
          )?.status,
        ).toBe("conflict");
      expect((await b.project.get()).resources).toContainEqual(runtime);
      expect((await b.stores.getSnapshot(knowledge.id)).files[0]?.content).toBe(
        "# Independent remote update",
      );
      expect((await b.restart().refresh()).status).toBe("conflict");
      const resolved = await b
        .restart()
        .resolve(`expert:${canonicalPragmaResourceRef(expert)}`, choice);
      expect(resolved.status, resolved.error).toBe("ready");
      const finalResources = (await b.project.get()).resources;
      if (choice === "remote") expect(finalResources).toEqual([]);
      else {
        expect(finalResources).toContainEqual(runtime);
        expect(finalResources.find((resource) => resource.kind === "Expert")?.spec).toMatchObject({
          instructions: "Local instructions",
        });
        const check = join(git.root, "inspect-retained-dependency");
        await exec("git", ["clone", git.bare, check]);
        expect(
          (await readSyncRepository(check, true)).has(
            `runtime-profile:${canonicalPragmaResourceRef(runtime)}`,
          ),
        ).toBe(true);
      }
    },
  );

  it.each(["repair", "delete"] as const)(
    "persists unreadable authority diagnostics after remote deletion until %s",
    async (recovery) => {
      const git = await fixture();
      const a = device(join(git.root, "a"));
      const knowledge = await addKnowledge(a.stores, "Protected docs");
      await a.service.configure(configuration);
      const b = device(join(git.root, "b"));
      await b.service.configure(configuration);
      const path = join(b.root, "data/context-stores", knowledge.id, "store.json");
      const original = await readFile(path, "utf8");
      await writeFile(path, "{}");
      await a.stores.remove(knowledge.id);
      await a.service.sync();
      const key = `knowledge:${knowledge.id}`;
      for (const result of [
        await b.service.sync(),
        await b.service.refresh(),
        await b.restart().overview(),
      ]) {
        expect(result.status, result.error).toBe("error");
        expect(result.items.find((item) => item.key === key)).toMatchObject({
          name: "Protected docs",
          status: "error",
        });
      }
      const state = JSON.parse(await readFile(join(b.root, "state/asset-sync/state.json"), "utf8"));
      expect(state.remoteItems[key]).toBeUndefined();
      expect(state.bases[key]).toBeDefined();
      if (recovery === "repair") await writeFile(path, original);
      else await rm(join(b.root, "data/context-stores", knowledge.id), { recursive: true });
      const repaired = await b.restart().refresh();
      expect(repaired.status, repaired.error).toBe("ready");
      expect(repaired.items.some((item) => item.key === key)).toBe(false);
      expect(await b.stores.exists(knowledge.id)).toBe(false);
      const completed = JSON.parse(
        await readFile(join(b.root, "state/asset-sync/state.json"), "utf8"),
      );
      expect(completed.unavailableItems[key]).toBeUndefined();
    },
  );

  it("rechecks a local deletion after incoming publication recreates the authority", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const knowledge = await addKnowledge(a.stores, "Original docs");
    await a.service.configure(configuration);
    let recreate = false;
    const b = device(join(git.root, "b"), false, undefined, undefined, undefined, {
      afterApply: async () => {
        if (!recreate) return;
        recreate = false;
        await b.stores.createFromSnapshot({
          id: knowledge.id,
          name: "Recreated docs",
          description: "Recreated",
          directories: [],
          files: [],
          author: "user",
          summary: "Recreated locally",
        });
      },
    });
    await b.service.configure(configuration);
    await b.stores.remove(knowledge.id);
    const runtime = resources().find((resource) => resource.kind === "RuntimeProfile")!;
    await a.project.publish({ expectedRevision: 0, resources: [runtime] });
    await a.service.sync();
    recreate = true;
    const result = await b.service.sync();
    expect(result.status, result.error).toBe("ready");
    const check = join(git.root, "inspect-recreation");
    await exec("git", ["clone", git.bare, check]);
    expect((await readSyncRepository(check, true)).get(`knowledge:${knowledge.id}`)?.name).toBe(
      "Recreated docs",
    );
    expect((await b.stores.get(knowledge.id)).name).toBe("Recreated docs");
  });
  it.each([false, true])(
    "upgrades real historical state before execution with an interrupted import=%s",
    async (interrupted) => {
      const git = await fixture();
      const a = device(join(git.root, "a"));
      const historical = join(import.meta.dirname, "migrations/fixtures/v1");
      const journal = JSON.parse(
        await readFile(join(historical, "restore-journal.json"), "utf8"),
      ) as { changes: { remote: unknown }[] };
      const item = CoreAssetSyncItemSchema.parse(journal.changes[0]!.remote);
      const seed = join(git.root, "historical-seed");
      await mkdir(seed);
      await exec("git", ["-C", seed, "init", "-b", "main"]);
      await writeSyncRepository(seed, new Map([[item.key, migrateSyncDslItem(item)]]));
      const legacyPath = join(
        seed,
        "pragma-sync/runtime-profiles",
        `${item.key.split(":").at(-1)}.pragma.yaml`,
      );
      await writeFile(legacyPath, formatPragmaYaml(item.data));
      await exec("git", ["-C", seed, "add", "."]);
      await exec("git", ["-C", seed, "commit", "-m", "Historical repository"]);
      await exec("git", ["-C", seed, "push", git.bare, "main"]);
      const owner = join(a.root, "state/asset-sync");
      await mkdir(owner, { recursive: true });
      for (const name of interrupted
        ? ["settings.json", "state.json", "restore-journal.json"]
        : ["settings.json", "state.json"])
        await writeFile(join(owner, name), await readFile(join(historical, name)));
      const upgraded = await a.service.sync();
      expect(upgraded.status, upgraded.error).toBe("ready");
      expect((await a.project.get()).resources.map(canonicalPragmaResourceRef)).toEqual(
        interrupted ? [item.key.slice("runtime-profile:".length)] : [],
      );
      expect(upgraded.items.find((entry) => entry.key === item.key)?.status).toBe(
        interrupted ? "synced" : undefined,
      );
      const revision = (await a.project.get()).revision;
      expect((await a.restart().sync()).status).toBe("ready");
      expect((await a.project.get()).revision).toBe(revision);
      const state = JSON.parse(await readFile(join(owner, "state.json"), "utf8"));
      expect(state.schemaVersion).toBe("pragma.asset-sync-state/v3");
      expect(state).not.toHaveProperty("ignoredRemote");
      const settings = JSON.parse(await readFile(join(owner, "settings.json"), "utf8"));
      expect(settings).not.toHaveProperty("pushDeletions");
      await expect(readFile(join(owner, "restore-journal.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.each(["conflict", "after-commit interruption"] as const)(
    "coordinates Flow layout deletion with Project publication during %s",
    async (mode) => {
      const git = await fixture();
      const a = device(join(git.root, "a"));
      const original = resources();
      const flow = original.find((resource) => resource.kind === "Flow")!;
      let enabled = false;
      const b = device(join(git.root, "b"), false, undefined, undefined, undefined, {
        beforeApply: async (project) => {
          if (!enabled || mode !== "conflict") return;
          enabled = false;
          await project.upsert({
            baseRevision: (await project.get()).revision,
            resource: { ...flow, metadata: { ...flow.metadata, description: "Concurrent edit" } },
          });
        },
        afterApply: async () => {
          if (!enabled || mode !== "after-commit interruption") return;
          enabled = false;
          throw new Error("Injected interruption after Flow deletion commit.");
        },
      });
      await a.project.publish({ expectedRevision: 0, resources: original });
      await a.layouts.save(initialLayout);
      await a.service.configure({ ...configuration });
      await b.service.configure(configuration);
      await a.project.remove({
        baseRevision: (await a.project.get()).revision,
        ref: canonicalPragmaResourceRef(flow),
      });
      await a.service.sync();
      enabled = true;
      const result = await b.service.refresh();
      if (mode === "conflict") {
        expect(result.status, result.error).toBe("conflict");
        expect(await b.layouts.get(initialLayout)).toMatchObject({ nodes: initialLayout.nodes });
        expect((await b.restart().refresh()).status).toBe("conflict");
        expect(await b.layouts.get(initialLayout)).toMatchObject({ nodes: initialLayout.nodes });
        const resolved = await b
          .restart()
          .resolve(`flow:${canonicalPragmaResourceRef(flow)}`, "local");
        expect(resolved.status, resolved.error).toBe("ready");
        const checkout = join(git.root, "inspect-preserved-layout");
        await exec("git", ["clone", git.bare, checkout]);
        expect(
          (await readSyncRepository(checkout, true)).get(`flow-layout:${flow.metadata.id}`)?.data,
        ).toMatchObject({ nodes: initialLayout.nodes });
      } else {
        expect(result.status).toBe("error");
        expect(await b.layouts.get(initialLayout)).toBeNull();
        const recovered = await b.restart().refresh();
        expect(recovered.status, recovered.error).toBe("ready");
        expect(recovered.items.some((item) => item.assetKey === `flow:${flow.metadata.id}`)).toBe(
          false,
        );
        expect(await b.layouts.get(initialLayout)).toBeNull();
      }
    },
  );

  it("isolates one Project CAS conflict while importing the other independent DSL resources", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const runtime = resources().find((resource) => resource.kind === "RuntimeProfile")!;
    const original = ["zdkgs0fde4xt00vr", "2dkgs0fde4xt00vr", "3dkgs0fde4xt00vr"].map((id) => ({
      ...runtime,
      metadata: { ...runtime.metadata, id, name: `Runtime ${id[0]}` },
    }));
    let enabled = false;
    const b = device(join(git.root, "b"), false, undefined, undefined, undefined, {
      beforeApply: async (project) => {
        if (!enabled) return;
        enabled = false;
        await project.upsert({
          baseRevision: (await project.get()).revision,
          resource: {
            ...original[1]!,
            metadata: { ...original[1]!.metadata, description: "User edit" },
          },
        });
      },
    });
    await a.project.publish({ expectedRevision: 0, resources: original });
    await a.service.configure(configuration);
    await b.service.configure(configuration);
    const incoming = original.map((resource) => ({
      ...resource,
      metadata: { ...resource.metadata, description: "Remote edit" },
    }));
    await a.project.apply({ baseRevision: (await a.project.get()).revision, upserts: incoming });
    await a.service.sync();
    enabled = true;
    const result = await b.service.refresh();
    expect(result.status, result.error).toBe("conflict");
    expect(
      result.items.filter((item) => item.status === "conflict").map((item) => item.key),
    ).toEqual([`runtime-profile:${canonicalPragmaResourceRef(original[1]!)}`]);
    const current = (await b.project.get()).resources;
    for (const index of [0, 2])
      expect(
        current.find((resource) => resource.metadata.id === original[index]!.metadata.id),
      ).toEqual(incoming[index]);
    expect(
      current.find((resource) => resource.metadata.id === original[1]!.metadata.id)?.metadata
        .description,
    ).toBe("User edit");
    const state = JSON.parse(await readFile(join(b.root, "state/asset-sync/state.json"), "utf8"));
    expect(state.restoreConflicts).toEqual([
      `runtime-profile:${canonicalPragmaResourceRef(original[1]!)}`,
    ]);
    expect(
      (
        await b
          .restart()
          .resolve(`runtime-profile:${canonicalPragmaResourceRef(original[1]!)}`, "local")
      ).status,
    ).toBe("ready");
  });

  it.each(["knowledge", "capability"] as const)(
    "defers incoming dependents when an unchanged %s authority becomes unreadable and resumes after repair",
    async (kind) => {
      const git = await fixture();
      const a = device(join(git.root, "a"));
      const authority =
        kind === "knowledge"
          ? await addKnowledge(a.stores, "Docs")
          : await a.capabilities.create({
              definition: {
                kind: "mcp_server",
                name: "Tools",
                description: "Tools",
                connection: { transport: "streamable-http", url: "https://example.test/mcp" },
                tools: [],
                timeoutMs: 30_000,
              },
              credentials: {},
            });
      const authorityId = "id" in authority ? authority.id : authority.manifest.id;
      const binding =
        kind === "knowledge"
          ? createDesktopContextResource({ owner: "project-expert", storeId: authorityId })
          : createDesktopCapabilityResource({ owner: "project-expert", capabilityId: authorityId });
      const runtime = resources().find((resource) => resource.kind === "RuntimeProfile")!;
      const expert = resources(kind === "knowledge" ? authorityId : undefined).find(
        (resource) => resource.kind === "Expert",
      )!;
      if (kind === "capability")
        expert.spec.capabilities = [
          { ref: canonicalPragmaResourceRef(binding), kind: "tools", tools: [] },
        ];
      const flow = resources().find((resource) => resource.kind === "Flow")!;
      let armed = false;
      let enabled = false;
      let invalidated = false;
      const path = join(
        git.root,
        "b/data",
        kind === "knowledge" ? "context-stores" : "capabilities",
        authorityId,
        kind === "knowledge" ? "store.json" : "capability.json",
      );
      const b = device(join(git.root, "b"), false, undefined, undefined, undefined, {
        afterValidation: async () => {
          if (enabled && !invalidated) armed = true;
        },
        beforeGet: async () => {
          if (!armed) return;
          armed = false;
          invalidated = true;
          await writeFile(path, "{}");
        },
      });
      await a.project.publish({ expectedRevision: 0, resources: [runtime, binding] });
      await a.service.configure(configuration);
      await b.service.configure(configuration);
      const originalManifest = await readFile(path, "utf8");
      await a.project.apply({
        baseRevision: (await a.project.get()).revision,
        upserts: [expert, flow],
      });
      await a.layouts.save(initialLayout);
      await a.service.sync();
      enabled = true;
      const result = await b.service.refresh();
      expect(invalidated).toBe(true);
      expect(result.status, result.error).toBe("error");
      expect(result.items.find((item) => item.key === `${kind}:${authorityId}`)?.status).toBe(
        "error",
      );
      expect(result.items.some((item) => item.status === "conflict")).toBe(false);
      expect(
        result.items.find((item) => item.key === `expert:${canonicalPragmaResourceRef(expert)}`)
          ?.status,
      ).toBe("pending");
      expect(
        result.items.find((item) => item.key === `flow:${canonicalPragmaResourceRef(flow)}`)
          ?.status,
      ).toBe("pending");
      expect(await b.layouts.get(initialLayout)).toBeNull();
      await expect(
        readFile(join(b.root, "state/asset-sync/restore-journal.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(path, originalManifest);
      const service = b.restart();
      const restored = await service.refresh();
      expect(restored.status, restored.error).toBe("ready");
      expect(await b.layouts.get(initialLayout)).toMatchObject({ nodes: initialLayout.nodes });
    },
  );

  it("defers a keep-local expert until its conflicted runtime can also be published", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const b = device(join(git.root, "b"));
    const original = resources().filter((resource) => resource.kind !== "Flow");
    await a.project.publish({ expectedRevision: 0, resources: original });
    await a.service.configure({ ...configuration });
    await b.service.configure(configuration);
    await b.project.apply({
      baseRevision: (await b.project.get()).revision,
      upserts: original.map((resource) => ({
        ...resource,
        metadata: { ...resource.metadata, description: "Local change" },
      })),
    });
    await a.project.apply({
      baseRevision: (await a.project.get()).revision,
      removals: original.map(canonicalPragmaResourceRef),
    });
    await a.service.sync();
    expect((await b.service.sync()).status).toBe("conflict");
    const expertKey = "expert:expert:1xddvess309a6gme";
    const runtimeKey = "runtime-profile:runtime-profile:zdkgs0fde4xt00vr";
    const deferred = await b.service.resolve(expertKey, "local");
    expect(deferred.status, deferred.error).toBe("conflict");
    const checkout = join(git.root, "inspect-deferred");
    await exec("git", ["clone", git.bare, checkout]);
    expect((await readSyncRepository(checkout, true)).size).toBe(0);
    await b.service.resolve(runtimeKey, "local");
    expect((await b.service.resolve(expertKey, "local")).status).toBe("ready");
    const consumer = device(join(git.root, "consumer"));
    const restored = await consumer.service.configure(configuration);
    expect(restored.status, restored.error).toBe("ready");
    expect((await consumer.project.get()).resources).toEqual((await b.project.get()).resources);
  });

  it.each(["update", "delete", "commit-update"] as const)(
    "preserves a concurrent DSL edit during %s import and permits keep-local recovery",
    async (mode) => {
      const git = await fixture();
      const a = device(join(git.root, "a"));
      const runtime = resources().find((resource) => resource.kind === "RuntimeProfile")!;
      let enabled = false;
      let validations = 0;
      let armed = false;
      let edited = false;
      const edit = async (project: PragmaProjectStore) => {
        if (edited) return;
        edited = true;
        await project.upsert({
          baseRevision: (await project.get()).revision,
          resource: {
            ...runtime,
            spec: {
              ...runtime.spec,
              config: { runtimeId: "codex", providerId: "openai", model: "user-model" },
            },
          },
        });
      };
      const b = device(join(git.root, "b"), false, undefined, undefined, undefined, {
        afterValidation: async () => {
          if (enabled && ++validations === 2) armed = true;
        },
        beforeGet: async (project) => {
          if (!armed || mode === "commit-update") return;
          armed = false;
          await edit(project);
        },
        beforeApply: async (project) => {
          if (!armed || mode !== "commit-update") return;
          armed = false;
          await edit(project);
        },
      });
      await a.project.publish({ expectedRevision: 0, resources: [runtime] });
      await a.service.configure({ ...configuration });
      await b.service.configure(configuration);
      if (mode === "delete")
        await a.project.remove({
          baseRevision: (await a.project.get()).revision,
          ref: canonicalPragmaResourceRef(runtime),
        });
      else
        await a.project.upsert({
          baseRevision: (await a.project.get()).revision,
          resource: {
            ...runtime,
            spec: {
              ...runtime.spec,
              config: { runtimeId: "codex", providerId: "openai", model: "remote-model" },
            },
          },
        });
      await a.service.sync();
      enabled = true;
      const result = await b.service.refresh();
      expect(edited).toBe(true);
      expect(result.status, result.error).toBe("conflict");
      expect((await b.project.get()).resources[0]).toMatchObject({
        spec: { config: { model: "user-model" } },
      });
      await expect(
        readFile(join(b.root, "state/asset-sync/restore-journal.json")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      const recovered = await b
        .restart()
        .resolve(`runtime-profile:${canonicalPragmaResourceRef(runtime)}`, "local");
      expect(recovered.status, recovered.error).toBe("ready");
      expect((await b.project.get()).resources[0]).toMatchObject({
        spec: { config: { model: "user-model" } },
      });
    },
  );

  it.each(["planning", "commit"] as const)(
    "retires a deletion journal when new local experts reference its target during %s",
    async (phase) => {
      const git = await fixture();
      const a = device(join(git.root, "a"));
      const runtime = resources().find((resource) => resource.kind === "RuntimeProfile")!;
      const expert = resources().find((resource) => resource.kind === "Expert")!;
      const otherExpert = {
        ...expert,
        metadata: { ...expert.metadata, id: "2xddvess309a6gme", name: "Writer B" },
      };
      let enabled = false;
      let armed = false;
      let injected = false;
      let validations = 0;
      const addReferences = async (project: PragmaProjectStore) => {
        armed = false;
        injected = true;
        await project.apply({
          baseRevision: (await project.get()).revision,
          upserts: [expert, otherExpert],
        });
      };
      const b = device(join(git.root, "b"), false, undefined, undefined, undefined, {
        afterValidation: async () => {
          if (enabled && ++validations === (phase === "planning" ? 1 : 2)) armed = true;
        },
        beforeGet: async (project) => {
          if (armed && phase === "planning") await addReferences(project);
        },
        beforeApply: async (project) => {
          if (armed && phase === "commit") await addReferences(project);
        },
      });
      await a.project.publish({ expectedRevision: 0, resources: [runtime] });
      await a.service.configure({ ...configuration });
      await b.service.configure(configuration);
      await a.project.remove({
        baseRevision: (await a.project.get()).revision,
        ref: canonicalPragmaResourceRef(runtime),
      });
      await a.service.sync();
      enabled = true;
      const result = await b.service.refresh();
      expect(injected).toBe(true);
      expect(result.status, result.error).toBe("conflict");
      expect((await b.project.get()).resources).toHaveLength(3);
      await expect(
        readFile(join(b.root, "state/asset-sync/restore-journal.json")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      const recovered = await b
        .restart()
        .resolve(`runtime-profile:${canonicalPragmaResourceRef(runtime)}`, "local");
      expect(recovered.status, recovered.error).toBe("ready");
      const consumer = device(join(git.root, "consumer"));
      expect((await consumer.service.configure(configuration)).status).toBe("ready");
      expect((await consumer.project.get()).resources).toHaveLength(3);
    },
  );

  it("completes Git deletion after a crash between push and state persistence", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const runtime = resources().find((resource) => resource.kind === "RuntimeProfile")!;
    const knowledge = await addKnowledge(a.stores, "Unchanged docs");
    await a.project.publish({ expectedRevision: 0, resources: [runtime] });
    await a.service.configure(configuration);
    await a.project.remove({
      baseRevision: (await a.project.get()).revision,
      ref: canonicalPragmaResourceRef(runtime),
    });
    await a.service.refresh();
    const path = join(a.root, "state/asset-sync/state.json");
    const previousState = await readFile(path, "utf8");
    const key = `runtime-profile:${canonicalPragmaResourceRef(runtime)}`;
    expect((await a.service.deleteRemote(key)).status).toBe("ready");
    // Git has committed the deletion, but the old local checkpoint survived the crash.
    await writeFile(path, previousState);
    await append(a.stores, knowledge.id, "# Unpublished edit");
    const head = await git.head();
    const recovered = await a.restart().deleteRemote(key);
    expect(recovered.status, recovered.error).toBe("ready");
    expect(recovered.items.some((item) => item.key === key)).toBe(false);
    expect(await git.head()).toBe(head);
    expect((await a.restart().overview()).items.some((item) => item.key === key)).toBe(false);
    const state = JSON.parse(await readFile(path, "utf8"));
    expect(state.bases[key]).toBeUndefined();
    expect(state).not.toHaveProperty("ignoredRemote");
  });

  it("automatically deletes a shared dependency graph without per-resource decisions", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const first = resources();
    const expert = first.find((resource) => resource.kind === "Expert")!;
    const flow = first.find((resource) => resource.kind === "Flow")!;
    const otherExpert = {
      ...expert,
      metadata: { ...expert.metadata, id: "2xddvess309a6gme", name: "Writer B" },
    };
    const otherFlow = structuredClone(flow);
    otherFlow.metadata.id = "31e73vjvctx49gkq";
    otherFlow.metadata.name = "Release B";
    otherFlow.spec.graph.steps["finish"]!.expert = { ref: "expert:2xddvess309a6gme" };
    const original = [...first, otherExpert, otherFlow];
    await a.layouts.save(initialLayout);
    await a.layouts.save({ ...initialLayout, flowId: otherFlow.metadata.id });
    await a.project.publish({ expectedRevision: 0, resources: original });
    expect((await a.service.configure(configuration)).status).toBe("ready");
    await a.project.apply({
      baseRevision: (await a.project.get()).revision,
      upserts: [],
      removals: original.map(canonicalPragmaResourceRef),
    });
    const keys = [
      "flow:flow:t1e73vjvctx49gkq",
      "expert:expert:1xddvess309a6gme",
      "runtime-profile:runtime-profile:zdkgs0fde4xt00vr",
    ];
    for (const service of [a.service, a.restart()]) {
      const ignored = await service.refresh();
      expect(ignored.status, ignored.error).toBe("ready");
      expect(ignored.items).toHaveLength(7);
      expect(ignored.items.every((item) => item.status === "pending")).toBe(true);
      expect((await a.project.get()).resources).toEqual([]);
    }

    // Reproduce conflict state persisted by the old dependency propagation.
    const statePath = join(a.root, "state", "asset-sync", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    await writeFile(statePath, JSON.stringify({ ...state, conflicts: keys.slice(0, 2) }));
    const service = a.restart();
    const removed = await service.sync();
    expect(removed.status, removed.error).toBe("ready");
    expect(removed.items).toEqual([]);
    expect((await a.project.get()).resources).toEqual([]);
    expect((await a.restart().refresh()).items).toEqual([]);
    const checkout = join(git.root, "inspect-deleted-graph");
    await exec("git", ["clone", git.bare, checkout]);
    expect((await readSyncRepository(checkout, true)).size).toBe(0);
  });

  it("isolates a referenced deletion conflict while publishing independent local changes", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const original = resources();
    // Edit instructions so this scenario does not also rename the derived RuntimeProfile.
    const knowledge = await addKnowledge(a.stores, "Independent docs");
    await a.project.publish({ expectedRevision: 0, resources: original });
    await a.service.configure(configuration);
    const b = device(join(git.root, "b"));
    await b.service.configure(configuration);
    await a.project.apply({
      baseRevision: (await a.project.get()).revision,
      upserts: [],
      removals: original.map(canonicalPragmaResourceRef),
    });
    await append(a.stores, knowledge.id, "# Independent local change");
    const remoteHead = await b.project.get();
    const expert = remoteHead.resources.find((resource) => resource.kind === "Expert")!;
    await b.project.apply({
      baseRevision: remoteHead.revision,
      upserts: [
        { ...expert, spec: { ...expert.spec, instructions: "Remote edited instructions" } },
      ],
    });
    await b.service.sync();
    const result = await a.service.sync();
    expect(result.status, result.error).toBe("conflict");
    expect(result.error).toBeUndefined();
    expect(result.items.find((item) => item.key === `knowledge:${knowledge.id}`)?.status).toBe(
      "synced",
    );
    const runtimeKey = "runtime-profile:runtime-profile:zdkgs0fde4xt00vr";
    expect(result.items.find((item) => item.key === runtimeKey)).toMatchObject({
      status: "conflict",
    });
    expect(result.items.find((item) => item.key === runtimeKey)?.message).toContain("Writer");
    const checkout = join(git.root, "inspect-partial-sync");
    await exec("git", ["clone", git.bare, checkout]);
    const items = await readSyncRepository(checkout, true);
    expect(items.has(runtimeKey)).toBe(true);
    expect(items.get(`knowledge:${knowledge.id}`)?.data).toMatchObject({
      files: [{ content: "# Independent local change" }],
    });
    const resolved = await a.service.resolve(
      `expert:${canonicalPragmaResourceRef(expert)}`,
      "local",
    );
    expect(resolved.status, resolved.error).toBe("ready");
    expect(resolved.items.some((item) => item.kind === "runtime-profile")).toBe(false);
  });

  it("publishes deletion of a whole local dependency graph in one synchronization", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const original = resources();
    await a.project.publish({ expectedRevision: 0, resources: original });
    await a.service.configure({ ...configuration });
    await a.project.apply({
      baseRevision: (await a.project.get()).revision,
      upserts: [],
      removals: original.map(canonicalPragmaResourceRef),
    });
    const removed = await a.service.sync();
    expect(removed.status, removed.error).toBe("ready");
    expect(removed.items).toEqual([]);
    expect((await a.restart().refresh()).items).toEqual([]);
  });

  it("keeps local resolution effective when the old Git expert references an ignored runtime", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const original = resources().filter((resource) => resource.kind !== "Flow");
    await a.project.publish({ expectedRevision: 0, resources: original });
    await a.service.configure(configuration);
    await a.project.apply({
      baseRevision: (await a.project.get()).revision,
      upserts: [],
      removals: original.map(canonicalPragmaResourceRef),
    });
    await a.service.refresh();
    const hook = join(git.bare, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const key = "expert:expert:1xddvess309a6gme";
    const failed = await a.service.resolve(key, "local");
    expect(failed.status).toBe("error");
    expect(failed.items.some((item) => item.key === key)).toBe(true);
    await rm(hook);
    const resolved = await a.restart().resolve(key, "local");
    expect(resolved.status, resolved.error).toBe("ready");
    expect(resolved.items.some((item) => item.key === key)).toBe(false);
    expect(resolved.items).toEqual([]);
    expect((await a.project.get()).resources).toEqual([]);
    expect((await a.restart().refresh()).items.some((item) => item.key === key)).toBe(false);
  });

  it.each([false, true])(
    "synchronizes historical Knowledge Git metadata safely (interrupted restore: %s)",
    async (interruptRestore) => {
      const git = await fixture();
      const a = device(join(git.root, "a"));
      const knowledge = await addKnowledge(a.stores, "Historical docs");
      const root = await a.stores.filesPath(knowledge.id);
      await mkdir(join(root, ".git", "empty"), { recursive: true });
      await writeFile(join(root, ".git", "internal.md"), "Private Git metadata\n");
      await mkdir(join(root, "nested", ".GIT"), { recursive: true });
      await writeFile(join(root, "nested", ".GIT", "internal.md"), "Nested metadata\n");
      await mkdir(join(root, "linked"));
      await writeFile(join(root, "linked", ".git"), "gitdir: /private/metadata\n");
      await a.stores.createFile(knowledge.id, "visible.md", "Visible knowledge\n");
      const historical = await a.stores.getSnapshot(knowledge.id);
      await expect(
        appendTransferredKnowledge(
          a.stores,
          {
            storeId: knowledge.id,
            baseRevision: historical.revision,
            baseSnapshotHash: historical.snapshotHash,
            snapshotHash: "0".repeat(64),
            files: [],
            directories: [],
            summary: "Invalid hash",
          },
          "sync",
        ),
      ).rejects.toThrow("declared hash");
      const configured = await a.service.configure(configuration);
      expect(configured.status, configured.error).toBe("ready");
      expect(await a.stores.getSnapshot(knowledge.id)).toEqual(historical);

      const checkout = join(git.root, "edit");
      await exec("git", ["clone", git.bare, checkout]);
      const metadataPath = `pragma-sync/knowledge-bases/${knowledge.id}/metadata.yaml`;
      const metadata = await readFile(join(checkout, metadataPath), "utf8");
      expect(metadata.toLowerCase()).not.toContain(".git");
      const tracked = (await exec("git", ["-C", checkout, "ls-files"])).stdout;
      expect(tracked.toLowerCase()).not.toContain(".git");
      const head = await git.head();
      const unchanged = await a.service.sync();
      expect(unchanged.status, unchanged.error).toBe("ready");
      expect(await git.head()).toBe(head);
      expect((await a.stores.getSnapshot(knowledge.id)).revision).toBe(historical.revision);

      const b = device(join(git.root, "b"));
      const imported = await b.service.configure(configuration);
      expect(imported.status, imported.error).toBe("ready");
      expect((await b.stores.getSnapshot(knowledge.id)).files.map((file) => file.id)).toEqual([
        "guide.md",
        "visible.md",
      ]);

      await writeFile(
        join(checkout, `pragma-sync/knowledge-bases/${knowledge.id}/files/guide.md`),
        "Remote edit\n",
      );
      await exec("git", ["-C", checkout, "commit", "-am", "Edit knowledge"]);
      await exec("git", ["-C", checkout, "push"]);
      if (interruptRestore) {
        const append = a.stores.appendSnapshot.bind(a.stores);
        vi.spyOn(a.stores, "appendSnapshot").mockImplementationOnce(async (...args) => {
          await append(...args);
          throw new Error("Interrupted after durable Knowledge update");
        });
        expect((await a.service.sync()).status).toBe("error");
      }
      const restored = await a.restart().sync();
      expect(restored.status, restored.error).toBe("ready");
      const updated = await a.stores.getSnapshot(knowledge.id);
      expect(updated.revision).toBe(historical.revision + 1);
      expect(updated.files.find((file) => file.id === "guide.md")?.content).toBe("Remote edit\n");
      expect(updated.files.filter((file) => file.id.toLowerCase().includes(".git"))).toEqual(
        historical.files.filter((file) => file.id.toLowerCase().includes(".git")),
      );
      expect(updated.directories).toEqual(historical.directories);
      expect(await a.stores.getSnapshot(knowledge.id, historical.revision)).toEqual(historical);
      const syncedHead = await git.head();
      expect((await a.restart().sync()).status).toBe("ready");
      expect(await git.head()).toBe(syncedHead);
      expect((await a.stores.getSnapshot(knowledge.id)).revision).toBe(updated.revision);
      if (!interruptRestore) {
        await b.service.configure({ ...configuration });
        await b.stores.remove(knowledge.id);
        expect((await b.service.sync()).status).toBe("ready");
        const deleted = await a.restart().sync();
        expect(deleted.status, deleted.error).toBe("ready");
        expect(await a.stores.exists(knowledge.id)).toBe(false);
      }
    },
  );
  it.each(["skill", "mcp_server"] as const)(
    "removes all %s bindings on deletion and synchronizes the deletion",
    async (kind) => {
      const git = await fixture();
      const a = device(join(git.root, "a"));
      const skill =
        kind === "skill"
          ? await addSkill(a.capabilities, a.root)
          : await a.capabilities.create({
              definition: {
                kind: "mcp_server",
                name: "audit",
                description: "Audit code",
                connection: {
                  transport: "stdio",
                  command: "search",
                  args: [],
                  env: {},
                  secretEnv: {},
                },
                tools: [],
                timeoutMs: 30_000,
              },
              credentials: {},
            });
      const bindings = (["project-expert", "default-agent-option"] as const).map((owner) =>
        createDesktopCapabilityResource({
          owner,
          capabilityId: skill.manifest.id,
          name: `audit ${owner}`,
          description: "Audit code",
        }),
      );
      const snapshot = await a.project.get();
      await a.project.apply({ baseRevision: snapshot.revision, upserts: bindings });
      const configured = await a.service.configure({ ...configuration });
      expect(configured.status, configured.error).toBe("ready");

      await a.capabilities.remove(skill.manifest.id);

      expect(await a.capabilities.exists(skill.manifest.id)).toBe(false);
      expect((await a.project.get()).resources).toEqual([]);
      const synced = await a.service.sync();
      expect(synced.status, synced.error).toBe("ready");
      expect(synced.items).toEqual([]);
      const files = (
        await exec("git", ["--git-dir", git.bare, "ls-tree", "-r", "--name-only", "main"])
      ).stdout;
      expect(files).not.toContain(`skills/${skill.manifest.id}/`);
      expect(files).not.toContain(`capability-definitions/${skill.manifest.id}.yaml`);
      for (const binding of bindings)
        expect(files).not.toContain(`${binding.metadata.id}.pragma.yaml`);
    },
  );

  it("rejects deleting a Capability used by a persisted Expert", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const skill = await addSkill(a.capabilities, a.root);
    const binding = createDesktopCapabilityResource({
      owner: "project-expert",
      capabilityId: skill.manifest.id,
      name: "audit",
    });
    const expert = resources().find((resource) => resource.kind === "Expert")!;
    if (expert.kind !== "Expert") throw new Error("Expected Expert");
    expert.spec.capabilities = [{ ref: canonicalPragmaResourceRef(binding), kind: "skill" }];
    const snapshot = await a.project.get();
    await a.project.apply({
      baseRevision: snapshot.revision,
      upserts: [
        binding,
        ...resources().filter((resource) => resource.kind === "RuntimeProfile"),
        expert,
      ],
    });
    await expect(a.capabilities.remove(skill.manifest.id)).rejects.toMatchObject({
      code: "capability_referenced",
    });
    expect(await a.capabilities.exists(skill.manifest.id)).toBe(true);
    expect((await a.project.get()).revision).toBe(snapshot.revision + 1);
  });

  it.each([false, true])(
    "automatically repairs an internal Context mapping with real stores and restart=%s",
    async (interrupt) => {
      const git = await fixture();
      const a = device(join(git.root, "a"), interrupt ? "project" : false);
      const knowledge = await addKnowledge(a.stores, "snipe_develop");
      const initialBinding = createDesktopContextResource({
        owner: "project-expert",
        storeId: knowledge.id,
      });
      const binding = {
        ...initialBinding,
        futurePolicy: { entries: [{ preserve: true }] },
        metadata: { ...initialBinding.metadata, futureSource: "remote" },
      };
      const head = await a.project.get();
      await a.project.apply({ baseRevision: head.revision, upserts: [binding] });
      expect((await a.service.configure(configuration)).status).toBe("ready");
      const before = await a.stores.getSnapshot(knowledge.id);
      const beforeStore = await a.stores.get(knowledge.id);
      const mounted = await a.project.get();
      await a.project.remove({
        baseRevision: mounted.revision,
        ref: canonicalPragmaResourceRef(binding),
      });
      const statePath = join(a.root, "state", "asset-sync", "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      const key = `knowledge:${canonicalPragmaResourceRef(binding)}`;
      await writeFile(statePath, JSON.stringify(state));
      expect((await a.service.overview()).items.some((item) => item.key === key)).toBe(false);
      const first = await a.service.automatic();
      expect(first.status, first.error).toBe(interrupt ? "error" : "ready");
      const published = await a.project.get();
      const completed = await a.restart().automatic();
      expect(completed.status, completed.error).toBe("ready");
      expect((await a.project.get()).revision).toBe(published.revision);
      expect((await a.project.get()).resources.map(canonicalPragmaResourceRef)).toEqual([
        canonicalPragmaResourceRef(binding),
      ]);
      expect(completed.items.find((item) => item.key === key)?.status).toBe("synced");
      expect((await a.project.get()).resources[0]).toMatchObject({
        futurePolicy: { entries: [{ preserve: true }] },
        metadata: { futureSource: "remote" },
      });
      expect(await a.stores.getSnapshot(knowledge.id)).toEqual(before);
      expect(await a.stores.get(knowledge.id)).toEqual(beforeStore);
    },
  );

  it("removes Knowledge bindings before authority deletion and retries an interrupted removal", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const knowledge = await addKnowledge(a.stores, "Knowledge");
    const binding = createDesktopContextResource({
      owner: "project-expert",
      storeId: knowledge.id,
    });
    const snapshot = await a.project.get();
    await a.project.apply({ baseRevision: snapshot.revision, upserts: [binding] });
    expect((await a.service.configure({ ...configuration })).status).toBe("ready");
    let interrupted = false;
    const stores = createContextStoreStore({
      storesPath: join(a.root, "data", "context-stores"),
      project: a.project,
      trashItem: async (path) => {
        if (!interrupted) {
          interrupted = true;
          throw new Error("Interrupted removal");
        }
        await rm(path, { recursive: true });
      },
    });
    await expect(stores.remove(knowledge.id)).rejects.toThrow("Interrupted removal");
    expect(await stores.exists(knowledge.id)).toBe(true);
    expect((await a.project.get()).resources).toEqual([]);
    await stores.remove(knowledge.id);
    expect(await stores.exists(knowledge.id)).toBe(false);
    const synced = await a.service.sync();
    expect(synced.status, synced.error).toBe("ready");
    expect(synced.items).toEqual([]);
  });

  it.each(["expert", "team", "system"] as const)(
    "blocks Knowledge deletion referenced by a %s",
    async (owner) => {
      const git = await fixture();
      const a = device(join(git.root, "a"));
      const knowledge = await addKnowledge(a.stores, "Knowledge");
      const binding = createDesktopContextResource({
        owner: "project-expert",
        storeId: knowledge.id,
      });
      const dependencyResources = resources();
      const expert = dependencyResources.find((resource) => resource.kind === "Expert")!;
      if (expert.kind !== "Expert") throw new Error("Expected Expert");
      const context = {
        ref: canonicalPragmaResourceRef(binding),
        namespace: "knowledge",
        required: true,
      };
      if (owner !== "team") expert.spec.contextStores = [context];
      const team: PragmaResource = {
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
          coordinator: { ref: canonicalPragmaResourceRef(expert) },
          members: [{ ref: canonicalPragmaResourceRef(expert) }],
          contextStores: [{ ...context, visibility: { mode: "all" } }],
          delegation: {
            permissions: { interact: {} },
            maxConcurrency: 2,
            maxDepth: 2,
            runtimes: {},
          },
        },
      };
      const snapshot = await a.project.get();
      await a.project.apply({
        baseRevision: snapshot.revision,
        upserts:
          owner === "system"
            ? [binding]
            : [binding, ...dependencyResources, ...(owner === "team" ? [team] : [])],
      });
      const stores =
        owner === "system"
          ? createContextStoreStore({
              storesPath: join(a.root, "data", "context-stores"),
              project: a.project,
              externalResources: () => [expert],
            })
          : a.stores;
      await expect(stores.remove(knowledge.id)).rejects.toMatchObject({
        code: "expert_referenced",
      });
      expect(await stores.exists(knowledge.id)).toBe(true);
      expect(
        (await a.project.get()).resources.some(
          (resource) =>
            canonicalPragmaResourceRef(resource) === canonicalPragmaResourceRef(binding),
        ),
      ).toBe(true);
    },
  );

  it("repairs historical unreferenced bindings without deleting unavailable assets", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const deletedId = "0123456789abcdef";
    const deleted = createDesktopCapabilityResource({
      owner: "project-expert",
      capabilityId: deletedId,
      name: "Deleted capability",
    });
    const skill = await addSkill(a.capabilities, a.root);
    const unavailable = createDesktopCapabilityResource({
      owner: "project-expert",
      capabilityId: skill.manifest.id,
      name: "audit",
    });
    const deletedKnowledge = createDesktopContextResource({
      owner: "project-expert",
      storeId: "f13af121-439b-4bad-8fe4-8b7dc27554d3",
    });
    const knowledge = await addKnowledge(a.stores, "Unreadable Knowledge");
    const unavailableKnowledge = createDesktopContextResource({
      owner: "project-expert",
      storeId: knowledge.id,
    });
    const snapshot = await a.project.get();
    await a.project.apply({
      baseRevision: snapshot.revision,
      upserts: [deleted, unavailable, deletedKnowledge, unavailableKnowledge],
    });
    // list() omits unreadable persisted assets. Their bindings must remain diagnosable.
    await writeFile(
      join(a.root, "data", "capabilities", skill.manifest.id, "capability.json"),
      "{}",
    );
    await writeFile(join(a.root, "data", "context-stores", knowledge.id, "store.json"), "{}");
    const overview = await a.service.configure(configuration);
    expect(
      overview.items.some(
        (item) => item.key === `capability:${canonicalPragmaResourceRef(deleted)}`,
      ),
    ).toBe(false);
    expect(
      overview.items.find(
        (item) => item.key === `capability:${canonicalPragmaResourceRef(unavailable)}`,
      )?.status,
    ).toBe("error");
    expect((await a.project.get()).resources).toEqual([unavailable, unavailableKnowledge]);
    expect(
      overview.items.some(
        (item) => item.key === `knowledge:${canonicalPragmaResourceRef(deletedKnowledge)}`,
      ),
    ).toBe(false);
    expect(
      overview.items.find(
        (item) => item.key === `knowledge:${canonicalPragmaResourceRef(unavailableKnowledge)}`,
      )?.status,
    ).toBe("error");
    expect(await a.stores.exists(knowledge.id)).toBe(true);
    expect(await a.capabilities.exists(skill.manifest.id)).toBe(true);
    expect(
      (await a.service.overview()).items.some((item) => item.name === "Deleted capability"),
    ).toBe(false);
  });

  it("restores Knowledge, binary Skill and an unreferenced non-Skill capability with original identities", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const b = device(join(git.root, "b"));
    const knowledge = await addKnowledge(a.stores, "团队规范");
    const skill = await addSkill(a.capabilities, a.root, true);
    const capability = await a.capabilities.create({
      definition: {
        kind: "mcp_server",
        name: "Unreferenced search",
        description: "Search",
        connection: { transport: "stdio", command: "search", args: [], env: {}, secretEnv: {} },
        tools: [],
        timeoutMs: 30_000,
      },
      credentials: { token: "LOCAL-SECRET" },
    });
    expect((await a.service.configure(configuration)).status).toBe("ready");
    const head = await git.head();
    expect((await a.service.sync()).status).toBe("ready");
    expect(await git.head()).toBe(head);
    const restored = await b.service.configure(configuration);
    expect(restored.status, restored.error).toBe("ready");
    expect((await b.stores.list())[0]?.id).toBe(knowledge.id);
    expect((await b.stores.getSnapshot(knowledge.id)).files).toEqual(
      (await a.stores.getSnapshot(knowledge.id)).files,
    );
    expect((await b.stores.getSnapshot(knowledge.id)).directories).toContain("empty");
    expect((await b.capabilities.get(capability.manifest.id)).definition).toEqual(
      capability.definition,
    );
    const skillRoot = await b.capabilities.skillFilesPath(skill.manifest.id, 1);
    expect(await readFile(join(skillRoot, "references", "sample.bin"))).toEqual(
      Buffer.from([0, 255, 128]),
    );
    expect((await b.capabilities.get(skill.manifest.id)).definition).toMatchObject({
      executablePaths: ["scripts/check.mjs", "scripts/check.py", "scripts/check.sh"],
    });
    expect(await readFile(join(skillRoot, "scripts/check.py"), "utf8")).toBe(
      "raise RuntimeError('must not execute')\n",
    );
    expect(await readFile(join(skillRoot, "scripts/check.sh"), "utf8")).toBe("#!/bin/sh\nexit 1\n");
    expect(await readFile(join(skillRoot, "requirements.txt"), "utf8")).toBe("requests\n");
    expect(await b.credentials.get(capability.manifest.id, "token")).toBeUndefined();
    const tree = (await exec("git", ["--git-dir", git.bare, "ls-tree", "-r", "main"])).stdout;
    expect(tree).toContain("100755");
    expect(tree).not.toContain("pragma-core-assets.json");
    const definition = (
      await exec("git", [
        "--git-dir",
        git.bare,
        "show",
        `main:pragma-sync/capability-definitions/${capability.manifest.id}.yaml`,
      ])
    ).stdout;
    expect(definition).not.toContain("LOCAL-SECRET");
    const before = await b.stores.getSnapshot(knowledge.id);
    await b.service.sync();
    expect((await b.stores.getSnapshot(knowledge.id)).revision).toBe(before.revision);
    const beforeCapability = (await b.capabilities.get(capability.manifest.id)).manifest
      .latestRevision;
    await b.credentials.setMany(capability.manifest.id, { token: "B-LOCAL-SECRET" });
    if (capability.definition.kind === "skill") throw new Error("Expected MCP definition");
    await a.capabilities.update({
      id: capability.manifest.id,
      baseRevision: capability.manifest.latestRevision,
      definition: { ...capability.definition, description: "Updated" },
      credentials: {},
    });
    await a.service.sync();
    await b.service.refresh();
    expect(await b.credentials.get(capability.manifest.id, "token")).toBe("B-LOCAL-SECRET");
    expect((await b.capabilities.get(capability.manifest.id)).manifest.latestRevision).toBe(
      beforeCapability + 1,
    );
  });
  it("derives Skill descriptions consistently across legacy restore and incremental script updates", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const b = device(join(git.root, "b"));
    const skill = await addSkill(a.capabilities, a.root);
    const configured = await a.service.configure(configuration);
    expect(configured.status, configured.error).toBe("ready");
    const checkout = join(git.root, "editor");
    await exec("git", ["clone", git.bare, checkout]);
    const prefix = join(checkout, "pragma-sync");
    const metadataPath = join(prefix, "skills", skill.manifest.id, "metadata.yaml");
    const entryPath = join(prefix, "skills", skill.manifest.id, "files", "SKILL.md");
    const scriptPath = join(prefix, "skills", skill.manifest.id, "files", "scripts", "check.mjs");
    const publishEdit = async (summary: string) => {
      await exec("git", ["-C", checkout, "add", "--all"]);
      await exec("git", ["-C", checkout, "commit", "-m", summary]);
      await exec("git", ["-C", checkout, "push"]);
    };
    // An actual old-format snapshot may contain an independently edited directory description.
    await writeFile(join(prefix, "sync.yaml"), "schemaVersion: pragma.asset-sync-repository/v1\n");
    await writeFile(
      metadataPath,
      formatPragmaYaml({
        id: skill.manifest.id,
        name: "audit",
        description: "Legacy directory annotation",
        entryPath: "SKILL.md",
      }),
    );
    await publishEdit("Edit legacy metadata description only");
    const restored = await b.service.configure(configuration);
    expect(restored.status, restored.error).toBe("ready");
    expect((await b.capabilities.get(skill.manifest.id)).definition).toMatchObject({
      description: "Audit code",
    });
    const metadataOnly = await a.service.refresh();
    expect(metadataOnly.status, metadataOnly.error).toBe("ready");
    expect((await a.capabilities.get(skill.manifest.id)).manifest.latestRevision).toBe(1);

    const script = "export const check = 2;\n";
    await writeFile(scriptPath, script);
    await publishEdit("Update scripts while legacy metadata differs");
    for (const current of [a, b]) {
      const refreshed = await current.service.refresh();
      expect(refreshed.status, refreshed.error).toBe("ready");
      const published = await current.capabilities.get(skill.manifest.id);
      expect(published.manifest.latestRevision).toBe(2);
      expect(published.definition).toMatchObject({ description: "Audit code" });
      const root = await current.capabilities.skillFilesPath(skill.manifest.id, 2);
      expect(await readFile(join(root, "scripts/check.mjs"), "utf8")).toBe(script);
      expect(await readFile(join(root, "SKILL.md"), "utf8")).toContain("description: Audit code");
    }
    const description = "Updated description from SKILL.md";
    await writeFile(
      entryPath,
      `---\nname: audit\ndescription: ${description}\n---\n\nAudit changes.\n`,
    );
    await publishEdit("Change the authoritative description without editing the stale cache");
    for (const current of [a, b]) {
      const refreshed = await current.service.refresh();
      expect(refreshed.status, refreshed.error).toBe("ready");
      expect((await current.capabilities.get(skill.manifest.id)).definition).toMatchObject({
        description,
      });
      expect((await current.capabilities.get(skill.manifest.id)).manifest.latestRevision).toBe(3);
    }
    const head = await git.head();
    const synced = await b.service.sync();
    expect(synced.status, synced.error).toBe("ready");
    expect(await git.head()).toBe(head);
    expect((await b.capabilities.get(skill.manifest.id)).manifest.latestRevision).toBe(3);
  });
  it("derives Skill descriptions for legacy bound resources without repeated changes", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const b = device(join(git.root, "b"));
    const skill = await addSkill(a.capabilities, a.root);
    // Before frontmatter became authoritative, valid definitions could store another description.
    const definitionPath = join(
      a.root,
      "data",
      "capabilities",
      skill.manifest.id,
      "revisions",
      "000001",
      "definition.json",
    );
    const legacyDefinition = JSON.stringify({
      ...skill.definition,
      description: "Legacy directory annotation",
    });
    await writeFile(definitionPath, legacyDefinition);
    const binding = createDesktopCapabilityResource({
      owner: "project-expert",
      capabilityId: skill.manifest.id,
      name: "audit",
      description: "Legacy directory annotation",
    });
    await a.project.apply({ baseRevision: (await a.project.get()).revision, upserts: [binding] });
    const configured = await a.service.configure(configuration);
    expect(configured.status, configured.error).toBe("ready");
    const checkout = join(git.root, "reader");
    await exec("git", ["clone", git.bare, checkout]);
    const remoteItems = await readSyncRepository(checkout, true);
    const bindingKey = `capability:${canonicalPragmaResourceRef(binding)}`;
    expect(remoteItems.get(bindingKey)?.data).toMatchObject({
      metadata: { description: "Audit code" },
    });
    const restored = await b.service.configure(configuration);
    expect(restored.status, restored.error).toBe("ready");
    const head = await git.head();
    for (const service of [a.service, b.service, a.restart(), b.restart()]) {
      const synced = await service.sync();
      expect(synced.status, synced.error).toBe("ready");
      expect(synced.items.find((entry) => entry.key === bindingKey)).toMatchObject({
        status: "synced",
      });
      expect(await git.head()).toBe(head);
    }
    for (const current of [a, b]) {
      const state = JSON.parse(
        await readFile(join(current.root, "state", "asset-sync", "state.json"), "utf8"),
      );
      expect(state.bases[bindingKey]).toBe(remoteItems.get(bindingKey)!.fingerprint);
      expect(state.remoteItems[bindingKey].fingerprint).toBe(
        remoteItems.get(bindingKey)!.fingerprint,
      );
    }
    expect((await a.capabilities.get(skill.manifest.id)).manifest.latestRevision).toBe(1);
    expect((await b.capabilities.get(skill.manifest.id)).manifest.latestRevision).toBe(1);
    expect(await readFile(definitionPath, "utf8")).toBe(legacyDefinition);
  });

  it("accepts remote file edits/additions/deletions and honors automatic upload configuration", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const knowledge = await addKnowledge(a.stores, "Docs");
    await a.service.configure(configuration);
    const checkout = join(git.root, "editor");
    await exec("git", ["clone", git.bare, checkout]);
    const files = join(checkout, "pragma-sync", "knowledge-bases", knowledge.id, "files");
    await rm(join(files, "guide.md"));
    await writeFile(join(files, "new.md"), "# Edited in Git\n");
    await exec("git", ["-C", checkout, "add", "--all"]);
    await exec("git", ["-C", checkout, "commit", "-m", "Edit knowledge"]);
    await exec("git", ["-C", checkout, "push"]);
    expect((await a.service.refresh()).status).toBe("ready");
    const snapshot = await a.stores.getSnapshot(knowledge.id);
    expect(snapshot.files.map((file) => file.id)).toEqual(["new.md"]);
    expect(snapshot.files[0]?.metadata).toMatchObject({ trigger: "manual", priority: "normal" });
    await append(a.stores, knowledge.id, "# Local pending\n");
    const head = await git.head();
    await a.service.automatic();
    expect(await git.head()).toBe(head);
    expect((await a.service.overview()).items.some((item) => item.status === "pending")).toBe(true);
    await a.service.configure({ ...configuration, autoPush: true });
    await append(a.stores, knowledge.id, "# Automatic upload\n");
    const enabledHead = await git.head();
    await a.service.automatic();
    expect(await git.head()).not.toBe(enabledHead);
  });
  it("migrates an interrupted v2 Skill restore with an independent cached description", async () => {
    const git = await fixture();
    const historical = join(import.meta.dirname, "migrations/fixtures/v2");
    const legacy = await readFile(join(historical, "skill-restore-journal.json"), "utf8");
    const journal = journalMigrationChain.upgrade(JSON.parse(legacy)).value;
    const item = journal.changes[0]!.remote!;
    const data = item.data as { files: { path: string; content: string; executable: boolean }[] };
    const id = item.key.slice("skill:".length);
    const b = device(join(git.root, "b"));
    const payload = join(git.root, "published-skill");
    for (const file of data.files) {
      const target = join(payload, file.path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, Buffer.from(file.content, "base64"));
      if (file.executable) await chmod(target, 0o700);
    }
    // The old operation stopped after publication. Revision equality must not republish it.
    await b.capabilities.importSkill({ sourcePath: payload }, { id });
    const seed = join(git.root, "legacy-skill-seed");
    await mkdir(seed);
    await exec("git", ["-C", seed, "init", "-b", "main"]);
    await writeSyncRepository(seed, new Map([[item.key, item]]));
    await exec("git", ["-C", seed, "commit", "-m", "Historical interrupted Skill restore"]);
    await exec("git", ["-C", seed, "push", git.bare, "main"]);
    const owner = join(b.root, "state/asset-sync");
    await mkdir(owner, { recursive: true });
    for (const name of ["settings.json", "state.json"])
      await writeFile(join(owner, name), await readFile(join(historical, name)));
    const path = join(owner, "restore-journal.json");
    await writeFile(path, legacy);
    const recovered = await b.restart().refresh();
    expect(recovered.status, recovered.error).toBe("ready");
    const restored = await b.capabilities.get(id);
    expect(restored.manifest.latestRevision).toBe(1);
    expect(restored.definition).toMatchObject({ description: "Updated review" });
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    const backups = join(owner, "migrations/backups");
    const names = await readdir(backups);
    const snapshots = await Promise.all(names.map((name) => readFile(join(backups, name), "utf8")));
    expect(snapshots).toContain(legacy);
    expect((await b.service.sync()).status).toBe("ready");
    expect((await b.capabilities.get(id)).manifest.latestRevision).toBe(1);
  });

  it("replays an interrupted restore without creating duplicate assets or revisions", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const b = device(join(git.root, "b"), true);
    const knowledge = await addKnowledge(a.stores, "Recover me");
    await a.service.configure(configuration);
    const failed = await b.service.configure(configuration);
    expect(failed.status).toBe("error");
    const first = await b.stores.getSnapshot(knowledge.id);
    expect(
      await readFile(join(b.root, "state", "asset-sync", "restore-journal.json"), "utf8"),
    ).toContain("pragma.asset-sync-journal/v4");
    const recovered = await b.restart().sync();
    expect(recovered.status, recovered.error).toBe("ready");
    expect((await b.stores.list()).length).toBe(1);
    expect((await b.stores.getSnapshot(knowledge.id)).revision).toBe(first.revision);
    await expect(
      readFile(join(b.root, "state", "asset-sync", "restore-journal.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["local", "remote", "restore"] as const)(
    "resolves an interrupted restore after local edits with %s and resumes synchronization",
    async (choice) => {
      const git = await fixture();
      const a = device(join(git.root, "a"));
      const b = device(join(git.root, "b"), true);
      const candidates = [
        await addKnowledge(a.stores, "Recover me"),
        await addKnowledge(a.stores, "Unrelated"),
      ];
      await a.service.configure(configuration);
      expect((await b.service.configure(configuration)).status).toBe("error");
      const knowledge = (await b.stores.list())[0]!;
      const unrelated = candidates.find((store) => store.id !== knowledge.id)!;
      await append(b.stores, knowledge.id, "# User changed after interruption\n");
      const restarted = b.restart();
      const result = await restarted.sync();
      expect(result.status, result.error).toBe("conflict");
      expect(result.items.find((item) => item.key === `knowledge:${knowledge.id}`)?.status).toBe(
        "conflict",
      );
      expect((await b.stores.getSnapshot(knowledge.id)).files[0]?.content).toBe(
        "# User changed after interruption\n",
      );
      expect((await b.stores.getSnapshot(unrelated.id)).files[0]?.content).toBe("# Original\n");
      await expect(
        readFile(join(b.root, "state/asset-sync/restore-journal.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      // Persisted conflict remains actionable across another restart and a pull.
      const service = b.restart();
      expect((await service.refresh()).status).toBe("conflict");
      const resolved =
        choice === "restore"
          ? await service.restore(`knowledge:${knowledge.id}`)
          : await service.resolve(`knowledge:${knowledge.id}`, choice);
      expect(resolved.status, resolved.error).toBe("ready");
      const expected = choice === "local" ? "# User changed after interruption\n" : "# Original\n";
      expect((await b.stores.getSnapshot(knowledge.id)).files[0]?.content).toBe(expected);
      expect((await service.sync()).status).toBe("ready");
      await a.service.refresh();
      expect((await a.stores.getSnapshot(knowledge.id)).files[0]?.content).toBe(expected);
    },
  );
  it("cancels unfinished restoration on configuration removal and permits reconfiguration", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const b = device(join(git.root, "b"), true);
    const knowledge = await addKnowledge(a.stores, "Recover me");
    await a.service.configure(configuration);
    expect((await b.service.configure(configuration)).status).toBe("error");
    await append(b.stores, knowledge.id, "# Keep my edit\n");
    await b.service.removeConfiguration();
    await expect(
      readFile(join(b.root, "state/asset-sync/restore-journal.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const service = b.restart();
    expect((await service.overview()).status).toBe("unconfigured");
    expect((await service.configure(configuration)).status).toBe("conflict");
    expect((await service.resolve(`knowledge:${knowledge.id}`, "local")).status).toBe("ready");
    expect((await b.stores.getSnapshot(knowledge.id)).files[0]?.content).toBe("# Keep my edit\n");
  });
  it.each(["configure", "interrupted-configuration"] as const)(
    "cancels the previous journal on %s source change without replaying its pending assets",
    async (mode) => {
      const git = await fixture();
      await exec("git", ["init", "--bare", "--initial-branch=main", join(git.root, "other.git")]);
      const a = device(join(git.root, "a"));
      const b = device(join(git.root, "b"), true);
      const candidates = [
        await addKnowledge(a.stores, "Applied stage"),
        await addKnowledge(a.stores, "Pending stage"),
      ];
      await a.service.configure(configuration);
      expect((await b.service.configure(configuration)).status).toBe("error");
      const knowledge = (await b.stores.list())[0]!;
      const pending = candidates.find((store) => store.id !== knowledge.id)!;
      await append(b.stores, knowledge.id, "# Keep my edit\n");
      const selected = { ...configuration, remote: "ssh://git@pragma.test/other.git" };
      if (mode === "interrupted-configuration") {
        // Model a crash after changing settings but before retiring the previous journal.
        await writeFile(
          join(b.root, "state/asset-sync/settings.json"),
          JSON.stringify({
            schemaVersion: "pragma.asset-sync-settings/v2",
            ...selected,
          }),
        );
      }
      const switched =
        mode === "configure" ? await b.service.configure(selected) : await b.restart().sync();
      expect(switched.status, switched.error).toBe("ready");
      expect((await b.stores.list()).map((store) => store.id)).toEqual([knowledge.id]);
      expect((await b.stores.getSnapshot(knowledge.id)).files[0]?.content).toBe("# Keep my edit\n");
      await expect(
        readFile(join(b.root, "state/asset-sync/restore-journal.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const service = b.restart();
      expect((await service.sync()).status).toBe("ready");
      expect((await service.configure(configuration)).status).toBe("conflict");
      expect((await b.stores.getSnapshot(pending.id)).files[0]?.content).toBe("# Original\n");
      expect((await service.resolve(`knowledge:${knowledge.id}`, "local")).status).toBe("ready");
    },
  );
  it("retains successful incoming restoration when an outgoing push fails", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const b = device(join(git.root, "b"));
    const remoteKnowledge = await addKnowledge(a.stores, "Remote");
    await a.service.configure(configuration);
    const localKnowledge = await addKnowledge(b.stores, "Local");
    const hook = join(git.bare, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o700);
    expect((await b.service.configure(configuration)).status).toBe("error");
    const restored = await b.stores.getSnapshot(remoteKnowledge.id);
    expect((await b.stores.list()).length).toBe(2);
    await rm(hook);
    const retried = await b.restart().sync();
    expect(retried.status, retried.error).toBe("ready");
    expect((await b.stores.getSnapshot(remoteKnowledge.id)).revision).toBe(restored.revision);
    const checkout = join(git.root, "verify");
    await exec("git", ["clone", git.bare, checkout]);
    expect(
      await readFile(
        join(checkout, "pragma-sync", "knowledge-bases", localKnowledge.id, "metadata.yaml"),
        "utf8",
      ),
    ).toContain("Local");
  });
  it("resolves Flow and layout as one asset while unrelated changes continue", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const b = device(join(git.root, "b"));
    const flow: PragmaResource = {
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
    };
    await a.project.publish({ expectedRevision: 0, resources: [flow] });
    const layout = {
      schemaVersion: "pragma.desktop-flow-layout/v2" as const,
      projectId: "studio",
      flowId: flow.metadata.id,
      nodes: { finish: { x: 1, y: 2 } },
      viewport: { x: 0, y: 0, zoom: 1 },
      updatedAt: new Date().toISOString(),
    };
    await a.layouts.save(layout);
    await a.service.configure(configuration);
    await b.service.configure(configuration);
    await a.project.publish({
      expectedRevision: 1,
      resources: [{ ...flow, metadata: { ...flow.metadata, name: "Remote release" } }],
    });
    await a.service.sync();
    await b.layouts.save({ ...layout, nodes: { finish: { x: 10, y: 20 } } });
    const unrelated = await addKnowledge(b.stores, "Independent");
    const conflict = await b.service.sync();
    expect(
      conflict.items.find((item) => item.key === `flow:flow:${flow.metadata.id}`)?.status,
    ).toBe("conflict");
    expect((await b.project.get()).resources[0]?.metadata.name).toBe("Release");
    expect(
      (await a.service.refresh()).items.some((item) => item.key === `knowledge:${unrelated.id}`),
    ).toBe(true);
    await b.service.resolve(`flow-layout:${flow.metadata.id}`, "remote");
    expect((await b.project.get()).resources[0]?.metadata.name).toBe("Remote release");
    expect(
      (await b.layouts.get({ projectId: "studio", flowId: flow.metadata.id }))?.nodes.finish,
    ).toEqual({ x: 1, y: 2 });
  });
  it("fails closed when an initialized empty repository loses its marker", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    await a.service.configure(configuration);
    const checkout = join(git.root, "edit");
    await exec("git", ["clone", git.bare, checkout]);
    await exec("git", ["-C", checkout, "rm", "pragma-sync/sync.yaml"]);
    await exec("git", ["-C", checkout, "commit", "-m", "Remove marker"]);
    await exec("git", ["-C", checkout, "push"]);
    expect((await a.service.refresh()).status).toBe("error");
  });
  it("fetches and recomputes after a competing ordinary push without losing either asset", async () => {
    const git = await fixture();
    let competingPush: (() => Promise<void>) | undefined;
    const a = device(join(git.root, "a"), false, async () => {
      const push = competingPush;
      competingPush = undefined;
      await push?.();
    });
    const b = device(join(git.root, "b"));
    await a.service.configure(configuration);
    await b.service.configure(configuration);
    const local = await addKnowledge(a.stores, "A");
    const competing = await addKnowledge(b.stores, "B");
    competingPush = async () => {
      expect((await b.service.sync()).status).toBe("ready");
    };
    const result = await a.service.sync();
    expect(result.status, result.error).toBe("ready");
    expect((await a.stores.list()).map((store) => store.id)).toContain(competing.id);
    await b.service.refresh();
    expect((await b.stores.list()).map((store) => store.id)).toContain(local.id);
    expect(
      (await exec("git", ["--git-dir", git.bare, "rev-list", "--count", "main"])).stdout.trim(),
    ).toBe("3");
  });
  it.each(["skill", "capability", "project"] as const)(
    "replays interrupted %s publication without duplicate revisions",
    async (stage) => {
      const git = await fixture();
      const a = device(join(git.root, "a"));
      const skill = await addSkill(a.capabilities, git.root);
      const capability = await a.capabilities.create({
        definition: {
          kind: "mcp_server",
          name: "Independent",
          description: "Tools",
          connection: {
            transport: "streamable-http",
            url: "https://example.test/mcp",
          },
          timeoutMs: 30_000,
          tools: [],
        },
        credentials: {},
      });
      const flow: PragmaResource = {
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
      };
      await a.project.publish({ expectedRevision: 0, resources: [flow] });
      await a.service.configure(configuration);
      const b = device(join(git.root, "b"), stage);
      expect((await b.service.configure(configuration)).status).toBe("error");
      expect((await b.restart().refresh()).status).toBe("ready");
      expect((await b.capabilities.get(skill.manifest.id)).manifest.latestRevision).toBe(1);
      expect((await b.capabilities.get(capability.manifest.id)).manifest.latestRevision).toBe(1);
      expect((await b.project.get()).revision).toBe(1);
      await expect(
        readFile(join(b.root, "state/asset-sync/restore-journal.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("preserves plugin configuration and blocks layouts when a dependency conflicts", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const knowledge = await addKnowledge(a.stores, "Docs");
    await a.project.publish({ expectedRevision: 0, resources: resources(knowledge.id) });
    await a.layouts.save(initialLayout);
    await a.service.configure(configuration);
    const b = device(join(git.root, "b"));
    const configured = await b.service.configure(configuration);
    expect(configured.status, configured.error).toBe("ready");
    expect(
      (await b.project.get()).resources.find((resource) => resource.kind === "Expert")?.spec,
    ).toMatchObject({
      plugins: [
        {
          ref: "plugin:example@1.0.0",
          config: { format: "markdown", options: { depth: 3 } },
          secretBindings: { token: "binding:example-token" },
        },
      ],
    });
    await append(a.stores, knowledge.id, "# Remote");
    await a.service.sync();
    await append(b.stores, knowledge.id, "# Local");
    await b.layouts.save({ ...initialLayout, nodes: { finish: { x: 10, y: 20 } } });
    const conflict = await b.service.sync();
    expect(conflict.items.find((item) => item.key === "flow-layout:t1e73vjvctx49gkq")?.status).toBe(
      "conflict",
    );
    await a.service.refresh();
    expect((await a.layouts.get(initialLayout))?.nodes.finish).toEqual({ x: 1, y: 2 });
  });
  it("replays canonicalized manual metadata after durable Knowledge creation", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const knowledge = await addKnowledge(a.stores, "Docs");
    await a.service.configure(configuration);
    const checkout = join(git.root, "edit");
    await exec("git", ["clone", git.bare, checkout]);
    const path = join(checkout, `pragma-sync/knowledge-bases/${knowledge.id}/metadata.yaml`);
    const meta = parsePragmaYaml(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(
      path,
      formatPragmaYaml({
        ...meta,
        name: " Docs ",
        description: "   ",
        directories: ["empty/deep"],
      }),
    );
    await exec("git", ["-C", checkout, "commit", "-am", "Edit metadata"]);
    await exec("git", ["-C", checkout, "push"]);
    const b = device(join(git.root, "b"), true);
    expect((await b.service.configure(configuration)).status).toBe("error");
    const restored = await b.restart().refresh();
    expect(restored.status, restored.error).toBe("ready");
    expect((await b.stores.list())[0]).toMatchObject({
      name: "Docs",
      description: "",
      contentRevision: 1,
    });
    expect((await b.stores.getSnapshot(knowledge.id)).directories).toEqual(["empty", "empty/deep"]);
  });
  it("preserves imported MCP definitions when verification discovers different tools", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const cap = await a.capabilities.create({
      definition: {
        kind: "mcp_server",
        name: "Tools",
        description: "Tools",
        connection: { transport: "streamable-http", url: "https://example.test/mcp" },
        tools: [],
        timeoutMs: 30_000,
      },
      credentials: {},
    });
    await a.service.configure(configuration);
    const b = device(
      join(git.root, "b"),
      "capability",
      undefined,
      undefined,
      async (definition) => ({
        definition:
          definition.kind === "mcp_server"
            ? {
                ...definition,
                tools: [
                  {
                    name: "observed",
                    description: "Discovered tool",
                    inputSchema: { type: "object", properties: {} },
                    schemaHash: "a".repeat(64),
                  },
                ],
              }
            : definition,
        health: { status: "ready", checkedAt: new Date().toISOString() },
      }),
    );
    expect((await b.service.configure(configuration)).status).toBe("error");
    const result = await b.restart().refresh();
    expect(result.status, result.error).toBe("ready");
    expect(await b.capabilities.get(cap.manifest.id)).toMatchObject({
      definition: cap.definition,
      manifest: { latestRevision: 1 },
      health: { status: "needs_attention", diagnostic: { code: "imported_definition_changed" } },
    });
    expect((await b.capabilities.get(cap.manifest.id)).manifest.activeRevision).toBeUndefined();
    if (cap.definition.kind === "skill") throw new Error("Expected MCP");
    await a.capabilities.update({
      id: cap.manifest.id,
      baseRevision: cap.manifest.latestRevision,
      definition: { ...cap.definition, description: "Updated definition" },
      credentials: {},
    });
    await a.service.sync();
    const updated = await b.service.refresh();
    expect(updated.status, updated.error).toBe("ready");
    expect(await b.capabilities.get(cap.manifest.id)).toMatchObject({
      definition: { ...cap.definition, description: "Updated definition" },
      manifest: { latestRevision: 2 },
      health: { status: "needs_attention" },
    });
  });
  it.each(["knowledge-delete", "capability-delete", "layout"] as const)(
    "preserves a concurrent user change during %s restore",
    async (kind) => {
      const git = await fixture();
      const a = device(join(git.root, "a"));
      const knowledge = await addKnowledge(a.stores, "Docs");
      const cap = await a.capabilities.create({
        definition: {
          kind: "mcp_server",
          name: "Tools",
          description: "Tools",
          connection: {
            transport: "streamable-http",
            url: "https://example.test/mcp",
            tokenCredentialRef: "token",
          },
          tools: [],
          timeoutMs: 30_000,
        },
        credentials: {},
      });
      await a.project.publish({ expectedRevision: 0, resources: resources() });
      await a.layouts.save(initialLayout);
      await a.service.configure({ ...configuration });
      let edit: (() => Promise<void>) | undefined;
      const b = device(join(git.root, "b"), false, undefined, async () => {
        const action = edit;
        edit = undefined;
        await action?.();
      });
      await b.service.configure(configuration);
      if (kind === "knowledge-delete") {
        const snapshot = await a.stores.getSnapshot(knowledge.id);
        await a.stores.remove(knowledge.id, {
          revision: snapshot.revision,
          snapshotHash: snapshot.snapshotHash,
        });
        edit = async () => append(b.stores, knowledge.id, "# User change");
      } else if (kind === "capability-delete") {
        await a.capabilities.remove(cap.manifest.id, cap.manifest.latestRevision);
        edit = async () => {
          const current = await b.capabilities.get(cap.manifest.id);
          if (current.definition.kind === "skill") throw new Error("Expected MCP");
          await b.capabilities.update({
            id: cap.manifest.id,
            baseRevision: current.manifest.latestRevision,
            definition: current.definition,
            credentials: { token: "Concurrent secret" },
          });
        };
      } else
        edit = async () => {
          await b.layouts.save({ ...initialLayout, nodes: { finish: { x: 99, y: 99 } } });
        };
      await a.layouts.save({ ...initialLayout, nodes: { finish: { x: 10, y: 20 } } });
      await a.service.sync();
      const result = await b.service.refresh();
      expect(result.status, result.error).toBe("conflict");
      if (kind === "knowledge-delete")
        expect((await b.stores.getSnapshot(knowledge.id)).files[0]?.content).toBe("# User change");
      else if (kind === "capability-delete") {
        expect((await b.capabilities.get(cap.manifest.id)).manifest.latestRevision).toBe(2);
        expect(await b.credentials.get(cap.manifest.id, "token")).toBe("Concurrent secret");
      } else expect((await b.layouts.get(initialLayout))?.nodes.finish).toEqual({ x: 99, y: 99 });
      const key =
        kind === "knowledge-delete"
          ? `knowledge:${knowledge.id}`
          : kind === "capability-delete"
            ? `capability:${cap.manifest.id}`
            : `flow-layout:${initialLayout.flowId}`;
      const resolved = await b.restart().resolve(key, "local");
      expect(resolved.status, resolved.error).toBe("ready");
      expect((await b.service.refresh()).status).toBe("ready");
      if (kind === "capability-delete")
        expect(await b.credentials.get(cap.manifest.id, "token")).toBe("Concurrent secret");
    },
  );
  it("keeps deletion versus remote edits conflicted while importing independent resources", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const knowledge = await addKnowledge(a.stores, "Docs");
    await a.service.configure(configuration);
    const b = device(join(git.root, "b"));
    await b.service.configure(configuration);
    const snapshot = await b.stores.getSnapshot(knowledge.id);
    await b.stores.remove(knowledge.id, {
      revision: snapshot.revision,
      snapshotHash: snapshot.snapshotHash,
    });
    await b.service.refresh();
    await append(a.stores, knowledge.id, "# Remote edit");
    await a.service.sync();
    const ignored = await b.service.refresh();
    expect(ignored.status, ignored.error).toBe("conflict");
    expect(ignored.items.find((item) => item.key === `knowledge:${knowledge.id}`)?.status).toBe(
      "conflict",
    );
    await a.project.publish({ expectedRevision: 0, resources: resources(knowledge.id) });
    const unrelated = await addKnowledge(a.stores, "Independent");
    await a.service.sync();
    const blocked = await b.service.refresh();
    expect(blocked.status, blocked.error).toBe("conflict");
    expect((await b.stores.list()).map((store) => store.id)).toEqual([unrelated.id]);
    expect((await b.project.get()).resources.some((resource) => resource.kind === "Expert")).toBe(
      false,
    );
    const restored = await b.service.restore(`knowledge:${knowledge.id}`);
    expect(restored.status, restored.error).toBe("ready");
    expect((await b.stores.getSnapshot(knowledge.id)).files[0]?.content).toBe("# Remote edit");
    expect((await b.project.get()).resources.some((resource) => resource.kind === "Expert")).toBe(
      true,
    );
  });
  it("replays updates with preserved unknown DSL fields and republishes them without duplicate revisions", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    await a.project.publish({
      expectedRevision: 0,
      resources: resources().map((resource) =>
        resource.kind === "Flow" ? { ...resource, futurePolicy: { retain: true } } : resource,
      ),
    });
    await a.service.configure(configuration);
    const b = device(join(git.root, "b"));
    await b.service.configure(configuration);
    const checkout = join(git.root, "edit");
    await exec("git", ["clone", git.bare, checkout]);
    const path = join(checkout, "pragma-sync/flows/t1e73vjvctx49gkq.pragma.yaml");
    const flow = parsePragmaYaml(await readFile(path, "utf8")) as Record<string, unknown>;
    delete flow["futurePolicy"];
    (flow["metadata"] as Record<string, unknown>)["name"] = "Renamed Flow";
    await writeFile(path, formatPragmaYaml(flow));
    await exec("git", ["-C", checkout, "commit", "-am", "Edit Flow"]);
    await exec("git", ["-C", checkout, "push"]);
    const apply = b.project.apply;
    let interrupted = false;
    b.project.apply = async (...args) => {
      const result = await apply(...args);
      if (!interrupted) {
        interrupted = true;
        throw new Error("Interrupted after compatible project update.");
      }
      return result;
    };
    const first = await b.service.sync();
    expect(first.status).toBe("error");
    const restored = await b.restart().sync();
    expect(restored.status, restored.error).toBe("ready");
    expect((await b.project.get()).revision).toBe(2);
    const yaml = (
      await exec("git", [
        "--git-dir",
        git.bare,
        "show",
        "main:pragma-sync/flows/t1e73vjvctx49gkq.pragma.yaml",
      ])
    ).stdout;
    expect(parsePragmaYaml(yaml)).toMatchObject({
      futurePolicy: { retain: true },
      metadata: { name: "Renamed Flow" },
    });
  });
});
