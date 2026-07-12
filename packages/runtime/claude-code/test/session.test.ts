import { describe, expect, it } from "vitest";
import type { RuntimeEventMappingContext } from "@pragma/core";

import {
  mapClaudeCodeNativeEvent,
  normalizeClaudeToolRuntimeEvents,
  readAssistantMessageEvent,
  type ClaudeToolStreamState,
} from "../src/session.ts";

const context = {
  runId: "run-1",
  source: {
    kind: "agent" as const,
    runId: "run-1",
    agentId: "expert-1",
    path: [],
  },
  events: {} as RuntimeEventMappingContext["events"],
} satisfies RuntimeEventMappingContext;

describe("Claude Code stream mapping", () => {
  it("does not expose internal system and thinking-token accounting events", () => {
    expect(
      mapClaudeCodeNativeEvent(
        { type: "system", subtype: "thinking_tokens", token_count: 1 },
        context,
      ).events,
    ).toEqual([]);
    expect(
      mapClaudeCodeNativeEvent({ type: "system", subtype: "status", status: "requesting" }, context)
        .events,
    ).toEqual([]);
  });

  it("keeps SDK thinking deltas as thought events", () => {
    expect(
      mapClaudeCodeNativeEvent(
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "Checking context" },
          },
        },
        context,
      ),
    ).toMatchObject({
      events: [
        {
          type: "thought.delta",
          payload: { contentType: "text", delta: "Checking context" },
        },
      ],
      thinkingDelta: "Checking context",
    });
  });

  it("emits only the new suffix from cumulative assistant thinking snapshots", () => {
    const first = readAssistantMessageEvent(
      { content: [{ type: "thinking", thinking: "The" }] },
      context.runId,
      context.source,
    );
    const second = readAssistantMessageEvent(
      { content: [{ type: "thinking", thinking: "The user" }] },
      context.runId,
      context.source,
      { thinkingPrefix: first.thinkingDelta },
    );
    const final = readAssistantMessageEvent(
      { content: [{ type: "thinking", thinking: "The user" }] },
      context.runId,
      context.source,
      { thinkingPrefix: `${first.thinkingDelta}${second.thinkingDelta}` },
    );

    expect(first.thinkingDelta).toBe("The");
    expect(second.thinkingDelta).toBe(" user");
    expect(final.events).toEqual([]);
    expect(final.thinkingDelta).toBeUndefined();
  });

  it("does not replay assistant snapshots after SDK text and thinking deltas", () => {
    expect(
      readAssistantMessageEvent(
        {
          content: [
            { type: "thinking", thinking: "Reformatted thinking snapshot" },
            { type: "text", text: "Reformatted answer snapshot" },
          ],
        },
        context.runId,
        context.source,
        { skipText: true, skipThinking: true },
      ),
    ).toMatchObject({ events: [] });
  });

  it("deduplicates tool starts and restores the tool name on results", () => {
    const state: ClaudeToolStreamState = {
      startedToolCallIds: new Set(),
      toolNames: new Map(),
    };
    const started = {
      runId: context.runId,
      source: context.source,
      type: "tool.started" as const,
      payload: {
        toolCallId: "tool-1",
        toolName: "mcp__pragma__list_expert_context",
        kind: "tool" as const,
        inputPreview: {},
      },
    };
    const completed = {
      runId: context.runId,
      source: context.source,
      type: "tool.completed" as const,
      payload: {
        toolCallId: "tool-1",
        toolName: "claude_tool",
        kind: "tool" as const,
        outputPreview: { context: [] },
      },
    };

    expect(normalizeClaudeToolRuntimeEvents([started], state)).toEqual([started]);
    expect(normalizeClaudeToolRuntimeEvents([started], state)).toEqual([]);
    expect(normalizeClaudeToolRuntimeEvents([completed], state)).toEqual([
      {
        ...completed,
        payload: {
          ...completed.payload,
          toolName: "mcp__pragma__list_expert_context",
        },
      },
    ]);
  });
});
