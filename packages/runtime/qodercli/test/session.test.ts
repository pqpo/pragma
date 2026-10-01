import type { SDKResultSuccess } from "@qoder-ai/qoder-agent-sdk";
import type { RuntimeTurnContext } from "@pragma/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelQoderTurn,
  closeQoderSession,
  consumeQoderStartupMessages,
  startQoderTurn,
  steerQoderTurn,
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

  it("derives context occupancy from the SDK percentage and the resolved model window", async () => {
    const sdkQuery = createSdkQuery({ contextUsageRatio: Number.NaN });
    sdkQuery.getContextUsage.mockResolvedValue({ contextWindow: { usedPercentage: 25 } });
    queryMock.mockReturnValue(sdkQuery);
    const session = createSession();
    session.contextWindowTokens = 100_000;

    await startQoderTurn(session, createTurn([]));

    expect(sdkQuery.getContextUsage).toHaveBeenCalledOnce();
    expect(session.contextWindowUsage).toMatchObject({
      usedTokens: 25_000,
      contextWindowTokens: 100_000,
      measurement: "derived",
    });
  });

  it.each([Number.NaN, -1, 101])(
    "estimates occupancy when the SDK percentage is invalid (%s)",
    async (usedPercentage) => {
      const sdkQuery = createSdkQuery({ contextUsageRatio: Number.NaN });
      sdkQuery.getContextUsage.mockResolvedValue({ contextWindow: { usedPercentage } });
      queryMock.mockReturnValue(sdkQuery);
      const countText = vi.fn<QoderNativeSession["tokenCounter"]["countText"]>(() => ({
        tokens: 42,
        source: "heuristic",
      }));
      const session = createSession(countText);
      session.contextWindowTokens = 100_000;

      await startQoderTurn(session, createTurn([]));

      expect(session.contextWindowUsage).toMatchObject({
        usedTokens: 42,
        contextWindowTokens: 100_000,
        measurement: "estimated",
      });
      expect(countText).toHaveBeenCalled();
    },
  );

  it("queues steer guidance for the next suitable Qoder boundary", async () => {
    const session = createSession();
    let injected: AsyncIterable<unknown> | undefined;
    const streamInput = vi.fn(async (messages: AsyncIterable<unknown>) => {
      injected = messages;
    });
    session.activeQuery = { streamInput } as unknown as QoderNativeSession["activeQuery"];

    await steerQoderTurn(session, { requestId: "request-1", content: "new direction" });

    expect(streamInput).toHaveBeenCalledOnce();
    const messages = [];
    if (injected === undefined) throw new Error("No steer input was injected.");
    for await (const message of injected) messages.push(message);
    expect(messages).toEqual([
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "new direction" }] },
        parent_tool_use_id: null,
        priority: "next",
        uuid: "request-1",
      },
    ]);
  });

  it("settles an aborted turn and shares one native interrupt", async () => {
    const controller = new AbortController();
    const interrupt = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const sdkQuery = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<never>>(() => undefined),
        };
      },
      interrupt,
      close,
    };
    queryMock.mockReturnValue(sdkQuery);
    const session = createSession();
    const turn = { ...createTurn([]), signal: controller.signal };

    const result = startQoderTurn(session, turn);
    await vi.waitFor(() => expect(session.activeQuery).toBe(sdkQuery));
    controller.abort(new Error("stop"));

    await expect(result).rejects.toThrow("stop");
    await cancelQoderTurn(session);
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it("retries a failed native close even after cancellation detached the Query", async () => {
    const session = createSession();
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("native stop failed"))
      .mockResolvedValue(undefined);
    session.activeQuery = { interrupt: vi.fn(async () => {}), close } as unknown as NonNullable<
      QoderNativeSession["activeQuery"]
    >;
    await expect(closeQoderSession(session)).rejects.toThrow("native stop failed");
    expect(session.activeQuery).toBeUndefined();
    await expect(closeQoderSession(session)).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
  });
  it("does not wait forever when Qoder ignores interrupt and close", async () => {
    vi.useFakeTimers();
    try {
      const session = createSession();
      const activeQuery = {
        interrupt: vi.fn(() => new Promise<void>(() => undefined)),
        close: vi.fn(() => new Promise<void>(() => undefined)),
      } as unknown as NonNullable<QoderNativeSession["activeQuery"]>;
      session.activeQuery = activeQuery;

      const cancellation = cancelQoderTurn(session);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(cancellation).resolves.toBeUndefined();

      expect(activeQuery.interrupt).toHaveBeenCalledOnce();
      expect(activeQuery.close).toHaveBeenCalledOnce();
      expect(session.activeQuery).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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
    attachments: [],
    startupMessages,
    features: {} as never,
    steps: {} as never,
    signal: new AbortController().signal,
    source: { kind: "runtime", runId: "run-1", path: [] },
    stream: {
      write: vi.fn(),
      writeNative: vi.fn(),
    } as unknown as RuntimeTurnContext<QoderNativeEvent>["stream"],
  };
}

function createSdkQuery(
  options: {
    readonly reportedUsage?: boolean;
    readonly contextUsageRatio?: number;
  } = {},
) {
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
      context_usage_ratio: options.contextUsageRatio ?? 0,
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
    getContextUsage: vi.fn(async () => ({ contextWindow: { usedPercentage: 0 } })),
  };
}
