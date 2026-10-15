import { describe, expect, it } from "vitest";
import { paginateIntegrationItems } from "../src/integration-pagination.ts";

describe("integration list pagination", () => {
  it("retains full bindings and diagnoses malformed, legacy and future cursors", () => {
    const first = paginateIntegrationItems([1, 2], { limit: 1 }, "mission.list");
    expect(first.nextCursor).toHaveLength(97);
    for (const cursor of ["p3.unknown", "p2.bad", first.nextCursor!.slice(0, -1) + "!"]) {
      expect(() =>
        paginateIntegrationItems([1, 2], { limit: 1, cursor }, "mission.list"),
      ).toThrowError(expect.objectContaining({ code: "CURSOR_INVALID" }));
    }
    expect(() =>
      paginateIntegrationItems(
        [1, 2],
        { limit: 1, cursor: "pragma.cli.cursor.v2.legacy" },
        "mission.list",
      ),
    ).toThrowError(expect.objectContaining({ code: "CURSOR_EXPIRED" }));
    expect(() => paginateIntegrationItems([1, 2], { limit: 201 }, "mission.list")).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
  });

  it("continues in a fresh query and expires changed results", () => {
    const items = [{ requestId: "one" }, { requestId: "two" }];
    const first = paginateIntegrationItems(items, { limit: 1 }, "mission.queue.list", {
      missionId: "m1",
    });
    expect(first.items).toEqual([items[0]]);
    expect(first.nextCursor).toBeDefined();
    const second = paginateIntegrationItems(
      JSON.parse(JSON.stringify(items)),
      { limit: 1, cursor: first.nextCursor },
      "mission.queue.list",
      { missionId: "m1" },
    );
    expect(second.items).toEqual([items[1]]);
    expect(second.nextCursor).toBeUndefined();
    expect(() =>
      paginateIntegrationItems(
        items.slice(1),
        { limit: 1, cursor: first.nextCursor },
        "mission.queue.list",
        { missionId: "m1" },
      ),
    ).toThrowError(expect.objectContaining({ code: "CURSOR_EXPIRED" }));
    expect(() =>
      paginateIntegrationItems(
        items,
        { limit: 1, cursor: first.nextCursor },
        "mission.queue.list",
        { missionId: "m2" },
      ),
    ).toThrowError(expect.objectContaining({ code: "CURSOR_INVALID" }));
  });
});
