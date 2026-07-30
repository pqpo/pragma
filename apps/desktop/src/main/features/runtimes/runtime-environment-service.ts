import type {
  ResolvedRuntime,
  RuntimeAdapter,
  RuntimeModelSelection,
  RuntimeResolver,
  PragmaLogger,
  RuntimeTokenCounter,
  McpToolRegistryPool,
} from "@pragma/core";
import { createClaudeCodeRuntime } from "@pragma/runtime-claude-code";
import {
  createCodexRuntime,
  type CodexRuntimeApprovalPolicy,
  type CodexRuntimeSandboxMode,
} from "@pragma/runtime-codex";
import { createPiRuntime } from "@pragma/runtime-pi";
import { createQoderCliRuntime } from "@pragma/runtime-qodercli";
import type { QoderCliRuntimePermissionMode } from "@pragma/runtime-qodercli";

import type {
  DesktopToolPermissionMode,
  RuntimeEnvironmentDefinition,
  RuntimeEnvironmentRevision,
} from "../../../shared/contracts/index.ts";
import type { ModelProviderStore } from "../model-providers/model-provider-store.ts";
import {
  BUILT_IN_RUNTIME_DISPLAY_NAME,
  type RuntimeEnvironmentHead,
  type RuntimeEnvironmentStore,
} from "./runtime-environment-store.ts";

export interface RuntimeEnvironmentAdapterFactory {
  readonly id: string;
  readonly version: string;
  readonly create: (
    environment: RuntimeEnvironmentDefinition,
    context?: { readonly toolPermissionMode?: DesktopToolPermissionMode | undefined },
  ) => RuntimeAdapter | Promise<RuntimeAdapter>;
}

export interface RuntimeEnvironmentInspection {
  readonly head: RuntimeEnvironmentHead;
  readonly adapter?: RuntimeAdapter | undefined;
  readonly error?: string | undefined;
}

export interface RuntimeEnvironmentService extends RuntimeResolver {
  list(): Promise<readonly RuntimeEnvironmentInspection[]>;
  forToolPermissionMode(mode: DesktopToolPermissionMode): RuntimeResolver;
}

