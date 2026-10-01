import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFileMemoryExtractorProfileStore,
  MEMORY_CURATOR_ID,
  MEMORY_CURATOR_REF,
} from "@pragma/memory";
import { MissionExecutorRefSchema } from "@pragma/shared";
import { createStaticRuntimeResolver } from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMissionStore } from "../missions/mission-store.ts";

import { createDesktopMemoryCurator } from "./memory-curator.ts";
import { createPragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { MissionRunner } from "../missions/mission-runner.ts";
import { MissionConversationSnapshotSchema } from "../../../shared/contracts/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Desktop Memory Curator", () => {
  it.each([
    "success",
    "read-recovered",
    "read-failed",
    "missing-output",
    "invalid-json",
    "cancelled",
  ] as const)(
    "uses internal transcripts and protects the paid execution when %s",
    async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), "pragma-curator-result-"));
      roots.push(root);
      const missions = createMissionStore({ missionsPath: join(root, "missions") });
      const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
      const runtime = defineRuntimeTestDriver<never, { id: string }>({
        descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
        createSession: () => ({ id: "runtime" }),
        readSession: () => ({ runtimeSessionId: "runtime" }),
        startTurn: () => ({ outputText: "unused", runtimeSessionId: "runtime" }),
        mapEvent: () => ({ events: [] }),
      });
      const run = vi.fn(async (id: string) => {
        const mission = await missions.get(id);
        return await missions.updateExecution(id, {
          id: randomUUID(),
          inputMessageId: mission.initialMessageId,
          status: scenario === "cancelled" ? "cancelled" : "succeeded",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        });
      });
      let missingOutput = scenario === "missing-output";
      const readSnapshot = async (id: string) =>
        MissionConversationSnapshotSchema.parse({
          missionId: id,
          revision: 1,
          entries: missingOutput
            ? []
            : [
                {
                  id: "assistant",
                  kind: "assistant",
                  content:
                    scenario === "invalid-json"
                      ? "broken JSON"
                      : '{"retain":false,"reason":"low-value"}',
                  streaming: false,
                  createdAt: new Date().toISOString(),
                },
              ],
          page: { oldestSequence: 1, newestSequence: 1 },
          pendingInteractions: [],
          queue: { state: "idle", pendingCount: 0, supportsSteer: false, items: [] },
        });
      const getInternalConversationSnapshot = vi.fn(readSnapshot);
      if (scenario === "read-recovered")
        getInternalConversationSnapshot.mockRejectedValueOnce(new Error("transient local read"));
      if (scenario === "read-failed")
        getInternalConversationSnapshot.mockRejectedValue(
          Object.assign(new Error("local storage read failed"), { retryable: true }),
        );
      const getChatPage = vi.fn(() => {
        throw new Error("User surface must not read system Missions.");
      });
      const deleteMission = vi.fn(async (id: string) => {
        await missions.get(id);
      });
      const runner = {
        run,
        getChatPage,
        getInternalConversationSnapshot,
        subscribeChat: () => () => undefined,
        getTerminalRuntimeOutputDiagnostic: async () => undefined,
        getTerminalRuntimeFailure: async () => ({ message: "Cancelled", retryable: true }),
        delete: deleteMission,
        interrupt: vi.fn(async (id: string) => await missions.get(id)),
      } as unknown as MissionRunner;
      const curator = createDesktopMemoryCurator({
        missions,
        runner,
        project,
        pragmaHome: root,
        workspace: root,
        profiles: createFileMemoryExtractorProfileStore({ pragmaHome: root }),
        runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
      });
      const extraction = curator.episodicExtractor.extract({
        schemaVersion: "pragma.memory-episodic-extraction-input/v2",
        jobId: "paid-job",
        executionId: "source",
        evidence: [],
        omittedEvidence: { records: 0, bytes: 0, byTopic: {} },
      });
      if (scenario === "success" || scenario === "read-recovered")
        await expect(extraction).resolves.toMatchObject({ output: { retain: false } });
      else
        await expect(extraction).rejects.toMatchObject({ retryable: scenario === "invalid-json" });
      expect(run).toHaveBeenCalledTimes(1);
      expect(getChatPage).not.toHaveBeenCalled();
      if (scenario === "read-failed" || scenario === "missing-output")
        expect(getInternalConversationSnapshot).toHaveBeenCalledTimes(4);
      if (scenario === "read-recovered")
        expect(getInternalConversationSnapshot).toHaveBeenCalledTimes(2);
      const [archived] = await curator.listRuns({ module: "episodic", jobId: "paid-job" });
      expect(archived).toBeDefined();
      if (scenario === "read-failed" || scenario === "missing-output" || scenario === "cancelled") {
        expect(deleteMission).not.toHaveBeenCalled();
        await expect(curator.recoverOrphans()).resolves.toBe(0);
        missingOutput = false;
        getInternalConversationSnapshot.mockImplementation(readSnapshot);
        expect((await curator.getRunChat(archived!.runId))?.entries).toHaveLength(1);
        expect(run).toHaveBeenCalledTimes(1);
        expect((await missions.get(archived!.missionId)).execution?.status).toBe(
          scenario === "cancelled" ? "cancelled" : "succeeded",
        );
      } else expect(deleteMission).toHaveBeenCalledTimes(1);
    },
    30_000,
  );

  it("crosses the real Mission persistence boundary with a valid hidden system identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-memory-curator-"));
    roots.push(root);
    const missions = createMissionStore({ missionsPath: join(root, "missions") });

    expect(MissionExecutorRefSchema.parse(MEMORY_CURATOR_REF)).toBe(`expert:${MEMORY_CURATOR_ID}`);
    const mission = await missions.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Extract a durable episodic memory from supplied evidence.",
      title: "Memory extraction test",
      project: { id: "studio", revision: 1 },
      executor: { kind: "expert", ref: MEMORY_CURATOR_REF, name: "Memory Curator" },
      origin: { type: "system-memory", jobId: "episodic-test" },
    });

    await expect(missions.get(mission.id)).resolves.toMatchObject({
      executor: { ref: MEMORY_CURATOR_REF },
      origin: { type: "system-memory", jobId: "episodic-test" },
    });
    await expect(missions.list()).resolves.toEqual([]);
  });
});
