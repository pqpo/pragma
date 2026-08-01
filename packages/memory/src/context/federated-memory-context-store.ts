import {
  StaticContextStore,
  error,
  ok,
  type ExpertAgentContextItemListInput,
  type ExpertAgentContextItemSearchMatch,
  type ExpertAgentContextResult,
  type ExpertAgentContextStore,
  type ExpertAgentContextItemSummary,
  type ExpertAgentStoredContextItem,
  type ExpertAgentStoredContextItemDeleteInput,
  type ExpertAgentStoredContextItemEditInput,
  type ExpertAgentStoredContextItemEditResult,
  type ExpertAgentStoredContextItemReadInput,
  type ExpertAgentStoredContextItemReadResult,
  type ExpertAgentStoredContextItemSearchInput,
  type ExpertAgentStoredContextRegisterInput,
} from "@pragma/core";

import { MemoryModuleRegistry } from "../pipeline/memory-module.ts";

export const MEMORY_CONTEXT_NAMESPACE = "memory";

export function createFederatedMemoryContextStore(
  registry: MemoryModuleRegistry,
): ExpertAgentContextStore {
  const catalogStore = (): StaticContextStore =>
    new StaticContextStore([
      {
        id: "catalog.md",
        content: renderCatalog(registry),
        metadata: {
          description: "Registered Memory Modules and current health.",
          trigger: "model_decision",
          priority: "normal",
          trustLevel: "system",
          sensitivity: "internal",
        },
      },
    ]);

  return {
    async listContext(input: ExpertAgentContextItemListInput = {}) {
      const catalog = await catalogStore().listContext(input);
      if (!catalog.ok) return catalog;
      const items: ExpertAgentContextItemSummary[] = [...catalog.value];
      for (const module of registry.list()) {
        const result = await module.contextProvider.listContext(input);
        if (!result.ok) continue;
        items.push(
          ...result.value.map((item) => ({
            ...item,
            id: `${module.descriptor.pathPrefix}/${item.id}`,
          })),
        );
      }
      return ok(items.toSorted((left, right) => left.id.localeCompare(right.id)));
    },

    async readContext(input: ExpertAgentStoredContextItemReadInput) {
      if (input.id === "catalog.md") return await catalogStore().readContext(input);
      const route = resolveRoute(registry, input.id);
      if (route === undefined)
        return error("context_not_found", `Memory context not found: ${input.id}`);
      const result = await route.module.contextProvider.readContext({
        ...input,
        id: route.localId,
      });
      return mapReadResult(result, route.module.descriptor.pathPrefix);
    },

    async searchContext(input: ExpertAgentStoredContextItemSearchInput) {
      const matches: ExpertAgentContextItemSearchMatch[] = [];
      const catalog = await catalogStore().searchContext(input);
      if (catalog.ok) matches.push(...catalog.value);
      for (const module of registry.list()) {
        const result = await module.contextProvider.searchContext(input);
        if (!result.ok) continue;
        matches.push(
          ...result.value.map((match) => ({
            ...match,
            id: `${module.descriptor.pathPrefix}/${match.id}`,
          })),
        );
      }
      return ok(matches.slice(0, input.maxResults ?? matches.length));
    },

    async addContext(input: ExpertAgentStoredContextRegisterInput) {
      return denied<ExpertAgentStoredContextItem>("add", input.id);
    },
    async editContext(input: ExpertAgentStoredContextItemEditInput) {
      return denied<ExpertAgentStoredContextItemEditResult>("edit", input.id);
    },
    async deleteContext(input: ExpertAgentStoredContextItemDeleteInput) {
      return denied<{ readonly id: string }>("delete", input.id);
    },
  };
}

function resolveRoute(registry: MemoryModuleRegistry, id: string) {
  const separator = id.indexOf("/");
  if (separator <= 0 || separator === id.length - 1) return undefined;
  const prefix = id.slice(0, separator);
  const module = registry.resolvePrefix(prefix);
  return module === undefined ? undefined : { module, localId: id.slice(separator + 1) };
}

function mapReadResult(
  result: ExpertAgentContextResult<ExpertAgentStoredContextItemReadResult>,
  prefix: string,
): ExpertAgentContextResult<ExpertAgentStoredContextItemReadResult> {
  return result.ok ? ok({ ...result.value, id: `${prefix}/${result.value.id}` }) : result;
}

function denied<T>(operation: string, id: string): ExpertAgentContextResult<T> {
  return error("permission_denied", `Memory Context Store does not allow ${operation}: ${id}`, {
    operation,
    id,
  });
}

function renderCatalog(registry: MemoryModuleRegistry): string {
  const modules = registry.list();
  return [
    "# Memory Modules",
    "",
    ...(modules.length === 0
      ? ["No Memory Modules are registered."]
      : modules.map((module) => {
          const diagnostic = registry.diagnostic(module.descriptor.id);
          const health = diagnostic?.status ?? "healthy";
          const cursor = diagnostic?.cursor?.sequence ?? 0;
          const lag = diagnostic?.lag ?? 0;
          return `- ${module.descriptor.id}@${module.descriptor.version} — ${module.descriptor.pathPrefix}/ — ${module.descriptor.storageModel} — ${health} — cursor ${cursor}, lag ${lag}`;
        })),
    "",
  ].join("\n");
}
