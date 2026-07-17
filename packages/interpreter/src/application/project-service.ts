import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { RuntimeResolver } from "@pragma/core";

import {
  PragmaDiagnosticSchema,
  PragmaResourceSchema,
  type PragmaDiagnostic,
  type PragmaLock,
  type PragmaResource,
  type PragmaResourceRef,
} from "../ast/pragma-dsl.schema.ts";
import {
  canonicalPragmaResourceRef,
  pragmaResourceDirectory,
  pragmaResourceFileName,
} from "../ast/resource-identity.ts";
import {
  formatPragmaYaml,
  loadPragmaProject,
  type CompiledResource,
  type PragmaCompileOptions,
  type PragmaEnvironmentInspection,
  type PragmaProject,
} from "../compiler/pragma-project.ts";
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
  readonly commit: (input: {
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly files: ReadonlyMap<string, string>;
  }) => Promise<PragmaProjectRevisionLocation>;
}

export interface PragmaProjectSnapshot {
  readonly schemaVersion: "pragma.project-snapshot/v2";
  readonly projectId: string;
  readonly revision: number;
  readonly resources: readonly PragmaResource[];
  readonly diagnostics: readonly PragmaDiagnostic[];
  readonly lock?: PragmaLock | undefined;
  readonly projectFingerprint?: string | undefined;
  readonly updatedAt?: string | undefined;
}

export interface PragmaProjectServiceOptions {
  readonly repository: PragmaProjectSourceRepository;
  readonly resourceAdapters?: PragmaResourceAdapterRegistry | undefined;
}

export class PragmaProjectService {
  private readonly adapters: PragmaResourceAdapterRegistry;

  constructor(private readonly options: PragmaProjectServiceOptions) {
    this.adapters = options.resourceAdapters ?? createDefaultPragmaResourceAdapterRegistry();
  }

