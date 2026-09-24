import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, opendir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { validateSkillPackage } from "@pragma/built-in-agents";
import { withFileLock } from "@pragma/core";
import { parse, stringify } from "yaml";

import {
  CapabilityIdSchema,
  SkillSyncConfigurationSchema,
  SkillSyncOverviewSchema,
  SkillSyncSkillManifestSchema,
  type Capability,
  type SkillSyncConfiguration,
  type SkillSyncIdentity,
  type SkillSyncOverview,
  type SkillSyncSkillManifest,
  type UpdateSkillSyncConfiguration,
} from "../../../shared/contracts/index.ts";
import type { CapabilityStore } from "./capability-store.ts";
import { scanSkillWorkingTree } from "./skill-revision-draft-store.ts";
import {
  backupSourceKey,
  type BackupProviderHead,
  canonicalBackupRemote,
  resolvedReferenceChanged,
  sourceChanged,
  type StudioBackupProvider,
} from "../studio-sync/studio-backup-sync.ts";
import {
  PendingSkillRemoteActivationSchema as PendingRemoteActivationSchema,
  SkillSyncStateV2Schema as SkillSyncStateSchema,
  StoredPortableSkillFilesSchema as StoredPortableFilesSchema,
  skillSyncStateMigrationChain,
  type SkillSyncStateV2 as SkillSyncState,
} from "../studio-sync/migrations/skill-sync/index.ts";
import { readStudioSyncState } from "../studio-sync/studio-sync-state-migration.ts";
import type { AssetGitService } from "../asset-git/asset-git-service.ts";
import type { AssetGitSource } from "../../../shared/contracts/index.ts";
import {
  upgradeSkillRepositoryManifest,
  upgradeSkillManifest,
} from "../studio-sync/asset-git-protocol-migrations.ts";

const execFileAsync = promisify(execFile);
const ROOT_MANIFEST = "pragma-skill-sync.yaml";
const SKILLS_DIRECTORY = "skills";
const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_REPOSITORY_SKILLS = 500;
const MAX_REPOSITORY_BYTES = 25 * 1024 * 1024;
const MAX_GIT_INDEX_RECORD_BYTES = 16 * 1024;
const GIT_TIMEOUT_MS = 60_000;
type SyncIntent = "full" | "pull_only" | "restore";

export type RemoteSkillFile = {
  readonly path: string;
  readonly content: string;
  readonly executable: boolean;
};

export type RemoteSkill = {
  readonly identity: SkillSyncIdentity;
  readonly name: string;
  readonly description: string;
  readonly files: readonly RemoteSkillFile[];
  readonly assetGit?: AssetGitSource | undefined;
};

export type RemoteSkillRepository = { readonly skills: ReadonlyMap<string, RemoteSkill> };
export type SkillSyncProviderHead = BackupProviderHead<RemoteSkillRepository>;

export type SkillSyncProvider = StudioBackupProvider<RemoteSkillRepository>;

type LocalSkill = RemoteSkill & {
  readonly capabilityId: string;
  readonly capabilityRevision: number;
  readonly capabilityContentHash: string;
};

type LocalSkillSnapshot = {
  readonly skills: Map<string, LocalSkill>;
  readonly errors: SkillSyncState["errors"];
};
const emptyState = (sourceKey?: string): SkillSyncState => ({
  schemaVersion: "pragma.skill-sync-state/v2",
  ...(sourceKey === undefined ? {} : { sourceKey }),
  bases: {},
  portableFiles: {},
  pendingRemoteActivations: {},
  ignoredRemote: [],
  conflicts: {},
  errors: {},
});

export interface SkillSyncService {
  getOverview(): Promise<SkillSyncOverview>;
  configure(
    input: Omit<UpdateSkillSyncConfiguration, "initializationMode"> &
      Partial<Pick<UpdateSkillSyncConfiguration, "initializationMode">>,
  ): Promise<SkillSyncOverview>;
  removeConfiguration(): Promise<void>;
  sync(): Promise<SkillSyncOverview>;
  refresh(): Promise<SkillSyncOverview>;
  schedule(reason: string): void;
  resolveConflict(syncKey: string, choice: "local" | "remote"): Promise<SkillSyncOverview>;
  restoreIgnored(syncKey: string): Promise<SkillSyncOverview>;
}

