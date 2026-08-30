import { describe, expect, it, vi } from "vitest";

import type { MissionChatEntry } from "../../../../shared/contracts/index.ts";
import { MissionLiveEntryStore } from "./mission-live-entry-store.ts";

function assistant(id: string, content: string): MissionChatEntry {
  return {
    id,
    kind: "assistant",
    content,
    streaming: true,
    createdAt: "2026-08-29T00:00:00.000Z",
  };
}

describe("MissionLiveEntryStore", () => {
  it("notifies only the subscriber for the changed entry", () => {
    const store = new MissionLiveEntryStore();
    const first = assistant("first", "a");
    const second = assistant("second", "b");
    store.reset([first, second]);
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    const unsubscribeFirst = store.subscribe(first.id, firstListener);
    const unsubscribeSecond = store.subscribe(second.id, secondListener);

    const updated = assistant("second", "bc");
    store.publish(updated);

    expect(store.get("first")).toBe(first);
    expect(store.get("second")).toBe(updated);
    expect(firstListener).not.toHaveBeenCalled();
    expect(secondListener).toHaveBeenCalledOnce();

    unsubscribeFirst();
    unsubscribeSecond();
  });

  it("does not notify when the exact entry object is published again", () => {
    const store = new MissionLiveEntryStore();
    const entry = assistant("answer", "done");
    store.reset([entry]);
    const listener = vi.fn();
    store.subscribe(entry.id, listener);

    store.publish(entry);

    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies changed and removed entries when a structural snapshot resets the store", () => {
    const store = new MissionLiveEntryStore();
    const unchanged = assistant("unchanged", "same");
    const changed = assistant("changed", "old");
    const removed = assistant("removed", "gone");
    store.reset([unchanged, changed, removed]);
    const unchangedListener = vi.fn();
    const changedListener = vi.fn();
    const removedListener = vi.fn();
    store.subscribe(unchanged.id, unchangedListener);
    store.subscribe(changed.id, changedListener);
    store.subscribe(removed.id, removedListener);

    const replacement = assistant("changed", "new");
    store.reset([unchanged, replacement]);

    expect(unchangedListener).not.toHaveBeenCalled();
    expect(changedListener).toHaveBeenCalledOnce();
    expect(removedListener).toHaveBeenCalledOnce();
    expect(store.get(changed.id)).toBe(replacement);
    expect(store.get(removed.id)).toBeUndefined();
  });
});
