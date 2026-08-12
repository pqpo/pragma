import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ExpertPromptAttachment } from "@pragma/shared";

import {
  ContextSystem,
  createRuntimeContextWindowUsage,
  defaultRuntimeTokenCounter,
  defineExpert,
  defineRuntimeDriver,
  RUNTIME_CONTEXT_COMPACTION_STAGES,
  RUNTIME_STARTUP_MESSAGE_STAGES,
  StaticContextStore,
  type ExpertAgentStartupMessage,
  type RuntimeContextWindowUsage,
  type RuntimeDriverSessionContext,
  type RuntimeTurnContext,
} from "../src/index.ts";
import { openRuntimeSession } from "../src/runtime/session-factory.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Runtime always-on startup messages", () => {
  it("keeps native images for vision models and degrades text-only models to path context", async () => {
    const image: ExpertPromptAttachment = {
      id: "00000000-0000-4000-8000-000000000001",
      kind: "image",
      name: "screen.png",
      path: "/tmp/screen.png",
      mimeType: "image/png",
      size: 2_000_000,
      optimized: {
        path: "/tmp/screen.optimized.webp",
        mimeType: "image/webp",
        size: 200_000,
      },
    };
    const vision = await createFixture(["text", "image"]);
    const textOnly = await createFixture(["text"]);
    const unavailableCatalog = await createFixture(undefined, true);
    try {
      await submit(vision.session, "inspect", [image]);
      await submit(textOnly.session, "inspect", [image]);
      await submit(unavailableCatalog.session, "inspect", [image]);

      expect(vision.stats.turns[0]?.attachments).toEqual([
        {
          id: image.id,
          kind: "image",
          name: image.name,
          path: "/tmp/screen.optimized.webp",
          mimeType: "image/webp",
          size: 200_000,
        },
      ]);
      expect(vision.stats.turns[0]?.rawQuery).toContain("/tmp/screen.png");
      expect(textOnly.stats.turns[0]?.attachments).toEqual([]);
      expect(textOnly.stats.turns[0]?.rawQuery).toContain("/tmp/screen.png");
      expect(unavailableCatalog.stats.turns[0]?.attachments).toEqual([]);
      expect(unavailableCatalog.stats.turns[0]?.rawQuery).toContain("/tmp/screen.png");
    } finally {
      await Promise.all([
        vision.session.close(),
        textOnly.session.close(),
        unavailableCatalog.session.close(),
      ]);
    }
  });

  it("injects once and rearms only after completed automatic or manual compaction", async () => {
    const fixture = await createFixture();
    try {
      await submit(fixture.session, "first");
      await submit(fixture.session, "without-compaction");
      await submit(fixture.session, "auto-compact");
      await submit(fixture.session, "after-auto");
      await submit(fixture.session, "steady-again");

      expect(fixture.stats.turns.map((turn) => turn.startupMessages.length)).toEqual([
        1, 0, 0, 1, 0,
      ]);

      await fixture.session.contextWindow?.compact?.();
      await submit(fixture.session, "after-manual");
      await submit(fixture.session, "after-manual-steady");

      expect(fixture.stats.turns.slice(-2).map((turn) => turn.startupMessages.length)).toEqual([
        1, 0,
      ]);
      expect(fixture.stats.compact).toHaveBeenCalledOnce();
    } finally {
      await fixture.session.close();
    }
  });

  it("coalesces compactions, ignores failed events, and keeps retries free of reinjection", async () => {
    const fixture = await createFixture();
    try {
      const retry = fixture.session.submit({
        query: "retry-after-compaction",
        output: z.object({ ok: z.boolean() }),
        outputRetryLimit: 1,
        execution: {},
      });
      await collectEvents(retry.events);
      await expect(retry.result).resolves.toMatchObject({ result: { output: { ok: true } } });

      expect(fixture.stats.turns.slice(0, 2).map((turn) => turn.startupMessages.length)).toEqual([
        1, 0,
      ]);

      await submit(fixture.session, "after-retry");
      await submit(fixture.session, "failed-compaction");
      await submit(fixture.session, "after-failed");

      expect(fixture.stats.turns.slice(2).map((turn) => turn.startupMessages.length)).toEqual([
        1, 0, 0,
      ]);
    } finally {
      await fixture.session.close();
    }
  });

  it("retries consumed startup context after a fresh native failure without a Session identity", async () => {
    const fixture = await createFixture();
    try {
      const failed = fixture.session.submit({ query: "fresh-failure", execution: {} });
      const events = collectEvents(failed.events);
      await expect(failed.result).rejects.toThrow("failed before native Session allocation");
      await events;

      await submit(fixture.session, "retry-after-fresh-failure");
      await submit(fixture.session, "steady-after-retry");
      expect(fixture.stats.turns.map((turn) => turn.startupMessages.length)).toEqual([1, 1, 0]);
    } finally {
      await fixture.session.close();
    }
  });

  it("skips oversized reinjection at the 50 percent gate and emits a diagnostic", async () => {
    const fixture = await createFixture();
    try {
      await submit(fixture.session, "first");
      await submit(fixture.session, "auto-compact");
      fixture.stats.contextWindow = createRuntimeContextWindowUsage({
        usedTokens: 99,
        contextWindowTokens: 100,
        measurement: "reported",
      });

      const skipped = await submit(fixture.session, "budget-gated");
      expect(fixture.stats.turns.at(-1)?.startupMessages).toEqual([]);
      expect(skipped.events).toContainEqual(
        expect.objectContaining({
          type: "progress",
          payload: expect.objectContaining({
            stage: RUNTIME_STARTUP_MESSAGE_STAGES.reinjectionSkipped,
            data: expect.objectContaining({
              reason: "insufficient_remaining_context",
              remainingTokens: 1,
              thresholdTokens: 0,
              thresholdRatio: 0.5,
            }),
          }),
        }),
      );

      await submit(fixture.session, "not-retried-without-compaction");
      expect(fixture.stats.turns.at(-1)?.startupMessages).toEqual([]);

      await submit(fixture.session, "auto-compact");
      fixture.stats.contextWindow = {
        ...fixture.stats.contextWindow,
        usedTokens: null,
        percent: null,
      };
      await submit(fixture.session, "unknown-usage-still-injects");
      expect(fixture.stats.turns.at(-1)?.startupMessages).toHaveLength(1);
    } finally {
      await fixture.session.close();
    }
  });

  it("allows reinjection exactly at the 50 percent budget boundary", async () => {
    const fixture = await createFixture();
    try {
      await submit(fixture.session, "first");
      await submit(fixture.session, "auto-compact");
      await (
        defaultRuntimeTokenCounter as typeof defaultRuntimeTokenCounter & {
          readonly load: () => Promise<boolean>;
        }
      ).load();
      const content = fixture.stats.turns[0]?.startupMessages
        .map((message) => message.content)
        .join("\n\n");
      const startupMessageTokens = defaultRuntimeTokenCounter.countText(content ?? "").tokens;
      fixture.stats.contextWindow = createRuntimeContextWindowUsage({
        usedTokens: 1_000,
        contextWindowTokens: 1_000 + startupMessageTokens * 2,
        measurement: "reported",
      });

      const result = await submit(fixture.session, "at-boundary");

      expect(fixture.stats.turns.at(-1)?.startupMessages).toHaveLength(1);
      expect(result.events).not.toContainEqual(
        expect.objectContaining({
          type: "progress",
          payload: expect.objectContaining({
            stage: RUNTIME_STARTUP_MESSAGE_STAGES.reinjectionSkipped,
          }),
        }),
      );
    } finally {
      await fixture.session.close();
    }
  });
});

