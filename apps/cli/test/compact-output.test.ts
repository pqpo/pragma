import { describe, expect, it } from "vitest";
import { CliCompactEventSchema, CliCompactResultSchema } from "@pragma/shared/integration";
import { createV2StreamPresenter, presentSuccess } from "../src/presenters/index.ts";
import { runCli } from "../src/index.ts";

const id = "11111111-1111-4111-8111-111111111111";
function input(view: "full" | "compact", format: "json" | "jsonl" = "jsonl") {
  const output: string[] = [];
  return {
    output,
    presentation: {
      io: { writeStdout: (s: string) => output.push(s), writeStderr: () => {} },
      format,
      outputView: view,
      requestId: id,
      command: "mission.get",
      cliVersion: "test",
      startedAt: new Date(),
    },
  };
}

describe("explicit compact v3 output", () => {
  it("keeps ordinary event results bound to their event rather than a final execution result", () => {
    const { output, presentation } = input("compact");
    const stream = createV2StreamPresenter({ ...presentation, command: "expert.run" });
    stream.emit({
      type: "tool.completed",
      data: { executionId: id, result: "large tool output ".repeat(1000) },
      missionId: id,
      executionId: id,
      replayable: true,
      cursor: "event-cursor",
      eventId: id,
      emittedAt: new Date().toISOString(),
    });
    expect(JSON.parse(output[0]!).data.contentReference).toMatchObject({
      source: "event",
      id: "event-cursor",
    });
  });
  it("retains v2 while emitting the result once in compact query streams", () => {
    for (const view of ["full", "compact"] as const) {
      const { output, presentation } = input(view);
      presentSuccess(presentation, { content: "whole result" });
      const events = output.map((s) => JSON.parse(s));
      expect(events.filter((e) => e.data.result !== undefined)).toHaveLength(
        view === "compact" ? 1 : 2,
      );
      if (view === "compact")
        for (const event of events)
          expect(CliCompactEventSchema.safeParse(event).success).toBe(true);
      expect(events.at(-1).data.status).toBe("succeeded");
      expect(events.at(-1).data.exitCode).toBe(0);
    }
  });
  it("does not repeat a run's final result and keeps replay metadata", () => {
    const { output, presentation } = input("compact");
    const stream = createV2StreamPresenter(presentation);
    stream.emit({
      type: "run.succeeded",
      data: { executionId: id, result: "answer" },
      missionId: id,
      executionId: id,
      replayable: true,
      cursor: "durable-cursor",
      eventId: id,
    });
    stream.finalize({ status: "succeeded", missionId: id, executionId: id, result: "answer" });
    const events = output.map((s) => JSON.parse(s));
    expect(events.filter((e) => e.data.result !== undefined)).toHaveLength(1);
    expect(events[0]).toMatchObject({ cursor: "durable-cursor", replayable: true, eventId: id });
    expect(events.at(-1).data).toMatchObject({ lastCursor: "durable-cursor" });
    expect(events.at(-1).data).not.toHaveProperty("result");
  });
  it("uses a durable content reference for a large final result", () => {
    const { output, presentation } = input("compact", "json");
    const value = "中😀".repeat(2000);
    const stream = createV2StreamPresenter({ ...presentation, format: "jsonl" });
    stream.finalize({ status: "succeeded", missionId: id, executionId: id, result: value });
    const events = output.map((s) => JSON.parse(s));
    expect(events[0].data.result).toBeUndefined();
    expect(events[0].data.resultContent).toMatchObject({
      source: "result",
      id,
      totalBytes: Buffer.byteLength(value),
    });
    expect(events.at(-1).data).not.toHaveProperty("resultContent");
    expect(Buffer.byteLength(output.join(""))).toBeLessThan(10000);
  });

  it("selects compact JSON explicitly and emits parse errors in the selected view", async () => {
    const { output, presentation } = input("compact", "json");
    presentSuccess(presentation, { status: "running" });
    expect(CliCompactResultSchema.safeParse(JSON.parse(output[0]!)).success).toBe(true);
    const io = { writeStdout: (s: string) => output.push(s), writeStderr: () => {} };
    expect(await runCli(["unknown", "--json", "--output-view", "compact"], io)).toBe(2);
    expect(JSON.parse(output.at(-1)!).schemaVersion).toBe("pragma.cli-result/v3");
  });
});
