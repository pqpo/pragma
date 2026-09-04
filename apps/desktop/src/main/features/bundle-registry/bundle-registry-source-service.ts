import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { withFileLock } from "@pragma/core";
import { decodePragmaBundle, loadPragmaProject } from "@pragma/interpreter";
import { canonicalPragmaResourceRef } from "@pragma/interpreter/ast";
import {
  BUNDLE_SOURCE_KIND_DIRECTORIES,
  BundleSourceItemSummarySchema,
  BundleSourceManifestSchema,
  bundleSourceItemDirectory,
  bundleSourceRootPrefix,
  parseBundleSourceItem,
  parseBundleSourceManifest,
  parseBundleSourceRepositoryEntry,
  type BundleSourceItemSummary,
  type BundleSourceKind,
} from "@pragma/shared";
import { parse } from "yaml";

import {
  DesktopBundleRegistrySnapshotSchema,
  DesktopBundleRegistrySourcesSchema,
  type AddDesktopBundleRegistrySource,
  type DesktopBundleRegistrySourceStatus,
  type DesktopSquareBundleDownload,
  type DesktopSquareCatalog,
  type DesktopSquareItemDetail,
  type DownloadDesktopSquareBundle,
  type GetDesktopSquareItem,
  type UpdateDesktopBundleRegistrySource,
} from "../../../shared/contracts/index.ts";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const CONFIG_BLOB_LIMIT = 2 * 1024 * 1024;
const CONFIG_BATCH_LIMIT = 64 * 1024 * 1024;
const LS_TREE_LIMIT = 32 * 1024 * 1024;

type StoredSources = ReturnType<typeof DesktopBundleRegistrySourcesSchema.parse>;
type StoredSource = StoredSources["sources"][number];
type Snapshot = ReturnType<typeof DesktopBundleRegistrySnapshotSchema.parse>;

interface GitTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly objectId: string;
  readonly path: string;
}

export interface DesktopBundleRegistrySourceService {
  listSources(): Promise<readonly DesktopBundleRegistrySourceStatus[]>;
  addSource(input: AddDesktopBundleRegistrySource): Promise<DesktopBundleRegistrySourceStatus>;
  updateSource(
    input: UpdateDesktopBundleRegistrySource,
  ): Promise<DesktopBundleRegistrySourceStatus>;
  removeSource(sourceId: string): Promise<void>;
  refreshSource(sourceId: string): Promise<DesktopBundleRegistrySourceStatus>;
  refreshEnabledSources(): Promise<readonly DesktopBundleRegistrySourceStatus[]>;
  getCatalog(): Promise<DesktopSquareCatalog>;
  getItem(input: GetDesktopSquareItem): Promise<DesktopSquareItemDetail>;
  downloadBundle(input: DownloadDesktopSquareBundle): Promise<DesktopSquareBundleDownload>;
}

