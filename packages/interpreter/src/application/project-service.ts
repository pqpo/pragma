import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  createPragmaLogger,
  type PragmaLogger,
  type PragmaLoggerProvider,
  type RuntimeResolver,
} from "@pragma/core";

import {
  PragmaDiagnosticSchema,
  PragmaResourceSchema,
  type PragmaDiagnostic,
  type PragmaLock,
  type PragmaResource,
  type PragmaResourceRef,
} from "../ast/pragma-dsl.schema.ts";
import {
  PragmaProjectChangeSetSchema,
  type PragmaProjectChangeSetInput,
} from "../ast/project-change-set.schema.ts";
import {
  canonicalPragmaResourceRef,
  normalizePragmaResourceName,
  pragmaResourceDirectory,
  pragmaResourceFileName,
} from "../ast/resource-identity.ts";
import {
  formatPragmaYaml,
  loadPragmaProject,
  type CompiledResource,
  type PragmaBlueprintCacheStore,
  type PragmaCompileOptions,
  type PragmaEnvironmentInspection,
  type PragmaProject,
} from "../compiler/pragma-project.ts";
import type { PragmaCompilerProjectMigrationResult } from "../compiler-migrations/types.ts";
import type { InvocableResource } from "../runtime/registries.ts";
import type { PragmaPluginResolver } from "../runtime/registries.ts";
import {
  createDefaultPragmaResourceAdapterRegistry,
  type PragmaAdapterHost,
  type PragmaResourceAdapterRegistry,
} from "../runtime/resource-adapters.ts";

export interface PragmaProjectRevisionLocation {
  readonly projectId: string;
  readonly revision: number;
  readonly rootDir: string;
  readonly entryFile: string;
  readonly snapshotHash?: string | undefined;
  readonly projectFingerprint?: string | undefined;
  readonly compilerVersion?: string | undefined;
  readonly updatedAt?: string | undefined;
}

export interface PragmaProjectSourceRepository {
  readonly getHead: (projectId: string) => Promise<PragmaProjectRevisionLocation | undefined>;
  readonly getRevision: (
    projectId: string,
    revision: number,
  ) => Promise<PragmaProjectRevisionLocation | undefined>;
  readonly readFiles: (
    location: PragmaProjectRevisionLocation,
  ) => Promise<ReadonlyMap<string, string>>;
  readonly withCheckout?: <T>(
    location: PragmaProjectRevisionLocation,
    operation: (location: PragmaProjectRevisionLocation) => Promise<T>,
  ) => Promise<T>;
  readonly commit: (input: {
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly files: ReadonlyMap<string, string>;
    readonly forceRevision?: boolean | undefined;
  }) => Promise<PragmaProjectRevisionLocation>;
}

export interface PragmaProjectSnapshot {
  readonly schemaVersion: "pragma.project-snapshot/v3";
  readonly projectId: string;
  readonly revision: number;
  readonly compilerVersion?: string | undefined;
  readonly resources: readonly PragmaResource[];
  readonly diagnostics: readonly PragmaDiagnostic[];
  readonly lock?: PragmaLock | undefined;
  readonly projectFingerprint?: string | undefined;
  readonly updatedAt?: string | undefined;
}

export interface PragmaProjectServiceOptions {
  readonly repository: PragmaProjectSourceRepository;
  readonly blueprintCache?: PragmaBlueprintCacheStore | undefined;
  readonly resourceAdapters?: PragmaResourceAdapterRegistry | undefined;
  readonly externalResourceRefs?: ReadonlySet<PragmaResourceRef> | undefined;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
}

export interface PragmaProjectChangeSetCandidate {
  readonly currentRevision: number;
  readonly resources: readonly PragmaResource[];
  readonly artifacts: ReadonlyMap<string, string>;
}

const PROJECT_CHANGE_SET_COMMIT_ATTEMPTS = 8;

export class PragmaProjectService {
  private readonly adapters: PragmaResourceAdapterRegistry;
  private readonly logger: PragmaLogger;
  private readonly openedProjects = new Map<string, Promise<PragmaProject>>();

  constructor(private readonly options: PragmaProjectServiceOptions) {
    this.adapters = options.resourceAdapters ?? createDefaultPragmaResourceAdapterRegistry();
    this.logger = createPragmaLogger(options.loggerProvider, {
      component: "interpreter.compiler",
    });
  }

