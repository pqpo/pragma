import type { RuntimeEventMappingContext, RuntimeStreamEventInput } from "@pragma/core";
import { describe, expect, it, vi } from "vitest";

import type { CodexAppServerClient } from "../src/app-server-client.ts";
import {
  compactCodexContextWindow,
  createCodexNativeSession,
  createCodexNotificationBus,
  mapCodexNotificationToRuntimeEvent,
  parseCodexContextWindowUsage,
  startCodexTurn,
} from "../src/session.ts";

describe("Codex context window", () => {
  it("reads active context from the latest turn instead of cumulative thread usage", () => {
    expect(
      parseCodexContextWindowUsage({
        threadId: "thread-1",
        tokenUsage: {
          total: { totalTokens: 663_493 },
          last: { totalTokens: 92_000, reasoningOutputTokens: 4_000 },
          modelContextWindow: 200_000,
        },
      }),
    ).toMatchObject({
      usedTokens: 88_000,
      contextWindowTokens: 200_000,
      percent: 44,
      measurement: "reported",
    });
  });

  it("does not substitute cumulative usage when the latest context snapshot is absent", () => {
    expect(
      parseCodexContextWindowUsage({
        token_usage: {
          total_token_usage: { total_tokens: 663_493 },
          model_context_window: 258_400,
        },
      }),
    ).toMatchObject({
      usedTokens: null,
      contextWindowTokens: 258_400,
      percent: null,
    });
  });

  it("supports snake-case latest usage and excludes transient reasoning tokens", () => {
    expect(
      parseCodexContextWindowUsage({
        token_usage: {
          last_token_usage: {
            total_tokens: 70_000,
            reasoning_output_tokens: 6_000,
          },
          model_context_window: 128_000,
        },
      }),
    ).toMatchObject({
      usedTokens: 64_000,
      contextWindowTokens: 128_000,
      percent: 50,
    });
  });

  it("maps root token notifications to live usage and context-window snapshots", () => {
    const result = mapCodexNotificationToRuntimeEvent(
      {
        rootThreadId: "thread-1",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            tokenUsage: {
              last: {
                inputTokens: 40_000,
                cachedInputTokens: 10_000,
                outputTokens: 2_000,
                totalTokens: 42_000,
                reasoningOutputTokens: 2_000,
              },
              modelContextWindow: 200_000,
            },
          },
        },
      },
      {
        runId: "run-1",
        source: { kind: "runtime", runId: "run-1", path: [] },
        events: {},
      } as unknown as RuntimeEventMappingContext,
    );

    expect(result.usage).toMatchObject({
      input: 30_000,
      output: 2_000,
      cacheRead: 10_000,
      totalTokens: 42_000,
    });
    expect(result.contextWindowUsage).toMatchObject({
      usedTokens: 40_000,
      contextWindowTokens: 200_000,
      percent: 20,
    });
  });

  it("waits for compact completion and returns refreshed thread usage", async () => {
    const notificationBus = createCodexNotificationBus();
    const client = {
      async compactThread() {
        notificationBus.publish({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            tokenUsage: {
              total: { totalTokens: 12_000 },
              last: { totalTokens: 12_000 },
              modelContextWindow: 200_000,
            },
          },
        });
        notificationBus.publish({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { status: "completed" } },
        });
      },
    } as unknown as CodexAppServerClient;
    const session = createCodexNativeSession({
      client,
      notificationBus,
      state: { threadId: "thread-1" },
    });

    await expect(compactCodexContextWindow(session)).resolves.toMatchObject({
      usedTokens: 12_000,
      contextWindowTokens: 200_000,
      percent: 6,
    });
  });

  it("times out when the app-server never reports compact completion", async () => {
    vi.useFakeTimers();
    try {
      const notificationBus = createCodexNotificationBus();
      const client = {
        async compactThread() {
          return undefined;
        },
      } as unknown as CodexAppServerClient;
      const session = createCodexNativeSession({
        client,
        notificationBus,
        state: { threadId: "thread-1" },
      });

      const compacting = compactCodexContextWindow(session);
      const rejected = expect(compacting).rejects.toThrow("context compaction timed out");
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Codex turn completion", () => {
  it("rejects a completed turn that contains no assistant output", async () => {
    const notificationBus = createCodexNotificationBus();
    const client = {
      async startTurn() {
        notificationBus.publish({
          method: "turn/completed",
          params: { turn: { status: "completed", error: null } },
        });
      },
    } as unknown as CodexAppServerClient;
    const session = createCodexNativeSession({
      client,
      notificationBus,
      state: { threadId: "thread-1" },
    });

    await expect(
      startCodexTurn(session, {
        runId: "run-1",
        attempt: 1,
        isRetry: false,
        rawQuery: "hello",
        prompt: "hello",
        startupMessages: [],
        signal: new AbortController().signal,
        source: {
          kind: "runtime",
          runId: "run-1",
          path: [{ runId: "run-1" }],
        },
        stream: {
          write: () => undefined,
          writeNative: () => undefined,
        },
      }),
    ).rejects.toThrow("completed without assistant output");
  });

  it("retains a spawned child nickname and role for runtime event mapping", async () => {
    const notificationBus = createCodexNotificationBus();
    const writeNative = vi.fn();
    const client = {
      async startTurn() {
        notificationBus.publish({
          method: "thread/started",
          params: {
            thread: {
              id: "child-thread",
              parentThreadId: "thread-1",
              agentNickname: "Ada",
              agentRole: "researcher",
            },
          },
        });
        notificationBus.publish({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            item: { type: "agentMessage", id: "answer", text: "done" },
          },
        });
        notificationBus.publish({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { status: "completed", error: null } },
        });
      },
    } as unknown as CodexAppServerClient;
    const session = createCodexNativeSession({
      client,
      notificationBus,
      state: { threadId: "thread-1" },
    });

    await startCodexTurn(session, {
      runId: "run-1",
      attempt: 1,
      isRetry: false,
      rawQuery: "hello",
      prompt: "hello",
      startupMessages: [],
      signal: new AbortController().signal,
      source: {
        kind: "runtime",
        runId: "run-1",
        path: [{ runId: "run-1" }],
      },
      stream: { write: () => undefined, writeNative },
    });

    expect(writeNative).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: {
          threadId: "child-thread",
          parentThreadId: "thread-1",
          displayName: "Ada",
          role: "researcher",
        },
      }),
    );
  });
});

