import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MemorySystem, createFileSystemTaskMemoryStore } from "../src/index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("file-system TaskMemoryStore", () => {
  it("stores records under the Execution directory by default", async () => {
    const dir = await mkdtemp(join(process.cwd(), "tmp-task-memory-"));
    tempDirs.push(dir);
    const store = createFileSystemTaskMemoryStore({
      agentId: "agent-a",
      rootDir: dir,
    });

    const appended = await store.append({
      actorAgentId: "agent-a",
      record: {
        type: "task",
        scope: "session",
        executionId: "execution-1",
        visibility: "shared",
        kind: "note",
        content: "Execution scoped note",
        status: "active",
      },
    });

    expect(appended.ok).toBe(true);

    const raw = await readFile(
      join(dir, "agent-a", "task-memory", "executions", "execution-1", "records.json"),
      "utf8",
    );
    expect(JSON.parse(raw)).toEqual([
      expect.objectContaining({
        executionId: "execution-1",
        content: "Execution scoped note",
      }),
    ]);
  });

  it("removes stale execution files when a record id moves to another execution", async () => {
    const dir = await mkdtemp(join(process.cwd(), "tmp-task-memory-"));
    tempDirs.push(dir);
    const store = createFileSystemTaskMemoryStore({
      agentId: "agent-a",
      rootDir: dir,
    });

    const first = await store.append({
      actorAgentId: "agent-a",
      record: {
        id: "stable-task-id",
        type: "task",
        scope: "session",
        executionId: "execution-1",
        visibility: "shared",
        kind: "note",
        content: "Original execution note",
        status: "active",
      },
    });
    const moved = await store.append({
      actorAgentId: "agent-a",
      record: {
        id: "stable-task-id",
        type: "task",
        scope: "session",
        executionId: "execution-2",
        visibility: "shared",
        kind: "note",
        content: "Moved execution note",
        status: "active",
      },
    });

    expect(first.ok).toBe(true);
    expect(moved.ok).toBe(true);

    const executionOne = await store.list({
      executionId: "execution-1",
      actorAgentId: "agent-a",
    });
    const executionTwo = await store.list({
      executionId: "execution-2",
      actorAgentId: "agent-a",
    });

    expect(executionOne).toMatchObject({ ok: true, value: [] });
    expect(executionTwo).toMatchObject({
      ok: true,
      value: [
        expect.objectContaining({
          id: "stable-task-id",
          executionId: "execution-2",
          content: "Moved execution note",
        }),
      ],
    });
  });

  it("lists shared entries by Execution", async () => {
    const store = await createStore();

    const appended = await store.append({
      actorAgentId: "agent-a",
      record: {
        type: "task",
        scope: "session",
        executionId: "execution-1",
        runtimeSession: { type: "cloud-pi-agent", id: "session-1" },
        visibility: "shared",
        kind: "handoff",
        content: "Schema migration complete. Validation remains.",
        status: "active",
      },
    });

    expect(appended.ok).toBe(true);

    const result = await store.list({
      executionId: "execution-1",
      actorAgentId: "agent-b",
      visibility: "shared",
    });

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (!result.ok) {
      return;
    }

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.content).toContain("Validation remains");
  });

  it("hides private entries from other agents", async () => {
    const store = await createStore();
    const appended = await store.append({
      actorAgentId: "agent-a",
      record: {
        type: "task",
        scope: "session",
        executionId: "execution-1",
        runtimeSession: { type: "cloud-pi-agent", id: "session-1" },
        visibility: "private",
        ownerAgentId: "agent-a",
        kind: "note",
        content: "Double-check prompt assembly before publishing.",
        status: "active",
      },
    });

    expect(appended.ok).toBe(true);
    if (!appended.ok) {
      return;
    }

    const forbidden = await store.get({
      id: appended.value.id,
      actorAgentId: "agent-b",
    });

    expect(forbidden.ok).toBe(false);
    if (forbidden.ok) {
      return;
    }

    expect(forbidden.error.code).toBe("permission_denied");
  });

  it("rejects private writes owned by another agent", async () => {
    const store = await createStore();

    const result = await store.append({
      actorAgentId: "agent-a",
      record: {
        type: "task",
        scope: "session",
        executionId: "execution-1",
        runtimeSession: { type: "cloud-pi-agent", id: "session-1" },
        visibility: "private",
        ownerAgentId: "agent-b",
        kind: "note",
        content: "This should not be writable by agent-a.",
        status: "active",
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.code).toBe("permission_denied");
  });

  it("patches todo entries and increments revision", async () => {
    const store = await createStore();
    const appended = await store.append({
      actorAgentId: "agent-a",
      record: {
        type: "task",
        scope: "session",
        executionId: "execution-1",
        runtimeSession: { type: "cloud-pi-agent", id: "session-1" },
        visibility: "shared",
        kind: "todo",
        content: "Release checklist",
        status: "active",
        items: [
          {
            id: "todo-1",
            text: "Validate API schema changes",
            done: false,
            assigneeAgentId: "agent-a",
          },
        ],
      },
    });

    expect(appended.ok).toBe(true);
    if (!appended.ok) {
      return;
    }

    const updated = await store.patch({
      id: appended.value.id,
      actorAgentId: "agent-b",
      expectedRevision: appended.value.revision,
      patch: {
        items: [
          {
            id: "todo-1",
            text: "Validate API schema changes",
            done: true,
            assigneeAgentId: "agent-a",
          },
        ],
        status: "resolved",
      },
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok) {
      return;
    }

    expect(updated.value.revision).toBe(1);
    expect(updated.value.status).toBe("resolved");
    expect(updated.value.items?.[0]?.done).toBe(true);
  });

  it("returns memory_conflict for stale revisions", async () => {
    const store = await createStore();
    const appended = await store.append({
      actorAgentId: "agent-a",
      record: {
        type: "task",
        scope: "session",
        executionId: "execution-1",
        runtimeSession: { type: "cloud-pi-agent", id: "session-1" },
        visibility: "shared",
        kind: "todo",
        content: "Release checklist",
        status: "active",
        items: [
          {
            id: "todo-1",
            text: "Validate API schema changes",
            done: false,
          },
        ],
      },
    });

    expect(appended.ok).toBe(true);
    if (!appended.ok) {
      return;
    }

    const firstPatch = await store.patch({
      id: appended.value.id,
      actorAgentId: "agent-a",
      expectedRevision: 0,
      patch: {
        items: [
          {
            id: "todo-1",
            text: "Validate API schema changes",
            done: true,
          },
        ],
      },
    });

    expect(firstPatch.ok).toBe(true);

    const stalePatch = await store.patch({
      id: appended.value.id,
      actorAgentId: "agent-b",
      expectedRevision: 0,
      patch: {
        status: "resolved",
      },
    });

    expect(stalePatch.ok).toBe(false);
    if (stalePatch.ok) {
      return;
    }

    expect(stalePatch.error.code).toBe("memory_conflict");
  });

  it("excludes private entries from other agents during runtime retrieval", async () => {
    const store = await createStore();

    await store.append({
      actorAgentId: "agent-a",
      record: {
        type: "task",
        scope: "session",
        executionId: "execution-1",
        runtimeSession: { type: "cloud-pi-agent", id: "session-1" },
        visibility: "shared",
        kind: "handoff",
        content: "Shared coordination state",
        status: "active",
      },
    });
    await store.append({
      actorAgentId: "agent-a",
      record: {
        type: "task",
        scope: "session",
        executionId: "execution-1",
        runtimeSession: { type: "cloud-pi-agent", id: "session-1" },
        visibility: "private",
        ownerAgentId: "agent-a",
        kind: "note",
        content: "Only agent-a should see this note",
        status: "active",
      },
    });

    const retrieved = await store.retrieveForRuntime({
      agentId: "agent-b",
      executionId: "execution-1",
    });

    expect(retrieved.ok).toBe(true);
    if (!retrieved.ok) {
      return;
    }

    expect(retrieved.value.shared).toHaveLength(1);
    expect(retrieved.value.private).toHaveLength(0);
    expect(retrieved.value.combined).toHaveLength(1);
  });

  it("scopes private runtime retrieval to the current task run", async () => {
    const store = await createStore();

    await store.append({
      actorAgentId: "agent-a",
      record: {
        type: "task",
        scope: "session",
        executionId: "execution-1",
        runtimeSession: { type: "cloud-pi-agent", id: "session-1" },
        invocationId: "task-1",
        visibility: "private",
        ownerAgentId: "agent-a",
        kind: "note",
        content: "Visible in task-1",
        status: "active",
      },
    });
    await store.append({
      actorAgentId: "agent-a",
      record: {
        type: "task",
        scope: "session",
        executionId: "execution-1",
        runtimeSession: { type: "cloud-pi-agent", id: "session-1" },
        invocationId: "task-2",
        visibility: "private",
        ownerAgentId: "agent-a",
        kind: "note",
        content: "Must stay out of task-1 runtime context",
        status: "active",
      },
    });

    const retrieved = await store.retrieveForRuntime({
      agentId: "agent-a",
      executionId: "execution-1",
      runtimeSession: { type: "cloud-pi-agent", id: "session-1" },
      invocationId: "task-1",
    });

    expect(retrieved).toEqual(expect.objectContaining({ ok: true }));
    if (!retrieved.ok) {
      return;
    }

    expect(retrieved.value.private).toHaveLength(1);
    expect(retrieved.value.private[0]?.content).toBe("Visible in task-1");
    expect(retrieved.value.combined).toHaveLength(1);
  });

  it("does not isolate execution task memory by runtime session during runtime retrieval", async () => {
    const store = await createStore();

    await store.append({
      actorAgentId: "agent-a",
      record: {
        type: "task",
        scope: "session",
        executionId: "execution-1",
        runtimeSession: { type: "cloud-pi-agent", id: "runtime-session-old" },
        visibility: "shared",
        kind: "handoff",
        content: "Execution state survives runtime session changes",
        status: "active",
      },
    });

    const retrieved = await store.retrieveForRuntime({
      agentId: "agent-a",
      executionId: "execution-1",
      runtimeSession: { type: "cloud-pi-agent", id: "runtime-session-new" },
    });

    expect(retrieved).toEqual(expect.objectContaining({ ok: true }));
    if (!retrieved.ok) {
      return;
    }

    expect(retrieved.value.combined).toHaveLength(1);
    expect(retrieved.value.combined[0]?.content).toBe(
      "Execution state survives runtime session changes",
    );
  });

  it("distinguishes equal native session ids from different runtime kinds", async () => {
    const store = await createStore();
    for (const runtimeType of ["cloud-pi-agent", "codex-local"] as const) {
      await store.append({
        actorAgentId: "agent-a",
        record: {
          type: "task",
          scope: "session",
          executionId: "execution-1",
          runtimeSession: { type: runtimeType, id: "session-1" },
          visibility: "shared",
          kind: "note",
          content: runtimeType,
          status: "active",
        },
      });
    }

    const listed = await store.list({
      executionId: "execution-1",
      actorAgentId: "agent-a",
      runtimeSession: { type: "codex-local", id: "session-1" },
    });

    expect(listed).toEqual(expect.objectContaining({ ok: true }));
    if (listed.ok) {
      expect(listed.value.map((record) => record.content)).toEqual(["codex-local"]);
    }
  });

  it("archives entries by task run and removes them from active retrieval", async () => {
    const store = await createStore();

    await store.append({
      actorAgentId: "agent-a",
      record: {
        type: "task",
        scope: "session",
        executionId: "execution-1",
        runtimeSession: { type: "cloud-pi-agent", id: "session-1" },
        invocationId: "task-1",
        visibility: "shared",
        kind: "progress",
        content: "Halfway complete",
        status: "active",
      },
    });

    const archived = await store.archive({
      executionId: "execution-1",
      runtimeSession: { type: "cloud-pi-agent", id: "session-1" },
      invocationId: "task-1",
      actorAgentId: "agent-a",
    });

    expect(archived.ok).toBe(true);
    if (!archived.ok) {
      return;
    }

    expect(archived.value[0]?.status).toBe("archived");

    const listed = await store.list({
      executionId: "execution-1",
      actorAgentId: "agent-a",
      status: "active",
    });
    const retrieved = await store.retrieveForRuntime({
      agentId: "agent-a",
      executionId: "execution-1",
    });

    expect(listed).toEqual(expect.objectContaining({ ok: true }));
    expect(retrieved).toEqual(expect.objectContaining({ ok: true }));
    if (!listed.ok || !retrieved.ok) {
      return;
    }

    expect(listed.value).toEqual([]);
    expect(retrieved.value.combined).toEqual([]);
  });

  it("rejects runtime-session-only archive scope", async () => {
    const store = await createStore();

    const archived = await store.archive({
      runtimeSession: { type: "cloud-pi-agent", id: "runtime-session-1" },
      actorAgentId: "agent-a",
    });

    expect(archived).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "invalid_input",
        }),
      }),
    );
  });

  it("integrates with MemorySystem runtime retrieval", async () => {
    const system = new MemorySystem({
      taskStore: await createStore(),
    });

    await system.appendTaskMemory({
      actorAgentId: "agent-a",
      record: {
        type: "task",
        scope: "session",
        executionId: "execution-1",
        runtimeSession: { type: "cloud-pi-agent", id: "session-1" },
        visibility: "shared",
        kind: "handoff",
        content: "Shared coordination state",
        status: "active",
      },
    });
    await system.appendTaskMemory({
      actorAgentId: "agent-a",
      record: {
        type: "task",
        scope: "session",
        executionId: "execution-1",
        runtimeSession: { type: "cloud-pi-agent", id: "session-1" },
        visibility: "private",
        ownerAgentId: "agent-a",
        kind: "note",
        content: "Private working note",
        status: "active",
      },
    });

    const retrieved = await system.retrieveForRuntime({
      request: {
        agentId: "agent-a",
        executionId: "execution-1",
      },
    });

    expect(retrieved.ok).toBe(true);
    if (!retrieved.ok) {
      return;
    }

    expect(retrieved.value.task.shared).toHaveLength(1);
    expect(retrieved.value.task.private).toHaveLength(1);
    expect(retrieved.value.task.combined).toHaveLength(2);
  });

  it("honors the configured task summary length", async () => {
    const dir = await mkdtemp(join(process.cwd(), "tmp-task-memory-"));
    tempDirs.push(dir);
    const store = createFileSystemTaskMemoryStore({
      agentId: "agent-a",
      rootDir: dir,
      summaryMaxChars: 40,
    });

    const appended = await store.append({
      actorAgentId: "agent-a",
      record: {
        type: "task",
        scope: "session",
        executionId: "execution-1",
        runtimeSession: { type: "cloud-pi-agent", id: "session-1" },
        visibility: "shared",
        kind: "progress",
        title: "A very long summary should be truncated",
        content:
          "This content is intentionally long enough to exceed the configured summary limit.",
        status: "active",
      },
    });

    expect(appended).toEqual(expect.objectContaining({ ok: true }));
    if (!appended.ok) {
      return;
    }

    expect(appended.value.summary?.length ?? 0).toBeLessThanOrEqual(40);
  });

  it("backfills missing task summaries when listing records for the always-on summary", async () => {
    const dir = await mkdtemp(join(process.cwd(), "tmp-task-memory-"));
    tempDirs.push(dir);
    const filePath = join(dir, "task.json");
    await writeFile(
      filePath,
      `${JSON.stringify(
        [
          {
            id: "legacy-task",
            type: "task",
            scope: "session",
            executionId: "execution-1",
            runtimeSession: { type: "cloud-pi-agent", id: "session-1" },
            visibility: "shared",
            kind: "progress",
            content: "Legacy records did not persist summary fields.",
            status: "active",
            revision: 0,
            provenance: {
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              evidence: [],
            },
          },
        ],
        null,
        2,
      )}\n`,
      "utf8",
    );
    const store = createFileSystemTaskMemoryStore({
      agentId: "agent-a",
      filePath,
    });

    const listed = await store.listForSummary({
      actorAgentId: "agent-a",
    });

    expect(listed).toEqual(expect.objectContaining({ ok: true }));
    if (!listed.ok) {
      return;
    }

    expect(listed.value[0]?.summary).toContain("Legacy records did not persist summary fields");
  });
});

async function createStore() {
  const dir = await mkdtemp(join(process.cwd(), "tmp-task-memory-"));
  tempDirs.push(dir);

  return createFileSystemTaskMemoryStore({
    agentId: "agent-a",
    rootDir: dir,
  });
}
