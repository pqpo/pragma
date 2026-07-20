import type { RuntimeAgentSession } from "../runtime/runtime-adapter.ts";
import type { RuntimeEnvironmentBinding } from "@pragma/shared";

export interface RuntimeSessionIdentity {
  readonly contextId: string;
  readonly expertId: string;
  readonly runtime: RuntimeEnvironmentBinding;
}

interface RuntimeSessionEntry {
  readonly identity: RuntimeSessionIdentity;
  readonly session: RuntimeAgentSession;
}

interface PendingRuntimeSession {
  readonly identity: RuntimeSessionIdentity;
  readonly opening: Promise<RuntimeAgentSession>;
}

export class RuntimeSessionPool {
  private readonly sessions = new Map<string, RuntimeSessionEntry>();
  private readonly pending = new Map<string, PendingRuntimeSession>();
  private sealed = false;
  private closePromise: Promise<void> | undefined;

  async acquire(
    identity: RuntimeSessionIdentity,
    create: () => Promise<RuntimeAgentSession>,
  ): Promise<RuntimeAgentSession> {
    if (this.sealed) {
      throw new Error("Runtime Session pool is closed.");
    }

    const existing = this.sessions.get(identity.contextId);
    if (existing !== undefined) {
      assertMatchingIdentity(existing.identity, identity);
      return existing.session;
    }

    const pending = this.pending.get(identity.contextId);
    if (pending !== undefined) {
      assertMatchingIdentity(pending.identity, identity);
      return await pending.opening;
    }

    const opening = create().then(async (session) => {
      if (this.sealed) {
        await session.close();
        throw new Error("Runtime Session pool closed while opening a session.");
      }
      this.sessions.set(identity.contextId, { identity, session });
      return session;
    });
    this.pending.set(identity.contextId, { identity, opening });

    try {
      return await opening;
    } finally {
      if (this.pending.get(identity.contextId)?.opening === opening) {
        this.pending.delete(identity.contextId);
      }
    }
  }

  async release(identity: RuntimeSessionIdentity): Promise<void> {
    const entry = this.sessions.get(identity.contextId);
    if (entry === undefined) return;
    assertMatchingIdentity(entry.identity, identity);
    this.sessions.delete(identity.contextId);
    await entry.session.close();
  }

  async clear(): Promise<void> {
    if (this.sealed) throw new Error("Runtime Session pool is closed.");
    if (this.pending.size > 0) {
      throw new Error("Runtime Session pool cannot be cleared while a Session is opening.");
    }
    const sessions = [...this.sessions.values()].map((entry) => entry.session);
    this.sessions.clear();
    const results = await Promise.allSettled(
      sessions.map(async (session) => await session.close()),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Runtime Session pool refresh failed.");
    }
  }

  close(): Promise<void> {
    this.seal();
    this.closePromise ??= this.closeAll();
    return this.closePromise;
  }

  seal(): void {
    this.sealed = true;
  }

  private async closeAll(): Promise<void> {
    const pendingResults = await Promise.allSettled(
      [...this.pending.values()].map((pending) => pending.opening),
    );
    const sessions = [...this.sessions.values()].map((entry) => entry.session);
    this.sessions.clear();
    const closeResults = await Promise.allSettled(
      sessions.map(async (session) => await session.close()),
    );
    const errors = [...pendingResults, ...closeResults].flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Runtime Session pool cleanup failed.");
  }
}

function assertMatchingIdentity(
  existing: RuntimeSessionIdentity,
  requested: RuntimeSessionIdentity,
): void {
  if (
    existing.expertId === requested.expertId &&
    existing.runtime.runtimeId === requested.runtime.runtimeId &&
    existing.runtime.revision === requested.runtime.revision &&
    existing.runtime.fingerprint === requested.runtime.fingerprint
  )
    return;
  throw new Error(
    `Runtime context ${requested.contextId} is bound to ${existing.expertId}/${existing.runtime.runtimeId}@${existing.runtime.revision} and cannot be reused with ${requested.expertId}/${requested.runtime.runtimeId}@${requested.runtime.revision}.`,
  );
}
