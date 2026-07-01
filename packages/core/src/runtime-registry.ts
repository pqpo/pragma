import type { RuntimeAdapter } from "@pragma/core";

import { createCloudPiRuntimeAdapter } from "./pi-runtime/adapter.ts";
import type { CloudPiRuntimeAdapterOptions } from "./pi-runtime/types.ts";

export type DefaultRuntimeOptions = CloudPiRuntimeAdapterOptions;

export interface RuntimeRegistry {
  readonly defaultRuntime: string;
  readonly list: () => readonly RuntimeAdapter[];
  readonly get: (runtimeId: string) => RuntimeAdapter | undefined;
  readonly resolve: (runtimeId?: string | undefined) => RuntimeAdapter;
}

export interface RuntimeRegistryOptions {
  readonly runtimes?: readonly RuntimeAdapter[] | undefined;
  readonly defaultRuntime?: string | undefined;
}

export function createDefaultRuntime(options: DefaultRuntimeOptions = {}): RuntimeAdapter {
  return createCloudPiRuntimeAdapter({
    ...options,
    descriptor: {
      ...options.descriptor,
      id: options.descriptor?.id ?? "default",
      kind: options.descriptor?.kind ?? "cloud-pi-agent",
      displayName: options.descriptor?.displayName ?? "Default Runtime",
    },
  });
}

export function createRuntimeRegistry(options: RuntimeRegistryOptions = {}): RuntimeRegistry {
  const defaultRuntime = options.defaultRuntime ?? "default";
  const runtimes = ensureDefaultRuntime(options.runtimes ?? [], defaultRuntime);
  const runtimeById = new Map<string, RuntimeAdapter>();

  for (const runtime of runtimes) {
    if (runtimeById.has(runtime.descriptor.id)) {
      throw new Error(`Duplicate runtime id: ${runtime.descriptor.id}`);
    }

    runtimeById.set(runtime.descriptor.id, runtime);
  }

  if (!runtimeById.has(defaultRuntime)) {
    throw new Error(`Default runtime is not registered: ${defaultRuntime}`);
  }

  return {
    defaultRuntime,
    list: () => runtimes,
    get: (runtimeId) => runtimeById.get(runtimeId),
    resolve: (runtimeId) => {
      const resolvedRuntimeId = runtimeId ?? defaultRuntime;
      const runtime = runtimeById.get(resolvedRuntimeId);

      if (runtime === undefined) {
        throw new Error(`Runtime is not registered: ${resolvedRuntimeId}`);
      }

      return runtime;
    },
  };
}

function ensureDefaultRuntime(
  runtimes: readonly RuntimeAdapter[],
  defaultRuntime: string,
): readonly RuntimeAdapter[] {
  if (runtimes.some((runtime) => runtime.descriptor.id === defaultRuntime)) {
    return runtimes;
  }

  if (defaultRuntime !== "default") {
    return runtimes;
  }

  return [createDefaultRuntime(), ...runtimes];
}
