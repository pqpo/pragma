import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import {
  ExpertAgentPluginManifestSchema,
  PragmaPaths,
  createExpertAgentPluginPackageFingerprint,
  encodePragmaPathSegment,
  resolveExpertAgentPluginConfig,
  setExpertAgentPluginConfigPath,
  withFileLock,
  type ExpertAgentPluginManifest,
} from "@pragma/core";
import { unzipSync } from "fflate";
import { z } from "zod";

import {
  DesktopPluginSchema,
  DesktopPluginManifestSchema,
  PluginZipInspectionSchema,
  type DesktopPlugin,
  type ImportPluginZip,
  type PluginZipInspection,
  type UpdatePluginDefaults,
} from "../shared/desktop-api.ts";
import type { PluginCredentialStore } from "./plugin-credential-store.ts";

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
const MAX_FILES = 2_000;

const PluginConfigStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    ref: z.string().min(1),
    config: z.record(z.string(), z.unknown()),
    secretBindings: z.record(z.string(), z.string().min(1)),
    updatedAt: z.string().datetime(),
  })
  .strict();

type PluginConfigState = z.infer<typeof PluginConfigStateSchema>;

interface InstalledPluginMetadata {
  readonly schemaVersion: 1;
  readonly contentHash: string;
  readonly createdAt: string;
}

interface LocatedPlugin {
  readonly ref: string;
  readonly origin: "built_in" | "user";
  readonly root: string;
  readonly manifest: ExpertAgentPluginManifest;
  readonly contentHash: string;
  readonly packageFingerprint: string;
  readonly createdAt: string;
  readonly status: "ready" | "needs_attention";
  readonly diagnostic?: string | undefined;
}

export interface ResolvedDesktopPlugin {
  readonly ref: `plugin:${string}@${string}`;
  readonly source: string;
  readonly packageFingerprint: string;
  readonly userConfig: Readonly<Record<string, unknown>>;
  readonly verificationFingerprint: string;
}

