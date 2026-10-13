import type { Capability, ExpertDefinition } from "./contracts/index.ts";

export interface ResourceToolSelectionItem {
  readonly ref: string;
  readonly name: string;
  readonly kind: "expert" | "team" | "flow";
}

export function expertResourceToolRefs(
  binding: ExpertDefinition["resourceTools"][number],
): string[] {
  return binding.target === undefined
    ? (binding.targets ?? []).map((target) => target.ref)
    : [binding.target.ref];
}

export function updateResourceToolSelection(
  bindings: ExpertDefinition["resourceTools"],
  refs: readonly string[],
  resources: readonly ResourceToolSelectionItem[],
  toolApprovals: ExpertDefinition["toolApprovals"] = {},
): Pick<ExpertDefinition, "resourceTools" | "toolApprovals"> {
  const selected = new Set(refs);
  const resourceTools = bindings.flatMap((binding) => {
    if (binding.target !== undefined) return selected.has(binding.target.ref) ? [binding] : [];
    const targets = (binding.targets ?? []).filter((target) => selected.has(target.ref));
    return targets.length === 0 ? [] : [{ ...binding, targets }];
  });
  const retainedRefs = new Set(resourceTools.flatMap(expertResourceToolRefs));
  const newExperts: { ref: string }[] = [];
  for (const ref of selected) {
    if (retainedRefs.has(ref)) continue;
    const resource = resources.find((candidate) => candidate.ref === ref);
    if (resource === undefined) continue;
    if (resource.kind === "expert") {
      newExperts.push({ ref });
    } else {
      resourceTools.push({
        adapter: "pragma.tool.call@v1",
        target: { ref },
        tool: {
          name: `call_${resource.kind}_${ref.slice(ref.indexOf(":") + 1)}`.replace(
            /[^A-Za-z0-9_-]/g,
            "_",
          ),
          description: `Call ${resource.name}.`,
          approval: "ask",
        },
      });
    }
  }
  if (newExperts.length > 0) {
    const delegateIndex = resourceTools.findIndex(
      (binding) => binding.adapter === "pragma.tool.delegate@v1",
    );
    if (delegateIndex < 0) {
      const previous = bindings.find((binding) => binding.adapter === "pragma.tool.delegate@v1");
      resourceTools.push({
        adapter: "pragma.tool.delegate@v1",
        targets: newExperts,
        policy: previous?.policy ?? { maxConcurrency: 4, maxDepth: 3, runtimes: {} },
      });
    } else {
      const delegate = resourceTools[delegateIndex]!;
      const { target, ...rest } = delegate;
      resourceTools[delegateIndex] = {
        ...rest,
        targets: [...(target === undefined ? delegate.targets! : [target]), ...newExperts],
      };
    }
  }
  return {
    resourceTools: resourceTools.map((binding) => {
      if (binding.adapter !== "pragma.tool.delegate@v1" || binding.policy === undefined)
        return binding;
      const expertIds = new Set(
        expertResourceToolRefs(binding).map((ref) => ref.slice("expert:".length)),
      );
      return {
        ...binding,
        policy: {
          ...binding.policy,
          runtimes: Object.fromEntries(
            Object.entries(binding.policy.runtimes).filter(([expertId]) => expertIds.has(expertId)),
          ),
        },
      };
    }),
    toolApprovals:
      newExperts.length === 0
        ? toolApprovals
        : {
            spawn_expert: "ask",
            continue_expert: "ask",
            ...toolApprovals,
          },
  };
}

export function toolApprovalKey(runtimeKey: string, toolName: string): string {
  const sanitized = toolName.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_") || "tool";
  return `mcp_${runtimeKey}_${sanitized}`;
}

export function clearCapabilityToolSelection(input: {
  readonly capabilityReferences: ExpertDefinition["capabilities"];
  readonly toolApprovals: ExpertDefinition["toolApprovals"];
  readonly capabilities: readonly Capability[];
  readonly retainedApprovalKeys?: readonly string[];
}): {
  readonly capabilityReferences: ExpertDefinition["capabilities"];
  readonly toolApprovals: ExpertDefinition["toolApprovals"];
} {
  const removedKeys = new Set(
    input.capabilityReferences.flatMap((reference) => {
      if (reference.kind !== "tools") return [];
      const capability = input.capabilities.find(
        (candidate) => candidate.manifest.id === reference.capabilityId,
      );
      return capability === undefined
        ? []
        : reference.toolNames.map((name) => toolApprovalKey(capability.manifest.runtimeKey, name));
    }),
  );
  const retained = new Set(input.retainedApprovalKeys);
  return {
    capabilityReferences: input.capabilityReferences.filter(
      (reference) => reference.kind !== "tools",
    ),
    toolApprovals: Object.fromEntries(
      Object.entries(input.toolApprovals).filter(
        ([key]) => !removedKeys.has(key) || retained.has(key),
      ),
    ),
  };
}
