import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ContextSystem, InMemoryContextStore, createContextTools } from "@pragma/core";
import { preview } from "../../src/missions/mission-chat-projection-common.ts";

import type { MissionChatEntry } from "@pragma/shared";
import {
  MISSION_EXECUTION_PROJECTION_MAX_BYTES,
  MISSION_EXECUTION_PROJECTION_MAX_CONTENT_LENGTH,
  MISSION_EXECUTION_PROJECTION_MAX_ENTRIES,
  migrateLegacyMissionExecutionProjection,
  readMissionExecutionProjection,
  readMissionExecutionProjectionPage,
  MISSION_EXECUTION_PROJECTION_ORDERING_VERSION,
  writeMissionExecutionProjection,
  type MissionExecutionProjectionWriteMetrics,
} from "../../src/missions/repository/mission-execution-projection.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("mission execution projection", () => {
  it("preserves emoji at the preview boundary without archiving a broken surrogate", async () => {
    const value = preview(`${"x".repeat(798)}😀suffix`);
    expect(value).toBe(`${"x".repeat(798)}…`);
    const { path } = await temporaryProjectionPath();
    await writeMissionExecutionProjection(path, "unicode-preview", [
      {
        id: "unicode-tool",
        executionId: "unicode-preview",
        createdAt: "2026-10-08T09:50:00.000Z",
        kind: "tool",
        toolCallId: "unicode-call",
        toolName: "context",
        status: "succeeded",
        outputPreview: value,
      },
    ]);
    const page = await readMissionExecutionProjectionPage(path, "unicode-preview", { limit: 10 });
    expect(page).toMatchObject({ truncatedFields: 0, entries: [{ outputPreview: value }] });
  });
  it("archives compact Context tool results without duplicate payloads or false truncation", async () => {
    const system = new ContextSystem();
    system.register({
      namespace: "mission-board",
      store: new InMemoryContextStore({
        context: [
          {
            id: "GUIDE.md",
            content: "guide",
            metadata: {
              description: "Mission Board usage guide and whiteboard conventions.",
              trigger: "always_on",
              priority: "critical",
            },
          },
        ],
      }),
    });
    system.register({ namespace: "mission-board-private", store: new InMemoryContextStore() });
    const tools = createContextTools({
      listContext: (input) => system.index(input),
      readContext: (input) => system.read(input),
      searchContext: (input) => system.search(input),
      addContext: (input) => system.add(input),
      editContext: (input) => system.edit(input),
      deleteContext: (input) => system.delete(input),
    });
    const call = async (name: string, args: unknown) =>
      await tools.find((tool) => tool.name === name)!.call(args, undefined);
    const identity = { namespace: "mission-board-private", id: "tool-test/roundtrip.md" };
    await call("add_expert_context", {
      ...identity,
      content: "# Context tool test\n\nalpha: 111\nbeta: 222\nTest content\ngamma: 333\n",
      description: "Temporary roundtrip test item for Context store tooling.",
      trigger: "manual",
      priority: "low",
    });
    const results = [
      await call("list_expert_context", { namespace: "mission-board", limit: 20 }),
      await call("list_expert_context", { namespace: identity.namespace, limit: 20 }),
      await call("read_expert_context", { ...identity, start: 20, offset: 15 }),
      await call("edit_expert_context", {
        ...identity,
        mode: "search_replace",
        search: "beta: 222",
        replace: "beta: 222-edited",
      }),
      await call("read_expert_context", { ...identity, start: 20, offset: 30 }),
    ];
    await call("edit_expert_context", {
      ...identity,
      mode: "append",
      content: "delta: 444 (appended)",
      separator: "blank_line",
    });
    results.push(await call("read_expert_context", { ...identity, start: 65, offset: 25 }));
    expect(results[0]!.text).toContain("revision:");
    expect(results[0]!.text).not.toContain("etag:");
    expect(JSON.parse(results[3]!.text)).not.toHaveProperty("sha256");
    expect(JSON.parse(results[3]!.text)).not.toHaveProperty("etag");
    const { path } = await temporaryProjectionPath();
    const executionId = "compact-context";
    const entries: MissionChatEntry[] = results.map((result, index) => {
      expect(result.isError).not.toBe(true);
      expect(result.details).toBeUndefined();
      // Match the runtime's text-result envelope, including JSON escaping.
      const serialized = JSON.stringify({
        content: [{ type: "text", text: result.text }],
        isError: false,
      });
      expect(serialized.length).toBeLessThanOrEqual(800);
      return {
        id: `tool-${index}`,
        executionId,
        createdAt: "2026-10-08T09:50:00.000Z",
        kind: "tool",
        toolCallId: `call-${index}`,
        toolName: "context",
        status: "succeeded",
        outputPreview: preview(serialized),
      };
    });
    entries.push({
      ...entries[0]!,
      id: "long-preview",
      toolCallId: "long-call",
      outputPreview: preview("x".repeat(2_000)),
    });
    await writeMissionExecutionProjection(path, executionId, entries);
    const page = await readMissionExecutionProjectionPage(path, executionId, { limit: 20 });
    expect(page).toMatchObject({ omittedEntries: 0, truncatedFields: 0 });
    expect(page?.entries).toEqual(entries);
  });
  it("reads the actual v3 fixture without rewriting it and rejects future ordering versions", async () => {
    const { path } = await temporaryProjectionPath();
    const executionId = "20000000-0000-4000-8000-000000000325";
    await copyFile(
      new URL("./fixtures/mission-execution-projection-v3-rejected-attempt.jsonl", import.meta.url),
      path,
    );
    const before = await readFile(path, "utf8");
    expect(
      await readMissionExecutionProjectionPage(path, executionId, { limit: 10 }),
    ).toMatchObject({
      orderingVersion: 3,
      entries: [{ id: "rejected-attempt", finalAnswer: true }],
    });
    expect(await readFile(path, "utf8")).toBe(before);
    const lines = before.trimEnd().split("\n");
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    header["orderingVersion"] = MISSION_EXECUTION_PROJECTION_ORDERING_VERSION + 1;
    await writeFile(path, [JSON.stringify(header), ...lines.slice(1)].join("\n") + "\n");
    await expect(
      readMissionExecutionProjectionPage(path, executionId, { limit: 10 }),
    ).rejects.toThrow();
  });
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