describe("Codex tool event mapping", () => {
  it("maps a failed dynamic MCP call to a visible tool failure", () => {
    const failedEvent = { type: "tool.failed" } as RuntimeStreamEventInput;
    const toolFailed = vi.fn(() => failedEvent);
    const context = {
      runId: "run-1",
      source: { kind: "runtime", runId: "run-1", path: [] },
      events: { toolFailed },
    } as unknown as RuntimeEventMappingContext;

    const result = mapCodexNotificationToRuntimeEvent(
      {
        rootThreadId: "thread-1",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            item: {
              type: "dynamicToolCall",
              id: "call-1",
              namespace: "mcp__pragma_tools",
              tool: "read_expert_context",
              arguments: {},
              status: "failed",
              contentItems: [
                {
                  type: "inputText",
                  text: "unsupported call: mcp__pragma_tools_f27986349ee3",
                },
              ],
              success: false,
              durationMs: 3,
            },
          },
        },
      },
      context,
    );

    expect(toolFailed).toHaveBeenCalledWith({
      toolCallId: "call-1",
      toolName: "read_expert_context",
      message: "unsupported call: mcp__pragma_tools_f27986349ee3",
    });
    expect(result.events).toEqual([
      expect.objectContaining({ type: "tool.failed", runId: "run-1" }),
    ]);
  });

  it("maps native collaboration calls without guessing tool names in the UI", () => {
    const context = {
      runId: "root-run",
      source: { kind: "runtime", runId: "root-run", path: [] },
      events: {},
    } as unknown as RuntimeEventMappingContext;

    const result = mapCodexNotificationToRuntimeEvent(
      {
        rootThreadId: "root-thread",
        notification: {
          method: "item/completed",
          params: {
            threadId: "root-thread",
            turnId: "root-turn",
            item: {
              type: "collabAgentToolCall",
              id: "collab-1",
              tool: "spawnAgent",
              status: "completed",
              senderThreadId: "root-thread",
              receiverThreadIds: ["child-thread"],
              prompt: "Inspect the repository",
              agentsStates: { "child-thread": { status: "running", message: null } },
            },
          },
        },
      },
      context,
    );

    expect(result.events).toEqual([
      expect.objectContaining({
        type: "agent.command",
        runId: "root-run",
        source: expect.objectContaining({ sessionId: "root-thread" }),
        payload: expect.objectContaining({
          commandId: "collab-1",
          action: "spawn",
          phase: "completed",
          targetSessionIds: ["child-thread"],
        }),
      }),
    ]);
  });

  it("keeps child thread output in a distinct runtime source", () => {
    const messageDelta = vi.fn((delta: string) => ({
      runId: "root-run",
      source: { kind: "runtime", runId: "root-run", path: [] },
      type: "message.delta" as const,
      payload: { role: "assistant" as const, contentType: "text" as const, delta },
    }));
    const context = {
      runId: "root-run",
      source: { kind: "runtime", runId: "root-run", path: [] },
      events: { messageDelta },
    } as unknown as RuntimeEventMappingContext;

    const result = mapCodexNotificationToRuntimeEvent(
      {
        rootThreadId: "root-thread",
        thread: {
          threadId: "child-thread",
          parentThreadId: "root-thread",
          role: "researcher",
        },
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "child-thread",
            turnId: "child-turn",
            itemId: "message-1",
            delta: "child output",
          },
        },
      },
      context,
    );

    expect(result.outputDelta).toBeUndefined();
    expect(result.events).toEqual([
      expect.objectContaining({
        runId: "child-turn",
        parentRunId: "root-run",
        source: expect.objectContaining({
          sessionId: "child-thread",
          parentSessionId: "root-thread",
          displayName: "researcher",
        }),
        payload: expect.objectContaining({ delta: "child output" }),
      }),
    ]);
  });
});
