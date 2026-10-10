import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileMemoryPolicyStore } from "@pragma/memory";
import { describe, expect, it, vi } from "vitest";
import { installMemoryPolicyHandlers } from "./memory-policy-ipc.ts";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
    electron.handlers.set(channel, handler);
  }),
}));
vi.mock("electron", () => ({ ipcMain: { handle: electron.handle } }));

describe("Memory policy IPC", () => {
  it("keeps authorized recall results available when execution search text cannot be loaded", async () => {
    electron.handlers.clear();
    const readEvents = vi.fn(async () => {
      throw new Error("execution unavailable");
    });
    const listRecall = vi.fn(async () => [
      {
        schemaVersion: "pragma.memory-recall-activity/v1",
        id: "recall",
        executionId: "own",
        invocationId: "invocation",
        operation: "search",
        target: "memory",
        queryDigest: "digest",
        resultRefs: [{ id: "overview.md" }],
        outcome: "allowed",
        reason: "matched",
        occurredAt: "2026-10-10T09:00:00.000Z",
      },
    ]);
    installMemoryPolicyHandlers(
      { activity: { listRecall }, executionStore: { readEvents } } as unknown as Parameters<
        typeof installMemoryPolicyHandlers
      >[0],
      {
        missions: {
          get: vi.fn(async () => ({})),
          readTimelinePage: vi.fn(async () => ({
            turns: [
              {
                sequence: 1,
                executionId: "own",
                message: { content: "Task", createdAt: "2026-10-10T09:00:00.000Z" },
              },
            ],
          })),
        },
        memoryBrowser: { getMemorySourceReader: vi.fn(async () => async () => undefined) },
        curator: { subscribeRunChat: vi.fn() },
        getWindow: () => null,
      } as unknown as Parameters<typeof installMemoryPolicyHandlers>[1],
    );
    const page = await electron.handlers.get("memory-mission:recall")!(
      {},
      {
        missionId: "00000000-0000-4000-8000-000000000001",
        executionId: "own",
        limit: 30,
      },
    );
    expect(readEvents).toHaveBeenCalledWith("own");
    expect(page).toMatchObject({
      records: [{ operation: "search", sources: [{ id: "overview.md", available: true }] }],
    });
    expect((page as { records: object[] }).records[0]).not.toHaveProperty("query");
  });

  it("rejects recall content requests for another Mission's execution before reading sources", async () => {
    electron.handlers.clear();
    const listRecall = vi.fn();
    const getMemorySourceReader = vi.fn();
    installMemoryPolicyHandlers(
      { activity: { listRecall } } as unknown as Parameters<typeof installMemoryPolicyHandlers>[0],
      {
        missions: {
          get: vi.fn(async () => ({})),
          readTimelinePage: vi.fn(async () => ({
            turns: [
              {
                sequence: 1,
                executionId: "own",
                message: { content: "Task", createdAt: "2026-10-10T09:00:00.000Z" },
              },
            ],
          })),
        },
        memoryBrowser: { getMemorySourceReader },
        curator: { subscribeRunChat: vi.fn() },
        getWindow: () => null,
      } as unknown as Parameters<typeof installMemoryPolicyHandlers>[1],
    );
    await expect(
      electron.handlers.get("memory-mission:recall")!(
        {},
        { missionId: "00000000-0000-4000-8000-000000000001", executionId: "other", limit: 30 },
      ),
    ).rejects.toThrow("memory_execution_not_in_mission");
    expect(listRecall).not.toHaveBeenCalled();
    expect(getMemorySourceReader).not.toHaveBeenCalled();
    electron.handlers.clear();
  });

  it("cancels retrieval before and after committing an asset recall change", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-memory-policy-ipc-"));
    electron.handlers.clear();
    const policies = createFileMemoryPolicyStore({ pragmaHome });
    const cancel = vi.fn();
    const update = vi.spyOn(policies, "updateOverride");
    try {
      await policies.updateGlobal({
        expectedRevision: 0,
        policy: { enabled: "enabled", capture: "enabled", recall: "enabled", learning: "disabled" },
      });
      installMemoryPolicyHandlers(
        { policies, retrieval: { cancel } } as unknown as Parameters<
          typeof installMemoryPolicyHandlers
        >[0],
        { curator: { subscribeRunChat: vi.fn() }, getWindow: () => null } as unknown as Parameters<
          typeof installMemoryPolicyHandlers
        >[1],
      );
      const result = await electron.handlers.get("memory-policy:asset:update")!(
        {},
        {
          targetRef: { type: "pragma.expert", id: "7k2m9q4v8np6r3dt" },
          expectedRevision: 0,
          policy: { capture: "inherit", recall: "disabled", learning: "inherit" },
        },
      );
      expect(result).toMatchObject({ revision: 1, effective: { recall: false } });
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]!);
      expect(cancel.mock.invocationCallOrder[1]).toBeGreaterThan(
        update.mock.invocationCallOrder[0]!,
      );
    } finally {
      update.mockRestore();
      electron.handlers.clear();
      await rm(pragmaHome, { recursive: true, force: true });
    }
  });
});
