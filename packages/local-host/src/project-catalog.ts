import { PragmaPaths, type PragmaLoggerProvider, type RuntimeResolver } from "@pragma/core";
import {
  canonicalPragmaResourceRef,
  PragmaInvocableResourceRefSchema,
  type InvocableResource,
  type PragmaResource,
} from "@pragma/interpreter";
import {
  ExecutorDescriptorSchema,
  type ExecutorDescriptor,
  type ExecutorReference,
  type WorkspaceSelection,
} from "@pragma/shared/integration";

import type { LocalHostCoreExecutorDefinition } from "./core-run.ts";
import {
  createLocalHostProjectRevisionReader,
  type LocalHostProjectRevisionReader,
} from "./project-revision.ts";

export const LOCAL_HOST_DEFAULT_PROJECT_ID = "studio" as const;

export interface LocalHostProjectSummary {
  readonly id: string;
  readonly revision: number;
  readonly fingerprint: string;
}

export interface LocalHostProjectRevisionSummary extends LocalHostProjectSummary {
  readonly resources: readonly PragmaResource[];
}

export interface LocalHostProjectCatalog {
  readonly resolve: (input: {
    readonly ref: ExecutorReference;
    readonly projectId?: string | undefined;
    readonly revision?: number | undefined;
    readonly workspace: WorkspaceSelection;
  }) => Promise<LocalHostCoreExecutorDefinition | undefined>;
  readonly listProjects: () => Promise<readonly LocalHostProjectSummary[]>;
  readonly getProjectRevision: (
    projectId: string,
    revision: number,
  ) => Promise<LocalHostProjectRevisionSummary | undefined>;
  readonly listExecutors: () => Promise<readonly ExecutorDescriptor[]>;
}

/**
 * Minimal read/compile port used by CLI foreground runs. The catalog is
 * intentionally scoped to the configured project owner and never scans the
 * complete project tree during composition startup.
 */
export function createLocalHostProjectCatalog(options: {
  readonly projectsPath: string;
  readonly objectsPath: string;
  readonly projectViewsPath: string;
  readonly projectId?: string | undefined;
  readonly pragmaHome?: string | undefined;
  readonly runtimes: RuntimeResolver;
  readonly environmentId?: string | undefined;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
  readonly reader?: LocalHostProjectRevisionReader | undefined;
}): LocalHostProjectCatalog {
  const projectId = options.projectId ?? LOCAL_HOST_DEFAULT_PROJECT_ID;
  const reader =
    options.reader ??
    createLocalHostProjectRevisionReader({
      projectsPath: options.projectsPath,
      objectsPath: options.objectsPath,
      projectViewsPath: options.projectViewsPath,
    });

  const readLocation = async (requestedProjectId: string, revision?: number) =>
    revision === undefined
      ? await reader.getHead(requestedProjectId)
      : await reader.getRevision(requestedProjectId, revision);

  const readSummary = async (
    requestedProjectId: string,
    revision?: number,
  ): Promise<LocalHostProjectRevisionSummary | undefined> => {
    const location = await readLocation(requestedProjectId, revision);
    if (location === undefined || location.projectFingerprint === undefined) return undefined;
    const project = await reader.openRevision(location);
    try {
      return {
        id: location.projectId,
        revision: location.revision,
        fingerprint: location.projectFingerprint,
        resources: project.listResources(),
      };
    } finally {
      await project.dispose();
    }
  };

  const listProjectResources = async (): Promise<
    | {
        readonly location: NonNullable<
          Awaited<ReturnType<LocalHostProjectRevisionReader["getHead"]>>
        >;
        readonly resources: readonly PragmaResource[];
      }
    | undefined
  > => {
    const location = await reader.getHead(projectId);
    if (location === undefined) return undefined;
    const project = await reader.openRevision(location);
    try {
      return { location, resources: project.listResources() };
    } finally {
      await project.dispose();
    }
  };

  const resolve = async (input: {
    readonly ref: ExecutorReference;
    readonly projectId?: string | undefined;
    readonly revision?: number | undefined;
    readonly workspace: WorkspaceSelection;
  }): Promise<LocalHostCoreExecutorDefinition | undefined> => {
    const targetProjectId = input.projectId ?? projectId;
    const exactRef = `${input.ref.kind}:${input.ref.id}`;
    if (!PragmaInvocableResourceRefSchema.safeParse(exactRef).success) return undefined;
    const location = await readLocation(targetProjectId, input.revision);
    if (location === undefined || location.projectFingerprint === undefined) return undefined;
    const project = await reader.openRevision(location);
    try {
      const resource = project
        .listResources()
        .find((candidate) => canonicalPragmaResourceRef(candidate) === exactRef);
      if (resource === undefined || !isInvocableResource(resource)) return undefined;
      const compiled = await project.compile<InvocableResource>(exactRef, {
        workspace: input.workspace.canonicalPath,
        ...(options.pragmaHome === undefined ? {} : { pragmaHome: options.pragmaHome }),
        projectRoot: location.rootDir,
        environmentId: options.environmentId ?? "cli",
        runtimes: options.runtimes,
        loggerProvider: options.loggerProvider,
      });
      const expectedCompiledFingerprint =
        location.derivedProjectFingerprint ?? location.projectFingerprint;
      if (compiled.projectFingerprint !== expectedCompiledFingerprint) {
        throw new Error(
          `Compiled project fingerprint does not match the ${
            location.derivedProjectFingerprint === undefined ? "published" : "derived compiler view"
          } revision: ${location.projectId}@${location.revision}.`,
        );
      }
      return {
        descriptor: createProjectExecutorDescriptor({
          resource,
          projectId: location.projectId,
          revision: location.revision,
          // The descriptor is the stable Mission/Revision pin. A migrated
          // compiler view may have a different derived fingerprint, but that
          // value must never replace the historical source fingerprint.
          fingerprint: location.projectFingerprint,
        }),
        definition: compiled.value,
      };
    } finally {
      await project.dispose();
    }
  };

  return {
    resolve,
    listProjects: async () => {
      const location = await reader.getHead(projectId);
      return location?.projectFingerprint === undefined
        ? []
        : [
            {
              id: location.projectId,
              revision: location.revision,
              fingerprint: location.projectFingerprint,
            },
          ];
    },
    getProjectRevision: async (requestedProjectId, revision) =>
      await readSummary(requestedProjectId, revision),
    listExecutors: async () => {
      const loaded = await listProjectResources();
      if (loaded === undefined || loaded.location.projectFingerprint === undefined) return [];
      return loaded.resources.filter(isInvocableResource).map((resource) =>
        createProjectExecutorDescriptor({
          resource,
          projectId: loaded.location.projectId,
          revision: loaded.location.revision,
          fingerprint: loaded.location.projectFingerprint!,
        }),
      );
    },
  };
}

