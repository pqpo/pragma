import type { RuntimeEventMappingContext, RuntimeStreamEventInput } from "@pragma/core";
import { describe, expect, it, vi } from "vitest";

import type { CodexAppServerClient } from "../src/app-server-client.ts";
import {
  createCodexNativeSession,
  createCodexNotificationBus,
  mapCodexNotificationToRuntimeEvent,
  startCodexTurn,
} from "../src/session.ts";

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
        method: "item/completed",
        params: {
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
      context,
    );

    expect(toolFailed).toHaveBeenCalledWith({
      toolCallId: "call-1",
      toolName: "read_expert_context",
      message: "unsupported call: mcp__pragma_tools_f27986349ee3",
    });
    expect(result.events).toEqual([failedEvent]);
  });
});
