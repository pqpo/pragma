import type { SDKResultSuccess } from "@qoder-ai/qoder-agent-sdk";
import type { RuntimeTurnContext } from "@pragma/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  consumeQoderStartupMessages,
  startQoderTurn,
  type QoderNativeEvent,
  type QoderNativeSession,
} from "../src/session.ts";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@qoder-ai/qoder-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@qoder-ai/qoder-agent-sdk")>()),
  query: queryMock,
}));

describe("Qoder startup messages", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("consumes startup messages once without recording them before a turn", () => {
    const session = createSession();
    session.pendingStartupMessages = [
      { role: "user", content: "always-on context one" },
      { role: "user", content: "always-on context two" },
    ];

    expect(consumeQoderStartupMessages(session)).toEqual([
      { role: "user", content: "always-on context one" },
      { role: "user", content: "always-on context two" },
    ]);
    expect(session.pendingStartupMessages).toEqual([]);
    expect(session.messages).toEqual([]);

    expect(consumeQoderStartupMessages(session)).toEqual([]);
    expect(session.messages).toEqual([]);
  });

  it("prepends startup messages to the first native prompt without double-counting fallback usage", async () => {
    const sdkQuery = createSdkQuery({ reportedUsage: false });
    queryMock.mockReturnValue(sdkQuery);
    const countText = vi.fn<QoderNativeSession["tokenCounter"]["countText"]>(() => ({
      tokens: 1,
      source: "heuristic",
    }));
    const session = createSession(countText);
    session.pendingStartupMessages = [
      { role: "user", content: "always-on context one" },
      { role: "user", content: "always-on context two" },
    ];
    const startupMessages = consumeQoderStartupMessages(session);

    await startQoderTurn(session, createTurn(startupMessages));

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "always-on context one\n\nalways-on context two\n\nuser prompt",
      }),
    );
    expect(JSON.parse(countText.mock.calls[0]![0])).toMatchObject({
      messages: [],
      prompt: "always-on context one\n\nalways-on context two\n\nuser prompt",
    });
    expect(session.messages.slice(0, 3)).toMatchObject([
      { role: "user", content: "always-on context one" },
      { role: "user", content: "always-on context two" },
      { role: "user", content: "user prompt" },
    ]);
    expect(sdkQuery.close).toHaveBeenCalledOnce();
  });

  it("leaves restored sessions without startup messages to replay", () => {
    const session = createSession();

    expect(consumeQoderStartupMessages(session)).toEqual([]);
    expect(session.messages).toEqual([]);
  });
});

function createSession(
  countText: QoderNativeSession["tokenCounter"]["countText"] = () => ({
    tokens: 1,
    source: "heuristic",
  }),
): QoderNativeSession {
  return {
    agent: { workspace: "/workspace" } as QoderNativeSession["agent"],
    auth: { type: "qodercli" },
    executablePath: "/opt/qodercli",
    env: {},
    configDir: "/tmp/qoder-config",
    mcpServerUrl: "http://127.0.0.1/mcp",
    plugin: { path: "/tmp/qoder-plugin", skills: [] },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
    } as unknown as QoderNativeSession["logger"],
    permissionMode: "default",
    systemPrompt: "system prompt",
    toolRuntimeState: {},
    tokenCounter: { countText },
    messages: [],
    toolNames: new Map(),
    pendingStartupMessages: [],
    sessionId: "",
  };
}

function createTurn(
  startupMessages: RuntimeTurnContext<QoderNativeEvent>["startupMessages"],
): RuntimeTurnContext<QoderNativeEvent> {
  return {
    runId: "run-1",
    attempt: 1,
    isRetry: false,
    rawQuery: "user prompt",
    prompt: "user prompt",
    startupMessages,
    signal: new AbortController().signal,
    source: { kind: "runtime", runId: "run-1", path: [] },
    stream: {
      write: vi.fn(),
      writeNative: vi.fn(),
    } as unknown as RuntimeTurnContext<QoderNativeEvent>["stream"],
  };
}

function createSdkQuery(options: { readonly reportedUsage?: boolean } = {}) {
  const reportedUsage = options.reportedUsage ?? true;
  const result = {
    type: "result",
    subtype: "success",
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: "done",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      cache_creation: {
        ephemeral_1h_input_tokens: 0,
        ephemeral_5m_input_tokens: 0,
      },
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      context_usage_ratio: 0,
      inference_geo: "",
      input_tokens: reportedUsage ? 1 : 0,
      iterations: [],
      output_tokens: reportedUsage ? 1 : 0,
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
      service_tier: "",
      speed: "",
    },
    modelUsage: {},
    permission_denials: [],
    uuid: "result",
    session_id: "qoder-session",
  } satisfies SDKResultSuccess;

  return {
    async *[Symbol.asyncIterator]() {
      yield result;
    },
    close: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    getContextUsage: vi.fn(async () => ({ totalTokens: 0, maxTokens: 0 })),
  };
}
