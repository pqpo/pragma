import { createIntegrationError } from "@pragma/shared/integration";
import type {
  PragmaLogger,
  ResolvedRuntime,
  RuntimeAdapter,
  RuntimeModelSelection,
  RuntimeResolver,
} from "@pragma/core";
import type {
  RuntimeEnvironmentDefinition,
  RuntimeEnvironmentRevision,
} from "../../deployment-contracts/index.ts";
import type {
  RuntimeEnvironmentHead,
  RuntimeEnvironmentStore,
} from "./runtime-environment-store.ts";
export interface RuntimeEnvironmentAdapterFactory {
  readonly id: string;
  readonly version: string;
  /**
   * Captures dynamic factory inputs once for one materialization attempt.
   *
   * The returned cache key and `create` closure must describe the same snapshot.
   * This prevents a settings change from caching an adapter under one value while
   * constructing it with a newer value.
   */
  readonly prepare?: (
    environment: RuntimeEnvironmentDefinition,
    context?: { readonly permissionModeId?: string | undefined },
  ) =>
    | RuntimeEnvironmentAdapterPreparation
    | Promise<RuntimeEnvironmentAdapterPreparation>
    | undefined
    | Promise<undefined>;
  readonly create: (
    environment: RuntimeEnvironmentDefinition,
    context?: { readonly permissionModeId?: string | undefined },
  ) => RuntimeAdapter | Promise<RuntimeAdapter>;
}

export interface RuntimeEnvironmentAdapterPreparation {
  readonly cacheKey: string;
  readonly create: () => RuntimeAdapter | Promise<RuntimeAdapter>;
}

export interface RuntimeEnvironmentInspection {
  readonly head: RuntimeEnvironmentHead;
  readonly adapter?: RuntimeAdapter | undefined;
  readonly error?: string | undefined;
}

export interface RuntimeEnvironmentService extends RuntimeResolver {
  list(): Promise<readonly RuntimeEnvironmentInspection[]>;
  getMaterializationCacheKey(): Promise<string>;
  invalidateModelValidation?(): void;
}

