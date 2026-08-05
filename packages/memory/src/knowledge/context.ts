import {
  StaticContextStore,
  type ExpertAgentContextItemSeed,
  type ExpertAgentContextStore,
} from "@pragma/core";
import type { Knowledge } from "@pragma/shared";

import type { KnowledgeMemoryStore } from "./store.ts";
import type { MemoryRecallScope } from "../pipeline/memory-module.ts";

export function createKnowledgeMemoryContextProvider(
  store: KnowledgeMemoryStore,
  scope: MemoryRecallScope,
): ExpertAgentContextStore {
  const rootStore = async (): Promise<StaticContextStore> => {
    const items = await store.listForRecall(scope);
    return new StaticContextStore([
      {
        id: "summary.md",
        content: renderSummary(items),
        metadata: metadata(
          "Published reusable Knowledge available to the current asset and principals.",
          "model_decision",
          "high",
        ),
      },
      {
        id: "index.md",
        content: renderIndex(items),
        metadata: metadata(
          "Searchable published Knowledge index. Candidates never appear here.",
          "model_decision",
          "normal",
        ),
      },
    ]);
  };

  return {
    listContext: async (input) => await (await rootStore()).listContext(input),
    async readContext(input) {
      if (input.id === "summary.md" || input.id === "index.md") {
        return await (await rootStore()).readContext(input);
      }
      const ref = readItemPath(input.id);
      if (ref === undefined) return await new StaticContextStore().readContext(input);
      const item = await store.getForRecall(scope, ref.id, ref.revision);
      return await new StaticContextStore(item === undefined ? [] : [itemSeed(item)]).readContext(
        input,
      );
    },
    async searchContext(input) {
      const root = await rootStore();
      const rootResult = await root.searchContext(input);
      if (!rootResult.ok) return rootResult;
      const remaining = Math.max(0, (input.maxResults ?? 20) - rootResult.value.length);
      if (remaining === 0) return rootResult;
      const items = await store.searchForRecall(scope, input.query, remaining);
      const detailResult = await new StaticContextStore(items.map(itemSeed)).searchContext({
        ...input,
        maxResults: remaining,
      });
      return detailResult.ok
        ? { ...detailResult, value: [...rootResult.value, ...detailResult.value] }
        : detailResult;
    },
    addContext: async (input) => await new StaticContextStore().addContext(input),
    editContext: async (input) => await new StaticContextStore().editContext(input),
    deleteContext: async (input) => await new StaticContextStore().deleteContext(input),
  };
}

function itemSeed(item: Knowledge): ExpertAgentContextItemSeed {
  return {
    id: `items/${item.id}/${item.revision}.md`,
    revision: String(item.revision),
    content: [
      `# ${item.content.title}`,
      "",
      `- Knowledge: ${item.id}`,
      `- Revision: ${item.revision}`,
      `- Key: ${item.content.normalizedKey}`,
      `- Root: ${item.rootRef.type}:${item.rootRef.id}`,
      `- Origin: ${item.origin.kind}`,
      "",
      "## Summary",
      item.content.summary,
      "",
      "## Guidance",
      ...item.content.guidance.map((entry) => `- ${entry}`),
      "",
      "## Provenance",
      ...item.sourceRefs.map(
        (source) => `- ${source.kind}:${source.id} revision ${source.revision}`,
      ),
      ...(item.sourceRefs.length === 0
        ? ["- Imported Knowledge carries summarized provenance in its Bundle origin."]
        : []),
      "",
    ].join("\n"),
    metadata: metadata(
      `Published Knowledge: ${oneLine(item.content.summary, 180)}`,
      "manual",
      "high",
      item.sensitivity,
    ),
  };
}

function renderSummary(items: readonly Knowledge[]): string {
  return [
    "# Knowledge Memory Summary",
    "",
    "Knowledge contains reviewed, published, reusable guidance. It is not raw history or automatically accepted model output.",
    "",
    `- Active published items: ${items.length}`,
    `- Imported items: ${items.filter((item) => item.origin.kind === "bundle-import").length}`,
    "",
    ...items.slice(0, 6).map(indexLine),
    ...(items.length === 0 ? ["- No published Knowledge is available in this scope."] : []),
    "",
  ].join("\n");
}

function renderIndex(items: readonly Knowledge[]): string {
  return [
    "# Knowledge Memory Index",
    "",
    "Only active, published revisions are listed. Read an exact revision before applying its guidance.",
    "",
    ...(items.length === 0
      ? ["- No published Knowledge is available in this scope."]
      : items.map(indexLine)),
    "",
  ].join("\n");
}

function indexLine(item: Knowledge): string {
  return `- items/${item.id}/${item.revision}.md | ${item.content.normalizedKey} | ${oneLine(item.content.summary, 240)}`;
}

function readItemPath(
  path: string,
): { readonly id: string; readonly revision: number } | undefined {
  const match = /^items\/([^/]+)\/([1-9][0-9]*)\.md$/.exec(path);
  return match === null ? undefined : { id: match[1]!, revision: Number(match[2]) };
}

function metadata(
  description: string,
  trigger: "always_on" | "model_decision" | "manual",
  priority: "critical" | "high" | "normal" | "low",
  sensitivity: "public" | "internal" | "confidential" | "restricted" = "internal",
) {
  return { description, trigger, priority, trustLevel: "system" as const, sensitivity };
}

function oneLine(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}
