import { inspectAssetReadiness } from "../asset-transfer/asset-transfer-readiness.ts";
import {
  createAssetTransferService,
  AssetTransferConflictError,
  NAME_RESOLUTION_ERROR_CODE,
  type CollectedItems,
  type CoreAssetSyncNameResolutionIssue,
} from "../asset-transfer/asset-transfer-service.ts";
import type { PluginStore } from "../plugins/plugin-store.ts";
import { fingerprint } from "../asset-transfer/asset-transfer-fingerprint.ts";
import { KnowledgeDataSchema } from "../asset-transfer/asset-transfer-payloads.ts";
import {
  encodeSyncRepository,
  readSyncRepository,
  SYNC_DIRECTORY,
  writeSyncRepository,
} from "./asset-sync-repository.ts";

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
  CoreAssetSyncOverviewSchema,
  type CoreAssetLogicalKind,
  type CoreAssetSyncConfiguration,
  type CoreAssetSyncItem,
  type CoreAssetSyncOverview,
  type DesktopRuntimeAvailability,
  type UpdateCoreAssetSyncConfiguration,
} from "../../../shared/contracts/index.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";

import type { ContextStoreStore } from "../context-stores/context-store-store.ts";

import { redactGitDiagnostic } from "../../../shared/git-diagnostics.ts";
import {
  classifyDesktopCapabilityResource,
  classifyDesktopContextResource,
  bindExistingDesktopContextResource,
  desktopCapabilityResourceId,
  desktopContextResourceId,
} from "../../platform/bindings/desktop-bound-resource-policy.ts";
import { assertAssetGitIdentity, runAssetGit } from "../asset-git/asset-git-command.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import { referencedPragmaResourceRefs } from "../projects/pragma-resource-references.ts";
import type { WorkflowLayoutStore } from "../projects/workflow-layout-store.ts";

