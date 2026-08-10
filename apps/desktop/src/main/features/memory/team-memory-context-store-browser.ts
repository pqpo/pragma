import type { ExpertAgentContextStore } from "@pragma/core";
import { canonicalPragmaResourceRef, type PragmaExpertTeamResource } from "@pragma/interpreter/ast";
import { MemoryRecallScopeSchema } from "@pragma/memory";

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
  const resolveTeam = async (teamRef: string): Promise<PragmaExpertTeamResource> => {
    const project = await options.project.get();
    const team = project.resources.find(
      (resource): resource is PragmaExpertTeamResource =>
        resource.kind === "ExpertTeam" && canonicalPragmaResourceRef(resource) === teamRef,
    );
    if (team === undefined) throw codedError("team_not_found");
    return team;
  };

  const viewInput = (team: PragmaExpertTeamResource) => ({
    rootRef: MemoryRecallScopeSchema.shape.rootRef.parse({
      type: "pragma.expert-team",
      id: team.metadata.id,
    }),
    projectId: options.project.projectId,
  });

  const open = async (
    input:
      | ListTeamMemoryContextStoreEntries
      | ReadTeamMemoryContextStoreEntry
      | SearchTeamMemoryContextStore,
  ): Promise<ExpertAgentContextStore> => {
    const team = await resolveTeam(input.teamRef);
    if (input.scopeId !== `team:${team.metadata.id}`) {
      throw codedError("context_store_scope_not_found");
    }
    return await options.memory.createContextStoreView(viewInput(team));
  };

  return {
    async get(input) {
      const team = await resolveTeam(input.teamRef);
      const scopeId = `team:${team.metadata.id}`;
      const target = viewInput(team);
      const available = await options.memory.isContextStoreViewAvailable(target);
      const hasMemory = available ? await options.memory.hasContextStoreViewContent(target) : false;
      return TeamMemoryContextStoreDescriptorSchema.parse({
        schemaVersion: "pragma.desktop-team-memory-context-store/v1",
        teamRef: input.teamRef,
        storeId: MEMORY_STORE_ID,
        namespace: MEMORY_STORE_ID,
        name: "Memory ContextStore",
        readOnly: true,
        searchable: true,
        hasMemory,
        root: {
          type: "pragma.expert-team",
          id: team.metadata.id,
          name: team.metadata.name,
        },
        defaultScopeId: scopeId,
        scopes: [
          {
            id: scopeId,
            expertId: team.metadata.id,
            name: team.metadata.name,
            role: "root",
            participation: "available",
            availability: available ? "available" : "recall_disabled",
          },
        ],
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
