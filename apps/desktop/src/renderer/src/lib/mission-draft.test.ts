import { describe, expect, it, vi } from "vitest";

import { pruneMissionDrafts, readMissionDraft, writeMissionDraft } from "./mission-draft.ts";

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => {
      value = next;
    }),
    removeItem: vi.fn(() => {
      value = null;
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

  it("prunes completed or deleted Missions", () => {
    const storage = memoryStorage(JSON.stringify({ active: "Keep", completed: "Drop" }));
    pruneMissionDrafts(storage, new Set(["active"]));

    expect(readMissionDraft(storage, "active")).toBe("Keep");
    expect(readMissionDraft(storage, "completed")).toBe("");
  });

  it("fails safely for malformed and unavailable storage", () => {
    expect(readMissionDraft(memoryStorage("{bad-json"), "mission-a")).toBe("");
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
});
