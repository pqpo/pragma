import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { RuntimeResolver } from "@pragma/core";
import { STORE_REVISION_EXPERT_REF } from "@pragma/built-in-agents";
import type { ContextStoreRevisionJob } from "@pragma/built-in-agents/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MissionRunner } from "../missions/mission-runner-contracts.ts";
import type { MissionStore } from "../missions/mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import { createDesktopStoreRevisionAgent } from "./store-revision-agent.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Desktop Store Revision Agent recovery", () => {
  it("recovers every orphan beyond the old 100-job limit and retires the legacy registry", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-store-revision-agent-"));
    temporaryDirectories.push(pragmaHome);
    const jobs = Array.from({ length: 101 }, (_, index) => revisionJob(index));
    const detachMission = vi.fn(async () => jobs[0]!);
    const restoreManagedRevisionStore = vi.fn(async () => ({}));
    const registryPath = join(
      pragmaHome,
      "state",
      "context-store-revisions",
      "agent-missions.json",
    );
    await mkdir(dirname(registryPath), { recursive: true });
    await writeFile(registryPath, '{"schemaVersion":"legacy"}\n');

    const agent = createDesktopStoreRevisionAgent({
      pragmaHome,
      revisions: {
        list: async () => jobs,
        attachMission: vi.fn(),
        detachMission,
      },
      missions: {
        get: async (id: string) => {
          const job = jobs.find((candidate) => candidate.missionId === id)!;
          return {
            executor: { kind: "expert", ref: STORE_REVISION_EXPERT_REF, name: "Store Revision" },
            contextMounts: [
              {
                kind: "context-store-draft",
                draftId: job.draftId,
                revisionJobId: job.id,
              },
            ],
          };
        },
        restoreManagedRevisionStore,
      } as unknown as MissionStore,
      runner: {} as MissionRunner,
      project: {} as PragmaProjectStore,
      runtimes: {} as RuntimeResolver,
    });

    await expect(agent.recoverOrphans()).resolves.toBe(101);
    expect(restoreManagedRevisionStore).toHaveBeenCalledTimes(101);
    expect(detachMission).toHaveBeenCalledTimes(101);
    await expect(readFile(registryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(
        join(
          pragmaHome,
          "state",
          "context-store-revisions",
          "migration-backups",
          "agent-missions.v1.json",
        ),
        "utf8",
      ),
    ).resolves.toContain("legacy");
  });
});

function revisionJob(index: number): ContextStoreRevisionJob {
  const suffix = String(index + 1).padStart(12, "0");
  return {
    schemaVersion: "pragma.context-store-revision-job/v2",
    id: `10000000-0000-4000-8000-${suffix}`,
    revision: 2,
    draftId: `20000000-0000-4000-8000-${suffix}`,
    missionId: `30000000-0000-4000-8000-${suffix}`,
    request: {
      schemaVersion: "pragma.context-store-revision-request/v1",
      storeId: "00000000-0000-4000-8000-000000000001",
      prompt: `Update ${index}`,
      source: "user",
    },
    state: "merged",
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:01:00.000Z",
  };
}
