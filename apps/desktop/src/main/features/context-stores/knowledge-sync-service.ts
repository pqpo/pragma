import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  opendir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { withFileLock } from "@pragma/core";
import { parse, stringify } from "yaml";
import { z } from "zod";

import {
  KnowledgeSyncConfigurationSchema,
  KnowledgeSyncOverviewSchema,
  KnowledgeSyncRepositoryManifestSchema,
  KnowledgeSyncStoreManifestSchema,
  type ContextStore,
  type ContextStoreSnapshot,
  type KnowledgeSyncConfiguration,
  type KnowledgeSyncOverview,
  type KnowledgeSyncStoreManifest,
} from "../../../shared/contracts/index.ts";
import { hashSnapshotContent, type ContextStoreStore } from "./context-store-store.ts";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const ROOT_MANIFEST = "pragma-knowledge-sync.yaml";
const STORES_DIRECTORY = "knowledge-bases";
const ABSENT = "absent";
const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_STORE_FILES = 5_000;
const MAX_REPOSITORY_STORES = 500;
const MAX_REPOSITORY_CONTENT_BYTES = 100 * 1024 * 1024;
const MAX_ERROR_MESSAGE_LENGTH = 2_000;
type SyncIntent = "full" | "pull_only";

export type RemoteStore = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly directories: readonly string[];
  readonly files: ContextStoreSnapshot["files"];
};

export type RemoteRepository = {
  readonly stores: ReadonlyMap<string, RemoteStore>;
};

export type ProviderHead = {
  readonly revision?: string | undefined;
  readonly reference?: string | undefined;
  readonly repository: RemoteRepository;
};

export interface ContextStoreSyncProvider {
  readHead(): Promise<ProviderHead>;
  publish(input: {
    readonly expectedRevision?: string | undefined;
    readonly repository: RemoteRepository;
    readonly alternate?: RemoteRepository | undefined;
    readonly message: string;
  }): Promise<
    | { readonly status: "published"; readonly revision: string }
    | { readonly status: "head_changed" }
  >;
}

type LocalStore = RemoteStore & {
  readonly revision: number;
  readonly snapshotHash: string;
};

const StoredStoreSummarySchema = z
  .object({
    fingerprint: z.string().min(1).max(128),
    exists: z.boolean(),
    name: z.string().trim().min(1).max(50).optional(),
    files: z.array(z.string().min(1).max(2_000)).max(MAX_STORE_FILES),
  })
  .strict();

const KnowledgeSyncStateSchema = z
  .object({
    schemaVersion: z.literal("pragma.knowledge-sync-state/v1"),
    revision: z.string().optional(),
    resolvedBranch: z.string().optional(),
    syncedAt: z.string().datetime().optional(),
    bases: z.record(z.string(), z.string()),
    ignoredRemote: z.array(
      z.object({ storeId: z.string().uuid(), name: z.string().trim().min(1).max(50) }).strict(),
    ),
    conflicts: z.record(
      z.string(),
      z
        .object({
          remoteRevision: z.string().min(1).max(128),
          local: StoredStoreSummarySchema,
          remote: StoredStoreSummarySchema,
        })
        .strict(),
    ),
    errorCode: z.string().trim().min(1).max(100).optional(),
    errorMessage: z.string().trim().min(1).max(MAX_ERROR_MESSAGE_LENGTH).optional(),
  })
  .strict();

type SyncState = z.infer<typeof KnowledgeSyncStateSchema>;

const emptyState = (): SyncState => ({
  schemaVersion: "pragma.knowledge-sync-state/v1",
  bases: {},
  ignoredRemote: [],
  conflicts: {},
});

export interface KnowledgeSyncService {
  getOverview(): Promise<KnowledgeSyncOverview>;
  configure(
    input: Omit<KnowledgeSyncConfiguration, "schemaVersion">,
  ): Promise<KnowledgeSyncOverview>;
  removeConfiguration(): Promise<void>;
  sync(): Promise<KnowledgeSyncOverview>;
  refresh(): Promise<KnowledgeSyncOverview>;
  schedule(reason: string): void;
  resolveConflict(storeId: string, choice: "local" | "remote"): Promise<KnowledgeSyncOverview>;
  restoreIgnored(storeId: string): Promise<KnowledgeSyncOverview>;
}

