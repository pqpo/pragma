import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { MissionChatEntry } from "../../../shared/contracts/index.ts";
import {
  MISSION_EXECUTION_PROJECTION_MAX_BYTES,
  MISSION_EXECUTION_PROJECTION_MAX_CONTENT_LENGTH,
  MISSION_EXECUTION_PROJECTION_MAX_ENTRIES,
  migrateLegacyMissionExecutionProjection,
  readMissionExecutionProjection,
  writeMissionExecutionProjection,
  type MissionExecutionProjectionWriteMetrics,
} from "./mission-execution-projection.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("mission execution projection", () => {
  it("keeps Unicode code-point truncation and exact projection counters", async () => {
    const { path } = await temporaryProjectionPath();
    const executionId = "execution-unicode";
    const exactBoundary = `${"中".repeat(MISSION_EXECUTION_PROJECTION_MAX_CONTENT_LENGTH - 1)}😀`;
    const overBoundary = `${exactBoundary}🚀`;

    await writeMissionExecutionProjection(path, executionId, [
      assistantEntry("exact", executionId, exactBoundary),
      assistantEntry("over", executionId, overBoundary),
    ]);

    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    const header = JSON.parse(lines[0]!) as {
      omittedEntries: number;
      truncatedFields: number;
    };
    const exactRecord = JSON.parse(lines[1]!) as {
      entry: { content: string };
      truncation?: unknown;
    };
    const overRecord = JSON.parse(lines[2]!) as {
      entry: { content: string };
      truncation: { fields: Array<{ field: string; originalLength: number }> };
    };

    expect(header).toMatchObject({ omittedEntries: 0, truncatedFields: 1 });
    expect(exactRecord.entry.content).toBe(exactBoundary);
    expect(exactRecord.truncation).toBeUndefined();
    expect(overRecord.entry.content).toBe(exactBoundary);
    expect(overRecord.entry.content.endsWith("😀")).toBe(true);
    expect(overRecord.truncation.fields).toEqual([
      {
        field: "content",
        originalLength: MISSION_EXECUTION_PROJECTION_MAX_CONTENT_LENGTH + 1,
      },
    ]);
  });

  it("preserves every bounded field rule across entry kinds", async () => {
    const { path } = await temporaryProjectionPath();
    const executionId = "execution-field-bounds";
    const createdAt = "2026-09-18T00:00:00.000Z";
    const entries: MissionChatEntry[] = [
      {
        id: "tool",
        executionId,
        kind: "tool",
        toolCallId: "call",
        toolName: "read_file",
        status: "failed",
        inputPreview: "i".repeat(801),
        outputPreview: "o".repeat(801),
        error: "错".repeat(4_001),
        createdAt,
      },
      {
        id: "agent",
        executionId,
        kind: "agent_activity",
        commandId: "command",
        action: "spawn",
        phase: "failed",
        targetSessionIds: [],
        label: "l".repeat(500),
        error: "😀".repeat(4_001),
        createdAt,
      },
      {
        id: "context",
        executionId,
        kind: "context_operation",
        operationId: "compaction",
        operation: "compaction",
        trigger: "manual",
        runtimeId: "fake",
        status: "failed",
        error: "e".repeat(4_001),
        createdAt,
      },
    ];

    await writeMissionExecutionProjection(path, executionId, entries);

    const [headerLine, ...recordLines] = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(JSON.parse(headerLine!) as unknown).toMatchObject({ truncatedFields: 5 });
    const records = recordLines.map(
      (line) =>
        JSON.parse(line) as {
          entry: MissionChatEntry;
          truncation?: { fields: Array<{ field: string; originalLength: number }> };
        },
    );
    expect(records[0]?.entry).toMatchObject({
      id: "tool",
      inputPreview: "i".repeat(800),
      outputPreview: "o".repeat(800),
      error: "错".repeat(4_000),
    });
    expect(records[0]?.truncation?.fields).toEqual([
      { field: "inputPreview", originalLength: 801 },
      { field: "outputPreview", originalLength: 801 },
      { field: "error", originalLength: 4_001 },
    ]);
    expect(records[1]?.entry).toMatchObject({
      id: "agent",
      label: "l".repeat(500),
      error: "😀".repeat(4_000),
    });
    expect(records[1]?.truncation?.fields).toEqual([{ field: "error", originalLength: 4_001 }]);
    expect(records[2]?.entry).toMatchObject({ id: "context", error: "e".repeat(4_000) });
    expect(records[2]?.truncation?.fields).toEqual([{ field: "error", originalLength: 4_001 }]);
  });

  it("validates discarded history while only bounding the newest candidates", async () => {
    const { directory, path } = await temporaryProjectionPath();
    const executionId = "execution-invalid-history";
    const durableEntry = assistantEntry("durable", executionId, "keep me");
    await writeMissionExecutionProjection(path, executionId, [durableEntry]);

    const entries = Array.from(
      { length: MISSION_EXECUTION_PROJECTION_MAX_ENTRIES + 1 },
      (_, index) => assistantEntry(`entry-${index}`, executionId, "valid"),
    );
    entries[0] = assistantEntry("invalid-discarded", executionId, "x".repeat(200_001));

    await expect(writeMissionExecutionProjection(path, executionId, entries)).rejects.toThrow();
    await expect(readMissionExecutionProjection(path, executionId)).resolves.toEqual([
      durableEntry,
    ]);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("yields during large builds and reports bounded synchronous slices", async () => {
    const { path } = await temporaryProjectionPath();
    const executionId = "execution-budget";
    const entries = Array.from({ length: 5_000 }, (_, index) =>
      assistantEntry(`entry-${index}`, executionId, `消息 ${index} 😀`),
    );
    let eventLoopAdvanced = false;
    let metrics: MissionExecutionProjectionWriteMetrics | undefined;
    setImmediate(() => {
      eventLoopAdvanced = true;
    });

    await writeMissionExecutionProjection(path, executionId, entries, undefined, undefined, {
      synchronousBuildBudgetMs: 0.1,
      onMetrics(value) {
        metrics = value;
      },
    });

    expect(eventLoopAdvanced).toBe(true);
    expect(metrics).toMatchObject({
      inputEntries: 5_000,
      candidateEntries: MISSION_EXECUTION_PROJECTION_MAX_ENTRIES,
      retainedEntries: MISSION_EXECUTION_PROJECTION_MAX_ENTRIES,
    });
    expect(metrics!.yieldCount).toBeGreaterThan(0);
    expect(metrics!.maximumSynchronousSliceMs).toBeGreaterThan(0);
    expect(Number.isFinite(metrics!.maximumSynchronousSliceMs)).toBe(true);
    expect(metrics!.encodedBytes).toBeLessThanOrEqual(MISSION_EXECUTION_PROJECTION_MAX_BYTES);
  });

  it("serializes writes to one path in invocation order", async () => {
    const { path } = await temporaryProjectionPath();
    const executionId = "execution-concurrent";
    const longContent = "concurrent ".repeat(200);
    const older = Array.from({ length: 1_500 }, (_, index) =>
      assistantEntry(`older-${index}`, executionId, longContent),
    );
    const newer = [assistantEntry("newer", executionId, "latest answer")];
    let newerMetrics: MissionExecutionProjectionWriteMetrics | undefined;

    await Promise.all([
      writeMissionExecutionProjection(path, executionId, older),
      writeMissionExecutionProjection(path, executionId, newer, undefined, undefined, {
        onMetrics(value) {
          newerMetrics = value;
        },
      }),
    ]);

    await expect(readMissionExecutionProjection(path, executionId)).resolves.toEqual(newer);
    expect(newerMetrics!.queueWaitMs).toBeGreaterThan(0);
  });

  it("returns the complete validated legacy input while writing its bounded projection", async () => {
    const { path } = await temporaryProjectionPath();
    const executionId = "execution-legacy";
    const entries = Array.from(
      { length: MISSION_EXECUTION_PROJECTION_MAX_ENTRIES + 2 },
      (_, index) => assistantEntry(`legacy-${index}`, executionId, `legacy ${index}`),
    );
    let eventLoopAdvanced = false;
    setImmediate(() => {
      eventLoopAdvanced = true;
    });

    const validated = await migrateLegacyMissionExecutionProjection(path, executionId, entries);

    expect(eventLoopAdvanced).toBe(true);
    expect(validated).toEqual(entries);
    const persisted = await readMissionExecutionProjection(path, executionId);
    expect(persisted).toHaveLength(MISSION_EXECUTION_PROJECTION_MAX_ENTRIES);
    expect(persisted?.[0]?.id).toBe("legacy-2");
  });

  it("rejects an invalid legacy entry even when it would be omitted", async () => {
    const { directory, path } = await temporaryProjectionPath();
    const executionId = "execution-invalid-legacy";
    const entries = Array.from(
      { length: MISSION_EXECUTION_PROJECTION_MAX_ENTRIES + 1 },
      (_, index) => assistantEntry(`legacy-${index}`, executionId, "valid"),
    );
    entries[0] = assistantEntry("invalid", executionId, "x".repeat(200_001));

    await expect(
      migrateLegacyMissionExecutionProjection(path, executionId, entries),
    ).rejects.toThrow();
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("removes a temporary projection when the atomic rename fails", async () => {
    const { directory, path } = await temporaryProjectionPath();
    await mkdir(path);

    await expect(
      writeMissionExecutionProjection(path, "execution-rename-failure", [
        assistantEntry("entry", "execution-rename-failure", "answer"),
      ]),
    ).rejects.toThrow();

    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(await readdir(path)).toEqual([]);
  });
});

function assistantEntry(id: string, executionId: string, content: string): MissionChatEntry {
  return {
    id,
    executionId,
    kind: "assistant",
    content,
    streaming: false,
    createdAt: "2026-09-18T00:00:00.000Z",
  };
}

async function temporaryProjectionPath(): Promise<{
  readonly directory: string;
  readonly path: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "pragma-mission-projection-"));
  temporaryPaths.push(directory);
  return { directory, path: join(directory, "projection.jsonl") };
}