export function createSkillSyncService(options: {
  readonly configurationPath: string;
  readonly statePath: string;
  readonly cacheRoot: string;
  readonly capabilities: CapabilityStore;
  readonly assetGit?: (() => AssetGitService | undefined) | undefined;
  readonly provider?: SkillSyncProvider | undefined;
  readonly providerFactory?:
    ((configuration: SkillSyncConfiguration) => SkillSyncProvider) | undefined;
  readonly supportsExecutableBits?: boolean | undefined;
  readonly warn?: ((message: string, error: unknown) => void) | undefined;
}): SkillSyncService {
  const lockPath = `${options.statePath}.lock`;
  let running: Promise<SkillSyncOverview> | undefined;
  let rerun = false;
  let requestedIntent: SyncIntent = "pull_only";
  let scheduled: NodeJS.Timeout | undefined;
  let transientStatus: "ready" | "syncing" | "conflict" | "error" = "ready";

  const providerFor = (configuration: SkillSyncConfiguration): SkillSyncProvider =>
    options.provider ??
    options.providerFactory?.(configuration) ??
    createGitSkillSyncProvider(options.cacheRoot, configuration);

  const readConfiguration = async (): Promise<SkillSyncConfiguration | undefined> => {
    try {
      return SkillSyncConfigurationSchema.parse(
        JSON.parse(await readFile(options.configurationPath, "utf8")),
      );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
  };
  const readState = async (): Promise<SkillSyncState> => {
    const configuration = await readConfiguration();
    return await readStudioSyncState({
      statePath: options.statePath,
      chain: skillSyncStateMigrationChain,
      onMissing: emptyState,
      finalizeMigrated: (state) =>
        state.sourceKey !== undefined || configuration === undefined
          ? state
          : SkillSyncStateSchema.parse({
              ...state,
              sourceKey: backupSourceKey(configuration),
            }),
    });
  };
  const writeState = async (state: SkillSyncState): Promise<void> =>
    await writeJsonAtomic(options.statePath, SkillSyncStateSchema.parse(state));

  const localSkills = async (knownState?: SkillSyncState): Promise<LocalSkillSnapshot> => {
    const state = knownState ?? (await readState());
    const skills = new Map<string, LocalSkill>();
    const errors: SkillSyncState["errors"] = {};
    const seenKeys = new Set<string>();
    for (const capability of await options.capabilities.list()) {
      if (capability.managedBy === "system" || capability.definition.kind !== "skill") continue;
      const identity = syncIdentity(capability);
      const syncKey = identityKey(identity);
      if (seenKeys.has(syncKey)) {
        skills.delete(syncKey);
        errors[syncKey] = {
          source: "local",
          code: "duplicate_skill_identity",
          message: `Multiple Skills claim ${syncKey}.`,
          name: capability.definition.name,
          capabilityId: capability.manifest.id,
        };
        continue;
      }
      seenKeys.add(syncKey);
      try {
        const root = await options.capabilities.skillFilesPath(
          capability.manifest.id,
          capability.manifest.latestRevision,
        );
        const snapshot = await scanSkillWorkingTree(root);
        const portable = state.portableFiles[syncKey];
        const exactStoredPortableSnapshot =
          portable?.capabilityRevision === capability.manifest.latestRevision &&
          portable.capabilityContentHash === capability.definition.contentHash;
        const pendingActivation = state.pendingRemoteActivations[syncKey];
        const exactPendingActivation =
          pendingActivation !== undefined &&
          pendingActivation.files.length === snapshot.entries.length &&
          pendingActivation.files.every(
            (file) =>
              snapshot.entries.find((entry) => entry.path === file.path)?.sha256 === file.sha256,
          );
        const storedPortableFiles =
          portable?.capabilityId === capability.manifest.id ? portable.files : [];
        const portableFiles = new Map(
          (exactPendingActivation ? pendingActivation.files : storedPortableFiles).map((file) => [
            file.path,
            file,
          ]),
        );
        const exactPortableSnapshot = exactStoredPortableSnapshot || exactPendingActivation;
        const supportsExecutableBits =
          options.supportsExecutableBits ?? process.platform !== "win32";
        const files: RemoteSkillFile[] = [];
        for (const entry of snapshot.entries) {
          const bytes = await readFile(safeChild(root, entry.path));
          const content = bytes.toString("utf8");
          if (!Buffer.from(content, "utf8").equals(bytes)) {
            throw coded("skill_sync_binary_file", `Skill file is not UTF-8 text: ${entry.path}`);
          }
          files.push({
            path: entry.path,
            content,
            executable:
              exactPortableSnapshot || !supportsExecutableBits
                ? (portableFiles?.get(entry.path)?.executable ?? entry.executable)
                : entry.executable,
          });
        }
        const skill = {
          identity,
          capabilityId: capability.manifest.id,
          capabilityRevision: capability.manifest.latestRevision,
          capabilityContentHash: capability.definition.contentHash,
          name: capability.definition.name,
          description: capability.definition.description,
          files,
          assetGit: await options
            .assetGit?.()
            ?.source({ kind: "skill", id: capability.manifest.id }),
        };
        validateRemoteSkill(skill);
        skills.set(syncKey, skill);
      } catch (error) {
        errors[syncKey] = {
          source: "local",
          code: errorCode(error),
          message: errorMessage(error),
          name: capability.definition.name,
          capabilityId: capability.manifest.id,
        };
      }
    }
    return { skills, errors };
  };

  const localSkillsForOverview = async (
    state?: SkillSyncState,
  ): Promise<Map<string, LocalSkill>> => {
    try {
      return (await localSkills(state)).skills;
    } catch {
      return new Map();
    }
  };

  const applyRemote = async (
    syncKey: string,
    remote: RemoteSkill | undefined,
    local: LocalSkill | undefined,
  ): Promise<Capability | undefined> => {
    if (remote === undefined) {
      if (local !== undefined)
        await options.capabilities.remove(local.capabilityId, local.capabilityRevision);
      return undefined;
    }
    validateRemoteSkill(remote);
    const incoming = join(options.cacheRoot, "incoming", randomUUID());
    try {
      await writeSkillTree(incoming, remote);
      const snapshot = await scanSkillWorkingTree(incoming);
      if (local === undefined) {
        const created = await options.capabilities.publishNewSkillRevisionCandidate({
          id: remote.identity.id,
          name: remote.name,
          description: remote.description,
          sourcePath: incoming,
          candidateContentHash: snapshot.hash,
        });
        if (remote.assetGit)
          await options
            .assetGit?.()
            ?.restoreSource({ kind: "skill", id: created.manifest.id }, remote.assetGit);
        else await options.assetGit?.()?.unbind({ kind: "skill", id: created.manifest.id });
        return created;
      } else {
        const updated = await options.capabilities.publishSkillRevisionCandidate({
          id: local.capabilityId,
          baseRevision: local.capabilityRevision,
          baseContentHash: local.capabilityContentHash,
          sourcePath: incoming,
          candidateContentHash: snapshot.hash,
        });
        if (remote.assetGit)
          await options
            .assetGit?.()
            ?.restoreSource({ kind: "skill", id: updated.manifest.id }, remote.assetGit);
        else await options.assetGit?.()?.unbind({ kind: "skill", id: updated.manifest.id });
        return updated;
      }
    } finally {
      await rm(incoming, { recursive: true, force: true });
    }
  };

  const reconcile = async (
    configuration: SkillSyncConfiguration,
    state: SkillSyncState,
    head: SkillSyncProviderHead,
    intent: SyncIntent,
  ): Promise<{
    state: SkillSyncState;
    repository: RemoteSkillRepository;
    publishedKeys: readonly string[];
    publishedSnapshots: ReadonlyMap<string, LocalSkill | undefined>;
  }> => {
    const localSnapshot = await localSkills(state);
    const local = localSnapshot.skills;
    const remote = new Map(head.repository.skills);
    const desired = new Map(remote);
    const bases = { ...state.bases };
    const portableFiles = { ...state.portableFiles };
    const pendingRemoteActivations = { ...state.pendingRemoteActivations };
    const conflicts = { ...state.conflicts };
    const errors = Object.fromEntries(
      Object.entries(state.errors).filter(([, error]) => error.source === "remote"),
    ) as SkillSyncState["errors"];
    let ignoredRemote = [...state.ignoredRemote];
    const publishedKeys: string[] = [];
    const publishedSnapshots = new Map<string, LocalSkill | undefined>();
    Object.assign(errors, localSnapshot.errors);
    const checkpointState = (): SkillSyncState =>
      SkillSyncStateSchema.parse({
        ...state,
        bases,
        portableFiles,
        pendingRemoteActivations,
        conflicts,
        errors,
        ignoredRemote,
        revision: head.revision,
        resolvedBranch: head.reference,
      });
    const keys = new Set([
      ...local.keys(),
      ...remote.keys(),
      ...Object.keys(bases),
      ...Object.keys(conflicts),
      ...Object.keys(errors),
      ...Object.keys(localSnapshot.errors),
    ]);
    for (const key of [...keys].toSorted()) {
      const localSkill = local.get(key);
      const remoteSkill = remote.get(key);
      if (localSnapshot.errors[key] !== undefined) continue;
      const localFingerprint = fingerprint(localSkill);
      const remoteFingerprint = fingerprint(remoteSkill);
      const base = bases[key];
      if (localFingerprint === remoteFingerprint) {
        delete pendingRemoteActivations[key];
        if (localFingerprint === "absent") {
          delete bases[key];
          delete portableFiles[key];
        } else {
          bases[key] = localFingerprint;
          if (localSkill !== undefined) portableFiles[key] = portableFilesForLocal(localSkill);
        }
        delete conflicts[key];
        delete errors[key];
        ignoredRemote = ignoredRemote.filter((item) => item.syncKey !== key);
        continue;
      }
      if (intent === "restore") {
        if (remoteSkill !== undefined) {
          pendingRemoteActivations[key] = pendingRemoteActivationFor(remoteSkill);
          await writeState(checkpointState());
        }
        try {
          const applied = await applyRemote(key, remoteSkill, localSkill);
          if (remoteSkill === undefined || applied === undefined) {
            delete bases[key];
            delete portableFiles[key];
          } else {
            bases[key] = remoteFingerprint;
            portableFiles[key] = portableFilesFor(applied, remoteSkill);
          }
          delete pendingRemoteActivations[key];
          delete conflicts[key];
          delete errors[key];
          await writeState(checkpointState());
        } catch (error) {
          delete pendingRemoteActivations[key];
          errors[key] = {
            source: "remote",
            code: errorCode(error),
            message: errorMessage(error),
            name: remoteSkill?.name ?? localSkill?.name,
            capabilityId: localSkill?.capabilityId,
          };
          await writeState(checkpointState());
        }
        continue;
      }
      const localChanged =
        base === undefined ? localSkill !== undefined : localFingerprint !== base;
      const remoteChanged =
        base === undefined ? remoteSkill !== undefined : remoteFingerprint !== base;
      if (localChanged && remoteChanged) {
        conflicts[key] = {
          remoteRevision: head.revision ?? "unborn",
          local: summary(localSkill),
          remote: summary(remoteSkill),
        };
        delete errors[key];
        continue;
      }
      if (remoteChanged) {
        if (remoteSkill !== undefined) {
          pendingRemoteActivations[key] = pendingRemoteActivationFor(remoteSkill);
          await writeState(checkpointState());
        }
        try {
          const applied = await applyRemote(key, remoteSkill, localSkill);
          if (remoteSkill === undefined || applied === undefined) {
            delete bases[key];
            delete portableFiles[key];
          } else {
            bases[key] = remoteFingerprint;
            portableFiles[key] = portableFilesFor(applied, remoteSkill);
          }
          delete pendingRemoteActivations[key];
          delete errors[key];
          delete conflicts[key];
          ignoredRemote = ignoredRemote.filter((item) => item.syncKey !== key);
          await writeState(checkpointState());
        } catch (error) {
          delete pendingRemoteActivations[key];
          if (errorCode(error) === "revision_conflict") {
            await writeState(checkpointState());
            throw coded(
              "skill_sync_local_changed",
              `The local Skill changed during synchronization: ${key}`,
            );
          }
          errors[key] = {
            source: "remote",
            code: errorCode(error),
            message: errorMessage(error),
            name: remoteSkill?.name ?? localSkill?.name,
            capabilityId: localSkill?.capabilityId,
          };
          await writeState(checkpointState());
        }
        continue;
      }
      if (intent === "pull_only") continue;
      if (localSkill === undefined && remoteSkill !== undefined && !configuration.pushDeletions) {
        ignoredRemote = [
          ...ignoredRemote.filter((item) => item.syncKey !== key),
          { syncKey: key, name: remoteSkill.name },
        ];
        continue;
      }
      if (localSkill === undefined) desired.delete(key);
      else {
        desired.set(key, localSkill);
        portableFiles[key] = portableFilesForLocal(localSkill);
      }
      publishedKeys.push(key);
      publishedSnapshots.set(key, localSkill);
      delete conflicts[key];
      delete errors[key];
      ignoredRemote = ignoredRemote.filter((item) => item.syncKey !== key);
    }
    return {
      repository: { skills: desired },
      publishedKeys,
      publishedSnapshots,
      state: SkillSyncStateSchema.parse({
        ...state,
        bases,
        portableFiles,
        pendingRemoteActivations,
        conflicts,
        errors,
        ignoredRemote,
        revision: head.revision,
        resolvedBranch: head.reference,
        errorCode: undefined,
        errorMessage: undefined,
      }),
    };
  };

  const runLocked = async (
    configuration: SkillSyncConfiguration,
    intent: SyncIntent,
  ): Promise<SkillSyncOverview> => {
    transientStatus = "syncing";
    const provider = providerFor(configuration);
    let state = await readState();
    const sourceKey = backupSourceKey(configuration);
    if (sourceChanged(state.sourceKey, configuration)) state = emptyState(sourceKey);
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const head = await provider.readHead();
        if (resolvedReferenceChanged(state.resolvedBranch, head.reference)) {
          state = emptyState(sourceKey);
        }
        let result: Awaited<ReturnType<typeof reconcile>>;
        try {
          result = await reconcile(configuration, state, head, intent);
        } catch (error) {
          if (errorCode(error) === "skill_sync_local_changed") continue;
          throw error;
        }
        state = result.state;
        if (result.publishedKeys.length > 0 && intent === "full") {
          const latestLocal = await localSkills(state);
          if (
            result.publishedKeys.some(
              (key) =>
                latestLocal.errors[key] !== undefined ||
                !sameLocalSnapshot(result.publishedSnapshots.get(key), latestLocal.skills.get(key)),
            )
          ) {
            continue;
          }
          const published = await provider.publish({
            expectedRevision: head.revision,
            repository: result.repository,
            message: "Synchronize Pragma Skills",
          });
          if (published.status === "head_changed") continue;
          state = SkillSyncStateSchema.parse({ ...state, revision: published.revision });
          for (const key of result.publishedKeys) {
            const skill = result.repository.skills.get(key);
            if (skill === undefined) delete state.bases[key];
            else state.bases[key] = fingerprint(skill);
          }
          const postPublishLocal = await localSkills(state);
          if (
            result.publishedKeys.some(
              (key) =>
                postPublishLocal.errors[key] !== undefined ||
                !sameLocalSnapshot(
                  result.publishedSnapshots.get(key),
                  postPublishLocal.skills.get(key),
                ),
            )
          ) {
            continue;
          }
        }
        state = SkillSyncStateSchema.parse({ ...state, syncedAt: new Date().toISOString() });
        await writeState(state);
        transientStatus = settledStatus(state);
        return await buildOverview(
          configuration,
          state,
          await localSkillsForOverview(state),
          transientStatus,
        );
      }
      throw coded(
        "skill_sync_head_changed",
        "The local or remote Skill repository changed repeatedly. Try again.",
      );
    } catch (error) {
      state = SkillSyncStateSchema.parse({
        ...state,
        errorCode: errorCode(error),
        errorMessage: errorMessage(error),
      });
      await writeState(state);
      transientStatus = "error";
      return await buildOverview(
        configuration,
        state,
        await localSkillsForOverview(state),
        "error",
      );
    }
  };

  const runSync = (intent: SyncIntent): Promise<SkillSyncOverview> => {
    if (running === undefined) requestedIntent = intent;
    else if (intent === "restore" || (intent === "full" && requestedIntent === "pull_only")) {
      requestedIntent = intent;
    }
    if (running !== undefined) {
      rerun = true;
      return running;
    }
    running = withFileLock(lockPath, async () => {
      let result: SkillSyncOverview;
      do {
        rerun = false;
        const nextIntent = requestedIntent;
        requestedIntent = "pull_only";
        const configuration = await readConfiguration();
        result =
          configuration === undefined
            ? unconfiguredOverview()
            : await runLocked(configuration, nextIntent);
      } while (rerun);
      return result;
    }).finally(() => {
      running = undefined;
    });
    return running;
  };

  return {
    async getOverview() {
      const configuration = await readConfiguration();
      if (configuration === undefined) return unconfiguredOverview();
      return await withFileLock(lockPath, async () => {
        const state = await readState();
        return await buildOverview(
          configuration,
          state,
          await localSkillsForOverview(state),
          transientStatus === "syncing" ? "syncing" : settledStatus(state),
        );
      });
    },
    async configure(input) {
      const { initializationMode = "merge_and_publish", ...settings } = input;
      const configuration = SkillSyncConfigurationSchema.parse({
        schemaVersion: "pragma.skill-sync-settings/v1",
        ...settings,
      });
      await withFileLock(lockPath, async () => {
        const head = await providerFor(configuration).readHead();
        const previous = await readConfiguration();
        await writeJsonAtomic(options.configurationPath, configuration);
        if (
          previous === undefined ||
          canonicalBackupRemote(previous.remote) !== canonicalBackupRemote(configuration.remote) ||
          previous.branch !== configuration.branch
        ) {
          await writeState(emptyState(backupSourceKey(configuration)));
        }
        void head;
      });
      return await runSync(initializationMode === "restore_remote" ? "restore" : "full");
    },
    async removeConfiguration() {
      if (scheduled !== undefined) clearTimeout(scheduled);
      scheduled = undefined;
      await withFileLock(lockPath, async () => {
        await rm(options.configurationPath, { force: true });
        await rm(options.statePath, { force: true });
        await rm(options.cacheRoot, { recursive: true, force: true });
      });
      transientStatus = "ready";
    },
    sync: () => runSync("full"),
    refresh: () => runSync("pull_only"),
    schedule(reason) {
      if (scheduled !== undefined) clearTimeout(scheduled);
      const localChange = reason === "skill-published" || reason === "skill-removed";
      scheduled = setTimeout(
        () => {
          scheduled = undefined;
          void (async () => {
            const configuration = await readConfiguration();
            if (configuration === undefined || (localChange && !configuration.autoPush)) return;
            await runSync(localChange ? "full" : "pull_only");
          })().catch((error: unknown) => options.warn?.("Scheduled Skill sync failed.", error));
        },
        localChange ? 750 : 0,
      );
      scheduled.unref();
    },
    async resolveConflict(syncKey, choice) {
      return await withFileLock(lockPath, async () => {
        const configuration = await readConfiguration();
        if (configuration === undefined) return unconfiguredOverview();
        const state = await readState();
        const conflict = state.conflicts[syncKey];
        if (conflict === undefined)
          return await buildOverview(
            configuration,
            state,
            await localSkillsForOverview(state),
            transientStatus === "syncing" ? "syncing" : settledStatus(state),
          );
        const provider = providerFor(configuration);
        const head = await provider.readHead();
        if (
          sourceChanged(state.sourceKey, configuration) ||
          state.resolvedBranch !== head.reference ||
          (head.revision ?? "unborn") !== conflict.remoteRevision
        ) {
          throw coded(
            "skill_sync_conflict_stale",
            "The remote repository changed. Synchronize again.",
          );
        }
        const local = await localSkills(state);
        let localSkill = local.skills.get(syncKey);
        if (fingerprint(localSkill) !== conflict.local.fingerprint) {
          throw coded("skill_sync_conflict_stale", "The local Skill changed. Synchronize again.");
        }
        if (choice === "remote") {
          const remoteSkill = head.repository.skills.get(syncKey);
          if (remoteSkill !== undefined) {
            state.pendingRemoteActivations[syncKey] = pendingRemoteActivationFor(remoteSkill);
            await writeState(state);
          }
          try {
            const applied = await applyRemote(syncKey, remoteSkill, localSkill);
            if (remoteSkill === undefined || applied === undefined)
              delete state.portableFiles[syncKey];
            else state.portableFiles[syncKey] = portableFilesFor(applied, remoteSkill);
            delete state.pendingRemoteActivations[syncKey];
            await writeState(state);
          } catch (error) {
            delete state.pendingRemoteActivations[syncKey];
            await writeState(state);
            throw error;
          }
        } else {
          let publishHead = head;
          let selectedLocal = localSkill;
          let resolved = false;
          for (let attempt = 0; attempt < 5; attempt += 1) {
            const latestBeforePublish = await localSkills(state);
            if (latestBeforePublish.errors[syncKey] !== undefined) {
              throw coded(
                "skill_sync_conflict_stale",
                "The local Skill changed. Synchronize again.",
              );
            }
            selectedLocal = latestBeforePublish.skills.get(syncKey);
            const desired = new Map(publishHead.repository.skills);
            if (selectedLocal === undefined) desired.delete(syncKey);
            else desired.set(syncKey, selectedLocal);
            const published = await provider.publish({
              expectedRevision: publishHead.revision,
              repository: { skills: desired },
              message: `Resolve Skill sync conflict for ${syncKey}`,
            });
            if (published.status === "head_changed") {
              throw coded(
                "skill_sync_conflict_stale",
                "The remote repository changed. Synchronize again.",
              );
            }
            state.revision = published.revision;
            const latestAfterPublish = await localSkills(state);
            if (latestAfterPublish.errors[syncKey] !== undefined) {
              throw coded(
                "skill_sync_conflict_stale",
                "The local Skill changed. Synchronize again.",
              );
            }
            const afterPublish = latestAfterPublish.skills.get(syncKey);
            if (sameLocalSnapshot(selectedLocal, afterPublish)) {
              selectedLocal = afterPublish;
              resolved = true;
              break;
            }
            selectedLocal = afterPublish;
            publishHead = {
              revision: published.revision,
              reference: publishHead.reference,
              repository: { skills: desired },
            };
          }
          if (!resolved) {
            throw coded(
              "skill_sync_local_changed",
              `The local Skill changed repeatedly while resolving ${syncKey}.`,
            );
          }
          if (selectedLocal === undefined) delete state.portableFiles[syncKey];
          else state.portableFiles[syncKey] = portableFilesForLocal(selectedLocal);
          localSkill = selectedLocal;
        }
        const remote = choice === "local" ? localSkill : head.repository.skills.get(syncKey);
        if (remote === undefined) delete state.bases[syncKey];
        else state.bases[syncKey] = fingerprint(remote);
        delete state.conflicts[syncKey];
        delete state.errors[syncKey];
        state.ignoredRemote = state.ignoredRemote.filter((item) => item.syncKey !== syncKey);
        state.errorCode = undefined;
        state.errorMessage = undefined;
        state.syncedAt = new Date().toISOString();
        await writeState(state);
        transientStatus = settledStatus(state);
        return await buildOverview(
          configuration,
          state,
          await localSkillsForOverview(state),
          transientStatus,
        );
      });
    },
    async restoreIgnored(syncKey) {
      await withFileLock(lockPath, async () => {
        const state = await readState();
        delete state.bases[syncKey];
        state.ignoredRemote = state.ignoredRemote.filter((item) => item.syncKey !== syncKey);
        await writeState(state);
      });
      return await runSync("full");
    },
  };
}

