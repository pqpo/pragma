import { describe, expect, it } from "vitest";

import {
  MissionContextStoreContentSchema,
  MissionContextStoreDescriptorSchema,
  MissionContextStoreEntrySchema,
  TeamMemoryContextStoreDescriptorSchema,
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

  it("describes Mission Board preview types and accepts encoded image payloads", () => {
    expect(
      MissionContextStoreEntrySchema.parse({
        id: "preview.png",
        metadata: { trigger: "manual", priority: "normal" },
        mediaType: "image/png",
        previewKind: "image",
      }),
    ).toMatchObject({ mediaType: "image/png", previewKind: "image" });
    expect(
      MissionContextStoreContentSchema.safeParse({
        id: "preview.png",
        metadata: { trigger: "manual", priority: "normal" },
        mediaType: "image/png",
        previewKind: "image",
        contentEncoding: "base64",
        content: "AA==",
        contentRange: {
          requestedStartOffset: 0,
          startOffset: 0,
          endOffset: 1,
          nextStartOffset: 1,
          truncated: false,
        },
      }).success,
    ).toBe(true);
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

  it("represents empty multi-scope Team Memory browsers in the v2 IPC contract", () => {
    const scopes = [
      {
        id: "team:vyv9pwwzaksth2dd",
        expertId: "vyv9pwwzaksth2dd",
        name: "Editorial Team",
        role: "root" as const,
        participation: "available" as const,
        availability: "empty" as const,
      },
      {
        id: "expert:1xddvess309a6gme",
        expertId: "1xddvess309a6gme",
        name: "Writer",
        role: "coordinator" as const,
        participation: "available" as const,
        availability: "available" as const,
      },
    ];
    expect(
      TeamMemoryContextStoreDescriptorSchema.parse({
        schemaVersion: "pragma.desktop-team-memory-context-store/v2",
        teamRef: "team:vyv9pwwzaksth2dd",
        storeId: "memory",
        namespace: "memory",
        name: "Memory ContextStore",
        readOnly: true,
        searchable: true,
        hasMemory: true,
        root: {
          type: "pragma.expert-team",
          id: "vyv9pwwzaksth2dd",
          name: "Editorial Team",
        },
        defaultScopeId: scopes[0]!.id,
        scopes,
      }).scopes,
    ).toHaveLength(2);
    expect(
      MissionContextStoreDescriptorSchema.shape.schemaVersion.parse(
        "pragma.desktop-mission-context-store/v2",
      ),
    ).toBe("pragma.desktop-mission-context-store/v2");
  });
});
