import { type Expert, type FlowStepReference } from "@pragma/core";
import {
  type PragmaDiagnostic,
  type PragmaDeclarativeResource,
  type PragmaResource,
  type PragmaSemanticResourceRef,
} from "../ast/pragma-dsl.schema.ts";
import { canonicalPragmaResourceRef, parsePragmaReference } from "../ast/resource-identity.ts";
import { type InvocableResource } from "../runtime/registries.ts";
import {
  type IndexedResource,
  type LockedResourceRef,
  PragmaDslError,
} from "./project-contracts.ts";

interface ResourceDependency {
  readonly ref: string;
  readonly path: readonly (string | number)[];
}

interface ResourceDependencyEdge extends ResourceDependency {
  readonly target: string;
}

interface ResourceCycle {
  readonly refs: readonly string[];
  readonly sourceRef: string;
  readonly path: readonly (string | number)[];
}

function findResourceCycles(
  nodes: ReadonlySet<string>,
  edges: ReadonlyMap<string, readonly ResourceDependencyEdge[]>,
): readonly ResourceCycle[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles: ResourceCycle[] = [];

  const visit = (node: string): void => {
    visiting.add(node);
    stack.push(node);
    for (const edge of edges.get(node) ?? []) {
      if (!nodes.has(edge.target)) continue;
      if (!visiting.has(edge.target) && !visited.has(edge.target)) {
        visit(edge.target);
        continue;
      }
      if (!visiting.has(edge.target)) continue;
      const cycleStart = stack.indexOf(edge.target);
      cycles.push({
        refs: [node, ...stack.slice(cycleStart)],
        sourceRef: node,
        path: edge.path,
      });
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };

  for (const node of [...nodes].sort()) {
    if (!visited.has(node)) visit(node);
  }
  return cycles;
}

export function validateResourceCycles(
  resources: ReadonlyMap<string, IndexedResource>,
): PragmaDiagnostic[] {
  const edges = new Map<string, readonly ResourceDependencyEdge[]>();
  for (const [key, indexed] of resources) {
    const dependencies = new Map<string, ResourceDependencyEdge>();
    for (const dependency of resourceDependencyEntries(indexed.resource)) {
      const parsed = parsePragmaReference(dependency.ref);
      const target = `${parsed.kind}:${parsed.id}`;
      if (!resources.has(target) || dependencies.has(target)) continue;
      dependencies.set(target, { ...dependency, target });
    }
    edges.set(
      key,
      [...dependencies.values()].sort((left, right) => left.target.localeCompare(right.target)),
    );
  }
  return findResourceCycles(new Set(resources.keys()), edges).map((cycle) => {
    const source = resources.get(cycle.sourceRef);
    return {
      severity: "error",
      code: "resource.cycle",
      message: `Pragma resource definitions must form an acyclic dependency graph: ${cycle.refs.join(" -> ")}.`,
      resourceRef: cycle.sourceRef as PragmaSemanticResourceRef,
      source: source?.source,
      path: [...cycle.path],
    };
  });
}

export function resourceDependencies(resource: PragmaResource): string[] {
  return resourceDependencyEntries(resource).map((dependency) => dependency.ref);
}

function resourceDependencyEntries(resource: PragmaResource): ResourceDependency[] {
  if (resource.kind === "Expert") {
    return [
      ...(resource.spec.runtime === undefined
        ? []
        : [{ ref: resource.spec.runtime.ref, path: ["spec", "runtime", "ref"] }]),
      ...resource.spec.capabilities.map((binding, index) => ({
        ref: binding.ref,
        path: ["spec", "capabilities", index, "ref"],
      })),
      ...resource.spec.contextStores.map((binding, index) => ({
        ref: binding.ref,
        path: ["spec", "contextStores", index, "ref"],
      })),
      ...resource.spec.tools.flatMap((binding, index) => [
        ...(binding.target === undefined
          ? binding.targets!.map((target, targetIndex) => ({
              ref: target.ref,
              path: ["spec", "tools", index, "targets", targetIndex, "ref"],
            }))
          : [
              {
                ref: binding.target.ref,
                path: ["spec", "tools", index, "target", "ref"],
              },
            ]),
        ...Object.entries(binding.policy?.runtimes ?? {}).map(([expertId, ref]) => ({
          ref,
          path: ["spec", "tools", index, "policy", "runtimes", expertId],
        })),
      ]),
    ];
  }
  if (resource.kind === "ExpertTeam") {
    return [
      { ref: resource.spec.coordinator.ref, path: ["spec", "coordinator", "ref"] },
      ...resource.spec.members.map((member, index) => ({
        ref: member.ref,
        path: ["spec", "members", index, "ref"],
      })),
      ...resource.spec.contextStores.map((binding, index) => ({
        ref: binding.ref,
        path: ["spec", "contextStores", index, "ref"],
      })),
      ...Object.entries(resource.spec.delegation.runtimes).map(([expertId, ref]) => ({
        ref,
        path: ["spec", "delegation", "runtimes", expertId],
      })),
    ];
  }
  if (resource.kind === "Flow") {
    return Object.entries(resource.spec.graph.steps).flatMap(([stepId, step]) => {
      const target =
        step.expert === undefined
          ? step.team === undefined
            ? step.flow === undefined
              ? undefined
              : { ref: step.flow.ref, field: "flow" }
            : { ref: step.team.ref, field: "team" }
          : { ref: step.expert.ref, field: "expert" };
      return [
        ...(target === undefined
          ? []
          : [
              {
                ref: target.ref,
                path: ["spec", "graph", "steps", stepId, target.field, "ref"],
              },
            ]),
        ...(step.runtime === undefined
          ? []
          : [
              {
                ref: step.runtime.ref,
                path: ["spec", "graph", "steps", stepId, "runtime", "ref"],
              },
            ]),
        ...Object.entries(step.runtimes ?? {}).map(([expertId, ref]) => ({
          ref,
          path: ["spec", "graph", "steps", stepId, "runtimes", expertId],
        })),
      ];
    });
  }
  if (resource.kind === "Automation") {
    return [
      {
        ref: resource.spec.route.executor.ref,
        path: ["spec", "route", "executor", "ref"],
      },
    ];
  }
  if (resource.kind === "Evaluation") {
    if (!("target" in resource.spec) || resource.spec.method.type !== "flow-run-dry") return [];
    return [
      {
        ref: resource.spec.target.ref,
        path: ["spec", "target", "ref"],
      },
    ];
  }
  return [];
}

export function collectLockedDependencies(
  root: IndexedResource,
  resources: ReadonlyMap<string, IndexedResource>,
): LockedResourceRef[] {
  const result = new Map<string, LockedResourceRef>();
  const visit = (indexed: IndexedResource): void => {
    for (const ref of resourceDependencies(indexed.resource)) {
      const parsed = parsePragmaReference(ref);
      const dependency = resources.get(`${parsed.kind}:${parsed.id}`);
      if (dependency === undefined || result.has(canonicalRef(dependency.resource))) continue;
      result.set(canonicalRef(dependency.resource), {
        ref: canonicalRef(dependency.resource),
        contentHash: dependency.contentHash,
        source: dependency.source,
      });
      visit(dependency);
    }
  };
  visit(root);
  return [...result.values()].sort((left, right) => left.ref.localeCompare(right.ref));
}

export function isDeclarativeResource(
  resource: PragmaResource,
): resource is PragmaDeclarativeResource {
  return (
    resource.kind === "Capability" ||
    resource.kind === "ContextStore" ||
    resource.kind === "RuntimeProfile" ||
    resource.kind === "Automation"
  );
}

export function isInvocableResource(
  resource: PragmaResource,
): resource is Exclude<PragmaResource, PragmaDeclarativeResource> {
  return !isDeclarativeResource(resource);
}

export function isPlainExpert(value: InvocableResource): value is Expert {
  return !("kind" in value);
}

export function requireStepReference(
  references: ReadonlyMap<string, FlowStepReference>,
  id: string,
): FlowStepReference {
  const reference = references.get(id);
  if (reference === undefined) throw new PragmaDslError(`Unknown Flow step: ${id}`);
  return reference;
}

export function canonicalRef(resource: PragmaResource): PragmaSemanticResourceRef {
  return canonicalPragmaResourceRef(resource);
}
