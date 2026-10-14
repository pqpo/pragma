import { describe, expect, it } from "vitest";
import {
  queryIntegrationMissions,
  queryIntegrationExecutors,
} from "../src/integration-list-query.ts";

describe("Host list queries", () => {
  const missions = [
    {
      id: "b",
      title: "Review patch",
      status: "running",
      workspace: { canonicalPath: "/work" },
      updatedAt: "2026-01-01",
    },
    {
      id: "a",
      title: "Review docs",
      status: "succeeded",
      workspace: { canonicalPath: "/work" },
      updatedAt: "2026-01-01",
    },
    {
      id: "c",
      title: "Other",
      status: "running",
      workspace: { canonicalPath: "/else" },
      updatedAt: "2026-01-02",
    },
  ];
  it("filters title/workspace and breaks ordering ties by ID", () => {
    const first = queryIntegrationMissions(missions, {
      limit: 1,
      query: "review",
      workspace: "/work",
    });
    expect(first.items[0]).toMatchObject({ id: "a" });
    const second = queryIntegrationMissions(missions.toReversed(), {
      limit: 1,
      query: "review",
      workspace: "/work",
      cursor: first.nextCursor,
    });
    expect(second.items[0]).toMatchObject({ id: "b" });
    expect(() =>
      queryIntegrationMissions([...missions, { ...missions[0], id: "d" }], {
        limit: 1,
        query: "review",
        workspace: "/work",
        cursor: first.nextCursor,
      }),
    ).toThrowError(expect.objectContaining({ code: "CURSOR_EXPIRED" }));
    expect(() =>
      queryIntegrationMissions(missions, {
        limit: 1,
        query: "review",
        workspace: "/else",
        cursor: first.nextCursor,
      }),
    ).toThrowError(expect.objectContaining({ code: "CURSOR_INVALID" }));
  });
  it("filters executor kind and offers stable name search", () => {
    const items = [
      { kind: "expert", ref: "expert:aaaaaaaaaaaaaaaa", name: "Research" },
      { kind: "flow", ref: "flow:bbbbbbbbbbbbbbbb", name: "Research flow" },
    ];
    const result = queryIntegrationExecutors(items, {
      executorKind: "expert",
      query: "research",
      limit: 1,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ name: "Research" });
  });
});