export function createGitSkillSyncProvider(
  cacheRoot: string,
  configuration: SkillSyncConfiguration,
  options: {
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly beforePush?: (() => Promise<void>) | undefined;
  } = {},
): SkillSyncProvider {
  const repositoryPath = join(cacheRoot, "repository");
  const environment = { ...process.env, ...options.env };
  const git = (
    repository: string | undefined,
    args: readonly string[],
    overrides: NodeJS.ProcessEnv = {},
  ) => runGit(repository, args, { ...environment, ...overrides });
  const remoteRevision = async (branch: string): Promise<string | undefined> =>
    (await git(repositoryPath, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]))
      .trim()
      .split(/\s+/u)[0] || undefined;
  const prepare = async (): Promise<{ reference: string; revision?: string }> => {
    await ensureGitRepository(repositoryPath, configuration.remote, git);
    await installManagedPathAttributes(repositoryPath);
    const advertised = await git(repositoryPath, ["ls-remote", "--symref", "origin", "HEAD"]);
    const defaultBranch = /^ref: refs\/heads\/([^\s]+)\s+HEAD$/mu.exec(advertised)?.[1];
    const reference = configuration.branch ?? defaultBranch ?? "main";
    await git(undefined, ["check-ref-format", "--branch", reference]);
    const revision = await remoteRevision(reference);
    if (revision === undefined) {
      await git(repositoryPath, ["read-tree", "--empty"]);
      await rm(join(repositoryPath, SKILLS_DIRECTORY), { recursive: true, force: true });
      await rm(join(repositoryPath, ROOT_MANIFEST), { force: true });
    } else {
      await git(repositoryPath, [
        "fetch",
        "--force",
        "--depth=50",
        "origin",
        `refs/heads/${reference}`,
      ]);
      await git(repositoryPath, ["checkout", "--detach", "--force", "FETCH_HEAD"]);
      await git(repositoryPath, ["reset", "--hard", "FETCH_HEAD"]);
    }
    await git(repositoryPath, ["clean", "-fdx", "--", ROOT_MANIFEST, SKILLS_DIRECTORY]);
    return { reference, ...(revision === undefined ? {} : { revision }) };
  };
  return {
    async readHead() {
      const prepared = await prepare();
      const fileModes = await readGitFileModes(repositoryPath, environment);
      return { ...prepared, repository: await readWorkingRepository(repositoryPath, fileModes) };
    },
    async publish(input) {
      const prepared = await prepare();
      if (prepared.revision !== input.expectedRevision) return { status: "head_changed" };
      const identity = await readGlobalGitIdentity(git);
      await writeWorkingRepository(repositoryPath, input.repository);
      await git(repositoryPath, ["add", "--force", "--", ROOT_MANIFEST, SKILLS_DIRECTORY]);
      await stageGitFileModes(repositoryPath, input.repository, git);
      const tree = (await git(repositoryPath, ["write-tree"])).trim();
      const args = ["commit-tree", tree];
      if (prepared.revision !== undefined) args.push("-p", prepared.revision);
      args.push("-m", input.message);
      const identityEnvironment = {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
      };
      const commit = (await git(repositoryPath, args, identityEnvironment)).trim();
      try {
        await options.beforePush?.();
        const remoteRef = `refs/heads/${prepared.reference}`;
        await git(repositoryPath, [
          "push",
          `--force-with-lease=${remoteRef}:${prepared.revision ?? ""}`,
          "origin",
          `${commit}:${remoteRef}`,
        ]);
      } catch (error) {
        if ((await remoteRevision(prepared.reference)) !== prepared.revision)
          return { status: "head_changed" };
        throw error;
      }
      return { status: "published", revision: commit };
    },
  };
}

