import { describe, expect, it } from "vitest";
import { trackMissionDeletionSettlement } from "@pragma/local-host";

describe("Mission deletion observer settlement", () => {
  it("releases idle Mission observers after success and failure", async () => {
    const pending = new Map<string, Promise<void>>();
    trackMissionDeletionSettlement(pending, "idle", Promise.resolve());
    trackMissionDeletionSettlement(pending, "failed", Promise.reject(new Error("observer failed")));
    await Promise.resolve();
    expect(pending.size).toBe(0);
  });
  it("does not clear a newer active settlement when older observers finish", async () => {
    const pending = new Map<string, Promise<void>>();
    let release!: () => void;
    const active = new Promise<void>((resolve) => {
      release = resolve;
    });
    trackMissionDeletionSettlement(pending, "mission", Promise.resolve());
    trackMissionDeletionSettlement(pending, "mission", active);
    await Promise.resolve();
    expect(pending.get("mission")).toBe(active);
    release();
    await active;
    expect(pending.size).toBe(0);
  });
});
