import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ContextSystem,
  InMemoryContextStore,
  createContextTools,
  EXECUTION_CURRENT_EXPERT_ID_ATTR,
  EXECUTION_ID_ATTR,
  INVOCATION_ID_ATTR,
  type ExpertAgentContextItemOperations,
} from "../src/index.ts";

describe("Expert context tools", () => {
  it("preserves omitted metadata fields during replace edits", async () => {
    const system = new ContextSystem();
    expect(
      system.register({
        namespace: "knowledge",
        store: new InMemoryContextStore({
          context: [
            {
              id: "items/example.md",
              content: "before",
              metadata: {
                description: "Existing description",
                trigger: "model_decision",
                priority: "high",
              },
            },
          ],
        }),
      }).ok,
    ).toBe(true);
    const tools = createContextTools({
      listContext: (input) => system.index(input),
      readContext: (input) => system.read(input),
      searchContext: (input) => system.search(input),
      addContext: (input) => system.add(input),
      editContext: (input) => system.edit(input),
      deleteContext: (input) => system.delete(input),
    });

    await tools
      .find((tool) => tool.name === "edit_expert_context")!
      .call(
        {
          namespace: "knowledge",
          id: "items/example.md",
          mode: "replace",
          content: "after",
        },
        undefined,
      );
    const result = await system.read({ namespace: "knowledge", id: "items/example.md" });

    expect(result).toMatchObject({
      ok: true,
      value: {
        content: "after",
        metadata: {
          description: "Existing description",
          trigger: "model_decision",
          priority: "high",
        },
      },
    });
  });

  it("includes aggregated user notes in askUserQuestion output", async () => {
    const unsupported = vi.fn(async () => {
      throw new Error("not used");
    });
    const operations: ExpertAgentContextItemOperations = {
      listContext: unsupported,
      readContext: unsupported,
      searchContext: unsupported,
      addContext: unsupported,
      editContext: unsupported,
      deleteContext: unsupported,
    };
    const tool = createContextTools(operations).find(
      (candidate) => candidate.name === "askUserQuestion",
    )!;

    const result = await tool.call(
      {
        questions: [
          {
            question: "Which direction should we take?",
            header: "Direction",
            kind: "single_choice",
            options: [{ label: "Option one", description: "The first route." }],
          },
        ],
      },
      undefined,
      {
        humanInteraction: async () => ({
          kind: "user_question",
          answered: true,
          answers: { "Which direction should we take?": "Option one" },
          notes: "Which direction should we take?\nPrioritize the first route.",
        }),
      },
    );

    expect(result.text).toBe(
      '{\n  "Which direction should we take?": "Option one"\n}\n\nUser notes:\nWhich direction should we take?\nPrioritize the first route.',
    );
  });

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
      committed: true,
      status: "created",
      namespace: "mission-board",
      id: "handoffs/example.md",
      revision: "store-revision-with-metadata",
      etag: "store-etag",
      sizeBytes: Buffer.byteLength(persistedContent, "utf8"),
      sha256: createHash("sha256").update(persistedContent, "utf8").digest("hex"),
    });
    expect(receipt).not.toHaveProperty("content");
    expect(JSON.parse(result.text)).toEqual(receipt);
    expect(result.text).not.toContain(sentinel);
    expect(JSON.stringify(result.details)).not.toContain(sentinel);
    expect(JSON.stringify(result.details)).not.toContain("持久化后附加的内容。");
  });

  it("rejects blank required identifiers while preserving empty content semantics", async () => {
    const addContext: ExpertAgentContextItemOperations["addContext"] = vi.fn(async (input) => ({
      ok: true as const,
      value: {
        namespace: input.namespace,
        id: input.id,
        metadata: { trigger: "manual" as const, priority: "normal" as const },
        content: input.content,
      },
    }));
    const unsupported = vi.fn(async () => {
      throw new Error("not used");
    });
    const tool = createContextTools({
      listContext: unsupported,
      readContext: unsupported,
      searchContext: unsupported,
      addContext,
      editContext: unsupported,
      deleteContext: unsupported,
    }).find((candidate) => candidate.name === "add_expert_context")!;

    await expect(
      tool.call({ namespace: "mission-board", id: "   ", content: "value" }, undefined),
    ).rejects.toThrow('Context tool parameter "id" must be a non-empty string.');
    await expect(
      tool.call({ namespace: "\t", id: "notes.md", content: "value" }, undefined),
    ).rejects.toThrow('Context tool parameter "namespace" must be a non-empty string.');
    expect(addContext).not.toHaveBeenCalled();

    await expect(
      tool.call({ namespace: "mission-board", id: "notes.md", content: "" }, undefined),
    ).resolves.toMatchObject({
      details: { context: { committed: true, id: "notes.md", sizeBytes: 0 } },
    });
    expect(addContext).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "mission-board", id: "notes.md", content: "" }),
    );
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

  it("maps append and prepend edits with an explicit separator", async () => {
    const editContext: ExpertAgentContextItemOperations["editContext"] = vi.fn(async (input) => {
      if (input.mode !== "append" && input.mode !== "prepend") {
        throw new Error("unexpected edit mode");
      }
      return {
        ok: true as const,
        value: {
          namespace: "mission-board",
          id: "notes.md",
          metadata: { trigger: "manual" as const, priority: "normal" as const },
          content: input.mode === "prepend" ? "head\nbody" : "body\n\n-tail",
          revision: `revision-${input.mode}`,
          etag: `etag-${input.mode}`,
          sizeBytes: 9,
          mode: input.mode,
        },
      };
    });
    const unsupported = vi.fn(async () => {
      throw new Error("not used");
    });
    const operations: ExpertAgentContextItemOperations = {
      listContext: unsupported,
      readContext: unsupported,
      searchContext: unsupported,
      addContext: unsupported,
      editContext,
      deleteContext: unsupported,
    };
    const tool = createContextTools(operations).find(
      (candidate) => candidate.name === "edit_expert_context",
    )!;

    await tool.call(
      {
        namespace: "mission-board",
        id: "notes.md",
        mode: "prepend",
        content: "head-",
        separator: "newline",
        expectedRevision: "revision-before-head",
      },
      undefined,
    );
    const result = await tool.call(
      {
        namespace: "mission-board",
        id: "notes.md",
        mode: "append",
        content: "-tail",
        separator: "blank_line",
        expectedEtag: "etag-before-tail",
      },
      undefined,
    );

    expect(editContext).toHaveBeenNthCalledWith(1, {
      namespace: "mission-board",
      id: "notes.md",
      mode: "prepend",
      content: "head-",
      separator: "newline",
      expectedRevision: "revision-before-head",
      expectedEtag: undefined,
      context: expect.any(Object),
    });
    expect(editContext).toHaveBeenNthCalledWith(2, {
      namespace: "mission-board",
      id: "notes.md",
      mode: "append",
      content: "-tail",
      separator: "blank_line",
      expectedRevision: undefined,
      expectedEtag: "etag-before-tail",
      context: expect.any(Object),
    });
    expect(result).toMatchObject({ details: { mode: "append" } });
    expect(JSON.parse(result.text)).toMatchObject({
      committed: true,
      status: "updated",
      namespace: "mission-board",
      id: "notes.md",
      revision: "revision-append",
      etag: "etag-append",
      mode: "append",
    });
    await expect(
      tool.call(
        {
          namespace: "mission-board",
          id: "notes.md",
          mode: "append",
          content: "missing separator",
        },
        undefined,
      ),
    ).rejects.toThrow('Context tool parameter "separator"');
  });

  it("normalizes blank optional filters, modes, and concurrency tokens", async () => {
    const listContext = vi.fn(async () => ({
      ok: true as const,
      value: { items: [], issues: [], stores: [] },
    }));
    const searchContext = vi.fn(async () => ({ ok: true as const, value: [] }));
    const editContext = vi.fn(async () => ({
      ok: true as const,
      value: {
        namespace: "mission-board",
        id: "notes.md",
        metadata: { trigger: "manual" as const, priority: "normal" as const },
        content: "updated",
        revision: "revision-current",
        etag: "etag-current",
        mode: "search_replace" as const,
        replacementCount: 1,
      },
    }));
    const unsupported = vi.fn(async () => {
      throw new Error("not used");
    });
    const tools = createContextTools({
      listContext,
      readContext: unsupported,
      searchContext,
      addContext: unsupported,
      editContext,
      deleteContext: unsupported,
    });

    await tools
      .find((tool) => tool.name === "list_expert_context")!
      .call({ namespace: " ", cursor: "\t" }, undefined);
    await tools
      .find((tool) => tool.name === "search_expert_context")!
      .call({ namespace: " ", scope: "", query: "needle" }, undefined);
    await tools
      .find((tool) => tool.name === "edit_expert_context")!
      .call(
        {
          namespace: "mission-board",
          id: "notes.md",
          mode: " ",
          search: "old",
          replace: "new",
          expectedRevision: "",
          expectedEtag: "  ",
        },
        undefined,
      );

    expect(listContext).toHaveBeenCalledWith({ context: expect.any(Object) });
    expect(searchContext).toHaveBeenCalledWith({
      namespace: undefined,
      query: "needle",
      scope: undefined,
      maxResults: undefined,
      contextLines: undefined,
      caseSensitive: undefined,
      context: expect.any(Object),
    });
    expect(editContext).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "search_replace",
        expectedRevision: undefined,
        expectedEtag: undefined,
      }),
    );
  });

  it("puts conflict recovery state in Agent-visible error text", async () => {
    const unsupported = vi.fn(async () => {
      throw new Error("not used");
    });
    const tool = createContextTools({
      listContext: unsupported,
      readContext: unsupported,
      searchContext: unsupported,
      addContext: unsupported,
      editContext: vi.fn(async () => ({
        ok: false as const,
        error: {
          code: "context_conflict" as const,
          message: "Context revision conflict: notes.md",
          details: {
            expectedRevision: "revision-old",
            currentRevision: "revision-current",
            currentEtag: "etag-current",
          },
        },
      })),
      deleteContext: unsupported,
    }).find((candidate) => candidate.name === "edit_expert_context")!;

    const result = await tool.call(
      {
        namespace: "mission-board",
        id: "notes.md",
        mode: "replace",
        content: "replacement",
        expectedRevision: "revision-old",
      },
      undefined,
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text)).toEqual({
      ok: false,
      committed: false,
      error: {
        code: "context_conflict",
        message: "Context revision conflict: notes.md",
        details: {
          expectedRevision: "revision-old",
          currentRevision: "revision-current",
          currentEtag: "etag-current",
        },
      },
      recovery: {
        action: "retry_with_current_version",
        currentRevision: "revision-current",
        currentEtag: "etag-current",
      },
    });
    expect(result.details).toEqual(JSON.parse(result.text));
  });

  it("returns explicit update and delete persistence receipts without content", async () => {
    const unsupported = vi.fn(async () => {
      throw new Error("not used");
    });
    const tools = createContextTools({
      listContext: unsupported,
      readContext: unsupported,
      searchContext: unsupported,
      addContext: unsupported,
      editContext: vi.fn(async () => ({
        ok: true as const,
        value: {
          namespace: "mission-board",
          id: "notes.md",
          metadata: { trigger: "manual" as const, priority: "normal" as const },
          content: "persisted content",
          revision: "revision-updated",
          etag: "etag-updated",
          mode: "replace" as const,
        },
      })),
      deleteContext: vi.fn(async () => ({
        ok: true as const,
        value: {
          namespace: "mission-board",
          id: "notes.md",
          effect: "local_change_removed" as const,
          message: "The local draft change was removed.",
        },
      })),
    });
    const edited = await tools
      .find((tool) => tool.name === "edit_expert_context")!
      .call(
        { namespace: "mission-board", id: "notes.md", mode: "replace", content: "replacement" },
        undefined,
      );
    const deleted = await tools
      .find((tool) => tool.name === "delete_expert_context")!
      .call({ namespace: "mission-board", id: "notes.md" }, undefined);

    expect(JSON.parse(edited.text)).toMatchObject({
      committed: true,
      status: "updated",
      revision: "revision-updated",
      etag: "etag-updated",
    });
    expect(edited.text).not.toContain("persisted content");
    expect(JSON.parse(deleted.text)).toEqual({
      committed: true,
      status: "deleted",
      namespace: "mission-board",
      id: "notes.md",
      effect: "local_change_removed",
      message: "The local draft change was removed.",
    });
  });

  it("overlays the active submission identity onto a reused Runtime context", async () => {
    const listContext = vi.fn(async () => ({
      ok: true as const,
      value: { items: [], issues: [], stores: [] },
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
          stores: [],
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

    await expect(tool.call({ cursor: "" }, undefined)).resolves.not.toMatchObject({
      isError: true,
    });
    await expect(tool.call({ cursor: "   " }, undefined)).resolves.not.toMatchObject({
      isError: true,
    });

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
        stores: [],
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

  it("lists display metadata without changing Context addressing", async () => {
    const unsupported = vi.fn(async () => {
      throw new Error("not used");
    });
    const operations: ExpertAgentContextItemOperations = {
      listContext: vi.fn(async () => ({
        ok: true as const,
        value: {
          items: [
            {
              namespace: "4jtrtegfka94yzgg",
              id: "guide.md",
              metadata: { trigger: "manual" as const, priority: "normal" as const },
              revision: "1723640000000000000:128",
              etag: "sha256:context-etag",
            },
          ],
          stores: [
            {
              namespace: "4jtrtegfka94yzgg",
              storeName: "Memory · 00pragma",
              itemCount: 16,
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
    const tool = createContextTools(operations).find(
      (candidate) => candidate.name === "list_expert_context",
    )!;

    const result = await tool.call({}, undefined);

    expect(result.text).toContain("storeName: Memory · 00pragma");
    expect(result.text).toContain("itemCount: 16");
    expect(result.text).toContain("revision: 1723640000000000000:128");
    expect(result.text).toContain("etag: sha256:context-etag");
    expect(result.details).toMatchObject({
      context: [
        {
          id: "guide.md",
          revision: "1723640000000000000:128",
          etag: "sha256:context-etag",
        },
      ],
      stores: [{ namespace: "4jtrtegfka94yzgg", storeName: "Memory · 00pragma", itemCount: 16 }],
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
          stores: [],
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
    expect(readResult.text).toContain(
      '"tool":"read_expert_context","arguments":{"namespace":"memory","id":"semantic/items/fact.md","start":126,"offset":128}',
    );
    expect(readResult.details).toMatchObject({
      continuation: {
        tool: "read_expert_context",
        arguments: {
          namespace: "memory",
          id: "semantic/items/fact.md",
          start: 126,
          offset: 128,
        },
      },
    });
  });
});
