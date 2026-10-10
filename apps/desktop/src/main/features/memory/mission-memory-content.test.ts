import { readFile } from "node:fs/promises";
import { SemanticFactSchema } from "@pragma/shared";
import { projectionHash, memoryProjectionFields, type MemoryRecallActivity } from "@pragma/memory";
import { describe, expect, it, vi } from "vitest";
import {
  buildMissionRecallPage,
  nameMissionAttention,
  readMissionAttentionContent,
} from "./mission-memory-content.ts";

const fact = SemanticFactSchema.parse(
  JSON.parse(
    await readFile(
      new URL(
        "../../../../../../packages/memory/test/fixtures/retrieval/semantic-record.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
const source = {
  module: "semantic" as const,
  record: { ...fact, statement: "偏好简洁的中文回答 📝", revision: 2 },
};
const text = memoryProjectionFields(source)[0]!.text;
const snippet = Array.from(text).slice(0, 22).join("");
const context = {
  contextId: "expert-context",
  version: 1,
  entries: [
    {
      module: "semantic" as const,
      memoryId: fact.id,
      revision: 2,
      decisionMode: "provider" as const,
      selectedPaths: [{ fieldPath: "fact", start: 0, end: 22, textHash: projectionHash(snippet) }],
    },
  ],
};
const recall = (id: string, occurredAt = "2026-10-10T09:00:00.000Z"): MemoryRecallActivity => ({
  schemaVersion: "pragma.memory-recall-activity/v1",
  id,
  executionId: "execution",
  invocationId: id,
  operation: "read",
  target: `semantic/items/${fact.id}.md`,
  outcome: "allowed",
  reason: "read",
  occurredAt,
  resultRefs: [{ id: `semantic/items/${fact.id}.md`, revision: "1" }],
});

describe("Mission memory content", () => {
  it("uses only current authorized sources and validates Unicode snippet hashes and revisions", async () => {
    const read = vi.fn(async () => source);
    expect((await nameMissionAttention(read, [context]))[0]?.entries[0]?.title).toBe(
      source.record.statement,
    );
    expect((await readMissionAttentionContent(read, context)).entries[0]?.content).toBe(snippet);
    expect((await readMissionAttentionContent(async () => undefined, context)).entries).toEqual([]);
    expect(
      (
        await readMissionAttentionContent(
          async () => ({ ...source, record: { ...source.record, revision: 3 } }),
          context,
        )
      ).entries,
    ).toEqual([]);
    expect(
      (
        await readMissionAttentionContent(read, {
          ...context,
          entries: [
            {
              ...context.entries[0]!,
              selectedPaths: [{ ...context.entries[0]!.selectedPaths[0]!, textHash: "wrong" }],
            },
          ],
        })
      ).entries,
    ).toEqual([]);
    expect(
      (
        await readMissionAttentionContent(
          async () => ({ ...source, record: { ...source.record, sensitivity: "restricted" } }),
          context,
        )
      ).entries,
    ).toEqual([]);
  });

  it("hides titles for revoked or expired sources and keeps historical versions separate", async () => {
    const page = await buildMissionRecallPage(async () => source, [recall("a")], undefined, 30);
    expect(page.records[0]?.sources[0]).toMatchObject({
      title: source.record.statement,
      revision: "1",
      currentRevision: "2",
      available: true,
    });
    expect(page.records[0]?.sources[0]).not.toHaveProperty("content");
    const unavailable = await buildMissionRecallPage(
      async () => undefined,
      [recall("a")],
      undefined,
      30,
    );
    expect(unavailable.records[0]?.sources[0]).toEqual({
      id: `semantic/items/${fact.id}.md`,
      revision: "1",
      available: false,
    });
    const denied = await buildMissionRecallPage(
      async () => source,
      [{ ...recall("a"), outcome: "denied" }],
      undefined,
      30,
    );
    expect(denied.records[0]?.sources[0]?.available).toBe(false);
    expect(denied.records[0]?.sources[0]).not.toHaveProperty("title");
  });

  it("paginates without repeats or omissions when new records arrive or the boundary is removed", async () => {
    const initial = [recall("d"), recall("c"), recall("b"), recall("a")];
    const first = await buildMissionRecallPage(async () => source, initial, undefined, 2);
    expect(first.records.map((r) => r.id)).toEqual(["d", "c"]);
    const changed = [
      recall("new", "2026-10-10T09:01:00.000Z"),
      ...initial.filter((r) => r.id !== "c"),
    ];
    const next = await buildMissionRecallPage(async () => source, changed, first.nextBefore, 2);
    expect(next.records.map((r) => r.id)).toEqual(["b", "a"]);
    expect(next.nextBefore).toBeUndefined();
  });
});
