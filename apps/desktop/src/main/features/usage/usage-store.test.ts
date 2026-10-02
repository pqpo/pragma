import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { RuntimeUsageObservation } from "@pragma/core";
import type { Invocation } from "@pragma/shared";
import { afterEach, describe, expect, it } from "vitest";

import {
  createDesktopUsageStore,
  createUnavailableDesktopUsageStore,
  type DesktopUsageStore,
} from "./usage-store.ts";

const directories: string[] = [];
const stores: DesktopUsageStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pragma-usage-"));
  directories.push(directory);
  const databasePath = join(directory, "usage", "usage.sqlite");
  const store = await createDesktopUsageStore({
    databasePath,
    now: new Date("2026-01-01T00:00:00.000Z"),
    timezone: "UTC",
  });
  stores.push(store);
  return { databasePath, store };
}

describe("Desktop usage store", () => {
  it("reports degraded when the usage database is unavailable", async () => {
    const failure = new Error("unsupported usage schema");
    const store = createUnavailableDesktopUsageStore({
      cause: failure,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    await expect(
      store.record(observation(), {
        mission: { id: "mission-1", title: "Mission" },
        invocations: invocationTree(),
        names: new Map(),
      }),
    ).rejects.toMatchObject({ code: "desktop_usage_unavailable", cause: failure });
    await expect(store.getOverview("all")).rejects.toThrow(
      "The original usage database was not modified",
    );
    await expect(store.getMissionUsage("mission-1")).rejects.toMatchObject({
      code: "desktop_usage_unavailable",
      cause: failure,
    });
  });

  it("records token-only observations and attributes ancestors inclusively", async () => {
    const { store } = await fixture();
    await store.record(observation(), {
      mission: { id: "mission-1", title: "Ship usage" },
      invocations: invocationTree(),
      names: new Map([
        ["flow-1", "Release flow"],
        ["team-1", "Platform team"],
        ["expert-1", "Token expert"],
      ]),
    });

    expect((await store.getOverview("all")).totals).toEqual({
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheWrite: 5,
      totalTokens: 155,
    });
    expect((await store.getMissionUsage("mission-1")).usage.totalTokens).toBe(155);
    expect(
      (await store.listSubjects({ period: "all", kind: "expert", offset: 0, limit: 20 })).items,
    ).toMatchObject([{ id: "expert-1", name: "Token expert", usage: { totalTokens: 155 } }]);
    expect(
      (await store.listSubjects({ period: "all", kind: "team", offset: 0, limit: 20 })).items,
    ).toMatchObject([{ id: "team-1", name: "Platform team", usage: { totalTokens: 155 } }]);
    expect(
      (await store.listSubjects({ period: "all", kind: "flow", offset: 0, limit: 20 })).items,
    ).toMatchObject([{ id: "flow-1", name: "Release flow", usage: { totalTokens: 155 } }]);
  });

  it("is idempotent, rejects conflicting duplicates, and ignores pre-activation data", async () => {
    const { store } = await fixture();
    const context = {
      mission: { id: "mission-1", title: "Mission" },
      invocations: invocationTree(),
      names: new Map<string, string>(),
    };
    await store.record(observation(), context);
    await store.record(observation(), context);
    expect((await store.getOverview("all")).totals.totalTokens).toBe(155);
    await expect(
      store.record(
        {
          ...observation(),
          usage: { ...observation().usage, output: 21, totalTokens: 156 },
        },
        context,
      ),
    ).rejects.toThrow("Conflicting usage observation");
    await store.record(
      { ...observation(), observationId: "old", occurredAt: "2025-12-31T23:00:00.000Z" },
      context,
    );
    expect((await store.getOverview("all")).totals.totalTokens).toBe(155);
  });

  it("retains totals but excludes deleted subjects from every ranked list after reopen", async () => {
    const { databasePath, store } = await fixture();
    await store.record(observation(), {
      mission: { id: "mission-1", title: "Private title" },
      invocations: invocationTree(),
      names: new Map([
        ["expert-1", "Private expert"],
        ["team-1", "Private team"],
        ["flow-1", "Private flow"],
      ]),
    });
    await store.markSubjectDeleted("mission", "mission-1");
    await store.reconcileActiveSubjects("expert", new Set());
    await store.reconcileActiveSubjects("team", new Set());
    await store.reconcileActiveSubjects("flow", new Set());
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = await createDesktopUsageStore({ databasePath });
    stores.push(reopened);
    expect((await reopened.getMissionUsage("mission-1")).usage.totalTokens).toBe(155);
    expect((await reopened.getOverview("all")).totals.totalTokens).toBe(155);
    for (const kind of ["mission", "expert", "team", "flow"] as const) {
      expect(
        await reopened.listSubjects({ period: "all", kind, offset: 0, limit: 20 }),
      ).toMatchObject({
        total: 0,
        items: [],
      });
    }
  });

  it("recovers only the positive snapshot delta after a Host write gap", async () => {
    const { store } = await fixture();
    const context = {
      mission: { id: "mission-1", title: "Mission" },
      invocations: invocationTree(),
      names: new Map<string, string>(),
    };
    await store.record(observation(), context);
    await store.recordRecovered(
      {
        ...observation(),
        usage: {
          ...observation().usage,
          input: 140,
          output: 30,
          totalTokens: 205,
        },
      },
      context,
    );
    await store.recordRecovered(
      {
        ...observation(),
        usage: {
          ...observation().usage,
          input: 140,
          output: 30,
          totalTokens: 205,
        },
      },
      context,
    );

    expect((await store.getOverview("all")).totals).toEqual({
      input: 140,
      output: 30,
      cacheRead: 30,
      cacheWrite: 5,
      totalTokens: 205,
    });
  });

  it("uses the ledger timezone for period boundaries and paginates ranked subjects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-usage-period-"));
    directories.push(directory);
    const databasePath = join(directory, "usage", "usage.sqlite");
    const activated = await createDesktopUsageStore({
      databasePath,
      now: new Date("2025-12-01T00:00:00.000Z"),
      timezone: "America/Los_Angeles",
    });
    await activated.close();

    const store = await createDesktopUsageStore({
      databasePath,
      now: new Date("2026-01-08T07:30:00.000Z"),
      timezone: "UTC",
    });
    stores.push(store);
    const context = {
      mission: { id: "mission-1", title: "Mission" },
      invocations: invocationTree(),
      names: new Map<string, string>(),
    };
    await store.record(
      {
        ...observation(),
        observationId: "outside-seven-days",
        occurredAt: "2026-01-01T07:59:00.000Z",
      },
      context,
    );
    await store.record(
      {
        ...observation(),
        observationId: "first-local-day",
        occurredAt: "2026-01-01T08:00:00.000Z",
      },
      context,
    );
    await store.record(
      {
        ...observation(),
        observationId: "last-local-day",
        occurredAt: "2026-01-08T07:00:00.000Z",
        executor: { id: "expert-2", name: "Second expert" },
      },
      context,
    );

    const overview = await store.getOverview("7d");
    expect(overview.daily).toHaveLength(7);
    expect(overview.daily.map((item) => item.date)).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
      "2026-01-05",
      "2026-01-06",
      "2026-01-07",
    ]);
    expect(overview.totals.totalTokens).toBe(310);
    expect(
      await store.listSubjects({ period: "7d", kind: "expert", offset: 0, limit: 1 }),
    ).toMatchObject({
      total: 2,
      items: [{ id: "expert-1" }],
    });
    expect(
      await store.listSubjects({ period: "7d", kind: "expert", offset: 1, limit: 1 }),
    ).toMatchObject({
      total: 2,
      items: [{ id: "expert-2" }],
    });
    expect((await store.getOverview("30d")).totals.totalTokens).toBe(465);
  });

  it("returns zero usage and keeps the revision stable for unknown Missions", async () => {
    const { store } = await fixture();
    const before = (await store.getOverview("all")).revision;

    expect((await store.getMissionUsage("missing")).usage).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    });
    await store.markSubjectDeleted("mission", "missing");
    expect((await store.getOverview("all")).revision).toBe(before);
  });

  it("rejects a future schema without mutating it with current tables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-usage-future-"));
    directories.push(directory);
    const databasePath = join(directory, "usage.sqlite");
    const future = new DatabaseSync(databasePath);
    future.exec(`
      CREATE TABLE usage_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO usage_metadata(key, value)
      VALUES ('schemaVersion', 'pragma.desktop-usage/v2');
    `);
    future.close();

    await expect(createDesktopUsageStore({ databasePath })).rejects.toThrow(
      "Unsupported Desktop usage schema: pragma.desktop-usage/v2.",
    );
    const inspected = new DatabaseSync(databasePath);
    expect(
      inspected
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_observations'",
        )
        .get(),
    ).toBeUndefined();
    inspected.close();
  });
});