export function createKnowledgeSyncService(options: {
  readonly configurationPath: string;
  readonly statePath: string;
  readonly cacheRoot: string;
  readonly stores: ContextStoreStore;
  readonly provider?: ContextStoreSyncProvider | undefined;
  readonly providerFactory?:
    ((configuration: KnowledgeSyncConfiguration) => ContextStoreSyncProvider) | undefined;
  readonly warn?: ((message: string, error: unknown) => void) | undefined;
}): KnowledgeSyncService {
  const lockPath = `${options.statePath}.lock`;
  let running: Promise<KnowledgeSyncOverview> | undefined;
  let rerun = false;
  let requestedIntent: SyncIntent = "pull_only";
  let scheduled: NodeJS.Timeout | undefined;
  let transientStatus: "ready" | "syncing" | "conflict" | "error" = "ready";

  const providerFor = (configuration: KnowledgeSyncConfiguration): ContextStoreSyncProvider =>
    options.provider ??
    options.providerFactory?.(configuration) ??
    createGitContextStoreSyncProvider(options.cacheRoot, configuration);

  const readConfiguration = async (): Promise<KnowledgeSyncConfiguration | undefined> => {
    try {
      return KnowledgeSyncConfigurationSchema.parse(
        JSON.parse(await readFile(options.configurationPath, "utf8")),
      );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
  };
  const readState = async (): Promise<SyncState> => {
    try {
      return KnowledgeSyncStateSchema.parse(JSON.parse(await readFile(options.statePath, "utf8")));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return emptyState();
      throw error;
    }
  };
  const writeState = async (state: SyncState) =>
    writeJsonAtomic(options.statePath, KnowledgeSyncStateSchema.parse(state));

  const localStores = async (): Promise<Map<string, LocalStore>> => {
    const result = new Map<string, LocalStore>();
    for (const store of await options.stores.list()) {
      const snapshot = await options.stores.getSnapshot(store.id);
      result.set(store.id, {
        ...toRemoteStore(store, snapshot),
        revision: snapshot.revision,
        snapshotHash: snapshot.snapshotHash,
      });
    }
    return result;
  };

  const applyRemote = async (
    local: LocalStore | undefined,
    remote: RemoteStore | undefined,
  ): Promise<void> => {
    if (remote === undefined) {
      if (local !== undefined) {
        await options.stores.remove(local.id, {
          revision: local.revision,
          snapshotHash: local.snapshotHash,
        });
      }
      return;
    }
    if (local === undefined) {
      await options.stores.createFromSnapshot({
        id: remote.id,
        name: remote.name,
        description: remote.description,
        directories: remote.directories,
        files: remote.files,
        author: "sync",
        summary: "Synchronize knowledge from Git.",
      });
      return;
    }
    await options.stores.appendSnapshot(
      {
        storeId: local.id,
        baseRevision: local.revision,
        baseSnapshotHash: local.snapshotHash,
        snapshotHash: hashRemoteContent(remote),
        directories: remote.directories,
        files: remote.files,
        summary: "Synchronize knowledge from Git.",
        name: remote.name,
        description: remote.description,
      },
      "sync",
    );
  };

  const reconcileLocked = async (
    configuration: KnowledgeSyncConfiguration,
    state: SyncState,
    provider: ContextStoreSyncProvider,
    head: ProviderHead,
    intent: SyncIntent,
  ): Promise<KnowledgeSyncOverview> => {
    if (
      state.resolvedBranch !== undefined &&
      head.reference !== undefined &&
      state.resolvedBranch !== head.reference
    ) {
      state = emptyState();
    }
    const local = await localStores();
    const remote = new Map(head.repository.stores);
    const ignored = new Map(state.ignoredRemote.map((item) => [item.storeId, item.name]));
    const ids = new Set([...Object.keys(state.bases), ...local.keys(), ...remote.keys()]);
    const desired = new Map(remote);
    const nextBases = { ...state.bases };
    const nextConflicts: SyncState["conflicts"] = {};

    for (const id of [...ids].toSorted()) {
      const localStore = local.get(id);
      const remoteStore = remote.get(id);
      const localFingerprint = fingerprint(localStore);
      const remoteFingerprint = fingerprint(remoteStore);
      const base = state.bases[id];

      if (ignored.has(id)) {
        if (localStore !== undefined) ignored.delete(id);
        else if (remoteStore === undefined) {
          ignored.delete(id);
          nextBases[id] = ABSENT;
          continue;
        } else {
          ignored.set(id, remoteStore.name);
          continue;
        }
      }
      if (localFingerprint === remoteFingerprint) {
        nextBases[id] = localFingerprint;
        continue;
      }
      if (base === undefined) {
        if (localStore !== undefined && remoteStore !== undefined) {
          nextConflicts[id] = conflictState(head, localStore, remoteStore);
        } else if (localStore !== undefined) {
          if (intent === "full") desired.set(id, localStore);
        } else if (remoteStore !== undefined) {
          try {
            await applyRemote(undefined, remoteStore);
            nextBases[id] = remoteFingerprint;
          } catch (error) {
            const currentLocal = (await localStores()).get(id);
            nextConflicts[id] = conflictState(head, currentLocal, remoteStore);
            options.warn?.("Knowledge sync could not create a remote knowledge base.", error);
          }
        }
        continue;
      }
      if (localFingerprint === base) {
        try {
          await applyRemote(localStore, remoteStore);
          nextBases[id] = remoteFingerprint;
        } catch (error) {
          nextConflicts[id] = conflictState(head, localStore, remoteStore);
          options.warn?.("Knowledge sync could not apply a remote deletion or update.", error);
        }
        continue;
      }
      if (remoteFingerprint === base) {
        if (localStore === undefined && !configuration.pushDeletions) {
          if (remoteStore !== undefined) ignored.set(id, remoteStore.name);
        } else if (intent === "full") {
          if (localStore === undefined) desired.delete(id);
          else desired.set(id, localStore);
        }
        continue;
      }
      nextConflicts[id] = conflictState(head, localStore, remoteStore);
    }

    let revision = head.revision;
    if (intent === "full" && !repositoriesEqual(remote, desired)) {
      const published = await provider.publish({
        expectedRevision: head.revision,
        repository: { stores: desired },
        message: "Synchronize Pragma knowledge bases",
      });
      if (published.status === "head_changed") throw new KnowledgeSyncRetryError();
      revision = published.revision;
      for (const [id, store] of desired) {
        if (nextConflicts[id] === undefined) nextBases[id] = fingerprint(store);
      }
      for (const id of Object.keys(nextBases)) {
        if (!desired.has(id) && nextConflicts[id] === undefined && !ignored.has(id)) {
          nextBases[id] = ABSENT;
        }
      }
    }
    const next: SyncState = {
      schemaVersion: "pragma.knowledge-sync-state/v1",
      ...(revision === undefined ? {} : { revision }),
      ...(head.reference === undefined ? {} : { resolvedBranch: head.reference }),
      syncedAt: new Date().toISOString(),
      bases: nextBases,
      ignoredRemote: [...ignored]
        .map(([storeId, name]) => ({ storeId, name }))
        .toSorted((left, right) => left.storeId.localeCompare(right.storeId)),
      conflicts: nextConflicts,
    };
    await writeState(next);
    transientStatus = Object.keys(nextConflicts).length === 0 ? "ready" : "conflict";
    return await buildOverview(configuration, next, await localStores(), transientStatus);
  };

  const failLocked = async (
    configuration: KnowledgeSyncConfiguration,
    error: unknown,
  ): Promise<KnowledgeSyncOverview> => {
    const state = await readState();
    const next: SyncState = {
      ...state,
      errorCode: syncErrorCode(error),
      errorMessage: errorMessage(error),
    };
    await writeState(next);
    options.warn?.("Knowledge sync failed.", error);
    transientStatus = "error";
    return await buildOverview(configuration, next, await localStores(), "error");
  };

  const runLocked = async (
    configuration: KnowledgeSyncConfiguration,
    intent: SyncIntent,
    initialHead?: ProviderHead,
    preparedProvider?: ContextStoreSyncProvider,
  ): Promise<KnowledgeSyncOverview> => {
    const provider = preparedProvider ?? providerFor(configuration);
    let head = initialHead;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        head ??= await provider.readHead();
        return await reconcileLocked(configuration, await readState(), provider, head, intent);
      } catch (error) {
        if (!(error instanceof KnowledgeSyncRetryError))
          return await failLocked(configuration, error);
        head = undefined;
      }
    }
    return await failLocked(
      configuration,
      new KnowledgeSyncRetryError(
        "The remote repository changed repeatedly while publishing. Synchronize again.",
      ),
    );
  };

  const synchronizeOnce = async (intent: SyncIntent): Promise<KnowledgeSyncOverview> =>
    await withFileLock(lockPath, async () => {
      const configuration = await readConfiguration();
      if (configuration === undefined) return unconfiguredOverview();
      transientStatus = "syncing";
      return await runLocked(configuration, intent);
    });

  const runSync = (intent: SyncIntent): Promise<KnowledgeSyncOverview> => {
    if (running !== undefined) {
      rerun = true;
      requestedIntent = mergeIntent(requestedIntent, intent);
      return running;
    }
    requestedIntent = intent;
    running = (async () => {
      let result: KnowledgeSyncOverview | undefined;
      do {
        rerun = false;
        const nextIntent = requestedIntent;
        requestedIntent = "pull_only";
        result = await synchronizeOnce(nextIntent);
      } while (rerun);
      return result ?? unconfiguredOverview();
    })().finally(() => {
      running = undefined;
    });
    return running;
  };

  return {
    async getOverview() {
      const configuration = await readConfiguration();
      if (configuration === undefined) return unconfiguredOverview();
      const state = await readState();
      const status =
        transientStatus === "syncing"
          ? "syncing"
          : state.errorMessage !== undefined
            ? "error"
            : Object.keys(state.conflicts).length > 0
              ? "conflict"
              : transientStatus;
      return await buildOverview(configuration, state, await localStores(), status);
    },
    async configure(input) {
      const configuration = KnowledgeSyncConfigurationSchema.parse({
        schemaVersion: "pragma.knowledge-sync-settings/v1",
        ...input,
      });
      return await withFileLock(lockPath, async () => {
        const provider = providerFor(configuration);
        const head = await provider.readHead();
        const previous = await readConfiguration();
        await writeJsonAtomic(options.configurationPath, configuration);
        if (
          previous === undefined ||
          canonicalRemote(previous.remote) !== canonicalRemote(configuration.remote) ||
          previous.branch !== configuration.branch
        ) {
          await writeState(emptyState());
        }
        transientStatus = "syncing";
        return await runLocked(configuration, "full", head, provider);
      });
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
      const isLocalPublish =
        reason === "knowledge-store-published" || reason === "knowledge-store-removed";
      scheduled = setTimeout(
        () => {
          scheduled = undefined;
          void (async () => {
            const configuration = await readConfiguration();
            if (configuration === undefined || (isLocalPublish && !configuration.autoPush)) return;
            await runSync(isLocalPublish ? "full" : "pull_only");
          })().catch((error: unknown) => options.warn?.("Scheduled knowledge sync failed.", error));
        },
        isLocalPublish ? 750 : 0,
      );
      scheduled.unref();
    },
    async resolveConflict(storeId, choice) {
      return await withFileLock(lockPath, async () => {
        const configuration = await readConfiguration();
        if (configuration === undefined) return unconfiguredOverview();
        const state = await readState();
        const conflict = state.conflicts[storeId];
        if (conflict === undefined)
          return await buildOverview(configuration, state, await localStores(), transientStatus);
        const provider = providerFor(configuration);
        const local = await localStores();
        const localStore = local.get(storeId);
        if (fingerprint(localStore) !== conflict.local.fingerprint) {
          throw new Error(
            "The local knowledge base changed after this conflict was detected. Synchronize again.",
          );
        }
        let resolved:
          | {
              readonly head: ProviderHead;
              readonly remote: RemoteStore | undefined;
              readonly revision: string;
            }
          | undefined;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const head = await provider.readHead();
          const remote = head.repository.stores.get(storeId);
          if (fingerprint(remote) !== conflict.remote.fingerprint) {
            throw new Error(
              "The remote knowledge base changed again. Synchronize before resolving it.",
            );
          }
          const desired = new Map(head.repository.stores);
          if (choice === "local") {
            if (localStore === undefined) desired.delete(storeId);
            else desired.set(storeId, localStore);
          }
          const alternate = new Map(head.repository.stores);
          if (localStore === undefined) alternate.delete(storeId);
          else alternate.set(storeId, localStore);
          const published = await provider.publish({
            expectedRevision: head.revision,
            repository: { stores: desired },
            ...(choice === "remote" ? { alternate: { stores: alternate } } : {}),
            message: `Resolve knowledge sync conflict for ${storeId}`,
          });
          if (published.status === "published") {
            resolved = { head, remote, revision: published.revision };
            break;
          }
        }
        if (resolved === undefined) {
          throw new Error(
            "The remote repository changed repeatedly while resolving the conflict. Try again.",
          );
        }
        const { head, remote } = resolved;
        if (choice === "remote") await applyRemote(localStore, remote);
        const nextConflicts = { ...state.conflicts };
        delete nextConflicts[storeId];
        const next: SyncState = {
          ...state,
          revision: resolved.revision,
          ...(head.reference === undefined ? {} : { resolvedBranch: head.reference }),
          syncedAt: new Date().toISOString(),
          bases: {
            ...state.bases,
            [storeId]: fingerprint(choice === "local" ? localStore : remote),
          },
          conflicts: nextConflicts,
          errorCode: undefined,
          errorMessage: undefined,
        };
        await writeState(next);
        transientStatus = Object.keys(nextConflicts).length === 0 ? "ready" : "conflict";
        return await buildOverview(configuration, next, await localStores(), transientStatus);
      });
    },
    async restoreIgnored(storeId) {
      await withFileLock(lockPath, async () => {
        const state = await readState();
        const bases = { ...state.bases };
        delete bases[storeId];
        await writeState({
          ...state,
          bases,
          ignoredRemote: state.ignoredRemote.filter((item) => item.storeId !== storeId),
        });
      });
      return await runSync("full");
    },
  };
}

