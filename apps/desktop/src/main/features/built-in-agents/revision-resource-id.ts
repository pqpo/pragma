import { createHash } from "node:crypto";

import type { KnowledgeRevisionToolInvocation } from "@pragma/built-in-agents";

export function reservedRevisionResourceId(
  resourceKind: "context-store" | "skill",
  input: KnowledgeRevisionToolInvocation,
): string {
  return deterministicRevisionUuid("reserved-resource", [
    resourceKind,
    input.executionId,
    input.invocationId,
    input.expertId,
    input.teamId ?? null,
    input.operationId,
  ]);
}

export function deterministicRevisionUuid(
  scope: string,
  parts: readonly (string | number | null)[],
): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(["pragma.revision-resource/v1", scope, ...parts]))
    .digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
