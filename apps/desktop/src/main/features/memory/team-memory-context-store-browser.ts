import type { ExpertAgentContextStore } from "@pragma/core";
import {
  canonicalPragmaResourceRef,
  type PragmaExpertResource,
  type PragmaExpertTeamResource,
} from "@pragma/interpreter/ast";

import {
  TeamMemoryContextStoreContentSchema,
  TeamMemoryContextStoreDescriptorSchema,
  TeamMemoryContextStoreEntrySchema,
  TeamMemoryContextStoreSearchMatchSchema,
  type GetTeamMemoryContextStore,
  type ListTeamMemoryContextStoreEntries,
  type ReadTeamMemoryContextStoreEntry,
  type SearchTeamMemoryContextStore,
  type TeamMemoryContextStoreContent,
  type TeamMemoryContextStoreDescriptor,
  type TeamMemoryContextStoreEntry,
  type TeamMemoryContextStoreSearchMatch,
} from "../../../shared/contracts/index.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { DesktopMemoryPlane } from "./desktop-memory-plane.ts";
import {
  defineTeamMemoryScopes,
  inspectTeamMemoryScopes,
  type TeamMemoryScopeDefinition,
} from "./team-memory-scope-catalog.ts";

const MEMORY_STORE_ID = "memory";

export interface TeamMemoryContextStoreBrowserService {
  get(input: GetTeamMemoryContextStore): Promise<TeamMemoryContextStoreDescriptor>;
  list(input: ListTeamMemoryContextStoreEntries): Promise<readonly TeamMemoryContextStoreEntry[]>;
  read(input: ReadTeamMemoryContextStoreEntry): Promise<TeamMemoryContextStoreContent>;
  search(
    input: SearchTeamMemoryContextStore,
  ): Promise<readonly TeamMemoryContextStoreSearchMatch[]>;
}

export function createTeamMemoryContextStoreBrowserService(options: {
  readonly project: PragmaProjectStore;
  readonly memory: DesktopMemoryPlane;
}): TeamMemoryContextStoreBrowserService {
  const resolveTeamScopes = async (
    teamRef: string,
  ): Promise<{
    readonly team: PragmaExpertTeamResource;
    readonly definition: TeamMemoryScopeDefinition;
  }> => {
    const project = await options.project.get();
    const team = project.resources.find(
      (resource): resource is PragmaExpertTeamResource =>
        resource.kind === "ExpertTeam" && canonicalPragmaResourceRef(resource) === teamRef,
    );
    if (team === undefined) throw codedError("team_not_found");
    const expertsByRef = new Map(
      project.resources
        .filter((resource): resource is PragmaExpertResource => resource.kind === "Expert")
        .map((resource) => [canonicalPragmaResourceRef(resource), resource]),
    );
    const expertScopes = [
      { ref: team.spec.coordinator.ref, role: "coordinator" as const },
      ...team.spec.members.map((member) => ({ ref: member.ref, role: "member" as const })),
    ].map(({ ref, role }) => {
      const expert = expertsByRef.get(ref);
      if (expert === undefined)
        throw codedError("team_expert_not_found", `Expert not found: ${ref}`);
      return {
        expertId: expert.metadata.id,
        name: expert.metadata.name,
        role,
        participation: "available" as const,
      };
    });
    return {
      team,
      definition: defineTeamMemoryScopes({
        teamId: team.metadata.id,
        teamName: team.metadata.name,
        teamParticipation: "available",
        experts: expertScopes,
        projectId: options.project.projectId,
      }),
    };
  };

  const open = async (
    input:
      | ListTeamMemoryContextStoreEntries
      | ReadTeamMemoryContextStoreEntry
      | SearchTeamMemoryContextStore,
  ): Promise<ExpertAgentContextStore> => {
    const { definition } = await resolveTeamScopes(input.teamRef);
    const view = definition.views.get(input.scopeId);
    if (view === undefined) throw codedError("context_store_scope_not_found");
    return await options.memory.createContextStoreView(view);
  };

  return {
    async get(input) {
      const { team, definition } = await resolveTeamScopes(input.teamRef);
      const catalog = await inspectTeamMemoryScopes(definition, options.memory);
      return TeamMemoryContextStoreDescriptorSchema.parse({
        schemaVersion: "pragma.desktop-team-memory-context-store/v2",
        teamRef: input.teamRef,
        storeId: MEMORY_STORE_ID,
        namespace: MEMORY_STORE_ID,
        name: "Memory ContextStore",
        readOnly: true,
        searchable: true,
        hasMemory: catalog.hasMemory,
        root: {
          type: "pragma.expert-team",
          id: team.metadata.id,
          name: team.metadata.name,
        },
        defaultScopeId: catalog.defaultScopeId,
        scopes: catalog.scopes,
      });
    },

    async list(input) {
      return TeamMemoryContextStoreEntrySchema.array().parse(
        unwrap(await (await open(input)).listContext({})),
      );
    },

    async read(input) {
      return TeamMemoryContextStoreContentSchema.parse(
        unwrap(
          await (
            await open(input)
          ).readContext({ id: input.id, start: input.start, offset: input.maxBytes }),
        ),
      );
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
      const unique = [
        ...new Map(
          [...unwrap(content), ...unwrap(paths)].map((match) => [
            `${match.id}\0${match.matchType ?? "content"}\0${match.lineNumber ?? 0}\0${match.line}`,
            match,
          ]),
        ).values(),
      ].slice(0, input.maxResults);
      return TeamMemoryContextStoreSearchMatchSchema.array().parse(unique);
    },
  };
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