interface TestNativeEvent {
  readonly stage: string;
  readonly data: unknown;
}

interface TestNativeSession {
  readonly context: RuntimeDriverSessionContext;
  pendingStartupMessages: readonly ExpertAgentStartupMessage[];
}

async function createFixture(inputModalities?: readonly string[], modelCatalogUnavailable = false) {
  const root = await mkdtemp(join(tmpdir(), "pragma-runtime-startup-"));
  roots.push(root);
  const stats = {
    turns: [] as Array<{
      readonly attempt: number;
      readonly attachments: readonly ExpertPromptAttachment[];
      readonly rawQuery: string;
      readonly startupMessages: readonly ExpertAgentStartupMessage[];
    }>,
    compact: vi.fn(),
    contextWindow: createRuntimeContextWindowUsage({
      usedTokens: 10,
      contextWindowTokens: 10_000,
      measurement: "reported",
    }) as RuntimeContextWindowUsage,
  };
  const contextSystem = new ContextSystem({
    stores: {
      project: new StaticContextStore([
        {
          id: "POLICY.md",
          content: "Always verify the complete policy before acting.",
          metadata: { trigger: "always_on" },
        },
      ]),
    },
    roots: [{ namespace: "project" }],
  });
  const agent = await defineExpert({
    id: "startup-test",
    name: "Startup Test",
    description: "Tests always-on startup messages",
    tags: ["test"],
    scope: "test",
    workspace: root,
    pragmaHome: root,
    contextSystem,
  });
  const runtime = defineRuntimeDriver<TestNativeEvent, TestNativeSession>({
    descriptor: { id: "startup-runtime", kind: "startup-runtime", displayName: "Startup" },
    ...(modelCatalogUnavailable
      ? {
          listModels: async () => {
            throw new Error("model catalog unavailable");
          },
        }
      : inputModalities === undefined
        ? {}
        : {
            listModels: async () => [
              {
                id: "test-model",
                displayName: "Test model",
                provider: { kind: "runtime-managed" as const, id: "test", displayName: "Test" },
                default: true,
                inputModalities,
              },
            ],
          }),
    createSession(context) {
      return { context, pendingStartupMessages: context.agentContext.startupMessages };
    },
    consumeStartupMessages(session) {
      const messages = session.pendingStartupMessages;
      session.pendingStartupMessages = [];
      return messages;
    },
    async startTurn(session, turn) {
      stats.turns.push({
        attempt: turn.attempt,
        attachments: turn.attachments,
        rawQuery: turn.rawQuery,
        startupMessages: turn.startupMessages,
      });
      if (
        turn.rawQuery === "auto-compact" ||
        (turn.rawQuery === "retry-after-compaction" && turn.attempt === 1)
      ) {
        writeCompactionEvent(turn, RUNTIME_CONTEXT_COMPACTION_STAGES.completed);
        if (turn.rawQuery === "auto-compact") {
          writeCompactionEvent(turn, RUNTIME_CONTEXT_COMPACTION_STAGES.completed);
        }
      }
      if (turn.rawQuery === "failed-compaction") {
        writeCompactionEvent(turn, RUNTIME_CONTEXT_COMPACTION_STAGES.failed);
      }
      if (turn.rawQuery === "fresh-failure") {
        throw new Error("failed before native Session allocation");
      }
      return {
        outputText:
          turn.rawQuery === "retry-after-compaction"
            ? turn.attempt === 1
              ? "invalid"
              : '{"ok":true}'
            : "done",
      };
    },
    mapEvent(event, context) {
      return { events: [context.events.progress(event.stage, event.data)] };
    },
    readContextWindow() {
      return stats.contextWindow;
    },
    compactContext() {
      stats.compact();
      return stats.contextWindow;
    },
  });
  const session = await openRuntimeSession(runtime, {
    agent,
    owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
    pragmaHome: root,
    systemSessionId: "system-session",
  });
  return { session, stats };
}

function writeCompactionEvent(turn: RuntimeTurnContext<TestNativeEvent>, stage: string): void {
  turn.stream.writeNative({
    stage,
    data: {
      operationId: `operation-${turn.runId}`,
      trigger: "auto",
      runtimeId: "startup-runtime",
      ...(stage === RUNTIME_CONTEXT_COMPACTION_STAGES.failed
        ? { errorMessage: "compaction failed" }
        : {}),
    },
  });
}

async function submit(
  session: Awaited<ReturnType<typeof createFixture>>["session"],
  query: string,
  attachments: readonly ExpertPromptAttachment[] = [],
) {
  const submission = session.submit({ query, attachments, execution: {} });
  const eventsPromise = collectEvents(submission.events);
  await submission.result;
  return { events: await eventsPromise };
}

async function collectEvents(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const collected: unknown[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}