export function createDesktopBundleRegistrySourceService(options: {
  readonly sourcesPath: string;
  readonly cacheRoot: string;
  readonly officialSource?:
    | { readonly name: string; readonly remote: string; readonly ref?: string | undefined }
    | undefined;
}): DesktopBundleRegistrySourceService {
  const lockPath = `${options.sourcesPath}.lock`;
  const repositoriesRoot = join(options.cacheRoot, "repositories");
  const snapshotsRoot = join(options.cacheRoot, "snapshots");
  const artifactsRoot = join(options.cacheRoot, "artifacts", "sha256");
  const transientStatuses = new Map<string, DesktopBundleRegistrySourceStatus>();
  const refreshOperations = new Map<string, Promise<DesktopBundleRegistrySourceStatus>>();

  const readSources = async (): Promise<StoredSources> => {
    try {
      const parsed = DesktopBundleRegistrySourcesSchema.parse(
        JSON.parse(await readFile(options.sourcesPath, "utf8")),
      );
      return withOfficialSource(parsed, options.officialSource);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return withOfficialSource(
          { schemaVersion: "pragma.desktop-bundle-registry-sources/v1", sources: [] },
          options.officialSource,
        );
      }
      throw new Error("Bundle Source configuration is unreadable.", { cause: error });
    }
  };

  const writeSources = async (sources: StoredSources): Promise<void> => {
    await writeJsonAtomically(options.sourcesPath, {
      schemaVersion: "pragma.desktop-bundle-registry-sources/v1",
      sources: sources.sources,
    });
  };

  const readSnapshot = async (sourceId: string): Promise<Snapshot | undefined> => {
    try {
      return DesktopBundleRegistrySnapshotSchema.parse(
        JSON.parse(await readFile(snapshotPath(snapshotsRoot, sourceId), "utf8")),
      );
    } catch {
      return undefined;
    }
  };

  const statusFor = async (source: StoredSource): Promise<DesktopBundleRegistrySourceStatus> => {
    const transient = transientStatuses.get(source.id);
    if (transient !== undefined) return transient;
    const snapshot = await readSnapshot(source.id);
    return {
      ...source,
      status: snapshot === undefined ? "error" : "ready",
      ...(snapshot === undefined
        ? { errorCode: "source_not_synced", errorMessage: "This source has not been synced." }
        : {
            commit: snapshot.commit,
            syncedAt: snapshot.syncedAt,
            itemCount: snapshot.items.length,
          }),
    };
  };

  const refreshOnce = async (source: StoredSource): Promise<DesktopBundleRegistrySourceStatus> => {
    const previous = await readSnapshot(source.id);
    transientStatuses.set(source.id, { ...source, status: "syncing" });
    try {
      const repositoryPath = join(repositoriesRoot, source.id);
      await ensureRepository(repositoryPath, source.remote);
      await runGit(repositoryPath, [
        "fetch",
        "--force",
        "--prune",
        "--depth=1",
        "--filter=blob:none",
        "origin",
        source.ref ?? "HEAD",
      ]);
      const commit = (await runGit(repositoryPath, ["rev-parse", "FETCH_HEAD"])).trim();
      const manifest = parseBundleSourceManifest(
        parse(await readGitBlob(repositoryPath, commit, "pragma-source.yaml", CONFIG_BLOB_LIMIT)),
      );
      const tree = await readGitTree(repositoryPath, commit);
      const unsafeEntry = tree.find(
        (entry) => entry.mode === "120000" || entry.mode === "160000" || entry.type === "commit",
      );
      if (unsafeEntry !== undefined) {
        throw new Error(
          `Bundle Source symlinks and submodules are not allowed: ${unsafeEntry.path}`,
        );
      }
      const manifestEntry = tree.find((entry) => entry.path === "pragma-source.yaml");
      if (manifestEntry?.mode !== "100644" || manifestEntry.type !== "blob") {
        throw new Error("pragma-source.yaml must be a regular file.");
      }
      const items = await loadSourceItems(repositoryPath, manifest, tree);
      const snapshot = DesktopBundleRegistrySnapshotSchema.parse({
        schemaVersion: "pragma.desktop-bundle-source-snapshot/v3",
        commit,
        syncedAt: new Date().toISOString(),
        manifest,
        items,
      });
      await writeJsonAtomically(snapshotPath(snapshotsRoot, source.id), snapshot);
      const status: DesktopBundleRegistrySourceStatus = {
        ...source,
        status: "ready",
        commit,
        syncedAt: snapshot.syncedAt,
        itemCount: items.length,
      };
      transientStatuses.set(source.id, status);
      return status;
    } catch (error) {
      const status: DesktopBundleRegistrySourceStatus = {
        ...source,
        status: previous === undefined ? "error" : "stale",
        ...(previous === undefined
          ? {}
          : {
              commit: previous.commit,
              syncedAt: previous.syncedAt,
              itemCount: previous.items.length,
            }),
        errorCode: sourceErrorCode(error),
        errorMessage: error instanceof Error ? error.message : "Bundle Source sync failed.",
      };
      transientStatuses.set(source.id, status);
      return status;
    }
  };

  const refresh = (source: StoredSource): Promise<DesktopBundleRegistrySourceStatus> => {
    const active = refreshOperations.get(source.id);
    if (active !== undefined) return active;
    const operation = refreshOnce(source).finally(() => refreshOperations.delete(source.id));
    refreshOperations.set(source.id, operation);
    return operation;
  };

  return {
    async listSources() {
      const sources = sourcePriorityOrder((await readSources()).sources);
      return await Promise.all(sources.map(statusFor));
    },
    async addSource(input) {
      assertSafeRemote(input.remote);
      const current = await readSources();
      if (
        current.sources.some(
          (source) => canonicalRemote(source.remote) === canonicalRemote(input.remote),
        )
      ) {
        throw new Error("This Git Bundle Source is already configured.");
      }
      const source: StoredSource = {
        id: randomUUID(),
        name: input.name,
        remote: input.remote,
        ...(input.ref === undefined ? {} : { ref: input.ref }),
        enabled: true,
        official: false,
        order: current.sources.filter((candidate) => !candidate.official).length,
      };
      const status = await refresh(source);
      if (status.status === "error") {
        await rm(join(repositoriesRoot, source.id), { recursive: true, force: true });
        transientStatuses.delete(source.id);
        throw new Error(status.errorMessage ?? "Bundle Source validation failed.");
      }
      try {
        await withFileLock(lockPath, async () => {
          const latest = await readSources();
          if (
            latest.sources.some(
              (candidate) => canonicalRemote(candidate.remote) === canonicalRemote(source.remote),
            )
          ) {
            throw new Error("This Git Bundle Source is already configured.");
          }
          await writeSources({ ...latest, sources: [...latest.sources, source] });
        });
      } catch (error) {
        transientStatuses.delete(source.id);
        await rm(join(repositoriesRoot, source.id), { recursive: true, force: true });
        await rm(snapshotPath(snapshotsRoot, source.id), { force: true });
        throw error;
      }
      return status;
    },
    async updateSource(input) {
      let updated: StoredSource | undefined;
      await withFileLock(lockPath, async () => {
        const current = await readSources();
        const source = current.sources.find((candidate) => candidate.id === input.sourceId);
        if (source === undefined) throw new Error("Bundle Source was not found.");
        updated = {
          ...source,
          name: input.name ?? source.name,
          enabled: input.enabled ?? source.enabled,
          order: input.order ?? source.order,
          ...(input.ref === null
            ? { ref: undefined }
            : input.ref === undefined
              ? {}
              : { ref: input.ref }),
        };
        await writeSources({
          ...current,
          sources: current.sources.map((candidate) =>
            candidate.id === input.sourceId ? updated! : candidate,
          ),
        });
      });
      if (updated === undefined) throw new Error("Bundle Source update did not complete.");
      transientStatuses.delete(updated.id);
      return await statusFor(updated);
    },
    async removeSource(sourceId) {
      await withFileLock(lockPath, async () => {
        const current = await readSources();
        const source = current.sources.find((candidate) => candidate.id === sourceId);
        if (source?.official === true)
          throw new Error("The official Bundle Source cannot be removed.");
        await writeSources({
          ...current,
          sources: current.sources.filter((candidate) => candidate.id !== sourceId),
        });
      });
      transientStatuses.delete(sourceId);
      await rm(join(repositoriesRoot, sourceId), { recursive: true, force: true });
      await rm(snapshotPath(snapshotsRoot, sourceId), { force: true });
    },
    async refreshSource(sourceId) {
      const source = (await readSources()).sources.find((candidate) => candidate.id === sourceId);
      if (source === undefined) throw new Error("Bundle Source was not found.");
      return await refresh(source);
    },
    async refreshEnabledSources() {
      const sources = (await readSources()).sources.filter((source) => source.enabled);
      return await Promise.all(sources.map(refresh));
    },
    async getCatalog() {
      const sources = sourcePriorityOrder((await readSources()).sources);
      const statuses = await Promise.all(sources.map(statusFor));
      const items: DesktopSquareCatalog["items"] = [];
      const categories: DesktopSquareCatalog["categories"] = [];
      const seenCategories = new Set<string>();
      for (const source of sources) {
        if (!source.enabled) continue;
        const snapshot = await readSnapshot(source.id);
        if (snapshot === undefined) continue;
        items.push(
          ...snapshot.items.map((item) => ({
            ...item,
            sourceId: source.id,
            sourceName: source.name,
            sourceOfficial: source.official,
            commit: snapshot.commit,
          })),
        );
        for (const kind of ["expert", "expert-team", "flow", "knowledge-base"] as const) {
          for (const category of snapshot.manifest.sections[kind].categories) {
            const key = `${kind}:${category.id}`;
            if (seenCategories.has(key)) continue;
            seenCategories.add(key);
            categories.push({ ...category, kind });
          }
        }
      }
      return { items, categories, sources: statuses };
    },
    async getItem(input) {
      const source = (await readSources()).sources.find(
        (candidate) => candidate.id === input.sourceId,
      );
      const snapshot = await readSnapshot(input.sourceId);
      if (source === undefined || snapshot === undefined)
        throw new Error("Bundle Source is unavailable.");
      const item = findSnapshotItem(snapshot, input);
      return {
        sourceId: source.id,
        sourceName: source.name,
        sourceOfficial: source.official,
        commit: snapshot.commit,
        item,
      };
    },
    async downloadBundle(input) {
      const source = (await readSources()).sources.find(
        (candidate) => candidate.id === input.sourceId,
      );
      const snapshot = await readSnapshot(input.sourceId);
      if (source === undefined || snapshot === undefined)
        throw new Error("Bundle Source is unavailable.");
      const item = findSnapshotItem(snapshot, input);
      if (!item.versions.includes(input.version))
        throw new Error("Bundle Source item version was not found.");
      const bundlePath = `${bundleSourceItemDirectory({
        kind: item.kind,
        categoryId: item.categoryId,
        itemId: item.id,
      })}/versions/${input.version}/bundle.pragma`;
      const temporary = join(options.cacheRoot, "artifacts", "tmp", `${randomUUID()}.pragma`);
      await mkdir(dirname(temporary), { recursive: true, mode: 0o700 });
      try {
        const result = await writeGitBlob(
          join(repositoriesRoot, source.id),
          snapshot.commit,
          bundlePath,
          temporary,
          snapshot.manifest.maxBundleBytes,
        );
        await validateDownloadedBundle(temporary, item);
        const destination = join(
          artifactsRoot,
          result.sha256.slice(0, 2),
          `${result.sha256}.pragma`,
        );
        try {
          if (
            (await stat(destination)).size === result.bytes &&
            (await hashFile(destination)) === result.sha256
          ) {
            await rm(temporary, { force: true });
            return {
              path: destination,
              rootRef: item.rootRef,
              sha256: result.sha256,
              cached: true,
            };
          }
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) throw error;
        }
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await rm(destination, { force: true });
        await rename(temporary, destination);
        return {
          path: destination,
          rootRef: item.rootRef,
          sha256: result.sha256,
          cached: false,
        };
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
  };
}

