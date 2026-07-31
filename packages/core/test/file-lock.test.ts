import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
    await expect(stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
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

  it("refreshes the lease while a long operation is active and cleans up after success", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-lock-lease-"));
    const lockDir = join(root, "execution", ".lock");
    const ownerPath = join(lockDir, "owner.json");
    let release!: () => void;
    let entered!: () => void;
    const operationEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const operation = withFileLock(
      lockDir,
      async () => {
        entered();
        await hold;
      },
      { staleMs: 60 },
    );
    await operationEntered;
    const initialLeaseMtime = (await stat(ownerPath)).mtimeMs;
    await new Promise<void>((resolve) => setTimeout(resolve, 90));

    expect((await stat(ownerPath)).mtimeMs).toBeGreaterThan(initialLeaseMtime);
    release();
    await operation;
    await expect(stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports active cross-process contention without reclaiming a live owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-lock-active-"));
    const lockDir = join(root, "execution", ".lock");
    const holder = spawnLockHolder(lockDir, 30);

    try {
      await waitForLine(holder, "LOCKED");
      await new Promise<void>((resolve) => setTimeout(resolve, 60));

      await expect(
        withFileLock(lockDir, async () => undefined, { timeoutMs: 40, staleMs: 30 }),
      ).rejects.toThrow("active Pragma file lock");

      const next = withFileLock(lockDir, async () => "continued", {
        timeoutMs: 1_000,
        staleMs: 30,
      });
      setTimeout(() => holder.stdin.end("release\n"), 30);
      await expect(next).resolves.toBe("continued");
      await waitForExit(holder);
      await expect(stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    }
  });

  it("immediately reclaims a lock whose owner process was forcibly terminated", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-lock-orphan-"));
    const lockDir = join(root, "execution", ".lock");
    const holder = spawnLockHolder(lockDir, 60_000);

    await waitForLine(holder, "LOCKED");
    holder.kill("SIGKILL");
    await waitForExit(holder);

    const startedAt = Date.now();
    await expect(
      withFileLock(lockDir, async () => "recovered", { timeoutMs: 1_000, staleMs: 60_000 }),
    ).resolves.toBe("recovered");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await expect(stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the stale timeout to recover a legacy lock without owner metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-lock-legacy-"));
    const lockDir = join(root, "execution", ".lock");
    await mkdir(lockDir, { recursive: true });
    const staleTime = new Date(Date.now() - 1_000);
    await utimes(lockDir, staleTime, staleTime);

    await expect(
      withFileLock(lockDir, async () => "recovered", { timeoutMs: 500, staleMs: 100 }),
    ).resolves.toBe("recovered");
    await expect(stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("identifies a fresh metadata-less lock as possibly orphaned", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-lock-unknown-"));
    const lockDir = join(root, "execution", ".lock");
    await mkdir(lockDir, { recursive: true });

    await expect(
      withFileLock(lockDir, async () => undefined, { timeoutMs: 20, staleMs: 1_000 }),
    ).rejects.toThrow("possibly orphaned Pragma file lock");
  });
});

function spawnLockHolder(lockDir: string, staleMs: number): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL("./fixtures/file-lock-holder.ts", import.meta.url)),
      lockDir,
      String(staleMs),
    ],
    { stdio: "pipe" },
  );
}

async function waitForLine(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.split("\n").includes(expected)) finish(resolve);
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = () => finish(() => reject(new Error(`Lock holder exited early: ${stderr}`)));
    const finish = (done: () => void) => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      done();
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