function observation(): RuntimeUsageObservation {
  return {
    observationId: "observation-1",
    occurredAt: "2026-01-02T12:00:00.000Z",
    executionId: "execution-1",
    invocationId: "expert-invocation",
    contextId: "context-1",
    runId: "run-1",
    runtimeId: "runtime-1",
    modelSelection: {
      model: { providerId: "provider-1", modelId: "model-1" },
    },
    executor: { id: "expert-1", name: "expert-1" },
    usage: {
      measurement: "reported",
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheWrite: 5,
      totalTokens: 155,
      cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9, total: 36 },
    },
  };
}

function invocationTree(): Invocation[] {
  const base = {
    rootInvocationId: "flow-invocation",
    contextId: "context-1",
    status: "running" as const,
    pendingExpertMessages: [],
    input: {},
    createdAt: "2026-01-02T12:00:00.000Z",
    updatedAt: "2026-01-02T12:00:00.000Z",
  };
  return [
    {
      ...base,
      invocationId: "flow-invocation",
      definition: { id: "flow-1", kind: "flow" },
    },
    {
      ...base,
      invocationId: "team-invocation",
      parentInvocationId: "flow-invocation",
      definition: { id: "team-1", kind: "expert-team" },
    },
    {
      ...base,
      invocationId: "expert-invocation",
      parentInvocationId: "team-invocation",
      definition: { id: "expert-1", kind: "expert" },
      executorId: "expert-1",
    },
  ];
}
