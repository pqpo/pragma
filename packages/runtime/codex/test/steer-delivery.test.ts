import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createNoopLoggerProvider,
  createFileExecutionStore,
  createFileExpertSessionStore,
  createPragma,
  createStaticRuntimeResolver,
  defineExpert,
} from "@pragma/core";
import { describe, expect, it, vi } from "vitest";

import { createCodexRuntime } from "../src/index.ts";
import { createAppServerFixture } from "./app-server-fixture.ts";

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "pragma-codex-steer-"));
  const codexSource = join(home, "empty-codex-source");
  await mkdir(codexSource);
  const peer = createAppServerFixture();
  const executions = createFileExecutionStore({ pragmaHome: home });
  const sessions = createFileExpertSessionStore({ pragmaHome: home, executions });
  const runtime = createCodexRuntime({
    spawn: peer.spawn,
    env: { CODEX_HOME: codexSource },
    canUse: () => ({ usable: true }),
    listModels: async () => [],
  });
  const app = createPragma({
    pragmaHome: home,
    executionStore: executions,
    expertSessionStore: sessions,
    loggerProvider: createNoopLoggerProvider(),
    runtimes: createStaticRuntimeResolver({
      runtimes: [runtime],
      defaultRuntimeId: runtime.descriptor.id,
    }),
  });
  const expert = await defineExpert({
    id: "codex-steer",
    name: "Codex Steer",
    description: "Steer delivery regression",
    tags: [],
    scope: "test",
    workspace: home,
  });
  let session = await app.experts.createSession(expert);
  return {
    peer,
    get session() {
      return session;
    },
    sessions,
    turnStarts: () => peer.requests.filter((request) => request.method === "turn/start"),
    async recover() {
      await session.releaseAfterTerminal();
      session = await app.experts.resumeSession(expert, { sessionId: session.sessionId });
    },
    async close() {
      await session.close();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

describe("Codex queued steer delivery", { timeout: 15_000 }, () => {
  it.each(["not-submitted", "uncertain"] as const)(
    "preserves cancellation of a strict steer with enqueue fallback after a late %s reply",
    async (reply) => {
      const f = await fixture();
      try {
        const active = await f.session.prompt("active", { requestId: "active" });
        await vi.waitFor(() => expect(f.turnStarts()).toHaveLength(1), { timeout: 5_000 });
        const attempt = f.session
          .prompt("redirect", {
            requestId: "redirect",
            mode: "steer",
            steerFallback: "enqueue",
          })
          .catch((error: unknown) => error);
        await vi.waitFor(() => expect(f.peer.requests.at(-1)?.method).toBe("turn/steer"), {
          timeout: 5_000,
        });
        const steerId = f.peer.requests.at(-1)!.id;
        f.peer.completeTurn("turn-1", "first result");
        await active.result;
        await f.session.cancelPromptQueue();
        f.peer.reject(
          steerId,
          reply === "not-submitted"
            ? { code: -32600, message: "no active turn to steer" }
            : { code: -32603, message: "lost reply" },
        );
        expect(await attempt).toBeInstanceOf(Error);
        await f.recover();
        expect(
          (await f.session.getPromptQueue()).find((p) => p.requestId === "redirect")?.status,
        ).toBe("cancelled");
        expect((await f.session.getState()).queuedRequestIds).not.toContain("redirect");
        expect(f.turnStarts()).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
  );

  it("rejects direct retries of an uncertain prompt before making another native request", async () => {
    const f = await fixture();
    try {
      await f.session.prompt("active", { requestId: "active" });
      await f.session.prompt("redirect", { requestId: "redirect" });
      await vi.waitFor(() => expect(f.turnStarts()).toHaveLength(1), { timeout: 5_000 });
      const attempt = f.session.attemptQueuedPromptSteer("redirect");
      await vi.waitFor(() => expect(f.peer.requests.at(-1)?.method).toBe("turn/steer"), {
        timeout: 5_000,
      });
      f.peer.reject(f.peer.requests.at(-1)!.id, { code: -32603, message: "lost reply" });
      await expect(attempt).resolves.toEqual({ outcome: "retained", reason: "delivery_uncertain" });

      await expect(f.session.steerQueuedPrompt("redirect")).rejects.toThrow(/uncertain/i);
      expect(f.peer.requests.filter((request) => request.method === "turn/steer")).toHaveLength(1);
    } finally {
      await f.close();
    }
  }, 10_000);

  it("keeps the queue paused when writing the pause event fails", async () => {
    const f = await fixture();
    try {
      const active = await f.session.prompt("active", { requestId: "active" });
      const queued = await f.session.prompt("redirect", { requestId: "redirect" });
      await vi.waitFor(() => expect(f.turnStarts()).toHaveLength(1), { timeout: 5_000 });
      const appendEvent = f.sessions.appendEvent.bind(f.sessions);
      vi.spyOn(f.sessions, "appendEvent").mockImplementation(async (id, event, claim) => {
        if (event.type === "prompt.queue-paused") throw new Error("pause event write failed");
        return await appendEvent(id, event, claim);
      });
      const attempt = f.session.attemptQueuedPromptSteer("redirect");
      const rejection = expect(attempt).rejects.toThrow("pause event write failed");
      await vi.waitFor(() => expect(f.peer.requests.at(-1)?.method).toBe("turn/steer"), {
        timeout: 5_000,
      });
      const steerId = f.peer.requests.at(-1)!.id;
      f.peer.completeTurn("turn-1", "first result");
      await active.result;
      f.peer.reject(steerId, { code: -32603, message: "lost reply" });
      await rejection;

      await expect(f.session.getPromptQueueState()).resolves.toMatchObject({ state: "paused" });
      await f.session.prompt("later", { requestId: "later" });
      await expect(f.session.steerQueuedPrompt("later")).rejects.toMatchObject({
        name: "SteerNotDispatchedError",
        reason: "no_active_turn",
      });
      expect(f.turnStarts()).toHaveLength(1);
      expect((await queued.getTree()).invocation.status).toBe("queued");
    } finally {
      await f.close();
    }
  });

  it.each(["not-submitted", "uncertain"] as const)(
    "does not resurrect a cleared prompt when the late steer reply is %s",
    async (reply) => {
      const f = await fixture();
      try {
        const active = await f.session.prompt("active", { requestId: "active" });
        const queued = await f.session.prompt("redirect", { requestId: "redirect" });
        await vi.waitFor(() => expect(f.turnStarts()).toHaveLength(1), { timeout: 5_000 });
        const attempt = f.session
          .attemptQueuedPromptSteer("redirect")
          .catch((error: unknown) => error);
        await vi.waitFor(() => expect(f.peer.requests.at(-1)?.method).toBe("turn/steer"), {
          timeout: 5_000,
        });
        const steerId = f.peer.requests.at(-1)!.id;
        f.peer.completeTurn("turn-1", "first result");
        await active.result;
        await f.session.cancelPromptQueue();
        await expect(queued.result).rejects.toThrow();
        f.peer.reject(
          steerId,
          reply === "not-submitted"
            ? { code: -32600, message: "no active turn to steer" }
            : { code: -32603, message: "lost reply" },
        );
        await attempt;

        expect(
          (await f.session.getPromptQueue()).find((p) => p.requestId === "redirect")?.status,
        ).toBe("cancelled");
        expect((await f.session.getState()).queuedRequestIds).not.toContain("redirect");
        expect(f.turnStarts()).toHaveLength(1);
        await f.recover();
        expect(
          (await f.session.getPromptQueue()).find((p) => p.requestId === "redirect")?.status,
        ).toBe("cancelled");
      } finally {
        await f.close();
      }
    },
  );

  it("retains the prompt when the native success response has no confirmed turn id", async () => {
    const f = await fixture();
    try {
      const active = await f.session.prompt("active", { requestId: "active" });
      const queued = await f.session.prompt("redirect", { requestId: "redirect" });
      await vi.waitFor(() => expect(f.turnStarts()).toHaveLength(1), { timeout: 5_000 });
      const attempt = f.session.attemptQueuedPromptSteer("redirect");
      await vi.waitFor(() => expect(f.peer.requests.at(-1)?.method).toBe("turn/steer"), {
        timeout: 5_000,
      });
      const steerId = f.peer.requests.at(-1)!.id;
      f.peer.completeTurn("turn-1", "first result");
      await active.result;
      f.peer.reply(steerId, {});

      await expect(attempt).resolves.toEqual({ outcome: "retained", reason: "delivery_uncertain" });
      expect((await queued.getTree()).invocation.status).toBe("queued");
      await expect(f.session.getPromptQueueState()).resolves.toMatchObject({ state: "paused" });
    } finally {
      await f.close();
    }
  });

  it.each([
    ["no active turn to steer", "no_active_turn"],
    ["expected active turn id `turn-1` but found `turn-2`", "target_changed"],
  ])("starts the retained prompt once after the old turn ends: %s", async (message, reason) => {
    const f = await fixture();
    try {
      const active = await f.session.prompt("active", { requestId: "active" });
      const queued = await f.session.prompt("redirect", { requestId: "redirect" });
      await vi.waitFor(() => expect(f.turnStarts()).toHaveLength(1), { timeout: 5_000 });
      const attempt = f.session.attemptQueuedPromptSteer("redirect");
      await vi.waitFor(() => expect(f.peer.requests.at(-1)?.method).toBe("turn/steer"), {
        timeout: 5_000,
      });
      const steer = f.peer.requests.at(-1)!;

      f.peer.completeTurn("turn-1", "first result");
      await expect(active.result).resolves.toBe("first result");
      expect(f.turnStarts()).toHaveLength(1);
      f.peer.reject(steer.id, { code: -32600, message });

      await expect(attempt).resolves.toEqual({ outcome: "retained", reason });
      await vi.waitFor(() => expect(f.turnStarts()).toHaveLength(2));
      expect((await queued.getTree()).invocation.status).toBe("running");
      expect((await f.session.getState()).activeExecutionId).toBe(queued.executionId);
      expect(await f.session.getPromptQueue()).toContainEqual(
        expect.objectContaining({ requestId: "redirect", executionId: queued.executionId }),
      );
      f.peer.completeTurn("turn-2", "second result");
      await expect(queued.result).resolves.toBe("second result");
      expect(f.turnStarts()).toHaveLength(2);
      const restored = (await f.session.getPromptQueue()).find((p) => p.requestId === "redirect");
      expect(restored?.deliveryAttempt).toBeUndefined();
      expect(restored?.error).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it.each(["disconnect", "timeout", "internal-error"] as const)(
    "retains the message and pauses after %s even when the old turn has finished",
    async (failure) => {
      const f = await fixture();
      try {
        const active = await f.session.prompt("active", { requestId: "active" });
        const queued = await f.session.prompt("redirect", { requestId: "redirect" });
        await vi.waitFor(() => expect(f.turnStarts()).toHaveLength(1), { timeout: 5_000 });
        const attempt = f.session.attemptQueuedPromptSteer("redirect");
        await vi.waitFor(() => expect(f.peer.requests.at(-1)?.method).toBe("turn/steer"), {
          timeout: 5_000,
        });
        const steer = f.peer.requests.at(-1)!;
        f.peer.completeTurn("turn-1", "first result");
        await active.result;
        if (failure === "disconnect") f.peer.disconnect();
        if (failure === "internal-error") {
          f.peer.reject(steer.id, { code: -32603, message: "failed to steer turn: lost response" });
        }

        await expect(attempt).resolves.toEqual({
          outcome: "retained",
          reason: "delivery_uncertain",
        });
        if (failure === "timeout") f.peer.reply(steer.id, { turnId: "turn-1" });
        await expect(f.session.getPromptQueueState()).resolves.toMatchObject({ state: "paused" });
        const retained = (await f.session.getPromptQueue()).find((p) => p.requestId === "redirect");
        expect(retained).toMatchObject({
          executionId: queued.executionId,
          status: "queued",
          content: "redirect",
          error: "delivery_uncertain",
          deliveryAttempt: { state: "uncertain" },
        });
        await expect(f.session.attemptQueuedPromptSteer("redirect")).resolves.toEqual({
          outcome: "retained",
          reason: "delivery_uncertain",
        });
        // A new enqueue must not implicitly resume the uncertain prompt either.
        await f.session.prompt("later", { requestId: "later" });
        expect(f.turnStarts()).toHaveLength(1);
        expect((await queued.getTree()).invocation.status).toBe("queued");
      } finally {
        await f.close();
      }
    },
    10_000,
  );
});
