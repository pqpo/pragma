import type { RuntimeContextRecord } from "@pragma/shared";

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
    incoming.updatedAt.localeCompare(current.updatedAt) > 0 ? incoming.updatedAt : current.updatedAt;
  const runtimeId = incomingIsNewer
    ? (incoming.runtimeId ?? current.runtimeId)
    : (current.runtimeId ?? incoming.runtimeId);
  const snapshot = incomingIsNewer
    ? (incoming.snapshot ?? current.snapshot)
    : (current.snapshot ?? incoming.snapshot);
  const closedAt =
    lifecycle === "closed"
      ? (incoming.closedAt ?? current.closedAt ?? updatedAt)
      : undefined;

  return {
    ...current,
    ...(runtimeId === undefined ? {} : { runtimeId }),
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
    current.owner.ownerId !== incoming.owner.ownerId
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
    current.runtimeId !== undefined &&
    incoming.runtimeId !== undefined &&
    current.runtimeId !== incoming.runtimeId
  ) {
    throw new Error(`Runtime Context Runtime identity conflict: ${incoming.contextId}.`);
  }
}
