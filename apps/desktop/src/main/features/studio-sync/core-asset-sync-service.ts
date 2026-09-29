import { inspectAssetReadiness } from "../asset-transfer/asset-transfer-readiness.ts";
import type { PluginStore } from "../plugins/plugin-store.ts";
import {
  encodeSyncRepository,
  readSyncRepository,
  writeSyncRepository,
  SYNC_DIRECTORY,
} from "./asset-sync-repository.ts";
import {
  createAssetTransferService,
  NAME_RESOLUTION_ERROR_CODE,
  type CoreAssetSyncNameResolutionIssue,
  type CollectedItems,
} from "../asset-transfer/asset-transfer-service.ts";

import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { withFileLock } from "@pragma/core";

import {
  canonicalPragmaResourceRef,
  PragmaForwardCompatibleResourceSchema,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import { z } from "zod";

import {
  CapabilityIdSchema,
  ContextStoreIdSchema,
  CoreAssetSyncConfigurationSchema,
  CoreAssetSyncItemSchema,
  CoreAssetSyncOverviewSchema,
  type CoreAssetSyncConfiguration,
  type CoreAssetSyncItem,
  type CoreAssetLogicalKind,
  type CoreAssetSyncOverview,
  type DesktopRuntimeAvailability,
  type UpdateCoreAssetSyncConfiguration,
} from "../../../shared/contracts/index.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";

import type { ContextStoreStore } from "../context-stores/context-store-store.ts";

import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { WorkflowLayoutStore } from "../projects/workflow-layout-store.ts";
import { referencedPragmaResourceRefs } from "../projects/pragma-resource-references.ts";
import {
  classifyDesktopCapabilityResource,
  classifyDesktopContextResource,
  desktopCapabilityResourceId,
  desktopContextResourceId,
} from "../../platform/bindings/desktop-bound-resource-policy.ts";
import { assertAssetGitIdentity, runAssetGit } from "../asset-git/asset-git-command.ts";

const StateSchema = z
  .object({
    schemaVersion: z.literal("pragma.asset-sync-state/v1"),
    source: z.string(),
    repositoryInitialized: z.boolean(),
    bases: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)),
    remoteItems: z
      .record(
        z.string(),
        CoreAssetSyncItemSchema.pick({ kind: true, name: true, fingerprint: true }),
      )
      .default({}),
    ignoredRemote: z.array(z.string()),
    conflicts: z.array(z.string()),
    restoreConflicts: z.array(z.string()).default([]),
    syncedAt: z.string().datetime().optional(),
  })
  .strict();
const ChangeSchema = z
  .object({
    key: z.string(),
    expectedRevision: z.number().int().positive().optional(),
    local: CoreAssetSyncItemSchema.optional(),
    remote: CoreAssetSyncItemSchema.optional(),
  })
  .strict();
const JournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.asset-sync-journal/v1"),
    source: z.string(),
    changes: z.array(ChangeSchema),
    expected: z.record(z.string(), z.string().nullable()),
    incomingState: StateSchema,
  })
  .strict();
type SyncState = z.infer<typeof StateSchema>;
type ItemMap = Map<string, CoreAssetSyncItem>;
export interface CoreAssetSyncService {
  overview(): Promise<CoreAssetSyncOverview>;
  configure(input: UpdateCoreAssetSyncConfiguration): Promise<CoreAssetSyncOverview>;
  removeConfiguration(): Promise<void>;
  sync(): Promise<CoreAssetSyncOverview>;
  automatic(): Promise<CoreAssetSyncOverview>;
  refresh(): Promise<CoreAssetSyncOverview>;
  resolve(key: string, choice: "local" | "remote"): Promise<CoreAssetSyncOverview>;
  restore(key: string): Promise<CoreAssetSyncOverview>;
}

