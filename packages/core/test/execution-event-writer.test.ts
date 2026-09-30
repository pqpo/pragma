import { describe, expect, it, vi } from "vitest";

import { createExecutionEventWriter } from "../src/execution/execution-commit.ts";
import type { ExecutionStore } from "../src/execution/execution-store.ts";

describe("Execution event writer", () => {
  it("flushes on the batching deadline and on tool/human control boundaries", async () => {
    vi.useFakeTimers();
    const commit = vi.fn(async () => ({}));
    const writer = createExecutionEventWriter({ commit } as unknown as ExecutionStore, "execution");
    try {
      writer.append({
        invocationId: "root",
        type: "runtime.event",
        data: { type: "message.started" },
      });
      await vi.advanceTimersByTimeAsync(49);
      expect(commit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(commit).toHaveBeenCalledOnce();
      await writer.append({
        invocationId: "root",
        type: "runtime.event",
        data: { type: "tool.started" },
      });
      expect(commit).toHaveBeenCalledTimes(2);
      await writer.append({ invocationId: "root", type: "human.requested", data: {} });
      expect(commit).toHaveBeenCalledTimes(3);
      await writer.flush();
    } finally {
      vi.useRealTimers();
    }
  });

  it("batches metadata without blocking the producer and flushes before settlement", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commit = vi.fn(async () => {
      await gate;
      return {};
    });
    const writer = createExecutionEventWriter({ commit } as unknown as ExecutionStore, "execution");
    for (let index = 0; index < 10; index++) {
      expect(
        writer.append({ invocationId: "root", type: "runtime.event", data: index }),
      ).toBeUndefined();
    }
    const barrier = writer.flush();
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]).toEqual([
      expect.objectContaining({
        events: Array.from({ length: 10 }, (_, index) => expect.objectContaining({ data: index })),
      }),
    ]);
    let settled = false;
    void barrier.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await barrier;
    expect(settled).toBe(true);
  });

  it("serializes concurrent flushes and preserves order while a commit is blocked", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maximum = 0;
    const committed: number[] = [];
    const commit = vi.fn(async (input: { events: { data: number }[] }) => {
      maximum = Math.max(maximum, ++active);
      await gate;
      committed.push(...input.events.map((event) => event.data));
      active--;
      return {};
    });
    const writer = createExecutionEventWriter({ commit } as unknown as ExecutionStore, "execution");
    writer.append({ invocationId: "root", type: "runtime.event", data: 1 });
    const first = writer.flush();
    writer.append({ invocationId: "root", type: "runtime.event", data: 2 });
    const second = writer.flush();
    release();
    await Promise.all([first, second]);
    expect(maximum).toBe(1);
    expect(committed).toEqual([1, 2]);
  });

  it("makes persistence failures fatal at the next append and terminal barrier", async () => {
    const failure = new Error("disk full");
    const commit = vi.fn(async () => {
      throw failure;
    });
    const writer = createExecutionEventWriter({ commit } as unknown as ExecutionStore, "execution");
    writer.append({ invocationId: "root", type: "runtime.event", data: 1 });
    await expect(writer.flush()).rejects.toBe(failure);
    expect(() => writer.append({ invocationId: "root", type: "runtime.event", data: 2 })).toThrow(
      failure,
    );
    await expect(writer.flush()).rejects.toBe(failure);
    expect(commit).toHaveBeenCalledOnce();
  });
});
