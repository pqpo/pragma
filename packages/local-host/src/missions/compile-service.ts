import { PragmaRuntimeProfileConfigSchema } from "@pragma/interpreter/ast";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

import {
  fingerprintExpertExecutionDefinition,
  withFileLock,
  type RuntimeModelSelection,
  type RuntimeResolver,
} from "@pragma/core";
import { compileBuiltInAgent } from "@pragma/built-in-agents";
import {
  canonicalPragmaResourceRef,
  type CompiledResource,
  type InvocableResource,
  type PragmaAdapterHost,
  type PragmaCompileOptions,
  type PragmaInvocableResource,
  type PragmaExpertResource,
  type PragmaProject,
  type PragmaResource,
  type PragmaResourceRef,
} from "@pragma/interpreter";
import { referencedPragmaResourceRefs } from "./resource-dependencies.ts";
import type { ExecutionEnvironmentSnapshot } from "@pragma/shared";
import {
  readMissionExecutionSnapshot,
  writeMissionExecutionSnapshot,
  type MissionExecutionSnapshot,
} from "./execution-snapshot.ts";

export type LocalHostMissionContextMount =
  | { readonly kind: "context-store"; readonly storeId: string }
  | {
      readonly kind: "skill-revision-draft";
      readonly draftId: string;
      readonly revisionJobId: string;
      readonly capabilityId: string;
    }
  | {
      readonly kind: "context-store-draft";
      readonly draftId: string;
      readonly revisionJobId?: string | undefined;
    };

export interface LocalHostMissionCompileRequest {
  readonly id: string;
  readonly project: { readonly id: string; readonly revision: number };
  readonly executor: { readonly kind: string; readonly ref: string; readonly name: string };
  readonly workspace: { readonly path: string };
  readonly modelOverride?:
    | {
        readonly providerId: string;
        readonly modelId: string;
        readonly thinkingLevel?: RuntimeModelSelection["thinkingLevel"] | undefined;
      }
    | undefined;
  readonly contextMounts: readonly LocalHostMissionContextMount[];
  readonly execution?: { readonly sessionId?: string | undefined } | undefined;
}

export interface LocalHostMissionRevision {
  readonly projectId: string;
  readonly revision: number;
  readonly resources: readonly PragmaResource[];
  readonly projectFingerprint?: string | undefined;
  readonly derivedProjectFingerprint?: string | undefined;
  readonly snapshotHash?: string | undefined;
  readonly rootDir?: string | undefined;
}

/** Resource access only; the service invokes the Interpreter compiler. */
export interface LocalHostMissionRevisionSource {
  getCurrentResources?(projectId: string): Promise<readonly PragmaResource[]>;
  getRevision(projectId: string, revision: number): Promise<LocalHostMissionRevision>;
  withProject<T>(
    pin: { readonly id: string; readonly revision: number },
    operation: (project: PragmaProject) => Promise<T>,
    revision?: LocalHostMissionRevision,
  ): Promise<T>;
}

export interface LocalHostResolvedCapabilityEnvironment {
  readonly capabilityId: string;
  readonly resolvedRevision: number;
  readonly fingerprint: string;
}

/** Process-local guards for Secret values captured by compiled contributions. */
export interface LocalHostResolvedSecretEnvironment {
  readonly ref: string;
  readonly fingerprint: string;
}

export interface LocalHostResolvedPluginEnvironment {
  readonly expertRef: `expert:${string}`;
  readonly binding: PragmaExpertResource["spec"]["plugins"][number];
  readonly fingerprint: string;
}

/** Hosts supply a prepared resource/profile, never a compiled executor. */
export type LocalHostSystemExecutorSource = Omit<
  Parameters<typeof compileBuiltInAgent>[0],
  "resolveExternalInvocable"
>;
export type LocalHostSystemExecutorSnapshot = MissionExecutionSnapshot["sources"][string];

export interface LocalHostMissionCompileScope<
  Request extends LocalHostMissionCompileRequest = LocalHostMissionCompileRequest,
> {
  readonly request: Request;
  readonly getRevision: () => Promise<LocalHostMissionRevision>;
}

export interface LocalHostStableMissionCompilation {
  readonly compiled: CompiledResource<InvocableResource>;
  readonly capabilities: LocalHostResolvedCapabilityEnvironment[];
  readonly secrets: readonly LocalHostResolvedSecretEnvironment[];
  readonly plugins: readonly LocalHostResolvedPluginEnvironment[];
  readonly identity: string;
  readonly definitionFingerprint?: string | undefined;
  /** Process-local guard; persisted definition fingerprints keep their historical shape. */
  readonly executionProfilesFingerprint?: string | undefined;
}

export interface LocalHostMissionCompileService<
  Request extends LocalHostMissionCompileRequest = LocalHostMissionCompileRequest,
> {
  isExecutionPinned(scope: LocalHostMissionCompileScope<Request>): Promise<boolean>;
  allowsExecutionProfileSuccessor(compiled: CompiledResource<InvocableResource>): boolean;
  createRequestScope(
    request: Request,
    revision?: Promise<LocalHostMissionRevision>,
  ): LocalHostMissionCompileScope<Request>;
  capabilities(
    scope: LocalHostMissionCompileScope<Request>,
  ): Promise<LocalHostResolvedCapabilityEnvironment[]>;
  identity(
    scope: LocalHostMissionCompileScope<Request>,
    capabilities: readonly LocalHostResolvedCapabilityEnvironment[],
    runtimes?: RuntimeResolver,
  ): Promise<string>;
  compile(
    scope: LocalHostMissionCompileScope<Request>,
    runtimes: RuntimeResolver,
    purpose?: "execute" | "stop",
  ): Promise<CompiledResource<InvocableResource>>;
  runtimeIds(
    scope: LocalHostMissionCompileScope<Request>,
    runtimes?: RuntimeResolver,
  ): Promise<readonly string[]>;
  executionProfilesFingerprintFor(
    compiled: CompiledResource<InvocableResource>,
  ): string | undefined;
  secretsFor(
    compiled: CompiledResource<InvocableResource>,
  ): readonly LocalHostResolvedSecretEnvironment[] | undefined;
  pluginsFor(
    compiled: CompiledResource<InvocableResource>,
  ): readonly LocalHostResolvedPluginEnvironment[] | undefined;
  compileStable(
    scope: LocalHostMissionCompileScope<Request>,
    runtimes: RuntimeResolver,
  ): Promise<LocalHostStableMissionCompilation>;
  prepare(
    scope: LocalHostMissionCompileScope<Request>,
    runtimes: RuntimeResolver,
    owner?: {
      readonly identity?: string | undefined;
      readonly hasOwner: boolean;
      readonly definitionFingerprint?: string | undefined;
      readonly executionProfilesFingerprint?: string | undefined;
      readonly capabilities?: readonly LocalHostResolvedCapabilityEnvironment[] | undefined;
      readonly secrets?: readonly LocalHostResolvedSecretEnvironment[] | undefined;
      readonly plugins?: readonly LocalHostResolvedPluginEnvironment[] | undefined;
    },
  ): Promise<{
    readonly cacheHit: boolean;
    readonly definitionChanged: boolean;
    readonly refreshEnvironment?: boolean | undefined;
    readonly definitionFingerprint?: string | undefined;
    readonly executionProfilesFingerprint?: string | undefined;
    readonly identityDurationMs: number;
    readonly compileDurationMs: number;
    readonly identity: string;
    readonly capabilities: LocalHostResolvedCapabilityEnvironment[];
    readonly secrets: readonly LocalHostResolvedSecretEnvironment[];
    readonly plugins: readonly LocalHostResolvedPluginEnvironment[];
    readonly compiled?: CompiledResource<InvocableResource> | undefined;
    readonly ensureCompiled: () => Promise<LocalHostStableMissionCompilation>;
  }>;
}

