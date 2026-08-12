import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { Validator, type Schema } from "@cfworker/json-schema";
import {
  defineExpert,
  defineExpertTeam,
  defineFlow,
  mergeExpertAgentToolApprovals,
  sanitizeExecutionToolName,
  type Expert,
  type ExpertAgentManagedTool,
  type ExpertAgentToolCallResult,
  type ExpertDefinition,
  type Flow,
  type FlowState,
  type FlowStepReference,
  type FlowTerminal,
  type IExpertAgentMcpConfig,
  type IExpertAgentSkillsConfig,
} from "@pragma/core";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";

import {
  PragmaBundleSchema,
  PragmaDiagnosticSchema,
  PragmaLockSchema,
  PragmaResourceSchema,
  type PragmaArtifactSource,
  type PragmaDiagnostic,
  type PragmaDeclarativeResource,
  type PragmaEnvironmentFingerprint,
  type PragmaExpertResource,
  type PragmaFlowDestination,
  type PragmaFlowResource,
  type PragmaFlowTarget,
  type PragmaFlowTransition,
  type PragmaInvocableResource,
  type PragmaLock,
  type PragmaResource,
  type PragmaResourceRef,
  type PragmaResourceHealth,
  type PragmaSemanticResourceRef,
} from "../ast/pragma-dsl.schema.ts";
import { validatePragmaFlowDataContracts } from "../ast/flow-data-contracts.ts";
import { analyzePragmaFlowGraph } from "../ast/flow-graph.ts";
import {
  canonicalPragmaResourceRef,
  normalizePragmaResourceName,
  parsePragmaReference,
  pragmaResourceDirectory,
  pragmaResourceFileName,
} from "../ast/resource-identity.ts";
import {
  ContextPolicyRegistry,
  DefinitionSerializerRegistry,
  FlowActionRegistry,
  ToolAdapterRegistry,
  type InvocableResource,
  type PragmaCompileHost,
  type PragmaPluginResolution,
} from "../runtime/registries.ts";
import {
  createContextSystem,
  createDefaultPragmaResourceAdapterRegistry,
  PragmaResourceNeedsAttentionError,
  type PragmaCapabilityContribution,
  type PragmaContextStoreContribution,
  type PragmaResourceContribution,
  type PragmaResourceAdapterRegistry,
  type PragmaResourceInspection,
  type PragmaRuntimeProfileContribution,
} from "../runtime/resource-adapters.ts";
import { evaluatePragmaFlowValue, renderPragmaFlowPrompt } from "../runtime/flow-values.ts";
import { sha256, stableStringify } from "./compiler-hash.ts";
import {
  PRAGMA_COMPILER_DIRECT_READ_VERSIONS,
  PRAGMA_COMPILER_UPGRADE_FROM_VERSIONS,
  PRAGMA_COMPILER_WRITE_VERSION,
  isPragmaCompilerVersionDirectlyReadable,
  isPragmaCompilerVersionUpgradeable,
} from "../ast/compiler-compatibility.ts";
import type { PragmaBundleManifest, PragmaBundleRequirement } from "../ast/pragma-bundle.schema.ts";
import {
  encodePragmaBundle,
  decodePragmaBundle,
  PragmaBundleFormatError,
  type DecodedPragmaBundle,
  type PragmaBundleBinarySource,
  type PragmaBundleLimits,
} from "../bundle/pragma-bundle-codec.ts";
import {
  applyPragmaEnvironmentBindingOverlay,
  mergePragmaBindingContributions,
  type PragmaBundleBindingHost,
  type PragmaBundleRequirementInspection,
  type PragmaEnvironmentBindingOverlay,
} from "../bundle/pragma-bundle-environment.ts";

const provenance = new WeakMap<object, PragmaProvenance>();
const PRAGMA_BUNDLE_BINDING_PREFIX = "binding:pragma.bundle." as const;
const PRAGMA_BUNDLE_RESERVED_PROJECT_PATHS = new Set([
  "project/pragma.yaml",
  "project/pragma.lock.yaml",
]);

export interface LoadPragmaProjectOptions {
  readonly rootDir?: string | undefined;
  readonly requireLock?: boolean | undefined;
  readonly serializers?: DefinitionSerializerRegistry | undefined;
  readonly resourceAdapters?: PragmaResourceAdapterRegistry | undefined;
  readonly externalResourceRefs?: ReadonlySet<PragmaResourceRef> | undefined;
  readonly revisionCompilerVersion?: string | undefined;
  readonly sourceIdentity?: string | undefined;
  readonly blueprintCache?: PragmaBlueprintCacheStore | undefined;
  readonly onBlueprintCacheLookup?:
    ((observation: PragmaBlueprintCacheObservation) => void) | undefined;
  /** Host extension id@version values understood by this process. */
  readonly supportedBundleExtensions?: ReadonlySet<string> | undefined;
}

export type LoadPragmaProjectSource =
  | string
  | {
      readonly kind: "yaml";
      readonly entryFile: string;
      readonly rootDir?: string | undefined;
    }
  | {
      readonly kind: "bundle";
      readonly source: PragmaBundleBinarySource;
      readonly limits?: PragmaBundleLimits | undefined;
    }
  | {
      readonly kind: "decoded-bundle";
      readonly bundle: DecodedPragmaBundle;
    };

export interface PragmaBlueprintCacheStore {
  readonly read: (key: string) => Promise<Uint8Array | undefined>;
  readonly write: (key: string, value: Uint8Array) => Promise<void>;
  readonly remove?: ((key: string) => Promise<void>) | undefined;
}

export interface PragmaBlueprintCacheObservation {
  readonly key: string;
  readonly tier: "memory" | "host" | "miss";
  readonly hit: boolean;
  readonly durationMs: number;
}

export type PragmaCompileOptions = PragmaCompileHost;

export interface CompiledResource<T> {
  readonly ref: PragmaSemanticResourceRef;
  readonly value: T;
  readonly fingerprint: string;
  readonly projectFingerprint: string;
  readonly environmentFingerprint: PragmaEnvironmentFingerprint;
  readonly rootRuntimeId?: string | undefined;
  readonly dependencies: readonly LockedResourceRef[];
}

export interface LockedResourceRef {
  readonly ref: PragmaSemanticResourceRef;
  readonly contentHash: string;
  readonly source: string;
}

export interface DumpOptions {
  readonly split?: "single" | "preserve" | "by-resource" | undefined;
}

export interface DumpedFiles {
  readonly files: ReadonlyMap<string, string>;
}

export interface PragmaBundleExportPayload {
  readonly codec: string;
  /** Paths are relative to the requirement payload root. */
  readonly files: ReadonlyMap<string, Uint8Array>;
}

export interface PragmaBundleExportHost {
  readonly exportPayload?: (input: {
    readonly requirement: PragmaBundleRequirement;
    readonly originalBindingRef?: string | undefined;
  }) => Promise<PragmaBundleExportPayload | undefined>;
}

