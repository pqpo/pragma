import { describe, expect, it } from "vitest";
import {
  queryIntegrationMissions,
  queryIntegrationExecutors,
  queryIntegrationMissionsWithDiagnostics,
} from "../src/integration-list-query.ts";
import {
  createIntegrationError,
  ListPageResultSchema,
  MissionListDiagnosticsPageSchema,
} from "@pragma/shared/integration";

describe("Host list queries", () => {
  it("keeps unavailable-owner diagnostics on filtered paged results with an explicit version", () => {
    const error = createIntegrationError({
      code: "STORAGE_CORRUPTED",
      category: "protocol",
      message: "Unreadable owner",
    });
    const page = queryIntegrationMissionsWithDiagnostics(
      {
        items: [
          { id: "b", title: "Match B" },
          { id: "a", title: "Match A" },
          { id: "c", title: "Other" },
        ],
        diagnostics: [error],
        warnings: [],
      },
      { limit: 1, query: "Match" },
    );
    expect(MissionListDiagnosticsPageSchema.safeParse(page).success).toBe(true);
    expect(ListPageResultSchema.safeParse(page).success).toBe(false);
    expect(page).toMatchObject({
      schemaVersion: "pragma.mission-list-page/v2",
      partial: true,
      items: [{ id: "a" }],
      diagnostics: [error],
    });
    expect(page.nextCursor).toBeDefined();
    const second = queryIntegrationMissionsWithDiagnostics(
      {
        items: [
          { id: "b", title: "Match B" },
          { id: "a", title: "Match A" },
          { id: "c", title: "Other" },
        ],
        diagnostics: [error],
        warnings: [],
      },
      { limit: 1, query: "Match", cursor: page.nextCursor },
    );
    expect(second.items).toEqual([{ id: "b", title: "Match B" }]);
  });
  it("fails closed if diagnostics contain no readable owner", () => {
    const error = createIntegrationError({
      code: "STORAGE_VERSION_UNSUPPORTED",
      category: "protocol",
      message: "Future owner",
    });
    expect(() =>
      queryIntegrationMissionsWithDiagnostics(
        { items: [], diagnostics: [error], warnings: [] },
        { limit: 1 },
      ),
    ).toThrowError(expect.objectContaining({ code: "STORAGE_VERSION_UNSUPPORTED" }));
  });
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
  it("binds executor cursors to full/summary projection and the exact byte budget", () => {
    const items = ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"].map((id) => ({
      kind: "expert",
      ref: `expert:${id}`,
      name: "Research",
      description: "x".repeat(1000),
    }));
    for (const maxContentBytes of [undefined, 500, 1000]) {
      const request = { executorKind: "expert" as const, limit: 1, maxContentBytes };
      const first = queryIntegrationExecutors(items, request);
      expect(
        queryIntegrationExecutors(items, { ...request, cursor: first.nextCursor }).items,
      ).toHaveLength(1);
      for (const changed of [undefined, 500, 1000].filter((value) => value !== maxContentBytes)) {
        expect(() =>
          queryIntegrationExecutors(items, {
            ...request,
            maxContentBytes: changed,
            cursor: first.nextCursor,
          }),
        ).toThrowError(expect.objectContaining({ code: "CURSOR_INVALID" }));
      }
    }
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
