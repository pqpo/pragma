import type { ExpertAgentContextStore } from "@pragma/core";
import { canonicalPragmaResourceRef, type PragmaExpertResource } from "@pragma/interpreter/ast";
import { MemoryRecallScopeSchema } from "@pragma/memory";

import {
  ExpertMemoryContextStoreContentSchema,
  ExpertMemoryContextStoreDescriptorSchema,
  ExpertMemoryContextStoreEntrySchema,
  ExpertMemoryContextStoreSearchMatchSchema,
  type ExpertMemoryContextStoreContent,
  type ExpertMemoryContextStoreDescriptor,
  type ExpertMemoryContextStoreEntry,
  type ExpertMemoryContextStoreSearchMatch,
  type GetExpertMemoryContextStore,
  type ListExpertMemoryContextStoreEntries,
  type ReadExpertMemoryContextStoreEntry,
  type SearchExpertMemoryContextStore,
} from "../../../shared/contracts/index.ts";
import type { DesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import type { DesktopMemoryPlane } from "./desktop-memory-plane.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";

const MEMORY_STORE_ID = "memory";

export interface ExpertMemoryContextStoreBrowserService {
  get(input: GetExpertMemoryContextStore): Promise<ExpertMemoryContextStoreDescriptor>;
  list(
    input: ListExpertMemoryContextStoreEntries,
  ): Promise<readonly ExpertMemoryContextStoreEntry[]>;
  read(input: ReadExpertMemoryContextStoreEntry): Promise<ExpertMemoryContextStoreContent>;
  search(
    input: SearchExpertMemoryContextStore,
  ): Promise<readonly ExpertMemoryContextStoreSearchMatch[]>;
}

export function createExpertMemoryContextStoreBrowserService(options: {
  readonly project: PragmaProjectStore;
  readonly systemExperts: Pick<DesktopSystemExpertRegistry, "getResource">;
  readonly memory: DesktopMemoryPlane;
}): ExpertMemoryContextStoreBrowserService {
  const resolveExpert = async (expertRef: string): Promise<PragmaExpertResource> => {
    const project = await options.project.get();
    const projectExpert = project.resources.find(
      (resource): resource is PragmaExpertResource =>
        resource.kind === "Expert" && canonicalPragmaResourceRef(resource) === expertRef,
    );
    const resource = projectExpert ?? options.systemExperts.getResource(expertRef);
    if (resource === undefined) throw codedError("expert_not_found");
    return resource;
  };

  const open = async (
    input:
      | ListExpertMemoryContextStoreEntries
      | ReadExpertMemoryContextStoreEntry
      | SearchExpertMemoryContextStore,
  ): Promise<ExpertAgentContextStore> => {
    const expert = await resolveExpert(input.expertRef);
    const scopeId = `expert:${expert.metadata.id}`;
    if (input.scopeId !== scopeId) throw codedError("context_store_scope_not_found");
    return await options.memory.createContextStoreView({
      rootRef: expertRootRef(expert.metadata.id),
      expertRef: { type: "pragma.expert", id: expert.metadata.id },
      projectId: options.project.projectId,
    });
  };

  return {
    async get(input) {
      const expert = await resolveExpert(input.expertRef);
      const scopeId = `expert:${expert.metadata.id}`;
      const viewInput = {
        rootRef: expertRootRef(expert.metadata.id),
        expertRef: { type: "pragma.expert", id: expert.metadata.id },
        projectId: options.project.projectId,
      } as const;
      const available = await options.memory.isContextStoreViewAvailable(viewInput);
      const hasMemory = available
        ? await options.memory.hasContextStoreViewContent(viewInput)
        : false;
      return ExpertMemoryContextStoreDescriptorSchema.parse({
        schemaVersion: "pragma.desktop-expert-memory-context-store/v1",
        expertRef: input.expertRef,
        storeId: MEMORY_STORE_ID,
        namespace: MEMORY_STORE_ID,
        name: "Memory ContextStore",
        readOnly: true,
        searchable: true,
        hasMemory,
        root: {
          type: "pragma.expert",
          id: expert.metadata.id,
          name: expert.metadata.name,
        },
        defaultScopeId: scopeId,
        scopes: [
          {
            id: scopeId,
            expertId: expert.metadata.id,
            name: expert.metadata.name,
            role: "root",
            participation: "available",
            availability: available ? "available" : "recall_disabled",
          },
        ],
      });
    },

    async list(input) {
      const result = await (await open(input)).listContext({});
      return ExpertMemoryContextStoreEntrySchema.array().parse(unwrap(result));
    },

    async read(input) {
      const result = await (
        await open(input)
      ).readContext({
        id: input.id,
        start: input.start,
        offset: input.maxBytes,
      });
      return ExpertMemoryContextStoreContentSchema.parse(unwrap(result));
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
      return ExpertMemoryContextStoreSearchMatchSchema.array().parse(unique);
    },
  };
}

function expertRootRef(id: string) {
  return MemoryRecallScopeSchema.shape.rootRef.parse({
    type: "pragma.expert",
    id,
  });
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
