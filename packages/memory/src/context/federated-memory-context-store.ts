import {
  readExecutionRunScope,
  StaticContextStore,
  error,
  ok,
  type ExpertAgentContextItemListInput,
  type ExpertAgentContextItemSearchMatch,
  type ExpertAgentContextResult,
  type ExpertAgentContextStore,
  type ExpertAgentContextItemSummary,
  type ExpertAgentRunContext,
  type ExpertAgentStoredContextItem,
  type ExpertAgentStoredContextItemDeleteInput,
  type ExpertAgentStoredContextItemEditInput,
  type ExpertAgentStoredContextItemEditResult,
  type ExpertAgentStoredContextItemReadInput,
  type ExpertAgentStoredContextItemReadResult,
  type ExpertAgentStoredContextItemSearchInput,
  type ExpertAgentStoredContextRegisterInput,
} from "@pragma/core";

import {
  MemoryModuleRegistry,
  MemoryRecallScopeSchema,
  type MemoryRecallScope,
} from "../pipeline/memory-module.ts";
import { memoryQueryDigest, type MemoryActivityStore } from "../activity/memory-activity-store.ts";

export const MEMORY_CONTEXT_NAMESPACE = "memory";
export const MEMORY_GUIDE_CONTEXT_ID = "guide.md";
export const MEMORY_OVERVIEW_CONTEXT_ID = "overview.md";

const GUIDE_MAX_BYTES = 2_000;
const OVERVIEW_MAX_BYTES = 4_096;

