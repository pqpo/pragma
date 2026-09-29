import type { WorkflowLayoutStore } from "../projects/workflow-layout-store.ts";
import type { CapabilityVerifier } from "../capabilities/capability-verification.ts";
import { createDesktopContextResource } from "../../platform/bindings/desktop-bound-resource-policy.ts";
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
import { afterEach, describe, expect, it } from "vitest";
import {
  createContextStoreStore,
  hashSnapshotContent,
  type ContextStoreStore,
} from "../context-stores/context-store-store.ts";
import { createPragmaProjectStore } from "../projects/pragma-project-store.ts";
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

const exec = promisify(execFile);
const temporary: string[] = [];
const remote = "ssh://git@pragma.test/assets.git";
const configuration = { remote, branch: "main", autoPush: false, pushDeletions: false };
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
) {
  const stores = createContextStoreStore({ storesPath: join(root, "data", "context-stores") });
  const project = createPragmaProjectStore({ projectsPath: join(root, "data", "projects") });
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
  const importProject = interruptAfter(project, "apply", interruptCreate === "project");
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
    ).toContain("pragma.asset-sync-journal/v1");
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
            schemaVersion: "pragma.asset-sync-settings/v1",
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
      await a.service.configure({ ...configuration, pushDeletions: true });
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
  it("keeps deleted local assets ignored after remote edits and defers new dependents only", async () => {
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
    await b.service.sync();
    await append(a.stores, knowledge.id, "# Remote edit");
    await a.service.sync();
    const ignored = await b.service.refresh();
    expect(ignored.status, ignored.error).toBe("ready");
    expect(ignored.items.find((item) => item.key === `knowledge:${knowledge.id}`)?.status).toBe(
      "ignored_remote",
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
