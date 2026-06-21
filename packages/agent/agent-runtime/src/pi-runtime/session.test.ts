import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createQueuedAgentLifecycle } from "@expertmesh/agent-core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createPiRuntimeSession } from "./session.ts";
import type { RuntimeStreamBridge } from "./types.ts";

describe("createPiRuntimeSession", () => {
  it("validates structured output with a Zod schema", async () => {
    const piSession = createFakeAgentSession('{"summary":"done","confidence":0.9}');
    const lifecycle = createQueuedAgentLifecycle(undefined);
    const runtimeSession = createPiRuntimeSession<string>(
      piSession,
      {
        sessionId: "session-1",
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
  });

  it("switches to the submitted model when modelName is provided", async () => {
    const piSession = createFakeAgentSession("done");
    const lifecycle = createQueuedAgentLifecycle(undefined);
    const model = {
      id: "gpt-4o",
      name: "GPT-4o",
      provider: "openai",
    };
    const runtimeSession = createPiRuntimeSession<string>(
      piSession,
      {
        sessionId: "session-1",
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

function createFakeAgentSession(text: string): AgentSession {
  let subscriber: ((event: unknown) => void) | undefined;

  return {
    sessionId: "pi-session-1",
    sessionFile: undefined,
    subscribe(callback: (event: unknown) => void) {
      subscriber = callback;
      return () => {
        subscriber = undefined;
      };
    },
    async prompt() {
      subscriber?.({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: text,
        },
      });
    },
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
