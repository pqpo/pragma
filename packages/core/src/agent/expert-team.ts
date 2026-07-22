import type { Expert } from "./expert-agent.ts";
import { normalizeRuntimeByExpert, type RuntimeByExpert } from "./agent-launcher.ts";
import {
  freshContextIdResolver,
  type ContextIdResolver,
} from "../execution/context-id-resolver.ts";

export type ExpertDefinition = Expert | ExpertTeam;

export interface ExpertTeamDelegationOptions {
  readonly allow?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly maxConcurrency?: number | undefined;
  readonly maxDepth?: number | undefined;
  readonly contextId?: ContextIdResolver | undefined;
  readonly runtimeByExpert?: RuntimeByExpert | undefined;
}

export interface DefineExpertTeamOptions {
  readonly id: string;
  readonly version: string;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly instructions?: string | undefined;
  readonly coordinator: Expert;
  readonly members: readonly Expert[];
  readonly delegation: ExpertTeamDelegationOptions;
}

export interface ExpertTeam {
  readonly kind: "expert-team";
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly instructions?: string | undefined;
  readonly coordinator: Expert;
  readonly members: readonly Expert[];
  readonly delegation: {
    readonly allow: ReadonlyMap<string, ReadonlySet<string>>;
    readonly maxConcurrency: number;
    readonly maxDepth: number;
    readonly contextId: ContextIdResolver;
    readonly runtimeByExpert: ReadonlyMap<string, string>;
  };
}

export function defineExpertTeam(options: DefineExpertTeamOptions): ExpertTeam {
  const participants = [options.coordinator, ...options.members];
  const ids = participants.map((expert) => expert.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`ExpertTeam ${options.id} contains duplicate Expert ids.`);
  }

  const known = new Set(ids);
  const allow = new Map<string, ReadonlySet<string>>();
  const configuredAllow = options.delegation.allow ?? {
    [options.coordinator.id]: options.members.map((expert) => expert.id),
  };
  for (const [source, targets] of Object.entries(configuredAllow)) {
    if (!known.has(source)) {
      throw new Error(`ExpertTeam ${options.id} delegation source is unknown: ${source}`);
    }
    const targetSet = new Set<string>();
    for (const target of targets) {
      if (!known.has(target)) {
        throw new Error(`ExpertTeam ${options.id} delegation target is unknown: ${target}`);
      }
      if (source === target) {
        throw new Error(`ExpertTeam ${options.id} does not allow self delegation: ${source}`);
      }
      targetSet.add(target);
    }
    allow.set(source, targetSet);
  }

  const routableExpertIds = new Set([...allow.values()].flatMap((targets) => [...targets]));
  const routableExperts = participants.filter((expert) => routableExpertIds.has(expert.id));
  const runtimeByExpert = normalizeRuntimeByExpert(
    options.delegation.runtimeByExpert,
    routableExperts,
    `ExpertTeam ${options.id}`,
  );

  const maxConcurrency = readPositiveInteger(
    options.delegation.maxConcurrency ?? 4,
    "maxConcurrency",
  );
  const maxDepth = readPositiveInteger(options.delegation.maxDepth ?? 3, "maxDepth");

  return Object.freeze({
    kind: "expert-team" as const,
    id: readNonEmpty(options.id, "id"),
    version: readNonEmpty(options.version, "version"),
    name: options.name ?? options.coordinator.name,
    description: options.description ?? options.coordinator.description,
    ...(options.instructions === undefined
      ? {}
      : { instructions: readNonEmpty(options.instructions, "instructions") }),
    coordinator: options.coordinator,
    members: Object.freeze([...options.members]),
    delegation: Object.freeze({
      allow,
      maxConcurrency,
      maxDepth,
      contextId: options.delegation.contextId ?? freshContextIdResolver,
      runtimeByExpert,
    }),
  });
}

export function isExpertTeam(expert: ExpertDefinition): expert is ExpertTeam {
  return "kind" in expert && expert.kind === "expert-team";
}

function readPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`ExpertTeam ${field} must be a positive integer.`);
  }
  return value;
}

function readNonEmpty(value: string, field: string): string {
  if (value.trim() === "") throw new Error(`ExpertTeam ${field} must not be empty.`);
  return value;
}
