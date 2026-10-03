import type { ExpertTeam } from "./expert-team.ts";
import type { Flow } from "../flow/flow.ts";

// Recovery definitions retain their persisted identity, but cannot acquire
// execution authority. This marker deliberately never enters a descriptor.
const stopOnlyDefinitions = new WeakSet<object>();

export class StopOnlyDefinitionExecutionError extends Error {
  readonly code = "STOP_ONLY_DEFINITION";

  constructor() {
    super("A stop-only definition cannot execute. Compile an execution definition first.");
    this.name = "StopOnlyDefinitionExecutionError";
  }
}

export function markStopOnlyDefinition<T extends object>(definition: T): T {
  stopOnlyDefinitions.add(definition);
  return definition;
}

export function assertExecutableDefinition(definition: object): void {
  if (isStopOnlyDefinition(definition)) throw new StopOnlyDefinitionExecutionError();
}

/** Also fences composition of a recovery definition into a new Team or Flow. */
export function isStopOnlyDefinition(definition: object): boolean {
  const seen = new Set<object>();
  const containsStopOnly = (current: object): boolean => {
    if (stopOnlyDefinitions.has(current)) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    if ("kind" in current && current.kind === "expert-team") {
      const team = current as ExpertTeam;
      return containsStopOnly(team.coordinator) || team.members.some(containsStopOnly);
    }
    if ("kind" in current && current.kind === "flow" && "steps" in current) {
      const flow = current as Flow;
      return [...flow.steps.values()].some((step) => containsStopOnly(step.definition));
    }
    return false;
  };
  return containsStopOnly(definition);
}