import { StateSchema, JournalSchema, type SyncState } from "./asset-sync-state.ts";
import { upgradeAssetSyncOwner, readCurrentAssetSyncOwner } from "./asset-sync-upgrade.ts";
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
  deleteRemote(key: string): Promise<CoreAssetSyncOverview>;
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
  const readConfigUnlocked = async (): Promise<CoreAssetSyncConfiguration | undefined> => {
    await upgradeAssetSyncOwner(options.configurationPath, options.statePath);
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
      schemaVersion: "pragma.asset-sync-state/v2",
      source,
      repositoryInitialized: false,
      bases: {},
      remoteItems: {},
      unavailableItems: {},
      conflicts: [],
      conflictMessages: {},
      restoreConflicts: [],
    };
  };
  const writeState = async (state: SyncState): Promise<void> =>
    writeAtomic(options.statePath, StateSchema.parse(state));

  const transfer = createAssetTransferService({ ...options, reportNameResolutionFailure });
  const collect = transfer.collectAssets;

  const unavailableLocalAuthorities = async (local: ItemMap, keys: Iterable<string>) => {
    const unavailable = new Set<string>();
    await Promise.all(
      [...keys].map(async (key) => {
        if (local.has(key)) return;
        const separator = key.indexOf(":");
        const kind = key.slice(0, separator);
        const id = key.slice(separator + 1);
        if (id.includes(":")) return;
        const exists =
          kind === "knowledge" && ContextStoreIdSchema.safeParse(id).success
            ? await options.stores.exists(id)
            : (kind === "capability" || kind === "skill") &&
                CapabilityIdSchema.safeParse(id).success
              ? await options.capabilities.exists(id)
              : false;
        if (exists) unavailable.add(key);
      }),
    );
    return unavailable;
  };
  const unavailableMessage =
    "asset_sync.local_unavailable: The local asset exists but cannot be read. Repair its configuration in Studio before synchronizing.";

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
          !model?.thinking?.supportedLevels.some((level) => level.value === config.thinkingLevel))
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
      return { schemaVersion: "pragma.asset-sync-overview/v2", status: "unconfigured", items: [] };
    }
    const current = state ?? (await readState(sourceKey(config)));
    const { items: local, nameResolutionIssues } = collected ?? (await collect());
    const missing = await readiness(local);
    const knownItems = { ...current.unavailableItems, ...current.remoteItems };
    const keys = new Set([
      ...local.keys(),
      ...(remote?.keys() ?? []),
      ...Object.keys(knownItems),
      ...current.conflicts,
    ]);
    const unavailable = await unavailableLocalAuthorities(local, keys);
    const items = [...keys].sort().flatMap((key) => {
      const item = local.get(key) ?? remote?.get(key) ?? knownItems[key];
      if (item === undefined) return [];
      const remoteItem = remote?.get(key) ?? current.remoteItems[key];
      const identity = logicalAssetIdentity({ ...item, key }, local, remote, knownItems);
      const localNameIssue = nameResolutionIssues.get(key);
      const status =
        unavailable.has(key) || localNameIssue !== undefined
          ? "error"
          : current.conflicts.includes(key)
            ? "conflict"
            : local.has(key) &&
                current.bases[key] === item.fingerprint &&
                (remoteItem === undefined || remoteItem.fingerprint === item.fingerprint)
              ? "synced"
              : "pending";
      const displayItem = { key, kind: item.kind, name: item.name };
      const unresolved = local.has(key) ? undefined : generatedBindingPlaceholder(displayItem);
      if (unresolved !== undefined) {
        reportNameResolutionFailure(key, unresolved.kind, unresolved.bindingId);
      }
      const nameIssue = localNameIssue ?? unresolved;
      const issueKind = localNameIssue?.resourceKind ?? unresolved?.kind;
      const bindingId = localNameIssue?.bindingId ?? unresolved?.bindingId;
      const namedAuthority =
        bindingId === undefined
          ? undefined
          : issueKind === "context-store"
            ? itemSummaryAt(`knowledge:${bindingId}`, local, remote, knownItems)
            : (itemSummaryAt(`capability:${bindingId}`, local, remote, knownItems) ??
              itemSummaryAt(`skill:${bindingId}`, local, remote, knownItems));
      const identityIssue =
        nameIssue && !namedAuthority
          ? generatedBindingPlaceholder({ ...displayItem, name: identity.assetName })
          : undefined;
      // Missing Host mappings are reconciled by sync, not user deletion decisions.
      // The independent Knowledge record still exposes content conflicts/deletions.
      if (identity.assetKind === "context" && !local.has(key)) return [];
      return [
        {
          key,
          kind: item.kind,
          name: safeSyncItemName(displayItem, localNameIssue?.resourceKind ?? unresolved?.kind),
          ...identity,
          assetName: safeSyncItemName({ name: identity.assetName }, identityIssue?.kind),
          status,
          ...(unavailable.has(key)
            ? { readiness: { status: "needs_attention", message: unavailableMessage } }
            : missing.has(key)
              ? { readiness: { status: "needs_attention", message: missing.get(key)! } }
              : {}),
          ...(unavailable.has(key)
            ? { message: unavailableMessage }
            : status === "conflict" && current.conflictMessages[key] !== undefined
              ? { message: current.conflictMessages[key] }
              : nameIssue !== undefined
                ? { message: "The bound local asset is unavailable. Check the application logs." }
                : {}),
        },
      ];
    });
    return CoreAssetSyncOverviewSchema.parse({
      schemaVersion: "pragma.asset-sync-overview/v2",
      configuration: config,
      status:
        lastError || items.some((item) => item.status === "error")
          ? "error"
          : items.some((item) => item.status === "conflict")
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
        unavailableItems: journal.incomingState.unavailableItems,
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
      if (!(error instanceof AssetTransferConflictError)) throw error;
      current = await collect();
      conflicts = [
        ...new Set([
          ...interruptedConflicts(current),
          ...pending
            .filter(
              (change) =>
                error.keys.includes(change.key) &&
                (current.items.get(change.key)?.fingerprint ?? null) !==
                  (change.remote?.fingerprint ?? null),
            )
            .map((change) => change.key),
        ]),
      ];
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
    resolution?: { key: string; choice: "local" | "remote" | "delete" },
  ): Promise<CoreAssetSyncOverview> => {
    await mkdir(dirname(options.statePath), { recursive: true });
    return await withFileLock(`${options.statePath}.lock`, async () => {
      const config = await readConfigUnlocked();
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
            const knownItems = { ...state.unavailableItems, ...state.remoteItems };
            const nextRemote = new Map(remote);
            const changes: {
              key: string;
              expectedRevision?: number;
              local?: CoreAssetSyncItem;
              remote?: CoreAssetSyncItem;
            }[] = [];
            const conflicts: string[] = [];
            const conflictMessages: Record<string, string> = {};
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
              ...Object.keys(knownItems),
              ...state.restoreConflicts,
            ]);
            const groups = new Map<string, string[]>();
            const unavailableAuthorities = await unavailableLocalAuthorities(local, keys);
            const deferredUnavailable = new Set(unavailableAuthorities);
            // Diagnostic identities are separate from the current Git inventory.
            const unavailableItems = Object.fromEntries(
              [...unavailableAuthorities].flatMap((key) => {
                const item = itemSummaryAt(key, local, remote, knownItems);
                return item
                  ? [[key, { kind: item.kind, name: item.name, fingerprint: item.fingerprint }]]
                  : [];
              }),
            );
            for (const key of keys) {
              const item = itemSummaryAt(key, local, remote, knownItems);
              const group = item
                ? logicalAssetIdentity(item, local, remote, knownItems).assetKey
                : key;
              groups.set(group, [...(groups.get(group) ?? []), key]);
            }
            const deletionKeys =
              resolution?.choice === "delete"
                ? [...groups.values()].find((members) => members.includes(resolution.key))
                : undefined;
            if (resolution?.choice === "delete") {
              if (
                !deletionKeys?.some(
                  (key) =>
                    remote.has(key) ||
                    state.remoteItems[key] !== undefined ||
                    bases[key] !== undefined,
                )
              )
                throw new Error("The Git asset no longer exists. Refresh synchronization status.");
              if (deletionKeys.some((key) => local.has(key)))
                throw new Error(
                  "The asset exists locally again. Refresh synchronization status before deleting from Git.",
                );
            }
            const groupChoices = new Map<string, "local" | "remote">();
            const groupedConflicts = new Set<string>();
            const repairContextKeys = new Set<string>();
            for (const [key, item] of remote) {
              if (local.has(key)) continue;
              const parsed = PragmaForwardCompatibleResourceSchema.safeParse(item.data);
              const storeId = parsed.success
                ? classifyDesktopContextResource(parsed.data)
                : undefined;
              if (storeId === undefined || !local.has(`knowledge:${storeId}`)) continue;
              // Absence of an internal mapping is not deletion of its authority.
              // Replay through the ordinary CAS/journal import path, including old
              // ignored and restore-conflict checkpoints, without touching content.
              repairContextKeys.add(key);
              groupChoices.set(key, "remote");
            }
            for (const members of groups.values()) {
              const localChanged = members.some(
                (key) => !repairContextKeys.has(key) && local.get(key)?.fingerprint !== bases[key],
              );
              const remoteChanged = members.some(
                (key) => remote.get(key)?.fingerprint !== bases[key],
              );
              const equal = members.every(
                (key) => local.get(key)?.fingerprint === remote.get(key)?.fingerprint,
              );
              if (resolution && members.includes(resolution.key))
                for (const key of members)
                  groupChoices.set(
                    key,
                    resolution.choice === "delete" ? "local" : resolution.choice,
                  );
              else if (
                !equal &&
                ((localChanged && remoteChanged) ||
                  members.some(
                    (key) => !repairContextKeys.has(key) && state.restoreConflicts.includes(key),
                  ))
              )
                for (const key of members) groupedConflicts.add(key);
            }
            // Use the selected versions' edges, including local graph deletions.
            const dependencyItems = [...keys].flatMap((key) => {
              const here = local.get(key);
              const there = remote.get(key);
              if (groupChoices.get(key) === "local") return here ? [here] : [];
              if (groupChoices.get(key) === "remote") return there ? [there] : [];
              if (here?.fingerprint !== bases[key] && there?.fingerprint === bases[key])
                return here ? [here] : [];
              return there ? [there] : here ? [here] : [];
            });
            for (const item of dependencyItems) {
              const parsed = PragmaForwardCompatibleResourceSchema.safeParse(item.data);
              if (!parsed.success) continue;
              const storeId = classifyDesktopContextResource(parsed.data);
              if (storeId && groupedConflicts.has(`knowledge:${storeId}`))
                groupedConflicts.add(item.key);
              if (storeId && deferredUnavailable.has(`knowledge:${storeId}`))
                deferredUnavailable.add(item.key);
            }
            // Block incoming changes that would depend on a conflicted resource or payload.
            const blockedRefs = new Set(
              [...groupedConflicts].flatMap((key) => {
                const item = remote.get(key) ?? local.get(key);
                const parsed = PragmaForwardCompatibleResourceSchema.safeParse(item?.data);
                return parsed.success ? [canonicalPragmaResourceRef(parsed.data)] : [];
              }),
            );
            const unavailableRefs = new Set(
              [...deferredUnavailable].flatMap((key) => {
                const parsed = PragmaForwardCompatibleResourceSchema.safeParse(
                  (remote.get(key) ?? local.get(key))?.data,
                );
                return parsed.success ? [canonicalPragmaResourceRef(parsed.data)] : [];
              }),
            );
            let grew = true;
            while (grew) {
              grew = false;
              if (effectiveIntent === "full" && !deletionKeys) {
                const planned = new Map(remote);
                for (const key of keys) {
                  if (groupedConflicts.has(key) || deferredUnavailable.has(key)) continue;
                  const here = local.get(key);
                  const there = remote.get(key);
                  if (
                    groupChoices.get(key) === "local" ||
                    (groupChoices.get(key) !== "remote" &&
                      here?.fingerprint !== bases[key] &&
                      there?.fingerprint === bases[key])
                  ) {
                    if (here) planned.set(key, here);
                    else planned.delete(key);
                  }
                }
                for (const [key, dependencies] of missingGitDependencyKeys(
                  remote,
                  planned,
                  local,
                )) {
                  // Keeping a local owner also retains its unchanged dependencies deleted remotely.
                  // Competing dependency edits remain separate user decisions.
                  if (
                    resolution?.choice === "local" &&
                    groupChoices.get(key) === "local" &&
                    dependencies.every(
                      (dependency) =>
                        local.has(dependency) &&
                        local.get(dependency)?.fingerprint === bases[dependency] &&
                        !remote.has(dependency) &&
                        !deferredUnavailable.has(dependency) &&
                        !groupedConflicts.has(dependency),
                    )
                  ) {
                    for (const dependency of dependencies)
                      for (const members of groups.values())
                        if (members.includes(dependency))
                          for (const member of members) groupChoices.set(member, "local");
                    grew = true;
                    continue;
                  }
                  for (const blocked of [key, ...dependencies]) {
                    const owner = planned.get(key)?.name ?? remote.get(key)?.name ?? "an asset";
                    const names = dependencies
                      .map(
                        (dependency) =>
                          itemSummaryAt(dependency, local, remote, knownItems)?.name ?? "an asset",
                      )
                      .join(", ");
                    conflictMessages[blocked] = (
                      blocked === key
                        ? `dependency_conflict: ${owner} requires ${names}. Resolve their deletion or competing changes together.`
                        : `resource_referenced: ${owner} still requires this asset. Resolve the reference before deleting it.`
                    ).slice(0, 2_000);
                    if (groupedConflicts.has(blocked)) continue;
                    groupedConflicts.add(blocked);
                    const parsed = PragmaForwardCompatibleResourceSchema.safeParse(
                      (remote.get(blocked) ?? local.get(blocked))?.data,
                    );
                    if (parsed.success) blockedRefs.add(canonicalPragmaResourceRef(parsed.data));
                    grew = true;
                  }
                }
              }
              if (!deletionKeys) {
                const plannedLocal: ItemMap = new Map(local);
                for (const key of keys) {
                  if (groupedConflicts.has(key) || deferredUnavailable.has(key)) continue;
                  const here = local.get(key);
                  const there = remote.get(key);
                  if (
                    groupChoices.get(key) === "remote" ||
                    (groupChoices.get(key) !== "local" &&
                      here?.fingerprint === bases[key] &&
                      there?.fingerprint !== bases[key])
                  ) {
                    if (there) plannedLocal.set(key, there);
                    else plannedLocal.delete(key);
                  }
                }
                for (const [key, dependencies] of missingGitDependencyKeys(
                  local,
                  plannedLocal,
                  remote,
                ))
                  for (const blocked of [key, ...dependencies]) {
                    const owner = plannedLocal.get(key)?.name ?? local.get(key)?.name ?? "an asset";
                    const names = dependencies
                      .map(
                        (dependency) =>
                          itemSummaryAt(dependency, local, remote, knownItems)?.name ?? "an asset",
                      )
                      .join(", ");
                    conflictMessages[blocked] = (
                      blocked === key
                        ? `dependency_conflict: ${owner} requires ${names}. Resolve their deletion or competing changes together.`
                        : `resource_referenced: ${owner} still requires this asset. Resolve the reference before deleting it.`
                    ).slice(0, 2_000);
                    if (groupedConflicts.has(blocked)) continue;
                    groupedConflicts.add(blocked);
                    const parsed = PragmaForwardCompatibleResourceSchema.safeParse(
                      (local.get(blocked) ?? remote.get(blocked))?.data,
                    );
                    if (parsed.success) blockedRefs.add(canonicalPragmaResourceRef(parsed.data));
                    grew = true;
                  }
              }
              for (const members of groups.values())
                if (members.some((key) => deferredUnavailable.has(key)))
                  for (const key of members) {
                    if (deferredUnavailable.has(key)) continue;
                    deferredUnavailable.add(key);
                    const parsed = PragmaForwardCompatibleResourceSchema.safeParse(
                      (remote.get(key) ?? local.get(key))?.data,
                    );
                    if (parsed.success)
                      unavailableRefs.add(canonicalPragmaResourceRef(parsed.data));
                    grew = true;
                  }
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
              for (const item of dependencyItems) {
                const parsed = PragmaForwardCompatibleResourceSchema.safeParse(item.data);
                if (!parsed.success || deferredUnavailable.has(item.key)) continue;
                if (
                  [...referencedPragmaResourceRefs([parsed.data])].some((ref) =>
                    unavailableRefs.has(ref),
                  )
                ) {
                  deferredUnavailable.add(item.key);
                  unavailableRefs.add(canonicalPragmaResourceRef(parsed.data));
                  grew = true;
                  continue;
                }
                if (groupedConflicts.has(item.key)) continue;
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
              if (deferredUnavailable.has(key)) {
                if (deletionKeys?.includes(key)) throw new Error(unavailableMessage);
                continue;
              }
              if (deletionKeys) {
                if (!deletionKeys.includes(key)) continue;
                if (nextRemote.delete(key)) pushNeeded = true;
                delete bases[key];
                continue;
              }
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
                  continue;
                }
                if (here) {
                  if (nameResolutionIssues.has(key)) continue;
                  nextRemote.set(key, here);
                  bases[key] = here.fingerprint;
                  pushNeeded = true;
                } else {
                  nextRemote.delete(key);
                  delete bases[key];
                  pushNeeded = true;
                }
                continue;
              }
              if (
                choice === "remote" ||
                (choice === undefined &&
                  ((!localChanged && remoteChanged) || (base === undefined && there && !here)))
              ) {
                let incoming = there;
                if (there && repairContextKeys.has(key)) {
                  const resource = PragmaForwardCompatibleResourceSchema.parse(there.data);
                  const storeId = classifyDesktopContextResource(resource);
                  if (resource.kind === "ContextStore" && storeId !== undefined) {
                    const authority = KnowledgeDataSchema.parse(
                      local.get(`knowledge:${storeId}`)?.data,
                    );
                    const data = bindExistingDesktopContextResource(resource, storeId, authority);
                    incoming = {
                      ...there,
                      name: authority.name,
                      data,
                      fingerprint: fingerprint(data),
                    };
                  }
                }
                changes.push({
                  key,
                  ...(revisions.has(key) ? { expectedRevision: revisions.get(key)! } : {}),
                  ...(here ? { local: here } : {}),
                  ...(incoming ? { remote: incoming } : {}),
                });
                if (there) bases[key] = there.fingerprint;
                else delete bases[key];
                continue;
              }
              if (here && there) conflicts.push(key);
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
            if (pushNeeded) assertGitAssetReferences(remote, nextRemote, local);
            const nextState = StateSchema.parse({
              ...state,
              repositoryInitialized: repositoryInitialized || pushNeeded,
              bases,
              unavailableItems,
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
              conflicts: deletionKeys
                ? state.conflicts.filter((key) => !deletionKeys.includes(key))
                : conflicts,
              conflictMessages: deletionKeys
                ? Object.fromEntries(
                    Object.entries(state.conflictMessages).filter(
                      ([key]) => !deletionKeys.includes(key),
                    ),
                  )
                : Object.fromEntries(
                    conflicts.flatMap((key) => {
                      const message = conflictMessages[key] ?? state.conflictMessages[key];
                      return message === undefined ? [] : [[key, message]];
                    }),
                  ),
              restoreConflicts: state.restoreConflicts.filter((key) =>
                deletionKeys ? !deletionKeys.includes(key) : conflicts.includes(key),
              ),
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
                  schemaVersion: "pragma.asset-sync-journal/v2",
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
                    unavailableItems,
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
            if (pushNeeded) {
              const deletions = [...remote.keys()].filter((key) => !nextRemote.has(key));
              if (deletions.length > 0) {
                const latest = await collect();
                if (
                  deletions.some((key) => latest.items.has(key)) ||
                  (await unavailableLocalAuthorities(latest.items, deletions)).size > 0
                )
                  throw new LocalHeadChangedError();
              }
              await publishRepository(checkout, nextRemote);
            }
            nextState.syncedAt = new Date().toISOString();
            await writeState(nextState);
            lastError = undefined;
            running = false;
            return await makeOverview(config, nextState, nextRemote);
          } catch (error) {
            if (
              (error instanceof RemoteHeadChangedError || error instanceof LocalHeadChangedError) &&
              attempt < 2
            )
              continue;
            throw error;
          } finally {
            await rm(checkout.root, { recursive: true, force: true });
          }
        }
        throw new RemoteHeadChangedError();
      } catch (error) {
        lastError =
          error instanceof Error ? redactGitDiagnostic(error.message) : "Synchronization failed.";
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
      await mkdir(dirname(options.statePath), { recursive: true });
      const snapshot = await readCurrentAssetSyncOwner(
        options.configurationPath,
        options.statePath,
        { executionActive: running },
      );
      const { config, state: storedState } =
        snapshot ??
        (await withFileLock(`${options.statePath}.lock`, async () => {
          const config = await readConfigUnlocked();
          return {
            config,
            state: config === undefined ? undefined : await readState(sourceKey(config)),
          };
        }));
      if (config === undefined) return await makeOverview(undefined);
      const state =
        storedState?.source === sourceKey(config)
          ? storedState
          : await readState(sourceKey(config));
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
        schemaVersion: "pragma.asset-sync-settings/v2",
      });
      await withFileLock(`${options.statePath}.lock`, async () => {
        const previous = await readConfigUnlocked();
        if (previous === undefined || sourceKey(previous) !== sourceKey(config))
          await rm(journalPath, { force: true });
        await writeAtomic(options.configurationPath, config);
      });
      return await run("full");
    },
    async removeConfiguration() {
      await withFileLock(`${options.statePath}.lock`, async () => {
        await upgradeAssetSyncOwner(options.configurationPath, options.statePath);
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
    deleteRemote: async (key) => await run("full", { key, choice: "delete" }),
  };
}

type CoreAssetSyncItemSummary = Pick<CoreAssetSyncItem, "key" | "kind" | "name" | "fingerprint"> & {
  readonly data?: unknown;
};

function missingGitDependencyKeys(
  previous: ItemMap,
  next: ItemMap,
  local: ItemMap,
): Map<string, string[]> {
  const knownRefs = new Map<string, string>();
  const availableRefs = new Set<string>();
  for (const [key, item] of [...previous, ...local]) {
    const parsed = PragmaForwardCompatibleResourceSchema.safeParse(item.data);
    if (parsed.success) knownRefs.set(canonicalPragmaResourceRef(parsed.data), key);
  }
  for (const item of next.values()) {
    const parsed = PragmaForwardCompatibleResourceSchema.safeParse(item.data);
    if (parsed.success) availableRefs.add(canonicalPragmaResourceRef(parsed.data));
  }
  const missing = new Map<string, string[]>();
  for (const [key, item] of next) {
    const parsed = PragmaForwardCompatibleResourceSchema.safeParse(item.data);
    if (!parsed.success) continue;
    const resource = parsed.data;
    const dependencies = [...referencedPragmaResourceRefs([resource])].flatMap((ref) => {
      const target = knownRefs.get(ref);
      return target !== undefined && !availableRefs.has(ref) ? [target] : [];
    });
    const storeId = classifyDesktopContextResource(resource);
    const capability = classifyDesktopCapabilityResource(resource);
    const payloads = storeId
      ? [`knowledge:${storeId}`]
      : capability
        ? [`capability:${capability.id}`, `skill:${capability.id}`]
        : [];
    const known = payloads.filter((candidate) => previous.has(candidate) || local.has(candidate));
    if (known.length > 0 && !payloads.some((candidate) => next.has(candidate)))
      dependencies.push(...known);
    if (dependencies.length > 0) missing.set(key, dependencies);
  }
  return missing;
}

function assertGitAssetReferences(previous: ItemMap, next: ItemMap, local: ItemMap): void {
  const removedKeys = new Set([...previous.keys()].filter((key) => !next.has(key)));
  const resourceRefs = (items: ItemMap) =>
    new Map(
      [...items.values()].flatMap((item) => {
        const parsed = PragmaForwardCompatibleResourceSchema.safeParse(item.data);
        return parsed.success
          ? [[canonicalPragmaResourceRef(parsed.data), parsed.data.metadata.name] as const]
          : [];
      }),
    );
  const availableRefs = resourceRefs(next);
  const previousRefs = resourceRefs(previous);
  const knownRefs = new Map([...resourceRefs(local), ...previousRefs]);
  for (const item of next.values()) {
    const parsed = PragmaForwardCompatibleResourceSchema.safeParse(item.data);
    if (!parsed.success) continue;
    const resource = parsed.data;
    const capability = classifyDesktopCapabilityResource(resource);
    const storeId = classifyDesktopContextResource(resource);
    if (
      [...referencedPragmaResourceRefs([resource])].some(
        (ref) => previousRefs.has(ref) && !availableRefs.has(ref),
      ) ||
      (capability &&
        (removedKeys.has(`capability:${capability.id}`) ||
          removedKeys.has(`skill:${capability.id}`))) ||
      (storeId && removedKeys.has(`knowledge:${storeId}`))
    )
      throw new Error(
        `The Git asset is still referenced by ${resource.metadata.name} in Git, even if it was deleted locally. Update or delete that Git reference first.`,
      );
    const missing = [...referencedPragmaResourceRefs([resource])].find(
      (ref) => knownRefs.has(ref) && !availableRefs.has(ref),
    );
    const missingCapability =
      capability &&
      [previous, local].some(
        (items) => items.has(`capability:${capability.id}`) || items.has(`skill:${capability.id}`),
      ) &&
      !next.has(`capability:${capability.id}`) &&
      !next.has(`skill:${capability.id}`);
    const missingKnowledge =
      storeId &&
      [previous, local].some((items) => items.has(`knowledge:${storeId}`)) &&
      !next.has(`knowledge:${storeId}`);
    // Host-provided external refs are not exported. Only synchronized authorities
    // participate in this graph, including local dependencies deferred by conflicts.
    if (missing || missingCapability || missingKnowledge)
      throw new Error(
        `The Git asset ${resource.metadata.name} requires ${missing ? knownRefs.get(missing) : "an asset"} that is missing from Git. Resolve that dependency first.`,
      );
  }
}

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

class LocalHeadChangedError extends Error {
  constructor() {
    super(
      "asset_sync.local_changed: Local resources changed during synchronization. Retrying with the latest local state.",
    );
  }
}

export function unavailableCoreAssetRuntimeBindings(
  rootRef: string,
  resources: readonly PragmaResource[],
  runtimes: readonly DesktopRuntimeAvailability[],
  options: { validateModels?: boolean } = {},
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
        (options.validateModels !== false && model === undefined) ||
        (options.validateModels !== false &&
          config.thinkingLevel !== undefined &&
          !model?.thinking?.supportedLevels.some((level) => level.value === config.thinkingLevel))
      )
        unavailable.push({ ref, name: resource.metadata.name });
    }
    for (const dependency of referencedPragmaResourceRefs([resource])) queue.push(dependency);
  }
  return unavailable;
}
