import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createQueuedAgentLifecycle } from "@expertmesh/agent-core";
import { describe, expect, it } from "vitest";
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
  } as unknown as AgentSession;
}

function createTestStreamBridge(): RuntimeStreamBridge {
  let sequence = 0;

  return {
    nextSequence: () => sequence++,
  };
}
