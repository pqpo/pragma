import {
  canonicalPragmaResourceRef,
  type PragmaInvocableResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";

import { referencedPragmaResourceRefs } from "./pragma-resource-references.ts";

export function findPragmaInvocableDependencyCycle(
  resources: readonly PragmaResource[],
): readonly string[] | undefined {
  const invocables = new Map<string, PragmaInvocableResource>(
    resources
      .filter(isInvocableResource)
      .map((resource) => [canonicalPragmaResourceRef(resource), resource] as const),
  );
  const visiting = new Map<string, number>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (ref: string): readonly string[] | undefined => {
    const cycleStart = visiting.get(ref);
    if (cycleStart !== undefined) return [...path.slice(cycleStart), ref];
    if (visited.has(ref)) return undefined;
    const resource = invocables.get(ref);
    if (resource === undefined) return undefined;

    visiting.set(ref, path.length);
    path.push(ref);
    for (const dependencyRef of referencedPragmaResourceRefs([resource])) {
      if (!invocables.has(dependencyRef)) continue;
      const cycle = visit(dependencyRef);
      if (cycle !== undefined) return cycle;
    }
    path.pop();
    visiting.delete(ref);
    visited.add(ref);
    return undefined;
  };

  for (const ref of invocables.keys()) {
    const cycle = visit(ref);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

function isInvocableResource(resource: PragmaResource): resource is PragmaInvocableResource {
  return resource.kind === "Expert" || resource.kind === "ExpertTeam" || resource.kind === "Flow";
}
