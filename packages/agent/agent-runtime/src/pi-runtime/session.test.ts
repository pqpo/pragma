import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createQueuedAgentLifecycle, ExpertAgent } from "@expertmesh/agent-core";
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

function createFakeAgentSession(texts: readonly string[]): AgentSession {
  let subscriber: ((event: unknown) => void) | undefined;
  let promptCount = 0;

  return {
    sessionId: "pi-session-1",
    sessionFile: undefined,
    subscribe(callback: (event: unknown) => void) {
      subscriber = callback;
      return () => {
        subscriber = undefined;
      };
    },
    prompt: vi.fn(async () => {
      const text = texts[promptCount] ?? texts.at(-1) ?? "";
      promptCount += 1;
      subscriber?.({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: text,
        },
      });
    }),
    setModel: vi.fn(),
  } as unknown as AgentSession;
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
