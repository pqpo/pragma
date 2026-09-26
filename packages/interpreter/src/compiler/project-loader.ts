import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import {
  PRAGMA_DSL_WRITE_API_VERSION,
  PragmaDiagnosticSchema,
  PragmaForwardCompatibleBundleSchema,
  PragmaForwardCompatibleResourceSchema,
  PragmaLockSchema,
  inspectPragmaUnknownFields,
  type PragmaArtifactSource,
  type PragmaDiagnostic,
  type PragmaLock,
  type PragmaResource,
} from "../ast/pragma-dsl.schema.ts";
import {
  normalizePragmaResourceName,
  pragmaResourceDirectory,
  pragmaResourceFileName,
} from "../ast/resource-identity.ts";
import {
  createDefaultPragmaResourceAdapterRegistry,
  type PragmaResourceAdapterRegistry,
} from "../runtime/resource-adapters.ts";
import { sha256, stableStringify } from "./compiler-hash.ts";
import {
  PRAGMA_COMPILER_DIRECT_READ_VERSIONS,
  PRAGMA_COMPILER_UPGRADE_FROM_VERSIONS,
  PRAGMA_COMPILER_WRITE_VERSION,
  isPragmaCompilerVersionDirectlyReadable,
  isPragmaCompilerVersionUpgradeable,
} from "../ast/compiler-compatibility.ts";
import {
  decodePragmaBundle,
  PragmaBundleFormatError,
  type DecodedPragmaBundle,
} from "../bundle/pragma-bundle-codec.ts";
import {
  type DumpOptions,
  type DumpedFiles,
  type ExportPragmaBundleOptions,
  type IndexedResource,
  type LoadPragmaProjectOptions,
  type LoadPragmaProjectSource,
  type PragmaBlueprintCacheObservation,
  type PragmaBlueprintCacheStore,
  type PragmaBundleExportResult,
  PragmaDslError,
  type PragmaProject,
} from "./project-contracts.ts";
import { formatPragmaYaml, parsePragmaYaml } from "./project-yaml.ts";
import {
  PragmaBundleProjectLockIdentitySchema,
  PragmaProjectImpl,
  provenance,
} from "./project-instance.ts";
import { canonicalRef, isDeclarativeResource } from "./project-dependencies.ts";
import { collectResourceArtifacts } from "./project-bundle.ts";
import { hashArtifactPath } from "./project-environment.ts";

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
          resource: PragmaForwardCompatibleResourceSchema,
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
      const projectRoot = resolve(temporaryRoot, "project");
      const portableLock = PragmaBundleProjectLockIdentitySchema.parse(
        parsePragmaYaml(await readFile(resolve(dirname(entryFile), "pragma.lock.yaml"), "utf8")),
      );
      if (
        portableLock.compilerVersion !== decoded.manifest.project.compilerVersion ||
        portableLock.projectFingerprint !== decoded.manifest.project.projectFingerprint
      ) {
        throw new PragmaBundleFormatError(
          "manifest.fingerprint_invalid",
          "The bundle project identity does not match its portable project lock.",
        );
      }
      const directlyReadable = isPragmaCompilerVersionDirectlyReadable(
        decoded.manifest.project.compilerVersion,
      );
      const project = directlyReadable
        ? await loadPragmaYamlProject(entryFile, {
            ...options,
            rootDir: projectRoot,
            requireLock: true,
            revisionCompilerVersion: decoded.manifest.project.compilerVersion,
            sourceIdentity: decoded.manifest.project.projectFingerprint,
          })
        : await loadMigratedBundleProject({
            decoded,
            entryFile,
            projectRoot,
            options,
          });
      if (
        directlyReadable &&
        project.createLock().projectFingerprint !== decoded.manifest.project.projectFingerprint
      ) {
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

async function loadMigratedBundleProject(input: {
  readonly decoded: DecodedPragmaBundle;
  readonly entryFile: string;
  readonly projectRoot: string;
  readonly options: LoadPragmaProjectOptions;
}): Promise<PragmaProjectImpl> {
  const sourceCompilerVersion = input.decoded.manifest.project.compilerVersion;
  if (!isPragmaCompilerVersionUpgradeable(sourceCompilerVersion)) {
    throw new PragmaBundleFormatError(
      "manifest.invalid",
      `Bundle compiler version is not supported: ${sourceCompilerVersion}.`,
    );
  }
  const projectFiles = new Map<string, string>();
  for (const [path, contents] of input.decoded.files) {
    if (!path.startsWith("project/")) continue;
    projectFiles.set(path.slice("project/".length), new TextDecoder().decode(contents));
  }
  const { migratePragmaCompilerProjectToCurrent, PRAGMA_COMPILER_MIGRATION_CHAIN_VERSION } =
    await import("../compiler-migrations/index.ts");
  let migrated;
  try {
    migrated = migratePragmaCompilerProjectToCurrent({
      files: projectFiles,
      revisionCompilerVersion: sourceCompilerVersion,
    });
  } catch (error) {
    throw new PragmaBundleFormatError(
      "manifest.fingerprint_invalid",
      "The bundle portable project failed compiler migration validation.",
      { cause: error },
    );
  }

  const imports: string[] = [];
  for (const resource of migrated.resources) {
    const path = `${pragmaResourceDirectory(resource)}/${pragmaResourceFileName(resource)}`;
    if (migrated.artifacts.has(path)) {
      throw new PragmaBundleFormatError(
        "manifest.invalid",
        `Migrated bundle resource collides with a project artifact: ${path}.`,
      );
    }
    imports.push(`./${path}`);
    const destination = resolve(input.projectRoot, path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, formatPragmaYaml(resource), { mode: 0o600 });
  }
  await writeFile(
    input.entryFile,
    formatPragmaYaml({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Bundle",
      imports: imports.toSorted(),
      resources: [],
    }),
    { mode: 0o600 },
  );
  const staged = await loadPragmaYamlProject(input.entryFile, {
    ...input.options,
    rootDir: input.projectRoot,
    requireLock: false,
    revisionCompilerVersion: undefined,
    sourceIdentity: undefined,
  });
  await writeFile(
    resolve(dirname(input.entryFile), "pragma.lock.yaml"),
    formatPragmaYaml(staged.createLock()),
    { mode: 0o600 },
  );
  await staged.dispose();
  return await loadPragmaYamlProject(input.entryFile, {
    ...input.options,
    rootDir: input.projectRoot,
    requireLock: true,
    revisionCompilerVersion: PRAGMA_COMPILER_WRITE_VERSION,
    sourceIdentity: sha256(
      stableStringify({
        sourceProjectFingerprint: input.decoded.manifest.project.projectFingerprint,
        sourceCompilerVersion,
        targetCompilerVersion: PRAGMA_COMPILER_WRITE_VERSION,
        migrationChainVersion: PRAGMA_COMPILER_MIGRATION_CHAIN_VERSION,
      }),
    ),
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

    const bundle = PragmaForwardCompatibleBundleSchema.safeParse(raw);
    if (bundle.success) {
      if (!allowBundle) {
        this.error("source.bundle", "A Bundle cannot be used as a structural include.", canonical);
        return;
      }
      this.reportUnknownFields(raw, "bundle", canonical);
      for (const imported of bundle.data.imports) {
        await this.loadFile(resolve(dirname(canonical), imported), true);
      }
      for (const resource of bundle.data.resources) this.addResource(resource, canonical);
      return;
    }

    const parsed = PragmaForwardCompatibleResourceSchema.safeParse(raw);
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
    this.reportUnknownFields(raw, "resource", canonical);
    this.addResource(parsed.data, canonical);
  }

  private reportUnknownFields(raw: unknown, kind: "resource" | "bundle", source: string): void {
    for (const issue of inspectPragmaUnknownFields(raw, kind)) {
      this.diagnostics.push(
        PragmaDiagnosticSchema.parse({
          severity: "warning",
          code: "schema.unknown_field",
          message: `Unknown ${PRAGMA_DSL_WRITE_API_VERSION} field is preserved but ignored: ${issue.key}.`,
          source,
          path: issue.path,
        }),
      );
    }
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
