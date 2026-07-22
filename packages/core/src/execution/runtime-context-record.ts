import type {
  RuntimeEnvironmentBinding,
  RuntimeContextOrigin,
  RuntimeContextOwner,
  RuntimeContextRecord,
} from "@pragma/shared";

import type { RuntimeModelSelection } from "../runtime/runtime-adapter.ts";

export interface CreateRuntimeContextRecordOptions {
  readonly contextId: string;
  readonly owner: RuntimeContextOwner;
  readonly origin: RuntimeContextOrigin;
  readonly expert: { readonly id: string; readonly version: string };
  readonly runtime: RuntimeEnvironmentBinding;
  readonly modelSelection?: RuntimeModelSelection | undefined;
  readonly now?: string | undefined;
}

export function createRuntimeContextRecord(
  options: CreateRuntimeContextRecordOptions,
): RuntimeContextRecord {
  const now = options.now ?? new Date().toISOString();
  return {
    schemaVersion: "pragma.runtime-context/v4",
    contextId: options.contextId,
    owner: options.owner,
    origin: options.origin,
    expert: options.expert,
    runtime: options.runtime,
    ...(options.modelSelection === undefined ? {} : { modelSelection: options.modelSelection }),
    lifecycle: "open",
    createdAt: now,
    updatedAt: now,
  };
}

export function mergeRuntimeContextRecord(
  current: RuntimeContextRecord | undefined,
  incoming: RuntimeContextRecord,
): RuntimeContextRecord {
  if (current === undefined) return incoming;
  assertSameRuntimeContext(current, incoming);

  const incomingIsNewer = incoming.updatedAt.localeCompare(current.updatedAt) >= 0;
  const lifecycle =
    current.lifecycle === "closed" || incoming.lifecycle === "closed" ? "closed" : "open";
  const updatedAt =
    incoming.updatedAt.localeCompare(current.updatedAt) > 0
      ? incoming.updatedAt
      : current.updatedAt;
  const snapshot = incomingIsNewer
    ? (incoming.snapshot ?? current.snapshot)
    : (current.snapshot ?? incoming.snapshot);
  const closedAt =
    lifecycle === "closed" ? (incoming.closedAt ?? current.closedAt ?? updatedAt) : undefined;

  return {
    ...current,
    ...(snapshot === undefined ? {} : { snapshot }),
    lifecycle,
    updatedAt,
    ...(closedAt === undefined ? {} : { closedAt }),
  };
}

function assertSameRuntimeContext(
  current: RuntimeContextRecord,
  incoming: RuntimeContextRecord,
): void {
  if (
    current.contextId !== incoming.contextId ||
    current.owner.type !== incoming.owner.type ||
    current.owner.ownerId !== incoming.owner.ownerId ||
    !sameRuntimeContextOrigin(current.origin, incoming.origin)
  ) {
    throw new Error(`Runtime Context owner conflict: ${incoming.contextId}.`);
  }
  if (
    current.expert.id !== incoming.expert.id ||
    current.expert.version !== incoming.expert.version
  ) {
    throw new Error(`Runtime Context Expert identity conflict: ${incoming.contextId}.`);
  }
  if (
    current.runtime.runtimeId !== incoming.runtime.runtimeId ||
    current.runtime.revision !== incoming.runtime.revision ||
    current.runtime.fingerprint !== incoming.runtime.fingerprint
  ) {
    throw new Error(`Runtime Context Runtime identity conflict: ${incoming.contextId}.`);
  }
}

export function requireInvocationContextOrigin(context: RuntimeContextRecord): string {
  if (context.origin.type !== "invocation") {
    throw new Error(`Runtime Context requires an Invocation origin: ${context.contextId}.`);
  }
  return context.origin.invocationId;
}

export function sameRuntimeContextOrigin(
  current: RuntimeContextOrigin,
  incoming: RuntimeContextOrigin,
): boolean {
  switch (current.type) {
    case "expert-session":
      return incoming.type === "expert-session" && current.sessionId === incoming.sessionId;
    case "invocation":
      return incoming.type === "invocation" && current.invocationId === incoming.invocationId;
    default: {
      const unsupported: never = current;
      throw new Error(`Unsupported Runtime Context origin: ${String(unsupported)}`);
    }
  }
}
