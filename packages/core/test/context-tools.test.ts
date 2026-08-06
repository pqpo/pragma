import { describe, expect, it, vi } from "vitest";

import {
  createContextTools,
  EXECUTION_CURRENT_EXPERT_ID_ATTR,
  EXECUTION_ID_ATTR,
  INVOCATION_ID_ATTR,
  type ExpertAgentContextItemOperations,
} from "../src/index.ts";

describe("Expert context tools", () => {
  it("overlays the active submission identity onto a reused Runtime context", async () => {
    const listContext = vi.fn(async () => ({
      ok: true as const,
      value: { items: [], issues: [] },
    }));
    const unsupported = vi.fn(async () => {
      throw new Error("not used");
    });
    const operations: ExpertAgentContextItemOperations = {
      listContext,
      readContext: unsupported,
      searchContext: unsupported,
      addContext: unsupported,
      editContext: unsupported,
      deleteContext: unsupported,
    };
    const tool = createContextTools(operations).find(
      (candidate) => candidate.name === "list_expert_context",
    );

    await tool!.call({}, undefined, {
      runContext: {
        source: { type: "expert-session", id: "session-1" },
        attributes: {
          [EXECUTION_ID_ATTR]: "execution-first",
          [INVOCATION_ID_ATTR]: "invocation-first",
          [EXECUTION_CURRENT_EXPERT_ID_ATTR]: "expert-a",
        },
      },
      execution: {
        executionId: "execution-current",
        invocationId: "invocation-current",
        depth: 0,
      },
    });

    expect(listContext).toHaveBeenCalledWith({
      source: { type: "expert-session", id: "session-1" },
      attributes: {
        [EXECUTION_ID_ATTR]: "execution-current",
        [INVOCATION_ID_ATTR]: "invocation-current",
        [EXECUTION_CURRENT_EXPERT_ID_ATTR]: "expert-a",
      },
    });
  });

  it("paginates context listings with a reusable opaque cursor", async () => {
    const unsupported = vi.fn(async () => {
      throw new Error("not used");
    });
    const operations: ExpertAgentContextItemOperations = {
      listContext: vi.fn(async () => ({
        ok: true as const,
        value: {
          items: ["c.md", "a.md", "b.md"].map((id) => ({
            id,
            namespace: "memory",
            metadata: { trigger: "model_decision" as const, priority: "normal" as const },
          })),
          issues: [],
        },
      })),
      readContext: unsupported,
      searchContext: unsupported,
      addContext: unsupported,
      editContext: unsupported,
      deleteContext: unsupported,
    };
    const tool = createContextTools(operations).find(
      (candidate) => candidate.name === "list_expert_context",
    )!;

    const first = await tool.call({ limit: 2 }, undefined);
    const firstDetails = first.details as {
      readonly context: readonly { readonly id: string }[];
      readonly page: { readonly nextCursor: string };
    };
    expect(firstDetails.context.map((item) => item.id)).toEqual(["a.md", "b.md"]);
    expect(first.text).toContain("More items are available");

    const second = await tool.call({ cursor: firstDetails.page.nextCursor, limit: 2 }, undefined);
    expect(
      (second.details as { readonly context: readonly { readonly id: string }[] }).context.map(
        (item) => item.id,
      ),
    ).toEqual(["c.md"]);
    await expect(tool.call({ cursor: "not-a-cursor" }, undefined)).resolves.toMatchObject({
      isError: true,
      details: { error: { code: "invalid_input" } },
    });
  });

  it("advances pagination past context identifiers that cannot fit in the result budget", async () => {
    const unsupported = vi.fn(async () => {
      throw new Error("not used");
    });
    const operations: ExpertAgentContextItemOperations = {
      listContext: vi.fn(async () => ({
        ok: true as const,
        value: {
          items: [
            {
              id: "x".repeat(2_000),
              namespace: "memory",
              metadata: { trigger: "manual" as const, priority: "critical" as const },
            },
            {
              id: "guide.md",
              namespace: "memory",
              metadata: { trigger: "manual" as const, priority: "normal" as const },
            },
          ],
          issues: [],
        },
      })),
      readContext: unsupported,
      searchContext: unsupported,
      addContext: unsupported,
      editContext: unsupported,
      deleteContext: unsupported,
    };
    const tool = createContextTools(operations, { resultByteBudget: 1_024 }).find(
      (candidate) => candidate.name === "list_expert_context",
    )!;

    const first = await tool.call({ limit: 1 }, undefined);
    const firstDetails = first.details as {
      readonly context: readonly unknown[];
      readonly page: { readonly nextCursor: string; readonly skippedOversized: number };
    };
    expect(Buffer.byteLength(first.text, "utf8")).toBeLessThanOrEqual(1_024);
    expect(firstDetails.context).toEqual([]);
    expect(firstDetails.page.skippedOversized).toBe(1);
    expect(first.text).toContain("More items are available");

    const second = await tool.call(
      { cursor: firstDetails.page.nextCursor, limit: 1 },
      undefined,
    );
    expect(
      (second.details as { readonly context: readonly { readonly id: string }[] }).context.map(
        (item) => item.id,
      ),
    ).toEqual(["guide.md"]);
  });

  it("bounds search snippets and defensively truncates oversized reads", async () => {
    const unsupported = vi.fn(async () => {
      throw new Error("not used");
    });
    const operations: ExpertAgentContextItemOperations = {
      listContext: unsupported,
      readContext: vi.fn(async () => ({
        ok: true as const,
        value: {
          namespace: "memory",
          id: "semantic/items/fact.md",
          metadata: { trigger: "manual" as const, priority: "normal" as const },
          content: "汉".repeat(2_000),
          contentRange: {
            requestedStartOffset: 0,
            startOffset: 0,
            endOffset: 6_000,
            nextStartOffset: 6_000,
            truncated: false,
            sizeBytes: 6_000,
            startLine: 4,
            endLine: 100,
            totalLines: 100,
          },
        },
      })),
      searchContext: vi.fn(async () => ({
        ok: true as const,
        value: [
          {
            namespace: "memory",
            id: "semantic/items/fact.md",
            lineNumber: 1,
            line: "汉".repeat(4_000),
          },
        ],
      })),
      addContext: unsupported,
      editContext: unsupported,
      deleteContext: unsupported,
    };
    const tools = createContextTools(operations, { readByteBudget: 128, resultByteBudget: 1_024 });
    const search = tools.find((candidate) => candidate.name === "search_expert_context")!;
    const searchResult = await search.call({ query: "汉" }, undefined);
    expect(Buffer.byteLength(searchResult.text, "utf8")).toBeLessThanOrEqual(1_024);
    expect(searchResult.text).toContain("read_expert_context");
    expect(searchResult.details).toMatchObject({ truncated: true });

    const read = tools.find((candidate) => candidate.name === "read_expert_context")!;
    const readResult = await read.call(
      { namespace: "memory", id: "semantic/items/fact.md" },
      undefined,
    );
    const context = (
      readResult.details as {
        readonly context: {
          readonly content: string;
          readonly contentRange: { readonly startLine: number; readonly endLine: number };
        };
      }
    ).context;
    expect(Buffer.byteLength(context.content, "utf8")).toBeLessThanOrEqual(128);
    expect(context.contentRange).toMatchObject({ startLine: 4, endLine: 4 });
    expect(readResult.text).toContain("truncationNotice");
    expect(readResult.text).toContain("nextStart=126");
  });
});
