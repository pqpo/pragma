import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RuntimeEventMappingContext } from "@pragma/core";
import { describe, expect, it, vi } from "vitest";

import { assertAssistantTurnCompleted } from "../src/session-events.ts";
import { mapPiAgentEvent } from "../src/session.ts";
import { createToolStreamEvents } from "../src/stream.ts";

describe("PI failed tool event projection", () => {
  it.each([
    { content: [] },
    { content: [{ type: "image", data: "image-bytes", mimeType: "image/png" }] },
  ])("keeps Host details out of media-only and empty failures: %j", ({ content }) => {
    const [event] = createToolStreamEvents({
      runId: "run",
      source: { kind: "runtime", runId: "run", path: [] },
      toolEvent: {
        type: "completed",
        toolCallId: "call",
        toolName: "inspect",
        isError: true,
        result: { content, details: { hostOnly: "host-only-marker" } },
      },
    });
    expect(event).toMatchObject({ type: "tool.failed" });
    expect(JSON.stringify(event)).not.toContain("host-only-marker");
    expect(event).toMatchObject({
      payload: {
        message: content.length === 0 ? "Tool execution failed" : JSON.stringify(content),
      },
    });
  });
});

describe("PI assistant turn validation", () => {
  it("surfaces provider errors instead of succeeding with an empty response", () => {
    expect(() =>
      assertAssistantTurnCompleted([
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "OpenAI API error (404): no body",
        },
      ]),
    ).toThrow("OpenAI API error (404): no body");
  });

  it("rejects a completed turn without assistant text", () => {
    expect(() =>
      assertAssistantTurnCompleted([{ role: "assistant", content: [], stopReason: "stop" }]),
    ).toThrow("empty assistant response");
  });

  it("accepts a normal assistant text response", () => {
    expect(() =>
      assertAssistantTurnCompleted([
        {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          stopReason: "stop",
        },
      ]),
    ).not.toThrow();
  });

  it("rejects a response truncated by the token limit", () => {
    expect(() =>
      assertAssistantTurnCompleted([
        {
          role: "assistant",
          content: [{ type: "text", text: "partial" }],
          stopReason: "length",
        },
      ]),
    ).toThrow("response was truncated before completion. Partial output was preserved");
  });

  it("does not claim partial output was preserved when a truncated response is empty", () => {
    expect(() =>
      assertAssistantTurnCompleted([
        {
          role: "assistant",
          content: [],
          stopReason: "length",
        },
      ]),
    ).toThrow("response was truncated before completion. Retry with a smaller request");
  });
});

describe("PI compaction event mapping", () => {
  it("maps native compaction lifecycle events to the shared contract", () => {
    const progress = vi.fn((stage: string, data: unknown) => ({
      type: "progress" as const,
      payload: { stage, data },
    }));
    const context = {
      runId: "run-1",
      source: { kind: "runtime", runId: "run-1", path: [] },
      events: { progress },
    } as unknown as RuntimeEventMappingContext;

    mapPiAgentEvent(
      {
        event: { type: "compaction_start", reason: "threshold" } as AgentSessionEvent,
        operationId: "compact-1",
        trigger: "auto",
      },
      context,
    );

    expect(progress).toHaveBeenCalledWith("context.compaction.started", {
      operationId: "compact-1",
      trigger: "auto",
      runtimeId: "cloud-pi-agent",
    });

    mapPiAgentEvent(
      {
        event: {
          type: "compaction_end",
          reason: "threshold",
          result: undefined,
          aborted: false,
          willRetry: false,
          errorMessage: "Compaction failed: provider unavailable",
        } as AgentSessionEvent,
        operationId: "compact-1",
        trigger: "auto",
      },
      context,
    );

    expect(progress).toHaveBeenLastCalledWith("context.compaction.failed", {
      operationId: "compact-1",
      trigger: "auto",
      runtimeId: "cloud-pi-agent",
      errorMessage: "Compaction failed: provider unavailable",
    });
  });
});
