import type { RuntimeAdapter } from "./runtime-adapter.ts";

export interface ExpertAgentRuntimeRegistry {
  readonly defaultRuntime?: string | undefined;
  readonly resolve: (runtimeId?: string | undefined) => RuntimeAdapter;
}

export type ExpertAgentRuntimeRegistryFactory = () => ExpertAgentRuntimeRegistry;

let defaultRuntimeRegistryFactory: ExpertAgentRuntimeRegistryFactory | undefined;

export function setDefaultRuntimeRegistryFactory(
  factory: ExpertAgentRuntimeRegistryFactory | undefined,
): void {
  defaultRuntimeRegistryFactory = factory;
}

export function createDefaultRuntimeRegistry(): ExpertAgentRuntimeRegistry {
  if (defaultRuntimeRegistryFactory === undefined) {
    throw new Error(
      "No default runtime registry is configured. Pass runtimes to agent.createSession(), createPragma({ runtimes }), or configure setDefaultRuntimeRegistryFactory().",
    );
  }

  return defaultRuntimeRegistryFactory();
}

export function createDefaultRuntimeRegistryIfConfigured():
  | ExpertAgentRuntimeRegistry
  | undefined {
  return defaultRuntimeRegistryFactory?.();
}
