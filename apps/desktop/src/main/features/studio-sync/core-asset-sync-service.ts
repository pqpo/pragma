import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  PRAGMA_MANAGEMENT_DESKTOP_CAPABILITY_ID,
  validatePortableSkillPackage,
} from "@pragma/built-in-agents";
import { withFileLock } from "@pragma/core";
import { SemanticResourceIdSchema } from "@pragma/shared";
import {
  canonicalPragmaResourceRef,
  PragmaForwardCompatibleResourceSchema,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import { z } from "zod";

import {
  CapabilityDefinitionSchema,
  CapabilityIdSchema,
  ContextStoreSnapshotSchema,
  ContextStoreIdSchema,
  CoreAssetSyncConfigurationSchema,
  CoreAssetSyncItemSchema,
  CoreAssetSyncOverviewSchema,
  CoreAssetSyncRepositorySchema,
  WorkflowLayoutSchema,
  type CoreAssetSyncConfiguration,
  type CoreAssetSyncItem,
  type CoreAssetSyncOverview,
  type DesktopRuntimeAvailability,
  type UpdateCoreAssetSyncConfiguration,
} from "../../../shared/contracts/index.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import { scanSkillWorkingTree } from "../capabilities/skill-revision-draft-store.ts";
import type { ContextStoreStore } from "../context-stores/context-store-store.ts";
import { hashSnapshotContent } from "../context-stores/context-store-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { WorkflowLayoutStore } from "../projects/workflow-layout-store.ts";
import { referencedPragmaResourceRefs } from "../projects/pragma-resource-references.ts";
import {
  classifyDesktopCapabilityResource,
  classifyDesktopContextResource,
} from "../../platform/bindings/desktop-bound-resource-policy.ts";

const execFileAsync = promisify(execFile);
const ROOT_FILE = "pragma-core-assets.json";
const MAX_REPOSITORY_BYTES = 150 * 1024 * 1024;
const SkillFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(2_000)
      .refine(
        (path) =>
          !path.startsWith("/") &&
          !path.includes("\\") &&
          path
            .split("/")
            .every(
              (segment) =>
                segment !== "" &&
                segment !== "." &&
                segment !== ".." &&
                segment.toLowerCase() !== ".git",
            ),
      ),
    content: z.string().max(128_000),
    executable: z.boolean(),
  })
  .strict();
const SkillDataSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    files: z.array(SkillFileSchema).min(1).max(1_000),
  })
  .strict();
const KnowledgeDataSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    directories: ContextStoreSnapshotSchema.shape.directories,
    files: ContextStoreSnapshotSchema.shape.files,
  })
  .strict();
const StateSchema = z
  .object({
    schemaVersion: z.literal("pragma.core-asset-sync-state/v1"),
    source: z.string(),
    bases: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)),
    remoteItems: z
      .record(
        z.string(),
        CoreAssetSyncItemSchema.pick({ kind: true, name: true, fingerprint: true }),
      )
      .default({}),
    ignoredRemote: z.array(z.string()),
    conflicts: z.array(z.string()),
    syncedAt: z.string().datetime().optional(),
  })
  .strict();
type SyncState = z.infer<typeof StateSchema>;
type ItemMap = Map<string, CoreAssetSyncItem>;

export interface CoreAssetSyncService {
  overview(): Promise<CoreAssetSyncOverview>;
  configure(input: UpdateCoreAssetSyncConfiguration): Promise<CoreAssetSyncOverview>;
  removeConfiguration(): Promise<void>;
  sync(): Promise<CoreAssetSyncOverview>;
  refresh(): Promise<CoreAssetSyncOverview>;
  resolve(key: string, choice: "local" | "remote"): Promise<CoreAssetSyncOverview>;
  restore(key: string): Promise<CoreAssetSyncOverview>;
  schedule(reason: string): void;
}

