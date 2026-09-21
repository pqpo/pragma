import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, opendir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { validateSkillPackage } from "@pragma/built-in-agents";
import { withFileLock } from "@pragma/core";
import { parse, stringify } from "yaml";
import { z } from "zod";

import {
  CapabilityIdSchema,
  SkillSyncConfigurationSchema,
  SkillSyncOverviewSchema,
  SkillSyncRepositoryManifestSchema,
  SkillSyncSkillManifestSchema,
  type Capability,
  type SkillSyncConfiguration,
  type SkillSyncIdentity,
  type SkillSyncOverview,
  type SkillSyncSkillManifest,
} from "../../../shared/contracts/index.ts";
import type { CapabilityStore } from "./capability-store.ts";
import { scanSkillWorkingTree } from "./skill-revision-draft-store.ts";

const execFileAsync = promisify(execFile);
const ROOT_MANIFEST = "pragma-skill-sync.yaml";
const SKILLS_DIRECTORY = "skills";
const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_CONFLICT_SUMMARY_FILES = 1_000;
const MAX_REPOSITORY_SKILLS = 500;
const MAX_REPOSITORY_BYTES = 25 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;
type SyncIntent = "full" | "pull_only";

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
};

export type RemoteSkillRepository = { readonly skills: ReadonlyMap<string, RemoteSkill> };
export type SkillSyncProviderHead = {
  readonly revision?: string | undefined;
  readonly reference?: string | undefined;
  readonly repository: RemoteSkillRepository;
};

export interface SkillSyncProvider {
  readHead(): Promise<SkillSyncProviderHead>;
  publish(input: {
    readonly expectedRevision?: string | undefined;
    readonly repository: RemoteSkillRepository;
    readonly message: string;
  }): Promise<
    | { readonly status: "published"; readonly revision: string }
    | { readonly status: "head_changed" }
  >;
}

type LocalSkill = RemoteSkill & {
  readonly capabilityId: string;
  readonly capabilityRevision: number;
  readonly capabilityContentHash: string;
};

const StoredSummarySchema = z
  .object({
    fingerprint: z.string().min(1).max(128),
    exists: z.boolean(),
    name: z.string().trim().min(1).max(120).optional(),
    files: z.array(z.string().min(1).max(2_000)).max(MAX_CONFLICT_SUMMARY_FILES),
  })
  .strict();

const StoredPortableFilesSchema = z
  .object({
    capabilityId: CapabilityIdSchema,
    capabilityRevision: z.number().int().positive(),
    capabilityContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
    files: z
      .array(z.object({ path: z.string().min(1).max(2_000), executable: z.boolean() }).strict())
      .max(MAX_CONFLICT_SUMMARY_FILES),
  })
  .strict();

const SkillSyncStateSchema = z
  .object({
    schemaVersion: z.literal("pragma.skill-sync-state/v1"),
    sourceKey: z.string().min(1).max(4_000).optional(),
    revision: z.string().optional(),
    resolvedBranch: z.string().optional(),
    syncedAt: z.string().datetime().optional(),
    bases: z.record(z.string(), z.string()),
    portableFiles: z.record(z.string(), StoredPortableFilesSchema).default({}),
    ignoredRemote: z.array(z.object({ syncKey: z.string(), name: z.string() }).strict()),
    conflicts: z.record(
      z.string(),
      z
        .object({
          remoteRevision: z.string().min(1),
          local: StoredSummarySchema,
          remote: StoredSummarySchema,
        })
        .strict(),
    ),
    errors: z.record(
      z.string(),
      z
        .object({
          source: z.enum(["local", "remote"]),
          code: z.string().min(1),
          message: z.string().min(1).max(2_000),
          name: z.string().trim().min(1).max(120).optional(),
          capabilityId: CapabilityIdSchema.optional(),
        })
        .strict(),
    ),
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
  })
  .strict();

type SkillSyncState = z.infer<typeof SkillSyncStateSchema>;
type LocalSkillSnapshot = {
  readonly skills: Map<string, LocalSkill>;
  readonly errors: SkillSyncState["errors"];
};
const emptyState = (sourceKey?: string): SkillSyncState => ({
  schemaVersion: "pragma.skill-sync-state/v1",
  ...(sourceKey === undefined ? {} : { sourceKey }),
  bases: {},
  portableFiles: {},
  ignoredRemote: [],
  conflicts: {},
  errors: {},
});

