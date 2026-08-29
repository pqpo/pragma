import type { Expert } from "./expert-agent.ts";
import type { ExpertAgentContextStore } from "../context-system/context-system.ts";
import { normalizeRuntimeByExpert, type RuntimeByExpert } from "./agent-launcher.ts";

export type ExpertDefinition = Expert | ExpertTeam;

export interface ExpertTeamDelegationOptions {
  readonly permissions?:
    | {
        readonly spawn?: Readonly<Record<string, readonly string[]>> | undefined;
        readonly interact?: Readonly<Record<string, readonly string[]>> | undefined;
      }
    | undefined;
  readonly maxConcurrency?: number | undefined;
  readonly maxDepth?: number | undefined;
  readonly runtimeByExpert?: RuntimeByExpert | undefined;
}

export interface DefineExpertTeamOptions {
  readonly id: string;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly instructions?: string | undefined;
  readonly coordinator: Expert;
  readonly members: readonly Expert[];
  readonly contextStores?: readonly ExpertTeamContextStoreBinding[] | undefined;
  readonly delegation: ExpertTeamDelegationOptions;
}

export type ExpertTeamContextVisibility =
  | { readonly mode: "all" }
  | { readonly mode: "blacklist"; readonly expertIds: readonly string[] }
  | { readonly mode: "whitelist"; readonly expertIds: readonly string[] };

export interface ExpertTeamContextStoreBinding {
  readonly namespace: string;
  readonly store: ExpertAgentContextStore;
  readonly storeName?: string | undefined;
  readonly required?: boolean | undefined;
  readonly visibility: ExpertTeamContextVisibility;
}

export interface ExpertTeam {
  readonly kind: "expert-team";
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly instructions?: string | undefined;
  readonly coordinator: Expert;
  readonly members: readonly Expert[];
  readonly contextStores: readonly ExpertTeamContextStoreBinding[];
  readonly delegation: {
    readonly permissions: {
      readonly spawn: ReadonlyMap<string, ReadonlySet<string>>;
      readonly interact: ReadonlyMap<string, ReadonlySet<string>>;
    };
    readonly maxConcurrency: number;
    readonly maxDepth: number;
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
  const contextNamespaces = new Set<string>();
  const contextStores = (options.contextStores ?? []).map((binding) => {
    const namespace = readNonEmpty(binding.namespace, "contextStores.namespace");
    if (contextNamespaces.has(namespace)) {
      throw new Error(
        `ExpertTeam ${options.id} contains duplicate Context namespace: ${namespace}`,
      );
    }
    contextNamespaces.add(namespace);
    const selected = binding.visibility.mode === "all" ? [] : [...binding.visibility.expertIds];
    if (new Set(selected).size !== selected.length) {
      throw new Error(`ExpertTeam ${options.id} Context visibility contains duplicate Expert ids.`);
    }
    for (const expertId of selected) {
      if (!known.has(expertId)) {
        throw new Error(
          `ExpertTeam ${options.id} Context visibility references unknown Expert: ${expertId}`,
        );
      }
    }
    const visible = ids.filter((expertId) =>
      binding.visibility.mode === "all"
        ? true
        : binding.visibility.mode === "whitelist"
          ? selected.includes(expertId)
          : !selected.includes(expertId),
    );
    if (visible.length === 0) {
      throw new Error(`ExpertTeam ${options.id} Context store must be visible to an Expert.`);
    }
    return Object.freeze({
      ...binding,
      namespace,
      required: binding.required ?? true,
      visibility:
        binding.visibility.mode === "all"
          ? Object.freeze({ mode: "all" as const })
          : Object.freeze({ ...binding.visibility, expertIds: Object.freeze(selected) }),
    });
  });
  for (const permission of ["spawn", "interact"] as const) {
    if (Object.hasOwn(options.delegation.permissions?.[permission] ?? {}, options.coordinator.id)) {
      throw new Error(
        `ExpertTeam ${options.id} ${permission} permission must not configure the coordinator; coordinator authority is system-inherited.`,
      );
    }
  }
  const spawn = normalizePermissionMap(
    options.id,
    "spawn",
    known,
    options.delegation.permissions?.spawn ?? {},
    false,
  );
  const interact = normalizePermissionMap(
    options.id,
    "interact",
    known,
    options.delegation.permissions?.interact ?? {},
    true,
  );

  const routableExpertIds = new Set([
    ...options.members.map((expert) => expert.id),
    ...[...spawn.values()].flatMap((targets) => [...targets]),
  ]);
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
    name: options.name ?? options.coordinator.name,
    description: options.description ?? options.coordinator.description,
    ...(options.instructions === undefined
      ? {}
      : { instructions: readNonEmpty(options.instructions, "instructions") }),
    coordinator: options.coordinator,
    members: Object.freeze([...options.members]),
    contextStores: Object.freeze(contextStores),
    delegation: Object.freeze({
      permissions: Object.freeze({ spawn, interact }),
      maxConcurrency,
      maxDepth,
      runtimeByExpert,
    }),
  });
}

function normalizePermissionMap(
  teamId: string,
  permission: "spawn" | "interact",
  known: ReadonlySet<string>,
  configured: Readonly<Record<string, readonly string[]>>,
  allowSameExpert: boolean,
): ReadonlyMap<string, ReadonlySet<string>> {
  const normalized = new Map<string, ReadonlySet<string>>();
  for (const [source, targets] of Object.entries(configured)) {
    if (!known.has(source)) {
      throw new Error(`ExpertTeam ${teamId} ${permission} source is unknown: ${source}`);
    }
    const targetSet = new Set<string>();
    for (const target of targets) {
      if (!known.has(target)) {
        throw new Error(`ExpertTeam ${teamId} ${permission} target is unknown: ${target}`);
      }
      if (!allowSameExpert && source === target) {
        throw new Error(`ExpertTeam ${teamId} does not allow self spawn: ${source}`);
      }
      targetSet.add(target);
    }
    normalized.set(source, targetSet);
  }
  return normalized;
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
