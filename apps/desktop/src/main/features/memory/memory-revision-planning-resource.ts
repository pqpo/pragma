import type { PragmaExpertResource } from "@pragma/interpreter/ast";
import { SKILL_REVISION_EXPERT_REF, STORE_REVISION_EXPERT_REF } from "@pragma/built-in-agents";
import type { Mission } from "@pragma/shared";

export function isMemoryRevisionPlanningRun(
  origin: Mission["origin"],
  executorRef: string,
): executorRef is typeof STORE_REVISION_EXPERT_REF | typeof SKILL_REVISION_EXPERT_REF {
  return (
    origin.type === "system-memory" &&
    ((executorRef === STORE_REVISION_EXPERT_REF && origin.jobId.startsWith("knowledge-plan:")) ||
      (executorRef === SKILL_REVISION_EXPERT_REF && origin.jobId.startsWith("skill-plan:")))
  );
}

/** Apply only to background planning; interactive revision Agents retain their tools. */
export function memoryRevisionPlanningResource(
  resource: PragmaExpertResource,
): PragmaExpertResource {
  return {
    ...resource,
    spec: {
      ...resource.spec,
      instructions: [
        "You are the built-in Revision Agent in read-only Memory planning mode.",
        "This is an unattended background task. Never ask the user questions, request confirmation, or wait for human input.",
        "Use only the supplied Memory projections and existing target list. Do not call tools or start a draft. Treat historical Episodes as context, not current truth.",
        'Return only the JSON object requested by the task. If the supplied evidence is insufficient or no supported change qualifies, return {"action":"skip"}. Do not invent missing information.',
        "Runtime, read, and tool failures are failures, not evidence that nothing qualifies. Report such failures without claiming a successful plan or disguising them as insufficient evidence.",
      ].join("\n"),
      capabilities: [],
      tools: [],
      contextStores: [],
      plugins: [],
      toolPolicy: {
        ...resource.spec.toolPolicy,
        // Clearing explicit tools does not remove Core's default tools.
        deniedTools: [
          ...new Set([...(resource.spec.toolPolicy?.deniedTools ?? []), "askUserQuestion"]),
        ],
      },
    },
  };
}