  async get(projectId: string, revision?: number): Promise<PragmaProjectSnapshot> {
    const location =
      revision === undefined
        ? await this.options.repository.getHead(projectId)
        : await this.options.repository.getRevision(projectId, revision);
    if (location === undefined) {
      return {
        schemaVersion: "pragma.project-snapshot/v3",
        projectId,
        revision: 0,
        resources: [],
        diagnostics: [],
      };
    }
    return await this.withCheckout(location, async (checkedOut) => {
      const project = await this.openLocation(checkedOut, true);
      const diagnostics = await project.validate();
      let lock: PragmaLock | undefined;
      try {
        lock = await project.readLock();
      } catch {
        lock = undefined;
      }
      const lockValid = !diagnostics.some(
        (diagnostic) =>
          diagnostic.code.startsWith("lock.") || diagnostic.code.startsWith("compiler."),
      );
      const compilerVersion = lock?.compilerVersion ?? checkedOut.compilerVersion;
      return {
        schemaVersion: "pragma.project-snapshot/v3",
        projectId,
        revision: checkedOut.revision,
        ...(compilerVersion === undefined ? {} : { compilerVersion }),
        resources: project.listResources(),
        diagnostics,
        ...(lock === undefined ? {} : { lock }),
        ...(lock !== undefined && lockValid ? { projectFingerprint: lock.projectFingerprint } : {}),
        updatedAt: checkedOut.updatedAt,
      };
    });
  }

  async validate(input: {
    readonly resources: readonly PragmaResource[];
    readonly artifacts?: ReadonlyMap<string, string> | undefined;
    readonly host?: PragmaCompileOptions | undefined;
  }): Promise<readonly PragmaDiagnostic[]> {
    return await withStagedProject(
      input.resources,
      input.artifacts,
      this.adapters,
      this.options.externalResourceRefs,
      async (project) =>
        input.host === undefined
          ? await project.validate()
          : await project.validateEnvironment(input.host),
    );
  }

  async inspectEnvironment(input: {
    readonly resources: readonly PragmaResource[];
    readonly artifacts?: ReadonlyMap<string, string> | undefined;
    readonly host: PragmaCompileOptions;
  }): Promise<PragmaEnvironmentInspection> {
    return await withStagedProject(
      input.resources,
      input.artifacts,
      this.adapters,
      this.options.externalResourceRefs,
      async (project) => await project.inspectEnvironment(input.host),
    );
  }

  async validateChangeSet(input: {
    readonly projectId: string;
    readonly changeSet: PragmaProjectChangeSetInput;
    readonly host?: PragmaCompileOptions | undefined;
  }): Promise<readonly PragmaDiagnostic[]> {
    const candidate = await this.materializeChangeSet(input.projectId, input.changeSet);
    return await this.validate({
      resources: candidate.resources,
      artifacts: candidate.artifacts,
      host: input.host,
    });
  }

  async publish(input: {
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly resources: readonly PragmaResource[];
    readonly artifacts?: ReadonlyMap<string, string> | undefined;
    readonly forceRevision?: boolean | undefined;
  }): Promise<PragmaProjectSnapshot> {
    const head = await this.options.repository.getHead(input.projectId);
    const actualRevision = head?.revision ?? 0;
    if (actualRevision !== input.expectedRevision) {
      throw new PragmaProjectRevisionConflictError(
        input.expectedRevision,
        actualRevision,
        [],
        false,
      );
    }
    const resources = input.resources.map((resource) => PragmaResourceSchema.parse(resource));
    assertUniqueCanonicalRefs(resources);
    const files = await this.renderProjectFiles({ resources, artifacts: input.artifacts });
    await this.options.repository.commit({
      projectId: input.projectId,
      expectedRevision: input.expectedRevision,
      files,
      forceRevision: input.forceRevision,
    });
    return await this.get(input.projectId);
  }

