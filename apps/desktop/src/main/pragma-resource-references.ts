import {
  canonicalPragmaResourceRef,
  type PragmaExpertResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";

export function referencingPragmaResources(
  resources: readonly PragmaResource[],
  targetRef: string,
): readonly PragmaResource[] {
  return resources.filter(
    (resource) =>
      canonicalPragmaResourceRef(resource) !== targetRef &&
      referencedPragmaResourceRefs([resource]).has(targetRef),
  );
}

export function referencedPragmaResourceRefs(
  resources: readonly PragmaResource[],
): ReadonlySet<string> {
  const refs = new Set<string>();
  const addToolRefs = (tools: PragmaExpertResource["spec"]["tools"]) => {
    for (const tool of tools) {
      if (tool.target !== undefined) refs.add(tool.target.ref);
      for (const target of tool.targets ?? []) refs.add(target.ref);
      for (const runtime of Object.values(tool.policy?.runtimes ?? {})) refs.add(runtime);
    }
  };

  for (const resource of resources) {
    if (resource.kind === "Expert") {
      if (resource.spec.runtime !== undefined) refs.add(resource.spec.runtime.ref);
      for (const capability of resource.spec.capabilities) refs.add(capability.ref);
      for (const context of resource.spec.contextStores) refs.add(context.ref);
      addToolRefs(resource.spec.tools);
      continue;
    }
    if (resource.kind === "ExpertTeam") {
      refs.add(resource.spec.coordinator.ref);
      for (const member of resource.spec.members) refs.add(member.ref);
      for (const runtime of Object.values(resource.spec.delegation.runtimes)) refs.add(runtime);
      continue;
    }
    if (resource.kind === "Flow") {
      for (const step of Object.values(resource.spec.graph.steps)) {
        const target = step.expert ?? step.team ?? step.flow;
        if (target !== undefined) refs.add(target.ref);
        if (step.runtime !== undefined) refs.add(step.runtime);
        for (const runtime of Object.values(step.runtimes ?? {})) refs.add(runtime);
      }
    }
  }

  return refs;
}
