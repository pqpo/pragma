import { MemoryRecallScopeSchema } from "@pragma/memory";

import type { MissionContextStoreScope } from "../../../shared/contracts/index.ts";
import type {
  DesktopMemoryContextStoreViewInput,
  DesktopMemoryPlane,
} from "./desktop-memory-plane.ts";

type ExpertScopeRole = Exclude<MissionContextStoreScope["role"], "root">;

export interface TeamMemoryExpertScopeCandidate {
  readonly expertId: string;
  readonly name: string;
  readonly role: ExpertScopeRole;
  readonly participation: MissionContextStoreScope["participation"];
}

export interface TeamMemoryScopeCatalog {
  readonly scopes: readonly MissionContextStoreScope[];
  readonly defaultScopeId: string;
  readonly hasMemory: boolean;
  readonly views: ReadonlyMap<string, DesktopMemoryContextStoreViewInput>;
}

export interface TeamMemoryScopeDefinition {
  readonly scopes: readonly Omit<MissionContextStoreScope, "availability">[];
  readonly defaultScopeId: string;
  readonly views: ReadonlyMap<string, DesktopMemoryContextStoreViewInput>;
}

export function defineTeamMemoryScopes(input: {
  readonly teamId: string;
  readonly teamName: string;
  readonly teamParticipation: MissionContextStoreScope["participation"];
  readonly experts: readonly TeamMemoryExpertScopeCandidate[];
  readonly projectId: string;
}): TeamMemoryScopeDefinition {
  const teamRootRef = MemoryRecallScopeSchema.shape.rootRef.parse({
    type: "pragma.expert-team",
    id: input.teamId,
  });
  const rootScopeId = `team:${input.teamId}`;
  const views = new Map<string, DesktopMemoryContextStoreViewInput>();
  views.set(rootScopeId, { rootRef: teamRootRef, projectId: input.projectId });

  const uniqueExperts = new Map<string, TeamMemoryExpertScopeCandidate>();
  for (const expert of input.experts) {
    if (!uniqueExperts.has(expert.expertId)) uniqueExperts.set(expert.expertId, expert);
  }
  for (const expert of uniqueExperts.values()) {
    const expertRef = MemoryRecallScopeSchema.shape.expertRef.unwrap().parse({
      type: "pragma.expert",
      id: expert.expertId,
    });
    views.set(`expert:${expert.expertId}`, {
      rootRef: expertRef,
      expertRef,
      projectId: input.projectId,
      policyScope: { rootRef: teamRootRef, producerRefs: [expertRef] },
    });
  }

  const scopes: Omit<MissionContextStoreScope, "availability">[] = [
    {
      id: rootScopeId,
      expertId: input.teamId,
      name: input.teamName,
      role: "root",
      participation: input.teamParticipation,
    },
    ...[...uniqueExperts.values()].map((expert) => ({
      id: `expert:${expert.expertId}`,
      expertId: expert.expertId,
      name: expert.name,
      role: expert.role,
      participation: expert.participation,
    })),
  ];
  return { scopes, defaultScopeId: rootScopeId, views };
}

export async function inspectTeamMemoryScopes(
  definition: TeamMemoryScopeDefinition,
  memory: Pick<DesktopMemoryPlane, "getContextStoreViewStatus">,
): Promise<TeamMemoryScopeCatalog> {
  const statuses = new Map<string, MissionContextStoreScope["availability"]>();
  await Promise.all(
    [...definition.views].map(async ([scopeId, view]) => {
      statuses.set(scopeId, await memory.getContextStoreViewStatus(view));
    }),
  );

  const scopes = definition.scopes.map((scope) => ({
    ...scope,
    availability: requireStatus(statuses, scope.id),
  }));
  return {
    scopes,
    defaultScopeId: definition.defaultScopeId,
    hasMemory: scopes.some((scope) => scope.availability === "available"),
    views: definition.views,
  };
}

function requireStatus(
  statuses: ReadonlyMap<string, MissionContextStoreScope["availability"]>,
  scopeId: string,
): MissionContextStoreScope["availability"] {
  const status = statuses.get(scopeId);
  if (status === undefined) throw new Error(`Memory scope status was not resolved: ${scopeId}`);
  return status;
}