export interface PragmaBundleExportExtensionInput {
  readonly id: string;
  readonly version: string;
  readonly required?: boolean | undefined;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

export interface PragmaProjectBundleExportOptions {
  readonly roots: readonly (PragmaResourceRef | object)[];
  readonly additionalRoots?: readonly (PragmaResourceRef | object)[] | undefined;
  readonly host?: PragmaBundleExportHost | undefined;
  readonly extensions?: readonly PragmaBundleExportExtensionInput[] | undefined;
  readonly createdAt?: string | undefined;
}

export interface PragmaBundleExportResult {
  readonly bytes: Uint8Array;
  readonly manifest: PragmaBundleManifest;
}

export interface ExportPragmaBundleOptions extends PragmaProjectBundleExportOptions {
  readonly serializers?: DefinitionSerializerRegistry | undefined;
  readonly resourceAdapters?: PragmaResourceAdapterRegistry | undefined;
  readonly projectRoot?: string | undefined;
  readonly include?: readonly object[] | undefined;
}

export interface PragmaLoadedBundle {
  readonly manifest: PragmaBundleManifest;
  readonly archiveBytes: number;
}

export interface PragmaProject extends AsyncDisposable {
  readonly entryFile: string;
  readonly bundle?: PragmaLoadedBundle | undefined;
  listResources(): readonly PragmaResource[];
  listResourceClosure(ref: PragmaResourceRef): readonly PragmaResource[];
  validate(): Promise<readonly PragmaDiagnostic[]>;
  validateFor(ref: PragmaResourceRef): Promise<readonly PragmaDiagnostic[]>;
  validateEnvironment(host: PragmaCompileOptions): Promise<readonly PragmaDiagnostic[]>;
  inspectEnvironment(host: PragmaCompileOptions): Promise<PragmaEnvironmentInspection>;
  inspectEnvironmentFor(
    ref: PragmaResourceRef,
    host: PragmaCompileOptions,
  ): Promise<PragmaEnvironmentInspection>;
  inspectBundleBindings(
    ref: PragmaResourceRef,
    host: PragmaBundleBindingHost,
  ): Promise<readonly PragmaBundleRequirementInspection[]>;
  bindEnvironment(
    ref: PragmaResourceRef,
    host: PragmaBundleBindingHost,
    selections?: Readonly<Record<string, string>>,
  ): Promise<PragmaBundleBindingResult>;
  prepareCompile<T extends InvocableResource>(
    ref: PragmaResourceRef,
    host: PragmaCompileOptions,
    overlay?: PragmaEnvironmentBindingOverlay,
  ): Promise<PragmaPrepareCompileResult<T>>;
  compile<T extends InvocableResource>(
    ref: PragmaResourceRef,
    host: PragmaCompileOptions,
  ): Promise<CompiledResource<T>>;
  dump(resource: object, options?: DumpOptions): Promise<DumpedFiles>;
  exportBundle(options: PragmaProjectBundleExportOptions): Promise<PragmaBundleExportResult>;
  createLock(): PragmaLock;
  readLock(): Promise<PragmaLock>;
  dispose(): Promise<void>;
}

export interface PragmaEnvironmentInspection {
  readonly diagnostics: readonly PragmaDiagnostic[];
  readonly resources: readonly PragmaResourceHealth[];
}

export interface PragmaBundleBindingResult {
  readonly overlay: PragmaEnvironmentBindingOverlay;
  readonly requirements: readonly PragmaBundleRequirementInspection[];
}

export type PragmaPrepareCompileResult<T> =
  | { readonly status: "ready"; readonly compiled: CompiledResource<T> }
  | {
      readonly status: "needs_binding";
      readonly requirements: readonly PragmaBundleRequirement[];
      readonly diagnostics: readonly PragmaDiagnostic[];
      readonly resources: readonly PragmaResourceHealth[];
    }
  | { readonly status: "invalid"; readonly diagnostics: readonly PragmaDiagnostic[] };

export class PragmaDslError extends Error {
  constructor(
    message: string,
    readonly diagnostics: readonly PragmaDiagnostic[] = [],
  ) {
    super(message);
    this.name = "PragmaDslError";
  }
}

interface IndexedResource {
  readonly resource: PragmaResource;
  readonly source: string;
  readonly normalized: string;
  readonly contentHash: string;
}

interface PragmaProvenance {
  readonly project: PragmaProjectImpl;
  readonly root: IndexedResource;
}

const PRAGMA_PROJECT_BLUEPRINT_SCHEMA_VERSION = "pragma.project-blueprint/v2";

const PragmaProjectBlueprintSchema = z
  .object({
    schemaVersion: z.literal(PRAGMA_PROJECT_BLUEPRINT_SCHEMA_VERSION),
    compilerVersion: z.literal(PRAGMA_COMPILER_WRITE_VERSION),
    sourceIdentity: z.string().min(1),
    entry: z.string().min(1),
    resources: z.array(
      z
        .object({
          resource: PragmaResourceSchema,
          source: z.string().min(1),
          normalized: z.string(),
          contentHash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
    artifacts: z.array(
      z
        .object({
          source: z.string().min(1),
          contentHash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
    diagnostics: z.array(PragmaDiagnosticSchema),
  })
  .strict();

type PragmaProjectBlueprint = z.infer<typeof PragmaProjectBlueprintSchema>;
const projectBlueprintMemoryCache = new Map<string, PragmaProjectBlueprint>();
const projectBlueprintLoads = new Map<string, Promise<PragmaProjectBlueprint | undefined>>();
const projectBlueprintBuilds = new Map<string, Promise<PragmaProjectBlueprint>>();
const PROJECT_BLUEPRINT_MEMORY_LIMIT = 128;

async function readCompilerCompatibilityDiagnostic(
  entryFile: string,
  options: LoadPragmaProjectOptions,
): Promise<PragmaDiagnostic | undefined> {
  if (options.requireLock !== true) return undefined;
  const versionDiagnostic = (
    version: string,
    source: "revision metadata" | "pragma.lock.yaml",
    path?: string,
  ): PragmaDiagnostic | undefined => {
    if (isPragmaCompilerVersionDirectlyReadable(version)) return undefined;
    const upgradeable = isPragmaCompilerVersionUpgradeable(version);
    return PragmaDiagnosticSchema.parse({
      severity: "error",
      code: upgradeable ? "compiler.version_upgrade_required" : "compiler.version_unsupported",
      message:
        `Project ${source} requires compiler ${version}; ` +
        (upgradeable
          ? `upgrade it to ${PRAGMA_COMPILER_WRITE_VERSION} before loading.`
          : `this Interpreter directly reads ${PRAGMA_COMPILER_DIRECT_READ_VERSIONS.join(", ")}` +
            ((PRAGMA_COMPILER_UPGRADE_FROM_VERSIONS as readonly string[]).length === 0
              ? "."
              : ` and upgrades ${PRAGMA_COMPILER_UPGRADE_FROM_VERSIONS.join(", ")}.`)),
      ...(path === undefined ? {} : { source: path }),
      path: ["compilerVersion"],
    });
  };
  const lockPath = resolve(dirname(entryFile), "pragma.lock.yaml");
  let lock: PragmaLock;
  try {
    lock = PragmaLockSchema.parse(parsePragmaYaml(await readFile(lockPath, "utf8")));
  } catch {
    return options.revisionCompilerVersion === undefined
      ? undefined
      : versionDiagnostic(options.revisionCompilerVersion, "revision metadata");
  }
  if (
    options.revisionCompilerVersion !== undefined &&
    options.revisionCompilerVersion !== lock.compilerVersion
  ) {
    return PragmaDiagnosticSchema.parse({
      severity: "error",
      code: "compiler.version_metadata_mismatch",
      message:
        `Project revision metadata declares compiler ${options.revisionCompilerVersion}, ` +
        `but pragma.lock.yaml declares ${lock.compilerVersion}.`,
      source: lockPath,
      path: ["compilerVersion"],
    });
  }
  return versionDiagnostic(lock.compilerVersion, "pragma.lock.yaml", lockPath);
}

export async function loadPragmaProject(
  source: LoadPragmaProjectSource,
  options: LoadPragmaProjectOptions = {},
): Promise<PragmaProject> {
  if (
    typeof source !== "string" &&
    (source.kind === "bundle" || source.kind === "decoded-bundle")
  ) {
    const decoded =
      source.kind === "bundle"
        ? await decodePragmaBundle(source.source, source.limits)
        : source.bundle;
    for (const extension of decoded.manifest.extensions) {
      const key = `${extension.id}@${extension.version}`;
      if (extension.required && options.supportedBundleExtensions?.has(key) !== true) {
        throw new PragmaBundleFormatError(
          "manifest.invalid",
          `Required bundle extension is not supported: ${key}.`,
        );
      }
    }
    const temporaryRoot = await mkdtemp(join(tmpdir(), "pragma-bundle-"));
    try {
      for (const [path, contents] of decoded.files) {
        if (!path.startsWith("project/")) continue;
        const destination = resolve(temporaryRoot, path);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, contents, { mode: 0o600 });
      }
      const entryFile = resolve(temporaryRoot, decoded.manifest.project.entry);
      const project = await loadPragmaYamlProject(entryFile, {
        ...options,
        rootDir: resolve(temporaryRoot, "project"),
        requireLock: true,
        sourceIdentity: decoded.manifest.project.projectFingerprint,
      });
      const actualFingerprint = project.createLock().projectFingerprint;
      if (actualFingerprint !== decoded.manifest.project.projectFingerprint) {
        throw new PragmaBundleFormatError(
          "manifest.fingerprint_invalid",
          "The bundle project fingerprint does not match its portable project.",
        );
      }
      const availableRefs = new Set(
        project.listResources().map((resource) => canonicalRef(resource)),
      );
      const missingRoot = decoded.manifest.roots.find((ref) => !availableRefs.has(ref));
      if (missingRoot !== undefined) {
        throw new PragmaBundleFormatError(
          "manifest.invalid",
          `Bundle root is not present in the portable project: ${missingRoot}.`,
        );
      }
      await project.assertBundleManifest(decoded.manifest);
      project.attachBundle(
        { manifest: decoded.manifest, archiveBytes: decoded.archiveBytes },
        decoded.files,
        async () => await rm(temporaryRoot, { recursive: true, force: true }),
      );
      return project;
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
  const entryFile = typeof source === "string" ? source : source.entryFile;
  return await loadPragmaYamlProject(entryFile, {
    ...options,
    ...(typeof source === "string" || source.rootDir === undefined
      ? {}
      : { rootDir: source.rootDir }),
  });
}

async function loadPragmaYamlProject(
  entryFile: string,
  options: LoadPragmaProjectOptions,
): Promise<PragmaProjectImpl> {
  const absoluteEntry = resolve(entryFile);
  const configuredRoot = resolve(options.rootDir ?? dirname(absoluteEntry));
  const rootDir = await realpath(configuredRoot);
  const canonicalEntry = await realpath(absoluteEntry);
  const compatibilityDiagnostic = await readCompilerCompatibilityDiagnostic(
    canonicalEntry,
    options,
  );
  if (compatibilityDiagnostic !== undefined) {
    return new PragmaProjectImpl(
      canonicalEntry,
      rootDir,
      new Map(),
      new Map(),
      [compatibilityDiagnostic],
      { ...options, requireLock: false },
    );
  }
  const adapters = options.resourceAdapters ?? createDefaultPragmaResourceAdapterRegistry();
  const sourceIdentity = options.sourceIdentity;
  const blueprintKey =
    sourceIdentity === undefined
      ? undefined
      : sha256(
          stableStringify({
            blueprintSchemaVersion: PRAGMA_PROJECT_BLUEPRINT_SCHEMA_VERSION,
            compilerVersion: PRAGMA_COMPILER_WRITE_VERSION,
            sourceIdentity,
            entry: relative(rootDir, canonicalEntry),
            resourceAdapters: adapters.fingerprint(),
          }),
        );
  if (blueprintKey !== undefined && sourceIdentity !== undefined) {
    const cacheStartedAt = performance.now();
    const cached = await loadProjectBlueprint(blueprintKey, options.blueprintCache);
    notifyBlueprintCacheLookup(options, {
      key: blueprintKey,
      tier: cached.tier,
      hit: cached.blueprint !== undefined,
      durationMs: elapsedMilliseconds(cacheStartedAt),
    });
    if (
      cached.blueprint !== undefined &&
      cached.blueprint.sourceIdentity === sourceIdentity &&
      cached.blueprint.entry === relative(rootDir, canonicalEntry)
    ) {
      return projectFromBlueprint(cached.blueprint, rootDir, canonicalEntry, options);
    }
    const blueprint = await buildProjectBlueprint(
      blueprintKey,
      sourceIdentity,
      rootDir,
      canonicalEntry,
      adapters,
      options.blueprintCache,
    );
    return projectFromBlueprint(blueprint, rootDir, canonicalEntry, options);
  }
  const loader = new SourceLoader(rootDir, adapters);
  await loader.loadEntry(canonicalEntry);
  await loader.collectArtifacts();
  return new PragmaProjectImpl(
    canonicalEntry,
    rootDir,
    loader.resources,
    loader.artifacts,
    loader.diagnostics,
    options,
  );
}

async function buildProjectBlueprint(
  key: string,
  sourceIdentity: string,
  rootDir: string,
  entryFile: string,
  adapters: PragmaResourceAdapterRegistry,
  store: PragmaBlueprintCacheStore | undefined,
): Promise<PragmaProjectBlueprint> {
  const pending = projectBlueprintBuilds.get(key);
  if (pending !== undefined) return await pending;
  const building = (async () => {
    const loader = new SourceLoader(rootDir, adapters);
    await loader.loadEntry(entryFile);
    await loader.collectArtifacts();
    const blueprint = createProjectBlueprint(sourceIdentity, rootDir, entryFile, loader);
    rememberProjectBlueprint(key, blueprint);
    if (store !== undefined) {
      void store
        .write(key, new TextEncoder().encode(JSON.stringify(blueprint)))
        .catch(() => undefined);
    }
    return blueprint;
  })();
  projectBlueprintBuilds.set(key, building);
  try {
    return await building;
  } finally {
    if (projectBlueprintBuilds.get(key) === building) projectBlueprintBuilds.delete(key);
  }
}

async function loadProjectBlueprint(
  key: string,
  store: PragmaBlueprintCacheStore | undefined,
): Promise<{
  readonly blueprint: PragmaProjectBlueprint | undefined;
  readonly tier: PragmaBlueprintCacheObservation["tier"];
}> {
  const memory = projectBlueprintMemoryCache.get(key);
  if (memory !== undefined) {
    projectBlueprintMemoryCache.delete(key);
    projectBlueprintMemoryCache.set(key, memory);
    return { blueprint: memory, tier: "memory" };
  }
  if (store === undefined) return { blueprint: undefined, tier: "miss" };
  const pending = projectBlueprintLoads.get(key);
  if (pending !== undefined) {
    return { blueprint: await pending, tier: "host" };
  }
  const loading = (async () => {
    try {
      const encoded = await store.read(key);
      if (encoded === undefined) return undefined;
      const parsed = PragmaProjectBlueprintSchema.safeParse(
        JSON.parse(new TextDecoder().decode(encoded)) as unknown,
      );
      if (!parsed.success) {
        await store.remove?.(key).catch(() => undefined);
        return undefined;
      }
      rememberProjectBlueprint(key, parsed.data);
      return parsed.data;
    } catch {
      return undefined;
    }
  })();
  projectBlueprintLoads.set(key, loading);
  try {
    const blueprint = await loading;
    return { blueprint, tier: blueprint === undefined ? "miss" : "host" };
  } finally {
    if (projectBlueprintLoads.get(key) === loading) projectBlueprintLoads.delete(key);
  }
}

function notifyBlueprintCacheLookup(
  options: LoadPragmaProjectOptions,
  observation: PragmaBlueprintCacheObservation,
): void {
  try {
    options.onBlueprintCacheLookup?.(observation);
  } catch {
    // Cache telemetry must never affect project loading.
  }
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function rememberProjectBlueprint(key: string, blueprint: PragmaProjectBlueprint): void {
  projectBlueprintMemoryCache.delete(key);
  projectBlueprintMemoryCache.set(key, blueprint);
  while (projectBlueprintMemoryCache.size > PROJECT_BLUEPRINT_MEMORY_LIMIT) {
    const oldest = projectBlueprintMemoryCache.keys().next().value as string | undefined;
    if (oldest === undefined || oldest === key) break;
    projectBlueprintMemoryCache.delete(oldest);
  }
}

function createProjectBlueprint(
  sourceIdentity: string,
  rootDir: string,
  entryFile: string,
  loader: SourceLoader,
): PragmaProjectBlueprint {
  const relativeSource = (source: string): string => {
    const value = relative(rootDir, source);
    if (value === "" || value.startsWith("..") || isAbsolute(value)) {
      throw new Error(`Blueprint source escapes the project root: ${source}`);
    }
    return value;
  };
  return PragmaProjectBlueprintSchema.parse({
    schemaVersion: PRAGMA_PROJECT_BLUEPRINT_SCHEMA_VERSION,
    compilerVersion: PRAGMA_COMPILER_WRITE_VERSION,
    sourceIdentity,
    entry: relativeSource(entryFile),
    resources: [...loader.resources.values()].map((indexed) => ({
      resource: indexed.resource,
      source: relativeSource(indexed.source),
      normalized: indexed.normalized,
      contentHash: indexed.contentHash,
    })),
    artifacts: [...loader.artifacts].map(([source, contentHash]) => ({ source, contentHash })),
    diagnostics: loader.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      ...(diagnostic.source === undefined ? {} : { source: relativeSource(diagnostic.source) }),
    })),
  });
}

function projectFromBlueprint(
  blueprint: PragmaProjectBlueprint,
  rootDir: string,
  entryFile: string,
  options: LoadPragmaProjectOptions,
): PragmaProjectImpl {
  const resolveSource = (source: string): string => {
    const value = resolve(rootDir, source);
    const child = relative(rootDir, value);
    if (child.startsWith("..") || isAbsolute(child)) {
      throw new Error(`Blueprint source escapes the project root: ${source}`);
    }
    return value;
  };
  return new PragmaProjectImpl(
    entryFile,
    rootDir,
    new Map(
      blueprint.resources.map((indexed) => [
        canonicalRef(indexed.resource),
        {
          resource: indexed.resource,
          source: resolveSource(indexed.source),
          normalized: indexed.normalized,
          contentHash: indexed.contentHash,
        },
      ]),
    ),
    new Map(blueprint.artifacts.map((artifact) => [artifact.source, artifact.contentHash])),
    blueprint.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      ...(diagnostic.source === undefined ? {} : { source: resolveSource(diagnostic.source) }),
    })),
    options,
  );
}

export async function dumpPragmaResource(
  resource: object,
  options: DumpOptions = {},
): Promise<DumpedFiles> {
  const source = provenance.get(resource);
  if (source === undefined) {
    throw new PragmaDslError(
      "Cannot dump a resource without DSL provenance. Register a serializer for programmatic definitions.",
    );
  }
  return await source.project.dump(resource, options);
}

export async function exportPragmaBundle(
  options: ExportPragmaBundleOptions,
): Promise<PragmaBundleExportResult> {
  if (options.roots.length === 0) throw new PragmaDslError("A bundle requires at least one root.");
  const provenances = options.roots
    .filter((root): root is object => typeof root === "object")
    .map((root) => provenance.get(root));
  const project = provenances[0]?.project;
  if (
    project !== undefined &&
    provenances.every((entry) => entry?.project === project) &&
    (options.include ?? []).every((entry) => provenance.get(entry)?.project === project) &&
    (options.additionalRoots ?? []).every(
      (entry) => typeof entry === "string" || provenance.get(entry)?.project === project,
    )
  ) {
    return await project.exportBundle({
      ...options,
      additionalRoots: [...(options.additionalRoots ?? []), ...(options.include ?? [])],
    });
  }

  const serializers = options.serializers;
  if (serializers === undefined) {
    throw new PragmaDslError(
      "Programmatic definitions require a versioned DefinitionSerializerRegistry.",
    );
  }
  const values = [
    ...options.roots.filter((root): root is object => typeof root === "object"),
    ...(options.additionalRoots ?? []).filter((root): root is object => typeof root === "object"),
    ...(options.include ?? []),
  ];
  const serializedByValue = new Map<object, PragmaResource>();
  for (const value of values) {
    if (serializedByValue.has(value)) continue;
    const resource = serializers.serialize(value);
    if (resource === undefined) {
      throw new PragmaDslError("No versioned serializer can describe a programmatic definition.");
    }
    serializedByValue.set(value, resource);
  }
  const serialized = [...serializedByValue.values()];
  const resources = new Map<string, IndexedResource>();
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  for (const resource of serialized) {
    const normalized = stableStringify(resource);
    const ref = canonicalRef(resource);
    if (resources.has(ref)) throw new PragmaDslError(`Duplicate serialized resource: ${ref}`);
    resources.set(ref, {
      resource,
      normalized,
      contentHash: sha256(normalized),
      source: resolve(projectRoot, "pragma.yaml"),
    });
  }
  const adapters = options.resourceAdapters ?? createDefaultPragmaResourceAdapterRegistry();
  const artifacts = await collectResourceArtifacts(resources, projectRoot, adapters);
  const memoryProject = new PragmaProjectImpl(
    resolve(projectRoot, "pragma.yaml"),
    projectRoot,
    resources,
    artifacts,
    [],
    { serializers, resourceAdapters: adapters },
  );
  const rootRefs = options.roots.map((root) => {
    if (typeof root === "string") return root;
    const resource = serializedByValue.get(root);
    if (resource === undefined) throw new PragmaDslError("No serializer found for bundle root.");
    return canonicalRef(resource);
  });
  const explicitAdditionalRoots = (options.additionalRoots ?? []).map((root) => {
    if (typeof root === "string") return root;
    const resource = serializedByValue.get(root);
    if (resource === undefined)
      throw new PragmaDslError("No serializer found for additional bundle root.");
    return canonicalRef(resource);
  });
  const includedRoots = (options.include ?? []).map((value) => {
    const resource = serializedByValue.get(value);
    if (resource === undefined)
      throw new PragmaDslError("No serializer found for included resource.");
    return canonicalRef(resource);
  });
  return await memoryProject.exportBundle({
    ...options,
    roots: rootRefs,
    additionalRoots: [...explicitAdditionalRoots, ...includedRoots],
  });
}

export function formatPragmaYaml(value: unknown): string {
  return stringify(value, { lineWidth: 100 });
}

export function parsePragmaYaml(source: string): unknown {
  const document = parseDocument(source, { prettyErrors: true });
  if (document.errors.length > 0) {
    throw new PragmaDslError(document.errors.map((error) => error.message).join("\n"));
  }
  return document.toJS({ maxAliasCount: 50 });
}

class SourceLoader {
  readonly resources = new Map<string, IndexedResource>();
  readonly artifacts = new Map<string, string>();
  readonly diagnostics: PragmaDiagnostic[] = [];
  private readonly loaded = new Set<string>();

  constructor(
    private readonly rootDir: string,
    private readonly adapters: PragmaResourceAdapterRegistry,
  ) {}

  async loadEntry(path: string): Promise<void> {
    await this.loadFile(path, true);
  }

  async collectArtifacts(): Promise<void> {
    for (const indexed of this.resources.values()) {
      if (!isDeclarativeResource(indexed.resource)) continue;
      let sources: readonly PragmaArtifactSource[];
      try {
        sources = this.adapters.artifactSources(indexed.resource);
      } catch {
        // Adapter config diagnostics are emitted by PragmaResourceAdapterRegistry.validate().
        continue;
      }
      for (const source of sources) {
        if (source.type === "project") {
          try {
            const path = await this.assertProjectPath(resolve(this.rootDir, source.path));
            this.artifacts.set(source.path, await hashArtifactPath(path));
          } catch (error) {
            this.error(
              "artifact.unavailable",
              error instanceof Error ? error.message : String(error),
              indexed.source,
            );
          }
        } else {
          this.artifacts.set(source.uri, source.integrity.slice("sha256:".length));
        }
      }
    }
  }

  private async loadFile(path: string, allowBundle: boolean): Promise<void> {
    let canonical: string;
    try {
      canonical = await this.assertProjectPath(path);
    } catch (error) {
      this.error("source.path", error instanceof Error ? error.message : String(error), path);
      return;
    }
    if (this.loaded.has(canonical)) return;
    this.loaded.add(canonical);

    let raw: unknown;
    try {
      raw = await this.parseYaml(canonical);
      raw = await this.expandIncludes(raw, dirname(canonical), new Set([canonical]));
    } catch (error) {
      this.error("source.parse", error instanceof Error ? error.message : String(error), canonical);
      return;
    }

    const bundle = PragmaBundleSchema.safeParse(raw);
    if (bundle.success) {
      if (!allowBundle) {
        this.error("source.bundle", "A Bundle cannot be used as a structural include.", canonical);
        return;
      }
      for (const imported of bundle.data.imports) {
        await this.loadFile(resolve(dirname(canonical), imported), true);
      }
      for (const resource of bundle.data.resources) this.addResource(resource, canonical);
      return;
    }

    const parsed = PragmaResourceSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        this.diagnostics.push(
          PragmaDiagnosticSchema.parse({
            severity: "error",
            code: "schema.invalid",
            message: issue.message,
            source: canonical,
            path: issue.path,
          }),
        );
      }
      return;
    }
    this.addResource(parsed.data, canonical);
  }

  private addResource(resource: PragmaResource, source: string): void {
    const key = canonicalRef(resource);
    if (this.resources.has(key)) {
      this.error("resource.duplicate", `Duplicate Pragma resource: ${key}`, source);
      return;
    }
    const sameId = [...this.resources.values()].find(
      (indexed) => indexed.resource.metadata.id === resource.metadata.id,
    );
    if (sameId !== undefined) {
      this.error(
        "resource.id_duplicate",
        `Resource ID ${resource.metadata.id} is already used by ${canonicalRef(sameId.resource)}.`,
        source,
      );
      return;
    }
    const normalizedName = normalizePragmaResourceName(resource.metadata.name);
    const sameName = [...this.resources.values()].find(
      (indexed) =>
        indexed.resource.kind === resource.kind &&
        normalizePragmaResourceName(indexed.resource.metadata.name) === normalizedName,
    );
    if (sameName !== undefined) {
      this.error(
        "resource.name_duplicate",
        `${resource.kind} name "${resource.metadata.name}" is already used by ${canonicalRef(sameName.resource)}.`,
        source,
      );
      return;
    }
    const normalized = stableStringify(resource);
    this.resources.set(key, {
      resource,
      source,
      normalized,
      contentHash: sha256(normalized),
    });
  }

  private async parseYaml(path: string): Promise<unknown> {
    const source = await readFile(path, "utf8");
    const document = parseDocument(source, { prettyErrors: true });
    if (document.errors.length > 0) {
      throw new Error(document.errors.map((error) => error.message).join("\n"));
    }
    return document.toJS({ maxAliasCount: 50 });
  }

  private async expandIncludes(
    value: unknown,
    baseDir: string,
    stack: Set<string>,
  ): Promise<unknown> {
    if (Array.isArray(value)) {
      return await Promise.all(value.map((entry) => this.expandIncludes(entry, baseDir, stack)));
    }
    if (typeof value !== "object" || value === null) return value;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length === 1 && typeof record["$include"] === "string") {
      const includedPath = await this.assertProjectPath(resolve(baseDir, record["$include"]));
      if (stack.has(includedPath)) throw new Error(`Cyclic $include: ${includedPath}`);
      const nextStack = new Set(stack).add(includedPath);
      const included = await this.parseYaml(includedPath);
      return await this.expandIncludes(included, dirname(includedPath), nextStack);
    }
    return Object.fromEntries(
      await Promise.all(
        Object.entries(record).map(async ([key, entry]) => [
          key,
          await this.expandIncludes(entry, baseDir, stack),
        ]),
      ),
    );
  }

