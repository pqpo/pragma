import { describe, expect, it, vi } from "vitest";

import { deleteCompletedTaskMission } from "./desktop-storage-cleanup-ipc.ts";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

describe("completed conversation cleanup", () => {
  it("claims eligibility before invoking the normal Mission deletion path", async () => {
    const remove = vi.fn(async () => {});
    const claimCompletedTaskDeletion = vi.fn(async () => {});
    await deleteCompletedTaskMission(
      { missions: { claimCompletedTaskDeletion }, runner: { delete: remove } },
      "mission-id",
    );
    expect(claimCompletedTaskDeletion).toHaveBeenCalledWith("mission-id");
    expect(remove).toHaveBeenCalledWith("mission-id");
  });

  it("does not delete when the storage claim rejects", async () => {
    const remove = vi.fn(async () => {});
    const claimCompletedTaskDeletion = vi.fn(async () => {
      throw new Error("Mission is active");
    });
    await expect(
      deleteCompletedTaskMission(
        { missions: { claimCompletedTaskDeletion }, runner: { delete: remove } },
        "mission-id",
      ),
    ).rejects.toThrow("Mission is active");
    expect(remove).not.toHaveBeenCalled();
  });
});
