import type { MemorySubjectRef } from "@pragma/shared";
import { createFileMemoryPolicyStore } from "../policy/memory-policy-store.ts";

export function createMemoryLearningPolicyGuard(options: {
  readonly pragmaHome?: string | undefined;
  readonly now?: (() => Date) | undefined;
}) {
  const policies = createFileMemoryPolicyStore(options);
  return async (rootRef?: MemorySubjectRef, producerRefs: readonly MemorySubjectRef[] = []) =>
    (
      await policies.resolveAt({
        rootRef,
        producerRefs,
        occurredAt: (options.now?.() ?? new Date()).toISOString(),
      })
    ).learning !== "disabled";
}