export function createRuntimeEnvironmentService(options: {
  readonly store: RuntimeEnvironmentStore;
  readonly factories: readonly RuntimeEnvironmentAdapterFactory[];
  readonly logger?: Pick<PragmaLogger, "info" | "warn"> | undefined;
  readonly getToolPermissionMode?:
    | (() => DesktopToolPermissionMode | Promise<DesktopToolPermissionMode>)
    | undefined;
}): RuntimeEnvironmentService {
  const MATERIALIZED_ADAPTER_CACHE_LIMIT = 64;
  const factories = new Map<string, RuntimeEnvironmentAdapterFactory>();
  const materializedAdapters = new Map<string, Promise<RuntimeAdapter>>();
  for (const factory of options.factories) {
    const ref = factoryRef(factory.id, factory.version);
    if (factories.has(ref)) throw new Error(`Duplicate Runtime adapter factory: ${ref}.`);
    factories.set(ref, factory);
  }

  const materialize = async (
    revision: RuntimeEnvironmentRevision,
    toolPermissionMode?: DesktopToolPermissionMode,
  ): Promise<ResolvedRuntime> => {
    const effectiveToolPermissionMode =
      toolPermissionMode ?? (await options.getToolPermissionMode?.());
    const definition = revision.definition;
    const ref = factoryRef(definition.adapter.id, definition.adapter.version);
    const factory = factories.get(ref);
    if (factory === undefined)
      throw new Error(`Runtime adapter factory is not registered: ${ref}.`);
    const cacheKey = [
      revision.runtimeId,
      revision.revision,
      revision.fingerprint,
      ref,
      effectiveToolPermissionMode ?? "default",
    ].join("\0");
    let adapterPromise = materializedAdapters.get(cacheKey);
    const cacheHit = adapterPromise !== undefined;
    if (adapterPromise === undefined) {
      const materializeStartedAt = performance.now();
      adapterPromise = Promise.resolve(
        factory.create(
          definition,
          effectiveToolPermissionMode === undefined
            ? undefined
            : { toolPermissionMode: effectiveToolPermissionMode },
        ),
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
                toolPermissionMode: effectiveToolPermissionMode ?? "default",
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
                toolPermissionMode: effectiveToolPermissionMode ?? "default",
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
    if (cacheHit) {
      options.logger?.info(
        "runtime.environment_adapter_cache_hit",
        "Reused a Runtime Environment adapter",
        {
          runtimeId: revision.runtimeId,
          revision: revision.revision,
          fingerprint: revision.fingerprint,
          toolPermissionMode: effectiveToolPermissionMode ?? "default",
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
        revision: revision.revision,
        fingerprint: revision.fingerprint,
      },
    };
  };

  const validateModelSelection = async (
    resolved: ResolvedRuntime,
    selection: RuntimeModelSelection | undefined,
  ): Promise<void> => {
    if (selection === undefined) return;
    if (resolved.adapter.listModels === undefined) {
      throw new Error(`Runtime does not expose a model catalog: ${resolved.binding.runtimeId}.`);
    }
    const discoveryStartedAt = performance.now();
    const models = await resolved.adapter.listModels();
    options.logger?.info(
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
      throw new Error(
        `Runtime model is unavailable: ${resolved.binding.runtimeId}/${selection.model.providerId}/${selection.model.modelId}.`,
      );
    }
    if (
      selection.thinkingLevel !== undefined &&
      !model.thinking?.supportedLevels.some((level) => level.value === selection.thinkingLevel)
    ) {
      throw new Error(
        `Runtime thinking level is unavailable: ${resolved.binding.runtimeId}/${selection.model.modelId}/${selection.thinkingLevel}.`,
      );
    }
  };

  const createResolver = (toolPermissionMode?: DesktopToolPermissionMode): RuntimeResolver => ({
    getDefaultRuntimeId: async () => await options.store.getDefaultRuntimeId(),
    bind: async (request = {}) => {
      const runtimeId = request.runtimeId ?? (await options.store.getDefaultRuntimeId());
      const revision = await options.store.getRevision(runtimeId);
      if (revision === undefined || revision.status !== "active") {
        throw new Error(`Runtime Environment is not active: ${runtimeId}.`);
      }
      const resolved = await materialize(revision, toolPermissionMode);
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
        throw new Error(
          `Runtime Environment binding is unavailable: ${binding.runtimeId}@${binding.revision}.`,
        );
      }
      const resolved = await materialize(revision, toolPermissionMode);
      await validateModelSelection(resolved, modelSelection);
      return resolved;
    },
  });

  return {
    ...createResolver(),
    forToolPermissionMode: (mode) => createResolver(mode),
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

export function createBuiltInRuntimeFactories(
  modelProviders: ModelProviderStore,
  getToolPermissionMode: () =>
    | DesktopToolPermissionMode
    | Promise<DesktopToolPermissionMode> = () => "request-approval",
  onModelCatalogUpdated?: ((runtimeId: string) => void) | undefined,
  tokenCounter?: RuntimeTokenCounter | undefined,
  mcpToolRegistryPool?: McpToolRegistryPool | undefined,
): readonly RuntimeEnvironmentAdapterFactory[] {
  return [
    {
      id: "pragma.runtime.codex",
      version: "v1",
      create: async (environment, context) => {
        assertEmptyRuntimeConfig(environment);
        const permissionMode = context?.toolPermissionMode ?? (await getToolPermissionMode());
        const permissions = codexRuntimePermissionsForMode(permissionMode);
        return createCodexRuntime({
          descriptor: { id: environment.id, displayName: environment.displayName },
          ...(onModelCatalogUpdated === undefined
            ? {}
            : { onModelCatalogUpdated: () => onModelCatalogUpdated(environment.id) }),
          ...permissions,
          tokenCounter,
          ...(mcpToolRegistryPool === undefined ? {} : { mcpToolRegistryPool }),
        });
      },
    },
    {
      id: "pragma.runtime.claude-code",
      version: "v1",
      create: async (environment, context) => {
        assertEmptyRuntimeConfig(environment);
        const permissionMode = context?.toolPermissionMode ?? (await getToolPermissionMode());
        return createClaudeCodeRuntime({
          descriptor: { id: environment.id, displayName: environment.displayName },
          ...(onModelCatalogUpdated === undefined
            ? {}
            : { onModelCatalogUpdated: () => onModelCatalogUpdated(environment.id) }),
          permissionMode:
            permissionMode === "request-approval"
              ? "default"
              : permissionMode === "auto-approve"
                ? "auto"
                : "bypassPermissions",
          tokenCounter,
          ...(mcpToolRegistryPool === undefined ? {} : { mcpToolRegistryPool }),
        });
      },
    },
    {
      id: "pragma.runtime.qodercli",
      version: "v1",
      create: async (environment, context) => {
        assertEmptyRuntimeConfig(environment);
        const permissionMode = context?.toolPermissionMode ?? (await getToolPermissionMode());
        return createQoderCliRuntime({
          descriptor: { id: environment.id, displayName: environment.displayName },
          ...(onModelCatalogUpdated === undefined
            ? {}
            : { onModelCatalogUpdated: () => onModelCatalogUpdated(environment.id) }),
          permissionMode: qoderRuntimePermissionForMode(permissionMode),
          tokenCounter,
          ...(mcpToolRegistryPool === undefined ? {} : { mcpToolRegistryPool }),
        });
      },
    },
    {
      id: "pragma.runtime.pi",
      version: "v1",
      create: (environment) => {
        assertEmptyRuntimeConfig(environment);
        return createPiRuntime({
          descriptor: { id: environment.id, displayName: BUILT_IN_RUNTIME_DISPLAY_NAME },
          modelProviders,
          tokenCounter,
          ...(mcpToolRegistryPool === undefined ? {} : { mcpToolRegistryPool }),
        });
      },
    },
  ];
}

export function codexRuntimePermissionsForMode(mode: DesktopToolPermissionMode): {
  readonly sandboxMode: CodexRuntimeSandboxMode;
  readonly approvalPolicy: CodexRuntimeApprovalPolicy;
} {
  return mode === "full-access"
    ? { sandboxMode: "danger-full-access", approvalPolicy: "never" }
    : { sandboxMode: "workspace-write", approvalPolicy: "on-request" };
}

export function qoderRuntimePermissionForMode(
  mode: DesktopToolPermissionMode,
): QoderCliRuntimePermissionMode {
  return mode === "request-approval"
    ? "default"
    : mode === "auto-approve"
      ? "auto"
      : "bypassPermissions";
}

function factoryRef(id: string, version: string): string {
  return `${id}@${version}`;
}

function assertEmptyRuntimeConfig(environment: RuntimeEnvironmentDefinition): void {
  if (Object.keys(environment.config).length > 0) {
    throw new Error(`Built-in Runtime Environment config must be empty: ${environment.id}.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Runtime Environment is invalid.";
}