  private async assertProjectPath(path: string): Promise<string> {
    const canonical = await realpath(path);
    const child = relative(this.rootDir, canonical);
    if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) return canonical;
    throw new Error(`Pragma source escapes the project root: ${path}`);
  }

  private error(code: string, message: string, source?: string): void {
    this.diagnostics.push(
      PragmaDiagnosticSchema.parse({ severity: "error", code, message, source, path: [] }),
    );
  }
}

class PragmaProjectImpl implements PragmaProject {
  private validation: Promise<readonly PragmaDiagnostic[]> | undefined;
  private lockValidation: Promise<PragmaDiagnostic[]> | undefined;
  private readonly targetedValidations = new Map<
    PragmaSemanticResourceRef,
    Promise<readonly PragmaDiagnostic[]>
  >();
  bundle: PragmaLoadedBundle | undefined;
  private cleanup: (() => Promise<void>) | undefined;
  private bundleFiles: ReadonlyMap<string, Uint8Array> | undefined;
  private disposed = false;

  constructor(
    readonly entryFile: string,
    readonly rootDir: string,
    private readonly resources: ReadonlyMap<string, IndexedResource>,
    private readonly artifacts: ReadonlyMap<string, string>,
    private readonly sourceDiagnostics: readonly PragmaDiagnostic[],
    private readonly options: LoadPragmaProjectOptions,
  ) {}