  /**
   * Renders a validated, canonical Pragma project without committing it. Hosts use this when a
   * portable subset must be packaged while keeping DSL serialization and lock generation inside
   * the Interpreter boundary.
   */
  async renderProjectFiles(input: {
    readonly resources: readonly PragmaResource[];
    readonly artifacts?: ReadonlyMap<string, string> | undefined;
  }): Promise<ReadonlyMap<string, string>> {
    const resources = input.resources.map((resource) => PragmaResourceSchema.parse(resource));
    assertUniqueCanonicalRefs(resources);
    return await withStagedProject(
      resources,
      input.artifacts,
      this.adapters,
      this.options.externalResourceRefs,
      async (project) => {
        const diagnostics = await project.validate();
        const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
        if (errors.length > 0) throw new PragmaProjectValidationError(errors);
        const files = new Map(canonicalProjectFiles(project));
        for (const [path, contents] of input.artifacts ?? []) {
          assertArtifactPath(path);
          if (files.has(path))
            throw new Error(`Artifact collides with a Pragma source file: ${path}`);
          files.set(path, contents);
        }
        return files;
      },
    );
  }

  /**
   * Serializes the historically schema- and lock-validated output of the compiler migration chain.
   * Unlike publication, this does not apply current authoring diagnostics to a historical
   * revision. Hosts use the result only as a rebuildable derived view; it must never be committed
   * as a new revision.
   */
  async renderCompilerMigration(
    migration: PragmaCompilerProjectMigrationResult,
  ): Promise<ReadonlyMap<string, string>> {
    const resources = migration.resources.map((resource) => PragmaResourceSchema.parse(resource));
    assertUniqueCanonicalRefs(resources);
    return await withStagedProject(
      resources,
      migration.artifacts,
      this.adapters,
      this.options.externalResourceRefs,
      async (project) => {
        const files = new Map(canonicalProjectFiles(project));
        for (const [path, contents] of migration.artifacts) {
          assertArtifactPath(path);
          if (files.has(path)) {
            throw new Error(`Artifact collides with a Pragma source file: ${path}`);
          }
          files.set(path, contents);
        }
        return files;
      },
    );
  }

  async applyChangeSet(input: {
    readonly projectId: string;
    readonly changeSet: PragmaProjectChangeSetInput;
  }): Promise<PragmaProjectSnapshot> {
    for (let attempt = 0; attempt < PROJECT_CHANGE_SET_COMMIT_ATTEMPTS; attempt += 1) {
      const candidate = await this.materializeChangeSet(input.projectId, input.changeSet);
      try {
        return await this.publish({
          projectId: input.projectId,
          expectedRevision: candidate.currentRevision,
          resources: candidate.resources,
          artifacts: candidate.artifacts,
        });
      } catch (error) {
        if (
          !(error instanceof PragmaProjectRevisionConflictError) ||
          attempt === PROJECT_CHANGE_SET_COMMIT_ATTEMPTS - 1
        ) {
          if (
            error instanceof PragmaProjectRevisionConflictError &&
            attempt === PROJECT_CHANGE_SET_COMMIT_ATTEMPTS - 1
          ) {
            throw new PragmaProjectRevisionConflictError(
              input.changeSet.baseRevision,
              error.currentRevision,
              [],
              true,
            );
          }
          throw error;
        }
      }
    }
    throw new Error("Unreachable project change-set retry state.");
  }