async function loadSourceItems(
  repositoryPath: string,
  manifest: ReturnType<typeof BundleSourceManifestSchema.parse>,
  tree: readonly GitTreeEntry[],
): Promise<BundleSourceItemSummary[]> {
  const sourceRoots = new Set<string>(Object.values(BUNDLE_SOURCE_KIND_DIRECTORIES));
  const parsed = tree
    .filter((entry) => sourceRoots.has(entry.path.split("/")[0] ?? ""))
    .map((entry) => {
      if (entry.mode !== "100644" || entry.type !== "blob") {
        throw new Error(`Bundle Source item paths must be regular files: ${entry.path}`);
      }
      const value = parseBundleSourceRepositoryEntry(entry.path);
      if (value === undefined)
        throw new Error(`Unsupported Bundle Source item file: ${entry.path}`);
      return { entry, value };
    });
  const configs = parsed.filter(
    (entry): entry is typeof entry & { value: Extract<typeof entry.value, { kind: "config" }> } =>
      entry.value.kind === "config",
  );
  const bundles = parsed.filter(
    (entry): entry is typeof entry & { value: Extract<typeof entry.value, { kind: "bundle" }> } =>
      entry.value.kind === "bundle",
  );
  const seen = new Set<string>();
  const items: BundleSourceItemSummary[] = [];
  const configBlobs = await readGitBlobs(
    repositoryPath,
    configs.map((config) => config.entry.objectId),
    CONFIG_BATCH_LIMIT,
  );
  for (const config of configs) {
    const key = `${config.value.sourceKind}:${config.value.itemId}`;
    if (seen.has(key)) throw new Error(`Duplicate Bundle Source item: ${key}`);
    seen.add(key);
    const configText = configBlobs.get(config.entry.objectId);
    if (configText === undefined)
      throw new Error(`Bundle Source config blob is missing: ${config.entry.path}`);
    if (Buffer.byteLength(configText, "utf8") > CONFIG_BLOB_LIMIT) {
      throw new Error(`Bundle Source config is too large: ${config.entry.path}`);
    }
    const item = parseBundleSourceItem(parse(configText));
    if (item.id !== config.value.itemId)
      throw new Error(`Bundle Source item id does not match its directory: ${config.entry.path}`);
    if (!item.rootRef.startsWith(`${bundleSourceRootPrefix(config.value.sourceKind)}:`)) {
      throw new Error(`Bundle Source rootRef does not match item kind: ${config.entry.path}`);
    }
    if (
      !manifest.sections[config.value.sourceKind].categories.some(
        (category) => category.id === config.value.categoryId,
      )
    ) {
      throw new Error(`Bundle Source item uses an unknown category: ${config.value.categoryId}`);
    }
    const versions = bundles
      .filter(
        (bundle) =>
          bundle.value.sourceKind === config.value.sourceKind &&
          bundle.value.categoryId === config.value.categoryId &&
          bundle.value.itemId === config.value.itemId,
      )
      .map((bundle) => bundle.value.version)
      .toSorted();
    if (!versions.includes(item.latestVersion))
      throw new Error(`Latest Bundle Source version is missing: ${item.id}@${item.latestVersion}`);
    items.push(
      BundleSourceItemSummarySchema.parse({
        ...item,
        kind: config.value.sourceKind,
        categoryId: config.value.categoryId,
        versions,
        configPath: config.entry.path,
      }),
    );
  }
  if (
    bundles.some(
      (bundle) =>
        !configs.some(
          (config) =>
            config.value.sourceKind === bundle.value.sourceKind &&
            config.value.categoryId === bundle.value.categoryId &&
            config.value.itemId === bundle.value.itemId,
        ),
    )
  ) {
    throw new Error("Bundle Source contains a version without config.yaml.");
  }
  return items;
}