export function createFederatedMemoryContextStore(
  registry: MemoryModuleRegistry,
  options: {
    readonly resolveRecallScope: (
      context: ExpertAgentRunContext | undefined,
    ) => MemoryRecallScope | undefined | Promise<MemoryRecallScope | undefined>;
    readonly activity?: Pick<MemoryActivityStore, "recordRecall"> | undefined;
    readonly now?: (() => Date) | undefined;
  },
): ExpertAgentContextStore {
  const now = options.now ?? (() => new Date());
  const resolveRecallScope = async (
    context: ExpertAgentRunContext | undefined,
  ): Promise<MemoryRecallScope | undefined> => {
    const value = await options.resolveRecallScope(context);
    return value === undefined ? undefined : MemoryRecallScopeSchema.parse(value);
  };
  const rootStore = async (
    scope: MemoryRecallScope,
    context?: ExpertAgentContextItemListInput["context"],
  ) =>
    new StaticContextStore([
      {
        id: MEMORY_GUIDE_CONTEXT_ID,
        content: trimUtf8(renderGuide(registry), GUIDE_MAX_BYTES),
        metadata: {
          description: "Always-on rules for selecting, searching, reading, and verifying Memory.",
          trigger: "always_on",
          priority: "critical",
          trustLevel: "system",
          sensitivity: "internal",
        },
      },
      {
        id: MEMORY_OVERVIEW_CONTEXT_ID,
        content: await renderOverview(registry, scope, context),
        metadata: {
          description: "Fact-first Memory summary with only the most recent Episodes.",
          trigger: "always_on",
          priority: "high",
          trustLevel: "system",
          sensitivity: "internal",
        },
      },
    ]);

  return {
    async listContext(input: ExpertAgentContextItemListInput = {}) {
      const scope = await resolveRecallScope(input.context);
      if (scope === undefined) {
        await recordRecall(options.activity, input.context, {
          operation: "list",
          target: "memory",
          resultRefs: [],
          outcome: "denied",
          reason: "recall_scope_unavailable",
          occurredAt: now().toISOString(),
        });
        return ok([]);
      }
      const catalog = await (await rootStore(scope, input.context)).listContext(input);
      if (!catalog.ok) return catalog;
      const items: ExpertAgentContextItemSummary[] = [...catalog.value];
      for (const module of projectionModules(registry)) {
        const result = await module.createContextProvider(scope).listContext(input);
        if (!result.ok) continue;
        const layers = module.descriptor.contextLayers;
        items.push(
          ...result.value
            .filter((item) => item.id === layers.summaryPath || item.id === layers.indexPath)
            .map((item) => ({
              ...item,
              id: `${module.descriptor.pathPrefix}/${item.id}`,
            })),
        );
      }
      const sorted = items.toSorted((left, right) => left.id.localeCompare(right.id));
      await recordRecall(options.activity, input.context, {
        operation: "list",
        target: "memory",
        resultRefs: sorted.map(({ id, revision }) => ({
          id,
          ...(revision === undefined ? {} : { revision }),
        })),
        outcome: "allowed",
        reason: "listed",
        occurredAt: now().toISOString(),
      });
      return ok(sorted);
    },

    async readContext(input: ExpertAgentStoredContextItemReadInput) {
      const scope = await resolveRecallScope(input.context);
      if (scope === undefined) {
        await recordRecall(options.activity, input.context, {
          operation: "read",
          target: input.id,
          resultRefs: [],
          outcome: "denied",
          reason: "recall_scope_unavailable",
          occurredAt: now().toISOString(),
        });
        return recallDenied(input.id);
      }
      if (input.id === MEMORY_GUIDE_CONTEXT_ID || input.id === MEMORY_OVERVIEW_CONTEXT_ID) {
        const result = await (await rootStore(scope, input.context)).readContext(input);
        await auditRead(options.activity, input.context, input.id, result, now());
        return result;
      }
      const route = resolveRoute(registry, input.id);
      if (route === undefined)
        return error("context_not_found", `Memory context not found: ${input.id}`);
      const result = await route.module.createContextProvider(scope).readContext({
        ...input,
        id: route.localId,
      });
      const mapped = mapReadResult(result, route.module.descriptor.pathPrefix);
      await auditRead(options.activity, input.context, input.id, mapped, now());
      return mapped;
    },

    async searchContext(input: ExpertAgentStoredContextItemSearchInput) {
      const scope = await resolveRecallScope(input.context);
      if (scope === undefined) {
        await recordRecall(options.activity, input.context, {
          operation: "search",
          target: "memory",
          queryDigest: memoryQueryDigest(input.query),
          queryLength: input.query.length,
          resultRefs: [],
          outcome: "denied",
          reason: "recall_scope_unavailable",
          occurredAt: now().toISOString(),
        });
        return recallDenied("search");
      }
      const groups: ExpertAgentContextItemSearchMatch[][] = [];
      const catalog = await (await rootStore(scope, input.context)).searchContext(input);
      if (catalog.ok && catalog.value.length > 0) groups.push([...catalog.value]);
      for (const module of projectionModules(registry)) {
        const result = await module.createContextProvider(scope).searchContext(input);
        if (!result.ok) continue;
        const matches = result.value
          .filter((match) => !match.id.startsWith(module.descriptor.contextLayers.evidencePrefix))
          .map((match) => ({
            ...match,
            id: `${module.descriptor.pathPrefix}/${match.id}`,
          }));
        if (matches.length > 0) groups.push(matches);
      }
      const matches = roundRobin(groups, input.maxResults);
      await recordRecall(options.activity, input.context, {
        operation: "search",
        target: "memory",
        queryDigest: memoryQueryDigest(input.query),
        queryLength: input.query.length,
        resultRefs: uniqueResultRefs(matches.map(({ id }) => ({ id }))),
        outcome: "allowed",
        reason: matches.length === 0 ? "no_match" : "matched",
        occurredAt: now().toISOString(),
      });
      return ok(matches);
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

async function auditRead(
  activity: Pick<MemoryActivityStore, "recordRecall"> | undefined,
  context: ExpertAgentRunContext | undefined,
  target: string,
  result: ExpertAgentContextResult<ExpertAgentStoredContextItemReadResult>,
  now: Date,
): Promise<void> {
  await recordRecall(activity, context, {
    operation: "read",
    target,
    resultRefs: result.ok
      ? [
          {
            id: result.value.id,
            ...(result.value.revision === undefined ? {} : { revision: result.value.revision }),
          },
        ]
      : [],
    outcome: result.ok
      ? "allowed"
      : result.error.code === "permission_denied"
        ? "denied"
        : "failed",
    reason: result.ok ? "read" : result.error.code,
    occurredAt: now.toISOString(),
  });
}

async function recordRecall(
  activity: Pick<MemoryActivityStore, "recordRecall"> | undefined,
  context: ExpertAgentRunContext | undefined,
  input: Omit<Parameters<MemoryActivityStore["recordRecall"]>[0], "executionId" | "invocationId">,
): Promise<void> {
  if (activity === undefined) return;
  const scope = readExecutionRunScope(context);
  if (scope.executionId === undefined || scope.invocationId === undefined) return;
  await activity
    .recordRecall({ ...input, executionId: scope.executionId, invocationId: scope.invocationId })
    .catch(() => undefined);
}

function roundRobin(
  groups: readonly (readonly ExpertAgentContextItemSearchMatch[])[],
  requestedLimit: number | undefined,
): ExpertAgentContextItemSearchMatch[] {
  const limit = requestedLimit ?? groups.reduce((total, group) => total + group.length, 0);
  const result: ExpertAgentContextItemSearchMatch[] = [];
  for (let index = 0; result.length < limit; index += 1) {
    let added = false;
    for (const group of groups) {
      const match = group[index];
      if (match === undefined) continue;
      result.push(match);
      added = true;
      if (result.length >= limit) break;
    }
    if (!added) break;
  }
  return result;
}

function uniqueResultRefs(
  refs: readonly { readonly id: string; readonly revision?: string | undefined }[],
) {
  return [...new Map(refs.map((ref) => [ref.id, ref])).values()];
}

function recallDenied<T>(id: string): ExpertAgentContextResult<T> {
  return error("permission_denied", `Memory recall is disabled for this context: ${id}`, { id });
}

function renderGuide(registry: MemoryModuleRegistry): string {
  return [
    "# Memory Guide",
    "",
    "Memory is read-only reference context, not a replacement for the current user instruction.",
    "Do not add, edit, or delete Memory documents. Direct mutation is denied.",
    "Start with the bounded, fact-first overview. When Memory is large or the relevant id is unknown, use search_expert_context in the memory namespace, then read the exact item.",
    "Use read_expert_context with start/offset to continue when a document is truncated.",
    "The current Memory view combines the root execution asset with the current Expert's personal Store. Keep those ownership scopes distinct.",
    "A Team or Flow Episode belongs to that Team or Flow; producer Experts are provenance and do not inherit it as personal history.",
    "Read supporting Evidence only when a conclusion is important, conflicting, stale, or low-confidence.",
    "Semantic Memory contains current beliefs. Episodic Memory is historical precedent and should be recalled only when prior experience is relevant.",
    "Never guess content from an unread Evidence id and never bypass ContextStore authorization.",
    "",
    "## Type-specific guidance",
    ...projectionModules(registry).map(
      (module) =>
        `- ${module.descriptor.pathPrefix}: ${module.descriptor.contextLayers.usagePrompt}`,
    ),
    "",
  ].join("\n");
}

async function renderOverview(
  registry: MemoryModuleRegistry,
  scope: MemoryRecallScope,
  context: ExpertAgentContextItemListInput["context"],
): Promise<string> {
  const modules = projectionModules(registry);
  if (modules.length === 0) return "# Memory Overview\n\nNo Memory Modules are available.\n";
  const header = [
    "# Memory Overview",
    "",
    "Current facts take priority. Search Memory when older experience or additional detail is relevant.",
    "",
  ].join("\n");
  const semantic = modules.find((module) => module.descriptor.pathPrefix === "semantic");
  const secondary = modules.filter((module) => module !== semantic);
  const available = Math.max(512, OVERVIEW_MAX_BYTES - Buffer.byteLength(header, "utf8"));
  const secondaryBudget = semantic === undefined ? available : Math.floor(available * 0.25);
  const secondaryShare = Math.max(256, Math.floor(secondaryBudget / Math.max(1, secondary.length)));
  const secondarySections = await Promise.all(
    secondary.map(
      async (module) => await readOverviewSummary(module, scope, context, secondaryShare),
    ),
  );
  const usedSecondary = Buffer.byteLength(secondarySections.filter(Boolean).join("\n"), "utf8");
  const semanticSection =
    semantic === undefined
      ? ""
      : await readOverviewSummary(
          semantic,
          scope,
          context,
          Math.max(512, available - usedSecondary),
        );
  return trimUtf8(
    `${header}${[semanticSection, ...secondarySections].filter(Boolean).join("\n")}`,
    OVERVIEW_MAX_BYTES,
  );
}

async function readOverviewSummary(
  module: ReturnType<MemoryModuleRegistry["list"]>[number],
  scope: MemoryRecallScope,
  context: ExpertAgentContextItemListInput["context"],
  budget: number,
): Promise<string> {
  const layers = module.descriptor.contextLayers;
  const result = await module.createContextProvider(scope).readContext({
    id: layers.summaryPath,
    offset: Math.min(layers.summaryMaxBytes, budget),
    context,
  });
  if (!result.ok) return "";
  const content = result.value.contentRange.truncated
    ? completeLines(result.value.content)
    : result.value.content;
  return `${content.trimEnd()}\n`;
}

function completeLines(value: string): string {
  const end = value.lastIndexOf("\n");
  return end < 0 ? `${value.trimEnd()}…\n` : value.slice(0, end + 1);
}

function resolveRoute(registry: MemoryModuleRegistry, id: string) {
  const separator = id.indexOf("/");
  if (separator <= 0 || separator === id.length - 1) return undefined;
  const prefix = id.slice(0, separator);
  const module = registry.resolvePrefix(prefix);
  return module === undefined || module.descriptor.purpose !== "projection"
    ? undefined
    : { module, localId: id.slice(separator + 1) };
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

function projectionModules(registry: MemoryModuleRegistry) {
  return registry.list().filter((module) => module.descriptor.purpose === "projection");
}

function trimUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buffer[end] ?? 0) >= 0x80 && (buffer[end] ?? 0) < 0xc0) end -= 1;
  return `${buffer.subarray(0, end).toString("utf8").trimEnd()}\n`;
}