  async compile<T extends InvocableResource>(input: {
    readonly projectId: string;
    readonly revision: number;
    readonly ref: PragmaResourceRef;
    readonly workspace: string;
    readonly pragmaHome?: string | undefined;
    readonly environmentId: string;
    readonly adapterHost: PragmaAdapterHost;
    readonly runtimes?: RuntimeResolver | undefined;
    readonly rootModelSelectionOverride?: PragmaCompileOptions["rootModelSelectionOverride"];
    readonly rootExecutionOverride?: PragmaCompileOptions["rootExecutionOverride"];
    readonly resolveExternalInvocable?: PragmaCompileOptions["resolveExternalInvocable"];
    readonly plugins?: PragmaPluginResolver | undefined;
  }): Promise<CompiledResource<T>> {
    const startedAt = performance.now();
    this.logger.info("interpreter.compile_started", "Pragma project compilation started.", {
      projectId: input.projectId,
      revision: input.revision,
      ref: input.ref,
    });
    const location = await this.options.repository.getRevision(input.projectId, input.revision);
    if (location === undefined) {
      throw new Error(`Pragma project revision not found: ${input.projectId}@${input.revision}`);
    }
    try {
      const compiled = await this.withCheckout(location, async (checkedOut) => {
        const project = await this.openLocation(checkedOut, true);
        return await project.compile<T>(input.ref, {
          workspace: input.workspace,
          pragmaHome: input.pragmaHome,
          projectRoot: dirname(checkedOut.entryFile),
          environmentId: input.environmentId,
          adapterHost: input.adapterHost,
          resourceAdapters: this.adapters,
          runtimes: input.runtimes,
          rootModelSelectionOverride: input.rootModelSelectionOverride,
          rootExecutionOverride: input.rootExecutionOverride,
          resolveExternalInvocable: input.resolveExternalInvocable,
          plugins: input.plugins,
          loggerProvider: this.options.loggerProvider,
        });
      });
      this.logger.info("interpreter.compile_completed", "Pragma project compilation completed.", {
        projectId: input.projectId,
        revision: input.revision,
        ref: input.ref,
        durationMs: elapsedMilliseconds(startedAt),
      });
      return compiled;
    } catch (error) {
      const attributes = {
        projectId: input.projectId,
        revision: input.revision,
        ref: input.ref,
      };
      if (error instanceof PragmaProjectValidationError) {
        this.logger.warn(
          "interpreter.compile_rejected",
          "Pragma project compilation was rejected by validation.",
          { ...attributes, diagnosticCount: error.diagnostics.length },
        );
      } else {
        this.logger.error(
          "interpreter.compile_failed",
          "Pragma project compilation failed.",
          error,
          attributes,
        );
      }
      throw error;
    }
  }

  private async withCheckout<T>(
    location: PragmaProjectRevisionLocation,
    operation: (location: PragmaProjectRevisionLocation) => Promise<T>,
  ): Promise<T> {
    return this.options.repository.withCheckout === undefined
      ? await operation(location)
      : await this.options.repository.withCheckout(location, operation);
  }

  private async openLocation(
    location: PragmaProjectRevisionLocation,
    requireLock: boolean,
  ): Promise<PragmaProject> {
    const sourceIdentity = location.snapshotHash ?? location.projectFingerprint;
    if (sourceIdentity === undefined) {
      return await loadPragmaProject(location.entryFile, {
        rootDir: location.rootDir,
        requireLock,
        ...(location.compilerVersion === undefined
          ? {}
          : { revisionCompilerVersion: location.compilerVersion }),
        resourceAdapters: this.adapters,
        externalResourceRefs: this.options.externalResourceRefs,
      });
    }
    const key =
      `${sourceIdentity}\0${location.compilerVersion ?? "unknown"}\0` +
      `${requireLock ? "locked" : "unlocked"}`;
    let project = this.openedProjects.get(key);
    if (project === undefined) {
      project = loadPragmaProject(location.entryFile, {
        rootDir: location.rootDir,
        requireLock,
        ...(location.compilerVersion === undefined
          ? {}
          : { revisionCompilerVersion: location.compilerVersion }),
        sourceIdentity,
        blueprintCache: this.options.blueprintCache,
        onBlueprintCacheLookup: (observation) => {
          this.logger.info(
            "interpreter.blueprint_cache_lookup",
            observation.hit
              ? "Pragma project Blueprint cache hit."
              : "Pragma project Blueprint cache miss.",
            {
              projectId: location.projectId,
              revision: location.revision,
              cacheTier: observation.tier,
              cacheHit: observation.hit,
              durationMs: observation.durationMs,
            },
          );
        },
        resourceAdapters: this.adapters,
        externalResourceRefs: this.options.externalResourceRefs,
      });
      this.openedProjects.set(key, project);
      void project.catch(() => {
        if (this.openedProjects.get(key) === project) this.openedProjects.delete(key);
      });
      while (this.openedProjects.size > 128) {
        const oldest = this.openedProjects.keys().next().value as string | undefined;
        if (oldest === undefined || oldest === key) break;
        this.openedProjects.delete(oldest);
      }
    } else {
      this.logger.info(
        "interpreter.project_cache_hit",
        "Reused the open immutable Pragma project.",
        {
          projectId: location.projectId,
          revision: location.revision,
          cacheTier: "service",
        },
      );
      this.openedProjects.delete(key);
      this.openedProjects.set(key, project);
    }
    return await project;
  }

