import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MemorySystem,
  createFileSystemTaskMemoryStore,
  createTaskMemoryTools,
} from "../src/index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("task-memory tools", () => {
  it("uses Execution context and agent id defaults", async () => {
    const store = await createStore("planner-agent");
    const tools = createTaskMemoryTools({
      memorySystem: new MemorySystem({
        taskStore: store,
      }),
      defaultAgentId: "planner-agent",
    });
    const listTool = tools.find((tool) => tool.name === "list_task_memory");

    const result = await listTool?.call({}, undefined, {
      runContext: {
        source: {
          type: "execution",
        },
        attributes: {
          "execution.executionId": "execution-1",
          "execution.runtimeSession": { type: "cloud-pi-agent", id: "session-1" },
          "execution.invocationId": "task-1",
        },
      },
    });

    expect(result).toEqual({
      text: "No task memory entries found.",
      details: {
        entries: [],
      },
    });
  });

  it("appends private todo task memory with the current agent as owner", async () => {
    const store = await createStore("specialist-agent");
    const memorySystem = new MemorySystem({
      taskStore: store,
    });
    const tools = createTaskMemoryTools({
      memorySystem,
      defaultAgentId: "specialist-agent",
    });
    const appendTool = tools.find((tool) => tool.name === "append_task_memory");

    const result = await appendTool?.call(
      {
        visibility: "private",
        kind: "todo",
        content: "My private checklist",
        items: [{ id: "todo-1", text: "Check contract", done: false }],
      },
      undefined,
      {
        runContext: {
          source: {
            type: "execution",
          },
          attributes: {
            "execution.executionId": "execution-2",
            "execution.runtimeSession": { type: "cloud-pi-agent", id: "session-1" },
          },
        },
      },
    );

    expect(result?.text).toContain("Appended task memory:");

    const listed = await memorySystem.listTaskMemory({
      executionId: "execution-2",
      actorAgentId: "specialist-agent",
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      return;
    }

    expect(listed.value[0]).toMatchObject({
      visibility: "private",
      ownerAgentId: "specialist-agent",
      kind: "todo",
      items: [{ id: "todo-1", text: "Check contract", done: false }],
    });
  });

  it("appends task memory with execution scope even without runtime session provenance", async () => {
    const store = await createStore("specialist-agent");
    const tools = createTaskMemoryTools({
      memorySystem: new MemorySystem({
        taskStore: store,
      }),
      defaultAgentId: "specialist-agent",
    });
    const appendTool = tools.find((tool) => tool.name === "append_task_memory");

    const result = await appendTool?.call(
      {
        visibility: "shared",
        kind: "note",
        content: "Execution scoped note",
      },
      undefined,
      {
        runContext: {
          source: {
            type: "execution",
          },
          attributes: {
            "execution.executionId": "execution-2",
          },
        },
      },
    );

    expect(result?.text).toContain("Appended task memory:");

    const listed = await store.list({
      executionId: "execution-2",
      actorAgentId: "specialist-agent",
    });
    expect(listed).toMatchObject({
      ok: true,
      value: [
        expect.objectContaining({
          content: "Execution scoped note",
        }),
      ],
    });
    expect(listed.ok && "runtimeSession" in listed.value[0]!).toBe(false);
  });

  it("lets append task memory override runtime session provenance explicitly", async () => {
    const store = await createStore("specialist-agent");
    const tools = createTaskMemoryTools({
      memorySystem: new MemorySystem({
        taskStore: store,
      }),
      defaultAgentId: "specialist-agent",
    });
    const appendTool = tools.find((tool) => tool.name === "append_task_memory");

    const result = await appendTool?.call(
      {
        visibility: "shared",
        kind: "note",
        content: "Explicit runtime session provenance",
        runtimeSession: { type: "cloud-pi-agent", id: "session-explicit" },
      },
      undefined,
      {
        runContext: {
          source: {
            type: "execution",
          },
          attributes: {
            "execution.executionId": "execution-2",
            "execution.runtimeSession": { type: "cloud-pi-agent", id: "session-context" },
          },
        },
      },
    );

    expect(result?.text).toContain("Appended task memory:");

    const listed = await store.list({
      executionId: "execution-2",
      actorAgentId: "specialist-agent",
    });
    expect(listed).toMatchObject({
      ok: true,
      value: [
        expect.objectContaining({
          runtimeSession: { type: "cloud-pi-agent", id: "session-explicit" },
        }),
      ],
    });
  });

  it("reads task memory by id with the current agent id", async () => {
    const store = await createStore("specialist-agent");
    const appended = await store.append({
      actorAgentId: "specialist-agent",
      record: {
        type: "task",
        scope: "session",
        executionId: "execution-2",
        runtimeSession: { type: "cloud-pi-agent", id: "session-1" },
        visibility: "private",
        ownerAgentId: "specialist-agent",
        kind: "note",
        content: "Private note",
        status: "active",
      },
    });
    expect(appended.ok).toBe(true);
    if (!appended.ok) {
      return;
    }

    const tools = createTaskMemoryTools({
      memorySystem: new MemorySystem({ taskStore: store }),
      defaultAgentId: "specialist-agent",
    });
    const getTool = tools.find((tool) => tool.name === "get_task_memory");

    const result = await getTool?.call({ id: appended.value.id }, undefined);

    expect(result?.text).toContain("Private note");
  });

  it("patches task memory with optimistic concurrency", async () => {
    const store = await createStore("planner-agent");
    const appended = await store.append({
      actorAgentId: "planner-agent",
      record: {
        type: "task",
        scope: "session",
        executionId: "execution-2",
        runtimeSession: { type: "cloud-pi-agent", id: "session-1" },
        visibility: "shared",
        kind: "todo",
        content: "Existing content",
        status: "active",
        items: [{ id: "todo-1", text: "Ship review fix", done: false }],
      },
    });
    expect(appended.ok).toBe(true);
    if (!appended.ok) {
      return;
    }

    const tools = createTaskMemoryTools({
      memorySystem: new MemorySystem({ taskStore: store }),
      defaultAgentId: "planner-agent",
    });
    const patchTool = tools.find((tool) => tool.name === "patch_task_memory");

    const result = await patchTool?.call(
      {
        id: appended.value.id,
        expectedRevision: appended.value.revision,
        content: "Updated content",
        status: "resolved",
        items: [{ id: "todo-1", text: "Ship review fix", done: true }],
      },
      undefined,
    );

    expect(result?.text).toContain("@ revision 1");
  });

  it("returns validation errors for invalid task memory append payloads", async () => {
    const store = await createStore("specialist-agent");
    const tools = createTaskMemoryTools({
      memorySystem: new MemorySystem({
        taskStore: store,
      }),
      defaultAgentId: "specialist-agent",
    });
    const appendTool = tools.find((tool) => tool.name === "append_task_memory");

    await expect(
      appendTool?.call(
        {
          visibility: "private",
          kind: "todo",
          content: "Missing items",
        },
        undefined,
        {
          runContext: {
            source: {
              type: "execution",
            },
            attributes: {
              "execution.executionId": "execution-2",
              "execution.runtimeSession": { type: "cloud-pi-agent", id: "session-1" },
            },
          },
        },
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
  });

  it("passes array status filters to list task memory", async () => {
    const store = await createStore("planner-agent");
    const memorySystem = new MemorySystem({
      taskStore: store,
    });
    const tools = createTaskMemoryTools({
      memorySystem,
      defaultAgentId: "planner-agent",
    });
    const appendTool = tools.find((tool) => tool.name === "append_task_memory");
    const listTool = tools.find((tool) => tool.name === "list_task_memory");

    await appendTool?.call(
      {
        visibility: "shared",
        kind: "note",
        content: "First",
        status: "active",
      },
      undefined,
      {
        runContext: {
          source: {
            type: "execution",
          },
          attributes: {
            "execution.executionId": "execution-1",
            "execution.runtimeSession": { type: "cloud-pi-agent", id: "session-1" },
          },
        },
      },
    );

    const result = await listTool?.call(
      {
        status: ["active", "resolved"],
      },
      undefined,
      {
        runContext: {
          source: {
            type: "execution",
          },
          attributes: {
            "execution.executionId": "execution-1",
            "execution.runtimeSession": { type: "cloud-pi-agent", id: "session-1" },
          },
        },
      },
    );

    expect(result?.details).toEqual({
      entries: [
        expect.objectContaining({
          executionId: "execution-1",
          status: "active",
        }),
      ],
    });
  });
});

async function createStore(agentId: string) {
  const dir = await mkdtemp(join(process.cwd(), "tmp-task-tool-memory-"));
  tempDirs.push(dir);

  return createFileSystemTaskMemoryStore({
    agentId,
    rootDir: dir,
  });
}