export function missionCompileContextMountsFingerprint(
  request: Pick<LocalHostMissionCompileRequest, "contextMounts">,
): string {
  return hash(
    request.contextMounts
      .map((mount) => {
        if (mount.kind === "context-store") return { kind: mount.kind, storeId: mount.storeId };
        if (mount.kind === "skill-revision-draft")
          return {
            kind: mount.kind,
            draftId: mount.draftId,
            revisionJobId: mount.revisionJobId,
            capabilityId: mount.capabilityId,
          };
        return {
          kind: mount.kind,
          draftId: mount.draftId,
          revisionJobId: mount.revisionJobId ?? null,
        };
      })
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
}

export function missionCompilationEnvironmentSnapshot(
  compiled: CompiledResource<InvocableResource>,
  capabilities: readonly LocalHostResolvedCapabilityEnvironment[],
  secrets: readonly LocalHostResolvedSecretEnvironment[] = [],
  plugins: readonly LocalHostResolvedPluginEnvironment[] = [],
): ExecutionEnvironmentSnapshot {
  return {
    fingerprint: hash({
      compiledEnvironment: compiled.environmentFingerprint.value,
      capabilities,
      ...(secrets.length > 0 ? { secrets } : {}),
      ...(plugins.length > 0 ? { plugins } : {}),
    }),
    resources: capabilities.map((capability) => ({
      kind: "capability",
      id: capability.capabilityId,
      revision: capability.resolvedRevision,
      fingerprint: capability.fingerprint,
    })),
  };
}

export function createLocalHostMissionCompileService<
  Request extends LocalHostMissionCompileRequest,
>(options: {
  readonly onPhase?:
    | ((input: {
        readonly requestId: string;
        readonly phase: string;
        readonly elapsedMs: number;
      }) => void)
    | undefined;
  readonly onCompile?:
    | ((input: {
        readonly requestId: string;
        readonly ref: string;
        readonly purpose: "execute" | "stop";
      }) => void)
    | undefined;
  readonly revisionSource: LocalHostMissionRevisionSource;
  readonly environmentId: string;
  readonly pragmaHome?: string | undefined;
  /** Only Mission execution owners supply this path; catalog/preview compilation stays live. */
  readonly executionSnapshotPath?: ((request: Request) => string | undefined) | undefined;
  readonly loggerProvider?: PragmaCompileOptions["loggerProvider"];
  readonly adapterHost: (
    request: Request,
    purpose: "execute" | "stop",
  ) => PragmaAdapterHost | Promise<PragmaAdapterHost>;
  readonly plugins?: PragmaCompileOptions["plugins"];
  /** Must fingerprint the authority used by final adapter overlays/source adapters for this ref. */
  readonly secretFingerprint?: ((ref: string) => Promise<string>) | undefined;
  readonly adaptAdapterHost?:
    ((request: Request, fallback: PragmaAdapterHost) => PragmaAdapterHost) | undefined;
  readonly capabilityAuthority?:
    | {
        readonly getCapabilityId: (binding: string) => string | undefined;
        readonly resolve: (
          id: string,
          revision?: number,
        ) => Promise<LocalHostResolvedCapabilityEnvironment>;
      }
    | undefined;
  readonly systemExecutors?:
    | {
        /** False when the Host pins implicit system Runtime choices in its saved source. */
        readonly tracksDefaultRuntime?: boolean | undefined;
        readonly getDependencyResource?: ((ref: string) => PragmaResource | undefined) | undefined;
        readonly getResource?: ((ref: string) => PragmaInvocableResource | undefined) | undefined;
        readonly fingerprint?:
          ((ref: string) => string | undefined | Promise<string | undefined>) | undefined;
        readonly prepare: (
          request: Request,
          runtimes: RuntimeResolver,
          purpose: "execute" | "stop",
          adapterHost: PragmaAdapterHost,
          pinnedSource?: LocalHostSystemExecutorSnapshot | undefined,
        ) => Promise<LocalHostSystemExecutorSource | undefined>;
      }
    | undefined;
}): LocalHostMissionCompileService<Request> {
  const snapshots = new WeakMap<
    LocalHostMissionCompileScope<Request>,
    Promise<MissionExecutionSnapshot | undefined>
  >();
  const liveProfiles = new WeakMap<
    LocalHostMissionCompileScope<Request>,
    Promise<Record<string, import("@pragma/interpreter").PragmaRuntimeProfileContribution | null>>
  >();
  const executionProfiles = (scope: LocalHostMissionCompileScope<Request>) => {
    let pending = liveProfiles.get(scope);
    if (pending === undefined) {
      pending = (async () => {
        const resources = await options.revisionSource.getCurrentResources?.(
          scope.request.project.id,
        );
        const profiles: Record<
          string,
          import("@pragma/interpreter").PragmaRuntimeProfileContribution | null
        > = {};
        const expertRefs = new Set<string>();
        if (resources !== undefined && resources.length > 0)
          await visitDependencies(scope, (_resource, ref) => {
            if (ref.startsWith("expert:")) expertRefs.add(ref);
          });
        for (const expert of resources ?? []) {
          if (expert.kind !== "Expert" || !expertRefs.has(canonicalPragmaResourceRef(expert)))
            continue;
          if (expert.spec.runtime === undefined) {
            profiles[expert.metadata.id] = null;
            continue;
          }
          const resource = resources!.find(
            (candidate) =>
              candidate.kind === "RuntimeProfile" &&
              canonicalPragmaResourceRef(candidate) === expert.spec.runtime!.ref,
          );
          if (
            resource?.kind !== "RuntimeProfile" ||
            resource.spec.adapter !== "pragma.runtime.profile@v1"
          )
            continue;
          const config = PragmaRuntimeProfileConfigSchema.parse(resource.spec.config);
          profiles[expert.metadata.id] = {
            runtimeId: config.runtimeId,
            ...(config.permissionModeId === undefined
              ? {}
              : { permissionModeId: config.permissionModeId }),
            ...(config.providerId === undefined || config.model === undefined
              ? {}
              : {
                  models: {
                    default: {
                      model: { providerId: config.providerId, modelId: config.model },
                      ...(config.thinkingLevel === undefined
                        ? {}
                        : { thinkingLevel: config.thinkingLevel }),
                    },
                  },
                }),
          };
        }
        return profiles;
      })();
      liveProfiles.set(scope, pending);
    }
    return pending;
  };
  const preparedSources = new WeakMap<
    LocalHostMissionCompileScope<Request>,
    Map<string, LocalHostSystemExecutorSource>
  >();
  // Stateless Flows resolve live dependencies on each run; only Session owners freeze them.
  const executionSnapshotPath = (request: Request) =>
    request.executor.kind === "flow" ? undefined : options.executionSnapshotPath?.(request);
  const readSnapshot = (scope: LocalHostMissionCompileScope<Request>) => {
    let result = snapshots.get(scope);
    if (result === undefined) {
      const path = executionSnapshotPath(scope.request);
      result =
        path === undefined
          ? Promise.resolve(undefined)
          : readMissionExecutionSnapshot(path, {
              missionId: scope.request.id,
              project: scope.request.project,
              executorRef: scope.request.executor.ref,
            }).then((snapshot) => {
              if (
                snapshot !== undefined &&
                (snapshot.missionId !== scope.request.id ||
                  snapshot.project.id !== scope.request.project.id ||
                  snapshot.project.revision !== scope.request.project.revision ||
                  snapshot.executorRef !== scope.request.executor.ref)
              )
                throw new Error(
                  `mission_execution_snapshot_identity_mismatch: ${scope.request.id}`,
                );
              return snapshot;
            });
      snapshots.set(scope, result);
    }
    return result;
  };
  const executionProfilesFingerprints = new WeakMap<CompiledResource<InvocableResource>, string>();
  const profileOverlayCompilations = new WeakSet<CompiledResource<InvocableResource>>();
  const compilationResources = new WeakMap<
    CompiledResource<InvocableResource>,
    {
      readonly secrets: readonly LocalHostResolvedSecretEnvironment[];
      readonly readers: ReadonlyMap<string, () => Promise<string | undefined>>;
      readonly plugins: readonly LocalHostResolvedPluginEnvironment[];
      readonly pluginReaders: ReadonlyMap<string, () => Promise<string | undefined>>;
    }
  >();
  const secretReadersByGuards = new WeakMap<
    readonly LocalHostResolvedSecretEnvironment[],
    ReadonlyMap<string, () => Promise<string | undefined>>
  >();
  const pluginReadersByGuards = new WeakMap<
    readonly LocalHostResolvedPluginEnvironment[],
    ReadonlyMap<string, () => Promise<string | undefined>>
  >();
  const secretFingerprint = async (ref: string, read: () => Promise<string | undefined>) =>
    options.secretFingerprint === undefined
      ? hash((await read()) ?? null)
      : await options.secretFingerprint(ref);
  const createRequestScope = (
    request: Request,
    seed?: Promise<LocalHostMissionRevision>,
  ): LocalHostMissionCompileScope<Request> => {
    const validate = (value: LocalHostMissionRevision): LocalHostMissionRevision => {
      if (value.projectId !== request.project.id || value.revision !== request.project.revision) {
        throw new Error(
          `Mission Revision pin mismatch: ${request.project.id}@${request.project.revision}`,
        );
      }
      return value;
    };
    let revision: Promise<LocalHostMissionRevision> | undefined = seed?.then(validate);
    return {
      request,
      getRevision: () =>
        (revision ??= Promise.resolve()
          .then(async () => {
            const startedAt = performance.now();
            try {
              return await options.revisionSource.getRevision(
                request.project.id,
                request.project.revision,
              );
            } finally {
              options.onPhase?.({
                requestId: request.id,
                phase: "identity_revision_read",
                elapsedMs: performance.now() - startedAt,
              });
            }
          })
          .then(validate)),
    };
  };
  const visitDependencies = async (
    scope: LocalHostMissionCompileScope<Request>,
    visit: (
      resource: PragmaResource | undefined,
      ref: string,
      fingerprint: string | undefined,
    ) => void,
  ) => {
    const snapshot = await readSnapshot(scope);
    const pinnedResources =
      snapshot === undefined
        ? undefined
        : new Map(
            snapshot.resources.map((resource) => [canonicalPragmaResourceRef(resource), resource]),
          );
    const pinnedFingerprints = snapshot === undefined ? undefined : new Map(snapshot.fingerprints);
    const visited = new Set<string>();
    let byRef: Promise<ReadonlyMap<string, PragmaResource>> | undefined;
    const projectResources = () =>
      (byRef ??= scope
        .getRevision()
        .then(
          (revision) =>
            new Map(
              revision.resources.map((resource) => [
                canonicalPragmaResourceRef(resource),
                resource,
              ]),
            ),
        ));
    const walk = async (ref: string): Promise<void> => {
      if (visited.has(ref)) return;
      visited.add(ref);
      const fingerprint =
        pinnedFingerprints === undefined
          ? await options.systemExecutors?.fingerprint?.(ref)
          : pinnedFingerprints.get(ref);
      const system =
        pinnedResources === undefined
          ? (options.systemExecutors?.getDependencyResource?.(ref) ??
            options.systemExecutors?.getResource?.(ref))
          : pinnedResources.get(ref);
      const resource =
        system ?? (fingerprint === undefined ? (await projectResources()).get(ref) : undefined);
      visit(resource, ref, fingerprint);
      if (resource !== undefined)
        await Promise.all([...referencedPragmaResourceRefs([resource])].map(walk));
    };
    await walk(scope.request.executor.ref);
  };
  const capabilities = async (
    scope: LocalHostMissionCompileScope<Request>,
  ): Promise<LocalHostResolvedCapabilityEnvironment[]> => {
    const snapshot = await readSnapshot(scope);
    if (snapshot !== undefined) {
      const resolved: LocalHostResolvedCapabilityEnvironment[] = [];
      for (const pin of snapshot.capabilities) {
        const actual = await options.capabilityAuthority?.resolve(
          pin.capabilityId,
          pin.resolvedRevision,
        );
        if (actual === undefined || actual.resolvedRevision !== pin.resolvedRevision)
          throw new Error(
            `mission_pinned_capability_unavailable: ${pin.capabilityId}@${pin.resolvedRevision}`,
          );
        resolved.push(actual);
      }
      return resolved;
    }
    const ids = new Set<string>();
    await visitDependencies(scope, (resource) => {
      if (resource?.kind !== "Capability" || resource.spec.binding === undefined) return;
      const id = options.capabilityAuthority?.getCapabilityId(resource.spec.binding);
      if (id !== undefined) ids.add(id);
    });
    return (
      await Promise.all([...ids].toSorted().map((id) => options.capabilityAuthority!.resolve(id)))
    ).toSorted((left, right) => left.capabilityId.localeCompare(right.capabilityId));
  };
  const defaultRuntimeDependencies = new WeakMap<
    LocalHostMissionCompileScope<Request>,
    Promise<boolean>
  >();
  const usesDefaultRuntime = (scope: LocalHostMissionCompileScope<Request>): Promise<boolean> => {
    let pending = defaultRuntimeDependencies.get(scope);
    if (pending === undefined) {
      pending = (async () => {
        const profiles = await executionProfiles(scope);
        if (Object.values(profiles).some((profile) => profile === null)) return true;
        let implicitDefault = false;
        await visitDependencies(scope, (pinnedResource, ref) => {
          const systemResource =
            options.systemExecutors?.getDependencyResource?.(ref) ??
            options.systemExecutors?.getResource?.(ref);
          if (
            systemResource !== undefined &&
            options.systemExecutors?.tracksDefaultRuntime === false
          )
            return;
          const resource = systemResource ?? pinnedResource;
          if (
            resource?.kind === "Expert" &&
            profiles[resource.metadata.id] === undefined &&
            resource.spec.runtime === undefined
          )
            implicitDefault = true;
        });
        return implicitDefault;
      })();
      defaultRuntimeDependencies.set(scope, pending);
    }
    return pending;
  };
  const identity = async (
    scope: LocalHostMissionCompileScope<Request>,
    active: readonly LocalHostResolvedCapabilityEnvironment[],
    runtimes?: RuntimeResolver,
  ): Promise<string> => {
    const snapshot = await readSnapshot(scope);
    const systemExecutorFingerprints = await resolveMissionSystemDependencyFingerprints({
      mission: scope.request,
      project: { getRevision: async () => await scope.getRevision() },
      getSystemExecutorFingerprint: options.systemExecutors?.fingerprint,
      getSystemExecutorResource: (ref) =>
        options.systemExecutors?.getDependencyResource?.(ref) ??
        options.systemExecutors?.getResource?.(ref),
    });
    const request = scope.request;
    return hash({
      project: request.project,
      executor: request.executor,
      contextMounts: missionCompileContextMountsFingerprint(request),
      systemExecutorFingerprints,
      modelOverride: request.modelOverride ?? null,
      expertExecutionProfiles: await executionProfiles(scope),
      ...(runtimes !== undefined && (await usesDefaultRuntime(scope))
        ? { defaultRuntimeId: await runtimes.getDefaultRuntimeId() }
        : {}),
      capabilities: snapshot?.capabilities ?? active,
    });
  };
  const compile = async (
    scope: LocalHostMissionCompileScope<Request>,
    runtimes: RuntimeResolver,
    purpose: "execute" | "stop" = "execute",
  ): Promise<CompiledResource<InvocableResource>> => {
    const snapshot = await readSnapshot(scope);
    const profiles = purpose === "stop" ? undefined : await executionProfiles(scope);
    let hasExecutionProfileOverlay = profiles !== undefined && Object.keys(profiles).length > 0;
    const adapterHost = await options.adapterHost(scope.request, purpose);
    const secretGuards = new Map<string, string>();
    const secretReaders = new Map<string, () => Promise<string | undefined>>();
    const pluginGuards = new Map<string, LocalHostResolvedPluginEnvironment>();
    const pluginReaders = new Map<string, () => Promise<string | undefined>>();
    let secretsChangedDuringCompile = false;
    let pluginsChangedDuringCompile = false;
    const guardPlugins = (
      plugins: NonNullable<PragmaCompileOptions["plugins"]>,
    ): NonNullable<PragmaCompileOptions["plugins"]> => ({
      inspect: (input) => plugins.inspect(input),
      async resolve(input) {
        const inspect = async () => pluginInspectionFingerprint(await plugins.inspect(input));
        const before = await inspect();
        const resolved = await plugins.resolve(input);
        const actual = pluginResolutionFingerprint(resolved);
        const after = await inspect();
        const key = pluginGuardKey(input);
        const previous = pluginGuards.get(key);
        if (
          before !== actual ||
          after !== actual ||
          (previous !== undefined && previous.fingerprint !== actual)
        ) {
          pluginsChangedDuringCompile = true;
          throw new MissionCompileEnvironmentChangedError();
        }
        pluginGuards.set(key, { ...input, fingerprint: actual });
        pluginReaders.set(key, inspect);
        return resolved;
      },
    });
    const guardAdapterHost = (host: PragmaAdapterHost): PragmaAdapterHost => ({
      ...host,
      environmentId: host.environmentId,
      projectRoot: host.projectRoot,
      resolveBinding: async (ref) => {
        const id = options.capabilityAuthority?.getCapabilityId(ref);
        const pin =
          purpose === "stop"
            ? undefined
            : snapshot?.capabilities.find((entry) => entry.capabilityId === id);
        const binding = await host.resolveBinding(
          ref,
          pin === undefined ? undefined : { revision: String(pin.resolvedRevision) },
        );
        if (pin !== undefined && binding?.revision !== String(pin.resolvedRevision))
          throw new Error(`mission_pinned_binding_unavailable: ${ref}@${pin.resolvedRevision}`);
        return binding;
      },
      resolveArtifact: (source) => host.resolveArtifact(source),
      ...(host.openFileContextStore === undefined
        ? {}
        : {
            openFileContextStore: (input: { readonly rootDir: string }) =>
              host.openFileContextStore!(input),
          }),
      async resolveSecret(ref) {
        const before = await options.secretFingerprint?.(ref);
        const value = await host.resolveSecret(ref);
        const after =
          options.secretFingerprint === undefined
            ? hash(value ?? null)
            : await options.secretFingerprint(ref);
        const previous = secretGuards.get(ref);
        if (
          (before !== undefined && before !== after) ||
          (previous !== undefined && previous !== after)
        ) {
          secretsChangedDuringCompile = true;
          throw new MissionCompileEnvironmentChangedError();
        }
        secretGuards.set(ref, after);
        secretReaders.set(ref, () => host.resolveSecret(ref));
        return value;
      },
    });
    const completed = new Map<
      string,
      {
        readonly resource?: PragmaInvocableResource | undefined;
        readonly compiled: CompiledResource<InvocableResource>;
      }
    >();
    const pending = new Map<
      string,
      Promise<{
        readonly resource?: PragmaInvocableResource | undefined;
        readonly compiled: CompiledResource<InvocableResource>;
      }>
    >();
    const dependencies = new Map<string, Set<string>>();
    const reaches = (from: string, target: string, visited = new Set<string>()): boolean => {
      if (from === target) return true;
      if (visited.has(from)) return false;
      visited.add(from);
      return [...(dependencies.get(from) ?? [])].some((ref) => reaches(ref, target, visited));
    };
    const compileSource = async (
      source: LocalHostSystemExecutorSource,
      ref: string,
      resolveExternalInvocable: PragmaCompileOptions["resolveExternalInvocable"],
    ) => {
      const override =
        scope.request.modelOverride === undefined || ref !== scope.request.executor.ref
          ? undefined
          : {
              model: {
                providerId: scope.request.modelOverride.providerId,
                modelId: scope.request.modelOverride.modelId,
              },
              ...(scope.request.modelOverride.thinkingLevel === undefined
                ? {}
                : { thinkingLevel: scope.request.modelOverride.thinkingLevel }),
            };
      return await compileBuiltInAgent({
        ...source,
        expertExecutionProfiles: profiles,
        compilationPurpose: purpose,
        ...(source.plugins === undefined && options.plugins === undefined
          ? {}
          : { plugins: guardPlugins(source.plugins ?? options.plugins!) }),
        ...(source.adapterHost === undefined
          ? {}
          : { adapterHost: guardAdapterHost(source.adapterHost) }),
        ...(purpose === "stop" ? { runtimes: undefined } : {}),
        ...(override === undefined
          ? {}
          : source.rootExecutionOverride === undefined
            ? { rootModelSelectionOverride: override }
            : {
                rootExecutionOverride: {
                  ...source.rootExecutionOverride,
                  modelSelection: override,
                },
              }),
        resolveExternalInvocable,
      });
    };
    const compileRef = async (
      ref: PragmaResourceRef,
      ancestors: ReadonlySet<string> = new Set(),
    ): Promise<{
      readonly resource?: PragmaInvocableResource | undefined;
      readonly compiled: CompiledResource<InvocableResource>;
    }> => {
      const cached = completed.get(ref);
      if (cached !== undefined) return cached;
      if (ancestors.has(ref)) throw new Error(`Cyclic external resource dependency: ${ref}`);
      const inFlight = pending.get(ref);
      if (inFlight !== undefined) return await inFlight;
      const nextAncestors = new Set(ancestors).add(ref);
      const operation = Promise.resolve().then(async () => {
        const resolveExternalInvocable: NonNullable<
          PragmaCompileOptions["resolveExternalInvocable"]
        > = async (targetRef) => {
          // Parallel sibling compilations can create a cycle without sharing ancestors.
          // Check the request graph before awaiting another in-flight compilation.
          if (reaches(targetRef, ref))
            throw new Error(`Cyclic external resource dependency: ${targetRef}`);
          const targets = dependencies.get(ref) ?? new Set<string>();
          targets.add(targetRef);
          dependencies.set(ref, targets);
          const target = await compileRef(targetRef, nextAncestors);
          if (target.resource === undefined)
            throw new Error(`System resource descriptor not found: ${targetRef}`);
          return { resource: target.resource, value: target.compiled.value };
        };
        const request =
          ref === scope.request.executor.ref
            ? scope.request
            : ({
                ...scope.request,
                modelOverride: undefined,
                executor: {
                  kind: ref.startsWith("team:")
                    ? "team"
                    : ref.startsWith("flow:")
                      ? "flow"
                      : "expert",
                  ref,
                  name: ref,
                },
              } as Request);
        options.onCompile?.({ requestId: scope.request.id, ref, purpose });
        const pinnedSource = snapshot?.sources[ref];
        let source =
          preparedSources.get(scope)?.get(ref) ??
          (await options.systemExecutors?.prepare(
            request,
            runtimes,
            purpose,
            adapterHost,
            pinnedSource,
          ));
        if (snapshot !== undefined) {
          if (pinnedSource === undefined) source = undefined;
          else {
            if (source === undefined)
              throw new Error(`mission_pinned_executor_unavailable: ${ref}`);
            // A current profile is still an overlay when switching back to the birth
            // snapshot's values after an intervening execution used another profile.
            if (
              source.rootExecutionOverride !== undefined ||
              JSON.stringify(source.rootExecutionOverride) !==
                JSON.stringify(pinnedSource.rootExecutionOverride) ||
              JSON.stringify(source.defaultModelSelection) !==
                JSON.stringify(pinnedSource.defaultModelSelection)
            ) {
              hasExecutionProfileOverlay = true;
            }
            const { expertResource, ...profile } = pinnedSource;
            if (expertResource !== undefined && expertResource.kind !== "Expert")
              throw new Error(`Invalid pinned Expert: ${ref}`);
            source = {
              ...source,
              ...profile,
              expertResource,
              rootExecutionOverride: source.rootExecutionOverride,
              rootModelSelectionOverride: source.rootModelSelectionOverride,
              defaultModelSelection: source.defaultModelSelection,
            };
          }
        }
        const systemResource =
          snapshot === undefined
            ? options.systemExecutors?.getResource?.(ref)
            : snapshot.resources.find(
                (resource): resource is PragmaInvocableResource =>
                  canonicalPragmaResourceRef(resource) === ref &&
                  (resource.kind === "Expert" ||
                    resource.kind === "ExpertTeam" ||
                    resource.kind === "Flow"),
              );
        if (
          source !== undefined &&
          (systemResource !== undefined || ref === scope.request.executor.ref)
        ) {
          const compiled = await compileSource(source, ref, resolveExternalInvocable);
          const resolved = { resource: systemResource, compiled };
          completed.set(ref, resolved);
          return resolved;
        }
        const revision = await scope.getRevision();
        const resource = revision.resources.find(
          (candidate): candidate is PragmaInvocableResource =>
            (candidate.kind === "Expert" ||
              candidate.kind === "ExpertTeam" ||
              candidate.kind === "Flow") &&
            canonicalPragmaResourceRef(candidate) === ref,
        );
        if (resource === undefined) throw new Error(`Pragma resource not found: ${ref}`);
        const compiled =
          source !== undefined
            ? await compileSource(source, ref, resolveExternalInvocable)
            : await options.revisionSource.withProject(
                scope.request.project,
                async (project) =>
                  await project.compile<InvocableResource>(ref, {
                    compilationPurpose: purpose,
                    expertExecutionProfiles: profiles,
                    workspace: scope.request.workspace.path,
                    projectRoot: dirname(project.entryFile),
                    pragmaHome: options.pragmaHome,
                    environmentId: options.environmentId,
                    adapterHost: guardAdapterHost(
                      purpose === "stop"
                        ? adapterHost
                        : (options.adaptAdapterHost?.(request, adapterHost) ?? adapterHost),
                    ),
                    runtimes: purpose === "stop" ? undefined : runtimes,
                    resolveExternalInvocable,
                    ...(scope.request.modelOverride === undefined ||
                    ref !== scope.request.executor.ref
                      ? {}
                      : {
                          rootModelSelectionOverride: {
                            model: {
                              providerId: scope.request.modelOverride.providerId,
                              modelId: scope.request.modelOverride.modelId,
                            },
                            ...(scope.request.modelOverride.thinkingLevel === undefined
                              ? {}
                              : { thinkingLevel: scope.request.modelOverride.thinkingLevel }),
                          },
                        }),
                    plugins:
                      options.plugins === undefined ? undefined : guardPlugins(options.plugins),
                    loggerProvider: options.loggerProvider,
                  }),
                revision,
              );
        const expected = revision.derivedProjectFingerprint ?? revision.projectFingerprint;
        if (
          source === undefined &&
          expected !== undefined &&
          compiled.projectFingerprint !== expected
        )
          throw new Error(
            `Compiled project fingerprint does not match the ${revision.derivedProjectFingerprint === undefined ? "published" : "derived compiler view"} revision: ${revision.projectId}@${revision.revision}.`,
          );
        const resolved = { resource, compiled };
        completed.set(ref, resolved);
        return resolved;
      });
      pending.set(ref, operation);
      return await operation;
    };
    try {
      const compiled = (await compileRef(scope.request.executor.ref as PragmaResourceRef)).compiled;
      const secrets = [...secretGuards]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([ref, fingerprint]) => ({ ref, fingerprint }));
      const plugins = [...pluginGuards]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([, plugin]) => plugin);
      secretReadersByGuards.set(secrets, secretReaders);
      pluginReadersByGuards.set(plugins, pluginReaders);
      compilationResources.set(compiled, {
        secrets,
        readers: secretReaders,
        plugins,
        pluginReaders,
      });
      // Tool-call delegation and Team launchers share these resolved live profiles.
      // Keep this guard separate from persisted structural definition fingerprints.
      executionProfilesFingerprints.set(compiled, hash(profiles ?? {}));
      if (hasExecutionProfileOverlay) profileOverlayCompilations.add(compiled);
      return compiled;
    } catch (error) {
      if (secretsChangedDuringCompile || pluginsChangedDuringCompile)
        throw new MissionCompileEnvironmentChangedError();
      throw error;
    }
  };
  const compileStable = async (
    scope: LocalHostMissionCompileScope<Request>,
    runtimes: RuntimeResolver,
  ): Promise<LocalHostStableMissionCompilation> => {
    await ensureSnapshot(scope, runtimes);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await capabilities(scope);
      const beforeIdentity = await identity(scope, before, runtimes);
      let compiled: CompiledResource<InvocableResource>;
      try {
        compiled = await compile(scope, runtimes);
      } catch (error) {
        if (error instanceof MissionCompileEnvironmentChangedError) continue;
        throw error;
      }
      const after = await capabilities(scope);
      const afterIdentity = await identity(scope, after, runtimes);
      const resourceCompilation = compilationResources.get(compiled)!;
      const secretsStable = (
        await Promise.all(
          resourceCompilation.secrets.map(
            async (secret) =>
              secret.fingerprint ===
              (await secretFingerprint(secret.ref, resourceCompilation.readers.get(secret.ref)!)),
          ),
        )
      ).every(Boolean);
      const pluginsStable = (
        await Promise.all(
          resourceCompilation.plugins.map(
            async (plugin) =>
              plugin.fingerprint ===
              (await resourceCompilation.pluginReaders.get(pluginGuardKey(plugin))!()),
          ),
        )
      ).every(Boolean);
      if (
        beforeIdentity === afterIdentity &&
        JSON.stringify(before) === JSON.stringify(after) &&
        secretsStable &&
        pluginsStable
      )
        return {
          compiled,
          capabilities: after,
          secrets: resourceCompilation.secrets,
          plugins: resourceCompilation.plugins,
          identity: afterIdentity,
          executionProfilesFingerprint: executionProfilesFingerprints.get(compiled),
          ...("kind" in compiled.value && compiled.value.kind === "flow"
            ? {}
            : { definitionFingerprint: fingerprintExpertExecutionDefinition(compiled.value) }),
        };
    }
    throw new Error(
      `Mission compilation environment changed repeatedly while compiling: ${scope.request.id}`,
    );
  };
  const ensureSnapshot = async (
    scope: LocalHostMissionCompileScope<Request>,
    runtimes: RuntimeResolver,
  ): Promise<void> => {
    const path = executionSnapshotPath(scope.request);
    if (
      path === undefined ||
      (await readSnapshot(scope)) !== undefined ||
      scope.request.execution?.sessionId !== undefined
    )
      return;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await withFileLock(`${path}.lock`, async () => {
      const existing = await readMissionExecutionSnapshot(path);
      if (existing !== undefined) {
        snapshots.delete(scope);
        await readSnapshot(scope);
        return;
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const pins = await capabilities(scope);
        const before = await identity(scope, pins, runtimes);
        const resources: PragmaResource[] = [];
        const pluginRefs = new Set<string>();
        const fingerprints: [string, string][] = [];
        await visitDependencies(scope, (resource, ref, fingerprint) => {
          if (resource?.kind === "Expert")
            for (const plugin of resource.spec.plugins) pluginRefs.add(plugin.ref);
          // Project resources are already pinned by the Project Revision.
          const system =
            options.systemExecutors?.getDependencyResource?.(ref) ??
            options.systemExecutors?.getResource?.(ref);
          if (system !== undefined && resource !== undefined)
            resources.push(structuredClone(resource));
          if (fingerprint !== undefined) fingerprints.push([ref, fingerprint]);
        });
        const sources: MissionExecutionSnapshot["sources"] = {};
        const prepared = new Map<string, LocalHostSystemExecutorSource>();
        const host = await options.adapterHost(scope.request, "execute");
        const sourceRefs = new Set([
          scope.request.executor.ref,
          ...fingerprints.map(([ref]) => ref),
          ...resources
            .filter((resource) => resource.kind === "Expert")
            .map(canonicalPragmaResourceRef),
        ]);
        for (const ref of sourceRefs) {
          const source = await options.systemExecutors?.prepare(
            {
              ...scope.request,
              executor:
                ref === scope.request.executor.ref
                  ? scope.request.executor
                  : { kind: "expert", ref, name: ref },
              // Freeze the underlying profile. compileSource applies the current Mission option.
              modelOverride: undefined,
            },
            runtimes,
            "execute",
            host,
          );
          if (source === undefined) continue;
          prepared.set(ref, source);
          const resource = source.expertResource ?? options.systemExecutors?.getResource?.(ref);
          sources[ref] = {
            ...(resource === undefined ? {} : { expertResource: structuredClone(resource) }),
            additionalResources: structuredClone([...(source.additionalResources ?? [])]),
            ...(source.rootExecutionOverride === undefined
              ? {}
              : { rootExecutionOverride: source.rootExecutionOverride }),
            ...(source.rootModelSelectionOverride === undefined
              ? {}
              : { rootModelSelectionOverride: source.rootModelSelectionOverride }),
            ...(source.defaultModelSelection === undefined
              ? {}
              : { defaultModelSelection: source.defaultModelSelection }),
          };
        }
        if (before !== (await identity(scope, await capabilities(scope), runtimes))) continue;
        const snapshot: MissionExecutionSnapshot = {
          schemaVersion: "pragma.mission-execution-snapshot/v2",
          missionId: scope.request.id,
          project: scope.request.project,
          executorRef: scope.request.executor.ref,
          resources,
          fingerprints: fingerprints.sort(([left], [right]) => left.localeCompare(right)),
          capabilities: pins,
          pluginRefs: [...pluginRefs].sort(),
          sources,
        };
        await writeMissionExecutionSnapshot(path, snapshot);
        preparedSources.set(scope, prepared);
        snapshots.set(scope, Promise.resolve(snapshot));
        return;
      }
      throw new Error(`mission_execution_snapshot_unstable: ${scope.request.id}`);
    });
  };
  return {
    isExecutionPinned: async (scope) => (await readSnapshot(scope)) !== undefined,
    allowsExecutionProfileSuccessor: (compiled) => profileOverlayCompilations.has(compiled),
    executionProfilesFingerprintFor: (compiled) => executionProfilesFingerprints.get(compiled),
    createRequestScope,
    capabilities,
    identity,
    compile,
    compileStable,
    secretsFor: (compiled) => compilationResources.get(compiled)?.secrets,
    pluginsFor: (compiled) => compilationResources.get(compiled)?.plugins,
    async runtimeIds(scope, runtimes) {
      const ids = new Set<string>();
      const snapshot = await readSnapshot(scope);
      const profiles = await executionProfiles(scope);
      const resources = new Map<string, PragmaResource>();
      await visitDependencies(scope, (resource, ref) => {
        if (resource !== undefined) resources.set(ref, resource);
      });
      const profileRefs = new Set<string>();
      for (const [ref, resource] of resources) {
        if (resource.kind === "Expert") {
          // Match compileExpert: live profiles replace the pinned RuntimeProfile.
          const profile = profiles[resource.metadata.id];
          const pinnedOverride = snapshot?.sources[ref]?.rootExecutionOverride;
          if (
            pinnedOverride !== undefined &&
            options.systemExecutors?.tracksDefaultRuntime === false
          )
            ids.add(pinnedOverride.runtimeId);
          else if (profile !== undefined) {
            if (profile !== null) ids.add(profile.runtimeId);
            else if (runtimes !== undefined) ids.add(await runtimes.getDefaultRuntimeId());
          } else if (resource.spec.runtime !== undefined)
            profileRefs.add(resource.spec.runtime.ref);
          else if (runtimes !== undefined) ids.add(await runtimes.getDefaultRuntimeId());
        } else {
          // Explicit Flow/team Runtime bindings remain authoritative independently of Expert defaults.
          for (const dependency of referencedPragmaResourceRefs([resource]))
            if (dependency.startsWith("runtime-profile:")) profileRefs.add(dependency);
        }
      }
      for (const ref of profileRefs) {
        const resource = resources.get(ref);
        if (resource?.kind === "RuntimeProfile") {
          const config = resource.spec.config as { runtimeId?: unknown };
          if (typeof config.runtimeId === "string") ids.add(config.runtimeId);
        }
      }
      // Some host-owned sources have no declarative Expert resource.
      for (const [ref, source] of Object.entries(snapshot?.sources ?? {}))
        if (!resources.has(ref) && source.rootExecutionOverride !== undefined)
          ids.add(source.rootExecutionOverride.runtimeId);
      return [...ids];
    },
    async prepare(scope, runtimes, owner) {
      const identityStartedAt = performance.now();
      const active = await capabilities(scope);
      const snapshot = await readSnapshot(scope);
      const desiredIdentity = await identity(scope, active, runtimes);
      let cacheHit =
        owner?.hasOwner === true &&
        owner.identity === desiredIdentity &&
        (snapshot === undefined || JSON.stringify(owner.capabilities) === JSON.stringify(active)) &&
        owner.secrets !== undefined &&
        owner.plugins !== undefined;
      if (cacheHit && owner!.secrets!.length > 0) {
        const readers = secretReadersByGuards.get(owner!.secrets!);
        if (options.secretFingerprint === undefined && readers === undefined) cacheHit = false;
        else
          cacheHit = (
            await Promise.all(
              owner!.secrets!.map(
                async (secret) =>
                  secret.fingerprint ===
                  (await secretFingerprint(secret.ref, () => readers!.get(secret.ref)!())),
              ),
            )
          ).every(Boolean);
      }
      if (cacheHit && owner!.plugins!.length > 0) {
        const readers = pluginReadersByGuards.get(owner!.plugins!);
        cacheHit = (
          await Promise.all(
            owner!.plugins!.map(async (plugin) => {
              const read = readers?.get(pluginGuardKey(plugin));
              const fingerprint =
                read !== undefined
                  ? await read()
                  : options.plugins === undefined
                    ? undefined
                    : pluginInspectionFingerprint(
                        await options.plugins.inspect({
                          expertRef: plugin.expertRef,
                          binding: plugin.binding,
                        }),
                      );
              return plugin.fingerprint === fingerprint;
            }),
          )
        ).every(Boolean);
      }
      const identityDurationMs = performance.now() - identityStartedAt;
      let compilation: Promise<LocalHostStableMissionCompilation> | undefined;
      const ensureCompiled = () => (compilation ??= compileStable(scope, runtimes));
      if (cacheHit)
        return {
          cacheHit,
          definitionChanged: false,
          identityDurationMs,
          compileDurationMs: 0,
          identity: desiredIdentity,
          capabilities: active,
          definitionFingerprint: owner!.definitionFingerprint,
          executionProfilesFingerprint: owner!.executionProfilesFingerprint,
          secrets: owner!.secrets!,
          plugins: owner!.plugins!,
          ensureCompiled,
        };
      const compileStartedAt = performance.now();
      const result = await ensureCompiled();
      const compileDurationMs = performance.now() - compileStartedAt;
      const executionProfilesChanged =
        owner?.hasOwner === true &&
        owner.executionProfilesFingerprint !== undefined &&
        owner.executionProfilesFingerprint !== result.executionProfilesFingerprint;
      const definitionChanged =
        owner?.hasOwner === true &&
        (executionProfilesChanged ||
          (owner.secrets === undefined
            ? result.secrets.length > 0
            : JSON.stringify(owner.secrets) !== JSON.stringify(result.secrets)) ||
          (owner.plugins === undefined
            ? result.plugins.length > 0
            : JSON.stringify(owner.plugins) !== JSON.stringify(result.plugins)) ||
          (result.definitionFingerprint !== undefined &&
            (owner.capabilities === undefined ||
              JSON.stringify(owner.capabilities) !== JSON.stringify(result.capabilities) ||
              (owner.definitionFingerprint !== undefined &&
                owner.definitionFingerprint !== result.definitionFingerprint))));
      // Secret/Plugin refresh can rebind a compatible definition to the same durable
      // Session after releasing its old handle. It must not create a new conversation.
      const refreshEnvironment =
        definitionChanged &&
        !executionProfilesChanged &&
        (await readSnapshot(scope)) !== undefined &&
        owner?.definitionFingerprint !== undefined &&
        owner.definitionFingerprint === result.definitionFingerprint;
      return {
        cacheHit,
        definitionChanged: definitionChanged && !refreshEnvironment,
        refreshEnvironment,
        identityDurationMs,
        compileDurationMs,
        ...result,
        ensureCompiled,
      };
    },
  };
}

