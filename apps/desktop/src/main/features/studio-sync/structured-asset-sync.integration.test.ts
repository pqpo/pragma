import type { WorkflowLayoutStore } from "../projects/workflow-layout-store.ts";
import type { CapabilityVerifier } from "../capabilities/capability-verification.ts";
import {
  createDesktopCapabilityResource,
  createDesktopContextResource,
} from "../../platform/bindings/desktop-bound-resource-policy.ts";
import { formatPragmaYaml, parsePragmaYaml } from "@pragma/interpreter";
import {
  canonicalPragmaResourceRef,
  PRAGMA_DSL_WRITE_API_VERSION,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createContextStoreStore,
  hashSnapshotContent,
  type ContextStoreStore,
} from "../context-stores/context-store-store.ts";
import {
  createPragmaProjectStore,
  type PragmaProjectStore,
} from "../projects/pragma-project-store.ts";
import { createWorkflowLayoutStore } from "../projects/workflow-layout-store.ts";
import { createCapabilityStore, type CapabilityStore } from "../capabilities/capability-store.ts";
import { createCapabilityCredentialStore } from "../capabilities/capability-credential-store.ts";
import {
  createCapabilityRevisionCoordinator,
  type CapabilityRevisionCoordinator,
} from "../capabilities/capability-revision-coordinator.ts";
import { createDesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import { createTestSecretStore } from "../credentials/test-secret-store.ts";
import { createCoreAssetSyncService } from "./core-asset-sync-service.ts";
import { readSyncRepository, writeSyncRepository } from "./asset-sync-repository.ts";
import { CoreAssetSyncItemSchema } from "../../../shared/contracts/index.ts";
import { appendTransferredKnowledge } from "../asset-transfer/asset-transfer-payloads.ts";

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
  const options = {
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
      name: "Runtime",
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
async function addSkill(capabilities: CapabilityStore, root: string) {
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
  await writeFile(join(sourcePath, "references", "sample.bin"), Buffer.from([0, 255, 128]));
  return await capabilities.importSkill({ sourcePath });
}

describe("structured asset sync with real Git and domain stores", { timeout: 60_000 }, () => {
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
      await writeSyncRepository(seed, new Map([[item.key, item]]));
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
      expect(state.schemaVersion).toBe("pragma.asset-sync-state/v2");
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
      upserts: [{ ...expert, metadata: { ...expert.metadata, name: "Writer remote edit" } }],
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
    expect(result.items.find((item) => item.key === runtimeKey)?.message).toContain(
      "Writer remote edit",
    );
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
    const skill = await addSkill(a.capabilities, a.root);
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
      executablePaths: ["scripts/check.mjs"],
    });
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
  it("synchronizes Skill description differences through export, restore and first publication", async () => {
    const git = await fixture();
    const a = device(join(git.root, "a"));
    const b = device(join(git.root, "b"));
    const skill = await addSkill(a.capabilities, a.root);
    const configured = await a.service.configure(configuration);
    expect(configured.status, configured.error).toBe("ready");
    const checkout = join(git.root, "editor");
    await exec("git", ["clone", git.bare, checkout]);
    const description = String.raw`Audit \ncode with \"quotes\"`;
    await writeFile(
      join(checkout, "pragma-sync", "skills", skill.manifest.id, "metadata.yaml"),
      formatPragmaYaml({
        id: skill.manifest.id,
        name: "audit",
        description,
        entryPath: "SKILL.md",
      }),
    );
    await exec("git", ["-C", checkout, "add", "--all"]);
    await exec("git", ["-C", checkout, "commit", "-m", "Edit Skill description"]);
    await exec("git", ["-C", checkout, "push"]);

    const restored = await b.service.configure(configuration);
    expect(restored.status, restored.error).toBe("ready");
    expect((await b.capabilities.get(skill.manifest.id)).definition).toMatchObject({
      description,
    });
    const root = await b.capabilities.skillFilesPath(skill.manifest.id, 1);
    expect(await readFile(join(root, "SKILL.md"), "utf8")).toContain("description: Audit code");
    const head = await git.head();
    const synced = await b.service.sync();
    expect(synced.status, synced.error).toBe("ready");
    expect(await git.head()).toBe(head);
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
    ).toContain("pragma.asset-sync-journal/v2");
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