  attachBundle(
    bundle: PragmaLoadedBundle,
    files: ReadonlyMap<string, Uint8Array>,
    cleanup: () => Promise<void>,
  ): void {
    this.bundle = bundle;
    this.bundleFiles = files;
    this.cleanup = cleanup;
  }
  async assertBundleManifest(manifest: PragmaBundleManifest): Promise<void> {
    const lock = await this.readLock();
    if (manifest.project.compilerVersion !== lock.compilerVersion) {
      throw new PragmaBundleFormatError(
        "manifest.invalid",
        `Bundle compiler version ${manifest.project.compilerVersion} does not match its lock ${lock.compilerVersion}.`,
      );
    }
    const byRef = new Map(
      [...this.resources.values()].map((indexed) => [
        canonicalRef(indexed.resource),
        indexed.resource,
      ]),
    );
    const fail = (message: string): never => {
      throw new PragmaBundleFormatError("manifest.invalid", message);
    };
    const requirementsById = new Map(
      manifest.requirements.map((requirement) => [requirement.id, requirement]),
    );
    const requirementsByLocation = new Map<string, PragmaBundleRequirement[]>();
    for (const requirement of manifest.requirements) {
      const key = requirementLocationKey(requirement.kind, requirement.ownerRef, requirement.path);
      const matches = requirementsByLocation.get(key) ?? [];
      matches.push(requirement);
      requirementsByLocation.set(key, matches);
    }
    const requirementAt = (
      kind: PragmaBundleRequirement["kind"],
      ownerRef: string,
      path: readonly (string | number)[],
      contract?: string,
    ): PragmaBundleRequirement | undefined =>
      requirementsByLocation
        .get(requirementLocationKey(kind, ownerRef, path))
        ?.find((requirement) => contract === undefined || requirement.contract === contract);
    for (const requirement of manifest.requirements) {
      const resource = byRef.get(requirement.ownerRef);
      if (resource === undefined) {
        throw new PragmaBundleFormatError(
          "manifest.invalid",
          `Bundle requirement owner is missing: ${requirement.ownerRef}.`,
        );
      }
      const value = valueAtPath(resource, requirement.path);
      if (requirement.kind === "binding" || requirement.kind === "secret") {
        if (value !== bundleBindingSlot(requirement.id)) {
          fail(`Bundle binding slot does not match requirement ${requirement.id}.`);
        }
        if (
          requirement.kind === "binding" &&
          (!isDeclarativeResource(resource) ||
            requirement.contract !== resource.spec.adapter ||
            stableStringify(requirement.path) !== stableStringify(["spec", "binding"]))
        ) {
          fail(`Bundle binding contract is invalid: ${requirement.id}.`);
        }
        if (requirement.kind === "secret") {
          const pluginIndex = requirement.path[2];
          const secretName = requirement.path[4];
          const plugin =
            resource.kind === "Expert" &&
            requirement.path[0] === "spec" &&
            requirement.path[1] === "plugins" &&
            typeof pluginIndex === "number" &&
            requirement.path[3] === "secretBindings" &&
            typeof secretName === "string"
              ? resource.spec.plugins[pluginIndex]
              : undefined;
          if (
            plugin === undefined ||
            requirement.path.length !== 5 ||
            requirement.contract !== `${plugin.ref}:secret:${secretName}`
          ) {
            fail(`Bundle secret contract is invalid: ${requirement.id}.`);
          }
        }
      } else if (requirement.kind === "plugin") {
        if (
          typeof value !== "object" ||
          value === null ||
          (value as Record<string, unknown>)["ref"] !== requirement.contract
        ) {
          fail(`Bundle plugin contract does not match requirement ${requirement.id}.`);
        }
      } else if (requirement.kind === "runtime") {
        const runtimeId = requirement.hints["runtimeId"];
        if (
          resource.kind !== "RuntimeProfile" ||
          requirement.contract !== "pragma.runtime@v1" ||
          typeof value !== "string" ||
          value !== runtimeId
        ) {
          fail(`Bundle Runtime contract does not match requirement ${requirement.id}.`);
        }
      } else if (requirement.kind === "external-artifact") {
        if (!isDeclarativeResource(resource)) {
          throw new PragmaBundleFormatError(
            "manifest.invalid",
            `Bundle external artifact owner is invalid: ${requirement.id}.`,
          );
        }
        const adapters =
          this.options.resourceAdapters ?? createDefaultPragmaResourceAdapterRegistry();
        const source = adapters
          .artifactSources(resource)
          .find(
            (candidate) =>
              candidate.type !== "project" && candidate.integrity === requirement.contract,
          );
        if (
          source === undefined ||
          source.type === "project" ||
          requirement.hints["uri"] !== source.uri ||
          requirement.hints["integrity"] !== source.integrity
        ) {
          fail(`Bundle external artifact contract is invalid: ${requirement.id}.`);
        }
      }
    }
    for (const [ownerRef, resource] of byRef) {
      for (const slot of findBundleBindingSlots(resource)) {
        const requirement = requirementsById.get(slot.requirementId);
        if (
          requirement === undefined ||
          requirement.ownerRef !== ownerRef ||
          stableStringify(requirement.path) !== stableStringify(slot.path)
        ) {
          fail(`Portable binding slot has no matching requirement: ${slot.value}.`);
        }
      }
      if (resource.kind === "RuntimeProfile") {
        const runtimeId = (resource.spec.config as Record<string, unknown>)["runtimeId"];
        if (
          requirementAt("runtime", ownerRef, ["spec", "config", "runtimeId"])?.hints[
            "runtimeId"
          ] !== runtimeId
        ) {
          fail(`RuntimeProfile requirement is missing or inconsistent: ${ownerRef}.`);
        }
      }
      if (resource.kind === "Expert") {
        for (const [index, plugin] of resource.spec.plugins.entries()) {
          if (
            requirementAt("plugin", ownerRef, ["spec", "plugins", index], plugin.ref) === undefined
          ) {
            fail(`Plugin requirement is missing: ${ownerRef} ${plugin.ref}.`);
          }
        }
      }
      if (isDeclarativeResource(resource)) {
        const adapters =
          this.options.resourceAdapters ?? createDefaultPragmaResourceAdapterRegistry();
        for (const source of adapters.artifactSources(resource)) {
          if (source.type === "project") continue;
          if (
            requirementAt("external-artifact", ownerRef, ["spec", "config"], source.integrity) ===
            undefined
          ) {
            fail(`External artifact requirement is missing: ${ownerRef} ${source.uri}.`);
          }
        }
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.cleanup?.();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  listResources(): readonly PragmaResource[] {
    return [...this.resources.values()]
      .map((indexed) => indexed.resource)
      .sort((left, right) => canonicalRef(left).localeCompare(canonicalRef(right)));
  }

  listResourceClosure(ref: PragmaResourceRef): readonly PragmaResource[] {
    return [...this.collectDependencyClosure(this.resolveResource(ref)).values()]
      .map((indexed) => indexed.resource)
      .sort((left, right) => canonicalRef(left).localeCompare(canonicalRef(right)));
  }

  async validate(): Promise<readonly PragmaDiagnostic[]> {
    this.validation ??= this.validateResources(this.resources);
    return await this.validation;
  }

  async validateFor(ref: PragmaResourceRef): Promise<readonly PragmaDiagnostic[]> {
    const root = this.resolveResource(ref);
    const rootRef = canonicalRef(root.resource);
    let validation = this.targetedValidations.get(rootRef);
    if (validation === undefined) {
      validation = this.validateResources(this.collectDependencyClosure(root));
      this.targetedValidations.set(rootRef, validation);
    }
    return await validation;
  }

  private async validateResources(
    resources: ReadonlyMap<string, IndexedResource>,
  ): Promise<readonly PragmaDiagnostic[]> {
    const diagnostics = [...this.sourceDiagnostics];
    const adapters = this.options.resourceAdapters ?? createDefaultPragmaResourceAdapterRegistry();
    for (const indexed of resources.values()) {
      const resourceRef = canonicalRef(indexed.resource);
      diagnostics.push(...this.validateReferences(indexed));
      diagnostics.push(
        ...validatePortableSemantics(indexed, this.resources).map((diagnostic) => ({
          ...diagnostic,
          resourceRef,
        })),
      );
      if (indexed.resource.kind === "Flow") {
        diagnostics.push(
          ...validateFlowGraph(indexed, this.resources).map((diagnostic) => ({
            ...diagnostic,
            resourceRef,
          })),
        );
      }
      if (isDeclarativeResource(indexed.resource)) {
        diagnostics.push(
          ...adapters.validate(indexed.resource).map((diagnostic) => ({
            ...diagnostic,
            resourceRef,
            source: indexed.source,
          })),
        );
      }
    }
    diagnostics.push(...validateResourceCycles(resources));
    if (this.options.requireLock === true) diagnostics.push(...(await this.validateLock()));
    return diagnostics;
  }

  private collectDependencyClosure(root: IndexedResource): ReadonlyMap<string, IndexedResource> {
    const closure = new Map<string, IndexedResource>();
    const visit = (indexed: IndexedResource): void => {
      const ref = canonicalRef(indexed.resource);
      if (closure.has(ref)) return;
      closure.set(ref, indexed);
      for (const dependencyRef of resourceDependencies(indexed.resource)) {
        const parsed = parsePragmaReference(dependencyRef);
        const dependency = this.resources.get(`${parsed.kind}:${parsed.id}`);
        if (dependency !== undefined) visit(dependency);
      }
    };
    visit(root);
    return closure;
  }

  async validateEnvironment(host: PragmaCompileOptions): Promise<readonly PragmaDiagnostic[]> {
    return (await this.inspectEnvironment(host)).diagnostics;
  }

  async inspectEnvironment(host: PragmaCompileOptions): Promise<PragmaEnvironmentInspection> {
    return await this.inspectEnvironmentResources(this.resources, await this.validate(), host);
  }

  async inspectEnvironmentFor(
    ref: PragmaResourceRef,
    host: PragmaCompileOptions,
  ): Promise<PragmaEnvironmentInspection> {
    const root = this.resolveResource(ref);
    return await this.inspectEnvironmentResources(
      this.collectDependencyClosure(root),
      await this.validateFor(ref),
      host,
    );
  }

  private async inspectEnvironmentResources(
    resources: ReadonlyMap<string, IndexedResource>,
    portableDiagnostics: readonly PragmaDiagnostic[],
    host: PragmaCompileOptions,
  ): Promise<PragmaEnvironmentInspection> {
    host = this.withProjectRoot(host);
    const diagnostics = [...portableDiagnostics];
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      return { diagnostics, resources: [] };
    }
    const adapters =
      host.resourceAdapters ??
      this.options.resourceAdapters ??
      createDefaultPragmaResourceAdapterRegistry();
    const adapterHost = createAdapterHost(
      host,
      this.artifacts,
      this.options.sourceIdentity !== undefined,
    );
    diagnostics.push(...validateExtensionEnvironment(resources, host));
    if (host.plugins !== undefined) {
      for (const indexed of resources.values()) {
        if (indexed.resource.kind !== "Expert") continue;
        for (const [index, binding] of indexed.resource.spec.plugins.entries()) {
          try {
            const inspection = await host.plugins.inspect({
              expertRef: canonicalRef(indexed.resource) as `expert:${string}`,
              binding,
            });
            if (inspection.ref !== binding.ref || inspection.status !== "ready") {
              diagnostics.push(
                ...(inspection.issues.length > 0
                  ? inspection.issues.map((issue) => ({
                      ...issue,
                      source: issue.source ?? indexed.source,
                      path: ["spec", "plugins", index, ...issue.path],
                    }))
                  : [
                      {
                        severity: "error" as const,
                        code: "environment.plugin_unavailable",
                        message:
                          inspection.ref === binding.ref
                            ? `Plugin ${binding.ref} needs attention.`
                            : `Plugin resolver returned ${inspection.ref} for ${binding.ref}.`,
                        source: indexed.source,
                        path: ["spec", "plugins", index],
                      },
                    ]),
              );
            }
          } catch (error) {
            diagnostics.push({
              severity: "error",
              code: "environment.plugin_unavailable",
              message: error instanceof Error ? error.message : String(error),
              source: indexed.source,
              path: ["spec", "plugins", index],
            });
          }
        }
      }
    }
    const health: PragmaResourceHealth[] = [];
    for (const indexed of resources.values()) {
      if (!isDeclarativeResource(indexed.resource)) continue;
      const baseInspection = await adapters.inspect(indexed.resource, adapterHost);
      const inspection =
        indexed.resource.kind === "RuntimeProfile"
          ? await verifyRuntimeEnvironment(
              baseInspection as PragmaResourceInspection<PragmaRuntimeProfileContribution>,
              host.runtimes,
              true,
            )
          : baseInspection;
      const resourceHealth = inspection.health;
      health.push(resourceHealth);
      diagnostics.push(
        ...resourceHealth.issues.map((issue) => ({
          ...issue,
          source: issue.source ?? indexed.source,
        })),
      );
    }
    return { diagnostics, resources: health };
  }

  async inspectBundleBindings(
    ref: PragmaResourceRef,
    host: PragmaBundleBindingHost,
  ): Promise<readonly PragmaBundleRequirementInspection[]> {
    const requirements = this.bundleRequirementsFor(ref);
    return await Promise.all(
      requirements.map(async (requirement) => {
        const inspection = await host.inspect({
          requirement,
          payload: this.readRequirementPayload(requirement.id),
        });
        if (inspection.requirementId !== requirement.id) {
          throw new Error(
            `Bundle binding Host returned ${inspection.requirementId} for ${requirement.id}.`,
          );
        }
        return inspection;
      }),
    );
  }

  async bindEnvironment(
    ref: PragmaResourceRef,
    host: PragmaBundleBindingHost,
    selections: Readonly<Record<string, string>> = {},
  ): Promise<PragmaBundleBindingResult> {
    const requirements = this.bundleRequirementsFor(ref);
    const contributions = await Promise.all(
      requirements.map(
        async (requirement) =>
          await host.bind({
            requirement,
            candidateId: selections[requirement.id],
            payload: this.readRequirementPayload(requirement.id),
          }),
      ),
    );
    return {
      overlay: mergePragmaBindingContributions(contributions),
      requirements: await this.inspectBundleBindings(ref, host),
    };
  }

  async prepareCompile<T extends InvocableResource>(
    ref: PragmaResourceRef,
    host: PragmaCompileOptions,
    overlay?: PragmaEnvironmentBindingOverlay,
  ): Promise<PragmaPrepareCompileResult<T>> {
    const portable = await this.validateFor(ref);
    if (portable.some((diagnostic) => diagnostic.severity === "error")) {
      return { status: "invalid", diagnostics: portable };
    }
    const effectiveHost =
      overlay === undefined ? host : applyPragmaEnvironmentBindingOverlay(host, overlay);
    const environment = await this.inspectEnvironmentFor(ref, effectiveHost);
    const unavailable =
      environment.diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
      environment.resources.some((resource) => resource.status !== "ready");
    if (unavailable) {
      return {
        status: "needs_binding",
        requirements: this.bundleRequirementsFor(ref),
        diagnostics: environment.diagnostics,
        resources: environment.resources,
      };
    }
    try {
      return { status: "ready", compiled: await this.compile<T>(ref, effectiveHost) };
    } catch (error) {
      if (error instanceof PragmaResourceNeedsAttentionError) {
        return {
          status: "needs_binding",
          requirements: this.bundleRequirementsFor(ref),
          diagnostics: error.health.issues,
          resources: [error.health],
        };
      }
      if (error instanceof PragmaDslError) {
        return { status: "invalid", diagnostics: error.diagnostics };
      }
      throw error;
    }
  }

  private bundleRequirementsFor(ref: PragmaResourceRef): readonly PragmaBundleRequirement[] {
    if (this.bundle === undefined) return [];
    const closure = this.collectDependencyClosure(this.resolveResource(ref));
    const refs = new Set([...closure.values()].map((indexed) => canonicalRef(indexed.resource)));
    return this.bundle.manifest.requirements.filter((requirement) =>
      refs.has(requirement.ownerRef),
    );
  }

  private readRequirementPayload(requirementId: string): ReadonlyMap<string, Uint8Array> {
    const requirement = this.bundle?.manifest.requirements.find(
      (item) => item.id === requirementId,
    );
    if (requirement?.payload === undefined || this.bundleFiles === undefined) return new Map();
    const root = `${requirement.payload.root}/`;
    return new Map(
      [...this.bundleFiles]
        .filter(([path]) => path.startsWith(root))
        .map(([path, contents]) => [path.slice(root.length), contents] as const),
    );
  }

  private withProjectRoot(host: PragmaCompileHost): PragmaCompileHost {
    return {
      ...host,
      projectRoot: this.bundle === undefined ? (host.projectRoot ?? this.rootDir) : this.rootDir,
    };
  }

  async compile<T extends InvocableResource>(
    ref: PragmaResourceRef,
    host: PragmaCompileOptions,
  ): Promise<CompiledResource<T>> {
    host = this.withProjectRoot(host);
    const compilerErrors = this.sourceDiagnostics.filter(
      (diagnostic) => diagnostic.severity === "error" && diagnostic.code.startsWith("compiler."),
    );
    if (compilerErrors.length > 0) {
      throw new PragmaDslError(
        `Pragma project compiler compatibility check failed: ${compilerErrors
          .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
          .join("; ")}`,
        compilerErrors,
      );
    }
    const indexed = this.resolveResource(ref);
    if (!isInvocableResource(indexed.resource)) {
      throw new PragmaDslError(`Resource is not invocable: ${ref}`);
    }
    const diagnostics = await this.validateFor(ref);
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length > 0) {
      throw new PragmaDslError(
        `Pragma project validation failed: ${errors.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("; ")}`,
        errors,
      );
    }
    const cache = new Map<string, InvocableResource>();
    const compiling = new Set<string>();
    const contextPolicies = host.contextPolicies ?? new ContextPolicyRegistry();
    const actions = host.actions ?? new FlowActionRegistry();
    const toolAdapters = host.toolAdapters ?? new ToolAdapterRegistry();
    const resourceAdapters =
      host.resourceAdapters ??
      this.options.resourceAdapters ??
      createDefaultPragmaResourceAdapterRegistry();
    const adapterHost = createAdapterHost(
      host,
      this.artifacts,
      this.options.sourceIdentity !== undefined,
    );
    const resolvedResources = new Map<
      string,
      { readonly contribution: PragmaResourceContribution; readonly health: PragmaResourceHealth }
    >();
    const resolvingResources = new Map<
      string,
      Promise<{
        readonly contribution: PragmaResourceContribution;
        readonly health: PragmaResourceHealth;
      }>
    >();
    const resolvedPlugins: {
      readonly expertRef: string;
      readonly ref: string;
      readonly resolution: PragmaPluginResolution;
    }[] = [];
    const resolvingPlugins = new Map<string, Promise<PragmaPluginResolution>>();

    const resolveDeclarative = async <TContribution extends PragmaResourceContribution>(
      resourceRef: string,
      kind: PragmaDeclarativeResource["kind"],
    ): Promise<{ readonly contribution: TContribution; readonly health: PragmaResourceHealth }> => {
      const indexed = this.resolveResource(resourceRef);
      if (indexed.resource.kind !== kind) {
        throw new PragmaDslError(`Expected ${kind} resource, received: ${resourceRef}`);
      }
      const key = canonicalRef(indexed.resource);
      const existing = resolvedResources.get(key);
      if (existing !== undefined) {
        return existing as {
          readonly contribution: TContribution;
          readonly health: PragmaResourceHealth;
        };
      }
      const pending = resolvingResources.get(key);
      if (pending !== undefined) {
        return (await pending) as {
          readonly contribution: TContribution;
          readonly health: PragmaResourceHealth;
        };
      }
      const resolving = (async () => {
        const baseResolved = await resourceAdapters.resolve<TContribution>(
          indexed.resource as PragmaDeclarativeResource,
          adapterHost,
        );
        const resolved =
          indexed.resource.kind === "RuntimeProfile" && host.runtimes !== undefined
            ? await verifyRuntimeEnvironment(
                baseResolved as PragmaResourceInspection<PragmaRuntimeProfileContribution>,
                host.runtimes,
                false,
              )
            : baseResolved;
        if (resolved.health.status !== "ready" || resolved.contribution === undefined) {
          throw new PragmaResourceNeedsAttentionError(resolved.health);
        }
        const value = {
          contribution: resolved.contribution,
          health: resolved.health,
        };
        resolvedResources.set(key, value);
        return value;
      })();
      resolvingResources.set(key, resolving);
      try {
        return (await resolving) as {
          readonly contribution: TContribution;
          readonly health: PragmaResourceHealth;
        };
      } finally {
        if (resolvingResources.get(key) === resolving) resolvingResources.delete(key);
      }
    };

    const resolveRuntime = async (runtimeRef: string): Promise<PragmaRuntimeProfileContribution> =>
      (await resolveDeclarative<PragmaRuntimeProfileContribution>(runtimeRef, "RuntimeProfile"))
        .contribution;

    const rootExpertRefs = new Set<string>();
    if (indexed.resource.kind === "Expert") {
      rootExpertRefs.add(canonicalRef(indexed.resource));
    } else if (indexed.resource.kind === "ExpertTeam") {
      rootExpertRefs.add(indexed.resource.spec.coordinator.ref);
    }

    const instantiate = async (resourceRef: string): Promise<InvocableResource> => {
      const parsedRef = parsePragmaReference(resourceRef);
      const externalKey = `${parsedRef.kind}:${parsedRef.id}` as PragmaResourceRef;
      const indexed = this.resources.get(externalKey);
      if (indexed === undefined) {
        const existing = cache.get(externalKey);
        if (existing !== undefined) return existing;
        const external = await host.resolveExternalInvocable?.(externalKey);
        if (external === undefined) {
          throw new PragmaDslError(`Pragma resource not found: ${resourceRef}`);
        }
        cache.set(externalKey, external);
        return external;
      }
      const key = canonicalRef(indexed.resource);
      const existing = cache.get(key);
      if (existing !== undefined) return existing;
      if (compiling.has(key)) throw new PragmaDslError(`Cyclic resource dependency: ${key}`);
      compiling.add(key);
      let value: InvocableResource;
      if (indexed.resource.kind === "Expert") {
        const tools: ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] = [];
        for (const binding of indexed.resource.spec.tools) {
          const targetRefs = binding.target === undefined ? binding.targets! : [binding.target];
          const targets = await Promise.all(
            targetRefs.map(async (target) => ({
              resource: this.resolveResource(target.ref).resource as PragmaInvocableResource,
              value: await instantiate(target.ref),
            })),
          );
          const runtimeEntries = await Promise.all(
            Object.entries(binding.policy?.runtimes ?? {}).map(
              async ([expertId, runtimeRef]) =>
                [expertId, (await resolveRuntime(runtimeRef)).runtimeId] as const,
            ),
          );
          tools.push(
            ...toolAdapters.createTools({
              binding,
              targets,
              contextPolicies,
              runtimeByExpert: Object.fromEntries(runtimeEntries),
            }),
          );
        }
        value = await compileExpert(
          indexed.resource,
          tools,
          host,
          rootExpertRefs.has(key) ? host.rootExecutionOverride : undefined,
          {
            resolveCapability: async (resourceRef) =>
              (await resolveDeclarative<PragmaCapabilityContribution>(resourceRef, "Capability"))
                .contribution,
            resolveContextStore: async (resourceRef) =>
              (
                await resolveDeclarative<PragmaContextStoreContribution>(
                  resourceRef,
                  "ContextStore",
                )
              ).contribution,
            resolveRuntime,
            resolvePlugin: async (binding) => {
              if (host.plugins === undefined) {
                throw new PragmaDslError(
                  `Expert ${indexed.resource.metadata.id} references ${binding.ref}, but the host has no Plugin resolver.`,
                );
              }
              const expertRef = canonicalRef(indexed.resource) as `expert:${string}`;
              const resolutionKey = stableStringify({ expertRef, binding });
              let resolving = resolvingPlugins.get(resolutionKey);
              if (resolving === undefined) {
                resolving = host.plugins.resolve({ expertRef, binding }).then((resolution) => {
                  assertPluginResolution(binding.ref, resolution);
                  resolvedPlugins.push({
                    expertRef,
                    ref: binding.ref,
                    resolution,
                  });
                  return resolution;
                });
                resolvingPlugins.set(resolutionKey, resolving);
              }
              return await resolving;
            },
          },
        );
      } else if (indexed.resource.kind === "ExpertTeam") {
        const coordinator = await instantiate(indexed.resource.spec.coordinator.ref);
        const members = await Promise.all(
          indexed.resource.spec.members.map(async (member) => await instantiate(member.ref)),
        );
        if (!isPlainExpert(coordinator) || members.some((member) => !isPlainExpert(member))) {
          throw new PragmaDslError(
            `ExpertTeam ${indexed.resource.metadata.id} only accepts Experts.`,
          );
        }
        const runtimeEntries = await Promise.all(
          Object.entries(indexed.resource.spec.delegation.runtimes).map(
            async ([expertId, runtimeRef]) =>
              [expertId, (await resolveRuntime(runtimeRef)).runtimeId] as const,
          ),
        );
        const contextStores = await Promise.all(
          indexed.resource.spec.contextStores.map(async (binding) => ({
            namespace: binding.namespace,
            required: binding.required,
            visibility: binding.visibility,
            store: (
              await resolveDeclarative<PragmaContextStoreContribution>(binding.ref, "ContextStore")
            ).contribution.store,
          })),
        );
        value = defineExpertTeam({
          id: indexed.resource.metadata.id,
          name: indexed.resource.metadata.name,
          description: indexed.resource.metadata.description,
          instructions: indexed.resource.spec.instructions,
          coordinator,
          members: members as Expert[],
          contextStores,
          delegation: {
            allow: indexed.resource.spec.delegation.allow,
            maxConcurrency: indexed.resource.spec.delegation.maxConcurrency,
            maxDepth: indexed.resource.spec.delegation.maxDepth,
            contextId: contextPolicies.resolve(indexed.resource.spec.delegation.context),
            runtimeByExpert: Object.fromEntries(runtimeEntries),
          },
        });
      } else if (indexed.resource.kind === "Flow") {
        value = await compileFlowResource(
          indexed.resource,
          instantiate,
          actions,
          contextPolicies,
          resolveRuntime,
        );
      } else {
        throw new PragmaDslError(`Resource is not invocable: ${resourceRef}`);
      }
      compiling.delete(key);
      cache.set(key, value);
      provenance.set(value, { project: this, root: indexed });
      return value;
    };

    const value = (await instantiate(ref)) as T;
    const rootRuntimeId = await resolveRootRuntime(
      indexed.resource,
      this.resources,
      resolveRuntime,
      host,
    );
    let rootRuntimeEnvironment: unknown;
    if (host.runtimes !== undefined) {
      const rootModelSelection = await resolveRootModelSelection(
        indexed.resource,
        this.resources,
        resolveRuntime,
        host,
      );
      const resolvedRootRuntime = await host.runtimes.bind({
        runtimeId: rootRuntimeId,
        ...(rootModelSelection === undefined ? {} : { modelSelection: rootModelSelection }),
      });
      const availability = await resolvedRootRuntime.adapter.canUse();
      if (!availability.usable) {
        throw new Error(
          availability.reason ??
            `Runtime is unavailable: ${resolvedRootRuntime.adapter.descriptor.id}`,
        );
      }
      const models =
        resolvedRootRuntime.adapter.listModels === undefined
          ? undefined
          : await resolvedRootRuntime.adapter.listModels();
      rootRuntimeEnvironment = {
        binding: resolvedRootRuntime.binding,
        descriptor: resolvedRootRuntime.adapter.descriptor,
        availability,
        models,
        ...(rootModelSelection === undefined ? {} : { modelSelection: rootModelSelection }),
      };
    }
    const projectFingerprint = this.createLock().projectFingerprint;
    const fingerprintResources = [...resolvedResources.entries()]
      .map(([resourceRef, resolved]) => ({
        ref: resourceRef as PragmaSemanticResourceRef,
        ...(resolved.health.bindingRevision === undefined
          ? {}
          : { bindingRevision: resolved.health.bindingRevision }),
        verificationFingerprint: resolved.health.verificationFingerprint!,
      }))
      .sort((left, right) => left.ref.localeCompare(right.ref));
    const fingerprintPlugins = resolvedPlugins
      .map((resolved) => ({
        expertRef: resolved.expertRef,
        ref: resolved.ref,
        packageFingerprint: resolved.resolution.packageFingerprint,
        verificationFingerprint: resolved.resolution.verificationFingerprint,
      }))
      .sort((left, right) =>
        `${left.expertRef}:${left.ref}`.localeCompare(`${right.expertRef}:${right.ref}`),
      );
    const environmentFingerprintValue = sha256(
      stableStringify({
        environmentId: adapterHost.environmentId,
        projectFingerprint,
        resources: fingerprintResources,
        plugins: fingerprintPlugins,
        rootRuntime: rootRuntimeEnvironment,
      }),
    );
    return {
      ref: canonicalRef(indexed.resource),
      value,
      fingerprint: indexed.contentHash,
      projectFingerprint,
      environmentFingerprint: {
        environmentId: adapterHost.environmentId,
        projectFingerprint,
        value: environmentFingerprintValue,
        resources: fingerprintResources,
        plugins: fingerprintPlugins,
      },
      ...(rootRuntimeId === undefined ? {} : { rootRuntimeId }),
      dependencies: collectLockedDependencies(indexed, this.resources),
    };
  }

