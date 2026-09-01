import type { RuntimeContextWindowUsage } from "@pragma/core";

import type { MissionChatPatch, MissionChatUpdate } from "../../../shared/contracts/index.ts";
import type {
  MissionChatNotification,
  MissionSurfaceAudience,
} from "./mission-runner-contracts.ts";

export interface MissionLiveChatProjection {
  close: () => Promise<void>;
}

export class MissionChatService<TLiveChat extends MissionLiveChatProjection> {
  readonly #listeners = new Set<(notification: MissionChatNotification) => void>();
  readonly #revisions = new Map<string, number>();
  readonly #degradedSync = new Set<string>();
  readonly #liveChats = new Map<string, TLiveChat>();
  readonly #contextWindows = new Map<string, RuntimeContextWindowUsage>();

  constructor(
    private readonly onListenerError: (input: {
      readonly error: unknown;
      readonly missionId: string;
    }) => void,
  ) {}

  revision(missionId: string): number {
    return this.#revisions.get(missionId) ?? 0;
  }

  live(missionId: string): TLiveChat | undefined {
    return this.#liveChats.get(missionId);
  }

  setLive(missionId: string, live: TLiveChat): void {
    this.#liveChats.set(missionId, live);
  }

  async closeLiveIfCurrent(missionId: string, expected: TLiveChat): Promise<void> {
    if (this.#liveChats.get(missionId) !== expected) return;
    await expected.close();
    this.#liveChats.delete(missionId);
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

  invalidate(missionId: string, audience: MissionSurfaceAudience): void {
    this.#emit(missionId, audience, { kind: "invalidate" });
  }

  subscribe(listener: (notification: MissionChatNotification) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async clear(missionId: string): Promise<void> {
    const live = this.#liveChats.get(missionId);
    if (live !== undefined) await live.close();
    this.#liveChats.delete(missionId);
    this.#revisions.delete(missionId);
    this.#degradedSync.delete(missionId);
    this.#contextWindows.delete(missionId);
  }

  #emit(
    missionId: string,
    audience: MissionSurfaceAudience,
    update:
      | { readonly kind: "patch"; readonly patches: readonly MissionChatPatch[] }
      | { readonly kind: "invalidate" },
  ): void {
    const revision = this.revision(missionId) + 1;
    this.#revisions.set(missionId, revision);
    const value: MissionChatUpdate =
      update.kind === "patch"
        ? { missionId, revision, kind: "patch", patches: [...update.patches] }
        : { missionId, revision, kind: "invalidate" };
    for (const listener of this.#listeners) {
      try {
        listener({ audience, update: value });
      } catch (error) {
        this.onListenerError({ error, missionId });
      }
    }
  }
}