  async get(projectId: string, revision?: number): Promise<PragmaProjectSnapshot> {
    const location =
      revision === undefined
        ? await this.options.repository.getHead(projectId)
        : await this.options.repository.getRevision(projectId, revision);
    if (location === undefined) {
      return {
        schemaVersion: "pragma.project-snapshot/v2",
        projectId,
        revision: 0,
        resources: [],
        diagnostics: [],
      };
    }
    const project = await this.openLocation(location, true);
    const diagnostics = await project.validate();
    let lock: PragmaLock | undefined;
    try {
      lock = await project.readLock();
    } catch {
      lock = undefined;
    }
    const lockValid = !diagnostics.some((diagnostic) => diagnostic.code.startsWith("lock."));
    return {
      schemaVersion: "pragma.project-snapshot/v2",
      projectId,
      revision: location.revision,
      resources: project.listResources(),
      diagnostics,
      ...(lock === undefined ? {} : { lock }),
      ...(lock !== undefined && lockValid ? { projectFingerprint: lock.projectFingerprint } : {}),
      updatedAt: location.updatedAt,
    };
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
      async (project) => await project.inspectEnvironment(input.host),
    );
  }

  async validateCandidate(input: {
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly upserts?: readonly PragmaResource[] | undefined;
    readonly removals?: readonly PragmaResourceRef[] | undefined;
    readonly host?: PragmaCompileOptions | undefined;
  }): Promise<readonly PragmaDiagnostic[]> {
    const current = await this.get(input.projectId);
    if (current.revision !== input.expectedRevision) {
      throw new PragmaProjectRevisionConflictError(input.expectedRevision, current.revision);
    }
    const currentErrors = current.diagnostics.filter(
      (diagnostic) => diagnostic.severity === "error" && diagnostic.code.startsWith("lock."),
    );
    if (currentErrors.length > 0) throw new PragmaProjectValidationError(currentErrors);
    const location = await this.options.repository.getRevision(
      input.projectId,
      input.expectedRevision,
    );
    const files =
      location === undefined
        ? new Map<string, string>()
        : await this.options.repository.readFiles(location);
    const managed = new Set([
      "pragma.yaml",
      "pragma.lock.yaml",
      ...(current.lock?.resources.map((resource) => resource.source) ?? []),
      ...current.resources.map(
        (resource) => `${pragmaResourceDirectory(resource)}/${pragmaResourceFileName(resource)}`,
      ),
    ]);
    const artifacts = new Map([...files].filter(([path]) => !managed.has(path)));
    const removals = new Set(input.removals ?? []);
    const upserts = (input.upserts ?? []).map((resource) => PragmaResourceSchema.parse(resource));
    const refs = new Set(upserts.map(canonicalPragmaResourceRef));
    return await this.validate({
      resources: [
        ...current.resources.filter((resource) => {
          const ref = canonicalPragmaResourceRef(resource);
          return !removals.has(ref) && !refs.has(ref);
        }),
        ...upserts,
      ],
      artifacts,
      host: input.host,
    });
  }

  async publish(input: {
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly resources: readonly PragmaResource[];
    readonly artifacts?: ReadonlyMap<string, string> | undefined;
  }): Promise<PragmaProjectSnapshot> {
    const head = await this.options.repository.getHead(input.projectId);
    const actualRevision = head?.revision ?? 0;
    if (actualRevision !== input.expectedRevision) {
      throw new PragmaProjectRevisionConflictError(input.expectedRevision, actualRevision);
    }
    const resources = input.resources.map((resource) => PragmaResourceSchema.parse(resource));
    assertUniqueCanonicalRefs(resources);
    const files = await withStagedProject(
      resources,
      input.artifacts,
      this.adapters,
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
    await this.options.repository.commit({
      projectId: input.projectId,
      expectedRevision: input.expectedRevision,
      files,
    });
    return await this.get(input.projectId);
  }

  async apply(input: {
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly upserts?: readonly PragmaResource[] | undefined;
    readonly removals?: readonly PragmaResourceRef[] | undefined;
    readonly artifacts?: ReadonlyMap<string, string> | undefined;
  }): Promise<PragmaProjectSnapshot> {
    const current = await this.get(input.projectId);
    if (current.revision !== input.expectedRevision) {
      throw new PragmaProjectRevisionConflictError(input.expectedRevision, current.revision);
    }
    const currentErrors = current.diagnostics.filter(
      (diagnostic) => diagnostic.severity === "error" && diagnostic.code.startsWith("lock."),
    );
    if (currentErrors.length > 0) throw new PragmaProjectValidationError(currentErrors);
    const removals = new Set(input.removals ?? []);
    const upserts = (input.upserts ?? []).map((resource) => PragmaResourceSchema.parse(resource));
    const upsertRefs = new Set(upserts.map(canonicalPragmaResourceRef));
    const location = await this.options.repository.getRevision(
      input.projectId,
      input.expectedRevision,
    );
    const existingFiles =
      location === undefined
        ? new Map<string, string>()
        : await this.options.repository.readFiles(location);
    const managedPaths = new Set([
      "pragma.yaml",
      "pragma.lock.yaml",
      ...(current.lock?.resources.map((resource) => resource.source) ?? []),
      ...current.resources.map(
        (resource) => `${pragmaResourceDirectory(resource)}/${pragmaResourceFileName(resource)}`,
      ),
    ]);
    const artifacts =
      input.artifacts ?? new Map([...existingFiles].filter(([path]) => !managedPaths.has(path)));
    return await this.publish({
      projectId: input.projectId,
      expectedRevision: input.expectedRevision,
      resources: [
        ...current.resources.filter((resource) => {
          const ref = canonicalPragmaResourceRef(resource);
          return !removals.has(ref) && !upsertRefs.has(ref);
        }),
        ...upserts,
      ],
      artifacts,
    });
  }

  async compile<T extends InvocableResource>(input: {
    readonly projectId: string;
    readonly revision: number;
    readonly ref: PragmaResourceRef;
    readonly workspace: string;
    readonly environmentId: string;
    readonly adapterHost: PragmaAdapterHost;
    readonly runtimes?: RuntimeResolver | undefined;
    readonly plugins?: PragmaPluginResolver | undefined;
  }): Promise<CompiledResource<T>> {
    const location = await this.options.repository.getRevision(input.projectId, input.revision);
    if (location === undefined) {
      throw new Error(`Pragma project revision not found: ${input.projectId}@${input.revision}`);
    }
    const project = await this.openLocation(location, true);
    return await project.compile<T>(input.ref, {
      workspace: input.workspace,
      projectRoot: dirname(location.entryFile),
      environmentId: input.environmentId,
      adapterHost: input.adapterHost,
      resourceAdapters: this.adapters,
      runtimes: input.runtimes,
      plugins: input.plugins,
    });
  }

  private async openLocation(
    location: PragmaProjectRevisionLocation,
    requireLock: boolean,
  ): Promise<PragmaProject> {
    return await loadPragmaProject(location.entryFile, {
      rootDir: location.rootDir,
      requireLock,
      resourceAdapters: this.adapters,
    });
  }
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
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Project revision changed from ${expectedRevision} to ${actualRevision}.`);
    this.name = "PragmaProjectRevisionConflictError";
  }
}

async function withStagedProject<T>(
  resources: readonly PragmaResource[],
  artifacts: ReadonlyMap<string, string> | undefined,
  adapters: PragmaResourceAdapterRegistry,
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
        apiVersion: "pragma/v2",
        kind: "Bundle",
        imports: imports.toSorted(),
        resources: [],
      }),
      { mode: 0o600 },
    );
    const project = await loadPragmaProject(join(root, "pragma.yaml"), {
      rootDir: root,
      resourceAdapters: adapters,
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
      apiVersion: "pragma/v2",
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
  for (const resource of resources) {
    const ref = canonicalPragmaResourceRef(resource);
    if (refs.has(ref)) throw new Error(`Duplicate Pragma resource: ${ref}`);
    refs.add(ref);
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