  async dump(resource: object, options: DumpOptions = {}): Promise<DumpedFiles> {
    const source = provenance.get(resource);
    if (source === undefined) {
      const serialized = this.options.serializers?.serialize(resource);
      if (serialized === undefined) {
        throw new PragmaDslError(
          "Cannot dump a programmatic resource because one or more components have no descriptor.",
        );
      }
      return { files: new Map([[`${serialized.metadata.id}.pragma.yaml`, stringify(serialized)]]) };
    }
    const mode = options.split ?? "preserve";
    if (mode === "single") {
      const bundle = PragmaBundleSchema.parse({
        apiVersion: "pragma/v4",
        kind: "Bundle",
        resources: this.listResources(),
      });
      return { files: new Map([["pragma.yaml", stringify(bundle)]]) };
    }
    const files = new Map<string, string>();
    const imports: string[] = [];
    for (const indexed of this.resources.values()) {
      const path = `${pragmaResourceDirectory(indexed.resource)}/${pragmaResourceFileName(indexed.resource)}`;
      imports.push(`./${path}`);
      files.set(path, stringify(indexed.resource));
    }
    files.set(
      "pragma.yaml",
      stringify({
        apiVersion: "pragma/v4",
        kind: "Bundle",
        imports: imports.sort(),
        resources: [],
      }),
    );
    files.set("pragma.lock.yaml", stringify(this.createLock()));
    return { files };
  }

  async exportBundle(options: PragmaProjectBundleExportOptions): Promise<PragmaBundleExportResult> {
    if (options.roots.length === 0)
      throw new PragmaDslError("A bundle requires at least one root.");
    const roots = options.roots.map((root) => {
      if (typeof root === "string") return this.resolveResource(root);
      const source = provenance.get(root);
      if (source?.project === this) return source.root;
      const serialized = this.options.serializers?.serialize(root);
      if (serialized !== undefined) return this.resolveResource(canonicalRef(serialized));
      throw new PragmaDslError("Bundle root has no DSL provenance or registered serializer.");
    });
    const additionalRoots = (options.additionalRoots ?? []).map((root) => {
      if (typeof root === "string") return this.resolveResource(root);
      const source = provenance.get(root);
      if (source?.project === this) return source.root;
      const serialized = this.options.serializers?.serialize(root);
      if (serialized !== undefined) return this.resolveResource(canonicalRef(serialized));
      throw new PragmaDslError("Additional bundle root has no DSL provenance or serializer.");
    });
    const selected = new Map<string, IndexedResource>();
    for (const root of [...roots, ...additionalRoots]) {
      for (const [ref, indexed] of this.collectDependencyClosure(root)) selected.set(ref, indexed);
    }
    const portable = portableizeBundleResources(selected, this.options.resourceAdapters);
    const files = new Map<string, Uint8Array>();
    const projectBundle = PragmaBundleSchema.parse({
      apiVersion: "pragma/v4",
      kind: "Bundle",
      resources: portable.resources,
    });
    files.set("project/pragma.yaml", new TextEncoder().encode(formatPragmaYaml(projectBundle)));

    const artifacts = await collectSelectedBundleArtifacts(
      portable.resources,
      this.rootDir,
      this.options.resourceAdapters ?? createDefaultPragmaResourceAdapterRegistry(),
      files,
    );
    const lockResources = portable.resources
      .map((resource) => ({
        ref: canonicalRef(resource),
        contentHash: sha256(stableStringify(resource)),
        source: "pragma.yaml",
      }))
      .toSorted((left, right) => left.ref.localeCompare(right.ref));
    const projectFingerprint = sha256(
      stableStringify({
        resources: lockResources.map(({ ref, contentHash }) => ({ ref, contentHash })),
        artifacts,
      }),
    );
    const lock = PragmaLockSchema.parse({
      apiVersion: "pragma/v4",
      kind: "Lock",
      compilerVersion: PRAGMA_COMPILER_WRITE_VERSION,
      projectFingerprint,
      resources: lockResources,
      artifacts,
    });
    files.set("project/pragma.lock.yaml", new TextEncoder().encode(formatPragmaYaml(lock)));

    const requirements: PragmaBundleRequirement[] = [];
    for (const draft of portable.requirements) {
      const payload =
        draft.requirement.kind === "secret"
          ? undefined
          : await options.host?.exportPayload?.({
              requirement: draft.requirement,
              ...(draft.originalBindingRef === undefined
                ? {}
                : { originalBindingRef: draft.originalBindingRef }),
            });
      if (payload === undefined) {
        requirements.push(draft.requirement);
        continue;
      }
      if (payload.files.size === 0) {
        throw new PragmaDslError(`Bundle payload is empty: ${draft.requirement.id}.`);
      }
      const root = `assets/${draft.requirement.id}`;
      const payloadEntries: { path: string; sha256: string }[] = [];
      for (const [relativePath, contents] of payload.files) {
        const path = `${root}/${relativePath}`;
        files.set(path, contents);
        payloadEntries.push({ path: relativePath, sha256: sha256(contents) });
      }
      requirements.push({
        ...draft.requirement,
        payload: {
          codec: payload.codec,
          root,
          fingerprint: sha256(
            stableStringify(payloadEntries.toSorted((a, b) => a.path.localeCompare(b.path))),
          ),
        },
      });
    }

    const extensions = (options.extensions ?? []).map((extension) => {
      if (extension.files.size === 0) {
        throw new PragmaDslError(
          `Bundle extension is empty: ${extension.id}@${extension.version}.`,
        );
      }
      const root = `extensions/${sha256(`${extension.id}@${extension.version}`).slice(0, 24)}`;
      const entries: { path: string; sha256: string }[] = [];
      for (const [relativePath, contents] of extension.files) {
        files.set(`${root}/${relativePath}`, contents);
        entries.push({ path: relativePath, sha256: sha256(contents) });
      }
      return {
        id: extension.id,
        version: extension.version,
        required: extension.required ?? false,
        root,
        fingerprint: sha256(
          stableStringify(entries.toSorted((a, b) => a.path.localeCompare(b.path))),
        ),
      };
    });
    return await encodePragmaBundle({
      manifest: {
        schemaVersion: "pragma.bundle/v1",
        createdAt: options.createdAt ?? new Date().toISOString(),
        roots: roots.map((root) => canonicalRef(root.resource)),
        project: {
          entry: "project/pragma.yaml",
          compilerVersion: PRAGMA_COMPILER_WRITE_VERSION,
          projectFingerprint,
        },
        requirements,
        extensions,
      },
      files,
    });
  }

  createLock(): PragmaLock {
    const resources = [...this.resources.values()]
      .sort((left, right) =>
        canonicalRef(left.resource).localeCompare(canonicalRef(right.resource)),
      )
      .map((indexed) => ({
        ref: canonicalRef(indexed.resource),
        contentHash: indexed.contentHash,
        source: relative(dirname(this.entryFile), indexed.source),
      }));
    const artifacts = [...this.artifacts.entries()]
      .map(([source, contentHash]) => ({ source, contentHash }))
      .toSorted((left, right) => left.source.localeCompare(right.source));
    return {
      apiVersion: "pragma/v4",
      kind: "Lock",
      compilerVersion: PRAGMA_COMPILER_WRITE_VERSION,
      projectFingerprint: sha256(
        stableStringify({
          resources: resources.map(({ ref, contentHash }) => ({ ref, contentHash })),
          artifacts,
        }),
      ),
      resources,
      artifacts,
    };
  }

  async readLock(): Promise<PragmaLock> {
    return PragmaLockSchema.parse(
      parsePragmaYaml(await readFile(resolve(dirname(this.entryFile), "pragma.lock.yaml"), "utf8")),
    );
  }

  private async validateLock(): Promise<PragmaDiagnostic[]> {
    this.lockValidation ??= this.validateLockOnce();
    return await this.lockValidation;
  }

  private async validateLockOnce(): Promise<PragmaDiagnostic[]> {
    const lockPath = resolve(dirname(this.entryFile), "pragma.lock.yaml");
    let lock: PragmaLock;
    try {
      lock = PragmaLockSchema.parse(parsePragmaYaml(await readFile(lockPath, "utf8")));
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      return [
        {
          severity: "error",
          code: missing ? "lock.missing" : "lock.invalid",
          message: missing
            ? "Published Pragma project revision is missing pragma.lock.yaml."
            : error instanceof Error
              ? error.message
              : String(error),
          source: lockPath,
          path: [],
        },
      ];
    }
    const expected = this.createLock();
    const expectedByRef = new Map(expected.resources.map((resource) => [resource.ref, resource]));
    const actualByRef = new Map(lock.resources.map((resource) => [resource.ref, resource]));
    const mismatches = [...new Set([...expectedByRef.keys(), ...actualByRef.keys()])].filter(
      (ref) => {
        const left = expectedByRef.get(ref);
        const right = actualByRef.get(ref);
        return left === undefined || right === undefined || left.contentHash !== right.contentHash;
      },
    );
    if (lock.projectFingerprint !== expected.projectFingerprint) {
      mismatches.push(`project:${lock.projectFingerprint}`);
    }
    return mismatches.length === 0
      ? []
      : [
          {
            severity: "error",
            code: "lock.mismatch",
            message: `Pragma lock is stale for: ${mismatches.sort().join(", ")}.`,
            source: lockPath,
            path: ["resources"],
          },
        ];
  }

  private resolveResource(ref: string): IndexedResource {
    const parsed = parsePragmaReference(ref);
    const indexed = this.resources.get(`${parsed.kind}:${parsed.id}`);
    if (indexed === undefined) throw new PragmaDslError(`Pragma resource not found: ${ref}`);
    return indexed;
  }

  private validateReferences(indexed: IndexedResource): PragmaDiagnostic[] {
    const diagnostics: PragmaDiagnostic[] = [];
    const resourceRef = canonicalRef(indexed.resource);
    for (const ref of resourceDependencies(indexed.resource)) {
      if (this.options.externalResourceRefs?.has(ref)) continue;
      try {
        this.resolveResource(ref);
      } catch (error) {
        diagnostics.push({
          severity: "error",
          code: "reference.invalid",
          message: error instanceof Error ? error.message : String(error),
          resourceRef,
          source: indexed.source,
          path: [],
        });
      }
    }
    return diagnostics;
  }
}

async function compileExpert(
  resource: PragmaExpertResource,
  tools: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[],
  host: PragmaCompileHost,
  executionOverride:
    | {
        readonly runtimeId: string;
        readonly modelSelection?: import("@pragma/core").RuntimeModelSelection | undefined;
      }
    | undefined,
  resolvers: {
    readonly resolveCapability: (ref: string) => Promise<PragmaCapabilityContribution>;
    readonly resolveContextStore: (ref: string) => Promise<PragmaContextStoreContribution>;
    readonly resolveRuntime: (ref: string) => Promise<PragmaRuntimeProfileContribution>;
    readonly resolvePlugin: (
      binding: PragmaExpertResource["spec"]["plugins"][number],
    ) => Promise<PragmaPluginResolution>;
  },
): Promise<Expert> {
  const [plugins, runtime, capabilities, contextStores] = await Promise.all([
    Promise.all(resource.spec.plugins.map(resolvers.resolvePlugin)),
    executionOverride !== undefined || resource.spec.runtime === undefined
      ? Promise.resolve(undefined)
      : resolvers.resolveRuntime(resource.spec.runtime.ref),
    Promise.all(
      resource.spec.capabilities.map(async (binding) => ({
        binding,
        contribution: await resolvers.resolveCapability(binding.ref),
      })),
    ),
    Promise.all(
      resource.spec.contextStores.map(async (binding) => ({
        namespace: binding.namespace,
        required: binding.required,
        contribution: await resolvers.resolveContextStore(binding.ref),
      })),
    ),
  ]);
  const capabilityTools: ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] = [];
  const skillConfigs: IExpertAgentSkillsConfig[] = [];
  const mcpConfigs: IExpertAgentMcpConfig[] = [];
  for (const { binding, contribution } of capabilities) {
    if (binding.kind === "skill") {
      if (contribution.skills === undefined) {
        throw new PragmaDslError(`${binding.ref} does not provide a Skill.`);
      }
      skillConfigs.push(contribution.skills);
      continue;
    }
    const allowed = new Set(binding.tools ?? []);
    if (contribution.tools !== undefined) {
      capabilityTools.push(
        ...contribution.tools
          .filter((tool) => allowed.has(tool.name))
          .map((tool) => ({
            ...tool,
            approval: mergeExpertAgentToolApprovals(tool.approval, {
              mode: resource.spec.toolApprovals[tool.name] ?? "ask",
            }),
          })),
      );
    }
    if (contribution.mcp !== undefined) {
      mcpConfigs.push(filterMcpContribution(contribution.mcp, allowed, resource));
    }
  }
  return await defineExpert({
    id: resource.metadata.id,
    name: resource.metadata.name,
    description: resource.metadata.description,
    tags: resource.metadata.tags,
    scope: resource.spec.scope,
    instructions: resource.spec.instructions,
    workspace: host.workspace,
    ...(host.pragmaHome === undefined ? {} : { pragmaHome: host.pragmaHome }),
    ...(host.loggerProvider === undefined ? {} : { loggerProvider: host.loggerProvider }),
    tools: [...tools, ...capabilityTools],
    skills: mergeSkills(skillConfigs),
    mcp: mergeMcp(mcpConfigs),
    ...(executionOverride?.modelSelection !== undefined
      ? { models: { default: executionOverride.modelSelection } }
      : runtime?.models === undefined
        ? host.defaultModelSelection === undefined
          ? {}
          : { models: { default: host.defaultModelSelection } }
        : { models: runtime.models }),
    ...(executionOverride !== undefined
      ? { defaultRuntimeId: executionOverride.runtimeId }
      : runtime === undefined
        ? {}
        : { defaultRuntimeId: runtime.runtimeId }),
    contextSystem: createContextSystem(contextStores),
    plugins: plugins.map((plugin) => ({
      source: plugin.source,
      expectedRef: plugin.ref,
      packageFingerprint: plugin.packageFingerprint,
      ...(plugin.cachePolicy === undefined ? {} : { cachePolicy: plugin.cachePolicy }),
      userConfig: plugin.userConfig,
      ...(plugin.hostBindings === undefined ? {} : { hostBindings: plugin.hostBindings }),
    })),
  });
}