  async materializeChangeSet(
    projectId: string,
    rawInput: PragmaProjectChangeSetInput,
  ): Promise<PragmaProjectChangeSetCandidate> {
    const input = PragmaProjectChangeSetSchema.parse(rawInput);
    const current = await this.get(projectId);
    if (input.baseRevision > current.revision) {
      throw new PragmaProjectRevisionConflictError(input.baseRevision, current.revision, [], false);
    }
    const currentErrors = current.diagnostics.filter(
      (diagnostic) =>
        diagnostic.severity === "error" &&
        (diagnostic.code.startsWith("lock.") || diagnostic.code.startsWith("compiler.")),
    );
    if (currentErrors.length > 0) throw new PragmaProjectValidationError(currentErrors);

    const upserts = (input.upserts ?? []).map((resource) => PragmaResourceSchema.parse(resource));
    assertUniqueCanonicalRefs(upserts);
    const removals = new Set(input.removals ?? []);
    const requiredUnchangedRefs = new Set(input.requiredUnchangedRefs ?? []);
    const upsertsByRef = resourcesByRef(upserts);
    const upsertRefs = new Set(upsertsByRef.keys());

    if (input.baseRevision !== current.revision) {
      const base =
        input.baseRevision === 0
          ? emptyProjectSnapshot(projectId)
          : await this.get(projectId, input.baseRevision);
      if (base.revision !== input.baseRevision) {
        throw new PragmaProjectRevisionConflictError(
          input.baseRevision,
          current.revision,
          [],
          false,
        );
      }
      const baseByRef = resourcesByRef(base.resources);
      const currentByRef = resourcesByRef(current.resources);
      const checkedRefs = new Set([...upsertRefs, ...removals, ...requiredUnchangedRefs]);
      const conflictingRefs = [...checkedRefs]
        .filter((ref) => {
          const baseResource = baseByRef.get(ref);
          const currentResource = currentByRef.get(ref);
          if (isDeepStrictEqual(baseResource, currentResource)) return false;
          if (requiredUnchangedRefs.has(ref)) return true;
          if (isDeepStrictEqual(upsertsByRef.get(ref), currentResource)) return false;
          if (removals.has(ref) && currentResource === undefined) return false;
          return true;
        })
        .toSorted();
      if (conflictingRefs.length > 0) {
        throw new PragmaProjectRevisionConflictError(
          input.baseRevision,
          current.revision,
          conflictingRefs,
          false,
        );
      }
    }

    return {
      currentRevision: current.revision,
      resources: [
        ...current.resources.filter((resource) => {
          const ref = canonicalPragmaResourceRef(resource);
          return !removals.has(ref) && !upsertRefs.has(ref);
        }),
        ...upserts,
      ],
      artifacts: await this.readArtifacts(projectId, current),
    };
  }

