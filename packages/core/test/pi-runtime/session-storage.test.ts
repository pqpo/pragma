import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { watchRuntimeSessionDir } from "../../src/pi-runtime/session-storage.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("watchRuntimeSessionDir", () => {
  it("calls the sync callback when the runtime session directory changes", async () => {
    const sessionDir = await createTempDir();
    const callback = vi.fn();
    const watcher = watchRuntimeSessionDir({
      context: {
        agentId: "agent-1",
        context: {
          source: {
            type: "user",
            id: "user-1",
          },
          attributes: {
            tenantId: "tenant-1",
          },
        },
        runtime: {
          id: "cloud-pi-agent",
          kind: "cloud-pi-agent",
          displayName: "Cloud PI Agent",
        },
        runtimeSession: {
          type: "cloud-pi-agent",
          id: "session-1",
        },
        sessionDir,
        systemSessionId: "system-session-1",
        workspace: "/workspace",
      },
      callback,
      debounceMs: 5,
    });

    try {
      await writeFile(join(sessionDir, "session-1.jsonl"), "{}\n", "utf8");
      await waitFor(() => callback.mock.calls.length > 0);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "agent-1",
          runtimeSession: {
            type: "cloud-pi-agent",
            id: "session-1",
          },
          sessionDir,
        }),
      );
    } finally {
      watcher.close();
    }
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "pragma-session-storage-"));
  tempDirs.push(dir);
  return dir;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1_000) {
      throw new Error("Timed out waiting for condition.");
    }
    await sleep(20);
  }
}
