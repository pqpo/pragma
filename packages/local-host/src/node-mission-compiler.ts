import { join } from "node:path";

import { PragmaPaths, type PragmaLoggerProvider, type RuntimeResolver } from "@pragma/core";
import {
  BUILT_IN_AGENT_REFS,
  builtInAgentResource,
  builtInAgentResources,
  builtInAgentFingerprint,
  type BuiltInAgentRef,
} from "@pragma/built-in-agents";
import { canonicalPragmaResourceRef } from "@pragma/interpreter";
import type { PragmaAdapterHost, PragmaCompileOptions, PragmaProject } from "@pragma/interpreter";
import { createIntegrationError } from "@pragma/shared/integration";

import {
  createLocalHostMissionCompileService,
  type LocalHostMissionCompileRequest,
  type LocalHostMissionRevision,
} from "./missions/compile-service.ts";
import { createLocalHostResourceResolvers } from "./resources/resolvers.ts";
import { createLocalHostRuntimeReadiness } from "./missions/runtime-readiness.ts";
import { withLocalHostCompilationErrors } from "./missions/compile-errors.ts";
import {
  createLocalHostProjectRevisionReader,
  type LocalHostProjectRevisionLocation,
  type LocalHostProjectRevisionReader,
} from "./project-revision.ts";

export interface LocalHostCompileResourcePorts {
  readonly secretFingerprint?: ((ref: string) => Promise<string>) | undefined;
  readonly adapterHost: (
    request: LocalHostMissionCompileRequest,
    purpose: "execute" | "stop",
  ) => PragmaAdapterHost | Promise<PragmaAdapterHost>;
  readonly capabilityAuthority?:
    | {
        readonly getCapabilityId: (binding: string) => string | undefined;
        readonly resolve: (
          id: string,
        ) => Promise<{ capabilityId: string; resolvedRevision: number; fingerprint: string }>;
      }
    | undefined;
  readonly plugins?: PragmaCompileOptions["plugins"];
}

/** Default Node composition uses the same compiler as rich Host compositions. */
export function createLocalHostNodeMissionCompiler<
  Request extends LocalHostMissionCompileRequest = LocalHostMissionCompileRequest,
