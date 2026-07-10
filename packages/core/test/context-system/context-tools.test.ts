import { describe, expect, it, vi } from "vitest";

import { createContextTools } from "../../src/context-system/context-tools.ts";
import type { ExpertAgentContextItemOperations } from "../../src/context-system/context-tools.ts";

describe("createContextTools", () => {
  it("requires explicit approval for every context write tool", () => {
    const tools = createContextTools({
      listContext: notCalledListOperation,
      readContext: notCalledOperation,
      searchContext: notCalledOperation,
      addContext: notCalledOperation,
      editContext: notCalledOperation,
      deleteContext: notCalledOperation,
    });

    for (const name of ["add_expert_context", "edit_expert_context", "delete_expert_context"]) {
      expect(tools.find((tool) => tool.name === name)?.approval).toMatchObject({
        mode: "required",
      });
    }
  });

  it("returns an error for malformed askUserQuestion input", async () => {
    const askTool = createContextTools({
      listContext: notCalledListOperation,
      readContext: notCalledOperation,
      searchContext: notCalledOperation,
      addContext: notCalledOperation,
      editContext: notCalledOperation,
      deleteContext: notCalledOperation,
    }).find((tool) => tool.name === "askUserQuestion");

    const result = await askTool?.call({ questions: [] }, undefined);

    expect(result).toEqual({
      text: "Invalid askUserQuestion input: questions array is empty or missing.",
      isError: true,
    });
  });

  it("normalizes askUserQuestion modes before passing questions to approval", async () => {
    const askTool = createContextTools({
      listContext: notCalledListOperation,
      readContext: notCalledOperation,
      searchContext: notCalledOperation,
      addContext: notCalledOperation,
      editContext: notCalledOperation,
      deleteContext: notCalledOperation,
    }).find((tool) => tool.name === "askUserQuestion");
    const humanInteraction = vi.fn(async () => ({
      kind: "user_question" as const,
      answered: true,
      answers: {
        answers: [
          { header: "Continue", kind: "single_choice", selected: "Yes" },
          { header: "Scope", kind: "multiple_choice", selected: ["Docs", "Tests"] },
          { header: "Notes", kind: "text", answer: "Ship it." },
        ],
      },
    }));

    const result = await askTool?.call(
      {
        questions: [
          {
            header: "Continue",
            question: "Should I continue?",
            options: [{ label: "Yes" }, { label: "No" }],
          },
          {
            header: "Scope",
            question: "Which areas should I update?",
            kind: "multiple_choice",
            options: [{ label: "Docs" }, { label: "Tests" }],
          },
          {
            header: "Notes",
            question: "Any extra notes?",
            kind: "text",
          },
        ],
      },
      undefined,
      { humanInteraction },
    );

    expect(humanInteraction).toHaveBeenCalledWith({
      kind: "user_question",
      toolName: "askUserQuestion",
      toolCallId: undefined,
      questions: [
        {
          header: "Continue",
          question: "Should I continue?",
          kind: "single_choice",
          options: [
            { label: "Yes", description: "" },
            { label: "No", description: "" },
          ],
        },
        {
          header: "Scope",
          question: "Which areas should I update?",
          kind: "multiple_choice",
          options: [
            { label: "Docs", description: "" },
            { label: "Tests", description: "" },
          ],
        },
        {
          header: "Notes",
          question: "Any extra notes?",
          kind: "text",
          options: [],
        },
      ],
    });
    expect(result).toEqual({
      text: JSON.stringify(
        {
          answers: [
            { header: "Continue", kind: "single_choice", selected: "Yes" },
            { header: "Scope", kind: "multiple_choice", selected: ["Docs", "Tests"] },
            { header: "Notes", kind: "text", answer: "Ship it." },
          ],
        },
        null,
        2,
      ),
      details: {
        answers: [
          { header: "Continue", kind: "single_choice", selected: "Yes" },
          { header: "Scope", kind: "multiple_choice", selected: ["Docs", "Tests"] },
          { header: "Notes", kind: "text", answer: "Ship it." },
        ],
      },
    });
  });

  it("filters choice questions without options", async () => {
    const askTool = createContextTools({
      listContext: notCalledListOperation,
      readContext: notCalledOperation,
      searchContext: notCalledOperation,
      addContext: notCalledOperation,
      editContext: notCalledOperation,
      deleteContext: notCalledOperation,
    }).find((tool) => tool.name === "askUserQuestion");

    const result = await askTool?.call(
      {
        questions: [
          {
            header: "Broken",
            question: "Pick one?",
            kind: "single_choice",
          },
        ],
      },
      undefined,
    );

    expect(result).toEqual({
      text: "Invalid askUserQuestion input: questions array is empty or missing.",
      isError: true,
    });
  });

  it("passes run context from the session instead of tool input", async () => {
    const sessionContext = {
      source: {
        type: "session",
        id: "session-1",
      },
      attributes: {
        tenantId: "tenant-1",
      },
    };
    const listContext = vi.fn(async () => ({
      ok: true as const,
      value: { items: [], issues: [] },
    }));
    const tools = createContextTools(
      {
        listContext,
        readContext: notCalledOperation,
        searchContext: notCalledOperation,
        addContext: notCalledOperation,
        editContext: notCalledOperation,
        deleteContext: notCalledOperation,
      },
      {
        getContext: () => sessionContext,
      },
    );
    const listTool = tools.find((tool) => tool.name === "list_expert_context");

    expect((listTool?.inputSchema as { properties: Record<string, unknown> }).properties).toEqual(
      {},
    );

    await listTool?.call(
      {
        source: {
          type: "tool-input",
          id: "ignored",
        },
        context: {
          tenantId: "ignored",
        },
      },
      undefined,
    );

    expect(listContext).toHaveBeenCalledWith(sessionContext);
  });

  it("creates a default run context when no session context provider is present", async () => {
    const listContext = vi.fn(async () => ({
      ok: true as const,
      value: { items: [], issues: [] },
    }));
    const listTool = createContextTools({
      listContext,
      readContext: notCalledOperation,
      searchContext: notCalledOperation,
      addContext: notCalledOperation,
      editContext: notCalledOperation,
      deleteContext: notCalledOperation,
    }).find((tool) => tool.name === "list_expert_context");

    await listTool?.call({}, undefined);

    expect(listContext).toHaveBeenCalledWith({
      source: {
        type: "system",
      },
      attributes: {},
    });
  });

  it("formats search matches grouped by context id with line text", async () => {
    const matches = [
      {
        namespace: "workspace",
        id: "guide.md",
        lineNumber: 10,
        line: "First needle match.",
        before: ["Before first."],
        after: ["After first."],
      },
      {
        namespace: "workspace",
        id: "guide.md",
        lineNumber: 25,
        line: "Second needle match.",
      },
      {
        namespace: "host",
        id: "AGENTS.md",
        lineNumber: 2,
        line: "Needle in instructions.",
      },
    ];
    const searchContext = vi.fn(async () => ({
      ok: true as const,
      value: matches,
    }));
    const searchTool = createContextTools({
      listContext: notCalledListOperation,
      readContext: notCalledOperation,
      searchContext,
      addContext: notCalledOperation,
      editContext: notCalledOperation,
      deleteContext: notCalledOperation,
    }).find((tool) => tool.name === "search_expert_context");

    const result = await searchTool?.call(
      {
        query: "needle",
      },
      undefined,
    );

    expect(result?.text).toBe(
      [
        "Found 3 matches in 2 context items.",
        "",
        "workspace/guide.md",
        " 9 | Before first.",
        ">10 | First needle match.",
        " 11 | After first.",
        "--",
        ">25 | Second needle match.",
        "",
        "---",
        "",
        "host/AGENTS.md",
        ">2 | Needle in instructions.",
      ].join("\n"),
    );
    expect(result?.details).toEqual({
      matches,
    });
  });

  it("calls edit_expert_context with search/replace arguments", async () => {
    const editContext = vi.fn(async () => ({
      ok: true as const,
      value: {
        namespace: "host",
        id: "guide.md",
        content: "updated",
        metadata: {
          trigger: "manual" as const,
          priority: "normal" as const,
        },
        mode: "search_replace" as const,
        replacementCount: 2,
      },
    }));
    const editTool = createContextTools({
      listContext: notCalledListOperation,
      readContext: notCalledOperation,
      searchContext: notCalledOperation,
      addContext: notCalledOperation,
      editContext,
      deleteContext: notCalledOperation,
    }).find((tool) => tool.name === "edit_expert_context");

    const result = await editTool?.call(
      {
        namespace: "host",
        id: "guide.md",
        mode: "search_replace",
        search: "old",
        replace: "new",
        replaceAll: true,
      },
      undefined,
    );

    expect(editContext).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "host",
        id: "guide.md",
        search: "old",
        replace: "new",
        replaceAll: true,
        context: expect.objectContaining({
          source: {
            type: "system",
          },
        }),
      }),
    );
    expect(result).toMatchObject({
      text: "Edited context: host/guide.md; mode=search_replace; replacements=2",
      details: {
        mode: "search_replace",
        replacementCount: 2,
      },
    });
  });

  it("calls edit_expert_context with replace mode arguments", async () => {
    const editContext = vi.fn(async () => ({
      ok: true as const,
      value: {
        namespace: "host",
        id: "guide.md",
        content: "updated",
        metadata: {
          description: "Guide",
          trigger: "always_on" as const,
          priority: "normal" as const,
        },
        mode: "replace" as const,
      },
    }));
    const editTool = createContextTools({
      listContext: notCalledListOperation,
      readContext: notCalledOperation,
      searchContext: notCalledOperation,
      addContext: notCalledOperation,
      editContext,
      deleteContext: notCalledOperation,
    }).find((tool) => tool.name === "edit_expert_context");

    const result = await editTool?.call(
      {
        namespace: "host",
        id: "guide.md",
        mode: "replace",
        content: "updated",
        description: "Guide",
        trigger: "always_on",
        expectedRevision: "rev-1",
      },
      undefined,
    );

    expect(editContext).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "host",
        id: "guide.md",
        mode: "replace",
        content: "updated",
        metadata: {
          description: "Guide",
          trigger: "always_on",
        },
        expectedRevision: "rev-1",
      }),
    );
    expect(result).toMatchObject({
      text: "Edited context: host/guide.md; mode=replace",
      details: {
        mode: "replace",
      },
    });
  });

  it("formats path search matches without line numbers", async () => {
    const searchContext = vi.fn(async () => ({
      ok: true as const,
      value: [
        {
          namespace: "host",
          id: "guides/guide.md",
          matchType: "path" as const,
          line: "guides/guide.md",
        },
      ],
    }));
    const searchTool = createContextTools({
      listContext: notCalledListOperation,
      readContext: notCalledOperation,
      searchContext,
      addContext: notCalledOperation,
      editContext: notCalledOperation,
      deleteContext: notCalledOperation,
    }).find((tool) => tool.name === "search_expert_context");

    const result = await searchTool?.call(
      {
        query: "guides/*.md",
        scope: "path",
      },
      undefined,
    );

    expect(result?.text).toBe(
      [
        "Found 1 match in 1 context item.",
        "",
        "host/guides/guide.md",
        "> path | guides/guide.md",
      ].join("\n"),
    );
  });
});

const notCalledListOperation = vi.fn(async () => {
  throw new Error("Unexpected context operation call.");
}) as unknown as ExpertAgentContextItemOperations["listContext"];

const notCalledOperation = vi.fn(async () => {
  throw new Error("Unexpected context operation call.");
}) as unknown as ExpertAgentContextItemOperations["readContext"] &
  ExpertAgentContextItemOperations["searchContext"] &
  ExpertAgentContextItemOperations["addContext"] &
  ExpertAgentContextItemOperations["editContext"] &
  ExpertAgentContextItemOperations["deleteContext"];