function findSnapshotItem(
  snapshot: Snapshot,
  input: { readonly kind: BundleSourceKind; readonly itemId: string },
): BundleSourceItemSummary {
  const item = snapshot.items.find(
    (candidate) => candidate.kind === input.kind && candidate.id === input.itemId,
  );
  if (item === undefined) throw new Error("Bundle Source item was not found.");
  return item;
}

async function validateDownloadedBundle(
  path: string,
  item: BundleSourceItemSummary,
): Promise<void> {
  const decoded = await decodePragmaBundle({ kind: "file", path });
  if (!decoded.manifest.roots.includes(item.rootRef)) {
    throw new Error(`Downloaded Bundle does not contain configured root ${item.rootRef}.`);
  }
  const project = await loadPragmaProject({ kind: "decoded-bundle", bundle: decoded });
  try {
    const root = project
      .listResources()
      .find((resource) => canonicalPragmaResourceRef(resource) === item.rootRef);
    const expectedKind =
      item.kind === "expert"
        ? "Expert"
        : item.kind === "expert-team"
          ? "ExpertTeam"
          : item.kind === "flow"
            ? "Flow"
            : "ContextStore";
    if (root?.kind !== expectedKind) {
      throw new Error(`Downloaded Bundle root type does not match ${item.kind}.`);
    }
  } finally {
    await project.dispose();
  }
}

