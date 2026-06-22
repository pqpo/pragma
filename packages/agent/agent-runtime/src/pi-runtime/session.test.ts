import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createQueuedAgentLifecycle, ExpertAgent } from "@expertmesh/agent-core";
import type { AgentMessageUsage } from "@expertmesh/contracts";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createPiRuntimeSession } from "./session.ts";
import type { RuntimeStreamBridge } from "./types.ts";

describe("createPiRuntimeSession", () => {
  it("validates structured output with a Zod schema", async () => {
    const piSession = createFakeAgentSession(['{"summary":"done","confidence":0.9}']);
    const lifecycle = createQueuedAgentLifecycle(undefined);
    const runtimeSession = createPiRuntimeSession(
      createTestAgent(),
      piSession,
      {
        systemSessionId: "system-session-1",
        runtimeSession: {
          type: "cloud-pi-agent",
          id: "pi-session-1",
        },
        agentId: "agent-1",
        runtime: {
          id: "cloud-pi-agent",
          kind: "cloud-pi-agent",
          displayName: "Cloud PI Agent",
        },
      },
      <TParsedOutput>(text: string) => text as TParsedOutput,
      lifecycle,
      createTestStreamBridge(),
      {
        modelRegistry: createFakeModelRegistry([]),
      },
    );

    const result = await runtimeSession.submit({
      query: "Summarize input",
      output: z.object({
        summary: z.string(),
        confidence: z.number(),
      }),
    });

    expect(result.result.output).toEqual({
      summary: "done",
      confidence: 0.9,
    });
    expect(result.runId).toHaveLength(36);
    expect(piSession.prompt).toHaveBeenCalledWith(
      expect.stringContaining("Return the final answer as valid JSON only."),
    );
  });

  it("extracts JSON from Markdown and surrounding text", async () => {
    const piSession = createFakeAgentSession([
      'Here is the result:\n```json\n{"summary":"done","confidence":0.9}\n```',
    ]);
    const runtimeSession = createTestRuntimeSession(piSession);

    const result = await runtimeSession.submit({
      query: "Summarize input",
      output: z.object({
        summary: z.string(),
        confidence: z.number(),
      }),
    });

    expect(result.result.output).toEqual({
      summary: "done",
      confidence: 0.9,
    });
  });

  it("retries structured output parsing failures with parser context", async () => {
    const piSession = createFakeAgentSession(["not json", '{"summary":"done","confidence":0.9}']);
    const runtimeSession = createTestRuntimeSession(piSession, {
      outputRetryLimit: 1,
    });

    const result = await runtimeSession.submit({
      query: "Summarize input",
      output: z.object({
        summary: z.string(),
        confidence: z.number(),
      }),
    });

    expect(result.result.output).toEqual({
      summary: "done",
      confidence: 0.9,
    });
    expect(piSession.prompt).toHaveBeenCalledTimes(2);
    expect(piSession.prompt).toHaveBeenLastCalledWith(expect.stringContaining("Parser error:"));
  });

  it("returns usage for the current submit including structured output retries", async () => {
    const piSession = createFakeAgentSession(
      ["not json", '{"summary":"done","confidence":0.9}'],
      [
        createUsage({ input: 11, output: 3, cacheRead: 5, cacheWrite: 7, costTotal: 1 }),
        createUsage({
          input: 13,
          output: 17,
          cacheRead: 19,
          cacheWrite: 23,
          cacheWrite1h: 29,
          costTotal: 2,
        }),
      ],
    );
    const runtimeSession = createTestRuntimeSession(piSession, {
      outputRetryLimit: 1,
    });
    const events: unknown[] = [];

    const result = await runtimeSession.submit({
      query: "Summarize input",
      output: z.object({
        summary: z.string(),
        confidence: z.number(),
      }),
      onEvent: (event) => {
        events.push(event);
      },
    });

    const expectedUsage = createUsage({
      input: 24,
      output: 20,
      cacheRead: 24,
      cacheWrite: 30,
      cacheWrite1h: 29,
      totalTokens: 98,
      costTotal: 3,
    });
    expect(result.result.usage).toEqual(expectedUsage);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "run.completed",
        payload: expect.objectContaining({
          usage: expectedUsage,
        }),
      }),
    );
  });

  it("fails after the configured structured output retry limit", async () => {
    const piSession = createFakeAgentSession(["not json"]);
    const runtimeSession = createTestRuntimeSession(piSession, {
      outputRetryLimit: 0,
    });

    await expect(
      runtimeSession.submit({
        query: "Summarize input",
        output: z.object({
          summary: z.string(),
          confidence: z.number(),
        }),
      }),
    ).rejects.toThrow("Raw output:");

    expect(piSession.prompt).toHaveBeenCalledTimes(1);
  });

  it("switches to the submitted model when modelName is provided", async () => {
    const piSession = createFakeAgentSession(["done"]);
    const lifecycle = createQueuedAgentLifecycle(undefined);
    const model = {
      id: "gpt-4o",
      name: "GPT-4o",
      provider: "openai",
    };
    const runtimeSession = createPiRuntimeSession(
      createTestAgent(),
      piSession,
      {
        systemSessionId: "system-session-1",
        runtimeSession: {
          type: "cloud-pi-agent",
          id: "pi-session-1",
        },
        agentId: "agent-1",
        runtime: {
          id: "cloud-pi-agent",
          kind: "cloud-pi-agent",
          displayName: "Cloud PI Agent",
        },
      },
      <TParsedOutput>(text: string) => text as TParsedOutput,
      lifecycle,
      createTestStreamBridge(),
      {
        modelRegistry: createFakeModelRegistry([model]),
      },
    );

    await runtimeSession.submit({
      query: "Summarize input",
      modelName: "openai/gpt-4o",
    });

    expect(piSession.setModel).toHaveBeenCalledWith(model);
  });

  it("exposes runtime-independent message history as a readonly snapshot", () => {
    const piSession = createFakeAgentSession(["done"]);
    const messages = [
      {
        role: "user",
        content: "Summarize input",
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-4o",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "tool-call-1",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        details: { path: "README.md" },
        isError: false,
        timestamp: 3,
      },
      {
        role: "custom",
        customType: "notice",
        content: "Queued context",
        display: true,
        details: { source: "test" },
        timestamp: 4,
      },
    ];
    setFakeAgentSessionMessages(piSession, messages);
    const runtimeSession = createTestRuntimeSession(piSession);

    const firstRead = runtimeSession.messages();
    const secondRead = runtimeSession.messages();

    expect(firstRead).toEqual(messages);
    expect(firstRead).not.toBe(secondRead);
  });

  it("preserves unsupported runtime messages as hidden platform custom messages", () => {
    const piSession = createFakeAgentSession(["done"]);
    const runtimeOnlyMessage = {
      role: "runtimeTrace",
      traceId: "trace-1",
      timestamp: 1,
    };
    setFakeAgentSessionMessages(piSession, [runtimeOnlyMessage]);
    const runtimeSession = createTestRuntimeSession(piSession);

    expect(runtimeSession.messages()).toEqual([
      expect.objectContaining({
        role: "custom",
        customType: "pi.runtimeTrace",
        content: "Unsupported PI runtime message role: runtimeTrace",
        display: false,
        details: runtimeOnlyMessage,
      }),
    ]);
  });
});