class MissionCompileEnvironmentChangedError extends Error {
  constructor() {
    super("Mission resource environment changed while compiling.");
  }
}

function pluginGuardKey(
  plugin: Pick<LocalHostResolvedPluginEnvironment, "expertRef" | "binding">,
): string {
  return JSON.stringify({ expertRef: plugin.expertRef, binding: plugin.binding });
}

function pluginResolutionFingerprint(plugin: {
  readonly packageFingerprint: string;
  readonly verificationFingerprint: string;
  readonly bindingFingerprint?: string | undefined;
}): string {
  return hash({
    packageFingerprint: plugin.packageFingerprint,
    verificationFingerprint: plugin.verificationFingerprint,
    ...(plugin.bindingFingerprint !== undefined
      ? { bindingFingerprint: plugin.bindingFingerprint }
      : {}),
  });
}

function pluginInspectionFingerprint(
  plugin: Awaited<ReturnType<NonNullable<PragmaCompileOptions["plugins"]>["inspect"]>>,
): string | undefined {
  return plugin.status === "ready" &&
    plugin.packageFingerprint !== undefined &&
    plugin.verificationFingerprint !== undefined
    ? pluginResolutionFingerprint({
        packageFingerprint: plugin.packageFingerprint,
        verificationFingerprint: plugin.verificationFingerprint,
        bindingFingerprint: plugin.bindingFingerprint,
      })
    : undefined;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Traverse only the target graph, including customized system dependencies. */
export async function resolveMissionSystemDependencyFingerprints(input: {
  readonly mission: Pick<LocalHostMissionCompileRequest, "project" | "executor">;
  readonly project: {
    readonly getRevision: (
      revision: number,
    ) => Promise<{ readonly resources: readonly PragmaResource[] }>;
  };
  readonly getSystemExecutorFingerprint?:
    ((ref: string) => string | undefined | Promise<string | undefined>) | undefined;
  readonly getSystemExecutorResource?: ((ref: string) => PragmaResource | undefined) | undefined;
}): Promise<readonly (readonly [string, string])[]> {
  const fingerprints = new Map<string, string>();
  const visited = new Set<string>();
  let snapshot: Promise<{ readonly resources: readonly PragmaResource[] }> | undefined;
  const visit = async (ref: string): Promise<void> => {
    if (visited.has(ref)) return;
    visited.add(ref);
    const fingerprint = await input.getSystemExecutorFingerprint?.(ref);
    if (fingerprint !== undefined) fingerprints.set(ref, fingerprint);
    const system = input.getSystemExecutorResource?.(ref);
    if (system === undefined && fingerprint !== undefined) return;
    const resource =
      system ??
      (
        await (snapshot ??= input.project.getRevision(input.mission.project.revision))
      ).resources.find((candidate) => canonicalPragmaResourceRef(candidate) === ref);
    if (resource !== undefined)
      await Promise.all([...referencedPragmaResourceRefs([resource])].map(visit));
  };
  await visit(input.mission.executor.ref);
  return [...fingerprints.entries()].toSorted(([left], [right]) => left.localeCompare(right));
}
