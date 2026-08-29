import { useCallback, useSyncExternalStore } from "react";

import type { MissionChatEntry } from "../../../../shared/contracts/index.ts";

type Listener = () => void;

const NOOP_UNSUBSCRIBE = (): void => undefined;

/**
 * Keeps high-frequency entry content outside the Mission detail component state.
 * Structural snapshots remain authoritative; subscribers only wake for their entry.
 */
export class MissionLiveEntryStore {
  readonly #entries = new Map<string, MissionChatEntry>();
  readonly #listeners = new Map<string, Set<Listener>>();

  get(entryId: string): MissionChatEntry | undefined {
    return this.#entries.get(entryId);
  }

  publish(entry: MissionChatEntry): void {
    if (this.#entries.get(entry.id) === entry) return;
    this.#entries.set(entry.id, entry);
    for (const listener of this.#listeners.get(entry.id) ?? []) listener();
  }

  reset(entries: readonly MissionChatEntry[]): void {
    this.#entries.clear();
    for (const entry of entries) this.#entries.set(entry.id, entry);
  }

  clear(): void {
    this.#entries.clear();
    for (const listeners of this.#listeners.values()) {
      for (const listener of listeners) listener();
    }
  }

  subscribe(entryId: string, listener: Listener): () => void {
    const listeners = this.#listeners.get(entryId) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(entryId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(entryId);
    };
  }
}

export function useMissionLiveEntry(
  store: MissionLiveEntryStore | undefined,
  fallback: MissionChatEntry,
): MissionChatEntry {
  const subscribe = useCallback(
    (listener: Listener) =>
      store === undefined ? NOOP_UNSUBSCRIBE : store.subscribe(fallback.id, listener),
    [fallback.id, store],
  );
  const getSnapshot = useCallback(() => store?.get(fallback.id) ?? fallback, [fallback, store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
