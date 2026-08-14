import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createContextTools,
  EXECUTION_CURRENT_EXPERT_ID_ATTR,
  EXECUTION_ID_ATTR,
  INVOCATION_ID_ATTR,
  type ExpertAgentContextItemOperations,
} from "../src/index.ts";

describe("Expert context tools", () => {
  it("returns an add receipt without echoing persisted context content", async () => {
    const sentinel = "这是用于验证写入回执不回显正文的长中文标记。".repeat(32);
    const addContext = vi.fn(async (input: { readonly content: string }) => ({
      ok: true as const,
      value: {
        namespace: "mission-board",
        id: "handoffs/example.md",
        metadata: { trigger: "manual" as const, priority: "high" as const },
        content: `${input.content}\n持久化后附加的内容。`,
        revision: "store-revision-with-metadata",
        etag: "store-etag",
        sizeBytes: 1,
      },
    }));
    const unsupported = vi.fn(async () => {
      throw new Error("not used");
    });
    const operations: ExpertAgentContextItemOperations = {
      listContext: unsupported,
      readContext: unsupported,
      searchContext: unsupported,
      addContext,
      editContext: unsupported,
      deleteContext: unsupported,
    };
    const tool = createContextTools(operations).find(
      (candidate) => candidate.name === "add_expert_context",
    )!;
    const input = {
      namespace: "mission-board",
      id: "handoffs/example.md",
      content: sentinel,
      description: "写入回执测试",
      trigger: "manual",
      priority: "high",
    };

    const result = await tool.call(input, undefined);
    const persistedContent = `${sentinel}\n持久化后附加的内容。`;
    const receipt = (
      result.details as {
        readonly context: {
          readonly status: string;
          readonly namespace: string;
          readonly id: string;
          readonly revision?: string | undefined;
          readonly etag?: string | undefined;
          readonly sizeBytes: number;
          readonly sha256: string;
          readonly content?: unknown;
        };
      }
    ).context;

    expect(addContext).toHaveBeenCalledWith({
      namespace: input.namespace,
      id: input.id,
      content: sentinel,
      metadata: {
        description: input.description,
        trigger: input.trigger,
        priority: input.priority,
      },
      context: expect.any(Object),
    });
    expect(receipt).toEqual({
      status: "created",
      namespace: "mission-board",
      id: "handoffs/example.md",
      revision: "store-revision-with-metadata",
      etag: "store-etag",
      sizeBytes: Buffer.byteLength(persistedContent, "utf8"),
      sha256: createHash("sha256").update(persistedContent, "utf8").digest("hex"),
    });
    expect(receipt).not.toHaveProperty("content");
    expect(result.text).toBe(
      `Added context: mission-board/handoffs/example.md; sizeBytes=${Buffer.byteLength(persistedContent, "utf8")}`,
    );
    expect(result.text).not.toContain(sentinel);
    expect(JSON.stringify(result.details)).not.toContain(sentinel);
    expect(JSON.stringify(result.details)).not.toContain("持久化后附加的内容。");
  });

  it("does not compute a receipt on add failure", async () => {
    const addContext = vi.fn(async () => ({
      ok: false as const,
      error: { code: "store_error" as const, message: "Store unavailable" },
    }));
    const unsupported = vi.fn(async () => {
      throw new Error("not used");
    });
    const operations: ExpertAgentContextItemOperations = {
      listContext: unsupported,
      readContext: unsupported,
      searchContext: unsupported,
      addContext,
      editContext: unsupported,
      deleteContext: unsupported,
    };
    const tool = createContextTools(operations).find(
      (candidate) => candidate.name === "add_expert_context",
    )!;

    const result = await tool.call(
      { namespace: "mission-board", id: "handoffs/example.md", content: "正文不应进入失败回执" },
      undefined,
    );

    expect(result).toMatchObject({
      isError: true,
      details: { error: { code: "store_error", message: "Store unavailable" } },
    });
    expect(result.details).not.toHaveProperty("context");
  });

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
      context: {
        source: { type: "expert-session", id: "session-1" },
        attributes: {
          [EXECUTION_ID_ATTR]: "execution-current",
          [INVOCATION_ID_ATTR]: "invocation-current",
          [EXECUTION_CURRENT_EXPERT_ID_ATTR]: "expert-a",
        },
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

  it("lists a requested namespace and prevents cursors from crossing namespace filters", async () => {
    const unsupported = vi.fn(async () => {
      throw new Error("not used");
    });
    const listContext = vi.fn(async (input?: { readonly namespace?: string | undefined }) => ({
      ok: true as const,
      value: {
        items:
          input?.namespace === "memory"
            ? ["a.md", "b.md", "c.md"].map((id) => ({
                id,
                namespace: "memory",
                metadata: { trigger: "manual" as const, priority: "normal" as const },
              }))
            : [],
        issues: [],
      },
    }));
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
    )!;

    const first = await tool.call({ namespace: "memory", limit: 2 }, undefined);
    const details = first.details as { readonly page: { readonly nextCursor: string } };
    expect(listContext).toHaveBeenCalledWith({ namespace: "memory", context: expect.any(Object) });
    expect(first.text).toContain("Showing 2 of 3");

    await expect(
      tool.call({ cursor: details.page.nextCursor, limit: 2 }, undefined),
    ).resolves.toMatchObject({
      isError: true,
      details: { error: { code: "invalid_input", message: expect.stringContaining("namespace") } },
    });
    await expect(
      tool.call(
        { namespace: "mission-board", cursor: details.page.nextCursor, limit: 2 },
        undefined,
      ),
    ).resolves.toMatchObject({
      isError: true,
      details: { error: { code: "invalid_input", message: expect.stringContaining("namespace") } },
    });
    await expect(
      tool.call({ namespace: "memory", cursor: details.page.nextCursor, limit: 2 }, undefined),
    ).resolves.toMatchObject({ text: expect.stringContaining("Showing 1 of 3") });
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

    const second = await tool.call({ cursor: firstDetails.page.nextCursor, limit: 1 }, undefined);
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