async function buildOverview(
  configuration: SkillSyncConfiguration,
  state: SkillSyncState,
  local: ReadonlyMap<string, LocalSkill>,
  status: "ready" | "syncing" | "conflict" | "error",
): Promise<SkillSyncOverview> {
  const keys = new Set([
    ...local.keys(),
    ...Object.keys(state.conflicts),
    ...Object.keys(state.errors),
    ...state.ignoredRemote.map((item) => item.syncKey),
  ]);
  return SkillSyncOverviewSchema.parse({
    configured: true,
    configuration,
    status,
    revision: state.revision,
    resolvedBranch: state.resolvedBranch,
    syncedAt: state.syncedAt,
    errorCode: state.errorCode,
    errorMessage: state.errorMessage,
    skills: [...keys].toSorted().map((syncKey) => {
      const skill = local.get(syncKey);
      const ignored = state.ignoredRemote.find((item) => item.syncKey === syncKey);
      const error = state.errors[syncKey];
      return {
        syncKey,
        capabilityId: skill?.capabilityId ?? error?.capabilityId,
        name: skill?.name ?? error?.name ?? ignored?.name ?? syncKey,
        status:
          state.conflicts[syncKey] !== undefined
            ? "conflict"
            : error !== undefined
              ? "error"
              : ignored !== undefined
                ? "ignored_remote"
                : status === "syncing"
                  ? "syncing"
                  : skill !== undefined && state.bases[syncKey] !== fingerprint(skill)
                    ? "pending"
                    : "synced",
        ...(error === undefined ? {} : { errorCode: error.code, errorMessage: error.message }),
      };
    }),
    conflicts: Object.entries(state.conflicts).map(([syncKey, conflict]) => ({
      syncKey,
      name: conflict.local.name ?? conflict.remote.name ?? syncKey,
      remoteRevision: conflict.remoteRevision,
      localExists: conflict.local.exists,
      remoteExists: conflict.remote.exists,
      localFiles: conflict.local.files,
      remoteFiles: conflict.remote.files,
    })),
  });
}

