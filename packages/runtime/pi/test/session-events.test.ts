import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RuntimeEventMappingContext } from "@pragma/core";
import { describe, expect, it, vi } from "vitest";

import { assertAssistantTurnCompleted } from "../src/session-events.ts";
import { mapPiAgentEvent } from "../src/session.ts";

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
    ).toThrow("response was truncated");
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
