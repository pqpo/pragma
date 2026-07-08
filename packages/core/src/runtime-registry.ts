import type { RuntimeAdapter } from "./runtime/runtime-adapter.ts";

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

export function createRuntimeRegistry(options: RuntimeRegistryOptions = {}): RuntimeRegistry {
  const defaultRuntime = options.defaultRuntime ?? "default";
  const runtimes = options.runtimes ?? [];
  const runtimeById = new Map<string, RuntimeAdapter>();

  for (const runtime of runtimes) {
    if (runtimeById.has(runtime.descriptor.id)) {
      throw new Error(`Duplicate runtime id: ${runtime.descriptor.id}`);
    }

    runtimeById.set(runtime.descriptor.id, runtime);
  }

  if (runtimes.length > 0 && !runtimeById.has(defaultRuntime)) {
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
