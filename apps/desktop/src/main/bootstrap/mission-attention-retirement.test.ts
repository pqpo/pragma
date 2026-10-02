import { describe, expect, it, vi } from "vitest";
import { createMissionAttentionRetirement } from "./mission-attention-retirement.ts";

describe("Mission Attention retirement", () => {
  it("retries a failed foreground stop during background settlement", async () => {
    const stop = vi
      .fn<(id: string) => Promise<void>>(async () => {})
      .mockRejectedValueOnce(new Error("stop failed"));
    const retiring = createMissionAttentionRetirement(stop);
    await expect(retiring.stop("mission")).rejects.toThrow("stop failed");
    await retiring.finish("mission");
    expect(stop).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenLastCalledWith("mission");
  });
  it("shares an outstanding stop and consumes a successful stop once", async () => {
    let release!: () => void;
    const stop = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const retiring = createMissionAttentionRetirement(stop);
    const first = retiring.stop("mission");
    expect(retiring.stop("mission")).toBe(first);
    const finished = retiring.finish("mission");
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    release();
    await finished;
    expect(stop).toHaveBeenCalledOnce();
  });
});
