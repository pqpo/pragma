import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  invokeMutation: vi.fn(),
}));

vi.mock("electron", () => ({ ipcRenderer: { invoke: mocks.invoke } }));
vi.mock("../invoke-mutation.ts", () => ({ invokeMutation: mocks.invokeMutation }));

import { missionsApi } from "./missions.ts";

describe("missionsApi", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invokeMutation.mockReset();
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