export interface SkillSyncService {
  getOverview(): Promise<SkillSyncOverview>;
  configure(input: Omit<SkillSyncConfiguration, "schemaVersion">): Promise<SkillSyncOverview>;
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
  readonly provider?: SkillSyncProvider | undefined;
  readonly providerFactory?:
    ((configuration: SkillSyncConfiguration) => SkillSyncProvider) | undefined;
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
    try {
      return SkillSyncStateSchema.parse(JSON.parse(await readFile(options.statePath, "utf8")));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return emptyState();
      throw error;
    }
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
        const portableModes =
          portable?.capabilityId === capability.manifest.id &&
          portable.capabilityRevision === capability.manifest.latestRevision &&
          portable.capabilityContentHash === capability.definition.contentHash
            ? new Map(portable.files.map((file) => [file.path, file.executable]))
            : undefined;
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
            executable: portableModes?.get(entry.path) ?? entry.executable,
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
        const id = remote.identity.kind === "capability" ? remote.identity.id : randomUUID();
        return await options.capabilities.publishNewSkillRevisionCandidate({
          id,
          name: remote.name,
          description: remote.description,
          sourcePath: incoming,
          candidateContentHash: snapshot.hash,
          ...(remote.identity.kind === "pragma-bundle"
            ? { origin: { kind: "pragma-bundle" as const, logicalId: remote.identity.logicalId } }
            : {}),
        });
      } else {
        return await options.capabilities.publishSkillRevisionCandidate({
          id: local.capabilityId,
          baseRevision: local.capabilityRevision,
          baseContentHash: local.capabilityContentHash,
          sourcePath: incoming,
          candidateContentHash: snapshot.hash,
        });
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
  }> => {
    const localSnapshot = await localSkills(state);
    const local = localSnapshot.skills;
    const remote = new Map(head.repository.skills);
    const desired = new Map(remote);
    const bases = { ...state.bases };
    const portableFiles = { ...state.portableFiles };
    const conflicts = { ...state.conflicts };
    const errors = Object.fromEntries(
      Object.entries(state.errors).filter(([, error]) => error.source === "remote"),
    ) as SkillSyncState["errors"];
    let ignoredRemote = [...state.ignoredRemote];
    const publishedKeys: string[] = [];
    Object.assign(errors, localSnapshot.errors);
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
        if (localFingerprint === "absent") {
          delete bases[key];
          delete portableFiles[key];
        } else bases[key] = localFingerprint;
        delete conflicts[key];
        delete errors[key];
        ignoredRemote = ignoredRemote.filter((item) => item.syncKey !== key);
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
        try {
          const applied = await applyRemote(key, remoteSkill, localSkill);
          if (remoteSkill === undefined || applied === undefined) {
            delete bases[key];
            delete portableFiles[key];
          } else {
            bases[key] = remoteFingerprint;
            portableFiles[key] = portableFilesFor(applied, remoteSkill);
          }
          delete errors[key];
          delete conflicts[key];
          ignoredRemote = ignoredRemote.filter((item) => item.syncKey !== key);
        } catch (error) {
          if (errorCode(error) === "revision_conflict") {
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
      else desired.set(key, localSkill);
      publishedKeys.push(key);
      delete conflicts[key];
      delete errors[key];
      ignoredRemote = ignoredRemote.filter((item) => item.syncKey !== key);
    }
    return {
      repository: { skills: desired },
      publishedKeys,
      state: SkillSyncStateSchema.parse({
        ...state,
        bases,
        portableFiles,
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
    const sourceKey = configurationSourceKey(configuration);
    if (state.sourceKey !== sourceKey) state = emptyState(sourceKey);
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const head = await provider.readHead();
        if (
          state.resolvedBranch !== undefined &&
          head.reference !== undefined &&
          state.resolvedBranch !== head.reference
        ) {
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
    if (intent === "full") requestedIntent = "full";
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
      const state = await readState();
      return await buildOverview(
        configuration,
        state,
        await localSkillsForOverview(state),
        transientStatus === "syncing" ? "syncing" : settledStatus(state),
      );
    },
    async configure(input) {
      const configuration = SkillSyncConfigurationSchema.parse({
        schemaVersion: "pragma.skill-sync-settings/v1",
        ...input,
      });
      await withFileLock(lockPath, async () => {
        const head = await providerFor(configuration).readHead();
        const previous = await readConfiguration();
        await writeJsonAtomic(options.configurationPath, configuration);
        if (
          previous === undefined ||
          canonicalRemote(previous.remote) !== canonicalRemote(configuration.remote) ||
          previous.branch !== configuration.branch
        ) {
          await writeState(emptyState(configurationSourceKey(configuration)));
        }
        void head;
      });
      return await runSync("full");
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
          state.sourceKey !== configurationSourceKey(configuration) ||
          state.resolvedBranch !== head.reference ||
          (head.revision ?? "unborn") !== conflict.remoteRevision
        ) {
          throw coded(
            "skill_sync_conflict_stale",
            "The remote repository changed. Synchronize again.",
          );
        }
        const local = await localSkills(state);
        const localSkill = local.skills.get(syncKey);
        if (fingerprint(localSkill) !== conflict.local.fingerprint) {
          throw coded("skill_sync_conflict_stale", "The local Skill changed. Synchronize again.");
        }
        if (choice === "remote") {
          const remoteSkill = head.repository.skills.get(syncKey);
          const applied = await applyRemote(syncKey, remoteSkill, localSkill);
          if (remoteSkill === undefined || applied === undefined)
            delete state.portableFiles[syncKey];
          else state.portableFiles[syncKey] = portableFilesFor(applied, remoteSkill);
        } else {
          const desired = new Map(head.repository.skills);
          if (localSkill === undefined) desired.delete(syncKey);
          else desired.set(syncKey, localSkill);
          const published = await provider.publish({
            expectedRevision: head.revision,
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
  options: { readonly env?: NodeJS.ProcessEnv | undefined } = {},
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
    await git(repositoryPath, ["clean", "-fd", "--", ROOT_MANIFEST, SKILLS_DIRECTORY]);
    return { reference, ...(revision === undefined ? {} : { revision }) };
  };
  return {
    async readHead() {
      const prepared = await prepare();
      const fileModes = await readGitFileModes(repositoryPath, git);
      return { ...prepared, repository: await readWorkingRepository(repositoryPath, fileModes) };
    },
    async publish(input) {
      const prepared = await prepare();
      if (prepared.revision !== input.expectedRevision) return { status: "head_changed" };
      const identity = await readGlobalGitIdentity(git);
      await writeWorkingRepository(repositoryPath, input.repository);
      await git(repositoryPath, ["add", "--", ROOT_MANIFEST, SKILLS_DIRECTORY]);
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
        await git(repositoryPath, ["push", "origin", `${commit}:refs/heads/${prepared.reference}`]);
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
  return capability.manifest.origin === undefined
    ? { kind: "capability", id: capability.manifest.id }
    : { kind: "pragma-bundle", logicalId: capability.manifest.origin.logicalId };
}

function identityKey(identity: SkillSyncIdentity): string {
  return identity.kind === "capability"
    ? `capability/${identity.id}`
    : `bundle/${identity.logicalId}`;
}

function portableFilesFor(capability: Capability, skill: RemoteSkill) {
  if (capability.definition.kind !== "skill") {
    throw coded("skill_sync_capability_invalid", "The synchronized capability is not a Skill.");
  }
  return StoredPortableFilesSchema.parse({
    capabilityId: capability.manifest.id,
    capabilityRevision: capability.manifest.latestRevision,
    capabilityContentHash: capability.definition.contentHash,
    files: skill.files.map(({ path, executable }) => ({ path, executable })),
  });
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
    SkillSyncRepositoryManifestSchema.parse(
      parse(await readUtf8Bounded(join(root, ROOT_MANIFEST), MAX_MANIFEST_BYTES)),
    );
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
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      (entry.name !== "capability" && entry.name !== "bundle")
    ) {
      throw coded("skill_sync_entry_invalid", `Invalid managed entry: ${entry.name}`);
    }
  }
  for (const kind of ["capability", "bundle"] as const) {
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
      const manifest = SkillSyncSkillManifestSchema.parse(
        parse(await readUtf8Bounded(join(base, "skill.yaml"), MAX_MANIFEST_BYTES)),
      );
      const key = identityKey(manifest.identity);
      if (key !== `${kind}/${entry.name}`)
        throw coded(
          "skill_sync_identity_mismatch",
          `Skill path does not match its identity: ${key}`,
        );
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
        identity: manifest.identity,
        name: manifest.name,
        description: manifest.description,
        files,
      };
      skills.set(key, remote);
      if (skills.size > MAX_REPOSITORY_SKILLS)
        throw coded("skill_sync_size_limit", "The Skill repository has too many Skills.");
    }
  }
  return { skills };
}

async function readGitFileModes(
  root: string,
  git: GitRunner,
): Promise<ReadonlyMap<string, string>> {
  const output = await git(root, ["ls-files", "--stage", "-z", "--", SKILLS_DIRECTORY]);
  const modes = new Map<string, string>();
  for (const record of output.split("\0")) {
    if (record === "") continue;
    const match = /^(\d+) [a-f0-9]+ \d+\t(.+)$/u.exec(record);
    if (match === null) throw coded("skill_sync_git_index_invalid", "Invalid Git index entry.");
    modes.set(match[2]!, match[1]!);
  }
  return modes;
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
  await writeFile(join(root, ROOT_MANIFEST), stringify({ schemaVersion: "pragma.skill-sync/v1" }));
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
    const manifest: SkillSyncSkillManifest = SkillSyncSkillManifestSchema.parse({
      schemaVersion: "pragma.skill-sync-skill/v1",
      identity: skill.identity,
      name: skill.name,
      description: skill.description,
      files,
    });
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
      canonicalRemote((await git(path, ["config", "--get", "remote.origin.url"])).trim()) ===
      canonicalRemote(remote)
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
    env: {
      ...environment,
      GIT_TERMINAL_PROMPT: "0",
      ...(environment.GIT_SSH_COMMAND === undefined
        ? { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }
        : {}),
    },
  });
  return stdout;
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

function canonicalRemote(value: string): string {
  return value
    .trim()
    .replace(/\/$/u, "")
    .replace(/\.git$/u, "");
}
function configurationSourceKey(configuration: SkillSyncConfiguration): string {
  return JSON.stringify([canonicalRemote(configuration.remote), configuration.branch ?? null]);
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
