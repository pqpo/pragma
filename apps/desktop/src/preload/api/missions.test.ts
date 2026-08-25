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

  it.each([
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