export interface PluginStore {
  list(): Promise<DesktopPlugin[]>;
  get(ref: string): Promise<DesktopPlugin>;
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

export class PluginStoreError extends Error {
  constructor(
    readonly code:
      | "plugin_not_found"
      | "import_invalid"
      | "version_conflict"
      | "plugin_referenced"
      | "built_in_readonly"
      | "config_invalid",
    message: string,
  ) {
    super(message);
    this.name = "PluginStoreError";
  }
}

export function createPluginStore(options: {
  readonly builtInPluginsPath: string;
  readonly userPluginsPath: string;
  readonly paths: PragmaPaths;
  readonly credentials: PluginCredentialStore;
  readonly isReferenced: (ref: string) => Promise<boolean>;
}): PluginStore {
  const readState = async (ref: string): Promise<PluginConfigState | undefined> => {
    try {
      const value = PluginConfigStateSchema.parse(
        JSON.parse(await readFile(options.paths.pluginConfigState(ref), "utf8")) as unknown,
      );
      if (value.ref !== ref) {
        throw new PluginStoreError(
          "config_invalid",
          `Plugin config state ref does not match its path: ${ref}.`,
        );
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  };
  const writeState = async (value: PluginConfigState): Promise<void> => {
    const statePath = options.paths.pluginConfigState(value.ref);
    await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${statePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, statePath);
  };
  const locateAll = async (): Promise<LocatedPlugin[]> => {
    const [builtIns, users] = await Promise.all([
      scanPluginRoot(options.builtInPluginsPath, "built_in"),
      scanPluginRoot(options.userPluginsPath, "user"),
    ]);
    const byRef = new Map<string, LocatedPlugin>();
    for (const plugin of [...builtIns, ...users]) {
      const existing = byRef.get(plugin.ref);
      if (existing !== undefined) {
        if (existing.origin === "built_in") continue;
        throw new PluginStoreError(
          "version_conflict",
          `Duplicate installed plugin: ${plugin.ref}.`,
        );
      }
      byRef.set(plugin.ref, plugin);
    }
    return [...byRef.values()].toSorted((left, right) => left.ref.localeCompare(right.ref));
  };
  const locate = async (ref: string): Promise<LocatedPlugin> => {
    const plugin = (await locateAll()).find((candidate) => candidate.ref === ref);
    if (plugin === undefined) {
      throw new PluginStoreError("plugin_not_found", `Plugin is not installed: ${ref}.`);
    }
    return plugin;
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
    async inspect(input) {
      try {
        const plugin = await locate(input.ref);
        if (plugin.status !== "ready") {
          return {
            ref: plugin.ref as `plugin:${string}@${string}`,
            status: "needs_attention" as const,
            packageFingerprint: plugin.packageFingerprint,
            issues: [
              {
                severity: "error" as const,
                code: "environment.plugin_unavailable",
                message: plugin.diagnostic ?? `Plugin is not ready: ${input.ref}.`,
                path: [],
              },
            ],
          };
        }
        const state = await readState(input.ref);
        const secretBindings = {
          ...(state?.secretBindings ?? {}),
          ...(input.secretBindings ?? {}),
        };
        const placeholderSecrets: Record<string, unknown> = {};
        for (const [path, binding] of Object.entries(secretBindings)) {
          assertSecretProperty(plugin.manifest, path);
          if (await options.credentials.has(binding)) {
            setExpertAgentPluginConfigPath(placeholderSecrets, path, "configured-secret");
          }
        }
        resolveExpertAgentPluginConfig(plugin.manifest, [
          state?.config ?? {},
          input.config ?? {},
          placeholderSecrets,
        ]);
        const credentialFingerprint = await options.credentials.fingerprint(
          Object.values(secretBindings),
        );
        return {
          ref: plugin.ref as `plugin:${string}@${string}`,
          status: "ready" as const,
          packageFingerprint: plugin.packageFingerprint,
          verificationFingerprint: createVerificationFingerprint(
            input.ref,
            plugin.contentHash,
            state?.config ?? {},
            input.config ?? {},
            credentialFingerprint,
          ),
          issues: [],
        };
      } catch (error) {
        return {
          ref: input.ref as `plugin:${string}@${string}`,
          status: "needs_attention" as const,
          issues: [
            {
              severity: "error" as const,
              code: "environment.plugin_unavailable",
              message: error instanceof Error ? error.message : String(error),
              path: [],
            },
          ],
        };
      }
    },
    async resolve(input) {
      const plugin = await locate(input.ref);
      if (plugin.status !== "ready") {
        throw new PluginStoreError(
          "config_invalid",
          plugin.diagnostic ?? `Plugin is not ready: ${input.ref}.`,
        );
      }
      assertConfigHasNoPlaintextSecrets(plugin.manifest, input.config ?? {});
      const state = await readState(input.ref);
      const secretBindings = {
        ...(state?.secretBindings ?? {}),
        ...(input.secretBindings ?? {}),
      };
      const config = await resolveConfiguration(
        plugin.manifest,
        [state?.config ?? {}, input.config ?? {}],
        secretBindings,
        options.credentials,
      );
      const credentialFingerprint = await options.credentials.fingerprint(
        Object.values(secretBindings),
      );
      return {
        ref: plugin.ref as `plugin:${string}@${string}`,
        source: plugin.root,
        packageFingerprint: plugin.packageFingerprint,
        userConfig: config,
        verificationFingerprint: createVerificationFingerprint(
          input.ref,
          plugin.contentHash,
          state?.config ?? {},
          input.config ?? {},
          credentialFingerprint,
        ),
      };
    },
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
  const minimumEndOffset = Math.max(0, archive.byteLength - 65_557);
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

async function scanPluginRoot(root: string, origin: "built_in" | "user"): Promise<LocatedPlugin[]> {
  const manifests = await findFiles(root, "plugin.json", origin === "built_in" ? 3 : 4);
  return await Promise.all(
    manifests.map(async (manifestPath) => {
      const pluginRoot = dirname(manifestPath);
      try {
        const manifest = ExpertAgentPluginManifestSchema.parse(
          JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
        );
        const metadata = await readInstallMetadata(pluginRoot);
        const packageFingerprint = await createExpertAgentPluginPackageFingerprint(pluginRoot);
        const contentHash = metadata?.contentHash ?? packageFingerprint;
        const entryInfo = await stat(resolve(pluginRoot, manifest.runtime.entry)).catch(
          () => undefined,
        );
        return {
          ref: pluginRef(manifest.id, manifest.version),
          origin,
          root: pluginRoot,
          manifest,
          contentHash,
          packageFingerprint,
          createdAt: metadata?.createdAt ?? new Date(0).toISOString(),
          status: entryInfo?.isFile() === true ? "ready" : "needs_attention",
          ...(entryInfo?.isFile() === true
            ? {}
            : { diagnostic: `Plugin entry is missing: ${manifest.runtime.entry}.` }),
        } satisfies LocatedPlugin;
      } catch (error) {
        throw new PluginStoreError(
          "config_invalid",
          `Invalid installed plugin at ${pluginRoot}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );
}

async function findFiles(root: string, name: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const matches = entries
    .filter((entry) => entry.isFile() && entry.name === name)
    .map((entry) => join(root, entry.name));
  const nested = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith(".") && !entry.name.endsWith(".tmp"),
      )
      .map((entry) => findFiles(join(root, entry.name), name, depth - 1)),
  );
  return [...matches, ...nested.flat()];
}

async function readInstallMetadata(root: string): Promise<InstalledPluginMetadata | undefined> {
  try {
    return JSON.parse(
      await readFile(join(root, ".pragma-install.json"), "utf8"),
    ) as InstalledPluginMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function resolveConfiguration(
  manifest: ExpertAgentPluginManifest,
  layers: readonly Readonly<Record<string, unknown>>[],
  secretBindings: Readonly<Record<string, string>>,
  credentials: PluginCredentialStore,
  pendingSecrets: Readonly<Record<string, string | null>> = {},
): Promise<Record<string, unknown>> {
  const secretConfig: Record<string, unknown> = {};
  for (const [path, binding] of Object.entries(secretBindings)) {
    assertSecretProperty(manifest, path);
    const value = Object.hasOwn(pendingSecrets, path)
      ? (pendingSecrets[path] ?? undefined)
      : await credentials.get(binding);
    if (value !== undefined) setExpertAgentPluginConfigPath(secretConfig, path, value);
  }
  return resolveExpertAgentPluginConfig(manifest, [...layers, secretConfig]);
}

function assertConfigHasNoPlaintextSecrets(
  manifest: ExpertAgentPluginManifest,
  config: Readonly<Record<string, unknown>>,
): void {
  for (const path of collectSecretConfigPaths(manifest.configuration)) {
    if (readConfigPath(config, path) !== undefined) {
      throw new PluginStoreError(
        "config_invalid",
        `Secret plugin config must use a binding: ${path}.`,
      );
    }
  }
}

function assertSecretProperty(manifest: ExpertAgentPluginManifest, path: string): void {
  if (!collectSecretConfigPaths(manifest.configuration).includes(path)) {
    throw new PluginStoreError(
      "config_invalid",
      `Plugin config is not a secret property: ${path}.`,
    );
  }
}

function collectSecretConfigPaths(
  schema: Readonly<Record<string, unknown>>,
  prefix = "",
): string[] {
  const properties = isPlainRecord(schema["properties"]) ? schema["properties"] : {};
  const paths: string[] = [];
  for (const [name, value] of Object.entries(properties)) {
    if (!isPlainRecord(value)) continue;
    const path = prefix.length === 0 ? name : `${prefix}.${name}`;
    if (value["x-pragma-secret"] === true) paths.push(path);
    if (value["type"] === "object") paths.push(...collectSecretConfigPaths(value, path));
  }
  return paths;
}

function readConfigPath(config: Readonly<Record<string, unknown>>, path: string): unknown {
  let cursor: unknown = config;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pluginRef(id: string, version: string): string {
  return `plugin:${id}@${version}`;
}

function defaultSecretBinding(ref: string, path: string): string {
  return `binding:plugin-secret-${createHash("sha256").update(`${ref}:${path}`).digest("hex").slice(0, 24)}`;
}

function createVerificationFingerprint(
  ref: string,
  packageContentHash: string,
  defaults: Readonly<Record<string, unknown>>,
  expert: Readonly<Record<string, unknown>>,
  credentials: string,
): string {
  return createHash("sha256")
    .update(stableStringify({ ref, package: packageContentHash, defaults, expert, credentials }))
    .digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
