import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ContextSystem, ExpertAgent } from "../../src/index.ts";
import { defineRuntimeDriver } from "../../src/runtime/driver.ts";
import type {
  RuntimeSessionCheckpoint,
  RuntimeSessionRestoreRequest,
} from "../../src/runtime/session-persistence.ts";

describe("defineRuntimeDriver", () => {
  it("runs a native driver through core stream, retry, and checkpoint workflows", async () => {
    const checkpoints: RuntimeSessionCheckpoint[] = [];
    const restoreRequests: RuntimeSessionRestoreRequest[] = [];
    const runtime = defineRuntimeDriver<FakeEvent, FakeSession>(
      {
        descriptor: {
          id: "fake-runtime",
          kind: "fake-runtime",
          displayName: "Fake Runtime",
          capabilities: {
            supportsStreaming: true,
            supportsAbort: true,
          },
        },
        resolvePersistence(ctx) {
          return {
            mode: "checkpoint",
            sessionDir: ctx.paths.runtimeSessionDir("fake"),
            checkpointOn: ["session.created", "runtimeSessionId.changed", "turn.completed"],
          };
        },
        createSession() {
          return {
            id: "native-session-1",
            attempts: 0,
          };
        },
        readSession(session) {
          return {
            runtimeSessionId: session.id,
          };
        },
        async startTurn(session, turn) {
          session.attempts += 1;

          if (turn.attempt === 1) {
            turn.stream.writeNative({ type: "delta", text: "not json" });
            turn.stream.writeNative({ type: "completed", text: "not json" });
            return { outputText: "not json" };
          }

          session.id = "native-session-2";
          turn.stream.writeNative({ type: "delta", text: "{\"ok\":true}" });
          turn.stream.writeNative({ type: "completed", text: "{\"ok\":true}" });
          return {
            outputText: "{\"ok\":true}",
            runtimeSessionId: session.id,
          };
        },
        mapEvent(event, ctx) {
          if (event.type === "delta") {
            return {
              events: [ctx.events.messageDelta(event.text)],
              outputDelta: event.text,
            };
          }

          return {
            events: [ctx.events.messageCompleted(event.text)],
            completedText: event.text,
          };
        },
      },
      {
        persistenceProvider: {
          restore(request) {
            restoreRequests.push(request);
            return {};
          },
          checkpoint(checkpoint) {
            checkpoints.push(checkpoint);
          },
        },
      },
    );
    const agent = await ExpertAgent.create({
      id: "coder",
      name: "Coder",
      description: "Responsible for code changes.",
      tags: ["coding"],
      version: "0.0.0",
      scope: "workspace",
      workspace: "/tmp/pragma-runtime-driver-test",
      contextSystem: new ContextSystem(),
    });
    const session = await runtime.createSession({
      agent,
      systemSessionId: "system-session-1",
    });
    const handle = session.submit({
      runId: "run-1",
      query: "Return JSON",
      output: z.object({ ok: z.boolean() }),
      outputRetryLimit: 1,
    });
    const events = [];
    for await (const event of handle.events) {
      events.push(event);
    }
    const result = await handle.result;

    expect(result.result.output).toEqual({ ok: true });
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "message.delta",
      "message.completed",
      "message.delta",
      "message.completed",
      "run.completed",
    ]);
    expect(session.info().runtimeSession.id).toBe("native-session-2");
    expect(restoreRequests).toHaveLength(1);
    expect(checkpoints.map((checkpoint) => checkpoint.trigger)).toEqual([
      "session.created",
      "runtimeSessionId.changed",
      "turn.completed",
    ]);
  });

  it("does not carry captured output text across structured output retries", async () => {
    const runtime = defineRuntimeDriver<FakeEvent, FakeSession>({
      descriptor: {
        id: "fake-runtime",
        kind: "fake-runtime",
        displayName: "Fake Runtime",
      },
      createSession() {
        return {
          id: "native-session-1",
          attempts: 0,
        };
      },
      startTurn(session, turn) {
        session.attempts += 1;

        if (turn.attempt === 1) {
          turn.stream.writeNative({ type: "delta", text: "not json" });
          return {};
        }

        turn.stream.writeNative({ type: "delta", text: "{\"ok\":true}" });
        return {};
      },
      mapEvent(event, ctx) {
        return event.type === "delta"
          ? {
              events: [ctx.events.messageDelta(event.text)],
              outputDelta: event.text,
            }
          : {
              events: [ctx.events.messageCompleted(event.text)],
              completedText: event.text,
            };
      },
    });
    const agent = await ExpertAgent.create({
      id: "coder",
      name: "Coder",
      description: "Responsible for code changes.",
      tags: ["coding"],
      version: "0.0.0",
      scope: "workspace",
      workspace: "/tmp/pragma-runtime-driver-retry-test",
      contextSystem: new ContextSystem(),
    });
    const session = await runtime.createSession({ agent });

    const result = await session.submit({
      query: "Return JSON",
      output: z.object({ ok: z.boolean() }),
      outputRetryLimit: 1,
    }).result;

    expect(result.result.output).toEqual({ ok: true });
  });
});

type FakeEvent =
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "completed"; readonly text: string };

interface FakeSession {
  id: string;
  attempts: number;
}