function sourcePriorityOrder(sources: readonly StoredSource[]): StoredSource[] {
  return [...sources].toSorted(
    (left, right) => Number(right.official) - Number(left.official) || left.order - right.order,
  );
}

function withOfficialSource(
  sources: StoredSources,
  official:
    | { readonly name: string; readonly remote: string; readonly ref?: string | undefined }
    | undefined,
): StoredSources {
  if (official === undefined) {
    return DesktopBundleRegistrySourcesSchema.parse({
      ...sources,
      sources: sources.sources.filter((source) => !source.official),
    });
  }
  const id = officialSourceId(official.remote);
  const storedOfficial = sources.sources.find((source) => source.official);
  const officialEntry: StoredSource = {
    id,
    name: official.name,
    remote: official.remote,
    ...(official.ref === undefined ? {} : { ref: official.ref }),
    enabled: storedOfficial?.enabled ?? true,
    official: true,
    order: 0,
  };
  return DesktopBundleRegistrySourcesSchema.parse({
    ...sources,
    sources: [officialEntry, ...sources.sources.filter((source) => !source.official)],
  });
}

function officialSourceId(remote: string): string {
  const hex = createHash("sha256").update(remote).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

async function ensureRepository(path: string, remote: string): Promise<void> {
  try {
    await stat(join(path, "HEAD"));
    const currentRemote = (await runGit(path, ["config", "--get", "remote.origin.url"])).trim();
    if (canonicalRemote(currentRemote) !== canonicalRemote(remote)) {
      throw new Error("Bundle Source cache remote does not match its configuration.");
    }
    return;
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(dirname(path), { recursive: true });
  await runGit(undefined, ["init", "--bare", temporary]);
  await runGit(temporary, ["remote", "add", "origin", remote]);
  await rename(temporary, path);
}

async function runGit(
  repositoryPath: string | undefined,
  args: readonly string[],
): Promise<string> {
  const completeArgs = repositoryPath === undefined ? [...args] : ["-C", repositoryPath, ...args];
  const { stdout } = await execFileAsync("git", completeArgs, {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: LS_TREE_LIMIT,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    },
  });
  return stdout;
}

async function readGitTree(repositoryPath: string, commit: string): Promise<GitTreeEntry[]> {
  const output = await runGit(repositoryPath, ["ls-tree", "-r", "-z", commit]);
  return output
    .split("\0")
    .filter((record) => record.length > 0)
    .map((record) => {
      const match = /^(\d+) ([a-z]+) ([a-f0-9]+)\t(.+)$/u.exec(record);
      if (match === null) throw new Error("Git returned an invalid tree entry.");
      return { mode: match[1]!, type: match[2]!, objectId: match[3]!, path: match[4]! };
    });
}

async function readGitBlob(
  repositoryPath: string,
  commit: string,
  path: string,
  maxBytes: number,
): Promise<string> {
  assertGitObjectPath(path);
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repositoryPath, "show", `${commit}:${path}`],
    {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: maxBytes,
      env: gitEnvironment(),
    },
  );
  if (Buffer.byteLength(stdout, "utf8") > maxBytes)
    throw new Error(`Bundle Source config is too large: ${path}`);
  return stdout;
}

