import type { ExecutionStatus, RuntimeContextOwner } from "@pragma/shared";

export interface ContextCandidate {
  readonly contextId: string;
  readonly agentId?: string | undefined;
  readonly expertId: string;
  readonly expertVersion: string;
  readonly runtimeId?: string | undefined;
  readonly lifecycle: "open" | "closed";
  readonly lastInvocationId: string;
  readonly lastInvocationStatus: ExecutionStatus;
}

export type ContextIdResolutionSource =
  | {
      readonly kind: "flow";
      readonly flowId: string;
      readonly stepId: string;
      readonly visit: number;
    }
  | {
      readonly kind: "expert-delegation";
      readonly callerExpertId: string;
      readonly callerAgentId?: string | undefined;
    }
  | {
      readonly kind: "expert-team";
      readonly teamId: string;
      readonly callerExpertId: string;
      readonly callerAgentId?: string | undefined;
    };

export interface ContextIdResolutionContext {
  readonly source: ContextIdResolutionSource;
  readonly executionId: string;
  readonly owner: RuntimeContextOwner;
  readonly ownerContextId?: string | undefined;
  readonly target: {
    readonly expertId: string;
    readonly expertVersion: string;
    readonly requestedRuntimeId?: string | undefined;
  };
  readonly invocation: {
    readonly parentInvocationId?: string | undefined;
    readonly input: unknown;
  };
  readonly state: Readonly<Record<string, unknown>>;
  readonly previousContexts: readonly ContextCandidate[];
  readonly freshContextId: string;
}

export interface ContextIdResolver {
  readonly id: string;
  readonly version: string;
  readonly resolve: (context: ContextIdResolutionContext) => string;
}

export interface ContextIdResolverDescriptor {
  readonly id: string;
  readonly version: string;
}

export const freshContextIdResolver = defineContextIdResolver({
  id: "pragma.context.fresh",
  version: "v1",
  resolve: ({ freshContextId }) => freshContextId,
});

export function defineContextIdResolver(options: ContextIdResolver): ContextIdResolver {
  const id = readNonEmpty(options.id, "ContextIdResolver id");
  const version = readNonEmpty(options.version, "ContextIdResolver version");
  if (typeof options.resolve !== "function") {
    throw new TypeError("ContextIdResolver resolve must be a function.");
  }
  return Object.freeze({ id, version, resolve: options.resolve });
}

export function describeContextIdResolver(
  resolver: ContextIdResolver,
): ContextIdResolverDescriptor {
  return Object.freeze({ id: resolver.id, version: resolver.version });
}

export function resolveContextId(
  resolver: ContextIdResolver,
  context: ContextIdResolutionContext,
): string {
  let resolved: unknown;
  try {
    resolved = resolver.resolve(context);
  } catch (error) {
    throw new Error(
      `ContextIdResolver ${resolver.id}@${resolver.version} failed: ${readErrorMessage(error)}`,
      { cause: error },
    );
  }
  if (resolved instanceof Promise) {
    throw new Error(`ContextIdResolver ${resolver.id}@${resolver.version} must be synchronous.`);
  }
  if (typeof resolved !== "string" || resolved.trim() === "") {
    throw new Error(
      `ContextIdResolver ${resolver.id}@${resolver.version} returned an empty contextId.`,
    );
  }
  return resolved;
}

function readNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must not be empty.`);
  }
  return value;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