function assertPluginResolution(expectedRef: string, resolution: PragmaPluginResolution): void {
  if (resolution.ref !== expectedRef) {
    throw new PragmaDslError(
      `Plugin resolver returned ${resolution.ref} for requested ${expectedRef}.`,
    );
  }
  for (const [name, value] of [
    ["packageFingerprint", resolution.packageFingerprint],
    ["verificationFingerprint", resolution.verificationFingerprint],
  ] as const) {
    if (!/^[a-f0-9]{64}$/.test(value)) {
      throw new PragmaDslError(`Plugin resolver returned an invalid ${name} for ${expectedRef}.`);
    }
  }
}

async function compileFlowResource(
  resource: PragmaFlowResource,
  instantiate: (ref: string) => Promise<InvocableResource>,
  actions: FlowActionRegistry,
  contextPolicies: ContextPolicyRegistry,
  resolveRuntime: (ref: string) => Promise<PragmaRuntimeProfileContribution>,
): Promise<Flow> {
  const inputSchema = createJsonSchemaZod(resource.spec.input?.schema);
  const outputSchema = createJsonSchemaZod(resource.spec.output?.schema);
  const flow = defineFlow({
    id: resource.metadata.id,
    input: inputSchema,
    output: outputSchema,
    maxNodeVisits: resource.spec.limits.maxNodeVisits,
    timeoutMs: resource.spec.limits.timeoutMs,
    ...(resource.spec.output?.value === undefined
      ? {}
      : {
          result: ({
            input,
            state,
            terminal,
          }: {
            readonly input: unknown;
            readonly state: FlowState;
            readonly terminal: { readonly output: unknown };
          }) => evaluatePragmaFlowValue(resource.spec.output!.value, state, input, terminal.output),
        }),
  });
  const references = new Map<string, FlowStepReference>();
  for (const [stepId, step] of Object.entries(resource.spec.graph.steps)) {
    const mappedInput =
      step.input === undefined
        ? undefined
        : ({ state, flowInput }: { state: FlowState; flowInput: unknown }) =>
            evaluatePragmaFlowValue(step.input, state, flowInput);
    const promptInput =
      step.prompt === undefined
        ? undefined
        : ({ state, flowInput }: { state: FlowState; flowInput: unknown }) =>
            renderPragmaFlowPrompt(step.prompt!, state, flowInput);
    const descriptor = {
      ...(step.input === undefined ? {} : { input: step.input }),
      ...(step.prompt === undefined ? {} : { prompt: step.prompt }),
      ...(step.output === undefined ? {} : { output: step.output }),
      ...(step.runtime === undefined ? {} : { runtime: step.runtime }),
    };
    if (step.action !== undefined) {
      const action = actions.resolve(step.action.ref);
      references.set(
        stepId,
        flow.task({
          id: stepId,
          input: mappedInput,
          descriptor,
          inputSchema: createJsonSchemaZod(action.inputSchema),
          outputSchema: createJsonSchemaZod(action.outputSchema),
          handler: async (context) => await action.execute(context),
        }),
      );
      continue;
    }
    if (step.human !== undefined) {
      const selectionSchema =
        step.human.selectionMode === "single"
          ? z.object({ selection: z.string().min(1) })
          : z.object({ selection: z.array(z.string().min(1)).min(1) });
      references.set(
        stepId,
        flow.humanTask({
          id: stepId,
          input: mappedInput,
          output: selectionSchema,
          descriptor,
          request: ({ input: stepInput, state }) =>
            compileHumanRequest(step.human!, state, stepInput),
        }),
      );
      continue;
    }
    const targetRef = step.expert?.ref ?? step.team?.ref ?? step.flow?.ref;
    if (targetRef === undefined) throw new PragmaDslError(`Flow step has no target: ${stepId}`);
    const target = await instantiate(targetRef);
    const runtimeProfile =
      step.runtime === undefined ? undefined : await resolveRuntime(step.runtime.ref);
    const runtime = runtimeProfile?.runtimeId;
    const modelSelection = step.runtime?.modelSelection ?? runtimeProfile?.models?.default;
    const runtimeEntries = await Promise.all(
      Object.entries(step.runtimes ?? {}).map(
        async ([expertId, runtimeRef]) =>
          [expertId, (await resolveRuntime(runtimeRef)).runtimeId] as const,
      ),
    );
    const options = {
      input: promptInput,
      output: createJsonSchemaZod(step.output?.schema),
      descriptor,
      runtime,
      runtimeByExpert: Object.fromEntries(runtimeEntries),
      modelSelection,
      contextId: step.context === undefined ? undefined : contextPolicies.resolve(step.context),
    };
    references.set(
      stepId,
      "kind" in target && target.kind === "flow"
        ? flow.use(stepId, target, { input: mappedInput, descriptor, runtime })
        : flow.use(stepId, target as ExpertDefinition, options),
    );
  }
  const start = references.get(resource.spec.graph.start);
  if (start === undefined)
    throw new PragmaDslError(`Unknown Flow start: ${resource.spec.graph.start}`);
  flow.compose(({ start: begin }) => begin(start));

  const loopMembers = validateAndReadLoopMembers(resource);
  for (const [loopId, loop] of Object.entries(resource.spec.graph.loops)) {
    flow.loop({
      id: loopId,
      entry: requireStepReference(references, loop.entry),
      steps: [...(loopMembers.get(loopId) ?? [])].map((id) => requireStepReference(references, id)),
      maxIterations: loop.maxIterations,
      onLimit: loop.onLimit === undefined ? undefined : compileTarget(loop.onLimit, references),
    });
  }
  for (const [stepId, transition] of Object.entries(resource.spec.graph.transitions)) {
    flow.setTransition(stepId, compileTransition(transition, references));
  }
  return flow.compile();
}

function compileTransition(
  transition: PragmaFlowTransition,
  references: ReadonlyMap<string, FlowStepReference>,
) {
  if (
    typeof transition === "string" ||
    "goto" in transition ||
    "end" in transition ||
    "fail" in transition
  ) {
    return { type: "next" as const, target: compileTarget(transition, references) };
  }

  if ("repeat" in transition) {
    return {
      type: "repeat" as const,
      loopId: transition.repeat.loop,
      target: requireStepReference(references, transition.repeat.goto),
    };
  }
  if ("branches" in transition) {
    return {
      type: "array-route" as const,
      field: transition.route,
      branches: transition.branches.map((branch) => ({
        id: branch.id,
        operator: branch.operator,
        values: [...branch.values],
        destination: compileDestination(branch.destination, references),
      })),
      fallback:
        transition.fallback === undefined
          ? undefined
          : compileDestination(transition.fallback, references),
    };
  }
  return {
    type: "route" as const,
    field: transition.route,
    cases: new Map(
      Object.entries(transition.cases).map(([key, target]) => [
        key,
        compileDestination(target, references),
      ]),
    ),
    fallback:
      transition.fallback === undefined
        ? undefined
        : compileDestination(transition.fallback, references),
  };
}

function compileDestination(
  target: PragmaFlowDestination,
  references: ReadonlyMap<string, FlowStepReference>,
) {
  return typeof target === "object" && "repeat" in target
    ? {
        type: "repeat" as const,
        loopId: target.repeat.loop,
        target: requireStepReference(references, target.repeat.goto),
      }
    : compileTarget(target, references);
}

function compileTarget(
  target: PragmaFlowTarget,
  references: ReadonlyMap<string, FlowStepReference>,
): FlowStepReference | FlowTerminal {
  if (typeof target === "string") return requireStepReference(references, target);
  if ("goto" in target) return requireStepReference(references, target.goto);
  if ("end" in target) return { type: "end" };
  return { type: "fail", reason: target.fail };
}

function compileHumanRequest(
  request: NonNullable<PragmaFlowResource["spec"]["graph"]["steps"][string]["human"]>,
  state: FlowState,
  input: unknown,
) {
  const question = renderPragmaFlowPrompt(request.prompt, state, input);
  return {
    kind: "question" as const,
    prompt: question,
    questions: [
      {
        header: "Selection",
        question,
        kind:
          request.selectionMode === "single"
            ? ("single_choice" as const)
            : ("multiple_choice" as const),
        options: request.options.map((option) => ({
          value: option.value,
          label: option.label,
          description: option.description ?? "",
        })),
      },
    ],
  };
}

function createJsonSchemaZod(schema: unknown): z.ZodTypeAny | undefined {
  if (schema === undefined) return undefined;
  assertValidJsonSchema(schema);
  return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
}

function validatePortableSemantics(
  indexed: IndexedResource,
  resources: ReadonlyMap<string, IndexedResource>,
): PragmaDiagnostic[] {
  const diagnostics: PragmaDiagnostic[] = [];
  const add = (code: string, message: string, path: (string | number)[]): void => {
    diagnostics.push({
      severity: "error",
      code,
      message,
      source: indexed.source,
      path,
    });
  };
  const resource = indexed.resource;
  if (resource.kind === "Expert") {
    resource.spec.tools.forEach((binding, index) => {
      if (binding.adapter === "pragma.tool.call@v1") {
        if (
          binding.target === undefined ||
          binding.targets !== undefined ||
          binding.tool === undefined
        ) {
          add(
            "tool.binding.invalid",
            "pragma.tool.call@v1 requires exactly one target and a tool declaration.",
            ["spec", "tools", index],
          );
        }
        if (binding.policy !== undefined) {
          add(
            "tool.binding.invalid",
            "pragma.tool.call@v1 does not accept delegation policy fields.",
            ["spec", "tools", index, "policy"],
          );
        }
      }
      if (binding.adapter === "pragma.tool.delegate@v1") {
        if (binding.tool !== undefined) {
          add(
            "tool.binding.invalid",
            "pragma.tool.delegate@v1 does not accept a tool declaration.",
            ["spec", "tools", index, "tool"],
          );
        }
        const refs = binding.target === undefined ? (binding.targets ?? []) : [binding.target];
        for (const target of refs) {
          const parsed = parsePragmaReference(target.ref);
          const resolved = resources.get(`${parsed.kind}:${parsed.id}`)?.resource;
          if (resolved !== undefined && resolved.kind !== "Expert") {
            add("tool.binding.invalid", "pragma.tool.delegate@v1 only supports Expert targets.", [
              "spec",
              "tools",
              index,
            ]);
          }
        }
      }
    });
  }
  if (resource.kind === "Flow") {
    for (const [field, schema] of [
      ["input", resource.spec.input?.schema],
      ["output", resource.spec.output?.schema],
    ] as const) {
      if (schema === undefined) continue;
      try {
        assertValidJsonSchema(schema);
        new Validator(schema, "2020-12", false).validate(null);
      } catch (error) {
        add("flow.schema.invalid", error instanceof Error ? error.message : String(error), [
          "spec",
          field,
          "schema",
        ]);
      }
    }
  }
  if (resource.kind === "Automation") {
    const executorRef = resource.spec.route.executor.ref;
    const parsed = parsePragmaReference(executorRef);
    const executor = resources.get(`${parsed.kind}:${parsed.id}`)?.resource;
    if (executor?.kind === "Flow" && executor.spec.input?.schema !== undefined) {
      if (resource.spec.route.input.kind !== "flow") {
        add(
          "automation.input.kind_invalid",
          "Flows with an input schema require structured Automation input.",
          ["spec", "route", "input"],
        );
      } else {
        const flowInputSchema = createJsonSchemaZod(executor.spec.input.schema);
        if (flowInputSchema !== undefined) {
          const validation = flowInputSchema.safeParse(resource.spec.route.input.value);
          if (!validation.success) {
            for (const issue of validation.error.issues) {
              add("automation.input.schema_invalid", issue.message, [
                "spec",
                "route",
                "input",
                "value",
                ...issue.path.map((segment) =>
                  typeof segment === "symbol"
                    ? (segment.description ?? segment.toString())
                    : segment,
                ),
              ]);
            }
          }
        }
      }
    }
  }
  return diagnostics;
}