/** Compose the reader from the canonical Pragma storage roots. */
export function createLocalHostProjectCatalogFromHome(options: {
  readonly pragmaHome?: string | undefined;
  readonly projectId?: string | undefined;
  readonly runtimes: RuntimeResolver;
  readonly environmentId?: string | undefined;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
  readonly reader?: LocalHostProjectRevisionReader | undefined;
}): LocalHostProjectCatalog {
  const paths = new PragmaPaths(
    options.pragmaHome === undefined ? {} : { pragmaHome: options.pragmaHome },
  );
  return createLocalHostProjectCatalog({
    projectsPath: paths.projectsRoot(),
    objectsPath: paths.contentObjectsRoot(),
    projectViewsPath: paths.projectViewsCacheRoot(),
    ...(options.pragmaHome === undefined ? {} : { pragmaHome: options.pragmaHome }),
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    runtimes: options.runtimes,
    ...(options.environmentId === undefined ? {} : { environmentId: options.environmentId }),
    ...(options.loggerProvider === undefined ? {} : { loggerProvider: options.loggerProvider }),
    ...(options.reader === undefined ? {} : { reader: options.reader }),
  });
}

function createProjectExecutorDescriptor(input: {
  readonly resource: PragmaResource;
  readonly projectId: string;
  readonly revision: number;
  readonly fingerprint: string;
}): ExecutorDescriptor {
  const ref = resourceRef(input.resource);
  return ExecutorDescriptorSchema.parse({
    schemaVersion: "pragma.integration-executor/v1",
    ref,
    name: input.resource.metadata.name,
    description: input.resource.metadata.description,
    source: "project",
    project: {
      projectId: input.projectId,
      revision: input.revision,
      fingerprint: input.fingerprint,
    },
    availability: { status: "ready", blockingCodes: [] },
    workspace: { required: true, allowNonGitDirectory: true },
    capabilities: {
      interactive: true,
      resumable: true,
      steerable: false,
      supportsQueue: false,
    },
  });
}

function isInvocableResource(resource: PragmaResource): boolean {
  return resource.kind === "Expert" || resource.kind === "ExpertTeam" || resource.kind === "Flow";
}

function resourceRef(resource: PragmaResource): ExecutorReference {
  if (resource.kind === "Expert") return { kind: "expert", id: resource.metadata.id };
  if (resource.kind === "ExpertTeam") return { kind: "team", id: resource.metadata.id };
  if (resource.kind === "Flow") return { kind: "flow", id: resource.metadata.id };
  throw new Error(`Resource is not an executor: ${resource.kind}.`);
}
