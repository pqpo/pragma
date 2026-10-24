import { createHash } from "node:crypto";

import type { RuntimeEnvironmentBinding } from "@pragma/shared";

import type { RuntimeAdapter, RuntimeModelSelection } from "./runtime/runtime-adapter.ts";

export interface ResolvedRuntime {
  readonly binding: RuntimeEnvironmentBinding;
  readonly adapter: RuntimeAdapter;
}

export interface RuntimeResolver {
  readonly getDefaultRuntimeId: () => Promise<string>;
  readonly bind: (request?: {
    readonly runtimeId?: string | undefined;
    readonly permissionModeId?: string | undefined;
    readonly modelSelection?: RuntimeModelSelection | undefined;
  }) => Promise<ResolvedRuntime>;
  readonly resolve: (request: {
    readonly binding: RuntimeEnvironmentBinding;
    readonly modelSelection?: RuntimeModelSelection | undefined;
  }) => Promise<ResolvedRuntime>;
}

export function createStaticRuntimeResolver(options: {
  readonly runtimes: readonly RuntimeAdapter[];
  readonly defaultRuntimeId: string;
}): RuntimeResolver {
  const runtimeById = new Map<string, RuntimeAdapter>();
  for (const runtime of options.runtimes) {
    if (runtimeById.has(runtime.descriptor.id)) {
      throw new Error(`Duplicate runtime id: ${runtime.descriptor.id}`);
    }
    runtimeById.set(runtime.descriptor.id, runtime);
  }
  if (!runtimeById.has(options.defaultRuntimeId)) {
    throw new Error(`Default runtime is not registered: ${options.defaultRuntimeId}`);
  }

  const resolveLatest = async (
    runtimeId: string,
    permissionModeId?: string,
  ): Promise<ResolvedRuntime> => {
    const adapter = runtimeById.get(runtimeId);
    if (adapter === undefined) throw new Error(`Runtime is not registered: ${runtimeId}`);
    const catalog = adapter.descriptor.permissionModes;
    const effectiveMode =
      permissionModeId ?? adapter.descriptor.configuredPermissionModeId ?? catalog?.defaultModeId;
    if (
      adapter.descriptor.configuredPermissionModeId !== undefined &&
      effectiveMode !== adapter.descriptor.configuredPermissionModeId
    ) {
      throw new Error(
        `Static Runtime adapter ${runtimeId} is configured for ${adapter.descriptor.configuredPermissionModeId}; use a Runtime Environment factory to select ${effectiveMode}.`,
      );
    }
    if (
      effectiveMode !== undefined &&
      adapter.descriptor.configuredPermissionModeId === undefined &&
      !catalog?.modes.some((mode) => mode.id === effectiveMode && mode.available)
    )
      throw new Error(`Unsupported permission mode for ${runtimeId}: ${effectiveMode}`);
    const models = adapter.listModels === undefined ? undefined : await adapter.listModels();
    return {
      adapter,
      binding: {
        runtimeId,
        ...(effectiveMode === undefined ? {} : { permissionModeId: effectiveMode }),
        revision: 1,
        fingerprint: sha256({ descriptor: staticIdentityDescriptor(adapter.descriptor), models }),
      },
    };
  };

  return {
    getDefaultRuntimeId: async () => options.defaultRuntimeId,
    bind: async (request = {}) =>
      await resolveLatest(request.runtimeId ?? options.defaultRuntimeId, request.permissionModeId),
    resolve: async ({ binding }) => {
      const resolved = await resolveLatest(binding.runtimeId, binding.permissionModeId);
      if (
        resolved.binding.revision !== binding.revision ||
        resolved.binding.fingerprint !== binding.fingerprint
      ) {
        throw new Error(`Runtime Environment binding is unavailable: ${binding.runtimeId}.`);
      }
      // Historical Contexts retain the exact binding that originally identified them.
      return binding.permissionModeId === undefined ? { ...resolved, binding } : resolved;
    },
  };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// Catalog metadata does not change the immutable identity of historical static bindings.
function staticIdentityDescriptor(descriptor: RuntimeAdapter["descriptor"]) {
  const { permissionModes: _catalog, configuredPermissionModeId: _mode, ...identity } = descriptor;
  void _catalog;
  void _mode;
  return identity;
}
