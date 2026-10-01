import type { RuntimeAgentSession } from "../src/index.ts";
import { describe, expect, it, vi } from "vitest";

import { createQueuedAgentLifecycle } from "../src/runtime/agent-lifecycle.ts";
import { RuntimeSessionPool } from "../src/execution/runtime-session-pool.ts";

const identity = {
  contextId: "context",
  expertId: "expert",
  runtime: { runtimeId: "runtime", revision: 1, fingerprint: "a".repeat(64) },
};

describe("RuntimeSessionPool", () => {
  it("confirms native stop of a racing opening without waiting for full cleanup", async () => {
    const pool = new RuntimeSessionPool();
    const session = { ...createRuntimeSession(), stopForDeletion: vi.fn(async () => {}) };
    let finish!: () => void;
    vi.mocked(session.close).mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let opened!: (session: RuntimeAgentSession) => void;
    const opening = pool.acquire(
      identity,
      async () =>
        await new Promise<RuntimeAgentSession>((resolve) => {
          opened = resolve;
        }),
    );
    const rejected = expect(opening).rejects.toMatchObject({ code: "RUNTIME_POOL_OPENING_SEALED" });
    const stopping = pool.closeForDeletion();
    opened(session);
    await stopping;
    await rejected;
    expect(session.stopForDeletion).toHaveBeenCalledOnce();
    finish();
    await pool.finishDeletion();
  });
  it("retries retired cleanup after native stop succeeded and close failed", async () => {
    const pool = new RuntimeSessionPool();
    const session = { ...createRuntimeSession(), stopForDeletion: vi.fn(async () => {}) };
    const close = vi.mocked(session.close).mockRejectedValueOnce(new Error("cleanup failed"));
    await pool.acquire(identity, async () => session);
    pool.invalidate(session);
    await expect(pool.finishDeletion()).rejects.toThrow("cleanup failed");
    expect(close).toHaveBeenCalledOnce();
    await Promise.all([pool.finishDeletion(), pool.finishDeletion()]);
    expect(close).toHaveBeenCalledTimes(2);
    expect(session.stopForDeletion).toHaveBeenCalledOnce();
    await pool.finishDeletion();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("retries the managed lifecycle cleanup instead of replaying its rejection", async () => {
    const cleanup = vi.fn(async () => {}).mockRejectedValueOnce(new Error("hook unavailable"));
    const lifecycle = createQueuedAgentLifecycle(undefined, { cleanup });
    const pool = new RuntimeSessionPool();
    const session = {
      ...createRuntimeSession(),
      stopForDeletion: vi.fn(async () => lifecycle.seal()),
      close: vi.fn(async () => await lifecycle.close()),
    };
    await pool.acquire(identity, async () => session);
    pool.invalidate(session);
    await expect(pool.finishDeletion()).rejects.toThrow("hook unavailable");
    await pool.finishDeletion();
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(session.close).toHaveBeenCalledTimes(2);
    expect(session.stopForDeletion).toHaveBeenCalledOnce();
    await pool.finishDeletion();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent creation for one context", async () => {
    const pool = new RuntimeSessionPool();
    const session = createRuntimeSession();
    const create = vi.fn(async () => session);

    const [first, second] = await Promise.all([
      pool.acquire(identity, create),
      pool.acquire(identity, create),
    ]);

    expect(first).toBe(session);
    expect(second).toBe(session);
    expect(create).toHaveBeenCalledTimes(1);
    await pool.close();
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("removes a failed creation so a later acquire can retry", async () => {
    const pool = new RuntimeSessionPool();
    const session = createRuntimeSession();
    const create = vi
      .fn<() => Promise<RuntimeAgentSession>>()
      .mockRejectedValueOnce(new Error("opening failed"))
      .mockResolvedValueOnce(session);

    await expect(pool.acquire(identity, create)).rejects.toThrow("opening failed");
    await expect(pool.acquire(identity, create)).resolves.toBe(session);
    expect(create).toHaveBeenCalledTimes(2);
    await pool.close();
  });

  it("rejects reuse when the Expert or Runtime identity changes", async () => {
    const pool = new RuntimeSessionPool();
    const session = createRuntimeSession();
    await pool.acquire(identity, async () => session);

    await expect(
      pool.acquire(
        { ...identity, runtime: { ...identity.runtime, runtimeId: "other-runtime" } },
        async () => session,
      ),
    ).rejects.toThrow("cannot be reused");
    await pool.close();
  });

  it("reopens a Runtime Session when Host Context bindings change", async () => {
    const pool = new RuntimeSessionPool();
    const first = createRuntimeSession();
    const second = createRuntimeSession();
    const create = vi.fn(async ({ fresh }: { readonly fresh: boolean }) =>
      fresh ? second : first,
    );

    await pool.acquire({ ...identity, hostContextBindingsFingerprint: "memory" }, create);
    await expect(
      pool.acquire({ ...identity, hostContextBindingsFingerprint: "disabled" }, create),
    ).resolves.toBe(second);

    expect(first.close).toHaveBeenCalledOnce();
    expect(create).toHaveBeenNthCalledWith(1, { fresh: false });
    expect(create).toHaveBeenNthCalledWith(2, { fresh: true });
    await pool.close();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it("releases one invocation-scoped Runtime without closing the pool", async () => {
    const pool = new RuntimeSessionPool();
    const fresh = createRuntimeSession();
    const reused = createRuntimeSession();
    await pool.acquire(identity, async () => fresh);
    await pool.acquire({ ...identity, contextId: "reused" }, async () => reused);

    await pool.release(identity);
    expect(fresh.close).toHaveBeenCalledTimes(1);
    expect(reused.close).not.toHaveBeenCalled();
    await pool.close();
    expect(reused.close).toHaveBeenCalledTimes(1);
  });

  it("clears cached Sessions without sealing the pool", async () => {
    const pool = new RuntimeSessionPool();
    const first = createRuntimeSession();
    const second = createRuntimeSession();
    await pool.acquire(identity, async () => first);

    await pool.clear();
    expect(first.close).toHaveBeenCalledTimes(1);
    await expect(pool.acquire(identity, async () => second)).resolves.toBe(second);
    await pool.close();
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it("retains a Session whose close failed so recovery cannot mistake it for stopped", async () => {
    const pool = new RuntimeSessionPool();
    const session = createRuntimeSession();
    vi.mocked(session.close).mockRejectedValueOnce(new Error("close failed"));
    await pool.acquire(identity, async () => session);
    await expect(pool.clear()).rejects.toThrow("close failed");
    expect(pool.get(identity)).toBe(session);
    await pool.clear();
    expect(session.close).toHaveBeenCalledTimes(2);
    expect(pool.get(identity)).toBeUndefined();
    await pool.close();
  });

  it("invalidates an unhealthy Session without waiting and reopens fresh", async () => {
    const pool = new RuntimeSessionPool();
    const neverCloses = createRuntimeSession();
    vi.mocked(neverCloses.close).mockReturnValue(new Promise<void>(() => undefined));
    const replacement = createRuntimeSession();
    const create = vi.fn(async ({ fresh }: { readonly fresh: boolean }) =>
      fresh ? replacement : neverCloses,
    );

    await pool.acquire(identity, create);
    pool.invalidate(neverCloses);

    await expect(pool.acquire(identity, create)).resolves.toBe(replacement);
    expect(neverCloses.close).toHaveBeenCalledOnce();
    expect(create).toHaveBeenNthCalledWith(2, { fresh: true });
    await pool.close();
    expect(replacement.close).toHaveBeenCalledOnce();
  });
  it("deletion waits for an invalidated native Session that ordinary close can leave behind", async () => {
    const pool = new RuntimeSessionPool();
    const session = createRuntimeSession();
    let release!: () => void;
    const closed = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(session.close).mockImplementation(async () => await closed);
    await pool.acquire(identity, async () => session);
    pool.invalidate(session);
    const stopped = vi.fn();
    const deletion = pool.closeForDeletion().then(stopped);
    await pool.close();
    expect(stopped).not.toHaveBeenCalled();
    release();
    await deletion;
    expect(stopped).toHaveBeenCalledOnce();
  });

  it("keeps a native close failure retryable for deletion", async () => {
    const pool = new RuntimeSessionPool();
    const session = createRuntimeSession();
    vi.mocked(session.close).mockRejectedValueOnce(new Error("native process still running"));
    await pool.acquire(identity, async () => session);
    await expect(pool.closeForDeletion()).rejects.toThrow("native process still running");
    await expect(pool.closeForDeletion()).resolves.toBeUndefined();
    expect(session.close).toHaveBeenCalledTimes(2);
  });
});

function createRuntimeSession(): RuntimeAgentSession {
  return {
    info: vi.fn(),
    messages: vi.fn(() => []),
    submit: vi.fn(),
    steer: vi.fn(),
    close: vi.fn(),
  } as unknown as RuntimeAgentSession;
}
