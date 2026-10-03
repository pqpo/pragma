import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  ExpertAgentPluginManifestSchema,
  encodePragmaPathSegment,
  PragmaPaths,
  createExpertAgentPluginPackageFingerprint,
  resolveExpertAgentPluginConfig,
  setExpertAgentPluginConfigPath,
  type ExpertAgentPluginManifest,
} from "@pragma/core";
import { z } from "zod";
import type { PluginCredentialStore } from "./plugin-credential-store.ts";
export const PluginConfigStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    ref: z.string().min(1),
    config: z.record(z.string(), z.unknown()),
    secretBindings: z.record(z.string(), z.string().min(1)),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type PluginConfigState = z.infer<typeof PluginConfigStateSchema>;

export interface InstalledPluginMetadata {
  readonly schemaVersion: 1;
  readonly contentHash: string;
  readonly createdAt: string;
}

export interface LocatedPlugin {
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

export async function scanPluginRoot(
  root: string,
  origin: "built_in" | "user",
): Promise<LocatedPlugin[]> {
  const manifests = await findFiles(root, "plugin.json", origin === "built_in" ? 3 : 4);
  return await Promise.all(
    manifests.map(async (manifestPath) => await readLocatedPlugin(manifestPath, origin)),
  );
}
async function readLocatedPlugin(
  manifestPath: string,
  origin: "built_in" | "user",
): Promise<LocatedPlugin> {
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
}

export async function findFiles(root: string, name: string, depth: number): Promise<string[]> {
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

export async function readInstallMetadata(
  root: string,
): Promise<InstalledPluginMetadata | undefined> {
  try {
    return JSON.parse(
      await readFile(join(root, ".pragma-install.json"), "utf8"),
    ) as InstalledPluginMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function resolveConfiguration(
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

export function assertConfigHasNoPlaintextSecrets(
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

export function assertSecretProperty(manifest: ExpertAgentPluginManifest, path: string): void {
  if (!collectSecretConfigPaths(manifest.configuration).includes(path)) {
    throw new PluginStoreError(
      "config_invalid",
      `Plugin config is not a secret property: ${path}.`,
    );
  }
}

export function collectSecretConfigPaths(
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

export function readConfigPath(config: Readonly<Record<string, unknown>>, path: string): unknown {
  let cursor: unknown = config;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

export function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function pluginRef(id: string, version: string): string {
  return `plugin:${id}@${version}`;
}

export function createVerificationFingerprint(
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

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function secretBindingFingerprint(bindings: Readonly<Record<string, string>>): string {
  return createHash("sha256").update(stableStringify(bindings)).digest("hex");
}
export interface LocalHostPluginResolveInput {
  readonly ref: string;
  readonly config?: Readonly<Record<string, unknown>> | undefined;
  readonly secretBindings?: Readonly<Record<string, string>> | undefined;
}
export function createLocalHostPluginResolver(options: {
  readonly builtInPluginsPath: string;
  readonly userPluginsPath: string;
  readonly paths: PragmaPaths;
  readonly credentials: PluginCredentialStore;
}) {
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
    const match = /^plugin:([A-Za-z0-9][A-Za-z0-9._-]*)@([A-Za-z0-9][A-Za-z0-9.+_-]*)$/.exec(ref);
    if (match === null)
      throw new PluginStoreError("plugin_not_found", `Plugin is not installed: ${ref}.`);
    const id = match[1]!;
    const version = match[2]!;
    const roots = [
      { root: options.builtInPluginsPath, origin: "built_in" as const },
      { root: options.userPluginsPath, origin: "user" as const },
    ];
    const found: { readonly path: string; readonly origin: "built_in" | "user" }[] = [];
    for (const { root, origin } of roots) {
      const canonical = join(
        root,
        origin === "user" ? encodePragmaPathSegment(id) : id,
        origin === "user" ? encodePragmaPathSegment(version) : version,
        "plugin.json",
      );
      if (
        await stat(canonical)
          .then((info) => info.isFile())
          .catch(() => false)
      ) {
        found.push({ path: canonical, origin });
        // Built-ins retain priority. User installations must also reject a
        // duplicate ref in a historical layout, including canonical+legacy.
        if (origin === "built_in") continue;
      }
      // Historical installations may use another bounded layout. Discover only
      // manifest identity; never fingerprint or open an unrelated package entry.
      for (const path of await findFiles(root, "plugin.json", origin === "built_in" ? 3 : 4)) {
        if (path === canonical) continue;
        const manifest = await readFile(path, "utf8")
          .then((source) => {
            const parsed = ExpertAgentPluginManifestSchema.safeParse(JSON.parse(source) as unknown);
            return parsed.success ? parsed.data : undefined;
          })
          .catch(() => undefined);
        if (manifest !== undefined && pluginRef(manifest.id, manifest.version) === ref)
          found.push({ path, origin });
      }
    }
    const builtIn = found.find((candidate) => candidate.origin === "built_in");
    const users = found.filter((candidate) => candidate.origin === "user");
    if (builtIn === undefined && users.length > 1)
      throw new PluginStoreError("version_conflict", `Duplicate installed plugin: ${ref}.`);
    const selected = builtIn ?? users[0];
    if (selected === undefined)
      throw new PluginStoreError("plugin_not_found", `Plugin is not installed: ${ref}.`);
    const plugin = await readLocatedPlugin(selected.path, selected.origin);
    if (plugin.ref !== ref)
      throw new PluginStoreError(
        "config_invalid",
        `Installed plugin identity does not match its path: ${ref}.`,
      );
    return plugin;
  };
  const inspect = async (input: LocalHostPluginResolveInput) => {
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
        bindingFingerprint: secretBindingFingerprint(secretBindings),
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
  };
  const resolve = async (input: LocalHostPluginResolveInput) => {
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
      bindingFingerprint: secretBindingFingerprint(secretBindings),
      cachePolicy:
        plugin.origin === "built_in" ? ("host-managed" as const) : ("immutable" as const),
      userConfig: config,
      verificationFingerprint: createVerificationFingerprint(
        input.ref,
        plugin.contentHash,
        state?.config ?? {},
        input.config ?? {},
        credentialFingerprint,
      ),
    };
  };
  return { readState, locateAll, locate, inspect, resolve };
}
