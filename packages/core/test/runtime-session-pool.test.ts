import type { RuntimeAgentSession } from "../src/index.ts";
import { describe, expect, it, vi } from "vitest";

import { RuntimeSessionPool } from "../src/execution/runtime-session-pool.ts";

const identity = {
  contextId: "context",
  expertId: "expert",
  runtime: { runtimeId: "runtime", revision: 1, fingerprint: "a".repeat(64) },
};

describe("RuntimeSessionPool", () => {
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
