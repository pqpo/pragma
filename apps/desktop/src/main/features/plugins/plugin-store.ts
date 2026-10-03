export { PluginStoreError } from "@pragma/local-host/resources";
import {
  createLocalHostPluginResolver,
  resolveConfiguration,
  assertSecretProperty,
  PluginStoreError,
  assertConfigHasNoPlaintextSecrets,
  type LocatedPlugin,
  pluginRef,
  type InstalledPluginMetadata,
  type PluginConfigState,
} from "@pragma/local-host/resources";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  ExpertAgentPluginManifestSchema,
  PragmaPaths,
  encodePragmaPathSegment,
  withFileLock,
  type ExpertAgentPluginManifest,
} from "@pragma/core";
import { unzipSync } from "fflate";
import {
  DesktopPluginSchema,
  DesktopPluginManifestSchema,
  PluginZipInspectionSchema,
  type DesktopPlugin,
  type ImportPluginZip,
  type PluginZipInspection,
  type UpdatePluginDefaults,
} from "../../../shared/contracts/index.ts";
import type { PluginCredentialStore } from "./plugin-credential-store.ts";
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
const MAX_FILES = 2000;
export interface ResolvedDesktopPlugin {
  readonly ref: `plugin:${string}@${string}`;
  readonly source: string;
  readonly packageFingerprint: string;
  readonly cachePolicy: "immutable" | "host-managed";
  readonly userConfig: Readonly<Record<string, unknown>>;
  readonly verificationFingerprint: string;
}
export interface PluginStore {
  list(): Promise<DesktopPlugin[]>;
  get(ref: string): Promise<DesktopPlugin>;
  exportPackage(ref: string): Promise<{
    readonly root: string;
    readonly contentHash: string;
    readonly origin: "built_in" | "user";
  }>;
  assertPortableConfig(ref: string, config: Readonly<Record<string, unknown>>): Promise<void>;
  hasSecret(binding: string): Promise<boolean>;
  inspectZip(sourcePath: string): Promise<PluginZipInspection>;
  importZip(input: ImportPluginZip): Promise<DesktopPlugin>;
  updateDefaults(input: UpdatePluginDefaults): Promise<DesktopPlugin>;
  setSecrets(secrets: Readonly<Record<string, string | null>>): Promise<void>;
  remove(ref: string): Promise<void>;
  inspect(input: {
    readonly ref: string;
    readonly config?: Readonly<Record<string, unknown>> | undefined;
    readonly secretBindings?: Readonly<Record<string, string>> | undefined;
  }): Promise<{
    readonly ref: `plugin:${string}@${string}`;
    readonly status: "ready" | "needs_attention";
    readonly packageFingerprint?: string | undefined;
    readonly verificationFingerprint?: string | undefined;
    readonly issues: readonly {
      readonly severity: "error";
      readonly code: string;
      readonly message: string;
      readonly path: (string | number)[];
    }[];
  }>;
  resolve(input: {
    readonly ref: string;
    readonly config?: Readonly<Record<string, unknown>> | undefined;
    readonly secretBindings?: Readonly<Record<string, string>> | undefined;
  }): Promise<ResolvedDesktopPlugin>;
}
export function createPluginStore(options: {
  readonly builtInPluginsPath: string;
  readonly userPluginsPath: string;
  readonly paths: PragmaPaths;
  readonly credentials: PluginCredentialStore;
  readonly isReferenced: (ref: string) => Promise<boolean>;
}): PluginStore {
  const { readState, locateAll, locate, inspect, resolve } = createLocalHostPluginResolver(options);
  const writeState = async (value: PluginConfigState): Promise<void> => {
    const statePath = options.paths.pluginConfigState(value.ref);
    await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${statePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, statePath);
  };
  const project = async (plugin: LocatedPlugin): Promise<DesktopPlugin> => {
    const state = await readState(plugin.ref);
    return DesktopPluginSchema.parse({
      ref: plugin.ref,
      origin: plugin.origin,
      manifest: DesktopPluginManifestSchema.parse(plugin.manifest),
      contentHash: plugin.contentHash,
      status: plugin.status,
      ...(plugin.diagnostic === undefined ? {} : { diagnostic: plugin.diagnostic }),
      defaultConfig: state?.config ?? {},
      configuredSecrets: Object.keys(state?.secretBindings ?? {}).toSorted(),
      createdAt: plugin.createdAt,
      updatedAt: state?.updatedAt ?? plugin.createdAt,
    });
  };
  return {
    async list() {
      return await Promise.all((await locateAll()).map(project));
    },
    async get(ref) {
      return await project(await locate(ref));
    },
    async exportPackage(ref) {
      const plugin = await locate(ref);
      return {
        root: plugin.root,
        contentHash: plugin.contentHash,
        origin: plugin.origin,
      };
    },
    async assertPortableConfig(ref, config) {
      assertConfigHasNoPlaintextSecrets((await locate(ref)).manifest, config);
    },
    async hasSecret(binding) {
      return await options.credentials.has(binding);
    },
    inspectZip: inspectPluginZip,
    async importZip(input) {
      const inspection = await inspectPluginZip(input.sourcePath);
      if (inspection.contentHash !== input.expectedHash) {
        throw new PluginStoreError(
          "import_invalid",
          "The plugin ZIP changed after it was inspected. Inspect it again before importing.",
        );
      }
      const ref = pluginRef(inspection.manifest.id, inspection.manifest.version);
      const archive = await readFile(input.sourcePath);
      const files = normalizedZipFiles(archive);
      return await withFileLock(options.paths.pluginMutationLock(ref), async () => {
        const existing = (await locateAll()).find((candidate) => candidate.ref === ref);
        if (existing !== undefined) {
          if (existing.contentHash === inspection.contentHash) return await project(existing);
          throw new PluginStoreError(
            "version_conflict",
            `Plugin ${ref} is immutable and is already installed with different contents.`,
          );
        }
        const target = join(
          options.userPluginsPath,
          encodePragmaPathSegment(inspection.manifest.id),
          encodePragmaPathSegment(inspection.manifest.version),
        );
        const temporary = `${target}.${randomUUID()}.tmp`;
        await mkdir(temporary, { recursive: true, mode: 0o700 });
        try {
          for (const [path, contents] of files) {
            const destination = join(temporary, path);
            await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
            await writeFile(destination, contents, { mode: 0o600 });
          }
          const metadata: InstalledPluginMetadata = {
            schemaVersion: 1,
            contentHash: inspection.contentHash,
            createdAt: new Date().toISOString(),
          };
          await writeFile(
            join(temporary, ".pragma-install.json"),
            `${JSON.stringify(metadata, null, 2)}\n`,
            { mode: 0o600 },
          );
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await rename(temporary, target);
        } catch (error) {
          await rm(temporary, { recursive: true, force: true });
          throw error;
        }
        return await project(await locate(ref));
      });
    },
    async updateDefaults(input) {
      return await withFileLock(options.paths.pluginMutationLock(input.ref), async () => {
        const plugin = await locate(input.ref);
        assertConfigHasNoPlaintextSecrets(plugin.manifest, input.config);
        const previous = (await readState(input.ref)) ?? {
          schemaVersion: 1 as const,
          ref: input.ref,
          config: {},
          secretBindings: {},
          updatedAt: plugin.createdAt,
        };
        const secretBindings = { ...previous.secretBindings };
        for (const [path, value] of Object.entries(input.secrets)) {
          assertSecretProperty(plugin.manifest, path);
          const binding = secretBindings[path] ?? defaultSecretBinding(input.ref, path);
          if (value === null) {
            delete secretBindings[path];
          } else {
            secretBindings[path] = binding;
          }
        }
        await resolveConfiguration(
          plugin.manifest,
          [input.config],
          secretBindings,
          options.credentials,
          input.secrets,
        );
        const secretsToSet: Record<string, string> = {};
        const bindingsToRemove: string[] = [];
        for (const [path, value] of Object.entries(input.secrets)) {
          const previousBinding = previous.secretBindings[path];
          if (value === null) {
            if (previousBinding !== undefined) bindingsToRemove.push(previousBinding);
          } else {
            secretsToSet[secretBindings[path]!] = value;
          }
        }
        await options.credentials.applyChanges({ set: secretsToSet });
        await writeState({
          schemaVersion: 1,
          ref: input.ref,
          config: input.config,
          secretBindings,
          updatedAt: new Date().toISOString(),
        });
        await options.credentials.applyChanges({ remove: bindingsToRemove });
        return await project(plugin);
      });
    },
    async setSecrets(secrets) {
      const valuesToSet: Record<string, string> = {};
      const bindingsToRemove: string[] = [];
      for (const [binding, value] of Object.entries(secrets)) {
        if (!/^binding:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(binding)) {
          throw new PluginStoreError(
            "config_invalid",
            `Invalid plugin secret binding: ${binding}.`,
          );
        }
        if (value === null) bindingsToRemove.push(binding);
        else valuesToSet[binding] = value;
      }
      await options.credentials.applyChanges({ set: valuesToSet, remove: bindingsToRemove });
    },
    async remove(ref) {
      await withFileLock(options.paths.pluginMutationLock(ref), async () => {
        const plugin = await locate(ref);
        if (plugin.origin === "built_in") {
          throw new PluginStoreError("built_in_readonly", "Built-in plugins cannot be deleted.");
        }
        if (await options.isReferenced(ref)) {
          throw new PluginStoreError(
            "plugin_referenced",
            "Deactivate this plugin in every expert first.",
          );
        }
        const state = await readState(ref);
        const bindings = Object.values(state?.secretBindings ?? {});
        await rm(plugin.root, { recursive: true, force: true });
        await rm(options.paths.pluginConfigState(ref), { force: true });
        await options.credentials.applyChanges({ remove: bindings });
      });
    },
    inspect,
    resolve,
  };
}
async function inspectPluginZip(sourcePath: string): Promise<PluginZipInspection> {
  if (extname(sourcePath).toLowerCase() !== ".zip") {
    throw new PluginStoreError("import_invalid", "Only ZIP plugin packages are supported.");
  }
  const info = await stat(sourcePath).catch(() => undefined);
  if (info?.isFile() !== true || info.size > MAX_ARCHIVE_BYTES) {
    throw new PluginStoreError("import_invalid", "The plugin ZIP is missing or exceeds 50 MiB.");
  }
  const archive = await readFile(sourcePath);
  const files = normalizedZipFiles(archive);
  const unpackedBytes = [...files.values()].reduce(
    (total, contents) => total + contents.byteLength,
    0,
  );
  const manifestBytes = files.get("plugin.json");
  const packageBytes = files.get("package.json");
  if (manifestBytes === undefined || packageBytes === undefined) {
    throw new PluginStoreError(
      "import_invalid",
      "The ZIP must contain plugin.json and package.json at one package root.",
    );
  }
  let manifest: ExpertAgentPluginManifest;
  let packageJson: Record<string, unknown>;
  try {
    manifest = ExpertAgentPluginManifestSchema.parse(
      JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as unknown,
    );
    packageJson = JSON.parse(Buffer.from(packageBytes).toString("utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new PluginStoreError(
      "import_invalid",
      error instanceof Error ? error.message : "The plugin manifest is invalid.",
    );
  }
  if (packageJson["type"] !== "module" || packageJson["version"] !== manifest.version) {
    throw new PluginStoreError(
      "import_invalid",
      "package.json must be ESM and its version must match plugin.json.",
    );
  }
  for (const field of ["dependencies", "optionalDependencies"] as const) {
    const dependencies = packageJson[field];
    if (
      dependencies !== undefined &&
      dependencies !== null &&
      typeof dependencies === "object" &&
      Object.keys(dependencies).length > 0
    ) {
      throw new PluginStoreError(
        "import_invalid",
        `Prebuilt plugins cannot declare ${field}; bundle runtime dependencies into the entry.`,
      );
    }
  }
  const entry = normalizeArchivePath(manifest.runtime.entry);
  const entryBytes = files.get(entry);
  if (entryBytes === undefined) {
    throw new PluginStoreError("import_invalid", `Plugin entry does not exist: ${entry}.`);
  }
  assertSelfContainedEsm(Buffer.from(entryBytes).toString("utf8"));
  return PluginZipInspectionSchema.parse({
    sourcePath,
    contentHash: createHash("sha256").update(archive).digest("hex"),
    manifest: DesktopPluginManifestSchema.parse(manifest),
    fileCount: files.size,
    unpackedBytes,
  });
}
function normalizedZipFiles(archive: Uint8Array): Map<string, Uint8Array> {
  assertZipEntryTypes(archive);
  let unpacked: Record<string, Uint8Array>;
  try {
    unpacked = unzipSync(archive);
  } catch {
    throw new PluginStoreError(
      "import_invalid",
      "The selected file is not a readable ZIP archive.",
    );
  }
  const entries = Object.entries(unpacked).filter(([path]) => !path.endsWith("/"));
  if (entries.length === 0 || entries.length > MAX_FILES) {
    throw new PluginStoreError("import_invalid", `Plugin ZIP must contain 1-${MAX_FILES} files.`);
  }
  const roots = entries.map(([path]) => path.replaceAll("\\", "/").split("/")[0]!);
  const hasDirectManifest = entries.some(([path]) => path.replaceAll("\\", "/") === "plugin.json");
  const commonRoot = hasDirectManifest || new Set(roots).size !== 1 ? undefined : roots[0];
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const [rawPath, contents] of entries) {
    const source = rawPath.replaceAll("\\", "/");
    const path = normalizeArchivePath(
      commonRoot === undefined ? source : source.slice(commonRoot.length + 1),
    );
    if (path === "" || path.split("/").includes("node_modules")) {
      throw new PluginStoreError("import_invalid", `Invalid plugin package path: ${rawPath}.`);
    }
    const collisionKey = path.toLowerCase();
    if ([...files.keys()].some((existing) => existing.toLowerCase() === collisionKey)) {
      throw new PluginStoreError("import_invalid", `Duplicate plugin package path: ${path}.`);
    }
    total += contents.byteLength;
    if (total > MAX_UNPACKED_BYTES) {
      throw new PluginStoreError("import_invalid", "The unpacked plugin exceeds 200 MiB.");
    }
    files.set(path, contents);
  }
  return files;
}
function assertZipEntryTypes(archive: Uint8Array): void {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const minimumEndOffset = Math.max(0, archive.byteLength - 65557);
  let endOffset = -1;
  for (let offset = archive.byteLength - 22; offset >= minimumEndOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) return;
  const entryCount = view.getUint16(endOffset + 10, true);
  if (entryCount === 0 || entryCount > MAX_FILES) {
    throw new PluginStoreError("import_invalid", `Plugin ZIP must contain 1-${MAX_FILES} files.`);
  }
  let offset = view.getUint32(endOffset + 16, true);
  let unpackedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new PluginStoreError("import_invalid", "The ZIP central directory is invalid.");
    }
    const originOs = view.getUint8(offset + 5);
    const externalAttributes = view.getUint32(offset + 38, true);
    unpackedBytes += view.getUint32(offset + 24, true);
    if (unpackedBytes > MAX_UNPACKED_BYTES) {
      throw new PluginStoreError("import_invalid", "The unpacked plugin exceeds 200 MiB.");
    }
    const unixType = (externalAttributes >>> 16) & 0o170000;
    if (
      (originOs === 3 || originOs === 19) &&
      unixType !== 0 &&
      unixType !== 0o100000 &&
      unixType !== 0o040000
    ) {
      throw new PluginStoreError(
        "import_invalid",
        "Plugin ZIP symbolic links and special files are not supported.",
      );
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    offset += 46 + nameLength + extraLength + commentLength;
  }
}
function normalizeArchivePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const target = resolve("/plugin", normalized);
  if (
    normalized === "" ||
    normalized.includes("\0") ||
    isAbsolute(normalized) ||
    relative("/plugin", target).startsWith("..")
  ) {
    throw new PluginStoreError("import_invalid", `Plugin path escapes the package: ${path}.`);
  }
  return relative("/plugin", target).replaceAll("\\", "/");
}
function assertSelfContainedEsm(source: string): void {
  const imports = [
    ...source.matchAll(/\b(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]!);
  const requires = [...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)].map(
    (match) => match[1]!,
  );
  const unsupported = [...imports, ...requires].find((specifier) => !specifier.startsWith("node:"));
  if (
    unsupported !== undefined ||
    /\bimport\s*\((?!\s*["'])/.test(source) ||
    /\brequire\s*\((?!\s*["'])/.test(source)
  ) {
    throw new PluginStoreError(
      "import_invalid",
      `Plugin entry must be self-contained ESM; unsupported import: ${unsupported ?? "dynamic expression"}.`,
    );
  }
}
function defaultSecretBinding(ref: string, path: string): string {
  return `binding:plugin-secret-${createHash("sha256").update(`${ref}:${path}`).digest("hex").slice(0, 24)}`;
}
