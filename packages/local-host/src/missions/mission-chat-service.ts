import { randomUUID } from "node:crypto";

import type { RuntimeContextWindowUsage } from "@pragma/core";

import type { MissionChatPatch, MissionChatUpdate } from "@pragma/shared";
import type {
  MissionChatNotification,
  MissionSurfaceAudience,
} from "./mission-runner-contracts.ts";

export interface MissionLiveChatProjection {
  close: () => Promise<void>;
}

export class MissionChatService<TLiveChat extends MissionLiveChatProjection> {
  readonly #streamId = randomUUID();
  readonly #reads = new Map<
    string,
    { missionId: string; promise: Promise<unknown>; coalesced: number }
  >();
  readonly #readEpochs = new Map<string, number>();
  #nextReadEpoch = 0;
  readonly #listeners = new Set<(notification: MissionChatNotification) => void>();
  readonly #revisions = new Map<string, number>();
  readonly #invalidationRevisions = new Map<string, number>();
  readonly #degradedSync = new Set<string>();
  readonly #liveChats = new Map<string, TLiveChat>();
  readonly #contextWindows = new Map<string, RuntimeContextWindowUsage>();

  constructor(
    private readonly onListenerError: (input: {
      readonly error: unknown;
      readonly missionId: string;
    }) => void,
    private readonly onReadCompleted?:
      | ((input: {
          missionId: string;
          kind: string;
          audience: MissionSurfaceAudience;
          coalesced: number;
          elapsedMs: number;
        }) => void)
      | undefined,
  ) {}

  read<T>(
    missionId: string,
    audience: MissionSurfaceAudience,
    kind: string,
    query: unknown,
    load: (assertCurrent: () => void) => Promise<T>,
  ): Promise<T> {
    const epoch = this.#readEpochs.get(missionId) ?? ++this.#nextReadEpoch;
    this.#readEpochs.set(missionId, epoch);
    const key = JSON.stringify([missionId, audience, kind, query, epoch, this.revision(missionId)]);
    const existing = this.#reads.get(key);
    if (existing !== undefined) {
      existing.coalesced++;
      return existing.promise as Promise<T>;
    }
    const startedAt = performance.now();
    const assertCurrent = () => {
      if (this.#readEpochs.get(missionId) !== epoch)
        throw new Error("Mission read was superseded by resource release.");
    };
    const promise = Promise.resolve()
      .then(() => {
        assertCurrent();
        return load(assertCurrent);
      })
      .then((value) => {
        assertCurrent();
        return value;
      })
      .finally(() => {
        const pendingRead = this.#reads.get(key);
        try {
          this.onReadCompleted?.({
            missionId,
            kind,
            audience,
            coalesced: pendingRead?.coalesced ?? 0,
            elapsedMs: performance.now() - startedAt,
          });
        } catch {
          /* Diagnostics must not affect reads. */
        }
        if (pendingRead?.promise === promise) this.#reads.delete(key);
        if (
          this.#readEpochs.get(missionId) === epoch &&
          ![...this.#reads.values()].some((read) => read.missionId === missionId)
        )
          this.#readEpochs.delete(missionId);
      });
    this.#reads.set(key, { missionId, promise, coalesced: 0 });
    return promise;
  }

  revision(missionId: string): number {
    return this.#revisions.get(missionId) ?? 0;
  }

  /** Changes that require a history read; live text patches do not advance this watermark. */
  invalidationRevision(missionId: string): number {
    return this.#invalidationRevisions.get(missionId) ?? 0;
  }

  live(missionId: string): TLiveChat | undefined {
    return this.#liveChats.get(missionId);
  }

  setLive(missionId: string, live: TLiveChat): TLiveChat | undefined {
    const previous = this.#liveChats.get(missionId);
    this.#liveChats.set(missionId, live);
    return previous;
  }

  detachLiveIfCurrent(missionId: string, expected: TLiveChat): TLiveChat | undefined {
    if (this.#liveChats.get(missionId) !== expected) return undefined;
    this.#liveChats.delete(missionId);
    return expected;
  }

  async closeLiveIfCurrent(missionId: string, expected: TLiveChat): Promise<void> {
    if (this.#liveChats.get(missionId) !== expected) return;
    await expected.close();
    if (this.#liveChats.get(missionId) === expected) this.#liveChats.delete(missionId);
  }

  contextWindow(missionId: string): RuntimeContextWindowUsage | undefined {
    return this.#contextWindows.get(missionId);
  }

  setContextWindow(missionId: string, usage: RuntimeContextWindowUsage): void {
    this.#contextWindows.set(missionId, usage);
  }

  clearContextWindow(missionId: string): void {
    this.#contextWindows.delete(missionId);
  }

  markSyncDegraded(missionId: string): boolean {
    const firstTransition = !this.#degradedSync.has(missionId);
    this.#degradedSync.add(missionId);
    return firstTransition;
  }

  markSyncRecovered(missionId: string): boolean {
    return this.#degradedSync.delete(missionId);
  }

  emitPatches(
    missionId: string,
    audience: MissionSurfaceAudience,
    patches: readonly MissionChatPatch[],
  ): void {
    if (patches.length === 0) return;
    this.#emit(missionId, audience, { kind: "patch", patches });
  }

  invalidate(
    missionId: string,
    audience: MissionSurfaceAudience,
    options: { readonly userVisibleOutput?: true | undefined } = {},
  ): void {
    this.#emit(missionId, audience, {
      kind: "invalidate",
      ...(options.userVisibleOutput === true ? { userVisibleOutput: true } : {}),
    });
  }

  subscribe(listener: (notification: MissionChatNotification) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  clearReads(missionId: string): void {
    this.#readEpochs.delete(missionId);
    for (const [key, read] of this.#reads) {
      if (read.missionId === missionId) this.#reads.delete(key);
    }
  }

  async clear(missionId: string): Promise<void> {
    this.clearReads(missionId);
    const live = this.#liveChats.get(missionId);
    if (live !== undefined) await live.close();
    this.#liveChats.delete(missionId);
    this.#revisions.delete(missionId);
    this.#invalidationRevisions.delete(missionId);
    this.#degradedSync.delete(missionId);
    this.#contextWindows.delete(missionId);
  }

  #emit(
    missionId: string,
    audience: MissionSurfaceAudience,
    update:
      | { readonly kind: "patch"; readonly patches: readonly MissionChatPatch[] }
      | { readonly kind: "invalidate"; readonly userVisibleOutput?: true | undefined },
  ): void {
    const revision = this.revision(missionId) + 1;
    this.#revisions.set(missionId, revision);
    if (update.kind === "invalidate") this.#invalidationRevisions.set(missionId, revision);
    const value: MissionChatUpdate =
      update.kind === "patch"
        ? {
            missionId,
            streamId: this.#streamId,
            revision,
            kind: "patch",
            patches: [...update.patches],
          }
        : {
            missionId,
            streamId: this.#streamId,
            revision,
            kind: "invalidate",
            ...(update.userVisibleOutput === true ? { userVisibleOutput: true } : {}),
          };
    for (const listener of this.#listeners) {
      try {
        listener({ audience, update: value });
      } catch (error) {
        this.onListenerError({ error, missionId });
      }
    }
  }
}