async function readGitBlobs(
  repositoryPath: string,
  objectIds: readonly string[],
  maxBytes: number,
): Promise<Map<string, string>> {
  if (objectIds.length === 0) return new Map();
  const child = spawn("git", ["-C", repositoryPath, "cat-file", "--batch"], {
    env: gitEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) child.kill();
    else chunks.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 4_000) stderr += chunk.toString("utf8");
  });
  const completed = new Promise<void>((resolvePromise, reject) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, GIT_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (bytes > maxBytes) reject(new Error("Bundle Source config batch is too large."));
      else if (code === 0) resolvePromise();
      else if (timedOut) reject(new Error("git cat-file timed out."));
      else reject(new Error(stderr.trim() || `git cat-file exited with code ${String(code)}.`));
    });
  });
  child.stdin.end(`${objectIds.join("\n")}\n`);
  await completed;
  const output = Buffer.concat(chunks);
  const blobs = new Map<string, string>();
  let offset = 0;
  for (const requestedId of objectIds) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd < 0) throw new Error("Git returned a truncated config batch header.");
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const match = /^([a-f0-9]+) blob (\d+)$/u.exec(header);
    if (match === null) throw new Error(`Git could not read Bundle Source config ${requestedId}.`);
    const blobBytes = Number(match[2]);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + blobBytes;
    if (contentEnd >= output.length || output[contentEnd] !== 10) {
      throw new Error("Git returned a truncated config blob.");
    }
    blobs.set(match[1]!, output.subarray(contentStart, contentEnd).toString("utf8"));
    offset = contentEnd + 1;
  }
  return blobs;
}