function assertValidJsonSchema(
  value: unknown,
  path = "$",
  ancestors: Set<object> = new Set(),
): asserts value is Schema | boolean {
  if (typeof value === "boolean") return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`JSON Schema at ${path} must be an object or boolean.`);
  }
  if (ancestors.has(value)) throw new Error(`JSON Schema contains a cycle at ${path}.`);
  ancestors.add(value);
  try {
    const schema = value as Record<string, unknown>;
    const instanceTypes = new Set([
      "array",
      "boolean",
      "integer",
      "null",
      "number",
      "object",
      "string",
    ]);
    if (schema["type"] !== undefined) {
      const types = Array.isArray(schema["type"]) ? schema["type"] : [schema["type"]];
      if (
        types.length === 0 ||
        types.some((type) => typeof type !== "string" || !instanceTypes.has(type)) ||
        new Set(types).size !== types.length
      ) {
        throw new Error(`JSON Schema type is invalid at ${path}.type.`);
      }
    }
    for (const keyword of ["$id", "$anchor", "$ref", "$schema", "$comment", "format"] as const) {
      if (schema[keyword] !== undefined && typeof schema[keyword] !== "string") {
        throw new Error(`JSON Schema ${keyword} must be a string at ${path}.${keyword}.`);
      }
    }
    if (
      schema["enum"] !== undefined &&
      (!Array.isArray(schema["enum"]) || schema["enum"].length === 0)
    ) {
      throw new Error(`JSON Schema enum must be a non-empty array at ${path}.enum.`);
    }
    for (const keyword of ["required"] as const) {
      const entries = schema[keyword];
      if (
        entries !== undefined &&
        (!Array.isArray(entries) ||
          entries.some((entry) => typeof entry !== "string") ||
          new Set(entries).size !== entries.length)
      ) {
        throw new Error(
          `JSON Schema ${keyword} must contain unique strings at ${path}.${keyword}.`,
        );
      }
    }
    for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"] as const) {
      const entries = schema[keyword];
      if (entries === undefined) continue;
      if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error(`JSON Schema ${keyword} must be a non-empty array at ${path}.${keyword}.`);
      }
      entries.forEach((entry, index) =>
        assertValidJsonSchema(entry, `${path}.${keyword}[${index}]`, ancestors),
      );
    }
    for (const keyword of [
      "not",
      "if",
      "then",
      "else",
      "additionalProperties",
      "unevaluatedProperties",
      "propertyNames",
      "items",
      "additionalItems",
      "unevaluatedItems",
      "contains",
    ] as const) {
      const entry = schema[keyword];
      if (entry === undefined) continue;
      if (keyword === "items" && Array.isArray(entry)) {
        entry.forEach((item, index) =>
          assertValidJsonSchema(item, `${path}.items[${index}]`, ancestors),
        );
      } else {
        assertValidJsonSchema(entry, `${path}.${keyword}`, ancestors);
      }
    }
    for (const keyword of [
      "properties",
      "patternProperties",
      "$defs",
      "definitions",
      "dependentSchemas",
    ] as const) {
      const entries = schema[keyword];
      if (entries === undefined) continue;
      if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
        throw new Error(`JSON Schema ${keyword} must be an object at ${path}.${keyword}.`);
      }
      for (const [key, entry] of Object.entries(entries)) {
        assertValidJsonSchema(entry, `${path}.${keyword}.${key}`, ancestors);
      }
    }
    for (const keyword of [
      "minProperties",
      "maxProperties",
      "minItems",
      "maxItems",
      "minContains",
      "maxContains",
      "minLength",
      "maxLength",
    ] as const) {
      const entry = schema[keyword];
      if (entry !== undefined && (!Number.isSafeInteger(entry) || (entry as number) < 0)) {
        throw new Error(
          `JSON Schema ${keyword} must be a non-negative integer at ${path}.${keyword}.`,
        );
      }
    }
    for (const keyword of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
      const entry = schema[keyword];
      if (entry !== undefined && (typeof entry !== "number" || !Number.isFinite(entry))) {
        throw new Error(`JSON Schema ${keyword} must be finite at ${path}.${keyword}.`);
      }
    }
    if (
      schema["multipleOf"] !== undefined &&
      (typeof schema["multipleOf"] !== "number" ||
        !Number.isFinite(schema["multipleOf"]) ||
        schema["multipleOf"] <= 0)
    ) {
      throw new Error(`JSON Schema multipleOf must be positive at ${path}.multipleOf.`);
    }
    if (schema["pattern"] !== undefined) {
      if (typeof schema["pattern"] !== "string") {
        throw new Error(`JSON Schema pattern must be a string at ${path}.pattern.`);
      }
      try {
        new RegExp(schema["pattern"], "u");
      } catch {
        throw new Error(`JSON Schema pattern is invalid at ${path}.pattern.`);
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

function validateExtensionEnvironment(
  resources: ReadonlyMap<string, IndexedResource>,
  host: PragmaCompileHost,
): PragmaDiagnostic[] {
  const diagnostics: PragmaDiagnostic[] = [];
  const actions = host.actions ?? new FlowActionRegistry();
  const contextPolicies = host.contextPolicies ?? new ContextPolicyRegistry();
  const toolAdapters = host.toolAdapters ?? new ToolAdapterRegistry();
  const check = (
    indexed: IndexedResource,
    code: string,
    path: (string | number)[],
    run: () => void,
  ) => {
    try {
      run();
    } catch (error) {
      diagnostics.push({
        severity: "error",
        code,
        message: error instanceof Error ? error.message : String(error),
        source: indexed.source,
        path,
      });
    }
  };
  for (const indexed of resources.values()) {
    const resource = indexed.resource;
    if (resource.kind === "Expert") {
      if (resource.spec.plugins.length > 0 && host.plugins === undefined) {
        diagnostics.push({
          severity: "error",
          code: "environment.plugin_resolver_unavailable",
          message: "The host does not provide a Plugin resolver.",
          source: indexed.source,
          path: ["spec", "plugins"],
        });
      }
      resource.spec.tools.forEach((binding, index) => {
        check(
          indexed,
          "environment.tool_adapter_unavailable",
          ["spec", "tools", index, "adapter"],
          () => {
            toolAdapters.resolve(binding.adapter);
          },
        );
        if (binding.policy !== undefined) {
          check(
            indexed,
            "environment.context_policy_unavailable",
            ["spec", "tools", index, "policy", "context"],
            () => {
              contextPolicies.resolve(binding.policy!.context);
            },
          );
        }
      });
    } else if (resource.kind === "ExpertTeam") {
      check(
        indexed,
        "environment.context_policy_unavailable",
        ["spec", "delegation", "context"],
        () => {
          contextPolicies.resolve(resource.spec.delegation.context);
        },
      );
    } else if (resource.kind === "Flow") {
      Object.entries(resource.spec.graph.steps).forEach(([stepId, step]) => {
        if (step.action !== undefined) {
          check(
            indexed,
            "environment.flow_action_unavailable",
            ["spec", "graph", "steps", stepId, "action"],
            () => {
              actions.resolve(step.action!.ref);
            },
          );
        }
        if (step.context !== undefined) {
          check(
            indexed,
            "environment.context_policy_unavailable",
            ["spec", "graph", "steps", stepId, "context"],
            () => {
              contextPolicies.resolve(step.context!);
            },
          );
        }
      });
    }
  }
  return diagnostics;
}

function validateFlowGraph(
  indexed: IndexedResource,
  resources: ReadonlyMap<string, IndexedResource>,
): PragmaDiagnostic[] {
  const resource = indexed.resource as PragmaFlowResource;
  return [
    ...analyzePragmaFlowGraph(resource).issues.map((issue) => ({
      severity: "error" as const,
      code: issue.code,
      message: issue.message,
      source: indexed.source,
      path: [...issue.path],
    })),
    ...invalidFlowExpressions(resource.spec).map((path) => ({
      severity: "error" as const,
      code: "flow.expression.invalid",
      message:
        "Use $flow.input, $node.output, $state paths, or {{ ... }} interpolation; ${...} is not supported.",
      source: indexed.source,
      path,
    })),
    ...validatePragmaFlowDataContracts(resource, {
      resolveResource: (ref) => resources.get(ref)?.resource,
    }).map((issue) => ({
      severity: "error" as const,
      code: issue.code,
      message: issue.message,
      source: indexed.source,
      path: [...issue.path],
    })),
  ];
}

function invalidFlowExpressions(
  value: unknown,
  path: (string | number)[] = ["spec"],
): (string | number)[][] {
  if (typeof value === "string") return value.includes("${") ? [path] : [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => invalidFlowExpressions(entry, [...path, index]));
  }
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    if (key === "prompt" && typeof entry === "object" && entry !== null && "segments" in entry) {
      return [];
    }
    return invalidFlowExpressions(entry, [...path, key]);
  });
}

function validateAndReadLoopMembers(
  resource: PragmaFlowResource,
): Map<string, ReadonlySet<string>> {
  const analysis = analyzePragmaFlowGraph(resource);
  const issue = analysis.issues[0];
  if (issue !== undefined) throw new PragmaDslError(issue.message);
  return new Map(analysis.loopMembers);
}

interface ResourceDependency {
  readonly ref: string;
  readonly path: readonly (string | number)[];
}

interface ResourceDependencyEdge extends ResourceDependency {
  readonly target: string;
}

interface ResourceCycle {
  readonly refs: readonly string[];
  readonly sourceRef: string;
  readonly path: readonly (string | number)[];
}

function findResourceCycles(
  nodes: ReadonlySet<string>,
  edges: ReadonlyMap<string, readonly ResourceDependencyEdge[]>,
): readonly ResourceCycle[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles: ResourceCycle[] = [];

  const visit = (node: string): void => {
    visiting.add(node);
    stack.push(node);
    for (const edge of edges.get(node) ?? []) {
      if (!nodes.has(edge.target)) continue;
      if (!visiting.has(edge.target) && !visited.has(edge.target)) {
        visit(edge.target);
        continue;
      }
      if (!visiting.has(edge.target)) continue;
      const cycleStart = stack.indexOf(edge.target);
      cycles.push({
        refs: [node, ...stack.slice(cycleStart)],
        sourceRef: node,
        path: edge.path,
      });
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };

  for (const node of [...nodes].sort()) {
    if (!visited.has(node)) visit(node);
  }
  return cycles;
}

function validateResourceCycles(
  resources: ReadonlyMap<string, IndexedResource>,
): PragmaDiagnostic[] {
  const edges = new Map<string, readonly ResourceDependencyEdge[]>();
  for (const [key, indexed] of resources) {
    const dependencies = new Map<string, ResourceDependencyEdge>();
    for (const dependency of resourceDependencyEntries(indexed.resource)) {
      const parsed = parsePragmaReference(dependency.ref);
      const target = `${parsed.kind}:${parsed.id}`;
      if (!resources.has(target) || dependencies.has(target)) continue;
      dependencies.set(target, { ...dependency, target });
    }
    edges.set(
      key,
      [...dependencies.values()].sort((left, right) => left.target.localeCompare(right.target)),
    );
  }
  return findResourceCycles(new Set(resources.keys()), edges).map((cycle) => {
    const source = resources.get(cycle.sourceRef);
    return {
      severity: "error",
      code: "resource.cycle",
      message: `Pragma resource definitions must form an acyclic dependency graph: ${cycle.refs.join(" -> ")}.`,
      resourceRef: cycle.sourceRef as PragmaSemanticResourceRef,
      source: source?.source,
      path: [...cycle.path],
    };
  });
}

function resourceDependencies(resource: PragmaResource): string[] {
  return resourceDependencyEntries(resource).map((dependency) => dependency.ref);
}

function resourceDependencyEntries(resource: PragmaResource): ResourceDependency[] {
  if (resource.kind === "Expert") {
    return [
      ...(resource.spec.runtime === undefined
        ? []
        : [{ ref: resource.spec.runtime.ref, path: ["spec", "runtime", "ref"] }]),
      ...resource.spec.capabilities.map((binding, index) => ({
        ref: binding.ref,
        path: ["spec", "capabilities", index, "ref"],
      })),
      ...resource.spec.contextStores.map((binding, index) => ({
        ref: binding.ref,
        path: ["spec", "contextStores", index, "ref"],
      })),
      ...resource.spec.tools.flatMap((binding, index) => [
        ...(binding.target === undefined
          ? binding.targets!.map((target, targetIndex) => ({
              ref: target.ref,
              path: ["spec", "tools", index, "targets", targetIndex, "ref"],
            }))
          : [
              {
                ref: binding.target.ref,
                path: ["spec", "tools", index, "target", "ref"],
              },
            ]),
        ...Object.entries(binding.policy?.runtimes ?? {}).map(([expertId, ref]) => ({
          ref,
          path: ["spec", "tools", index, "policy", "runtimes", expertId],
        })),
      ]),
    ];
  }
  if (resource.kind === "ExpertTeam") {
    return [
      { ref: resource.spec.coordinator.ref, path: ["spec", "coordinator", "ref"] },
      ...resource.spec.members.map((member, index) => ({
        ref: member.ref,
        path: ["spec", "members", index, "ref"],
      })),
      ...resource.spec.contextStores.map((binding, index) => ({
        ref: binding.ref,
        path: ["spec", "contextStores", index, "ref"],
      })),
      ...Object.entries(resource.spec.delegation.runtimes).map(([expertId, ref]) => ({
        ref,
        path: ["spec", "delegation", "runtimes", expertId],
      })),
    ];
  }
  if (resource.kind === "Flow") {
    return Object.entries(resource.spec.graph.steps).flatMap(([stepId, step]) => {
      const target =
        step.expert === undefined
          ? step.team === undefined
            ? step.flow === undefined
              ? undefined
              : { ref: step.flow.ref, field: "flow" }
            : { ref: step.team.ref, field: "team" }
          : { ref: step.expert.ref, field: "expert" };
      return [
        ...(target === undefined
          ? []
          : [
              {
                ref: target.ref,
                path: ["spec", "graph", "steps", stepId, target.field, "ref"],
              },
            ]),
        ...(step.runtime === undefined
          ? []
          : [
              {
                ref: step.runtime.ref,
                path: ["spec", "graph", "steps", stepId, "runtime", "ref"],
              },
            ]),
        ...Object.entries(step.runtimes ?? {}).map(([expertId, ref]) => ({
          ref,
          path: ["spec", "graph", "steps", stepId, "runtimes", expertId],
        })),
      ];
    });
  }
  if (resource.kind === "Automation") {
    return [
      {
        ref: resource.spec.route.executor.ref,
        path: ["spec", "route", "executor", "ref"],
      },
    ];
  }
  if (resource.kind === "Evaluation") {
    if (!("target" in resource.spec) || resource.spec.method.type !== "flow-run-dry") return [];
    return [
      {
        ref: resource.spec.target.ref,
        path: ["spec", "target", "ref"],
      },
    ];
  }
  return [];
}

function collectLockedDependencies(
  root: IndexedResource,
  resources: ReadonlyMap<string, IndexedResource>,
): LockedResourceRef[] {
  const result = new Map<string, LockedResourceRef>();
  const visit = (indexed: IndexedResource): void => {
    for (const ref of resourceDependencies(indexed.resource)) {
      const parsed = parsePragmaReference(ref);
      const dependency = resources.get(`${parsed.kind}:${parsed.id}`);
      if (dependency === undefined || result.has(canonicalRef(dependency.resource))) continue;
      result.set(canonicalRef(dependency.resource), {
        ref: canonicalRef(dependency.resource),
        contentHash: dependency.contentHash,
        source: dependency.source,
      });
      visit(dependency);
    }
  };
  visit(root);
  return [...result.values()].sort((left, right) => left.ref.localeCompare(right.ref));
}

function filterMcpContribution(
  contribution: IExpertAgentMcpConfig,
  allowed: ReadonlySet<string>,
  resource: PragmaExpertResource,
): IExpertAgentMcpConfig {
  return {
    mcpServers: Object.fromEntries(
      Object.entries(contribution.mcpServers).map(([key, server]) => [
        key,
        {
          ...server,
          allowTools: [...allowed],
          toolApprovals: Object.fromEntries(
            [...allowed].map((toolName) => [
              toolName,
              mergeExpertAgentToolApprovals(server.toolApprovals?.[toolName], {
                mode:
                  resource.spec.toolApprovals[
                    `mcp_${key}_${sanitizeExecutionToolName(toolName)}`
                  ] ??
                  resource.spec.toolApprovals[toolName] ??
                  "ask",
              })!,
            ]),
          ),
        },
      ]),
    ),
  };
}

function mergeSkills(
  configs: readonly IExpertAgentSkillsConfig[],
): IExpertAgentSkillsConfig | undefined {
  const skills = configs.flatMap((config) => config.skills);
  return skills.length === 0 ? undefined : { skills };
}

function mergeMcp(configs: readonly IExpertAgentMcpConfig[]): IExpertAgentMcpConfig | undefined {
  const servers: IExpertAgentMcpConfig["mcpServers"] = {};
  for (const config of configs) {
    for (const [key, server] of Object.entries(config.mcpServers)) {
      if (servers[key] !== undefined) throw new PragmaDslError(`Duplicate MCP server key: ${key}`);
      servers[key] = server;
    }
  }
  return Object.keys(servers).length === 0 ? undefined : { mcpServers: servers };
}

function createAdapterHost(
  host: PragmaCompileHost,
  artifacts: ReadonlyMap<string, string>,
  artifactsAreImmutable: boolean,
) {
  const external = host.adapterHost;
  const root = resolve(host.projectRoot ?? external?.projectRoot ?? host.workspace);
  return {
    environmentId: host.environmentId ?? external?.environmentId ?? "default",
    projectRoot: root,
    async resolveBinding(
      ref: Parameters<NonNullable<PragmaCompileHost["adapterHost"]>["resolveBinding"]>[0],
    ) {
      return await external?.resolveBinding(ref);
    },
    async resolveArtifact(
      source: Parameters<NonNullable<PragmaCompileHost["adapterHost"]>["resolveArtifact"]>[0],
    ) {
      if (source.type !== "project") {
        if (external === undefined) {
          throw new Error(`No artifact resolver configured for: ${source.uri}`);
        }
        return await external.resolveArtifact(source);
      }
      const canonicalRoot = await realpath(root);
      const path = await realpath(resolve(root, source.path));
      const child = relative(canonicalRoot, path);
      if (child.startsWith("..") || isAbsolute(child)) {
        throw new Error(`Artifact source escapes the project root: ${source.path}`);
      }
      const info = await lstat(path);
      const contentHash = artifacts.get(source.path);
      if (contentHash === undefined) {
        throw new Error(`Project artifact was not indexed: ${source.path}`);
      }
      return {
        source,
        path,
        contentHash,
        ...(artifactsAreImmutable ? { verified: true } : {}),
        ...(info.isFile() ? { text: await readFile(path, "utf8") } : {}),
      };
    },
    async resolveSecret(ref: string) {
      return await external?.resolveSecret(ref);
    },
  };
}

interface PortableBundleRequirementDraft {
  readonly requirement: PragmaBundleRequirement;
  readonly originalBindingRef?: string | undefined;
}

function portableizeBundleResources(
  resources: ReadonlyMap<string, IndexedResource>,
  configuredAdapters: PragmaResourceAdapterRegistry | undefined,
): {
  readonly resources: readonly PragmaResource[];
  readonly requirements: readonly PortableBundleRequirementDraft[];
} {
  const adapters = configuredAdapters ?? createDefaultPragmaResourceAdapterRegistry();
  const requirements: PortableBundleRequirementDraft[] = [];
  const output = [...resources.values()]
    .toSorted((left, right) =>
      canonicalRef(left.resource).localeCompare(canonicalRef(right.resource)),
    )
    .map((indexed) => {
      const resource = structuredClone(indexed.resource);
      const ownerRef = canonicalRef(resource);
      const spec = resource.spec as unknown as Record<string, unknown>;
      if (isDeclarativeResource(resource)) {
        const binding = typeof spec["binding"] === "string" ? spec["binding"] : undefined;
        if (binding !== undefined) {
          const path = ["spec", "binding"] as const;
          const requirement = createBundleRequirement({
            kind: "binding",
            ownerRef,
            path,
            contract: resource.spec.adapter,
            name: `${resource.metadata.name} binding`,
            hints: { adapter: resource.spec.adapter },
          });
          spec["binding"] = bundleBindingSlot(requirement.id);
          requirements.push({ requirement, originalBindingRef: binding });
        }
        for (const source of adapters.artifactSources(resource)) {
          if (source.type === "project") continue;
          requirements.push({
            requirement: createBundleRequirement({
              kind: "external-artifact",
              ownerRef,
              path: ["spec", "config"],
              contract: source.integrity,
              name: `${resource.metadata.name} external artifact`,
              hints: { uri: source.uri, integrity: source.integrity },
            }),
          });
        }
        if (resource.kind === "RuntimeProfile") {
          const config = spec["config"] as Record<string, unknown>;
          requirements.push({
            requirement: createBundleRequirement({
              kind: "runtime",
              ownerRef,
              path: ["spec", "config", "runtimeId"],
              contract: "pragma.runtime@v1",
              name: `${resource.metadata.name} runtime`,
              hints: { runtimeId: config["runtimeId"] },
            }),
          });
        }
      }
      if (resource.kind === "Expert") {
        const plugins = spec["plugins"] as Record<string, unknown>[];
        for (const [pluginIndex, plugin] of plugins.entries()) {
          const pluginRef = plugin["ref"] as string;
          requirements.push({
            requirement: createBundleRequirement({
              kind: "plugin",
              ownerRef,
              path: ["spec", "plugins", pluginIndex],
              contract: pluginRef,
              name: `${resource.metadata.name} plugin ${pluginRef}`,
              hints: { ref: pluginRef },
            }),
          });
          const secretBindings = plugin["secretBindings"] as Record<string, string> | undefined;
          if (secretBindings === undefined) continue;
          for (const [secretName, originalBindingRef] of Object.entries(secretBindings)) {
            const requirement = createBundleRequirement({
              kind: "secret",
              ownerRef,
              path: ["spec", "plugins", pluginIndex, "secretBindings", secretName],
              contract: `${pluginRef}:secret:${secretName}`,
              name: `${resource.metadata.name} secret ${secretName}`,
              hints: { plugin: pluginRef, secretName },
            });
            secretBindings[secretName] = bundleBindingSlot(requirement.id);
            requirements.push({ requirement, originalBindingRef });
          }
        }
      }
      return PragmaResourceSchema.parse(resource);
    });
  return { resources: output, requirements };
}

function createBundleRequirement(input: {
  readonly kind: PragmaBundleRequirement["kind"];
  readonly ownerRef: PragmaSemanticResourceRef;
  readonly path: readonly (string | number)[];
  readonly contract: string;
  readonly name: string;
  readonly hints: Readonly<Record<string, unknown>>;
}): PragmaBundleRequirement {
  const id = `req-${sha256(stableStringify(input)).slice(0, 24)}`;
  return {
    id,
    kind: input.kind,
    ownerRef: input.ownerRef,
    path: [...input.path],
    contract: input.contract,
    required: true,
    name: input.name,
    hints: { ...input.hints },
  };
}

function bundleBindingSlot(requirementId: string): `binding:${string}` {
  return `${PRAGMA_BUNDLE_BINDING_PREFIX}${requirementId}`;
}

function requirementLocationKey(
  kind: PragmaBundleRequirement["kind"],
  ownerRef: string,
  path: readonly (string | number)[],
): string {
  return stableStringify([kind, ownerRef, path]);
}

function valueAtPath(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function findBundleBindingSlots(value: unknown): readonly {
  readonly value: string;
  readonly requirementId: string;
  readonly path: readonly (string | number)[];
}[] {
  const slots: {
    value: string;
    requirementId: string;
    path: (string | number)[];
  }[] = [];
  const visit = (current: unknown, path: (string | number)[]): void => {
    if (typeof current === "string" && current.startsWith(`${PRAGMA_BUNDLE_BINDING_PREFIX}req-`)) {
      slots.push({
        value: current,
        requirementId: current.slice(PRAGMA_BUNDLE_BINDING_PREFIX.length),
        path,
      });
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, [...path, index]));
      return;
    }
    if (typeof current !== "object" || current === null) return;
    for (const [key, entry] of Object.entries(current)) visit(entry, [...path, key]);
  };
  visit(value, []);
  return slots;
}

