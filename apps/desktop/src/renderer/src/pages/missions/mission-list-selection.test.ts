import { expect, it } from "vitest";
import { resolveUnlistedMissionSelection } from "./mission-list-selection.ts";

it("retains an internal detail, falls back for a deleted Mission, and surfaces other read failures", async () => {
  await expect(
    resolveUnlistedMissionSelection({
      id: "hidden",
      getSource: async () => ({ type: "internal" }),
      isCurrent: () => true,
    }),
  ).resolves.toBe("detail");
  await expect(
    resolveUnlistedMissionSelection({
      id: "deleted",
      getSource: async () => {
        throw { code: "mission_not_found" };
      },
      isCurrent: () => true,
    }),
  ).resolves.toBe("deleted");
  const error = new Error("Host disconnected");
  await expect(
    resolveUnlistedMissionSelection({
      id: "hidden",
      getSource: async () => {
        throw error;
      },
      isCurrent: () => true,
    }),
  ).rejects.toBe(error);
});

it.each([false, true])(
  "ignores a stale source response after the user navigates (rejected=%s)",
  async (rejected) => {
    let complete!: () => void;
    const ready = new Promise<void>((resolve) => {
      complete = resolve;
    });
    let current = true;
    const pending = resolveUnlistedMissionSelection({
      id: "hidden",
      getSource: async () => {
        await ready;
        if (rejected) throw new Error("stale error");
        return { type: "internal" };
      },
      isCurrent: () => current,
    });
    current = false;
    complete();
    await expect(pending).resolves.toBe("stale");
  },
);
