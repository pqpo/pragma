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

  const resolveLatest = async (runtimeId: string): Promise<ResolvedRuntime> => {
    const adapter = runtimeById.get(runtimeId);
    if (adapter === undefined) throw new Error(`Runtime is not registered: ${runtimeId}`);
    const models = adapter.listModels === undefined ? undefined : await adapter.listModels();
    return {
      adapter,
      binding: {
        runtimeId,
        revision: 1,
        fingerprint: sha256({ descriptor: adapter.descriptor, models }),
      },
    };
  };

  return {
    getDefaultRuntimeId: async () => options.defaultRuntimeId,
    bind: async (request = {}) =>
      await resolveLatest(request.runtimeId ?? options.defaultRuntimeId),
    resolve: async ({ binding }) => {
      const resolved = await resolveLatest(binding.runtimeId);
      if (
        resolved.binding.revision !== binding.revision ||
        resolved.binding.fingerprint !== binding.fingerprint
      ) {
        throw new Error(`Runtime Environment binding is unavailable: ${binding.runtimeId}.`);
      }
      return resolved;
    },
  };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
