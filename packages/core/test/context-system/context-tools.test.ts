import { describe, expect, it, vi } from "vitest";

import { createContextTools } from "../../src/context-system/context-tools.ts";
import type { ExpertAgentContextItemOperations } from "../../src/context-system/context-tools.ts";
import { createInMemoryTaskMemoryStore } from "../../src/memory-system/in-memory-task-store.ts";

describe("createContextTools", () => {
  it("returns an error for malformed askUserQuestion input", async () => {
    const askTool = createContextTools({
      listContext: notCalledListOperation,
      readContext: notCalledOperation,
      searchContext: notCalledOperation,
      addContext: notCalledOperation,
      updateContext: notCalledOperation,
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
      updateContext: notCalledOperation,
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
      updateContext: notCalledOperation,
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
      value: [],
    }));
    const tools = createContextTools(
      {
        listContext,
        readContext: notCalledOperation,
        searchContext: notCalledOperation,
        addContext: notCalledOperation,
        updateContext: notCalledOperation,
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
      value: [],
    }));
    const listTool = createContextTools({
      listContext,
      readContext: notCalledOperation,
      searchContext: notCalledOperation,
      addContext: notCalledOperation,
      updateContext: notCalledOperation,
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
      updateContext: notCalledOperation,
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

  it("uses workflow run context and agent id defaults for task memory tools", async () => {
    const listTaskMemory = vi.fn(async () => ({
      ok: true as const,
      value: [],
    }));
    const tools = createContextTools(
      {
        listContext: notCalledListOperation,
        readContext: notCalledOperation,
        searchContext: notCalledOperation,
        addContext: notCalledOperation,
        updateContext: notCalledOperation,
        deleteContext: notCalledOperation,
        listTaskMemory,
        getTaskMemory: notCalledTaskMemoryOperation,
        appendTaskMemory: notCalledTaskMemoryOperation,
        patchTaskMemory: notCalledTaskMemoryOperation,
      },
      {
        agentId: "planner-agent",
        getContext: () => ({
          source: {
            type: "workflow",
          },
          attributes: {
            "taskMemory.workflowRunId": "workflow-1",
            "taskMemory.taskRunId": "task-1",
          },
        }),
      },
    );
    const listTool = tools.find((tool) => tool.name === "list_task_memory");

    await listTool?.call({}, undefined);

    expect(listTaskMemory).toHaveBeenCalledWith({
      workflowRunId: "workflow-1",
      actorAgentId: "planner-agent",
      taskRunId: undefined,
      visibility: undefined,
      status: undefined,
      context: {
        source: {
          type: "workflow",
        },
        attributes: {
          "taskMemory.workflowRunId": "workflow-1",
          "taskMemory.taskRunId": "task-1",
        },
      },
    });
  });

  it("appends private todo task memory with the current agent as owner", async () => {
    const appendTaskMemory = vi.fn(async (input) => ({
      ok: true as const,
      value: {
        ...input.record,
        id: "memory-1",
        revision: 0,
        provenance: {
          createdBy: input.actorAgentId,
          updatedBy: input.actorAgentId,
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
          evidence: [],
        },
      },
    }));
    const tools = createContextTools(
      {
        listContext: notCalledListOperation,
        readContext: notCalledOperation,
        searchContext: notCalledOperation,
        addContext: notCalledOperation,
        updateContext: notCalledOperation,
        deleteContext: notCalledOperation,
        listTaskMemory: notCalledTaskMemoryOperation,
        getTaskMemory: notCalledTaskMemoryOperation,
        appendTaskMemory,
        patchTaskMemory: notCalledTaskMemoryOperation,
      },
      {
        agentId: "specialist-agent",
        getContext: () => ({
          source: {
            type: "workflow",
          },
          attributes: {
            "taskMemory.workflowRunId": "workflow-2",
          },
        }),
      },
    );
    const appendTool = tools.find((tool) => tool.name === "append_task_memory");

    await appendTool?.call(
      {
        visibility: "private",
        kind: "todo",
        content: "My private checklist",
        items: [{ id: "todo-1", text: "Check contract", done: false }],
      },
      undefined,
    );

    expect(appendTaskMemory).toHaveBeenCalledWith({
      actorAgentId: "specialist-agent",
      record: {
        type: "task",
        scope: "session",
        workflowRunId: "workflow-2",
        taskRunId: undefined,
        runtimeSessionId: undefined,
        visibility: "private",
        ownerAgentId: "specialist-agent",
        kind: "todo",
        title: undefined,
        content: "My private checklist",
        status: "active",
        items: [{ id: "todo-1", text: "Check contract", done: false, assigneeAgentId: undefined }],
      },
      context: {
        source: {
          type: "workflow",
        },
        attributes: {
          "taskMemory.workflowRunId": "workflow-2",
        },
      },
    });
  });

  it("reads task memory by id with the current agent id", async () => {
    const getTaskMemory = vi.fn(async () => ({
      ok: true as const,
      value: {
        id: "memory-1",
        type: "task" as const,
        scope: "session" as const,
        workflowRunId: "workflow-2",
        visibility: "private" as const,
        ownerAgentId: "specialist-agent",
        kind: "note" as const,
        content: "Private note",
        status: "active" as const,
        revision: 0,
        provenance: {
          createdBy: "specialist-agent",
          updatedBy: "specialist-agent",
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
          evidence: [],
        },
      },
    }));
    const tools = createContextTools(
      {
        listContext: notCalledListOperation,
        readContext: notCalledOperation,
        searchContext: notCalledOperation,
        addContext: notCalledOperation,
        updateContext: notCalledOperation,
        deleteContext: notCalledOperation,
        listTaskMemory: notCalledTaskMemoryOperation,
        getTaskMemory,
        appendTaskMemory: notCalledTaskMemoryOperation,
        patchTaskMemory: notCalledTaskMemoryOperation,
      },
      {
        agentId: "specialist-agent",
      },
    );
    const getTool = tools.find((tool) => tool.name === "get_task_memory");

    await getTool?.call({ id: "memory-1" }, undefined);

    expect(getTaskMemory).toHaveBeenCalledWith({
      id: "memory-1",
      actorAgentId: "specialist-agent",
      context: {
        source: {
          type: "system",
        },
        attributes: {},
      },
    });
  });

  it("patches task memory with optimistic concurrency", async () => {
    const patchTaskMemory = vi.fn(async (input) => ({
      ok: true as const,
      value: {
        id: input.id,
        type: "task" as const,
        scope: "session" as const,
        workflowRunId: "workflow-2",
        visibility: "shared" as const,
        kind: "todo" as const,
        content: input.patch.content ?? "Existing content",
        status: input.patch.status ?? "active",
        items: input.patch.items,
        revision: input.expectedRevision + 1,
        provenance: {
          createdBy: "planner-agent",
          updatedBy: input.actorAgentId,
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:01.000Z",
          evidence: [],
        },
      },
    }));
    const tools = createContextTools(
      {
        listContext: notCalledListOperation,
        readContext: notCalledOperation,
        searchContext: notCalledOperation,
        addContext: notCalledOperation,
        updateContext: notCalledOperation,
        deleteContext: notCalledOperation,
        listTaskMemory: notCalledTaskMemoryOperation,
        getTaskMemory: notCalledTaskMemoryOperation,
        appendTaskMemory: notCalledTaskMemoryOperation,
        patchTaskMemory,
      },
      {
        agentId: "planner-agent",
      },
    );
    const patchTool = tools.find((tool) => tool.name === "patch_task_memory");

    await patchTool?.call(
      {
        id: "memory-1",
        expectedRevision: 2,
        content: "Updated content",
        status: "resolved",
        items: [{ id: "todo-1", text: "Ship review fix", done: true }],
      },
      undefined,
    );

    expect(patchTaskMemory).toHaveBeenCalledWith({
      id: "memory-1",
      actorAgentId: "planner-agent",
      expectedRevision: 2,
      patch: {
        title: undefined,
        content: "Updated content",
        status: "resolved",
        items: [{ id: "todo-1", text: "Ship review fix", done: true, assigneeAgentId: undefined }],
      },
      context: {
        source: {
          type: "system",
        },
        attributes: {},
      },
    });
  });

  it("returns validation errors for invalid task memory append payloads", async () => {
    const taskStore = createInMemoryTaskMemoryStore();
    const tools = createContextTools(
      {
        listContext: notCalledListOperation,
        readContext: notCalledOperation,
        searchContext: notCalledOperation,
        addContext: notCalledOperation,
        updateContext: notCalledOperation,
        deleteContext: notCalledOperation,
        listTaskMemory: notCalledTaskMemoryOperation,
        getTaskMemory: notCalledTaskMemoryOperation,
        appendTaskMemory: (input) => taskStore.append(input),
        patchTaskMemory: notCalledTaskMemoryOperation,
      },
      {
        agentId: "specialist-agent",
        getContext: () => ({
          source: {
            type: "workflow",
          },
          attributes: {
            "taskMemory.workflowRunId": "workflow-2",
          },
        }),
      },
    );
    const appendTool = tools.find((tool) => tool.name === "append_task_memory");

    await expect(
      appendTool?.call(
        {
          visibility: "private",
          kind: "todo",
          content: "Missing items",
        },
        undefined,
      ),
    ).resolves.toEqual({
      text: "Task memory operation failed: Todo task memory requires todo items.",
      isError: true,
      details: {
        error: {
          code: "invalid_input",
          message: "Todo task memory requires todo items.",
        },
      },
    });
    await expect(
      appendTool?.call(
        {
          visibility: "private",
          kind: "note",
          content: "Items are not allowed",
          items: [{ id: "todo-1", text: "Bad payload", done: false }],
        },
        undefined,
      ),
    ).resolves.toEqual({
      text: "Task memory operation failed: Only todo task memory may include todo items.",
      isError: true,
      details: {
        error: {
          code: "invalid_input",
          message: "Only todo task memory may include todo items.",
        },
      },
    });
  });

  it("passes array status filters to list task memory", async () => {
    const listTaskMemory = vi.fn(async () => ({
      ok: true as const,
      value: [],
    }));
    const tools = createContextTools(
      {
        listContext: notCalledListOperation,
        readContext: notCalledOperation,
        searchContext: notCalledOperation,
        addContext: notCalledOperation,
        updateContext: notCalledOperation,
        deleteContext: notCalledOperation,
        listTaskMemory,
        getTaskMemory: notCalledTaskMemoryOperation,
        appendTaskMemory: notCalledTaskMemoryOperation,
        patchTaskMemory: notCalledTaskMemoryOperation,
      },
      {
        agentId: "planner-agent",
        getContext: () => ({
          source: {
            type: "workflow",
          },
          attributes: {
            "taskMemory.workflowRunId": "workflow-1",
          },
        }),
      },
    );
    const listTool = tools.find((tool) => tool.name === "list_task_memory");

    await listTool?.call(
      {
        status: ["active", "resolved"],
      },
      undefined,
    );

    expect(listTaskMemory).toHaveBeenCalledWith({
      workflowRunId: "workflow-1",
      actorAgentId: "planner-agent",
      taskRunId: undefined,
      visibility: undefined,
      status: ["active", "resolved"],
      context: {
        source: {
          type: "workflow",
        },
        attributes: {
          "taskMemory.workflowRunId": "workflow-1",
        },
      },
    });
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
  ExpertAgentContextItemOperations["updateContext"] &
  ExpertAgentContextItemOperations["deleteContext"];

const notCalledTaskMemoryOperation = vi.fn(async () => {
  throw new Error("Unexpected task memory operation call.");
}) as unknown as NonNullable<ExpertAgentContextItemOperations["getTaskMemory"]> &
  NonNullable<ExpertAgentContextItemOperations["listTaskMemory"]> &
  NonNullable<ExpertAgentContextItemOperations["appendTaskMemory"]> &
  NonNullable<ExpertAgentContextItemOperations["patchTaskMemory"]>;
