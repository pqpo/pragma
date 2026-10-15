import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFileMemoryExtractorProfileStore,
  createMemoryExtractionSessionStore,
  MEMORY_CURATOR_ID,
  MEMORY_CURATOR_REF,
} from "@pragma/memory";
import { MemoryEvidenceEnvelopeSchema, MissionExecutorRefSchema } from "@pragma/shared";
import { createStaticRuntimeResolver } from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMissionStore } from "@pragma/local-host";

import { createDesktopMemoryCurator } from "./memory-curator.ts";
import { createPragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { LocalHostMissionApplication } from "@pragma/local-host";
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
    "missing-receipt",
    "cancelled",
    "routed-model",
    "diagnostic-recovered",
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
      const runtimes = createStaticRuntimeResolver({
        runtimes: [runtime],
        defaultRuntimeId: "fake",
      });
      const run = vi.fn(async (id: string) => {
        const mission = await missions.get(id);
        if (scenario !== "cancelled" && scenario !== "missing-receipt") {
          const source = await curator.source({
            missionId: id,
            runtimes,
            workspace: root,
            pragmaHome: root,
          });
          const binding = await source.adapterHost!.resolveBinding("binding:pragma.memory-curator");
          const tools = (
            binding!.value as {
              contribution: {
                tools: import("@pragma/core").ExpertAgentManagedTool<
                  string,
                  import("@pragma/core").ExpertAgentToolCallResult
                >[];
              };
            }
          ).contribution.tools;
          const result = await tools
            .find((tool) => tool.name === "finish_extraction")!
            .call({ retain: false, reason: "low-value" }, undefined);
          expect(result.text).toContain("durable");
        }
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
      const getTerminalRuntimeOutputDiagnostic = vi.fn(async () => ({
        responseModel: "provider/actual-fallback-model",
      }));
      if (scenario === "diagnostic-recovered")
        getTerminalRuntimeOutputDiagnostic.mockRejectedValueOnce(
          new Error("transient diagnostic read"),
        );
      const application = {
        startRun: run,
        getChatPage,
        getInternalConversationSnapshot,
        getInternalContextWindow: async () => ({ missionId: "test", revision: 1 }),
        subscribeChat: () => () => undefined,
        getTerminalRuntimeOutputDiagnostic,
        getTerminalRuntimeFailure: async () => ({ message: "Cancelled", retryable: true }),
        delete: deleteMission,
        interrupt: vi.fn(async (id: string) => await missions.get(id)),
      } as unknown as LocalHostMissionApplication;
      const curator = createDesktopMemoryCurator({
        missions,
        application,
        project,
        pragmaHome: root,
        workspace: root,
        profiles: createFileMemoryExtractorProfileStore({ pragmaHome: root }),
        runtimes,
      });
      const extraction = curator.episodicExtractor.extract({
        schemaVersion: "pragma.memory-episodic-extraction-input/v2",
        jobId: "paid-job",
        executionId: "source",
        evidence: [
          MemoryEvidenceEnvelopeSchema.parse({
            schemaVersion: "pragma.memory-evidence/v1",
            messageId: "source-message",
            topic: "execution.message.appended",
            schemaRef: "pragma.memory.execution-message/v2",
            sourceRef: {
              type: "pragma.execution-event",
              id: "event",
              canonicalEventId: "canonical",
            },
            subjectRefs: [{ type: "pragma.execution", id: "source" }],
            occurredAt: "2026-10-14T00:00:00.000Z",
            visibility: { mode: "host-private" },
            sensitivity: "internal",
            bindings: [],
            policySnapshot: {
              capture: true,
              recall: true,
              learning: "local-candidates",
              appliedRevisions: [],
            },
            payload: { message: { role: "user", text: "Hello" } },
          }),
        ],
        omittedEvidence: { records: 0, bytes: 0, byTopic: {} },
      });
      if (scenario !== "cancelled" && scenario !== "missing-receipt") {
        const result = await extraction;
        expect(result.output).toMatchObject({ retain: false });
        if (scenario === "routed-model" || scenario === "diagnostic-recovered") {
          const receipt = await createMemoryExtractionSessionStore({ pragmaHome: root }).recover(
            "episodic",
            "paid-job",
            "source",
          );
          const missionId = run.mock.calls[0]![0];
          const finished = await missions.get(missionId);
          expect(result.provenance).toMatchObject({
            responseModel: "provider/actual-fallback-model",
            extractedAt: finished.execution!.finishedAt,
          });
          expect(receipt?.provenance).toEqual(result.provenance);
        }
      } else await expect(extraction).rejects.toMatchObject({ retryable: false });
      if (scenario === "diagnostic-recovered")
        expect(getTerminalRuntimeOutputDiagnostic).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenCalledTimes(1);
      expect(getChatPage).not.toHaveBeenCalled();
      if (scenario === "read-failed")
        expect(getInternalConversationSnapshot).toHaveBeenCalledTimes(4);
      if (scenario === "read-recovered")
        expect(getInternalConversationSnapshot).toHaveBeenCalledTimes(2);
      const [archived] = await curator.listRuns({ module: "episodic", jobId: "paid-job" });
      expect(archived).toBeDefined();
      if (
        scenario === "read-failed" ||
        scenario === "missing-receipt" ||
        scenario === "cancelled"
      ) {
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

  it.each(["before-start", "during-compilation"])(
    "blocks revoked inline tool Evidence %s",
    async (when) => {
      const root = await mkdtemp(join(tmpdir(), "pragma-curator-revoked-"));
      roots.push(root);
      let allowed = true;
      const missions = createMissionStore({ missionsPath: join(root, "missions") });
      const createMission = missions.create.bind(missions);
      const create = vi.spyOn(missions, "create").mockImplementation(async (input) => {
        expect(input.goal).not.toContain("private-tool-body");
        const mission = await createMission(input);
        if (when === "before-start") allowed = false;
        return mission;
      });
      const runtimes = createStaticRuntimeResolver({
        defaultRuntimeId: "fake",
        runtimes: [
          defineRuntimeTestDriver<never, { id: string }>({
            descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
            createSession: () => ({ id: "runtime" }),
            readSession: () => ({ runtimeSessionId: "runtime" }),
            startTurn: () => ({ outputText: "unused", runtimeSessionId: "runtime" }),
            mapEvent: () => ({ events: [] }),
          }),
        ],
      });
      const startRun = vi.fn(async (id: string) => {
        allowed = false;
        await curator.source({ missionId: id, runtimes, workspace: root, pragmaHome: root });
        throw new Error("Runtime must not start after consent is revoked.");
      });
      const application = {
        startRun,
        subscribeChat: () => () => undefined,
        getInternalConversationSnapshot: async () => {
          throw new Error("No execution transcript");
        },
        interrupt: vi.fn(),
        delete: vi.fn(),
      } as unknown as LocalHostMissionApplication;
      const curator = createDesktopMemoryCurator({
        missions,
        application,
        runtimes,
        pragmaHome: root,
        workspace: root,
        project: createPragmaProjectStore({ projectsPath: join(root, "projects") }),
        profiles: createFileMemoryExtractorProfileStore({ pragmaHome: root }),
      });
      await expect(
        curator.episodicExtractor.extract(
          {
            schemaVersion: "pragma.memory-episodic-extraction-input/v2",
            jobId: "revoked",
            executionId: "source",
            evidence: [
              MemoryEvidenceEnvelopeSchema.parse({
                schemaVersion: "pragma.memory-evidence/v1",
                messageId: "tool",
                topic: "execution.tool.content",
                schemaRef: "pragma.memory.tool-content/v1",
                sourceRef: {
                  type: "pragma.execution-event",
                  id: "event",
                  canonicalEventId: "canonical",
                },
                subjectRefs: [{ type: "pragma.execution", id: "source" }],
                occurredAt: "2026-10-14T00:00:00.000Z",
                visibility: { mode: "host-private" },
                sensitivity: "internal",
                bindings: [],
                policySnapshot: {
                  capture: true,
                  recall: true,
                  learning: "local-candidates",
                  appliedRevisions: [],
                },
                payload: {
                  toolCallId: "call",
                  toolName: "lookup",
                  phase: "completed",
                  completeness: "full",
                  text: "private-tool-body",
                  allowedModules: ["episodic"],
                },
              }),
            ],
            omittedEvidence: { records: 0, bytes: 0, byTopic: {} },
          },
          {
            assertAccess: async () => {
              if (!allowed) throw new Error("memory_curator_tool_content_denied");
            },
          },
        ),
      ).rejects.toThrow("tool_content_denied");
      expect(create).toHaveBeenCalledOnce();
      expect(startRun).toHaveBeenCalledTimes(when === "before-start" ? 0 : 1);
    },
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
