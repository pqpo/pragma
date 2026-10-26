import type { PragmaExpertResource } from "@pragma/interpreter/ast";

import { revisionInstructions } from "./revision-instructions.ts";

/** Automatic learning shares the Revision Agent and draft tools, with a bounded unattended brief. */
export function unattendedMemoryRevisionResource(
  resource: PragmaExpertResource,
  options?: { readonly learningTools?: boolean },
): PragmaExpertResource {
  const instructions = revisionInstructions(resource.metadata.id, "memory", options?.learningTools);
  if (instructions === undefined) throw new Error("Unsupported Memory Revision Agent");
  return {
    ...resource,
    spec: {
      ...resource.spec,
      instructions,
      toolPolicy: {
        ...resource.spec.toolPolicy,
        deniedTools: [
          ...new Set([...(resource.spec.toolPolicy?.deniedTools ?? []), "askUserQuestion"]),
        ],
      },
    },
  };
}