export function createGitContextStoreSyncProvider(
  cacheRoot: string,
  configuration: KnowledgeSyncConfiguration,
): ContextStoreSyncProvider {
  const repositoryPath = join(cacheRoot, "repository");

  const prepare = async (): Promise<{ reference: string; revision?: string }> => {
    await ensureGitRepository(repositoryPath, configuration.remote);
    await installManagedPathAttributes(repositoryPath);
    const advertised = await runGit(repositoryPath, ["ls-remote", "--symref", "origin", "HEAD"]);
    const defaultBranch = /^ref: refs\/heads\/([^\s]+)\s+HEAD$/mu.exec(advertised)?.[1];
    const branch = configuration.branch ?? defaultBranch ?? "main";
    await runGit(undefined, ["check-ref-format", "--branch", branch]);
    const heads = await runGit(repositoryPath, [
      "ls-remote",
      "--heads",
      "origin",
      `refs/heads/${branch}`,
    ]);
    const revision = heads.trim().split(/\s+/u)[0] || undefined;
    if (revision !== undefined) {
      await runGit(repositoryPath, [
        "fetch",
        "--force",
        "--depth=50",
        "origin",
        `refs/heads/${branch}`,
      ]);
      await runGit(repositoryPath, ["checkout", "--detach", "--force", "FETCH_HEAD"]);
      await runGit(repositoryPath, ["reset", "--hard", "FETCH_HEAD"]);
    } else {
      await runGit(repositoryPath, ["read-tree", "--empty"]);
      await rm(join(repositoryPath, STORES_DIRECTORY), { recursive: true, force: true });
      await rm(join(repositoryPath, ROOT_MANIFEST), { force: true });
    }
    await runGit(repositoryPath, ["clean", "-fd", "--", ROOT_MANIFEST, STORES_DIRECTORY]);
    return { reference: branch, ...(revision === undefined ? {} : { revision }) };
  };

  return {
    async readHead() {
      const prepared = await prepare();
      return { ...prepared, repository: await readWorkingRepository(repositoryPath) };
    },
    async publish(input) {
      const prepared = await prepare();
      if (prepared.revision !== input.expectedRevision) return { status: "head_changed" };
      await runGit(repositoryPath, ["config", "user.name", "Pragma Knowledge Sync"]);
      await runGit(repositoryPath, ["config", "user.email", "knowledge-sync@pragma.local"]);

      let alternateCommit: string | undefined;
      if (input.alternate !== undefined) {
        await writeWorkingRepository(repositoryPath, input.alternate);
        await runGit(repositoryPath, ["add", "--", ROOT_MANIFEST, STORES_DIRECTORY]);
        const tree = (await runGit(repositoryPath, ["write-tree"])).trim();
        const args = ["commit-tree", tree];
        if (prepared.revision !== undefined) args.push("-p", prepared.revision);
        args.push("-m", `${input.message} (local candidate)`);
        alternateCommit = (await runGit(repositoryPath, args)).trim();
      }

      await writeWorkingRepository(repositoryPath, input.repository);
      await runGit(repositoryPath, ["add", "--", ROOT_MANIFEST, STORES_DIRECTORY]);
      const tree = (await runGit(repositoryPath, ["write-tree"])).trim();
      const commitArgs = ["commit-tree", tree];
      if (prepared.revision !== undefined) commitArgs.push("-p", prepared.revision);
      if (alternateCommit !== undefined) commitArgs.push("-p", alternateCommit);
      commitArgs.push("-m", input.message);
      const commit = (await runGit(repositoryPath, commitArgs)).trim();
      try {
        await runGit(repositoryPath, [
          "push",
          "origin",
          `${commit}:refs/heads/${prepared.reference}`,
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : "";
        if (
          message.includes("rejected") ||
          message.includes("non-fast-forward") ||
          message.includes("fetch first")
        ) {
          return { status: "head_changed" };
        }
        throw error;
      }
      await runGit(repositoryPath, ["checkout", "--detach", "--force", commit]);
      return { status: "published", revision: commit };
    },
  };
}

async function readWorkingRepository(root: string): Promise<RemoteRepository> {
  const manifestPath = join(root, ROOT_MANIFEST);
  try {
    await assertRegularFile(manifestPath);
    KnowledgeSyncRepositoryManifestSchema.parse(
      parse(await readUtf8FileBounded(manifestPath, MAX_MANIFEST_BYTES)),
    );
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      try {
        await access(join(root, STORES_DIRECTORY));
      } catch (storesError) {
        if (isNodeError(storesError, "ENOENT")) return { stores: new Map() };
        throw storesError;
      }
      throw new Error(
        `The repository already uses the reserved ${STORES_DIRECTORY} path without ${ROOT_MANIFEST}.`,
        { cause: error },
      );
    }
    throw new Error("The Git knowledge repository manifest is invalid.", { cause: error });
  }
  const stores = new Map<string, RemoteStore>();
  const storeRoot = join(root, STORES_DIRECTORY);
  const entries = await readDirectoryBounded(storeRoot, MAX_REPOSITORY_STORES);
  let repositoryContentBytes = 0;
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Unsupported knowledge store entry: ${entry.name}`);
    }
    const id = entry.name;
    const base = join(storeRoot, id);
    const storeManifestPath = join(base, "store.yaml");
    await assertRegularFile(storeManifestPath);
    const manifest = KnowledgeSyncStoreManifestSchema.parse(
      parse(await readUtf8FileBounded(storeManifestPath, MAX_MANIFEST_BYTES)),
    );
    if (manifest.id !== id) throw new Error(`Knowledge store path does not match its id: ${id}`);
    const metadata = new Map(manifest.files.map((file) => [file.path, file.metadata]));
    const paths = await listMarkdownFiles(join(base, "files"));
    if (paths.length > MAX_STORE_FILES) {
      throw new Error(`Knowledge store ${id} exceeds ${MAX_STORE_FILES} Markdown files.`);
    }
    if (paths.length !== metadata.size || paths.some((path) => !metadata.has(path))) {
      throw new Error(`Knowledge store file metadata is incomplete: ${id}`);
    }
    const files: RemoteStore["files"][number][] = [];
    for (const path of paths) {
      const content = await readUtf8FileBounded(
        join(base, "files", ...path.split("/")),
        MAX_FILE_BYTES,
      );
      repositoryContentBytes += Buffer.byteLength(content, "utf8");
      if (repositoryContentBytes > MAX_REPOSITORY_CONTENT_BYTES) {
        throw new Error(
          `The knowledge repository exceeds ${MAX_REPOSITORY_CONTENT_BYTES} content bytes.`,
        );
      }
      files.push({ id: path, content, metadata: metadata.get(path)! });
    }
    stores.set(id, {
      id,
      name: manifest.name,
      description: manifest.description,
      directories: manifest.directories,
      files,
    });
  }
  return { stores };
}

async function writeWorkingRepository(root: string, repository: RemoteRepository): Promise<void> {
  assertRepositoryBounds(repository);
  await rm(join(root, STORES_DIRECTORY), { recursive: true, force: true });
  await mkdir(join(root, STORES_DIRECTORY), { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, ROOT_MANIFEST),
    stringify(
      KnowledgeSyncRepositoryManifestSchema.parse({ schemaVersion: "pragma.knowledge-sync/v1" }),
    ),
  );
  for (const store of [...repository.stores.values()].toSorted((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const base = join(root, STORES_DIRECTORY, store.id);
    const manifest: KnowledgeSyncStoreManifest = KnowledgeSyncStoreManifestSchema.parse({
      schemaVersion: "pragma.knowledge-sync-store/v1",
      id: store.id,
      name: store.name,
      description: store.description,
      directories: [...store.directories].toSorted(),
      files: store.files
        .map((file) => ({ path: file.id, metadata: file.metadata }))
        .toSorted((a, b) => a.path.localeCompare(b.path)),
    });
    await mkdir(join(base, "files"), { recursive: true, mode: 0o700 });
    await writeFile(join(base, "store.yaml"), stringify(manifest));
    for (const file of store.files) {
      const path = safeChild(join(base, "files"), file.id);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, file.content, "utf8");
    }
  }
}

function assertRepositoryBounds(repository: RemoteRepository): void {
  if (repository.stores.size > MAX_REPOSITORY_STORES) {
    throw new Error(`The knowledge repository exceeds ${MAX_REPOSITORY_STORES} stores.`);
  }
  let totalBytes = 0;
  for (const store of repository.stores.values()) {
    if (store.files.length > MAX_STORE_FILES) {
      throw new Error(`Knowledge store ${store.id} exceeds ${MAX_STORE_FILES} Markdown files.`);
    }
    for (const file of store.files) {
      const bytes = Buffer.byteLength(file.content, "utf8");
      if (bytes > MAX_FILE_BYTES) {
        throw new Error(`Knowledge sync file exceeds ${MAX_FILE_BYTES} bytes: ${file.id}`);
      }
      totalBytes += bytes;
      if (totalBytes > MAX_REPOSITORY_CONTENT_BYTES) {
        throw new Error(
          `The knowledge repository exceeds ${MAX_REPOSITORY_CONTENT_BYTES} content bytes.`,
        );
      }
    }
  }
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directoryPath: string): Promise<void> => {
    let directory;
    try {
      directory = await opendir(directoryPath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    for await (const entry of directory) {
      if (entry.isSymbolicLink()) throw new Error("Knowledge sync symlinks are not allowed.");
      const path = join(directoryPath, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(relative(root, path).split(sep).join("/"));
        if (files.length > MAX_STORE_FILES) {
          throw new Error(`A knowledge store exceeds ${MAX_STORE_FILES} Markdown files.`);
        }
      } else throw new Error(`Unsupported knowledge sync file: ${relative(root, path)}`);
    }
  };
  await visit(root);
  return files.toSorted();
}

async function readDirectoryBounded(path: string, maximumEntries: number): Promise<Dirent[]> {
  const entries: Dirent[] = [];
  let directory;
  try {
    directory = await opendir(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return entries;
    throw error;
  }
  for await (const entry of directory) {
    entries.push(entry);
    if (entries.length > maximumEntries) {
      throw new Error(`The knowledge repository exceeds ${maximumEntries} stores.`);
    }
  }
  return entries;
}

async function ensureGitRepository(path: string, remote: string): Promise<void> {
  try {
    await access(join(path, ".git"));
    const current = (await runGit(path, ["config", "--get", "remote.origin.url"])).trim();
    if (canonicalRemote(current) !== canonicalRemote(remote)) {
      await rm(path, { recursive: true, force: true });
    } else return;
  } catch {
    await rm(path, { recursive: true, force: true });
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await runGit(undefined, ["init", temporary]);
    await runGit(temporary, ["remote", "add", "origin", remote]);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function installManagedPathAttributes(repositoryPath: string): Promise<void> {
  const attributesPath = join(repositoryPath, ".git", "info", "attributes");
  await mkdir(dirname(attributesPath), { recursive: true, mode: 0o700 });
  await writeFile(
    attributesPath,
    `${ROOT_MANIFEST} -text -filter\n${STORES_DIRECTORY}/** -text -filter\n`,
    { mode: 0o600 },
  );
}

async function runGit(repository: string | undefined, args: readonly string[]): Promise<string> {
  const command = repository === undefined ? [...args] : ["-C", repository, ...args];
  const { stdout } = await execFileAsync("git", command, {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...(process.env.GIT_SSH_COMMAND === undefined
        ? { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }
        : {}),
    },
  });
  return stdout;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function readUtf8FileBounded(path: string, maximumBytes: number): Promise<string> {
  const file = await stat(path);
  if (!file.isFile() || file.size > maximumBytes) {
    throw new Error(`Knowledge sync file exceeds ${maximumBytes} bytes: ${path}`);
  }
  const content = await readFile(path, "utf8");
  if (Buffer.byteLength(content, "utf8") > maximumBytes) {
    throw new Error(`Knowledge sync file exceeds ${maximumBytes} bytes: ${path}`);
  }
  return content;
}

function toRemoteStore(store: ContextStore, snapshot: ContextStoreSnapshot): RemoteStore {
  return {
    id: store.id,
    name: store.name,
    description: store.description,
    directories: snapshot.directories,
    files: snapshot.files,
  };
}

function fingerprint(store: RemoteStore | undefined): string {
  if (store === undefined) return ABSENT;
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: store.id,
        name: store.name,
        description: store.description,
        directories: [...store.directories].toSorted(),
        files: [...store.files].toSorted((a, b) => a.id.localeCompare(b.id)),
      }),
    )
    .digest("hex");
}

function hashRemoteContent(store: RemoteStore): string {
  return hashSnapshotContent([...store.files], [...store.directories]);
}

function repositoriesEqual(a: Map<string, RemoteStore>, b: Map<string, RemoteStore>): boolean {
  if (a.size !== b.size) return false;
  return [...a].every(([id, store]) => fingerprint(store) === fingerprint(b.get(id)));
}

async function buildOverview(
  configuration: KnowledgeSyncConfiguration,
  state: SyncState,
  local: Map<string, LocalStore>,
  status: "ready" | "syncing" | "conflict" | "error",
): Promise<KnowledgeSyncOverview> {
  const ignored = new Map(state.ignoredRemote.map((item) => [item.storeId, item.name]));
  const stores = [...new Set([...local.keys(), ...ignored.keys(), ...Object.keys(state.conflicts)])]
    .toSorted()
    .map((id) => {
      const store = local.get(id);
      const conflict = state.conflicts[id];
      const localFingerprint = fingerprint(store);
      const storeStatus =
        conflict !== undefined
          ? ("conflict" as const)
          : ignored.has(id) && store === undefined
            ? ("ignored_remote" as const)
            : state.bases[id] === localFingerprint
              ? ("synced" as const)
              : status === "syncing"
                ? ("syncing" as const)
                : status === "error"
                  ? ("error" as const)
                  : ("pending" as const);
      return {
        storeId: id,
        name:
          store?.name ??
          conflict?.local.name ??
          conflict?.remote.name ??
          ignored.get(id) ??
          "Unavailable knowledge base",
        status: storeStatus,
      };
    });
  return KnowledgeSyncOverviewSchema.parse({
    configured: true,
    configuration,
    status,
    ...(state.resolvedBranch === undefined ? {} : { resolvedBranch: state.resolvedBranch }),
    ...(state.revision === undefined ? {} : { revision: state.revision }),
    ...(state.syncedAt === undefined ? {} : { syncedAt: state.syncedAt }),
    ...(state.errorCode === undefined ? {} : { errorCode: state.errorCode }),
    ...(state.errorMessage === undefined ? {} : { errorMessage: state.errorMessage }),
    stores,
    conflicts: Object.entries(state.conflicts).map(([storeId, conflict]) => ({
      storeId,
      name:
        local.get(storeId)?.name ??
        conflict.local.name ??
        conflict.remote.name ??
        "Unavailable knowledge base",
      remoteRevision: conflict.remoteRevision,
      localExists: conflict.local.exists,
      remoteExists: conflict.remote.exists,
      localFiles:
        local
          .get(storeId)
          ?.files.map((file) => file.id)
          .toSorted() ?? [],
      remoteFiles: conflict.remote.files,
    })),
  });
}

function unconfiguredOverview(): KnowledgeSyncOverview {
  return { configured: false, status: "unconfigured", stores: [], conflicts: [] };
}

function canonicalRemote(remote: string): string {
  return remote
    .trim()
    .replace(/\.git$/u, "")
    .replace(/\/$/u, "");
}

async function assertRegularFile(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`Knowledge sync requires a regular file: ${path}`);
  }
}

function safeChild(root: string, id: string): string {
  const path = resolve(root, ...id.replaceAll("\\", "/").split("/"));
  if (!path.startsWith(`${resolve(root)}${sep}`)) throw new Error(`Unsafe knowledge path: ${id}`);
  return path;
}

function conflictState(
  head: ProviderHead,
  local: RemoteStore | undefined,
  remote: RemoteStore | undefined,
): SyncState["conflicts"][string] {
  return {
    remoteRevision: head.revision ?? "unborn",
    local: storeSummary(local),
    remote: storeSummary(remote),
  };
}

function storeSummary(store: RemoteStore | undefined) {
  return StoredStoreSummarySchema.parse({
    fingerprint: fingerprint(store),
    exists: store !== undefined,
    ...(store === undefined ? {} : { name: store.name }),
    files: store?.files.map((file) => file.id).toSorted() ?? [],
  });
}

function mergeIntent(left: SyncIntent, right: SyncIntent): SyncIntent {
  return left === "full" || right === "full" ? "full" : "pull_only";
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Knowledge sync failed.";
  const normalized = message.trim() || "Knowledge sync failed.";
  return normalized.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function syncErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (isNodeError(error, "ENOENT") || message.includes("not found")) return "git_unavailable";
  if (message.includes("permission denied") || message.includes("authentication"))
    return "git_auth_failed";
  if (message.includes("manifest") || message.includes("schema") || error instanceof z.ZodError)
    return "sync_protocol_invalid";
  if (error instanceof KnowledgeSyncRetryError) return "remote_changed_too_often";
  return "knowledge_sync_failed";
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

class KnowledgeSyncRetryError extends Error {}
