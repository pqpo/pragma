import type { RuntimeAgentSession } from "../runtime/runtime-adapter.ts";
import type { RuntimeEnvironmentBinding } from "@pragma/shared";

export interface RuntimeSessionIdentity {
  readonly contextId: string;
  readonly expertId: string;
  readonly runtime: RuntimeEnvironmentBinding;
  readonly hostContextBindingsFingerprint?: string | undefined;
}

export interface RuntimeSessionCreateOptions {
  readonly fresh: boolean;
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
  private readonly freshContexts = new Set<string>();
  private readonly retiredCleanup = new Map<RuntimeAgentSession, Promise<void>>();
  private readonly failedRetirements = new Set<RuntimeAgentSession>();
  private readonly retiring = new Map<RuntimeAgentSession, Promise<void>>();
  private sealed = false;
  private closePromise: Promise<void> | undefined;

  async acquire(
    identity: RuntimeSessionIdentity,
    create: (options: RuntimeSessionCreateOptions) => Promise<RuntimeAgentSession>,
  ): Promise<RuntimeAgentSession> {
    if (this.sealed) {
      throw new Error("Runtime Session pool is closed.");
    }

    let fresh = this.freshContexts.delete(identity.contextId);
    while (true) {
      if (this.sealed) {
        throw new Error("Runtime Session pool is closed.");
      }
      const existing = this.sessions.get(identity.contextId);
      if (existing !== undefined) {
        assertMatchingIdentity(existing.identity, identity);
        if (hostContextBindingsMatch(existing.identity, identity)) return existing.session;
        this.sessions.delete(identity.contextId);
        await existing.session.close();
        fresh = true;
        continue;
      }

      const pending = this.pending.get(identity.contextId);
      if (pending !== undefined) {
        assertMatchingIdentity(pending.identity, identity);
        await pending.opening;
        fresh = true;
        continue;
      }

      const opening = create({ fresh }).then(async (session) => {
        if (this.sealed) {
          this.invalidate(session);
          await this.retiring.get(session);
          throw Object.assign(new Error("Runtime Session pool closed while opening a session."), {
            code: "RUNTIME_POOL_OPENING_SEALED",
          });
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
  }

  get(identity: RuntimeSessionIdentity): RuntimeAgentSession | undefined {
    const existing = this.sessions.get(identity.contextId);
    if (existing === undefined) return undefined;
    assertMatchingIdentity(existing.identity, identity);
    return existing.session;
  }

  async release(identity: RuntimeSessionIdentity): Promise<void> {
    const entry = this.sessions.get(identity.contextId);
    if (entry === undefined) return;
    assertMatchingIdentity(entry.identity, identity);
    await entry.session.close();
    if (this.sessions.get(identity.contextId) === entry) this.sessions.delete(identity.contextId);
  }

  /**
   * Removes an unhealthy Runtime Session without waiting for its provider to
   * acknowledge close. The next acquire for this Context must start fresh: a
   * provider that did not settle an interrupt cannot safely resume the same
   * native conversation while its previous turn may still be alive.
   */
  invalidate(session: RuntimeAgentSession): void {
    for (const [contextId, entry] of this.sessions) {
      if (entry.session !== session) continue;
      this.sessions.delete(contextId);
      this.freshContexts.add(contextId);
    }
    const closing = Promise.resolve().then(
      async () => await (session.stopForDeletion?.() ?? session.close()),
    );
    if (session.stopForDeletion !== undefined) {
      const cleanup = closing.then(async () => await session.close());
      this.retiredCleanup.set(session, cleanup);
      void cleanup.then(
        () => {
          if (this.retiredCleanup.get(session) === cleanup) this.retiredCleanup.delete(session);
        },
        () => undefined,
      );
    }
    this.retiring.set(session, closing);
    void closing.then(
      () => this.retiring.delete(session),
      () => {
        this.failedRetirements.add(session);
      },
    );
  }

  async clear(): Promise<void> {
    if (this.sealed) throw new Error("Runtime Session pool is closed.");
    if (this.pending.size > 0) {
      throw new Error("Runtime Session pool cannot be cleared while a Session is opening.");
    }
    const entries = [...this.sessions.entries()];
    const results = await Promise.allSettled(
      entries.map(async ([contextId, entry]) => {
        await entry.session.close();
        if (this.sessions.get(contextId) === entry) this.sessions.delete(contextId);
      }),
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
    if (this.closePromise === undefined) {
      this.closePromise = this.closeAll();
      void this.closePromise.catch(() => {
        this.closePromise = undefined;
      });
    }
    return this.closePromise;
  }

  async finishDeletion(): Promise<void> {
    await Promise.all([this.close(), ...this.retiredCleanup.values()]);
  }

  async closeForDeletion(): Promise<void> {
    this.seal();
    for (const session of this.failedRetirements) {
      this.failedRetirements.delete(session);
      this.invalidate(session);
    }
    const openingResults = await Promise.allSettled(
      [...this.pending.values()].map((pending) => pending.opening),
    );
    const results = await Promise.allSettled([
      ...[...this.sessions.values()].map(async ({ session }) => {
        if (session.stopForDeletion !== undefined) await session.stopForDeletion();
        else {
          await session.close();
          for (const [contextId, entry] of this.sessions)
            if (entry.session === session) this.sessions.delete(contextId);
        }
      }),
      ...this.retiring.values(),
    ]);
    const errors = [...openingResults, ...results].flatMap((result) =>
      result.status === "rejected" && !isSealedOpening(result.reason)
        ? [result.reason as unknown]
        : [],
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length > 0)
      throw new AggregateError(errors, "Runtime deletion stop was not confirmed.");
  }

  seal(): void {
    this.sealed = true;
  }

  private async closeAll(): Promise<void> {
    const pendingResults = await Promise.allSettled(
      [...this.pending.values()].map((pending) => pending.opening),
    );
    const sessions = [...this.sessions.values()].map((entry) => entry.session);
    this.freshContexts.clear();
    const closeResults = await Promise.allSettled(
      sessions.map(async (session) => {
        await session.close();
        for (const [contextId, entry] of this.sessions) {
          if (entry.session === session) this.sessions.delete(contextId);
        }
      }),
    );
    const errors = [...pendingResults, ...closeResults].flatMap((result) =>
      result.status === "rejected" && !isSealedOpening(result.reason)
        ? [result.reason as unknown]
        : [],
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

function hostContextBindingsMatch(
  existing: RuntimeSessionIdentity,
  requested: RuntimeSessionIdentity,
): boolean {
  return existing.hostContextBindingsFingerprint === requested.hostContextBindingsFingerprint;
}

function isSealedOpening(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "RUNTIME_POOL_OPENING_SEALED";
}