export function createCoreAssetSyncService(options: {
  readonly configurationPath: string;
  readonly statePath: string;
  readonly project: PragmaProjectStore;
  readonly layouts: WorkflowLayoutStore;
  readonly stores: ContextStoreStore;
  readonly capabilities: CapabilityStore;
  readonly getRuntimes: () => Promise<readonly DesktopRuntimeAvailability[]>;
  readonly warn?: (message: string, error: unknown) => void;
}): CoreAssetSyncService {
  let running = false;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let lastError: string | undefined;
  const readConfig = async (): Promise<CoreAssetSyncConfiguration | undefined> => {
    try {
      return CoreAssetSyncConfigurationSchema.parse(
        JSON.parse(await readFile(options.configurationPath, "utf8")),
      );
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  };
  const readState = async (source: string): Promise<SyncState> => {
    try {
      const stored = StateSchema.parse(JSON.parse(await readFile(options.statePath, "utf8")));
      if (stored.source === source) return stored;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return {
      schemaVersion: "pragma.core-asset-sync-state/v1",
      source,
      bases: {},
      remoteItems: {},
      ignoredRemote: [],
      conflicts: [],
    };
  };
  const writeState = async (state: SyncState): Promise<void> =>
    writeAtomic(options.statePath, StateSchema.parse(state));

  const collect = async (): Promise<ItemMap> => {
    const result: ItemMap = new Map();
    const add = (
      kind: CoreAssetSyncItem["kind"],
      id: string,
      name: string,
      data: unknown,
    ): void => {
      const key = `${kind}:${id}`;
      result.set(
        key,
        CoreAssetSyncItemSchema.parse({ key, kind, name, fingerprint: fingerprint(data), data }),
      );
    };
    const snapshot = await options.project.get();
    const resources = snapshot.resources.filter((resource) => {
      if (resource.kind === "Capability") {
        const binding = classifyDesktopCapabilityResource(resource);
        return binding !== undefined && binding.id !== PRAGMA_MANAGEMENT_DESKTOP_CAPABILITY_ID;
      }
      if (resource.kind === "ContextStore")
        return classifyDesktopContextResource(resource) !== undefined;
      return ["Expert", "ExpertTeam", "Flow", "RuntimeProfile"].includes(resource.kind);
    });
    for (const resource of resources) {
      const kind =
        resource.kind === "Expert"
          ? "expert"
          : resource.kind === "ExpertTeam"
            ? "team"
            : resource.kind === "Flow"
              ? "flow"
              : resource.kind === "RuntimeProfile"
                ? "runtime-profile"
                : resource.kind === "Capability"
                  ? "capability"
                  : "knowledge";
      const portable =
        resource.kind === "Expert"
          ? {
              ...resource,
              spec: {
                ...resource.spec,
                plugins: resource.spec.plugins.map((plugin) => ({ ref: plugin.ref })),
              },
            }
          : resource;
      add(kind, canonicalPragmaResourceRef(resource), resource.metadata.name, portable);
      if (resource.kind === "Flow") {
        const layout = await options.layouts.get({
          projectId: snapshot.projectId,
          flowId: resource.metadata.id,
        });
        if (layout !== null)
          add("flow-layout", resource.metadata.id, resource.metadata.name, {
            nodes: layout.nodes,
            viewport: layout.viewport,
          });
      }
    }
    for (const store of await options.stores.list()) {
      const storeSnapshot = await options.stores.getSnapshot(store.id);
      add("knowledge", store.id, store.name, {
        name: store.name,
        description: store.description,
        directories: storeSnapshot.directories,
        files: storeSnapshot.files,
      });
    }
    const referencedCapabilities = new Set(
      resources
        .flatMap((resource) =>
          resource.kind === "Capability" ? [classifyDesktopCapabilityResource(resource)?.id] : [],
        )
        .filter((id): id is string => id !== undefined),
    );
    for (const capability of await options.capabilities.list()) {
      if (capability.managedBy === "system") continue;
      const id = capability.manifest.id;
      if (capability.definition.kind !== "skill" && !referencedCapabilities.has(id)) continue;
      if (capability.definition.kind !== "skill") {
        add("capability", id, capability.definition.name, capability.definition);
        continue;
      }
      const root = await options.capabilities.skillFilesPath(
        id,
        capability.manifest.latestRevision,
      );
      const tree = await scanSkillWorkingTree(root, {
        ...(capability.definition.executablePaths === undefined
          ? {}
          : { executablePaths: new Set(capability.definition.executablePaths) }),
      });
      const files = await Promise.all(
        tree.entries.map(async (entry) => {
          const bytes = await readFile(join(root, entry.path));
          const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (content.includes("\0"))
            throw new Error(`Skill contains a binary file: ${entry.path}`);
          return { path: entry.path, content, executable: entry.executable };
        }),
      );
      add(
        "skill",
        id,
        capability.definition.name,
        SkillDataSchema.parse({
          name: capability.definition.name,
          description: capability.definition.description,
          files,
        }),
      );
    }
    return result;
  };

  const readiness = async (items: ItemMap): Promise<Map<string, string>> => {
    const unavailable = new Map<string, string>();
    const runtimes = await options.getRuntimes();
    const resources = [...items.values()]
      .filter(
        (item) =>
          ["expert", "team", "flow", "runtime-profile", "capability", "knowledge"].includes(
            item.kind,
          ) && item.key.includes(":", item.kind.length + 1),
      )
      .flatMap((item) => {
        const parsed = PragmaForwardCompatibleResourceSchema.safeParse(item.data);
        return parsed.success ? [parsed.data] : [];
      });
    for (const item of items.values()) {
      if (["expert", "team", "flow"].includes(item.kind)) {
        const missing = unavailableCoreAssetRuntimeBindings(
          item.key.slice(item.kind.length + 1),
          resources,
          runtimes,
        );
        if (missing.length > 0)
          unavailable.set(
            item.key,
            `Choose a local harness and model for ${missing.map((entry) => entry.name).join(", ")}.`,
          );
        if (containsDeprecatedPluginReference(item.key.slice(item.kind.length + 1), resources))
          unavailable.set(
            item.key,
            "Remove the deprecated plugin reference before running this asset.",
          );
      }
      if (item.kind !== "runtime-profile") continue;
      const resource = PragmaForwardCompatibleResourceSchema.parse(item.data);
      if (resource.kind !== "RuntimeProfile") continue;
      const config = resource.spec.config as {
        runtimeId?: string;
        providerId?: string;
        model?: string;
        thinkingLevel?: string;
      };
      const runtime = runtimes.find(
        (candidate) => candidate.id === config.runtimeId && candidate.status === "available",
      );
      const model = runtime?.models?.find(
        (candidate) => candidate.id === config.model && candidate.provider.id === config.providerId,
      );
      if (
        runtime === undefined ||
        model === undefined ||
        (config.thinkingLevel !== undefined &&
          !model.thinking?.supportedLevels.some((level) => level.value === config.thinkingLevel))
      )
        unavailable.set(item.key, "Choose an available local harness and model in Studio.");
    }
    return unavailable;
  };

  const makeOverview = async (
    config: CoreAssetSyncConfiguration | undefined,
    state?: SyncState,
    remote?: ItemMap,
  ): Promise<CoreAssetSyncOverview> => {
    if (config === undefined) return { status: "unconfigured", items: [] };
    const current = state ?? (await readState(sourceKey(config)));
    const local = await collect();
    const missing = await readiness(local);
    const keys = new Set([
      ...local.keys(),
      ...(remote?.keys() ?? []),
      ...Object.keys(current.remoteItems),
      ...current.conflicts,
      ...current.ignoredRemote,
    ]);
    const items = [...keys].sort().flatMap((key) => {
      const item = local.get(key) ?? remote?.get(key) ?? current.remoteItems[key];
      if (item === undefined) return [];
      const remoteItem = remote?.get(key) ?? current.remoteItems[key];
      const status = current.conflicts.includes(key)
        ? "conflict"
        : current.ignoredRemote.includes(key)
          ? "ignored_remote"
          : !local.has(key) && remoteItem !== undefined
            ? config.pushDeletions
              ? "pending"
              : "ignored_remote"
            : missing.has(key)
              ? "needs_attention"
              : current.bases[key] === item.fingerprint
                ? "synced"
                : "pending";
      return [
        {
          key,
          kind: item.kind,
          name: item.name,
          status,
          ...(missing.has(key) ? { message: missing.get(key) } : {}),
        },
      ];
    });
    return CoreAssetSyncOverviewSchema.parse({
      configuration: config,
      status: lastError
        ? "error"
        : current.conflicts.length > 0
          ? "conflict"
          : running
            ? "syncing"
            : "ready",
      ...(current.syncedAt ? { syncedAt: current.syncedAt } : {}),
      ...(lastError ? { error: lastError } : {}),
      items,
    });
  };

  const applyRemote = async (
    changes: readonly { key: string; local?: CoreAssetSyncItem; remote?: CoreAssetSyncItem }[],
  ): Promise<void> => {
    const projectUpserts: PragmaResource[] = [];
    const projectRemovals: string[] = [];
    const deferredRemovals: { kind: "knowledge" | "skill" | "capability"; id: string }[] = [];
    for (const { local, remote } of changes) {
      const item = remote ?? local;
      if (item === undefined) continue;
      if (
        ["expert", "team", "flow", "runtime-profile"].includes(item.kind) ||
        (item.kind === "capability" && item.key.startsWith("capability:capability:")) ||
        (item.kind === "knowledge" && item.key.startsWith("knowledge:context-store:"))
      ) {
        if (remote === undefined) projectRemovals.push(item.key.slice(item.kind.length + 1));
        else projectUpserts.push(PragmaForwardCompatibleResourceSchema.parse(remote.data));
        continue;
      }
      if (item.kind === "flow-layout") {
        const flowId = item.key.slice("flow-layout:".length);
        if (remote === undefined)
          await options.layouts.remove({ projectId: options.project.projectId, flowId });
        else {
          const layout = z
            .object({
              nodes: WorkflowLayoutSchema.shape.nodes,
              viewport: WorkflowLayoutSchema.shape.viewport,
            })
            .parse(remote.data);
          await options.layouts.save({
            ...layout,
            schemaVersion: "pragma.desktop-flow-layout/v2",
            projectId: options.project.projectId,
            flowId,
            updatedAt: new Date().toISOString(),
          });
        }
        continue;
      }
      if (item.kind === "knowledge") {
        const id = item.key.slice("knowledge:".length);
        const localStore = (await options.stores.list()).find((candidate) => candidate.id === id);
        if (remote === undefined) {
          if (localStore) deferredRemovals.push({ kind: "knowledge", id });
          continue;
        }
        const data = KnowledgeDataSchema.parse(remote.data);
        if (localStore === undefined)
          await options.stores.createFromSnapshot({
            id,
            ...data,
            author: "sync",
            summary: "Restore core assets from Git.",
          });
        else
          await options.stores.appendSnapshot(
            {
              storeId: id,
              baseRevision: localStore.contentRevision,
              baseSnapshotHash: localStore.snapshotHash,
              snapshotHash: hashKnowledge(data),
              ...data,
              summary: "Restore core assets from Git.",
            },
            "sync",
          );
        continue;
      }
      const id = item.key.slice(item.kind.length + 1);
      const localCapability = (await options.capabilities.list()).find(
        (candidate) => candidate.manifest.id === id,
      );
      if (remote === undefined) {
        if (localCapability)
          deferredRemovals.push({ kind: item.kind === "skill" ? "skill" : "capability", id });
        continue;
      }
      if (item.kind === "capability") {
        const definition = CapabilityDefinitionSchema.parse(remote.data);
        if (definition.kind === "skill") throw new Error("Skill payload is missing.");
        if (localCapability === undefined)
          await options.capabilities.create({ definition, credentials: {} }, { id });
        else
          await options.capabilities.update({
            id,
            baseRevision: localCapability.manifest.latestRevision,
            definition,
            credentials: {},
          });
        continue;
      }
      if (item.kind === "skill") {
        const data = SkillDataSchema.parse(remote.data);
        const validation = validatePortableSkillPackage(
          {
            name: data.name,
            description: data.description,
            files: data.files.map(({ path, content }) => ({ path, content })),
          },
          {
            executablePaths: new Set(
              data.files.filter((file) => file.executable).map((file) => file.path),
            ),
          },
        );
        if (!validation.passed)
          throw new Error(
            `Invalid incoming Skill: ${validation.diagnostics[0]?.message ?? "unknown error"}`,
          );
        const root = await mkdtemp(join(tmpdir(), "pragma-core-skill-"));
        try {
          for (const file of data.files) {
            const path = join(root, file.path);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, file.content, { mode: file.executable ? 0o700 : 0o600 });
          }
          const tree = await scanSkillWorkingTree(root, {
            executablePaths: new Set(
              data.files.filter((file) => file.executable).map((file) => file.path),
            ),
          });
          const executablePaths = data.files
            .filter((file) => file.executable)
            .map((file) => file.path);
          if (localCapability === undefined)
            await options.capabilities.publishNewSkillRevisionCandidate({
              id,
              name: data.name,
              description: data.description,
              sourcePath: root,
              candidateContentHash: tree.hash,
              executablePaths,
            });
          else if (localCapability.definition.kind === "skill")
            await options.capabilities.publishSkillRevisionCandidate({
              id,
              baseRevision: localCapability.manifest.latestRevision,
              baseContentHash: localCapability.definition.contentHash,
              sourcePath: root,
              candidateContentHash: tree.hash,
              executablePaths,
            });
          else throw new Error(`Capability ${id} is not a Skill.`);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
    if (projectUpserts.length > 0 || projectRemovals.length > 0) {
      const current = await options.project.get();
      await options.project.apply({
        baseRevision: current.revision,
        upserts: projectUpserts,
        removals: projectRemovals,
      });
    }
    for (const removal of deferredRemovals) {
      if (removal.kind === "knowledge") {
        const store = (await options.stores.list()).find(
          (candidate) => candidate.id === removal.id,
        );
        if (store)
          await options.stores.remove(removal.id, {
            revision: store.contentRevision,
            snapshotHash: store.snapshotHash,
          });
      } else {
        const capability = (await options.capabilities.list()).find(
          (candidate) => candidate.manifest.id === removal.id,
        );
        if (capability)
          await options.capabilities.remove(removal.id, capability.manifest.latestRevision);
      }
    }
  };

  const run = async (
    intent: "full" | "pull" | "automatic",
    resolution?: { key: string; choice: "local" | "remote" },
  ): Promise<CoreAssetSyncOverview> => {
    await mkdir(dirname(options.statePath), { recursive: true });
    return await withFileLock(`${options.statePath}.lock`, async () => {
      const config = await readConfig();
      if (config === undefined) return await makeOverview(undefined);
      const effectiveIntent = intent === "automatic" ? (config.autoPush ? "full" : "pull") : intent;
      running = true;
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const source = sourceKey(config);
          const state = await readState(source);
          const checkout = await checkoutRepository(config);
          try {
            const remote = await readRepository(
              checkout.root,
              Object.keys(state.bases).length > 0 || Object.keys(state.remoteItems).length > 0,
            );
            const local = await collect();
            const nextRemote = new Map(remote);
            const changes: {
              key: string;
              local?: CoreAssetSyncItem;
              remote?: CoreAssetSyncItem;
            }[] = [];
            const conflicts: string[] = [];
            const ignored = new Set(state.ignoredRemote);
            const bases = { ...state.bases };
            let pushNeeded = false;
            for (const key of new Set([...local.keys(), ...remote.keys(), ...Object.keys(bases)])) {
              const here = local.get(key);
              const there = remote.get(key);
              const base = bases[key];
              if (here?.fingerprint === there?.fingerprint) {
                if (here) bases[key] = here.fingerprint;
                else delete bases[key];
                ignored.delete(key);
                continue;
              }
              const localChanged = here?.fingerprint !== base;
              const remoteChanged = there?.fingerprint !== base;
              const choice = resolution?.key === key ? resolution.choice : undefined;
              if (localChanged && remoteChanged && choice === undefined) {
                conflicts.push(key);
                continue;
              }
              if (
                choice === "local" ||
                (choice === undefined &&
                  ((localChanged && !remoteChanged) || (base === undefined && here && !there)))
              ) {
                if (effectiveIntent === "pull") {
                  if (here === undefined && there !== undefined && !config.pushDeletions)
                    ignored.add(key);
                  continue;
                }
                if (here) {
                  nextRemote.set(key, here);
                  bases[key] = here.fingerprint;
                  pushNeeded = true;
                } else if (choice === "local" || config.pushDeletions) {
                  nextRemote.delete(key);
                  delete bases[key];
                  pushNeeded = true;
                } else {
                  ignored.add(key);
                }
                continue;
              }
              if (
                choice === "remote" ||
                (choice === undefined &&
                  ((!localChanged && remoteChanged) || (base === undefined && there && !here)))
              ) {
                changes.push({
                  key,
                  ...(here ? { local: here } : {}),
                  ...(there ? { remote: there } : {}),
                });
                if (there) bases[key] = there.fingerprint;
                else delete bases[key];
                ignored.delete(key);
                continue;
              }
              if (here && there) conflicts.push(key);
              else if (!here && there) ignored.add(key);
            }
            const nextState = StateSchema.parse({
              ...state,
              bases,
              remoteItems: Object.fromEntries(
                [...nextRemote].map(([key, item]) => [
                  key,
                  { kind: item.kind, name: item.name, fingerprint: item.fingerprint },
                ]),
              ),
              ignoredRemote: [...ignored],
              conflicts,
            });
            await applyRemote(changes);
            if (pushNeeded) await publishRepository(checkout, nextRemote);
            nextState.syncedAt = new Date().toISOString();
            await writeState(nextState);
            lastError = undefined;
            running = false;
            return await makeOverview(config, nextState, nextRemote);
          } catch (error) {
            if (error instanceof RemoteHeadChangedError && attempt < 2) continue;
            throw error;
          } finally {
            await rm(checkout.root, { recursive: true, force: true });
          }
        }
        throw new RemoteHeadChangedError();
      } catch (error) {
        lastError =
          error instanceof Error ? error.message.slice(0, 2_000) : "Synchronization failed.";
        options.warn?.("Core asset sync failed.", error);
        running = false;
        return await makeOverview(config);
      } finally {
        running = false;
      }
    });
  };
  return {
    overview: async () => await makeOverview(await readConfig()),
    async configure(input) {
      const config = CoreAssetSyncConfigurationSchema.parse({
        ...input,
        schemaVersion: "pragma.core-asset-sync-settings/v1",
      });
      await withFileLock(`${options.statePath}.lock`, async () =>
        writeAtomic(options.configurationPath, config),
      );
      return await run("full");
    },
    async removeConfiguration() {
      if (scheduled) clearTimeout(scheduled);
      scheduled = undefined;
      await withFileLock(`${options.statePath}.lock`, async () =>
        rm(options.configurationPath, { force: true }),
      );
    },
    sync: async () => await run("full"),
    refresh: async () => await run("pull"),
    resolve: async (key, choice) => await run("full", { key, choice }),
    restore: async (key) => await run("pull", { key, choice: "remote" }),
    schedule(reason) {
      if (scheduled) clearTimeout(scheduled);
      scheduled = setTimeout(() => {
        scheduled = undefined;
        void run(
          reason === "startup" || reason === "focus" || reason === "online" ? "pull" : "automatic",
        ).catch((error: unknown) => options.warn?.("Core asset sync scheduling failed.", error));
      }, 1_000);
    },
  };
}

function sourceKey(config: CoreAssetSyncConfiguration): string {
  return JSON.stringify([config.remote.trim().replace(/\/+$/u, ""), config.branch ?? null]);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function hashKnowledge(data: z.infer<typeof KnowledgeDataSchema>): string {
  return hashSnapshotContent(data.files, data.directories);
}
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
async function writeAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    timeout: 60_000,
    maxBuffer: 2_000_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout.trim();
}
type Checkout = { root: string; branch: string };
async function checkoutRepository(config: CoreAssetSyncConfiguration): Promise<Checkout> {
  const root = await mkdtemp(join(tmpdir(), "pragma-core-sync-"));
  try {
    await git(root, ["init", "-q"]);
    await git(root, ["remote", "add", "origin", config.remote]);
    const remoteHead =
      config.branch === undefined
        ? await git(root, ["ls-remote", "--symref", "origin", "HEAD"])
        : "";
    const branch =
      config.branch ?? /^ref: refs\/heads\/([^\s]+)\s+HEAD/mu.exec(remoteHead)?.[1] ?? "main";
    const branchHead = await git(root, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
    if (branchHead !== "") {
      await git(root, ["fetch", "--depth=1", "origin", `refs/heads/${branch}`]);
      await git(root, ["checkout", "-q", "-B", branch, "FETCH_HEAD"]);
    } else await git(root, ["checkout", "-q", "--orphan", branch]);
    return { root, branch };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
function validItemIdentity(item: CoreAssetSyncItem): boolean {
  const prefix = `${item.kind}:`;
  if (!item.key.startsWith(prefix)) return false;
  const id = item.key.slice(prefix.length);
  if (
    item.kind === "expert" ||
    item.kind === "team" ||
    item.kind === "flow" ||
    item.kind === "runtime-profile"
  ) {
    const resource = PragmaForwardCompatibleResourceSchema.safeParse(item.data);
    const expectedKind = {
      expert: "Expert",
      team: "ExpertTeam",
      flow: "Flow",
      "runtime-profile": "RuntimeProfile",
    }[item.kind];
    return (
      resource.success &&
      resource.data.kind === expectedKind &&
      item.name === resource.data.metadata.name &&
      id === canonicalPragmaResourceRef(resource.data)
    );
  }
  if (item.kind === "flow-layout") {
    return (
      SemanticResourceIdSchema.safeParse(id).success &&
      z
        .object({
          nodes: WorkflowLayoutSchema.shape.nodes,
          viewport: WorkflowLayoutSchema.shape.viewport,
        })
        .safeParse(item.data).success
    );
  }
  if (item.kind === "knowledge") {
    if (id.startsWith("context-store:")) {
      const resource = PragmaForwardCompatibleResourceSchema.safeParse(item.data);
      return (
        resource.success &&
        resource.data.kind === "ContextStore" &&
        item.name === resource.data.metadata.name &&
        id === canonicalPragmaResourceRef(resource.data) &&
        classifyDesktopContextResource(resource.data) !== undefined
      );
    }
    const data = KnowledgeDataSchema.safeParse(item.data);
    return (
      ContextStoreIdSchema.safeParse(id).success && data.success && item.name === data.data.name
    );
  }
  if (id.startsWith("capability:")) {
    if (item.kind !== "capability") return false;
    const resource = PragmaForwardCompatibleResourceSchema.safeParse(item.data);
    return (
      resource.success &&
      resource.data.kind === "Capability" &&
      item.name === resource.data.metadata.name &&
      id === canonicalPragmaResourceRef(resource.data) &&
      classifyDesktopCapabilityResource(resource.data) !== undefined
    );
  }
  if (!CapabilityIdSchema.safeParse(id).success) return false;
  if (item.kind === "skill") {
    const data = SkillDataSchema.safeParse(item.data);
    return data.success && item.name === data.data.name;
  }
  const definition = CapabilityDefinitionSchema.safeParse(item.data);
  return (
    definition.success && definition.data.kind !== "skill" && item.name === definition.data.name
  );
}
async function readRepository(root: string, requireManifest: boolean): Promise<ItemMap> {
  const path = join(root, ROOT_FILE);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_REPOSITORY_BYTES)
      throw new Error("Invalid core asset repository manifest.");
    const parsed = CoreAssetSyncRepositorySchema.parse(JSON.parse(await readFile(path, "utf8")));
    const items = new Map<string, CoreAssetSyncItem>();
    for (const item of parsed.items) {
      if (fingerprint(item.data) !== item.fingerprint || !validItemIdentity(item))
        throw new Error(`Core asset integrity failed: ${item.key}`);
      items.set(item.key, item);
    }
    return items;
  } catch (error) {
    if (isMissing(error)) {
      if (requireManifest)
        throw new Error(
          "The configured Git repository no longer contains pragma-core-assets.json.",
          {
            cause: error,
          },
        );
      return new Map();
    }
    throw error;
  }
}
async function publishRepository(checkout: Checkout, items: ItemMap): Promise<void> {
  const path = join(checkout.root, ROOT_FILE);
  const content = JSON.stringify(
    CoreAssetSyncRepositorySchema.parse({
      schemaVersion: "pragma.core-asset-sync/v1",
      items: [...items.values()].sort((a, b) => a.key.localeCompare(b.key)),
    }),
  );
  if (Buffer.byteLength(content) > MAX_REPOSITORY_BYTES)
    throw new Error("Core asset repository exceeds 150 MiB.");
  await writeFile(path, `${content}\n`, { mode: 0o600 });
  await git(checkout.root, ["add", "--", ROOT_FILE]);
  if ((await git(checkout.root, ["status", "--porcelain", "--", ROOT_FILE])) === "") return;
  await git(checkout.root, [
    "-c",
    "user.name=Pragma",
    "-c",
    "user.email=sync@pragma.local",
    "commit",
    "-q",
    "-m",
    "Synchronize Pragma core assets",
  ]);
  try {
    await git(checkout.root, ["push", "origin", `HEAD:refs/heads/${checkout.branch}`]);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    if (
      /non-fast-forward|fetch first|remote contains work that you do not have locally/iu.test(
        stderr,
      )
    )
      throw new RemoteHeadChangedError();
    throw error;
  }
}

class RemoteHeadChangedError extends Error {
  constructor() {
    super("The Git branch changed during synchronization. Retrying with the latest revision.");
  }
}

export function unavailableCoreAssetRuntimeBindings(
  rootRef: string,
  resources: readonly PragmaResource[],
  runtimes: readonly DesktopRuntimeAvailability[],
): readonly { ref: string; name: string }[] {
  const byRef = new Map(
    resources.map((resource) => [canonicalPragmaResourceRef(resource), resource] as const),
  );
  const visited = new Set<string>();
  const queue = [rootRef];
  const unavailable: { ref: string; name: string }[] = [];
  while (queue.length > 0) {
    const ref = queue.shift()!;
    if (visited.has(ref)) continue;
    visited.add(ref);
    const resource = byRef.get(ref);
    if (resource === undefined) continue;
    if (resource.kind === "RuntimeProfile") {
      const config = resource.spec.config as {
        runtimeId?: string;
        providerId?: string;
        model?: string;
        thinkingLevel?: string;
      };
      const runtime = runtimes.find(
        (candidate) => candidate.id === config.runtimeId && candidate.status === "available",
      );
      const model = runtime?.models?.find(
        (candidate) => candidate.provider.id === config.providerId && candidate.id === config.model,
      );
      if (
        runtime === undefined ||
        model === undefined ||
        (config.thinkingLevel !== undefined &&
          !model.thinking?.supportedLevels.some((level) => level.value === config.thinkingLevel))
      )
        unavailable.push({ ref, name: resource.metadata.name });
    }
    for (const dependency of referencedPragmaResourceRefs([resource])) queue.push(dependency);
  }
  return unavailable;
}

export function containsDeprecatedPluginReference(
  rootRef: string,
  resources: readonly PragmaResource[],
): boolean {
  const byRef = new Map(
    resources.map((resource) => [canonicalPragmaResourceRef(resource), resource] as const),
  );
  const visited = new Set<string>();
  const queue = [rootRef];
  while (queue.length > 0) {
    const ref = queue.shift()!;
    if (visited.has(ref)) continue;
    visited.add(ref);
    const resource = byRef.get(ref);
    if (resource === undefined) continue;
    if (resource.kind === "Expert" && resource.spec.plugins.length > 0) return true;
    for (const dependency of referencedPragmaResourceRefs([resource])) queue.push(dependency);
  }
  return false;
}