function createTestRuntimeSession(
  piSession: AgentSession,
  options: {
    readonly outputRetryLimit?: number | undefined;
  } = {},
) {
  return createPiRuntimeSession(
    createTestAgent(),
    piSession,
    {
      systemSessionId: "system-session-1",
      runtimeSession: {
        type: "cloud-pi-agent",
        id: "pi-session-1",
      },
      agentId: "agent-1",
      runtime: {
        id: "cloud-pi-agent",
        kind: "cloud-pi-agent",
        displayName: "Cloud PI Agent",
      },
    },
    <TParsedOutput>(text: string) => text as TParsedOutput,
    createQueuedAgentLifecycle(undefined),
    createTestStreamBridge(),
    {
      modelRegistry: createFakeModelRegistry([]),
    },
    options,
  );
}

function createTestAgent(): ExpertAgent {
  return new ExpertAgent({
    schemaVersion: "expertmesh.expert/v1",
    id: "agent-1",
    displayName: "Test Agent",
    description: "Test agent",
    tags: [],
    version: "0.0.0",
    scope: "test",
    workspace: "/tmp/expertmesh-test",
  });
}

function createFakeAgentSession(
  texts: readonly string[],
  usages: readonly AgentMessageUsage[] = [],
): AgentSession {
  let subscriber: ((event: unknown) => void) | undefined;
  let promptCount = 0;
  let messages: unknown[] = [];

  return {
    sessionId: "pi-session-1",
    sessionFile: undefined,
    get messages() {
      return messages;
    },
    set messages(nextMessages: unknown[]) {
      messages = nextMessages;
    },
    subscribe(callback: (event: unknown) => void) {
      subscriber = callback;
      return () => {
        subscriber = undefined;
      };
    },
    prompt: vi.fn(async () => {
      const text = texts[promptCount] ?? texts.at(-1) ?? "";
      const usage = usages[promptCount];
      promptCount += 1;
      subscriber?.({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: text,
        },
      });
      if (usage !== undefined) {
        messages.push({
          role: "assistant",
          content: [{ type: "text", text }],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-4o",
          usage,
          stopReason: "stop",
          timestamp: promptCount,
        });
      }
    }),
    setModel: vi.fn(),
  } as unknown as AgentSession;
}

function createUsage(options: {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cacheWrite1h?: number | undefined;
  readonly totalTokens?: number | undefined;
  readonly costTotal: number;
}): AgentMessageUsage {
  return {
    input: options.input,
    output: options.output,
    cacheRead: options.cacheRead,
    cacheWrite: options.cacheWrite,
    ...(options.cacheWrite1h === undefined ? {} : { cacheWrite1h: options.cacheWrite1h }),
    totalTokens:
      options.totalTokens ??
      options.input + options.output + options.cacheRead + options.cacheWrite,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: options.costTotal,
    },
  };
}

function setFakeAgentSessionMessages(piSession: AgentSession, messages: readonly unknown[]): void {
  (piSession as { messages: unknown[] }).messages = [...messages];
}

function createFakeModelRegistry(models: readonly unknown[]) {
  return {
    getAll: () => [...models],
  } as never;
}

function createTestStreamBridge(): RuntimeStreamBridge {
  let sequence = 0;

  return {
    nextSequence: () => sequence++,
  };
}
