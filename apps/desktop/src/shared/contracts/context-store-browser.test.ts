import { describe, expect, it } from "vitest";

import {
  ReadMissionContextStoreEntrySchema,
  SearchMissionContextStoreSchema,
} from "./context-store-browser.ts";

const target = {
  missionId: "00000000-0000-4000-8000-000000000000",
  storeId: "memory",
  scopeId: "expert:1xddvess309a6gme",
};

describe("mission ContextStore browser contracts", () => {
  it("bounds reads to 64 KiB", () => {
    expect(
      ReadMissionContextStoreEntrySchema.parse({ ...target, id: "overview.md" }),
    ).toMatchObject({ start: 0, maxBytes: 64_000 });
    expect(
      ReadMissionContextStoreEntrySchema.safeParse({
        ...target,
        id: "overview.md",
        maxBytes: 64_001,
      }).success,
    ).toBe(false);
  });

  it("bounds search result and context sizes", () => {
    expect(SearchMissionContextStoreSchema.parse({ ...target, query: "failure" })).toMatchObject({
      maxResults: 50,
      contextLines: 2,
    });
    expect(
      SearchMissionContextStoreSchema.safeParse({ ...target, query: "failure", maxResults: 51 })
        .success,
    ).toBe(false);
  });
});