export function createRuntimeEnvironmentService(options: {
  readonly store: RuntimeEnvironmentStore;
  readonly factories: readonly RuntimeEnvironmentAdapterFactory[];
  /** Retired IDs apply only when no persisted Environment owns that identity. */
  readonly bindAliases?: Readonly<Record<string, string>> | undefined;
  readonly logger?: Pick<PragmaLogger, "info" | "debug" | "warn"> | undefined;
  readonly getMaterializationCacheKey?: (() => string | Promise<string>) | undefined;
}): RuntimeEnvironmentService {
  const MATERIALIZED_ADAPTER_CACHE_LIMIT = 64;
  const factories = new Map<string, RuntimeEnvironmentAdapterFactory>();
  const materializedAdapters = new Map<string, Promise<RuntimeAdapter>>();
  for (const factory of options.factories) {
    const ref = factoryRef(factory.id, factory.version);
    if (factories.has(ref)) throw new Error(`Duplicate Runtime adapter factory: ${ref}.`);
    factories.set(ref, factory);
  }
  let modelGeneration = 0;
  const getMaterializationCacheKey = async (): Promise<string> =>
    `${(await options.getMaterializationCacheKey?.()) ?? "default"}\0models=${modelGeneration}`;

  const materialize = async (
    revision: RuntimeEnvironmentRevision,
    permissionModeId?: string,
  ): Promise<ResolvedRuntime> => {
    const definition = revision.definition;
    const ref = factoryRef(definition.adapter.id, definition.adapter.version);
    const factory = factories.get(ref);
    if (factory === undefined)
      throw runtimeUnavailable(
        "adapter_factory_missing",
        `Runtime adapter factory is not registered: ${ref}.`,
      );
    const factoryContext = { permissionModeId };
    const preparation = await factory.prepare?.(definition, factoryContext);
    const materializationCacheKey = [
      await getMaterializationCacheKey(),
      preparation?.cacheKey ?? "default",
    ].join("\0");
    const cacheKey = [
      revision.runtimeId,
      revision.revision,
      revision.fingerprint,
      ref,
      permissionModeId ?? "default",
      materializationCacheKey,
    ].join("\0");
    let adapterPromise = materializedAdapters.get(cacheKey);
    const cacheHit = adapterPromise !== undefined;
    if (adapterPromise === undefined) {
      const materializeStartedAt = performance.now();
      adapterPromise = Promise.resolve(
        preparation?.create() ?? factory.create(definition, factoryContext),
      );
      void adapterPromise
        .then(
          () => {
            options.logger?.info(
              "runtime.environment_adapter_materialized",
              "Runtime Environment adapter materialized",
              {
                runtimeId: revision.runtimeId,
                revision: revision.revision,
                fingerprint: revision.fingerprint,
                materializationCacheKey,
                durationMs: environmentElapsedMs(materializeStartedAt),
              },
            );
          },
          (error: unknown) => {
            if (materializedAdapters.get(cacheKey) === adapterPromise) {
              materializedAdapters.delete(cacheKey);
            }
            options.logger?.warn(
              "runtime.environment_adapter_materialization_failed",
              "Runtime Environment adapter materialization failed",
              {
                runtimeId: revision.runtimeId,
                revision: revision.revision,
                fingerprint: revision.fingerprint,
                materializationCacheKey,
                durationMs: environmentElapsedMs(materializeStartedAt),
                error,
              },
            );
          },
        )
        .catch(() => undefined);
      materializedAdapters.set(cacheKey, adapterPromise);
      while (materializedAdapters.size > MATERIALIZED_ADAPTER_CACHE_LIMIT) {
        const oldest = materializedAdapters.keys().next().value as string | undefined;
        if (oldest === undefined || oldest === cacheKey) break;
        materializedAdapters.delete(oldest);
      }
    } else {
      materializedAdapters.delete(cacheKey);
      materializedAdapters.set(cacheKey, adapterPromise);
    }
    const adapter = await adapterPromise;
    const catalog = adapter.descriptor.permissionModes;
    const effectiveModeId = permissionModeId ?? catalog?.defaultModeId;
    if (
      effectiveModeId !== undefined &&
      !catalog?.modes.some((mode) => mode.id === effectiveModeId && mode.available)
    ) {
      throw runtimeUnavailable(
        "permission_mode_unavailable",
        `Unsupported permission mode for ${revision.runtimeId}: ${effectiveModeId}`,
      );
    }
    if (
      adapter.descriptor.configuredPermissionModeId !== undefined &&
      adapter.descriptor.configuredPermissionModeId !== effectiveModeId
    ) {
      throw runtimeUnavailable(
        "permission_mode_mismatch",
        `Runtime factory did not apply the requested permission mode: ${revision.runtimeId}/${effectiveModeId}.`,
      );
    }
    if (permissionModeId === undefined && effectiveModeId !== undefined) {
      const explicitKey = [
        revision.runtimeId,
        revision.revision,
        revision.fingerprint,
        ref,
        effectiveModeId,
        materializationCacheKey,
      ].join("\0");
      materializedAdapters.set(explicitKey, adapterPromise);
      while (materializedAdapters.size > MATERIALIZED_ADAPTER_CACHE_LIMIT)
        materializedAdapters.delete(materializedAdapters.keys().next().value!);
    }
    if (cacheHit) {
      options.logger?.debug(
        "runtime.environment_adapter_cache_hit",
        "Reused a Runtime Environment adapter",
        {
          runtimeId: revision.runtimeId,
          revision: revision.revision,
          fingerprint: revision.fingerprint,
          materializationCacheKey,
        },
      );
    }
    if (adapter.descriptor.id !== definition.id) {
      throw new Error(
        `Runtime adapter identity mismatch: expected ${definition.id}, received ${adapter.descriptor.id}.`,
      );
    }
    return {
      adapter,
      binding: {
        runtimeId: revision.runtimeId,
        ...(effectiveModeId === undefined ? {} : { permissionModeId: effectiveModeId }),
        revision: revision.revision,
        fingerprint: revision.fingerprint,
      },
    };
  };

  let modelCatalogs = new WeakMap<
    RuntimeAdapter,
    { expiresAt: number; value: ReturnType<NonNullable<RuntimeAdapter["listModels"]>> }
  >();
  const validateModelSelection = async (
    resolved: ResolvedRuntime,
    selection: RuntimeModelSelection | undefined,
  ): Promise<void> => {
    if (selection === undefined) return;
    if (resolved.adapter.listModels === undefined) {
      throw runtimeUnavailable(
        "model_catalog_unavailable",
        `Runtime does not expose a model catalog: ${resolved.binding.runtimeId}.`,
      );
    }
    const discoveryStartedAt = performance.now();
    let catalog = modelCatalogs.get(resolved.adapter);
    if (catalog === undefined || catalog.expiresAt <= Date.now()) {
      const value = resolved.adapter
        .listModels()
        .then((models) => {
          const entry = modelCatalogs.get(resolved.adapter);
          if (entry?.value === value) entry.expiresAt = Date.now() + 30_000;
          return models;
        })
        .catch((error: unknown) => {
          if (modelCatalogs.get(resolved.adapter)?.value === value)
            modelCatalogs.delete(resolved.adapter);
          throw error;
        });
      catalog = { expiresAt: Infinity, value };
      modelCatalogs.set(resolved.adapter, catalog);
    }
    const models = await catalog.value;
    options.logger?.debug(
      "runtime.model_catalog_validation",
      "Runtime model selection catalog validation completed",
      {
        runtimeId: resolved.binding.runtimeId,
        revision: resolved.binding.revision,
        fingerprint: resolved.binding.fingerprint,
        durationMs: environmentElapsedMs(discoveryStartedAt),
        modelCount: models.length,
      },
    );
    const model = models.find(
      (candidate) =>
        candidate.id === selection.model.modelId &&
        candidate.provider.id === selection.model.providerId,
    );
    if (model === undefined) {
      throw runtimeUnavailable(
        "model_unavailable",
        `Runtime model is unavailable: ${resolved.binding.runtimeId}/${selection.model.providerId}/${selection.model.modelId}.`,
      );
    }
    if (
      selection.thinkingLevel !== undefined &&
      !model.thinking?.supportedLevels.some((level) => level.value === selection.thinkingLevel)
    ) {
      throw runtimeUnavailable(
        "thinking_level_unavailable",
        `Runtime thinking level is unavailable: ${resolved.binding.runtimeId}/${selection.model.modelId}/${selection.thinkingLevel}.`,
      );
    }
  };

  const createResolver = (): RuntimeResolver => ({
    getDefaultRuntimeId: async () => await options.store.getDefaultRuntimeId(),
    bind: async (request = {}) => {
      let runtimeId = request.runtimeId ?? (await options.store.getDefaultRuntimeId());
      let revision = await options.store.getRevision(runtimeId);
      const alias = options.bindAliases?.[runtimeId];
      if (revision === undefined && alias !== undefined) {
        runtimeId = alias;
        revision = await options.store.getRevision(runtimeId);
      }
      if (revision === undefined || revision.status !== "active") {
        throw runtimeUnavailable(
          "environment_inactive",
          `Runtime Environment is not active: ${runtimeId}.`,
        );
      }
      const resolved = await materialize(revision, request.permissionModeId);
      await validateModelSelection(resolved, request.modelSelection);
      return resolved;
    },
    resolve: async ({ binding, modelSelection }) => {
      const revision = await options.store.getRevision(binding.runtimeId, binding.revision);
      if (
        revision === undefined ||
        revision.status !== "active" ||
        revision.fingerprint !== binding.fingerprint
      ) {
        throw runtimeUnavailable(
          "environment_binding_unavailable",
          `Runtime Environment binding is unavailable: ${binding.runtimeId}@${binding.revision}.`,
        );
      }
      const resolved = await materialize(revision, binding.permissionModeId);
      await validateModelSelection(resolved, modelSelection);
      return resolved;
    },
  });

  return {
    ...createResolver(),
    getMaterializationCacheKey,
    invalidateModelValidation: () => {
      modelCatalogs = new WeakMap();
      modelGeneration++;
    },
    list: async () =>
      await Promise.all(
        (await options.store.listHeads()).map(
          async (head): Promise<RuntimeEnvironmentInspection> => {
            if (head.error !== undefined) return { head, error: head.error };
            if (head.revision === undefined || head.revision.status === "deleted") return { head };
            try {
              return { head, adapter: (await materialize(head.revision)).adapter };
            } catch (error) {
              return { head, error: errorMessage(error) };
            }
          },
        ),
      ),
  };
}

function environmentElapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function factoryRef(id: string, version: string): string {
  return `${id}@${version}`;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Runtime Environment is invalid.";
}

function runtimeUnavailable(diagnosticCode: string, message: string) {
  return Object.assign(
    new Error(message),
    createIntegrationError({
      code: "RUNTIME_UNAVAILABLE",
      category: "dependency",
      message,
      details: { diagnosticCode },
    }),
  );
}
