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
});
