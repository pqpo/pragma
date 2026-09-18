import { describe, expect, it, vi } from "vitest";

import {
  createMissionDraftPersistence,
  removeMissionDrafts,
  readMissionDraft,
  writeMissionDraft,
} from "./mission-draft.ts";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set("pragma.desktop.missions.composer-drafts.v1", initial);
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, next: string) => {
      values.set(key, next);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
}

describe("Mission composer draft persistence", () => {
  it("isolates drafts by Mission id and removes empty drafts", () => {
    const storage = memoryStorage();
    writeMissionDraft(storage, "mission-a", "First");
    writeMissionDraft(storage, "mission-b", "Second");

    expect(readMissionDraft(storage, "mission-a")).toBe("First");
    expect(readMissionDraft(storage, "mission-b")).toBe("Second");

    writeMissionDraft(storage, "mission-a", "");
    expect(readMissionDraft(storage, "mission-a")).toBe("");
    expect(readMissionDraft(storage, "mission-b")).toBe("Second");
  });

  it("migrates only the requested legacy draft", () => {
    const storage = memoryStorage(JSON.stringify({ "mission-a": "First", "mission-b": "Second" }));

    expect(readMissionDraft(storage, "mission-a")).toBe("First");
    expect(storage.setItem).toHaveBeenCalledWith(
      "pragma.desktop.missions.composer-draft.v2.mission-a",
      "First",
    );
    expect(readMissionDraft(storage, "mission-b")).toBe("Second");
  });

  it("writes one Mission without reading or serializing the legacy collection", () => {
    const storage = memoryStorage(JSON.stringify({ other: "x".repeat(10_000) }));
    storage.getItem.mockClear();

    writeMissionDraft(storage, "mission-a", "Changed");

    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).toHaveBeenCalledWith(
      "pragma.desktop.missions.composer-draft.v2.mission-a",
      "Changed",
    );
  });

  it("prunes completed or deleted Missions", () => {
    const storage = memoryStorage(
      JSON.stringify({
        active: "Keep",
        hiddenRevision: "Unsaved revision message",
        completed: "Drop",
        deleted: "Drop",
      }),
    );
    removeMissionDrafts(storage, new Set(["completed", "deleted"]));
    expect(readMissionDraft(storage, "hiddenRevision")).toBe("Unsaved revision message");
    expect(readMissionDraft(storage, "deleted")).toBe("");

    expect(readMissionDraft(storage, "active")).toBe("Keep");
    expect(readMissionDraft(storage, "completed")).toBe("");
  });

  it("fails safely for malformed and unavailable storage", () => {
    expect(readMissionDraft(memoryStorage("{bad-json"), "mission-a")).toBe("");
    expect(
      readMissionDraft(
        {
          getItem: (key) =>
            key === "pragma.desktop.missions.composer-drafts.v1"
              ? JSON.stringify({ "mission-a": "Legacy" })
              : null,
          setItem: () => {
            throw new Error("full");
          },
          removeItem: () => undefined,
        },
        "mission-a",
      ),
    ).toBe("Legacy");
    expect(() =>
      writeMissionDraft(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error("full");
          },
          removeItem: () => undefined,
        },
        "mission-a",
        "Draft",
      ),
    ).not.toThrow();
  });

  it("debounces writes, flushes Mission switches, and cannot resurrect a cleared draft", () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const persistence = createMissionDraftPersistence(storage, 400);

    persistence.schedule("mission-a", "F");
    persistence.schedule("mission-a", "Final");
    expect(storage.setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(399);
    expect(storage.setItem).not.toHaveBeenCalled();
    persistence.schedule("mission-b", "Second");
    expect(readMissionDraft(storage, "mission-a")).toBe("Final");

    persistence.clear("mission-b");
    vi.runAllTimers();
    expect(readMissionDraft(storage, "mission-b")).toBe("");

    persistence.schedule("mission-a", "On exit");
    persistence.dispose();
    expect(readMissionDraft(storage, "mission-a")).toBe("On exit");
    vi.useRealTimers();
  });

  it("cancels pending writes and physically removes completed or deleted Mission drafts", () => {
    vi.useFakeTimers();
    const storage = memoryStorage(JSON.stringify({ "mission-a": "Legacy" }));
    const persistence = createMissionDraftPersistence(storage, 400);

    writeMissionDraft(storage, "mission-a", "Current");
    persistence.schedule("mission-a", "Pending");
    persistence.remove("mission-a");
    vi.runAllTimers();

    expect(readMissionDraft(storage, "mission-a")).toBe("");
    expect(storage.removeItem).toHaveBeenCalledWith(
      "pragma.desktop.missions.composer-draft.v2.mission-a",
    );
    expect(storage.removeItem).toHaveBeenCalledWith("pragma.desktop.missions.composer-drafts.v1");
    vi.useRealTimers();
  });
});
