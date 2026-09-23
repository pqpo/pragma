import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  invokeMutation: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener },
}));
vi.mock("../invoke-mutation.ts", () => ({ invokeMutation: mocks.invokeMutation }));

import { missionsApi } from "./missions.ts";

describe("missionsApi", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invokeMutation.mockReset();
    mocks.on.mockReset();
    mocks.removeListener.mockReset();
  });

  it("validates direct Mission status deltas before forwarding them", () => {
    const listener = vi.fn();
    const unsubscribe = missionsApi.subscribeMissionStatusUpdates(listener);
    const handler = mocks.on.mock.calls[0]?.[1] as
      ((event: unknown, value: unknown) => void) | undefined;
    expect(mocks.on).toHaveBeenCalledWith("missions:status:updated", expect.any(Function));

    handler?.(
      {},
      {
        missionId: "00000000-0000-4000-8000-000000000001",
        revision: 3,
        execution: {
          id: "00000000-0000-4000-8000-000000000002",
          status: "succeeded",
        },
      },
    );
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: 3,
        execution: { id: expect.any(String), status: "succeeded" },
      }),
    );
    expect(() => handler?.({}, { missionId: "bad", revision: 0 })).toThrow();

    unsubscribe();
    expect(mocks.removeListener).toHaveBeenCalledWith("missions:status:updated", handler);
  });

  it("validates a detail-only Mission source from the Host", async () => {
    mocks.invokeMutation.mockResolvedValueOnce({ type: "internal" });
    await expect(
      missionsApi.getMissionListSource("00000000-0000-4000-8000-000000000001"),
    ).resolves.toEqual({ type: "internal" });
    mocks.invokeMutation.mockResolvedValueOnce({ type: "unknown" });
    await expect(
      missionsApi.getMissionListSource("00000000-0000-4000-8000-000000000001"),
    ).rejects.toThrow();
  });

  it("validates and persists the complete Home project order", async () => {
    const first = {
      id: "00000000-0000-4000-8000-000000000001",
      name: "First",
      executorRef: "expert:0000000000pragma",
      contextStoreIds: [],
      workspace: { path: "/work/first", basename: "first" },
    };
    const second = { ...first, id: "00000000-0000-4000-8000-000000000002", name: "Second" };
    mocks.invokeMutation.mockResolvedValueOnce([second, first]);

    await expect(missionsApi.reorderHomeProjects([second.id, first.id])).resolves.toEqual([
      second,
      first,
    ]);
    expect(mocks.invokeMutation).toHaveBeenCalledWith("missions:home-projects:reorder", [
      second.id,
      first.id,
    ]);
  });

  it("opens, validates, and closes an on-demand work conversation stream", async () => {
    const missionId = "00000000-0000-4000-8000-000000000001";
    const subscriptionId = "00000000-0000-4000-8000-000000000002";
    const streamId = "00000000-0000-4000-8000-000000000003";
    mocks.invoke.mockResolvedValueOnce({
      subscriptionId,
      streamId,
      snapshot: { missionId, recordId: "agent:reviewer", revision: 1, entries: [] },
    });

    await expect(
      missionsApi.openMissionWorkConversationStream({
        subscriptionId,
        missionId,
        recordId: "agent:reviewer",
        limit: 100,
      }),
    ).resolves.toMatchObject({ streamId, snapshot: { missionId, entries: [] } });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "missions:work:conversation:stream:open",
      expect.objectContaining({ subscriptionId, missionId, recordId: "agent:reviewer" }),
    );

    const listener = vi.fn();
    const unsubscribe = missionsApi.subscribeMissionWorkConversationUpdates(listener);
    const handler = mocks.on.mock.calls[0]?.[1] as
      ((event: unknown, value: unknown) => void) | undefined;
    handler?.(
      {},
      {
        subscriptionId,
        streamId,
        sequence: 1,
        missionId,
        recordId: "agent:reviewer",
        kind: "invalidate",
      },
    );
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ sequence: 1 }));
    unsubscribe();

    mocks.invoke.mockResolvedValueOnce(undefined);
    await missionsApi.closeMissionWorkConversationStream({ subscriptionId });
    expect(mocks.invoke).toHaveBeenLastCalledWith("missions:work:conversation:stream:close", {
      subscriptionId,
    });
  });

  it("rejects duplicate project IDs before invoking the reorder mutation", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001";
    await expect(missionsApi.reorderHomeProjects([projectId, projectId])).rejects.toThrow();
    expect(mocks.invokeMutation).not.toHaveBeenCalled();
  });

  it.each([
    [
      "getMissionListSource",
      () => missionsApi.getMissionListSource("00000000-0000-4000-8000-000000000001"),
    ],
    ["getMission", () => missionsApi.getMission("00000000-0000-4000-8000-000000000001")],
    [
      "markMissionComplete",
      () => missionsApi.markMissionComplete("00000000-0000-4000-8000-000000000001"),
    ],
    ["reopenMission", () => missionsApi.reopenMission("00000000-0000-4000-8000-000000000001")],
  ])("preserves structured Mission errors from %s", async (_name, invoke) => {
    const error = {
      code: "mission_not_found",
      message: "Mission was not found.",
      diagnostics: [],
    };
    mocks.invoke.mockRejectedValueOnce(new Error("Raw Electron IPC error."));
    mocks.invokeMutation.mockRejectedValueOnce(error);

    await expect(invoke()).rejects.toBe(error);
  });
});
