import { createHash } from "node:crypto";

import {
  MemorySubjectRefSchema,
  type MemoryRevisionBinding,
  type MemorySubjectRef,
  type MemoryVisibilityPolicy,
} from "@pragma/shared";

export function assertMemoryBindingsTightened(
  current: readonly MemoryRevisionBinding[],
  next: readonly MemoryRevisionBinding[],
): MemoryRevisionBinding[] {
  const currentByRef = new Map(
    current.map((binding) => [subjectRefKey(binding.consumerRef), binding]),
  );
  if (next.length !== current.length) throw new Error("memory_permission_expansion_denied");
  for (const binding of next) {
    const previous = currentByRef.get(subjectRefKey(binding.consumerRef));
    if (previous === undefined) throw new Error("memory_permission_expansion_denied");
    if (previous.recall === "deny" && binding.recall === "allow") {
      throw new Error("memory_permission_expansion_denied");
    }
    if (previous.export === "deny" && binding.export === "allow") {
      throw new Error("memory_permission_expansion_denied");
    }
    const changed = previous.recall !== binding.recall || previous.export !== binding.export;
    const expectedRevision = previous.permissionRevision + (changed ? 1 : 0);
    if (binding.permissionRevision !== expectedRevision) {
      throw new Error("memory_permission_revision_invalid");
    }
  }
  return [...next];
}

export function assertMemoryVisibilityTightened(
  current: MemoryVisibilityPolicy,
  next: MemoryVisibilityPolicy,
): MemoryVisibilityPolicy {
  if (current.mode === "restricted") {
    if (next.mode !== "restricted") throw new Error("memory_permission_expansion_denied");
    const allowed = new Set(current.principals.map(subjectRefKey));
    if (next.principals.some((ref) => !allowed.has(subjectRefKey(ref)))) {
      throw new Error("memory_permission_expansion_denied");
    }
    return next;
  }
  if (current.mode === "host-private" && next.mode === "public") {
    throw new Error("memory_permission_expansion_denied");
  }
  return next;
}

export function createMemoryTombstone(
  module: "episodic" | "semantic",
  id: string,
  revision: number,
  input: { readonly actorRef: MemorySubjectRef; readonly reason: string; readonly now: Date },
) {
  return {
    schemaVersion: "pragma.memory-tombstone/v1" as const,
    module,
    memoryId: id,
    lastRevision: revision,
    identityDigest: createHash("sha256").update(`${module}\0${id}`).digest("hex"),
    actorRef: MemorySubjectRefSchema.parse(input.actorRef),
    reasonDigest: createHash("sha256").update(input.reason).digest("hex"),
    reasonLength: input.reason.length,
    forgottenAt: input.now.toISOString(),
  };
}

function subjectRefKey(ref: MemorySubjectRef): string {
  return `${ref.type}\0${ref.id}`;
}
