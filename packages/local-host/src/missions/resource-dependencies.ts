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
      for (const context of resource.spec.contextStores) refs.add(context.ref);
      for (const runtime of Object.values(resource.spec.delegation.runtimes)) refs.add(runtime);
      continue;
    }
    if (resource.kind === "Flow") {
      for (const step of Object.values(resource.spec.graph.steps)) {
        const target = step.expert ?? step.team ?? step.flow;
        if (target !== undefined) refs.add(target.ref);
        if (step.runtime !== undefined) refs.add(step.runtime.ref);
        for (const runtime of Object.values(step.runtimes ?? {})) refs.add(runtime);
      }
      continue;
    }
    if (resource.kind === "Automation") {
      refs.add(resource.spec.route.executor.ref);
      continue;
    }
    if (resource.kind === "Evaluation") {
      if ("target" in resource.spec && resource.spec.method.type === "flow-run-dry") {
        refs.add(resource.spec.target.ref);
      }
    }
  }

  return refs;
}

/** Runtime readiness reads only dependencies reachable from the requested target. */
export function missionTargetRuntimeIds(
  ref: string,
  resources: readonly PragmaResource[],
  getExternalResource?: ((ref: string) => PragmaResource | undefined) | undefined,
): readonly string[] {
  const byRef = new Map(
    resources.map((resource) => [canonicalPragmaResourceRef(resource), resource]),
  );
  const visited = new Set<string>();
  const pending = [ref];
  const runtimeIds = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const resource = byRef.get(current) ?? getExternalResource?.(current);
    if (resource === undefined) continue;
    if (resource.kind === "RuntimeProfile") {
      const config = resource.spec.config as { runtimeId?: string };
      if (config.runtimeId !== undefined) runtimeIds.add(config.runtimeId);
    }
    pending.push(...referencedPragmaResourceRefs([resource]));
  }
  return [...runtimeIds];
}