export function createCoreAssetSyncService(options: {
  readonly configurationPath: string;
  readonly statePath: string;
  readonly project: PragmaProjectStore;
  readonly layouts: WorkflowLayoutStore;
  readonly stores: ContextStoreStore;
  readonly capabilities: CapabilityStore;
  readonly plugins?: PluginStore;
  readonly getRuntimes: () => Promise<readonly DesktopRuntimeAvailability[]>;
  readonly warn?: (message: string, error: unknown) => void;
  readonly reportNameResolutionIssue?: (issue: CoreAssetSyncNameResolutionIssue) => void;
}): CoreAssetSyncService {
  let running = false;
  let lastError: string | undefined;
  const reportedNameResolutionFailures = new Set<string>();
  const reportNameResolutionFailure = (
    key: string,
    kind: CoreAssetSyncNameResolutionIssue["resourceKind"],
    bindingId: string,
  ): CoreAssetSyncNameResolutionIssue => {
    const issue = {
      code: NAME_RESOLUTION_ERROR_CODE,
      resourceKey: key,
      resourceKind: kind,
      bindingId,
    } as const;
    if (reportedNameResolutionFailures.has(key)) return issue;
    reportedNameResolutionFailures.add(key);
    options.reportNameResolutionIssue?.(issue);
    return issue;
  };
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
      schemaVersion: "pragma.asset-sync-state/v1",
      source,
      repositoryInitialized: false,
      bases: {},
      remoteItems: {},
      ignoredRemote: [],
      conflicts: [],
      restoreConflicts: [],
    };
  };
  const writeState = async (state: SyncState): Promise<void> =>
    writeAtomic(options.statePath, StateSchema.parse(state));

  const transfer = createAssetTransferService({ ...options, reportNameResolutionFailure });
  const collect = transfer.collectAssets;

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
    if (options.plugins) {
      const diagnostics = await inspectAssetReadiness(resources, {
        capabilities: options.capabilities,
        contextStores: options.stores,
        plugins: options.plugins,
        runtimes,
        checkContextContent: false,
      });
      for (const diagnostic of diagnostics)
        if (diagnostic.status !== "ready") {
          for (const item of items.values())
            if (item.key.endsWith(`:${diagnostic.resourceRef}`))
              unavailable.set(
                item.key,
                `${diagnostic.code}: ${diagnostic.message} (${diagnostic.action})`,
              );
        }
    }
    for (const capability of await options.capabilities.list())
      if (capability.health?.status === "needs_attention") {
        const id = capability.manifest.id;
        unavailable.set(
          `${capability.definition.kind === "skill" ? "skill" : "capability"}:${id}`,
          "capability_needs_attention: Configure this capability in Studio.",
        );
        for (const resource of resources)
          if (classifyDesktopCapabilityResource(resource)?.id === id)
            unavailable.set(
              `capability:${canonicalPragmaResourceRef(resource)}`,
              "capability_needs_attention: Configure this capability in Studio.",
            );
      }
    let updated = true;
    while (updated) {
      updated = false;
      for (const resource of resources) {
        const key = `${resource.kind === "Expert" ? "expert" : resource.kind === "ExpertTeam" ? "team" : resource.kind === "Flow" ? "flow" : resource.kind === "RuntimeProfile" ? "runtime-profile" : resource.kind === "Capability" ? "capability" : "knowledge"}:${canonicalPragmaResourceRef(resource)}`;
        if (unavailable.has(key)) continue;
        const missing = [...referencedPragmaResourceRefs([resource])].find((ref) =>
          [...unavailable.keys()].some((candidate) => candidate.endsWith(`:${ref}`)),
        );
        if (missing) {
          unavailable.set(
            key,
            "dependency_needs_attention: Configure the required asset in Studio.",
          );
          updated = true;
        }
      }
    }
    return unavailable;
  };

  const makeOverview = async (
    config: CoreAssetSyncConfiguration | undefined,
    state?: SyncState,
    remote?: ItemMap,
    collected?: CollectedItems,
  ): Promise<CoreAssetSyncOverview> => {
    if (config === undefined) {
      return { status: "unconfigured", items: [] };
    }
    const current = state ?? (await readState(sourceKey(config)));
    const { items: local, nameResolutionIssues } = collected ?? (await collect());
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
      const identity = logicalAssetIdentity({ ...item, key }, local, remote, current.remoteItems);
      const localNameIssue = nameResolutionIssues.get(key);
      const status = current.conflicts.includes(key)
        ? "conflict"
        : localNameIssue !== undefined
          ? "error"
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
      const displayItem = { key, kind: item.kind, name: item.name };
      const unresolved = local.has(key) ? undefined : generatedBindingPlaceholder(displayItem);
      if (unresolved !== undefined) {
        reportNameResolutionFailure(key, unresolved.kind, unresolved.bindingId);
      }
      const nameIssue = localNameIssue ?? unresolved;
      return [
        {
          key,
          kind: item.kind,
          name: safeSyncItemName(displayItem, localNameIssue?.resourceKind ?? unresolved?.kind),
          ...identity,
          status,
          ...(nameIssue !== undefined
            ? { message: "The bound local asset is unavailable. Check the application logs." }
            : missing.has(key)
              ? { message: missing.get(key) }
              : {}),
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

  const journalPath = join(dirname(options.statePath), "restore-journal.json");
  const recoverImport = async (source: string): Promise<"complete" | "conflict"> => {
    let journal: z.infer<typeof JournalSchema>;
    try {
      journal = JournalSchema.parse(JSON.parse(await readFile(journalPath, "utf8")));
    } catch (error) {
      if (isMissing(error)) return "complete";
      throw error;
    }
    if (journal.source !== source) {
      // Configuration changes cancel unfinished imports from the previous repository.
      // Already published assets remain local and are reconciled against the selected source.
      await rm(journalPath, { force: true });
      return "complete";
    }
    const interruptedConflicts = (current: CollectedItems): string[] =>
      journal.changes.flatMap((change) => {
        const actual = current.items.get(change.key)?.fingerprint ?? null;
        if (actual === (change.remote?.fingerprint ?? null)) return [];
        return actual !== journal.expected[change.key] ||
          (change.expectedRevision !== undefined &&
            change.expectedRevision !== current.revisions.get(change.key))
          ? [change.key]
          : [];
      });
    const deferConflicts = async (current: CollectedItems, conflicts: readonly string[]) => {
      const state = await readState(source);
      const bases = { ...state.bases };
      // Only completed stages advance their baseline. Pending stages are replanned from Git.
      for (const change of journal.changes) {
        if (
          (current.items.get(change.key)?.fingerprint ?? null) !==
          (change.remote?.fingerprint ?? null)
        )
          continue;
        const incomingBase = journal.incomingState.bases[change.key];
        if (incomingBase === undefined) delete bases[change.key];
        else bases[change.key] = incomingBase;
      }
      await writeState({
        ...state,
        repositoryInitialized:
          state.repositoryInitialized || journal.incomingState.repositoryInitialized,
        bases,
        remoteItems: journal.incomingState.remoteItems,
        conflicts: [...new Set([...state.conflicts, ...conflicts])],
        restoreConflicts: [...new Set([...state.restoreConflicts, ...conflicts])],
      });
      // Persist the conflict before retiring the operation, so a crash repeats this transition.
      await rm(journalPath, { force: true });
    };
    let current = await collect();
    let conflicts = interruptedConflicts(current);
    if (conflicts.length > 0) {
      await deferConflicts(current, conflicts);
      return "conflict";
    }
    const pending = journal.changes.filter(
      (change) =>
        (current.items.get(change.key)?.fingerprint ?? null) !==
        (change.remote?.fingerprint ?? null),
    );
    try {
      await transfer.applyImport(await transfer.prepareImport(pending));
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("asset_sync.restore_conflict:"))
        throw error;
      current = await collect();
      conflicts = interruptedConflicts(current);
      if (conflicts.length === 0) throw error;
      await deferConflicts(current, conflicts);
      return "conflict";
    }
    await writeState(journal.incomingState);
    await rm(journalPath, { force: true });
    return "complete";
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
        await recoverImport(sourceKey(config));
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const source = sourceKey(config);
          const state = await readState(source);
          const checkout = await checkoutRepository(config);
          try {
            const remote = await readSyncRepository(checkout.root, state.repositoryInitialized);
            const { items: local, revisions, nameResolutionIssues } = await collect();
            const nextRemote = new Map(remote);
            const changes: {
              key: string;
              expectedRevision?: number;
              local?: CoreAssetSyncItem;
              remote?: CoreAssetSyncItem;
            }[] = [];
            const conflicts: string[] = [];
            const ignored = new Set(state.ignoredRemote);
            const bases = { ...state.bases };
            const repositoryInitialized = await lstat(
              join(checkout.root, SYNC_DIRECTORY, "sync.yaml"),
            )
              .then(() => true)
              .catch((error: unknown) => {
                if (isMissing(error)) return false;
                throw error;
              });
            let pushNeeded = effectiveIntent === "full" && !repositoryInitialized;
            const keys = new Set([
              ...local.keys(),
              ...remote.keys(),
              ...Object.keys(bases),
              ...state.restoreConflicts,
            ]);
            const groups = new Map<string, string[]>();
            for (const key of keys) {
              const item = local.get(key) ?? remote.get(key);
              const group = item ? logicalAssetIdentity(item, local, remote).assetKey : key;
              groups.set(group, [...(groups.get(group) ?? []), key]);
            }
            const groupChoices = new Map<string, "local" | "remote">();
            const groupedConflicts = new Set<string>();
            for (const members of groups.values()) {
              if (
                (!resolution || !members.includes(resolution.key)) &&
                members.every((key) => !local.has(key)) &&
                members.some((key) => state.ignoredRemote.includes(key)) &&
                !members.some((key) => state.restoreConflicts.includes(key))
              ) {
                for (const key of members) ignored.add(key);
                continue;
              }
              const localChanged = members.some(
                (key) => local.get(key)?.fingerprint !== bases[key],
              );
              const remoteChanged = members.some(
                (key) => remote.get(key)?.fingerprint !== bases[key],
              );
              const equal = members.every(
                (key) => local.get(key)?.fingerprint === remote.get(key)?.fingerprint,
              );
              if (resolution && members.includes(resolution.key))
                for (const key of members) groupChoices.set(key, resolution.choice);
              else if (
                !equal &&
                ((localChanged && remoteChanged) ||
                  members.some((key) => state.restoreConflicts.includes(key)))
              )
                for (const key of members) groupedConflicts.add(key);
            }
            for (const item of [...remote.values(), ...local.values()]) {
              const parsed = PragmaForwardCompatibleResourceSchema.safeParse(item.data);
              if (!parsed.success) continue;
              const storeId = classifyDesktopContextResource(parsed.data);
              if (
                storeId &&
                (groupedConflicts.has(`knowledge:${storeId}`) ||
                  (ignored.has(`knowledge:${storeId}`) &&
                    !local.has(`knowledge:${storeId}`) &&
                    groupChoices.get(`knowledge:${storeId}`) !== "remote" &&
                    !ignored.has(item.key)))
              )
                groupedConflicts.add(item.key);
            }
            // Block incoming changes that would depend on a conflicted resource or payload.
            const blockedRefs = new Set(
              [
                ...new Set([
                  ...groupedConflicts,
                  ...[...ignored].filter(
                    (key) => !local.has(key) && groupChoices.get(key) !== "remote",
                  ),
                ]),
              ].flatMap((key) => {
                const item = remote.get(key) ?? local.get(key);
                const parsed = PragmaForwardCompatibleResourceSchema.safeParse(item?.data);
                return parsed.success ? [canonicalPragmaResourceRef(parsed.data)] : [];
              }),
            );
            let grew = true;
            while (grew) {
              grew = false;
              for (const members of groups.values())
                if (members.some((key) => groupedConflicts.has(key)))
                  for (const key of members) {
                    if (groupedConflicts.has(key)) continue;
                    groupedConflicts.add(key);
                    const parsed = PragmaForwardCompatibleResourceSchema.safeParse(
                      (remote.get(key) ?? local.get(key))?.data,
                    );
                    if (parsed.success) blockedRefs.add(canonicalPragmaResourceRef(parsed.data));
                    grew = true;
                  }
              for (const item of [...remote.values(), ...local.values()]) {
                const parsed = PragmaForwardCompatibleResourceSchema.safeParse(item.data);
                if (!parsed.success || groupedConflicts.has(item.key)) continue;
                if (
                  [...referencedPragmaResourceRefs([parsed.data])].some((ref) =>
                    blockedRefs.has(ref),
                  )
                ) {
                  groupedConflicts.add(item.key);
                  blockedRefs.add(canonicalPragmaResourceRef(parsed.data));
                  grew = true;
                }
              }
            }
            for (const key of keys) {
              if (groupedConflicts.has(key)) {
                conflicts.push(key);
                continue;
              }
              const here = local.get(key);
              const there = remote.get(key);
              const base = bases[key];
              if (here?.fingerprint === there?.fingerprint) {
                if (here) bases[key] = here.fingerprint;
                else delete bases[key];
                ignored.delete(key);
                continue;
              }
              if (
                here === undefined &&
                there !== undefined &&
                ignored.has(key) &&
                !groupChoices.has(key)
              ) {
                ignored.add(key);
                continue;
              }
              const localChanged = here?.fingerprint !== base;
              const remoteChanged = there?.fingerprint !== base;
              const choice = groupChoices.get(key);
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
                  if (nameResolutionIssues.has(key)) continue;
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
                  ...(revisions.has(key) ? { expectedRevision: revisions.get(key)! } : {}),
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
            const prepared = await transfer.prepareImport(changes);
            if (effectiveIntent === "full")
              for (const change of prepared)
                if (
                  change.remote &&
                  change.remote.fingerprint !== remote.get(change.key)?.fingerprint
                ) {
                  nextRemote.set(change.key, change.remote);
                  bases[change.key] = change.remote.fingerprint;
                  pushNeeded = true;
                }
            const nextState = StateSchema.parse({
              ...state,
              repositoryInitialized: repositoryInitialized || pushNeeded,
              bases,
              remoteItems: Object.fromEntries(
                [...nextRemote].map(([key, item]) => [
                  key,
                  {
                    kind: item.kind,
                    name: item.name,
                    fingerprint: item.fingerprint,
                  },
                ]),
              ),
              ignoredRemote: [...ignored],
              conflicts,
              restoreConflicts: state.restoreConflicts.filter((key) => conflicts.includes(key)),
            });
            if (pushNeeded) encodeSyncRepository(nextRemote);
            if (changes.length > 0) {
              const incomingBases = { ...state.bases };
              for (const change of changes) {
                if (change.remote) incomingBases[change.key] = change.remote.fingerprint;
                else delete incomingBases[change.key];
              }
              await writeAtomic(
                journalPath,
                JournalSchema.parse({
                  schemaVersion: "pragma.asset-sync-journal/v1",
                  source,
                  changes: prepared,
                  expected: Object.fromEntries(
                    changes.map((change) => [
                      change.key,
                      local.get(change.key)?.fingerprint ?? null,
                    ]),
                  ),
                  incomingState: {
                    ...state,
                    repositoryInitialized,
                    bases: incomingBases,
                    remoteItems: Object.fromEntries(
                      [...remote].map(([key, item]) => [
                        key,
                        { kind: item.kind, name: item.name, fingerprint: item.fingerprint },
                      ]),
                    ),
                  },
                }),
              );
              if ((await recoverImport(source)) === "conflict") {
                if (attempt < 2) continue;
                lastError = undefined;
                running = false;
                return await makeOverview(config);
              }
            }
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
    async overview() {
      const config = await readConfig();
      if (config === undefined) return await makeOverview(undefined);
      const state = await readState(sourceKey(config));
      const local = await collect();
      if (!needsRemoteIdentity(state, local.items))
        return await makeOverview(config, state, undefined, local);
      let checkout: Checkout | undefined;
      try {
        checkout = await checkoutRepository(config);
        const remote = await readSyncRepository(checkout.root, true);
        return await makeOverview(config, state, remote, local);
      } catch (error) {
        options.warn?.("Core asset sync overview could not read remote identity metadata.", error);
        return await makeOverview(config, state, undefined, local);
      } finally {
        if (checkout !== undefined) await rm(checkout.root, { recursive: true, force: true });
      }
    },
    async configure(input) {
      const config = CoreAssetSyncConfigurationSchema.parse({
        ...input,
        schemaVersion: "pragma.asset-sync-settings/v1",
      });
      await withFileLock(`${options.statePath}.lock`, async () => {
        const previous = await readConfig();
        if (
          previous?.pushDeletions === false &&
          config.pushDeletions &&
          sourceKey(previous) === sourceKey(config)
        ) {
          const state = await readState(sourceKey(config));
          const { items: local } = await collect();
          const ignored = new Set(state.ignoredRemote);
          for (const key of Object.keys(state.remoteItems)) {
            if (!local.has(key)) ignored.add(key);
          }
          await writeState({ ...state, ignoredRemote: [...ignored] });
        }
        if (previous === undefined || sourceKey(previous) !== sourceKey(config))
          await rm(journalPath, { force: true });
        await writeAtomic(options.configurationPath, config);
      });
      return await run("full");
    },
    async removeConfiguration() {
      await withFileLock(`${options.statePath}.lock`, async () => {
        await rm(options.configurationPath, { force: true });
        await rm(journalPath, { force: true });
        lastError = undefined;
      });
    },
    sync: async () => await run("full"),
    automatic: async () => await run("automatic"),
    refresh: async () => await run("pull"),
    resolve: async (key, choice) => await run("full", { key, choice }),
    restore: async (key) => await run("pull", { key, choice: "remote" }),
  };
}

type CoreAssetSyncItemSummary = Pick<CoreAssetSyncItem, "key" | "kind" | "name" | "fingerprint"> & {
  readonly data?: unknown;
};

function logicalAssetIdentity(
  item: CoreAssetSyncItemSummary,
  local: ItemMap,
  remote?: ItemMap,
  cached?: SyncState["remoteItems"],
): { assetKey: string; assetKind: CoreAssetLogicalKind; assetName: string } {
  const parsedResource =
    item.data === undefined
      ? undefined
      : PragmaForwardCompatibleResourceSchema.safeParse(item.data);
  const resource = parsedResource?.success === true ? parsedResource.data : undefined;
  if (resource?.kind === "Capability") {
    const capabilityId = classifyDesktopCapabilityResource(resource)?.id;
    if (capabilityId !== undefined) {
      const definition =
        itemSummaryAt(`capability:${capabilityId}`, local, remote, cached) ??
        itemSummaryAt(`skill:${capabilityId}`, local, remote, cached);
      return {
        assetKey: `${definition?.kind === "skill" ? "skill" : "capability"}:${capabilityId}`,
        assetKind: definition?.kind === "skill" ? "skill" : "capability",
        assetName: definition?.name ?? resource.metadata.name,
      };
    }
  }
  if (resource?.kind === "ContextStore") {
    const storeId = classifyDesktopContextResource(resource);
    if (storeId !== undefined) {
      const store = itemSummaryAt(`knowledge:${storeId}`, local, remote, cached);
      return {
        assetKey: `context:${storeId}`,
        assetKind: "context",
        assetName: store?.name ?? resource.metadata.name,
      };
    }
  }
  if (
    resource !== undefined &&
    ["Expert", "ExpertTeam", "Flow", "RuntimeProfile"].includes(resource.kind)
  ) {
    const assetKind =
      resource.kind === "Expert"
        ? "expert"
        : resource.kind === "ExpertTeam"
          ? "team"
          : resource.kind === "Flow"
            ? "flow"
            : "runtime-profile";
    return {
      assetKey: `${assetKind}:${resource.metadata.id}`,
      assetKind,
      assetName: resource.metadata.name,
    };
  }
  if (item.kind === "flow-layout") {
    const id = item.key.slice("flow-layout:".length);
    const flowKey = `flow:flow:${id}`;
    const flow = remote?.get(flowKey) ?? local.get(flowKey) ?? cached?.[flowKey];
    return {
      assetKey: `flow:${id}`,
      assetKind: "flow",
      assetName: flow?.name ?? item.name,
    };
  }

  const separator = item.key.indexOf(":");
  const rawId = separator < 0 ? item.key : item.key.slice(separator + 1);
  const nestedPrefix = `${item.kind}:`;
  const id = rawId.startsWith(nestedPrefix) ? rawId.slice(nestedPrefix.length) : rawId;
  if (item.kind === "capability" && rawId.startsWith("capability:")) {
    const capabilityId = canonicalBindingTargetId(
      rawId.slice("capability:".length),
      "capability",
      CapabilityIdSchema,
      local,
      remote,
      cached,
    );
    if (capabilityId !== undefined) {
      const definition =
        itemSummaryAt(`capability:${capabilityId}`, local, remote, cached) ??
        itemSummaryAt(`skill:${capabilityId}`, local, remote, cached);
      return {
        assetKey: `${definition?.kind === "skill" ? "skill" : "capability"}:${capabilityId}`,
        assetKind: definition?.kind === "skill" ? "skill" : "capability",
        assetName: definition?.name ?? item.name,
      };
    }
  }
  if (item.kind === "knowledge" && rawId.startsWith("context-store:")) {
    const storeId = canonicalBindingTargetId(
      rawId.slice("context-store:".length),
      "knowledge",
      ContextStoreIdSchema,
      local,
      remote,
      cached,
    );
    if (storeId !== undefined) {
      const store = itemSummaryAt(`knowledge:${storeId}`, local, remote, cached);
      return {
        assetKey: `context:${storeId}`,
        assetKind: "context",
        assetName: store?.name ?? item.name,
      };
    }
    return { assetKey: `context:${id}`, assetKind: "context", assetName: item.name };
  }
  const assetKind = item.kind as CoreAssetLogicalKind;
  return { assetKey: `${assetKind}:${id}`, assetKind, assetName: item.name };
}

function itemSummaryAt(
  key: string,
  local: ItemMap,
  remote?: ItemMap,
  cached?: SyncState["remoteItems"],
): CoreAssetSyncItemSummary | undefined {
  const item = local.get(key) ?? remote?.get(key) ?? cached?.[key];
  return item === undefined ? undefined : { ...item, key };
}

function canonicalBindingTargetId(
  resourceId: string,
  targetKind: "capability" | "knowledge",
  idSchema: typeof CapabilityIdSchema | typeof ContextStoreIdSchema,
  local: ItemMap,
  remote?: ItemMap,
  cached?: SyncState["remoteItems"],
): string | undefined {
  const keys = new Set([...local.keys(), ...(remote?.keys() ?? []), ...Object.keys(cached ?? {})]);
  return [...keys].flatMap((key) => {
    if (!key.startsWith(`${targetKind}:`)) return [];
    const id = key.slice(targetKind.length + 1);
    if (id.includes(":") || !idSchema.safeParse(id).success) return [];
    const matchesResource =
      targetKind === "capability"
        ? (["project-expert", "system-expert-customization", "default-agent-option"] as const).some(
            (owner) => desktopCapabilityResourceId(owner, id) === resourceId,
          )
        : (["project-expert", "system-expert-customization"] as const).some(
            (owner) => desktopContextResourceId(owner, id) === resourceId,
          );
    return matchesResource ? [id] : [];
  })[0];
}

function needsRemoteIdentity(state: SyncState, local: ItemMap): boolean {
  return Object.keys(state.remoteItems).some(
    (key) =>
      !local.has(key) &&
      (key.startsWith("capability:capability:") || key.startsWith("knowledge:context-store:")),
  );
}

function sourceKey(config: CoreAssetSyncConfiguration): string {
  return JSON.stringify([config.remote.trim().replace(/\/+$/u, ""), config.branch ?? null]);
}
function generatedBindingPlaceholder(item: Pick<CoreAssetSyncItem, "key" | "kind" | "name">):
  | {
      readonly kind: CoreAssetSyncNameResolutionIssue["resourceKind"];
      readonly bindingId: string;
    }
  | undefined {
  if (item.kind === "knowledge" && item.key.startsWith("knowledge:context-store:")) {
    const bindingId = item.name.startsWith("Context ") ? item.name.slice("Context ".length) : "";
    if (ContextStoreIdSchema.safeParse(bindingId).success)
      return { kind: "context-store", bindingId };
  }
  if (item.kind === "capability" && item.key.startsWith("capability:capability:")) {
    const bindingId = item.name.startsWith("Capability ")
      ? item.name.slice("Capability ".length)
      : "";
    if (CapabilityIdSchema.safeParse(bindingId).success) return { kind: "capability", bindingId };
  }
  return undefined;
}
function safeSyncItemName(
  item: Pick<CoreAssetSyncItem, "name">,
  unresolvedKind: CoreAssetSyncNameResolutionIssue["resourceKind"] | undefined,
): string {
  if (unresolvedKind === "context-store") return "Unavailable knowledge base";
  if (unresolvedKind === "capability") return "Unavailable capability";
  return item.name;
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
  return (await runAssetGit(root, args, { maxBuffer: 2_000_000 })).trim();
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
async function publishRepository(checkout: Checkout, items: ItemMap): Promise<void> {
  await writeSyncRepository(checkout.root, items);
  if ((await git(checkout.root, ["status", "--porcelain", "--", SYNC_DIRECTORY])) === "") return;
  await assertAssetGitIdentity(checkout.root);
  await git(checkout.root, ["commit", "-q", "-m", "Synchronize Pragma core assets"]);
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
