import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { LocalHostMissionApplication, MissionStore } from "@pragma/local-host";
import { STORE_REVISION_EXPERT_REF } from "@pragma/built-in-agents";
import { createLegacyMemoryRevisionObserver } from "./legacy-memory-revision-observer.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it.each(["running", "succeeded", "failed"])(
  "only observes registered historical %s work",
  async (status) => {
    const root = await mkdtemp(join(tmpdir(), "pragma-legacy-observer-"));
    roots.push(root);
    const registry = join(root, "state", "memory-revision-planning");
    await mkdir(registry, { recursive: true });
    const id = randomUUID();
    await writeFile(join(registry, id), "");
    const startRun = vi.fn(),
      remove = vi.fn(async () => undefined),
      continuation = vi.fn();
    const observer = createLegacyMemoryRevisionObserver({
      pragmaHome: root,
      missions: {
        get: async () => ({
          id,
          executor: { ref: STORE_REVISION_EXPERT_REF },
          origin: { type: "system-memory", jobId: `knowledge-plan:${"a".repeat(64)}` },
          execution: { id: "execution-1", status },
        }),
      } as unknown as MissionStore,
      application: {
        startRun,
        delete: remove,
        continueInternalMemoryMission: continuation,
        getInternalConversationSnapshot: async () => ({
          entries: [
            { kind: "assistant", executionId: "earlier", content: "invalid" },
            {
              kind: "assistant",
              executionId: "execution-1",
              content: '{"action":"skip","reason":"No delta"}',
            },
          ],
        }),
      } as unknown as LocalHostMissionApplication,
    });
    expect(await observer.knowledge.hasPending("a".repeat(64))).toBe(true);
    const observed = observer.knowledge.plan({
      sourceDigest: "a".repeat(64),
      signal: new AbortController().signal,
    } as Parameters<typeof observer.knowledge.plan>[0]);
    if (status === "succeeded") expect(await observed).toMatchObject({ action: "skip" });
    else
      await expect(observed).rejects.toThrow(
        status === "running"
          ? "memory_revision_observation_pending"
          : "memory_legacy_revision_failed",
      );
    expect(startRun).not.toHaveBeenCalled();
    expect(continuation).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    if (status === "running")
      expect(await observer.knowledge.prepareDirectRetry("a".repeat(64))).toBe(false);
    else {
      expect(await observer.knowledge.prepareDirectRetry("a".repeat(64))).toBe(true);
      expect(await observer.knowledge.hasPending("a".repeat(64))).toBe(false);
      expect(remove).toHaveBeenCalledOnce();
    }
  },
);