function unconfiguredOverview(): SkillSyncOverview {
  return { configured: false, status: "unconfigured", skills: [], conflicts: [] };
}

function syncIdentity(capability: Capability): SkillSyncIdentity {
  return { kind: "capability", id: capability.manifest.id };
}

function identityKey(identity: SkillSyncIdentity): string {
  return `capability/${identity.id}`;
}

function portableFilesFor(capability: Capability, skill: RemoteSkill) {
  if (capability.definition.kind !== "skill") {
    throw coded("skill_sync_capability_invalid", "The synchronized capability is not a Skill.");
  }
  return StoredPortableFilesSchema.parse({
    capabilityId: capability.manifest.id,
    capabilityRevision: capability.manifest.latestRevision,
    capabilityContentHash: capability.definition.contentHash,
    files: portableFileEntries(skill),
  });
}

function portableFilesForLocal(skill: LocalSkill) {
  return StoredPortableFilesSchema.parse({
    capabilityId: skill.capabilityId,
    capabilityRevision: skill.capabilityRevision,
    capabilityContentHash: skill.capabilityContentHash,
    files: portableFileEntries(skill),
  });
}

function portableFileEntries(skill: RemoteSkill) {
  return skill.files.map(({ path, content, executable }) => ({
    path,
    executable,
    sha256: createHash("sha256").update(content).digest("hex"),
  }));
}

