import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { RuntimeEventMappingContext } from "@pragma/core";

import {
  mapClaudeCodeNativeEvent,
  normalizeClaudeToolRuntimeEvents,
  readAssistantMessageEvent,
  readClaudeCodeContextWindowUsage,
  writeClaudeCodeMcpConfig,
  type ClaudeToolStreamState,
} from "../src/session.ts";

describe("Claude Code context window", () => {
  it("pairs the latest assistant-step usage with the selected model context window", () => {
    expect(
      readClaudeCodeContextWindowUsage(
        {
          modelUsage: {
            "claude-sonnet": {
              inputTokens: 60_000,
              outputTokens: 2_000,
              contextWindow: 200_000,
            },
          },
        },
        {
          measurement: "reported",
          input: 41_000,
          output: 1_000,
          cacheRead: 8_000,
          cacheWrite: 0,
          totalTokens: 50_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        "claude-sonnet",
      ),
    ).toMatchObject({
      usedTokens: 50_000,
      contextWindowTokens: 200_000,
      percent: 25,
      measurement: "derived",
    });
  });
});

describe("Claude Code Execution MCP config", () => {
  it("writes the isolated registration URL", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pragma-claude-mcp-"));
    const url = "http://127.0.0.1:43127/sessions/opaque-token/mcp";

    try {
      const path = await writeClaudeCodeMcpConfig(sessionDir, url);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        mcpServers: {
          pragma: {
            type: "http",
            url,
          },
        },
      });
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });
});

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
