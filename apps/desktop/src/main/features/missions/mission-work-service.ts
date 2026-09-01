import type { MissionChatEntry, MissionWorkSnapshot } from "../../../shared/contracts/index.ts";
import type {
  MissionSurfaceAudience,
  MissionWorkNotification,
} from "./mission-runner-contracts.ts";

export interface MissionWorkProjection {
  readonly revision: number;
  readonly executionSignature: string;
  readonly executionCount: number;
  readonly snapshot: MissionWorkSnapshot;
  readonly entriesByRecordId: ReadonlyMap<string, readonly MissionChatEntry[]>;
}

export interface MissionLiveWorkProjection {
  readonly entries: readonly MissionChatEntry[];
}

export class MissionWorkService<TLiveWork extends MissionLiveWorkProjection> {
  readonly #listeners = new Set<(notification: MissionWorkNotification) => void>();
  readonly #revisions = new Map<string, number>();
  readonly #liveOutputs = new Map<string, Map<string, TLiveWork>>();
  readonly #projectionCache = new Map<string, MissionWorkProjection>();
  readonly #projectionLoads = new Map<
    string,
    {
      readonly revision: number;
      readonly executionSignature: string;
      readonly promise: Promise<MissionWorkProjection>;
    }
  >();

  constructor(
    private readonly onListenerError: (input: {
      readonly error: unknown;
      readonly missionId: string;
    }) => void,
  ) {}

  revision(missionId: string): number {
    return this.#revisions.get(missionId) ?? 0;
  }

  invalidate(missionId: string, audience: MissionSurfaceAudience): void {
    const revision = this.revision(missionId) + 1;
    this.#revisions.set(missionId, revision);
    this.#projectionCache.delete(missionId);
    const update = { missionId, revision };
    for (const listener of this.#listeners) {
      try {
        listener({ audience, update });
      } catch (error) {
        this.onListenerError({ error, missionId });
      }
    }
  }

  subscribe(listener: (notification: MissionWorkNotification) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  live(missionId: string, recordId: string): TLiveWork | undefined {
    return this.#liveOutputs.get(missionId)?.get(recordId);
  }

  getOrCreateLive(
    missionId: string,
    recordId: string,
    create: () => TLiveWork,
  ): { readonly value: TLiveWork; readonly created: boolean } {
    const byRecord = this.#liveOutputs.get(missionId) ?? new Map<string, TLiveWork>();
    const existing = byRecord.get(recordId);
    if (existing !== undefined) return { value: existing, created: false };
    const value = create();
    byRecord.set(recordId, value);
    this.#liveOutputs.set(missionId, byRecord);
    return { value, created: true };
  }

  clearLive(missionId: string): void {
    this.#liveOutputs.delete(missionId);
  }

  cached(
    missionId: string,
    revision: number,
    executionSignature: string,
  ): MissionWorkProjection | undefined {
    const cached = this.#projectionCache.get(missionId);
    if (cached?.revision !== revision || cached.executionSignature !== executionSignature) {
      return undefined;
    }
    this.#projectionCache.delete(missionId);
    this.#projectionCache.set(missionId, cached);
    return cached;
  }

  loading(
    missionId: string,
    revision: number,
    executionSignature: string,
  ): Promise<MissionWorkProjection> | undefined {
    const load = this.#projectionLoads.get(missionId);
    return load?.revision === revision && load.executionSignature === executionSignature
      ? load.promise
      : undefined;
  }

  beginLoad(
    missionId: string,
    revision: number,
    executionSignature: string,
    promise: Promise<MissionWorkProjection>,
  ): void {
    this.#projectionLoads.set(missionId, { revision, executionSignature, promise });
  }

  finishLoad(missionId: string, promise: Promise<MissionWorkProjection>): void {
    if (this.#projectionLoads.get(missionId)?.promise === promise) {
      this.#projectionLoads.delete(missionId);
    }
  }

  cache(missionId: string, projection: MissionWorkProjection): void {
    this.#projectionCache.delete(missionId);
    this.#projectionCache.set(missionId, projection);
    while (this.#projectionCache.size > 5) {
      const oldest = this.#projectionCache.keys().next();
      if (!oldest.done) this.#projectionCache.delete(oldest.value);
    }
  }

  clear(missionId: string): void {
    this.#revisions.delete(missionId);
    this.#projectionCache.delete(missionId);
    this.#projectionLoads.delete(missionId);
    this.#liveOutputs.delete(missionId);
  }
}