function pendingRemoteActivationFor(skill: RemoteSkill) {
  return PendingRemoteActivationSchema.parse({ files: portableFileEntries(skill) });
}

function sameLocalSnapshot(
  expected: LocalSkill | undefined,
  actual: LocalSkill | undefined,
): boolean {
  if (expected === undefined || actual === undefined) return expected === actual;
  return (
    expected.capabilityId === actual.capabilityId &&
    expected.capabilityRevision === actual.capabilityRevision &&
    expected.capabilityContentHash === actual.capabilityContentHash &&
    fingerprint(expected) === fingerprint(actual)
  );
}

function fingerprint(skill: RemoteSkill | undefined): string {
  if (skill === undefined) return "absent";
  return createHash("sha256")
    .update(
      JSON.stringify({
        identity: skill.identity,
        name: skill.name,
        description: skill.description,
        files: [...skill.files]
          .toSorted((left, right) => left.path.localeCompare(right.path))
          .map((file) => [
            file.path,
            createHash("sha256").update(file.content).digest("hex"),
            file.executable,
          ]),
        assetGit: skill.assetGit,
      }),
    )
    .digest("hex");
}

function summary(skill: RemoteSkill | undefined) {
  return skill === undefined
    ? { fingerprint: "absent", exists: false, files: [] }
    : {
        fingerprint: fingerprint(skill),
        exists: true,
        name: skill.name,
        files: skill.files.map((file) => file.path).toSorted(),
      };
}

function validateRemoteSkill(skill: RemoteSkill): void {
  for (const file of skill.files) {
    if (Buffer.byteLength(file.content, "utf8") > MAX_FILE_BYTES) {
      throw coded("skill_sync_size_limit", `Skill file is too large: ${file.path}`);
    }
  }
  const validation = validateSkillPackage({
    name: skill.name,
    description: skill.description,
    files: skill.files.map(({ path, content }) => ({ path, content })),
  });
  if (!validation.passed) {
    const issue = validation.diagnostics[0]!;
    throw coded(issue.code, `${issue.path}: ${issue.message}`);
  }
}

async function writeSkillTree(root: string, skill: RemoteSkill): Promise<void> {
  for (const file of skill.files) {
    const path = safeChild(root, file.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, file.content, { mode: file.executable ? 0o700 : 0o600 });
  }
}

