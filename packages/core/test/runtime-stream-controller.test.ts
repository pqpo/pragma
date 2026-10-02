import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentMessageUsage } from "@pragma/shared";

import {
  AsyncPushQueue,
  createLoggerProvider,
  createRuntimeStreamController,
  createUsageFromTokenCounts,
  defaultRuntimeTokenCounter,
  defineExpert,
  type Expert,
  type RuntimeAgentSession,
  type RuntimeStreamEvent,
  type RuntimeTokenCounter,
} from "../src/index.ts";
import {
  RuntimeTurnNotDispatchedError,
  type RuntimeTurnContext,
  type RuntimeTurnResult,
  type RuntimeUsageContext,
} from "../src/runtime/driver.ts";
import { openRuntimeSession } from "../src/runtime/session-factory.ts";
import { defineRuntimeTestDriver } from "../src/testing/index.ts";

const sessions: RuntimeAgentSession[] = [];
const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) await session.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

describe("Runtime attempt usage settlement", () => {
  it("collects precise usage before generating any fallback estimate", async () => {
    const collectUsage = vi.fn(() => reportedUsage(333));
    const session = await createDriverFixture(() => ({ outputText: "final answer" }), collectUsage);
    const countText = vi.spyOn(defaultRuntimeTokenCounter, "countText");
    const handle = session.submit({ query: "hello", execution: {} });
    await expect(handle.result).resolves.toMatchObject({ result: { usage: reportedUsage(333) } });
    expect(await handle.usage).toEqual(reportedUsage(333));
    expect(collectUsage).toHaveBeenCalledOnce();
    expect(countText).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "does not bill an undispatched attempt (previous reported attempt: %s)",
    async (previousAttempt) => {
      const collectUsage = vi.fn(() => reportedUsage(999));
      const session = await createDriverFixture((turn) => {
        if (previousAttempt && turn.attempt === 1)
          return { outputText: "invalid JSON", usage: reportedUsage(333) };
        throw new RuntimeTurnNotDispatchedError(new Error("validation before dispatch"));
      }, collectUsage);
      const countText = vi.spyOn(defaultRuntimeTokenCounter, "countText");
      const handle = session.submit({
        query: "hello",
        execution: {},
        ...(previousAttempt ? { output: z.object({ ok: z.boolean() }), outputRetryLimit: 1 } : {}),
      });
      await expect(handle.result).rejects.toThrow("validation before dispatch");
      expect(await handle.usage).toEqual(previousAttempt ? reportedUsage(333) : undefined);
      expect(collectUsage).not.toHaveBeenCalled();
      expect(countText).not.toHaveBeenCalled();
    },
  );

  it("estimates final-only output without requiring streaming deltas", async () => {
    const outputText = "final answer ".repeat(100);
    const session = await createDriverFixture(() => ({ outputText }));
    const countText = vi.spyOn(defaultRuntimeTokenCounter, "countText");
    const handle = session.submit({ query: "hello", execution: {} });
    await expect(handle.result).resolves.toMatchObject({ result: { output: outputText } });
    const usage = await handle.usage;
    expect(usage?.measurement).toBe("estimated");
    expect(usage?.output).toBeGreaterThan(0);
    expect(countText).toHaveBeenCalledTimes(2);
    expect(countText).toHaveBeenCalledWith(outputText);
  });

  it.each([false, true])(
    "settles oversized final-only output with reported usage taking priority: %s",
    async (reported) => {
      await vi.waitFor(() =>
        expect(defaultRuntimeTokenCounter.countText("hello world").source).toBe("tokenizer"),
      );
      const outputText = "x".repeat(200_001);
      const session = await createDriverFixture(() => ({
        outputText,
        ...(reported ? { usage: reportedUsage(333) } : {}),
      }));
      const countText = vi.spyOn(defaultRuntimeTokenCounter, "countText");
      const handle = session.submit({ query: "hello", execution: {} });
      await expect(handle.result).resolves.toMatchObject({ result: { output: outputText } });
      if (reported) {
        expect(await handle.usage).toEqual(reportedUsage(333));
        expect(countText).not.toHaveBeenCalled();
      } else {
        expect(await handle.usage).toMatchObject({ measurement: "estimated", output: 50_001 });
        expect(countText).toHaveBeenCalledTimes(2);
        expect(countText).toHaveBeenCalledWith(outputText);
      }
    },
  );

  it("collects each retry independently and sums its precise usage once", async () => {
    const collectUsage = vi
      .fn()
      .mockReturnValueOnce(reportedUsage(333))
      .mockReturnValueOnce(reportedUsage(444));
    const session = await createDriverFixture(
      (turn) => ({ outputText: turn.attempt === 1 ? "invalid JSON" : '{"ok":true}' }),
      collectUsage,
    );
    const countText = vi.spyOn(defaultRuntimeTokenCounter, "countText");
    const handle = session.submit({
      query: "hello",
      execution: {},
      output: z.object({ ok: z.boolean() }),
      outputRetryLimit: 1,
    });
    await expect(handle.result).resolves.toMatchObject({ result: { output: { ok: true } } });
    expect(await handle.usage).toEqual(reportedUsage(777));
    expect(collectUsage).toHaveBeenCalledTimes(2);
    expect(collectUsage.mock.calls.every(([, context]) => context.usage === undefined)).toBe(true);
    expect(countText).not.toHaveBeenCalled();
  });
});

function reportedUsage(input: number) {
  return createUsageFromTokenCounts({
    inputTokens: input,
    inputTokensIncludeCacheRead: false,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
}

async function createDriverFixture(
  startTurn: (turn: RuntimeTurnContext<number>) => RuntimeTurnResult,
  collectUsage?: (session: object, context: RuntimeUsageContext) => AgentMessageUsage | undefined,
) {
  const home = await mkdtemp(join(tmpdir(), "pragma-runtime-usage-"));
  homes.push(home);
  const agent = await defineExpert({
    id: "usage-test",
    name: "Usage test",
    description: "Usage test",
    tags: [],
    scope: "test",
    workspace: home,
  });
  const runtime = defineRuntimeTestDriver<number, object>({
    descriptor: { id: "usage-test", kind: "test", displayName: "Usage test" },
    createSession: () => ({}),
    startTurn: (_, turn) => startTurn(turn),
    mapEvent: (input) => ({ usage: reportedUsage(input) }),
    collectUsage,
  });
  const session = await openRuntimeSession(runtime, {
    agent,
    owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
    pragmaHome: home,
    systemSessionId: "usage-session",
  });
  sessions.push(session);
  return session;
}

describe("Runtime stream telemetry", () => {
  it("does no tokenization for 10,000 deltas and memoizes terminal fallback", async () => {
    const countText = vi.fn(() => ({ tokens: 5 }));
    const { controller, queue } = createFixture({ countText } as unknown as RuntimeTokenCounter);
    controller.beginUsageCapture({ prompt: "hello" });
    for (let index = 0; index < 10_000; index++) {
      controller.writer.write({
        runId: "run-1",
        source: controller.source,
        type: "message.delta",
        payload: { contentType: "text", delta: "x" },
      });
    }
    expect(countText).not.toHaveBeenCalled();
    expect(controller.getUsage()?.measurement).toBe("estimated");
    controller.getUsage();
    expect(countText).toHaveBeenCalledTimes(2);
    await controller.complete();
    const events: RuntimeStreamEvent[] = [];
    for await (const event of queue) events.push(event);
    expect(events.filter((event) => event.type === "usage.updated")).toHaveLength(1);
    expect(events.filter((event) => event.type === "context-window.updated")).toEqual([]);
  });

  it("publishes reported usage once without tokenization or live context estimates", async () => {
    const countText = vi.fn(() => {
      throw new Error("unexpected estimate");
    });
    const { controller, queue } = createFixture({ countText } as unknown as RuntimeTokenCounter);
    controller.beginUsageCapture({ prompt: "hello" });
    controller.writer.writeNative(123);
    expect(controller.getUsage()?.totalTokens).toBe(123);
    await controller.complete();
    expect(countText).not.toHaveBeenCalled();
    const events: RuntimeStreamEvent[] = [];
    for await (const event of queue) events.push(event);
    expect(events.filter((event) => event.type === "usage.updated")).toHaveLength(1);
    expect(events.find((event) => event.type === "usage.updated")?.payload.usage.totalTokens).toBe(
      123,
    );
    expect(events.filter((event) => event.type === "context-window.updated")).toEqual([]);
  });
});

function createFixture(tokenCounter?: RuntimeTokenCounter) {
  const queue = new AsyncPushQueue<RuntimeStreamEvent>();
  const controller = createRuntimeStreamController<number>({
    agent: {
      id: "telemetry-expert",
      hooks: undefined,
    } as unknown as Expert,
    queue,
    tokenCounter,
    runId: "run-1",
    session: () => ({
      systemSessionId: "session-1",
      runtimeSession: { type: "test", id: "native-1" },
      agentId: "telemetry-expert",
      runtime: { id: "test", kind: "test", displayName: "Test" },
      sessionState: "active",
      runState: "running",
    }),
    logger: createLoggerProvider({
      minimumLevel: "silent",
      handler: { write: () => undefined },
    }).createLogger({ component: "test" }),
    mapEvent: (usage) => ({
      usage: {
        measurement: "reported",
        input: usage,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: usage,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
    }),
  });
  return { controller, queue };
}
