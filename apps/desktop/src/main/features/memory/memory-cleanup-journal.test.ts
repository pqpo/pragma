import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMemoryCleanupJournal } from "./memory-cleanup-journal.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Memory cleanup journal", () => {
  it("replays only unfinished Mission deletion steps after a crash", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-memory-cleanup-"));
    roots.push(pragmaHome);
    const forgetCorrelation = vi.fn(async () => ({ deletedEvents: 1 }));
    let failEpisodic = true;
    const deleteEpisodic = vi.fn(async () => {
      if (failEpisodic) throw new Error("simulated-cleanup-crash");
    });
    const deleteSemantic = vi.fn(async () => undefined);
    const journal = createMemoryCleanupJournal({
      pragmaHome,
      feed: { forgetCorrelation },
      episodic: { deleteExecutionState: deleteEpisodic },
      semantic: { deleteExecutionState: deleteSemantic },
      now: () => new Date("2026-08-04T00:00:00.000Z"),
    });

    await expect(journal.cleanup(["execution-b", "execution-a"])).rejects.toThrow(
      "simulated-cleanup-crash",
    );
    expect(forgetCorrelation).toHaveBeenCalledTimes(2);
    expect(deleteSemantic).not.toHaveBeenCalled();

    failEpisodic = false;
    await expect(journal.recover()).resolves.toBe(1);
    expect(forgetCorrelation).toHaveBeenCalledTimes(2);
    expect(deleteEpisodic).toHaveBeenCalledTimes(2);
    expect(deleteSemantic).toHaveBeenCalledOnce();
    await expect(readdir(join(pragmaHome, "state", "memory", "cleanup-journal"))).resolves.toEqual(
      [],
    );
  });
});
