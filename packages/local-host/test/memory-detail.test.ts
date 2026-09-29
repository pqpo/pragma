import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  EpisodicMemoryRecordSchema,
  projectMemory,
  projectionHash,
  selectedMemoryText,
} from "@pragma/memory";
import { memoryDetailSegments } from "../src/memory-detail.ts";

describe("Memory detail expansion", () => {
  it("retains a late failure/recovery hit before overview and surrounding context", async () => {
    const record = EpisodicMemoryRecordSchema.parse(
      JSON.parse(
        await readFile(
          new URL("../../memory/test/fixtures/retrieval/episodic-record.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    record.attempts = Array.from({ length: 10 }, (_, index) => ({
      description: `Attempt ${index}`,
      result: "failed",
      evidenceRefs: record.evidenceRefs,
    }));
    record.failuresAndRecoveries = Array.from({ length: 12 }, (_, index) => ({
      failure: `Failure ${index}`,
      recovery: `Recovery ${index}: preserve the actual retrieval anchor`,
      evidenceRefs: record.evidenceRefs,
    }));
    const source = { module: "episodic" as const, record };
    const hit = projectMemory(source, 1024).find(
      (segment) => segment.fieldPath === "failuresAndRecoveries[10]",
    )!;
    expect(projectMemory(source, 600).slice(0, 6)).not.toContainEqual(hit);
    const result = memoryDetailSegments(source, [hit, hit]);
    expect(result[0]).toEqual(hit);
    expect(result).toHaveLength(6);
    expect(result.some((segment) => segment.fieldPath === "overview")).toBe(true);
    expect(result.some((segment) => segment.fieldPath === "failuresAndRecoveries[9]")).toBe(true);
    expect(new Set(result.map((segment) => segment.segmentId)).size).toBe(result.length);
    for (const segment of result) {
      expect(selectedMemoryText(source, segment.fieldPath, segment.start, segment.end)).toBe(
        segment.text,
      );
      expect(projectionHash(segment.text)).toBe(segment.textHash);
    }
  });
  it("preserves an exact hit whose offsets differ from detail projection chunks", async () => {
    const record = EpisodicMemoryRecordSchema.parse(
      JSON.parse(
        await readFile(
          new URL("../../memory/test/fixtures/retrieval/episodic-record.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    record.failuresAndRecoveries = [
      {
        failure: "服务启动失败。🌏".repeat(400),
        recovery: "重建缓存后恢复。".repeat(400),
        evidenceRefs: record.evidenceRefs,
      },
    ];
    const source = { module: "episodic" as const, record };
    const hit = projectMemory(source, 1024).filter(
      (segment) => segment.fieldPath === "failuresAndRecoveries[0]",
    )[1]!;
    const result = memoryDetailSegments(source, [hit]);
    expect(result[0]).toEqual(hit);
    expect(
      result
        .slice(1)
        .every(
          (segment) =>
            segment.fieldPath !== hit.fieldPath ||
            segment.end <= hit.start ||
            segment.start >= hit.end,
        ),
    ).toBe(true);
  });
});
