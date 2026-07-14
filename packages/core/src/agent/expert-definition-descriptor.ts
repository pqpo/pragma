import { createHash } from "node:crypto";

import { describeContextIdResolver } from "../execution/context-id-resolver.ts";
import { readAgentDelegationDefinition } from "./agent-launcher.ts";
import type { Expert } from "./expert-agent.ts";
import { isExpertTeam, type ExpertDefinition } from "./expert-team.ts";

export function describeExpertExecutionDefinition(definition: ExpertDefinition): unknown {
  return describeDefinition(definition, new Set<string>());
}

export function fingerprintExpertExecutionDefinition(definition: ExpertDefinition): string {
  return createHash("sha256")
    .update(JSON.stringify(describeExpertExecutionDefinition(definition)))
    .digest("hex");
}

function describeDefinition(definition: ExpertDefinition, ancestors: Set<string>): unknown {
  if (isExpertTeam(definition)) {
    return {
      kind: "expert-team",
      id: definition.id,
      version: definition.version,
      coordinator: { id: definition.coordinator.id, version: definition.coordinator.version },
      members: definition.members
        .map((member) => ({ id: member.id, version: member.version }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      delegation: {
        allow: [...definition.delegation.allow.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([source, targets]) => [source, [...targets].sort()]),
        maxConcurrency: definition.delegation.maxConcurrency,
        maxDepth: definition.delegation.maxDepth,
        contextId: describeContextIdResolver(definition.delegation.contextId),
      },
    };
  }
  if (ancestors.has(definition.id)) {
    return { kind: "expert", id: definition.id, version: definition.version, recursive: true };
  }
  const nextAncestors = new Set(ancestors).add(definition.id);
  return {
    kind: "expert",
    id: definition.id,
    version: definition.version,
    delegation: describeLauncher(definition, nextAncestors),
  };
}

function describeLauncher(definition: Expert, ancestors: Set<string>): unknown {
  const launchers = new Set(
    (definition.tools ?? []).flatMap((tool) => {
      const launcher = readAgentDelegationDefinition(tool);
      return launcher === undefined ? [] : [launcher];
    }),
  );
  if (launchers.size > 1) throw new Error(`Expert ${definition.id} has multiple agent launchers.`);
  const launcher = [...launchers][0];
  if (launcher === undefined) return undefined;
  return {
    experts: launcher.experts
      .map((expert) => describeDefinition(expert, ancestors))
      .sort((left, right) => descriptorId(left).localeCompare(descriptorId(right))),
    maxConcurrency: launcher.maxConcurrency,
    maxDepth: launcher.maxDepth,
    contextId: describeContextIdResolver(launcher.contextId),
  };
}

function descriptorId(value: unknown): string {
  if (typeof value !== "object" || value === null || !("id" in value)) return "";
  return String(value.id);
}