async function readWorkingRepository(
  root: string,
  fileModes: ReadonlyMap<string, string>,
): Promise<RemoteSkillRepository> {
  try {
    const manifest = parse(await readUtf8Bounded(join(root, ROOT_MANIFEST), MAX_MANIFEST_BYTES));
    upgradeSkillRepositoryManifest(manifest);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      try {
        await access(join(root, SKILLS_DIRECTORY));
      } catch (directoryError) {
        if (isNodeError(directoryError, "ENOENT")) return { skills: new Map() };
        throw directoryError;
      }
      throw coded(
        "skill_sync_manifest_missing",
        `The repository uses ${SKILLS_DIRECTORY} without ${ROOT_MANIFEST}.`,
      );
    }
    throw coded("skill_sync_manifest_invalid", "The Skill sync repository manifest is invalid.");
  }
  const skills = new Map<string, RemoteSkill>();
  let totalBytes = 0;
  for (const entry of await readDirectory(join(root, SKILLS_DIRECTORY))) {
    if (entry.name === "bundle") {
      throw coded(
        "skill_sync_protocol_unsupported",
        "Legacy Bundle Skill identities are unsupported. Reinitialize Skill sync.",
      );
    }
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name !== "capability") {
      throw coded("skill_sync_entry_invalid", `Invalid managed entry: ${entry.name}`);
    }
  }
  for (const kind of ["capability"] as const) {
    const kindRoot = join(root, SKILLS_DIRECTORY, kind);
    for (const entry of await readDirectory(kindRoot)) {
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw coded("skill_sync_entry_invalid", `Invalid Skill entry: ${kind}/${entry.name}`);
      CapabilityIdSchema.parse(entry.name);
      const base = join(kindRoot, entry.name);
      const baseEntries = await readDirectory(base);
      if (
        baseEntries.length !== 2 ||
        !baseEntries.some(
          (child) => child.name === "skill.yaml" && child.isFile() && !child.isSymbolicLink(),
        ) ||
        !baseEntries.some(
          (child) => child.name === "files" && child.isDirectory() && !child.isSymbolicLink(),
        )
      ) {
        throw coded("skill_sync_entry_invalid", `Invalid Skill layout: ${kind}/${entry.name}`);
      }
      const rawManifest = parse(
        await readUtf8Bounded(join(base, "skill.yaml"), MAX_MANIFEST_BYTES),
      );
      const manifest = upgradeSkillManifest(rawManifest);
      if (manifest.identity.kind !== "capability") {
        throw coded(
          "skill_sync_protocol_unsupported",
          "Legacy Bundle Skill identities are unsupported. Reinitialize Skill sync.",
        );
      }
      const storedKey = `capability/${manifest.identity.id}`;
      if (storedKey !== `${kind}/${entry.name}`)
        throw coded(
          "skill_sync_identity_mismatch",
          `Skill path does not match its identity: ${storedKey}`,
        );
      const identity = manifest.identity;
      const key = identityKey(identity);
      const payloadRoot = join(base, "files");
      const snapshot = await scanSkillWorkingTree(payloadRoot);
      const declared = new Map(manifest.files.map((file) => [file.path, file]));
      if (
        snapshot.entries.length !== declared.size ||
        snapshot.entries.some((file) => {
          const expected = declared.get(file.path);
          return (
            expected === undefined ||
            expected.sizeBytes !== file.sizeBytes ||
            expected.sha256 !== file.sha256 ||
            expected.executable !==
              gitExecutable(
                fileModes,
                `${SKILLS_DIRECTORY}/${kind}/${entry.name}/files/${file.path}`,
              )
          );
        })
      ) {
        throw coded("skill_sync_integrity_failed", `Skill file manifest is incomplete: ${key}`);
      }
      const files: RemoteSkillFile[] = [];
      for (const metadata of manifest.files) {
        const content = await readUtf8Bounded(
          safeChild(payloadRoot, metadata.path),
          MAX_FILE_BYTES,
        );
        const sizeBytes = Buffer.byteLength(content, "utf8");
        const sha256 = createHash("sha256").update(content).digest("hex");
        if (sizeBytes !== metadata.sizeBytes || sha256 !== metadata.sha256)
          throw coded(
            "skill_sync_integrity_failed",
            `Skill file integrity check failed: ${metadata.path}`,
          );
        totalBytes += sizeBytes;
        if (totalBytes > MAX_REPOSITORY_BYTES)
          throw coded("skill_sync_size_limit", "The Skill repository is too large.");
        files.push({ path: metadata.path, content, executable: metadata.executable });
      }
      const remote = {
        identity,
        name: manifest.name,
        description: manifest.description,
        files,
        ...(manifest.assetGit ? { assetGit: manifest.assetGit } : {}),
      };
      if (skills.has(key))
        throw coded("skill_sync_identity_mismatch", `Multiple Skills resolve to ${key}.`);
      skills.set(key, remote);
      if (skills.size > MAX_REPOSITORY_SKILLS)
        throw coded("skill_sync_size_limit", "The Skill repository has too many Skills.");
    }
  }
  return { skills };
}

async function readGitFileModes(
  root: string,
  environment: NodeJS.ProcessEnv,
): Promise<ReadonlyMap<string, string>> {
  const modes = new Map<string, string>();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["-C", root, "ls-files", "--stage", "-z", "--", SKILLS_DIRECTORY], {
      env: gitEnvironment(environment),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error === undefined) resolvePromise();
      else rejectPromise(error);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(coded("skill_sync_git_timeout", "Git index inspection timed out."));
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (true) {
        const terminator = pending.indexOf(0);
        if (terminator < 0) break;
        const recordBytes = pending.subarray(0, terminator);
        pending = pending.subarray(terminator + 1);
        try {
          addGitIndexMode(modes, recordBytes);
        } catch (error) {
          child.kill("SIGKILL");
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      if (pending.length > MAX_GIT_INDEX_RECORD_BYTES) {
        child.kill("SIGKILL");
        finish(coded("skill_sync_git_index_invalid", "Git index entry is too large."));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4_000) stderr += chunk.slice(0, 4_000 - stderr.length);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        finish(
          new Error(
            `Git index inspection failed (${code ?? signal ?? "unknown"}): ${stderr.trim()}`,
          ),
        );
        return;
      }
      if (pending.length !== 0) {
        finish(coded("skill_sync_git_index_invalid", "Invalid Git index entry."));
        return;
      }
      finish();
    });
  });
  return modes;
}

function addGitIndexMode(modes: Map<string, string>, recordBytes: Buffer): void {
  if (recordBytes.length === 0 || recordBytes.length > MAX_GIT_INDEX_RECORD_BYTES) {
    throw coded("skill_sync_git_index_invalid", "Invalid Git index entry.");
  }
  const record = recordBytes.toString("utf8");
  if (!Buffer.from(record, "utf8").equals(recordBytes)) {
    throw coded("skill_sync_git_index_invalid", "Git index path is not UTF-8 text.");
  }
  const separator = record.indexOf("\t");
  const header =
    separator < 0 ? undefined : /^(\d+) [a-f0-9]+ \d+$/u.exec(record.slice(0, separator));
  const path = separator < 0 ? "" : record.slice(separator + 1);
  if (header === undefined || header === null || path === "") {
    throw coded("skill_sync_git_index_invalid", "Invalid Git index entry.");
  }
  modes.set(path, header[1]!);
}

async function stageGitFileModes(
  root: string,
  repository: RemoteSkillRepository,
  git: GitRunner,
): Promise<void> {
  const executable: string[] = [];
  const nonExecutable: string[] = [];
  for (const [key, skill] of repository.skills) {
    for (const file of skill.files) {
      const path = `${SKILLS_DIRECTORY}/${key}/files/${file.path}`;
      (file.executable ? executable : nonExecutable).push(path);
    }
  }
  for (const [mode, paths] of [
    ["+x", executable],
    ["-x", nonExecutable],
  ] as const) {
    for (let offset = 0; offset < paths.length; offset += 100) {
      await git(root, [
        "update-index",
        `--chmod=${mode}`,
        "--",
        ...paths.slice(offset, offset + 100),
      ]);
    }
  }
}