  private async readArtifacts(
    projectId: string,
    snapshot: PragmaProjectSnapshot,
  ): Promise<ReadonlyMap<string, string>> {
    if (snapshot.revision === 0) return new Map();
    const location = await this.options.repository.getRevision(projectId, snapshot.revision);
    if (location === undefined) {
      throw new Error(`Pragma project revision not found: ${projectId}@${snapshot.revision}`);
    }
    const files = await this.options.repository.readFiles(location);
    const managedPaths = new Set([
      "pragma.yaml",
      "pragma.lock.yaml",
      ...(snapshot.lock?.resources.map((resource) => resource.source) ?? []),
      ...snapshot.resources.map(
        (resource) => `${pragmaResourceDirectory(resource)}/${pragmaResourceFileName(resource)}`,
      ),
    ]);
    return new Map([...files].filter(([path]) => !managedPaths.has(path)));
  }
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

export interface PragmaInterpreter {
  readonly projects: PragmaProjectService;
}

export function createPragmaInterpreter(options: PragmaProjectServiceOptions): PragmaInterpreter {
  return { projects: new PragmaProjectService(options) };
}

export class PragmaProjectValidationError extends Error {
  constructor(readonly diagnostics: readonly PragmaDiagnostic[]) {
    super("Pragma project validation failed.");
    this.name = "PragmaProjectValidationError";
  }
}

export class PragmaProjectRevisionConflictError extends Error {
  constructor(
    readonly baseRevision: number,
    readonly currentRevision: number,
    readonly conflictingRefs: readonly PragmaResourceRef[] = [],
    readonly retryable: boolean = true,
  ) {
    super(
      conflictingRefs.length === 0
        ? `Project revision changed from ${baseRevision} to ${currentRevision}.`
        : `Project resources changed since revision ${baseRevision}: ${conflictingRefs.join(", ")}. Current revision is ${currentRevision}.`,
    );
    this.name = "PragmaProjectRevisionConflictError";
  }
}

function emptyProjectSnapshot(projectId: string): PragmaProjectSnapshot {
  return {
    schemaVersion: "pragma.project-snapshot/v3",
    projectId,
    revision: 0,
    resources: [],
    diagnostics: [],
  };
}

function resourcesByRef(
  resources: readonly PragmaResource[],
): ReadonlyMap<PragmaResourceRef, PragmaResource> {
  return new Map(resources.map((resource) => [canonicalPragmaResourceRef(resource), resource]));
}

async function withStagedProject<T>(
  resources: readonly PragmaResource[],
  artifacts: ReadonlyMap<string, string> | undefined,
  adapters: PragmaResourceAdapterRegistry,
  externalResourceRefs: ReadonlySet<PragmaResourceRef> | undefined,
  operation: (project: PragmaProject) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pragma-project-service-"));
  try {
    for (const [relativePath, contents] of artifacts ?? []) {
      assertArtifactPath(relativePath);
      const path = join(root, relativePath);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, contents, { mode: 0o600 });
    }
    const imports: string[] = [];
    for (const resource of resources) {
      const relativePath = `${pragmaResourceDirectory(resource)}/${pragmaResourceFileName(resource)}`;
      imports.push(`./${relativePath}`);
      await mkdir(dirname(join(root, relativePath)), { recursive: true, mode: 0o700 });
      await writeFile(join(root, relativePath), formatPragmaYaml(resource), { mode: 0o600 });
    }
    await writeFile(
      join(root, "pragma.yaml"),
      formatPragmaYaml({
        apiVersion: "pragma/v4",
        kind: "Bundle",
        imports: imports.toSorted(),
        resources: [],
      }),
      { mode: 0o600 },
    );
    const project = await loadPragmaProject(join(root, "pragma.yaml"), {
      rootDir: root,
      resourceAdapters: adapters,
      externalResourceRefs,
    });
    return await operation(project);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertArtifactPath(path: string): void {
  const root = resolve("/pragma-project-root");
  const target = resolve(root, path);
  const child = relative(root, target);
  if (path.trim() === "" || isAbsolute(path) || child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`Artifact path must stay inside the project: ${path}`);
  }
}

function canonicalProjectFiles(project: PragmaProject): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  const imports: string[] = [];
  for (const resource of project.listResources()) {
    const path = `${pragmaResourceDirectory(resource)}/${pragmaResourceFileName(resource)}`;
    imports.push(`./${path}`);
    files.set(path, formatPragmaYaml(resource));
  }
  files.set(
    "pragma.yaml",
    formatPragmaYaml({
      apiVersion: "pragma/v4",
      kind: "Bundle",
      imports: imports.toSorted(),
      resources: [],
    }),
  );
  files.set("pragma.lock.yaml", formatPragmaYaml(project.createLock()));
  return files;
}

function assertUniqueCanonicalRefs(resources: readonly PragmaResource[]): void {
  const refs = new Set<string>();
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const resource of resources) {
    const ref = canonicalPragmaResourceRef(resource);
    if (refs.has(ref)) throw new Error(`Duplicate Pragma resource: ${ref}`);
    if (ids.has(resource.metadata.id)) {
      throw new Error(`Duplicate Pragma resource ID: ${resource.metadata.id}`);
    }
    const nameKey = `${resource.kind}\u0000${normalizePragmaResourceName(resource.metadata.name)}`;
    if (names.has(nameKey)) {
      throw new Error(`Duplicate ${resource.kind} name: ${resource.metadata.name}`);
    }
    refs.add(ref);
    ids.add(resource.metadata.id);
    names.add(nameKey);
  }
}

export function toPragmaDiagnostic(error: unknown): PragmaDiagnostic {
  return PragmaDiagnosticSchema.parse({
    severity: "error",
    code: "project.error",
    message: error instanceof Error ? error.message : String(error),
    path: [],
  });
}
