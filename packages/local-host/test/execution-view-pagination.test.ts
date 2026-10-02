import { createTestExecutionStore } from "./execution-test-host.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { StoredExecutionView } from "@pragma/core";
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
it("uses bounded cursor reads through sparse scopes and preserves page boundaries", async () => {
  const home = await mkdtemp(join(tmpdir(), "pragma-view-page-"));
  homes.push(home);
  const store = createTestExecutionStore({ pragmaHome: home });
  const timestamp = new Date().toISOString();
  const definition = { kind: "flow" as const, id: "flow" };
  const root = {
    invocationId: "root",
    rootInvocationId: "root",
    contextId: "context",
    definition,
    status: "running" as const,
    input: null,
    pendingExpertMessages: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await store.create(
    {
      schemaVersion: "pragma.execution/v12",
      executionId: "execution",
      version: 0,
      kind: "flow",
      definition,
      rootInvocationId: "root",
      status: "running",
      input: null,
      state: {},
      lastAppliedSequence: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    root,
  );
  await store.commit({
    executionId: "execution",
    commitId: "seed",
    invocationPuts: [{ ...root, invocationId: "child", parentInvocationId: "root" }],
    events: Array.from({ length: 10 }, (_, index) => ({
      eventId: `event-${index + 1}`,
      invocationId: (index + 1) % 3 === 0 ? "root" : "child",
      type: "progress",
      data: index,
    })),
  });
  const reads = vi.spyOn(store, "readEvents");
  const invocations = vi.spyOn(store, "listInvocations");
  const view = new StoredExecutionView("execution", store);
  const first = await view.listEvents({ limit: 2 });
  expect(first.items.map((event) => event.cursor.sequence)).toEqual([3, 6]);
  expect(first.nextCursor?.sequence).toBe(6);
  const second = await view.listEvents({ limit: 2, after: first.nextCursor });
  expect(second.items.map((event) => event.cursor.sequence)).toEqual([9]);
  expect(second.nextCursor).toBeUndefined();
  expect(invocations).not.toHaveBeenCalled();
  expect(reads.mock.calls.every((call) => call[2] === 3)).toBe(true);
  const all = await view.listEvents({ scope: { kind: "all" }, limit: 2 });
  expect(all.items.map((event) => event.cursor.sequence)).toEqual([1, 2]);
  expect(all.nextCursor?.sequence).toBe(2);
});