function gitExecutable(fileModes: ReadonlyMap<string, string>, path: string): boolean {
  const mode = fileModes.get(path);
  if (mode !== "100644" && mode !== "100755")
    throw coded("skill_sync_git_index_invalid", `Invalid Git mode for managed file: ${path}`);
  return mode === "100755";
}

async function writeWorkingRepository(
  root: string,
  repository: RemoteSkillRepository,
): Promise<void> {
  assertRepositoryBounds(repository);
  await rm(join(root, SKILLS_DIRECTORY), { recursive: true, force: true });
  await mkdir(join(root, SKILLS_DIRECTORY), { recursive: true, mode: 0o700 });
  await writeFile(join(root, ROOT_MANIFEST), stringify({ schemaVersion: "pragma.skill-sync/v3" }));
  for (const [key, skill] of [...repository.skills.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const base = join(root, SKILLS_DIRECTORY, ...key.split("/"));
    const files = skill.files.map((file) => ({
      path: file.path,
      sizeBytes: Buffer.byteLength(file.content, "utf8"),
      sha256: createHash("sha256").update(file.content).digest("hex"),
      executable: file.executable,
    }));
    const manifest = createSkillSyncManifest(skill, files);
    await mkdir(join(base, "files"), { recursive: true, mode: 0o700 });
    await writeFile(join(base, "skill.yaml"), stringify(manifest));
    await writeSkillTree(join(base, "files"), skill);
  }
}

type GitRunner = (
  repository: string | undefined,
  args: readonly string[],
  environment?: NodeJS.ProcessEnv,
) => Promise<string>;
async function ensureGitRepository(path: string, remote: string, git: GitRunner): Promise<void> {
  try {
    await access(join(path, ".git"));
    if (
      canonicalBackupRemote((await git(path, ["config", "--get", "remote.origin.url"])).trim()) ===
      canonicalBackupRemote(remote)
    )
      return;
  } catch {
    /* recreate below */
  }
  await rm(path, { recursive: true, force: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await git(undefined, ["init", temporary]);
    await git(temporary, ["remote", "add", "origin", remote]);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function installManagedPathAttributes(repositoryPath: string): Promise<void> {
  const path = join(repositoryPath, ".git", "info", "attributes");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${ROOT_MANIFEST} -text -filter\n${SKILLS_DIRECTORY}/** -text -filter\n`, {
    mode: 0o600,
  });
}

async function readGlobalGitIdentity(git: GitRunner): Promise<{ name: string; email: string }> {
  const [name, email] = await Promise.all([
    git(undefined, ["config", "--global", "--get", "user.name"]).catch(() => ""),
    git(undefined, ["config", "--global", "--get", "user.email"]).catch(() => ""),
  ]);
  if (name.trim() !== "" && email.trim() !== "") return { name: name.trim(), email: email.trim() };
  throw coded("git_identity_missing", "Skill sync requires global Git user.name and user.email.");
}

async function runGit(
  repository: string | undefined,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const command = repository === undefined ? [...args] : ["-C", repository, ...args];
  const { stdout } = await execFileAsync("git", command, {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    env: gitEnvironment(environment),
  });
  return stdout;
}

function gitEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...environment,
    GIT_TERMINAL_PROMPT: "0",
    ...(environment.GIT_SSH_COMMAND === undefined
      ? { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }
      : {}),
  };
}

async function readDirectory(path: string) {
  const entries = [];
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw coded("skill_sync_entry_invalid", `Invalid Skill sync directory: ${path}`);
    const directory = await opendir(path);
    for await (const entry of directory) entries.push(entry);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return entries;
    throw error;
  }
  return entries;
}

async function readUtf8Bounded(path: string, limit: number): Promise<string> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size > limit
  )
    throw coded("skill_sync_file_invalid", `Invalid Skill sync file: ${path}`);
  const bytes = await readFile(path);
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes))
    throw coded("skill_sync_binary_file", `Skill sync file is not UTF-8: ${path}`);
  return content;
}

function safeChild(root: string, path: string): string {
  const target = resolve(root, ...path.split("/"));
  const absoluteRoot = resolve(root);
  if (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}${sep}`))
    throw coded("skill_sync_path_invalid", `Unsafe Skill path: ${path}`);
  return target;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function assertRepositoryBounds(repository: RemoteSkillRepository): void {
  if (repository.skills.size > MAX_REPOSITORY_SKILLS)
    throw coded("skill_sync_size_limit", "The Skill repository has too many Skills.");
  let totalBytes = 0;
  for (const [key, skill] of repository.skills) {
    if (identityKey(skill.identity) !== key)
      throw coded(
        "skill_sync_identity_mismatch",
        `Skill map key does not match its identity: ${key}`,
      );
    validateRemoteSkill(skill);
    const manifest = createSkillSyncManifest(
      skill,
      skill.files.map((file) => ({
        path: file.path,
        sizeBytes: Buffer.byteLength(file.content, "utf8"),
        sha256: createHash("sha256").update(file.content).digest("hex"),
        executable: file.executable,
      })),
    );
    if (Buffer.byteLength(stringify(manifest), "utf8") > MAX_MANIFEST_BYTES) {
      throw coded("skill_sync_size_limit", `Skill manifest is too large: ${key}`);
    }
    for (const file of skill.files) {
      const size = Buffer.byteLength(file.content, "utf8");
      if (size > MAX_FILE_BYTES)
        throw coded("skill_sync_size_limit", `Skill file is too large: ${file.path}`);
      totalBytes += size;
      if (totalBytes > MAX_REPOSITORY_BYTES)
        throw coded("skill_sync_size_limit", "The Skill repository is too large.");
    }
  }
}

function createSkillSyncManifest(
  skill: RemoteSkill,
  files: SkillSyncSkillManifest["files"],
): SkillSyncSkillManifest {
  return SkillSyncSkillManifestSchema.parse({
    schemaVersion: "pragma.skill-sync-skill/v3",
    identity: skill.identity,
    name: skill.name,
    description: skill.description,
    files,
    ...(skill.assetGit ? { assetGit: skill.assetGit } : {}),
  });
}
function settledStatus(state: SkillSyncState): "ready" | "conflict" | "error" {
  if (Object.keys(state.conflicts).length > 0) return "conflict";
  if (
    Object.keys(state.errors).length > 0 ||
    state.errorCode !== undefined ||
    state.errorMessage !== undefined
  )
    return "error";
  return "ready";
}
function coded(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "skill_sync_failed";
}
function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}
function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
