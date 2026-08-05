import type { ExpertAgentContextStore } from "@pragma/core";
import { MemoryRecallScopeSchema } from "@pragma/memory";
import { canonicalPragmaResourceRef, type PragmaResource } from "@pragma/interpreter/ast";

import {
  MissionContextStoreContentSchema,
  MissionContextStoreDescriptorSchema,
  MissionContextStoreEntrySchema,
  MissionContextStoreSearchMatchSchema,
  type GetMissionContextStore,
  type ListMissionContextStoreEntries,
  type Mission,
  type MissionContextStoreContent,
  type MissionContextStoreDescriptor,
  type MissionContextStoreEntry,
  type MissionContextStoreScope,
  type MissionContextStoreSearchMatch,
  type ReadMissionContextStoreEntry,
  type SearchMissionContextStore,
} from "../../../shared/contracts/index.ts";
import type { DesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import type { DesktopMemoryPlane } from "../memory/desktop-memory-plane.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { MissionRunner } from "./mission-runner.ts";
import type { MissionStore } from "./mission-store.ts";

const MEMORY_STORE_ID = "memory";

type ScopeRole = MissionContextStoreScope["role"];

const SCOPE_ROLE_RANK: Readonly<Record<ScopeRole, number>> = {
  root: 0,
  coordinator: 1,
  "flow-step": 2,
  member: 3,
  delegated: 4,
  observed: 5,
};

interface ScopeCandidate {
  readonly expertId: string;
  readonly name: string;
  readonly role: ScopeRole;
}

export interface MissionContextStoreBrowserService {
  get(input: GetMissionContextStore): Promise<MissionContextStoreDescriptor>;
  list(input: ListMissionContextStoreEntries): Promise<readonly MissionContextStoreEntry[]>;
  read(input: ReadMissionContextStoreEntry): Promise<MissionContextStoreContent>;
  search(input: SearchMissionContextStore): Promise<readonly MissionContextStoreSearchMatch[]>;
}

export function createMissionContextStoreBrowserService(options: {
  readonly missions: MissionStore;
  readonly project: PragmaProjectStore;
  readonly systemExperts: DesktopSystemExpertRegistry;
  readonly memory: DesktopMemoryPlane;
  readonly runner: Pick<MissionRunner, "getWork">;
}): MissionContextStoreBrowserService {
  const catalog = async (input: GetMissionContextStore) => {
    assertMemoryStore(input.storeId);
    const mission = await userMission(options.missions, input.missionId);
    const { candidates, participated } = await collectScopeCandidates(mission, options);
    const rootRef = missionRootRef(mission);
    const scopes = await Promise.all(
      candidates.map(async (candidate) => ({
        id: `expert:${candidate.expertId}`,
        expertId: candidate.expertId,
        name: candidate.name,
        role: candidate.role,
        participation: participated.has(candidate.expertId) ? "participated" : "available",
        availability: await scopeAvailability(options.memory, {
          rootRef,
          expertId: candidate.expertId,
          projectId: mission.project.id,
        }),
      })),
    );
    const defaultScope =
      scopes.find((scope) => scope.role === "root" || scope.role === "coordinator") ?? scopes[0];
    if (defaultScope === undefined) throw codedError("context_store_scope_unavailable");
    return { mission, rootRef, scopes, defaultScope };
  };

  const open = async (
    input:
      ListMissionContextStoreEntries | ReadMissionContextStoreEntry | SearchMissionContextStore,
  ): Promise<ExpertAgentContextStore> => {
    assertMemoryStore(input.storeId);
    const mission = await userMission(options.missions, input.missionId);
    const { candidates } = await collectScopeCandidates(mission, options);
    const scope = candidates.find((candidate) => `expert:${candidate.expertId}` === input.scopeId);
    if (scope === undefined) throw codedError("context_store_scope_not_found");
    return await options.memory.createContextStoreView({
      rootRef: missionRootRef(mission),
      expertRef: { type: "pragma.expert", id: scope.expertId },
      projectId: mission.project.id,
    });
  };

  return {
    async get(input) {
      const resolved = await catalog(input);
      return MissionContextStoreDescriptorSchema.parse({
        schemaVersion: "pragma.desktop-mission-context-store/v1",
        missionId: resolved.mission.id,
        storeId: MEMORY_STORE_ID,
        namespace: "memory",
        name: "Memory ContextStore",
        readOnly: true,
        searchable: true,
        root: {
          ...resolved.rootRef,
          name: resolved.mission.executor.name,
        },
        defaultScopeId: resolved.defaultScope.id,
        scopes: resolved.scopes,
      });
    },

    async list(input) {
      const result = await (await open(input)).listContext({});
      return MissionContextStoreEntrySchema.array().parse(unwrap(result));
    },

    async read(input) {
      const result = await (
        await open(input)
      ).readContext({
        id: input.id,
        start: input.start,
        offset: input.maxBytes,
      });
      return MissionContextStoreContentSchema.parse(unwrap(result));
    },

    async search(input) {
      const store = await open(input);
      const searchInput = {
        query: input.query,
        maxResults: input.maxResults,
        contextLines: input.contextLines,
      };
      const [content, paths] = await Promise.all([
        store.searchContext(searchInput),
        store.searchContext({ ...searchInput, scope: "path" }),
      ]);
      const merged = [...unwrap(content), ...unwrap(paths)];
      const unique = [
        ...new Map(
          merged.map((match) => [
            `${match.id}\0${match.matchType ?? "content"}\0${match.lineNumber ?? 0}\0${match.line}`,
            match,
          ]),
        ).values(),
      ].slice(0, input.maxResults);
      return MissionContextStoreSearchMatchSchema.array().parse(unique);
    },
  };
}

async function collectScopeCandidates(
  mission: Mission,
  options: {
    readonly project: PragmaProjectStore;
    readonly systemExperts: DesktopSystemExpertRegistry;
    readonly runner: Pick<MissionRunner, "getWork">;
  },
): Promise<{
  readonly candidates: readonly ScopeCandidate[];
  readonly participated: ReadonlySet<string>;
}> {
  const project = await options.project.openRevision(mission.project.revision);
  const rootSystemResource = options.systemExperts.getResource(mission.executor.ref);
  const resources = [
    ...project.listResources(),
    ...(rootSystemResource === undefined ? [] : [rootSystemResource]),
    ...options.systemExperts.getAdditionalResources(mission.executor.ref),
  ];
  const byRef = new Map(
    resources.map((resource) => [canonicalPragmaResourceRef(resource), resource]),
  );
  const scopes = new Map<string, ScopeCandidate>();
  const visited = new Set<string>();

  const addExpert = (
    resource: Extract<PragmaResource, { readonly kind: "Expert" }>,
    role: ScopeRole,
  ) => {
    const current = scopes.get(resource.metadata.id);
    if (current === undefined || roleRank(role) < roleRank(current.role)) {
      scopes.set(resource.metadata.id, {
        expertId: resource.metadata.id,
        name: resource.metadata.name,
        role,
      });
    }
  };
  const visit = (ref: string, role: ScopeRole): void => {
    const resource = byRef.get(ref);
    if (resource === undefined) return;
    if (resource.kind === "Expert") {
      addExpert(resource, role);
      if (visited.has(ref)) return;
      visited.add(ref);
      for (const tool of resource.spec.tools) {
        for (const target of [
          ...(tool.target === undefined ? [] : [tool.target]),
          ...(tool.targets ?? []),
        ]) {
          visit(target.ref, "delegated");
        }
      }
      return;
    }
    if (resource.kind === "ExpertTeam") {
      if (visited.has(ref)) return;
      visited.add(ref);
      visit(resource.spec.coordinator.ref, "coordinator");
      for (const member of resource.spec.members) visit(member.ref, "member");
      return;
    }
    if (resource.kind === "Flow") {
      if (visited.has(ref)) return;
      visited.add(ref);
      for (const step of Object.values(resource.spec.graph.steps)) {
        if (step.expert !== undefined) visit(step.expert.ref, "flow-step");
        if (step.team !== undefined) visit(step.team.ref, "flow-step");
        if (step.flow !== undefined) visit(step.flow.ref, "flow-step");
      }
    }
  };

  visit(
    mission.executor.ref,
    mission.executor.kind === "expert"
      ? "root"
      : mission.executor.kind === "team"
        ? "coordinator"
        : "flow-step",
  );

  const work = await options.runner.getWork(mission.id);
  const participated = new Set(
    (work?.records ?? []).flatMap((record) =>
      record.executorId === undefined ? [] : [record.executorId],
    ),
  );
  const names = new Map(
    resources.map((resource) => [resource.metadata.id, resource.metadata.name]),
  );
  for (const record of work?.records ?? []) {
    if (record.executorId === undefined || scopes.has(record.executorId)) continue;
    const valid = MemoryRecallScopeSchema.safeParse({
      rootRef: missionRootRef(mission),
      expertRef: { type: "pragma.expert", id: record.executorId },
    });
    if (!valid.success) continue;
    scopes.set(record.executorId, {
      expertId: record.executorId,
      name: names.get(record.executorId) ?? record.title ?? record.executorId,
      role: "observed",
    });
  }

  if (scopes.size === 0 && mission.executor.kind === "expert") {
    const expertId = mission.executor.ref.slice("expert:".length);
    scopes.set(expertId, { expertId, name: mission.executor.name, role: "root" });
  }
  return {
    candidates: [...scopes.values()].toSorted(
      (left, right) =>
        roleRank(left.role) - roleRank(right.role) || left.name.localeCompare(right.name),
    ),
    participated,
  };
}

function missionRootRef(mission: Mission) {
  const type =
    mission.executor.kind === "team"
      ? "pragma.expert-team"
      : mission.executor.kind === "flow"
        ? "pragma.flow"
        : "pragma.expert";
  const expectedPrefix = `${mission.executor.kind}:`;
  if (!mission.executor.ref.startsWith(expectedPrefix)) {
    throw codedError(
      "invalid_mission_executor_ref",
      `Mission executor kind ${mission.executor.kind} does not match ${mission.executor.ref}.`,
    );
  }
  return MemoryRecallScopeSchema.shape.rootRef.parse({
    type,
    id: mission.executor.ref.slice(expectedPrefix.length),
  });
}

async function scopeAvailability(
  memory: DesktopMemoryPlane,
  input: {
    readonly rootRef: ReturnType<typeof missionRootRef>;
    readonly expertId: string;
    readonly projectId: string;
  },
): Promise<"available" | "recall_disabled"> {
  const available = await memory.isContextStoreViewAvailable({
    rootRef: input.rootRef,
    expertRef: { type: "pragma.expert", id: input.expertId },
    projectId: input.projectId,
  });
  return available ? "available" : "recall_disabled";
}

async function userMission(missions: MissionStore, missionId: string): Promise<Mission> {
  const mission = await missions.get(missionId);
  if (mission.origin.type !== "user") throw codedError("mission_not_found");
  return mission;
}

function assertMemoryStore(storeId: string): void {
  if (storeId !== MEMORY_STORE_ID) throw codedError("context_store_not_found");
}

function unwrap<T>(result: import("@pragma/core").ExpertAgentContextResult<T>): T {
  if (result.ok) return result.value;
  throw codedError(result.error.code, result.error.message);
}

function codedError(code: string, message = code): Error {
  const error = new Error(message);
  Object.assign(error, { code });
  return error;
}

function roleRank(role: ScopeRole): number {
  return SCOPE_ROLE_RANK[role];
}
