import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { withFileLock } from "../src/storage/file-lock.ts";

describe("withFileLock", () => {
  it("serializes heavily contended lock directory creation and removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-lock-"));
    const lockDir = join(root, "execution", ".lock");
    let active = 0;
    let maximumActive = 0;
    let completed = 0;

    await Promise.all(
      Array.from(
        { length: 50 },
        async () =>
          await withFileLock(lockDir, async () => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await new Promise<void>((resolve) => setTimeout(resolve, 2));
            completed += 1;
            active -= 1;
          }),
      ),
    );

    expect(maximumActive).toBe(1);
    expect(completed).toBe(50);
  });

  it("serves in-process contenders in arrival order", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-lock-fifo-"));
    const lockDir = join(root, "execution", ".lock");
    const order: number[] = [];
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withFileLock(lockDir, async () => {
      order.push(1);
      markFirstEntered();
      await holdFirst;
    });
    await firstEntered;
    const second = withFileLock(lockDir, async () => {
      order.push(2);
    });
    const third = withFileLock(lockDir, async () => {
      order.push(3);
    });

    releaseFirst();
    await Promise.all([first, second, third]);

    expect(order).toEqual([1, 2, 3]);
  });

  it("hands the local lock to the next waiter after an operation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-lock-failure-"));
    const lockDir = join(root, "execution", ".lock");
    const failed = withFileLock(lockDir, async () => {
      throw new Error("expected failure");
    });
    const next = withFileLock(lockDir, async () => "continued");

    await expect(failed).rejects.toThrow("expected failure");
    await expect(next).resolves.toBe("continued");
  });

  it("removes a timed-out local waiter without blocking the queue", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-lock-timeout-"));
    const lockDir = join(root, "execution", ".lock");
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withFileLock(lockDir, async () => {
      markFirstEntered();
      await holdFirst;
    });
    await firstEntered;

    await expect(withFileLock(lockDir, async () => undefined, { timeoutMs: 20 })).rejects.toThrow(
      "in-process file lock",
    );
    const next = withFileLock(lockDir, async () => "continued");
    releaseFirst();

    await first;
    await expect(next).resolves.toBe("continued");
  });
});
