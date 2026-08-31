import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { withFileLock } from "@pragma/core";
import {
  BundleRegistryCatalogIndexSchema,
  BundleRegistryCategoryCatalogSchema,
  BundleRegistryManifestSchema,
  BundleRegistryPackageSchema,
  BundleRegistryPackageShardSchema,
  type BundleRegistryPackageSummary,
} from "@pragma/shared";
import { parse } from "yaml";

import {
  DesktopBundleRegistrySnapshotSchema,
  DesktopBundleRegistrySourcesSchema,
  type AddDesktopBundleRegistrySource,
  type DesktopBundleRegistrySourceStatus,
  type DesktopSquareBundleDownload,
  type DesktopSquareCatalog,
  type DesktopSquarePackageDetail,
  type DownloadDesktopSquareBundle,
  type GetDesktopSquarePackage,
  type UpdateDesktopBundleRegistrySource,
} from "../../../shared/contracts/index.ts";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const CATALOG_BLOB_LIMIT = 16 * 1024 * 1024;

type StoredSources = ReturnType<typeof DesktopBundleRegistrySourcesSchema.parse>;
type StoredSource = StoredSources["sources"][number];
type Snapshot = ReturnType<typeof DesktopBundleRegistrySnapshotSchema.parse>;

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
  getPackage(input: GetDesktopSquarePackage): Promise<DesktopSquarePackageDetail>;
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
      throw new Error("Bundle Registry source configuration is unreadable.", { cause: error });
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
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
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
        ? { errorCode: "registry_not_synced", errorMessage: "This source has not been synced." }
        : {
            commit: snapshot.commit,
            syncedAt: snapshot.syncedAt,
            packageCount: snapshot.packages.length,
          }),
    };
  };

  const refreshOnce = async (source: StoredSource): Promise<DesktopBundleRegistrySourceStatus> => {
    const previous = await readSnapshot(source.id);
    transientStatuses.set(source.id, { ...source, status: "syncing" });
    try {
      const repositoryPath = join(repositoriesRoot, source.id);
      await ensureRepository(repositoryPath, source.remote);
      const targetRef = source.ref ?? "HEAD";
      await runGit(repositoryPath, [
        "fetch",
        "--force",
        "--prune",
        "--depth=1",
        "--filter=blob:none",
        "origin",
        targetRef,
      ]);
      const commit = (await runGit(repositoryPath, ["rev-parse", "FETCH_HEAD"])).trim();
      const manifest = BundleRegistryManifestSchema.parse(
        parse(await readGitBlob(repositoryPath, commit, "pragma-registry.yaml", 1024 * 1024)),
      );
      const catalog = BundleRegistryCatalogIndexSchema.parse(
        JSON.parse(await readGitBlob(repositoryPath, commit, manifest.catalog, CATALOG_BLOB_LIMIT)),
      );
      if (catalog.registryId !== manifest.id) {
        throw new Error("Registry catalog identity does not match pragma-registry.yaml.");
      }
      const packages: BundleRegistryPackageSummary[] = [];
      const packageIds = new Set<string>();
      for (const shard of catalog.packageShards) {
        const sourceText = await readGitBlob(
          repositoryPath,
          commit,
          shard.path,
          CATALOG_BLOB_LIMIT,
        );
        if (hashText(sourceText) !== shard.sha256) {
          throw new Error(`Registry catalog shard hash mismatch: ${shard.path}`);
        }
        const parsed = BundleRegistryPackageShardSchema.parse(JSON.parse(sourceText));
        if (parsed.packages.length !== shard.count) {
          throw new Error(`Registry catalog shard count mismatch: ${shard.path}`);
        }
        for (const item of parsed.packages) {
          if (item.id[0] !== shard.prefix) {
            throw new Error(`Registry package is in the wrong shard: ${item.id}`);
          }
          if (packageIds.has(item.id)) {
            throw new Error(`Registry catalog contains a duplicate package: ${item.id}`);
          }
          packageIds.add(item.id);
        }
        packages.push(...parsed.packages);
      }
      if (packages.length !== catalog.packageCount) {
        throw new Error("Registry package count does not match its catalog index.");
      }
      const categoryIds = new Set(manifest.categories.map((category) => category.id));
      if (catalog.categoryIndexes.length !== categoryIds.size) {
        throw new Error("Registry catalog does not index every category.");
      }
      for (const category of catalog.categoryIndexes) {
        if (!categoryIds.has(category.categoryId)) {
          throw new Error(`Registry catalog uses an unknown category: ${category.categoryId}`);
        }
        const sourceText = await readGitBlob(
          repositoryPath,
          commit,
          category.path,
          CATALOG_BLOB_LIMIT,
        );
        if (hashText(sourceText) !== category.sha256) {
          throw new Error(`Registry category index hash mismatch: ${category.path}`);
        }
        const parsed = BundleRegistryCategoryCatalogSchema.parse(JSON.parse(sourceText));
        if (
          parsed.categoryId !== category.categoryId ||
          parsed.packageIds.length !== category.count ||
          new Set(parsed.packageIds).size !== parsed.packageIds.length ||
          parsed.packageIds.some((packageId) => !packageIds.has(packageId))
        ) {
          throw new Error(`Registry category index is inconsistent: ${category.path}`);
        }
      }
      const snapshot = DesktopBundleRegistrySnapshotSchema.parse({
        schemaVersion: "pragma.desktop-bundle-registry-snapshot/v1",
        commit,
        syncedAt: new Date().toISOString(),
        manifest,
        catalog,
        packages,
      });
      await writeJsonAtomically(snapshotPath(snapshotsRoot, source.id), snapshot);
      const status: DesktopBundleRegistrySourceStatus = {
        ...source,
        status: "ready",
        commit,
        syncedAt: snapshot.syncedAt,
        packageCount: packages.length,
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
              packageCount: previous.packages.length,
            }),
        errorCode: registryErrorCode(error),
        errorMessage: error instanceof Error ? error.message : "Registry sync failed.",
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
      const sources = (await readSources()).sources.toSorted(
        (left, right) => left.order - right.order,
      );
      return await Promise.all(sources.map(statusFor));
    },
    async addSource(input) {
      assertSafeRemote(input.remote);
      const duplicate = (await readSources()).sources.some(
        (source) => canonicalRemote(source.remote) === canonicalRemote(input.remote),
      );
      if (duplicate) throw new Error("This Git Registry source is already configured.");
      const source: StoredSource = {
        id: randomUUID(),
        name: input.name,
        remote: input.remote,
        ...(input.ref === undefined ? {} : { ref: input.ref }),
        enabled: true,
        official: false,
        order: (await readSources()).sources.length,
      };
      const status = await refresh(source);
      if (status.status === "error") {
        await rm(join(repositoriesRoot, source.id), { recursive: true, force: true });
        transientStatuses.delete(source.id);
        throw new Error(status.errorMessage ?? "Registry source validation failed.");
      }
      try {
        await withFileLock(lockPath, async () => {
          const current = await readSources();
          if (
            current.sources.some(
              (candidate) => canonicalRemote(candidate.remote) === canonicalRemote(source.remote),
            )
          ) {
            throw new Error("This Git Registry source is already configured.");
          }
          await writeSources({ ...current, sources: [...current.sources, source] });
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
        if (source === undefined) throw new Error("Bundle Registry source was not found.");
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
      if (updated === undefined) throw new Error("Bundle Registry source update did not complete.");
      transientStatuses.delete(updated.id);
      return await statusFor(updated);
    },
    async removeSource(sourceId) {
      await withFileLock(lockPath, async () => {
        const current = await readSources();
        const source = current.sources.find((candidate) => candidate.id === sourceId);
        if (source?.official === true)
          throw new Error("The official Registry source cannot be removed.");
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
      if (source === undefined) throw new Error("Bundle Registry source was not found.");
      return await refresh(source);
    },
    async refreshEnabledSources() {
      const sources = (await readSources()).sources.filter((source) => source.enabled);
      return await Promise.all(sources.map(refresh));
    },
    async getCatalog() {
      const sources = (await readSources()).sources.toSorted(
        (left, right) => left.order - right.order,
      );
      const statuses = await Promise.all(sources.map(statusFor));
      const packages: DesktopSquareCatalog["packages"][number][] = [];
      for (const source of sources) {
        if (!source.enabled) continue;
        const snapshot = await readSnapshot(source.id);
        if (snapshot === undefined) continue;
        packages.push(
          ...snapshot.packages.map((item) => ({
            ...item,
            sourceId: source.id,
            sourceName: source.name,
            sourceOfficial: source.official,
            commit: snapshot.commit,
          })),
        );
      }
      return { packages, sources: statuses };
    },
    async getPackage(input) {
      const source = (await readSources()).sources.find(
        (candidate) => candidate.id === input.sourceId,
      );
      const snapshot = await readSnapshot(input.sourceId);
      if (source === undefined || snapshot === undefined)
        throw new Error("Registry source is unavailable.");
      const summary = snapshot.packages.find((candidate) => candidate.id === input.packageId);
      if (summary === undefined) throw new Error("Registry package was not found.");
      const repositoryPath = join(repositoriesRoot, source.id);
      const item = BundleRegistryPackageSchema.parse(
        parse(
          await readGitBlob(repositoryPath, snapshot.commit, summary.packagePath, 2 * 1024 * 1024),
        ),
      );
      if (item.id !== summary.id)
        throw new Error("Registry package identity does not match its catalog.");
      const readmePath = localizedReadme(item, undefined);
      const readme = await readGitBlob(repositoryPath, snapshot.commit, readmePath, 512 * 1024);
      return {
        sourceId: source.id,
        sourceName: source.name,
        sourceOfficial: source.official,
        commit: snapshot.commit,
        package: item,
        readme,
      };
    },
    async downloadBundle(input) {
      const source = (await readSources()).sources.find(
        (candidate) => candidate.id === input.sourceId,
      );
      const snapshot = await readSnapshot(input.sourceId);
      if (source === undefined || snapshot === undefined)
        throw new Error("Registry source is unavailable.");
      const summary = snapshot.packages.find((candidate) => candidate.id === input.packageId);
      if (summary === undefined) throw new Error("Registry package was not found.");
      const item = BundleRegistryPackageSchema.parse(
        parse(
          await readGitBlob(
            join(repositoriesRoot, source.id),
            snapshot.commit,
            summary.packagePath,
            2 * 1024 * 1024,
          ),
        ),
      );
      if (item.id !== summary.id)
        throw new Error("Registry package identity does not match its catalog.");
      const version = item.versions.find((candidate) => candidate.version === input.version);
      if (version === undefined) throw new Error("Registry package version was not found.");
      const destination = join(
        artifactsRoot,
        version.bundle.sha256.slice(0, 2),
        `${version.bundle.sha256}.pragma`,
      );
      try {
        const existing = await stat(destination);
        if (
          existing.size === version.bundle.size &&
          (await hashFile(destination)) === version.bundle.sha256
        ) {
          return { path: destination, sha256: version.bundle.sha256, cached: true };
        }
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
      await mkdir(dirname(destination), { recursive: true });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        const result = await writeGitBlob(
          join(repositoriesRoot, source.id),
          snapshot.commit,
          version.bundle.path,
          temporary,
          version.bundle.size,
        );
        if (result.bytes !== version.bundle.size || result.sha256 !== version.bundle.sha256) {
          throw new Error("Downloaded Registry Bundle does not match its catalog metadata.");
        }
        await rename(temporary, destination);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return { path: destination, sha256: version.bundle.sha256, cached: false };
    },
  };
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
    const currentRemote = (await runGit(path, ["remote", "get-url", "origin"])).trim();
    if (canonicalRemote(currentRemote) !== canonicalRemote(remote)) {
      throw new Error("Registry cache remote does not match its source configuration.");
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
    maxBuffer: CATALOG_BLOB_LIMIT,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    },
  });
  return stdout;
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
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  if (Buffer.byteLength(stdout, "utf8") > maxBytes)
    throw new Error(`Registry blob is too large: ${path}`);
  return stdout;
}

async function writeGitBlob(
  repositoryPath: string,
  commit: string,
  path: string,
  destination: string,
  expectedBytes: number,
): Promise<{ readonly bytes: number; readonly sha256: string }> {
  assertGitObjectPath(path);
  const child = spawn("git", ["-C", repositoryPath, "show", `${commit}:${path}`], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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
      if (bytes > expectedBytes) {
        child.kill();
        callback(new Error("Registry Bundle exceeded its declared size."));
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
      throw new Error("Git credentials must not be embedded in a Registry URL.");
    }
    return;
  }
  if (/^[A-Za-z0-9._-]+@[^:\s]+:[^\s]+$/u.test(remote)) return;
  throw new Error("Only HTTPS and SSH Git Registry remotes are supported.");
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
    throw new Error(`Unsafe Registry object path: ${path}`);
  }
}

function localizedReadme(
  item: ReturnType<typeof BundleRegistryPackageSchema.parse>,
  locale: "en" | "zh-Hans" | "zh-Hant" | undefined,
): string {
  return (locale === undefined ? undefined : item.localizedReadmes?.[locale]) ?? item.readme;
}

function snapshotPath(root: string, sourceId: string): string {
  return join(root, `${sourceId}.json`);
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function registryErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (isNodeError(error, "ENOENT")) return "git_unavailable";
  if (message.includes("not found") && message.includes("git")) return "git_unavailable";
  if (message.includes("authentication") || message.includes("permission denied"))
    return "git_auth_failed";
  if (message.includes("schema") || message.includes("parse")) return "registry_protocol_invalid";
  return "registry_sync_failed";
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
