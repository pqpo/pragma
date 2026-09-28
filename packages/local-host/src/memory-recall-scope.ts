import { EXECUTION_CURRENT_EXPERT_ID_ATTR, type ExpertAgentRunContext } from "@pragma/core";
import {
  MemoryRecallScopeSchema,
  type MemoryPolicyStore,
  type MemoryRecallScope,
} from "@pragma/memory";

export async function resolveMemoryRecallScope(
  policies: Pick<MemoryPolicyStore, "resolveAt">,
  context: ExpertAgentRunContext | undefined,
  now: Date = new Date(),
  principalRefs: readonly import("@pragma/shared").MemorySubjectRef[] = [],
): Promise<MemoryRecallScope | undefined> {
  const source = context?.source;
  const currentExpertId = context?.attributes?.[EXECUTION_CURRENT_EXPERT_ID_ATTR];
  if (currentExpertId === undefined) return undefined;
  const scope = MemoryRecallScopeSchema.safeParse({
    rootRef: { type: source?.type, id: source?.id },
    expertRef: { type: "pragma.expert", id: currentExpertId },
    ...(principalRefs.length === 0 ? {} : { principalRefs }),
  });
  if (!scope.success) return undefined;
  const policy = await policies.resolveAt({
    rootRef: scope.data.rootRef,
    ...(scope.data.expertRef === undefined ? {} : { producerRefs: [scope.data.expertRef] }),
    occurredAt: now.toISOString(),
  });
  return policy.recall ? scope.data : undefined;
}