>(options: {
  readonly pragmaHome?: string | undefined;
  readonly runtimes: RuntimeResolver;
  readonly resources?: LocalHostCompileResourcePorts | undefined;
  readonly reader?: LocalHostProjectRevisionReader | undefined;
  readonly environmentId?: string | undefined;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
}) {
  const paths = new PragmaPaths({ pragmaHome: options.pragmaHome });
  const resources =
    options.resources ??
    createLocalHostResourceResolvers({
      pragmaHome: paths.root,
      environmentId: options.environmentId ?? "cli",
    });
  const reader =
    options.reader ??
    createLocalHostProjectRevisionReader({
      projectsPath: paths.projectsRoot(),
      objectsPath: paths.contentObjectsRoot(),
      projectViewsPath: paths.projectViewsCacheRoot(),
      externalResourceRefs: new Set(BUILT_IN_AGENT_REFS),
    });
  const locations = new WeakMap<LocalHostMissionRevision, LocalHostProjectRevisionLocation>();
  const withProject = async <T>(
    location: LocalHostProjectRevisionLocation,
    operation: (project: PragmaProject) => Promise<T>,
  ): Promise<T> => {
    if (reader.withOpenRevision !== undefined)
      return await reader.withOpenRevision(location, operation);
    const project = await reader.openRevision(location);
    try {
      return await operation(project);
    } finally {
      await project.dispose();
    }
  };
  const readRevision = async (
    location: LocalHostProjectRevisionLocation,
  ): Promise<LocalHostMissionRevision> => {
    const snapshot: LocalHostMissionRevision = await withLocalHostCompilationErrors(() =>
      withProject(location, async (project) => ({
        projectId: location.projectId,
        revision: location.revision,
        resources: project.listResources(),
        projectFingerprint: location.projectFingerprint,
        derivedProjectFingerprint: location.derivedProjectFingerprint,
        snapshotHash: location.snapshotHash,
      })),
    );
    locations.set(snapshot, location);
    return snapshot;
  };
  const builtInRefs = new Set<string>(BUILT_IN_AGENT_REFS);
  const builtInResources = new Map(
    BUILT_IN_AGENT_REFS.flatMap((ref) =>
      builtInAgentResources(ref).map(
        (resource) => [canonicalPragmaResourceRef(resource), resource] as const,
      ),
    ),
  );
  const environmentId = options.environmentId ?? "cli";
  const service = createLocalHostMissionCompileService<Request>({
    environmentId,
    pragmaHome: paths.root,
    loggerProvider: options.loggerProvider,
    adapterHost: resources.adapterHost,
    secretFingerprint: resources.secretFingerprint,
    plugins: resources.plugins,
    capabilityAuthority: resources.capabilityAuthority,
    revisionSource: {
      getRevision: async (projectId, revision) => {
        const location = await reader.getRevision(projectId, revision);
        if (location === undefined)
          throw createIntegrationError({
            code: "NOT_FOUND",
            category: "not_found",
            message: `Project Revision not found: ${projectId}@${revision}.`,
            details: { projectId, revision },
          });
        return await readRevision(location);
      },
      withProject: async (pin, operation, snapshot) => {
        const location =
          (snapshot === undefined ? undefined : locations.get(snapshot)) ??
          (await reader.getRevision(pin.id, pin.revision));
        if (location === undefined)
          throw new Error(`Project Revision not found: ${pin.id}@${pin.revision}.`);
        return await withProject(location, operation);
      },
    },
    systemExecutors: {
      getResource: (ref) =>
        builtInRefs.has(ref) ? builtInAgentResource(ref as BuiltInAgentRef) : undefined,
      getDependencyResource: (ref) => builtInResources.get(ref),
      fingerprint: (ref) =>
        builtInRefs.has(ref) ? builtInAgentFingerprint(ref as BuiltInAgentRef) : undefined,
      prepare: async (request, runtimes, _purpose, adapterHost) =>
        builtInRefs.has(request.executor.ref)
          ? {
              ref: request.executor.ref as BuiltInAgentRef,
              environmentId,
              definitionStateRoot: join(paths.cacheRoot(), "built-in-agents", "definitions"),
              workspace: request.workspace.path,
              pragmaHome: paths.root,
              runtimes,
              loggerProvider: options.loggerProvider,
              adapterHost,
            }
          : undefined,
    },
  });
  const readiness = createLocalHostRuntimeReadiness({ runtimes: options.runtimes });
  const assertReady = async (scope: Parameters<typeof service.compile>[0]): Promise<void> =>
    await withLocalHostCompilationErrors(async () => {
      const targets = await service.runtimeIds(scope);
      const results = await readiness.get(
        targets.length === 0 ? [await options.runtimes.getDefaultRuntimeId()] : targets,
      );
      for (const { runtimeId, availability } of results) {
        if (!availability.usable)
          throw createIntegrationError({
            code: "RUNTIME_UNAVAILABLE",
            category: "dependency",
            message: availability.reason ?? `Runtime is unavailable: ${runtimeId}.`,
            details: { runtimeId },
          });
      }
    });
  return {
    reader,
    service,
    readRevision,
    readiness,
    assertReady,
    async compileForStop(scope: Parameters<typeof service.compile>[0]) {
      return await withLocalHostCompilationErrors(() =>
        service.compile(scope, options.runtimes, "stop"),
      );
    },
    async prepare(
      scope: Parameters<typeof service.prepare>[0],
      owner?: Parameters<typeof service.prepare>[2],
    ) {
      return await withLocalHostCompilationErrors(async () => {
        await assertReady(scope);
        const prepared = await service.prepare(scope, options.runtimes, owner);
        return {
          ...prepared,
          ensureCompiled: () => withLocalHostCompilationErrors(prepared.ensureCompiled),
        };
      });
    },
  };
}

export type LocalHostNodeMissionCompiler<
  Request extends LocalHostMissionCompileRequest = LocalHostMissionCompileRequest,
> = ReturnType<typeof createLocalHostNodeMissionCompiler<Request>>;
