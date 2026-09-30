import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MissionBranchHistorySchema,
  type MissionChatEntry,
} from "../../../shared/contracts/index.ts";
import {
  createMissionBranchContext,
  prepareMissionBranchHistory,
} from "./mission-branch-context.ts";
import { createMissionStore } from "./mission-store.ts";
import { createNoopLoggerProvider } from "@pragma/core";
import { createMissionRunner } from "./mission-runner.ts";
import { createPragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { CapabilityCredentialStore } from "../capabilities/capability-credential-store.ts";

describe("createMissionBranchContext", () => {
  it("retains a standalone direct steer before the selected final reply in a persisted branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-steer-branch-"));
    try {
      const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
      await project.publish({ expectedRevision: 0, resources: [] });
      const store = createMissionStore({ missionsPath: join(root, "missions") });
      const source = await store.create({
        workspace: { path: root, basename: "workspace" },
        goal: "Initial prompt",
        project: { id: "studio", revision: 1 },
        executor: { kind: "expert", ref: "expert:2qgbztga4kz2qz51", name: "Expert" },
      });
      const timestamp = (offset: number) =>
        new Date(Date.parse(source.createdAt) + offset).toISOString();
      const steerId = "00000000-0000-4000-8000-000000000042";
      const steer = await store.appendUserMessage(source.id, {
        id: steerId,
        content: "Keep the change small",
        createdAt: timestamp(2_000),
      });
      if (steer.kind !== "user") throw new Error("Expected user timeline record");
      const executionId = "00000000-0000-4000-8000-000000000041";
      const settled = await store.updateExecution(source.id, {
        id: executionId,
        inputMessageId: source.initialMessageId,
        status: "succeeded",
        startedAt: timestamp(0),
        finishedAt: timestamp(3_000),
      });
      const initial = (await store.readTimelinePage(source.id, { limit: 10 })).turns[0]!;
      const working: MissionChatEntry = {
        id: "working",
        kind: "assistant",
        content: "Working",
        streaming: false,
        executionId,
        timelineSequence: initial.sequence,
        createdAt: timestamp(1_000),
      };
      const final: MissionChatEntry = {
        ...working,
        id: "final",
        content: "Done",
        finalAnswer: true,
        createdAt: timestamp(3_000),
      };
      const history = prepareMissionBranchHistory(
        [
          { ...initial.message, kind: "user", timelineSequence: initial.sequence },
          working,
          final,
          { ...steer, timelineSequence: steer.sequence },
        ],
        {
          hiddenEntryIds: [],
          deliveries: [
            {
              entryId: steerId,
              delivery: {
                requestedMode: "steer",
                effectiveMode: "steer",
                status: "succeeded",
              },
            },
          ],
        },
      );
      const branch = await store.createBranch({
        sourceMissionId: source.id,
        expectedSourceUpdatedAt: settled.updatedAt,
        expectedExecutionId: executionId,
        expectedMessageId: final.id,
        project: source.project,
        executor: source.executor,
        history: history.slice(0, history.findIndex((entry) => entry.id === final.id) + 1),
      });
      const inherited = await store.readBranchHistory(branch.id);
      expect(inherited?.entries.map((entry) => entry.id)).toEqual(
        [source.initialMessageId, working.id, steerId, final.id].map(
          (id) => `branch:${source.id}:${id}`,
        ),
      );
      const transcript = createMissionBranchContext(inherited!).find(
        (item) => item.id === "transcript.md",
      )!.content;
      expect(transcript.indexOf("Keep the change small")).toBeLessThan(transcript.indexOf("Done"));
      expect.soft(inherited?.entries.map((entry) => entry.timelineSequence)).toEqual([1, 1, 2, 2]);
      const recent = createMissionBranchContext(inherited!).find(
        (item) => item.id === "RECENT.md",
      )!.content;
      expect(recent).toContain("Keep the change small");
      expect(recent).toContain("Done");
      expect.soft(recent.indexOf("Keep the change small")).toBeLessThan(recent.indexOf("Done"));
      // Reopen storage and read the Branch's own page without a source session.
      const reopened = createMissionStore({ missionsPath: join(root, "missions") });
      const runner = createMissionRunner({
        missions: reopened,
        project,
        capabilityStore: {} as CapabilityStore,
        capabilityCredentials: {} as CapabilityCredentialStore,
        capabilitiesPath: join(root, "capabilities"),
        pragmaHome: join(root, "state"),
        runtimes: {
          getDefaultRuntimeId: async () => "unused",
          bind: async () => {
            throw new Error("Branch history must not require a Runtime");
          },
          resolve: async () => {
            throw new Error("Branch history must not require a Runtime");
          },
        },
        loggerProvider: createNoopLoggerProvider(),
      });
      const page = await runner.getChatPage({ id: branch.id, limit: 50 });
      expect
        .soft(page.entries.map((entry) => entry.id))
        .toEqual([
          source.initialMessageId,
          `branch:${source.id}:${working.id}`,
          steerId,
          `branch:${source.id}:${final.id}`,
        ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("preloads a bounded recent conversation without deriving a Mission goal", () => {
    const entries: MissionChatEntry[] = [
      {
        id: "old-user",
        kind: "user",
        content: `obsolete-first-message-${"x".repeat(5_000)}`,
        timelineSequence: 1,
        createdAt: "2026-08-25T00:00:00.000Z",
      },
      {
        id: "old-assistant",
        kind: "assistant",
        content: "Obsolete response",
        streaming: false,
        timelineSequence: 1,
        createdAt: "2026-08-25T00:01:00.000Z",
      },
      {
        id: "current-user",
        kind: "user",
        content: "Use the current mobile dashboard direction.",
        timelineSequence: 2,
        createdAt: "2026-08-25T00:02:00.000Z",
      },
      {
        id: "current-assistant",
        kind: "assistant",
        content: "The mobile dashboard direction is ready.",
        streaming: false,
        timelineSequence: 2,
        createdAt: "2026-08-25T00:03:00.000Z",
      },
    ];
    const context = createMissionBranchContext(
      MissionBranchHistorySchema.parse({
        schemaVersion: "pragma.mission-branch-history/v1",
        source: {
          sourceMissionId: "00000000-0000-4000-8000-000000000001",
          sourceProjectRevision: 1,
          cutoffMessageId: "current-assistant",
          createdAt: "2026-08-25T00:04:00.000Z",
        },
        entries,
      }),
    );

    const branch = context.find((item) => item.id === "BRANCH.md");
    const recent = context.find((item) => item.id === "RECENT.md");
    const transcript = context.find((item) => item.id === "transcript.md");

    expect(branch?.content).not.toContain("Mission goal");
    expect(branch?.content).toContain('namespace="branch-history" and id="transcript.md"');
    expect(recent?.metadata?.trigger).toBe("always_on");
    expect(recent?.metadata?.trustLevel).toBe("user");
    expect(recent?.content).toContain("Use the current mobile dashboard direction.");
    expect(recent?.content).toContain("The mobile dashboard direction is ready.");
    expect(recent?.content).not.toContain("obsolete-first-message");
    expect(Buffer.byteLength(recent?.content ?? "", "utf8")).toBeLessThanOrEqual(3 * 1_024);
    expect(transcript?.metadata?.trigger).toBe("manual");
    expect(transcript?.content).toContain("obsolete-first-message");
  });

  it("keeps short inherited messages as conversation rather than a derived objective", () => {
    const context = createMissionBranchContext(
      MissionBranchHistorySchema.parse({
        schemaVersion: "pragma.mission-branch-history/v1",
        source: {
          sourceMissionId: "00000000-0000-4000-8000-000000000002",
          sourceProjectRevision: 3,
          cutoffMessageId: "assistant",
          createdAt: "2026-08-25T01:00:00.000Z",
        },
        entries: [
          {
            id: "user",
            kind: "user",
            content: "This is a message, not a declared goal.",
            timelineSequence: 1,
            createdAt: "2026-08-25T00:58:00.000Z",
          },
          {
            id: "assistant",
            kind: "assistant",
            content: "Understood.",
            streaming: false,
            timelineSequence: 1,
            createdAt: "2026-08-25T00:59:00.000Z",
          },
        ],
      }),
    );

    expect(context.find((item) => item.id === "RECENT.md")?.content).toContain(
      "#### User\n\nThis is a message, not a declared goal.",
    );
  });
});