async function writeGitBlob(
  repositoryPath: string,
  commit: string,
  path: string,
  destination: string,
  maxBytes: number,
): Promise<{ readonly bytes: number; readonly sha256: string }> {
  assertGitObjectPath(path);
  const child = spawn("git", ["-C", repositoryPath, "show", `${commit}:${path}`], {
    env: gitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const hash = createHash("sha256");
  let bytes = 0;
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 4_000) stderr += chunk.toString("utf8");
  });
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        child.kill();
        callback(new Error("Bundle exceeded the Source size limit."));
        return;
      }
      hash.update(chunk);
      callback(undefined, chunk);
    },
  });
  const exit = new Promise<void>((resolvePromise, reject) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, GIT_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else if (timedOut) reject(new Error("git show timed out."));
      else reject(new Error(stderr.trim() || `git show exited with code ${String(code)}.`));
    });
  });
  await Promise.all([
    pipeline(child.stdout, limiter, createWriteStream(destination, { mode: 0o600 })),
    exit,
  ]);
  return { bytes, sha256: hash.digest("hex") };
}

function assertSafeRemote(remote: string): void {
  if (remote.startsWith("https://") || remote.startsWith("ssh://")) {
    const parsed = new URL(remote);
    if (parsed.password !== "" || (parsed.protocol === "https:" && parsed.username !== "")) {
      throw new Error("Git credentials must not be embedded in a Bundle Source URL.");
    }
    return;
  }
  if (/^[A-Za-z0-9._-]+@[^:\s]+:[^\s]+$/u.test(remote)) return;
  throw new Error("Only HTTPS and SSH Git Bundle Source remotes are supported.");
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
  };
}

function canonicalRemote(remote: string): string {
  return remote
    .trim()
    .replace(/\.git$/u, "")
    .replace(/\/$/u, "")
    .toLowerCase();
}

function assertGitObjectPath(path: string): void {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe Bundle Source object path: ${path}`);
  }
}

function snapshotPath(root: string, sourceId: string): string {
  return join(root, `${sourceId}.json`);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function sourceErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (isNodeError(error, "ENOENT")) return "git_unavailable";
  if (message.includes("not found") && message.includes("git")) return "git_unavailable";
  if (message.includes("authentication") || message.includes("permission denied"))
    return "git_auth_failed";
  if (message.includes("schema") || message.includes("parse") || message.includes("source"))
    return "source_protocol_invalid";
  return "source_sync_failed";
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