async function collectResourceArtifacts(
  resources: ReadonlyMap<string, IndexedResource>,
  projectRoot: string,
  adapters: PragmaResourceAdapterRegistry,
): Promise<ReadonlyMap<string, string>> {
  const artifacts = new Map<string, string>();
  for (const indexed of resources.values()) {
    if (!isDeclarativeResource(indexed.resource)) continue;
    for (const source of adapters.artifactSources(indexed.resource)) {
      if (source.type === "project") {
        const absolute = await assertPathInsideRoot(projectRoot, resolve(projectRoot, source.path));
        artifacts.set(source.path, await hashArtifactPath(absolute));
      } else {
        artifacts.set(source.uri, source.integrity.slice("sha256:".length));
      }
    }
  }
  return artifacts;
}

async function collectSelectedBundleArtifacts(
  resources: readonly PragmaResource[],
  projectRoot: string,
  adapters: PragmaResourceAdapterRegistry,
  files: Map<string, Uint8Array>,
): Promise<readonly { readonly source: string; readonly contentHash: string }[]> {
  const artifacts = new Map<string, string>();
  for (const resource of resources) {
    if (!isDeclarativeResource(resource)) continue;
    for (const source of adapters.artifactSources(resource)) {
      if (source.type === "project") {
        const absolute = await assertPathInsideRoot(projectRoot, resolve(projectRoot, source.path));
        artifacts.set(source.path, await hashArtifactPath(absolute));
        await collectArtifactFiles(absolute, source.path, projectRoot, files);
      } else {
        artifacts.set(source.uri, source.integrity.slice("sha256:".length));
      }
    }
  }
  return [...artifacts]
    .map(([source, contentHash]) => ({ source, contentHash }))
    .toSorted((left, right) => left.source.localeCompare(right.source));
}

async function collectArtifactFiles(
  absolute: string,
  logicalPath: string,
  projectRoot: string,
  files: Map<string, Uint8Array>,
): Promise<void> {
  const safePath = await assertPathInsideRoot(projectRoot, absolute);
  const info = await lstat(safePath);
  if (info.isFile()) {
    const bundlePath = `project/${logicalPath.replaceAll("\\", "/")}`;
    if (PRAGMA_BUNDLE_RESERVED_PROJECT_PATHS.has(bundlePath)) {
      throw new PragmaDslError(
        `Project artifact collides with a generated bundle file: ${logicalPath}.`,
      );
    }
    files.set(bundlePath, new Uint8Array(await readFile(safePath)));
    return;
  }
  if (!info.isDirectory()) throw new Error(`Unsupported project artifact: ${logicalPath}`);
  for (const child of (await readdir(safePath)).toSorted()) {
    await collectArtifactFiles(
      resolve(safePath, child),
      `${logicalPath.replace(/\/$/, "")}/${child}`,
      projectRoot,
      files,
    );
  }
}

async function assertPathInsideRoot(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const canonicalPath = await realpath(path);
  const child = relative(canonicalRoot, canonicalPath);
  if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) return canonicalPath;
  throw new Error(`Project artifact escapes the project root: ${path}`);
}

async function verifyRuntimeEnvironment(
  inspection: PragmaResourceInspection<PragmaRuntimeProfileContribution>,
  runtimes: PragmaCompileHost["runtimes"],
  requireRegistry: boolean,
): Promise<PragmaResourceInspection<PragmaRuntimeProfileContribution>> {
  if (inspection.health.status !== "ready" || inspection.contribution === undefined) {
    return inspection;
  }
  try {
    if (runtimes === undefined) {
      if (!requireRegistry) return inspection;
      throw new Error("A Runtime registry is required to verify RuntimeProfile availability.");
    }
    const resolvedRuntime = await runtimes.bind({
      runtimeId: inspection.contribution.runtimeId,
    });
    const runtime = resolvedRuntime.adapter;
    const canUse = await runtime.canUse();
    if (!canUse.usable) {
      throw new Error(canUse.reason ?? `Runtime is unavailable: ${runtime.descriptor.id}`);
    }
    const models =
      runtime.listModels === undefined
        ? undefined
        : [...(await runtime.listModels())].sort((left, right) => left.id.localeCompare(right.id));
    const selection = inspection.contribution.models?.default;
    const defaultModel = selection?.model.modelId;
    const defaultProvider = selection?.model.providerId;
    const defaultThinkingLevel = selection?.thinkingLevel;
    if (defaultModel !== undefined && models !== undefined) {
      const selectedModel = models.find(
        (model) =>
          model.id === defaultModel &&
          (defaultProvider === undefined || model.provider.id === defaultProvider),
      );
      if (selectedModel === undefined) {
        throw new Error(
          `Runtime model is unavailable for ${runtime.descriptor.id}: ${defaultModel}`,
        );
      }
      if (
        defaultThinkingLevel !== undefined &&
        !selectedModel.thinking?.supportedLevels.some(
          (level) => level.value === defaultThinkingLevel,
        )
      ) {
        throw new Error(
          `Runtime thinking level is unavailable for ${runtime.descriptor.id}/${defaultModel}: ${defaultThinkingLevel}`,
        );
      }
    } else if (defaultThinkingLevel !== undefined) {
      throw new Error(
        `Runtime thinking level requires a discoverable model for ${runtime.descriptor.id}.`,
      );
    }
    return {
      ...inspection,
      health: {
        ...inspection.health,
        verificationFingerprint: sha256(
          stableStringify({
            adapter: inspection.health.verificationFingerprint,
            runtime: runtime.descriptor,
            availability: canUse,
            models,
          }),
        ),
      },
    };
  } catch (error) {
    return {
      ref: inspection.ref,
      health: {
        ...inspection.health,
        status: "needs_attention",
        verificationFingerprint: undefined,
        issues: [
          {
            severity: "error",
            code: "environment.runtime_unavailable",
            message: error instanceof Error ? error.message : String(error),
            path: ["spec", "config", "runtimeId"],
          },
        ],
      },
    };
  }
}

async function hashArtifactPath(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isFile()) return sha256(await readFile(path));
  if (!info.isDirectory()) throw new Error(`Artifact is not a regular file or directory: ${path}`);
  const entries = await readdir(path, { withFileTypes: true });
  const unsupported = entries.find((entry) => !entry.isFile() && !entry.isDirectory());
  if (unsupported !== undefined) {
    throw new Error(`Artifact contains a non-regular entry: ${resolve(path, unsupported.name)}`);
  }
  const hashes = await Promise.all(
    entries.map(async (entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
      hash: await hashArtifactPath(resolve(path, entry.name)),
    })),
  );
  return sha256(
    stableStringify(hashes.toSorted((left, right) => left.name.localeCompare(right.name))),
  );
}

async function resolveRootRuntime(
  resource: PragmaResource,
  resources: ReadonlyMap<string, IndexedResource>,
  resolveRuntime: (ref: string) => Promise<PragmaRuntimeProfileContribution>,
  host: PragmaCompileHost,
): Promise<string | undefined> {
  if (host.rootExecutionOverride !== undefined) return host.rootExecutionOverride.runtimeId;
  if (resource.kind === "Expert") {
    return resource.spec.runtime === undefined
      ? await host.runtimes?.getDefaultRuntimeId()
      : (await resolveRuntime(resource.spec.runtime.ref)).runtimeId;
  }
  if (resource.kind === "ExpertTeam") {
    const coordinator = resources.get(resource.spec.coordinator.ref)?.resource;
    if (coordinator?.kind !== "Expert") {
      throw new PragmaDslError(
        `ExpertTeam coordinator not found: ${resource.spec.coordinator.ref}`,
      );
    }
    return coordinator.spec.runtime === undefined
      ? await host.runtimes?.getDefaultRuntimeId()
      : (await resolveRuntime(coordinator.spec.runtime.ref)).runtimeId;
  }
  return await host.runtimes?.getDefaultRuntimeId();
}

async function resolveRootModelSelection(
  resource: PragmaResource,
  resources: ReadonlyMap<string, IndexedResource>,
  resolveRuntime: (ref: string) => Promise<PragmaRuntimeProfileContribution>,
  host: PragmaCompileHost,
) {
  if (host.rootModelSelectionOverride !== undefined) {
    return host.rootModelSelectionOverride;
  }
  if (host.rootExecutionOverride !== undefined) {
    return host.rootExecutionOverride.modelSelection;
  }
  if (resource.kind === "Expert") {
    return resource.spec.runtime === undefined
      ? host.defaultModelSelection
      : (await resolveRuntime(resource.spec.runtime.ref)).models?.default;
  }
  if (resource.kind === "ExpertTeam") {
    const coordinator = resources.get(resource.spec.coordinator.ref)?.resource;
    if (coordinator?.kind !== "Expert") return undefined;
    return coordinator.spec.runtime === undefined
      ? host.defaultModelSelection
      : (await resolveRuntime(coordinator.spec.runtime.ref)).models?.default;
  }
  return undefined;
}

function isDeclarativeResource(resource: PragmaResource): resource is PragmaDeclarativeResource {
  return (
    resource.kind === "Capability" ||
    resource.kind === "ContextStore" ||
    resource.kind === "RuntimeProfile" ||
    resource.kind === "Automation"
  );
}

function isInvocableResource(
  resource: PragmaResource,
): resource is Exclude<PragmaResource, PragmaDeclarativeResource> {
  return !isDeclarativeResource(resource);
}

function isPlainExpert(value: InvocableResource): value is Expert {
  return !("kind" in value);
}

function requireStepReference(
  references: ReadonlyMap<string, FlowStepReference>,
  id: string,
): FlowStepReference {
  const reference = references.get(id);
  if (reference === undefined) throw new PragmaDslError(`Unknown Flow step: ${id}`);
  return reference;
}

function canonicalRef(resource: PragmaResource): PragmaSemanticResourceRef {
  return canonicalPragmaResourceRef(resource);
}
