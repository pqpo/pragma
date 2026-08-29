import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeUsageObservation } from "@pragma/core";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalHostUsageSink } from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Local Host UsageSink", () => {
  it("persists exact observations once and tolerates replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-local-usage-"));
    roots.push(root);
    const sink = createLocalHostUsageSink({ path: join(root, "usage", "observations.json") });
    const observation = fixtureObservation();

    await sink.record(observation);
    await sink.record(observation);

    await expect(sink.list()).resolves.toEqual([observation]);
  });

  it("rejects a conflicting replay with the same observation identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-local-usage-conflict-"));
    roots.push(root);
    const sink = createLocalHostUsageSink({ path: join(root, "usage", "observations.json") });
    await sink.record(fixtureObservation());

    await expect(
      sink.record({
        ...fixtureObservation(),
        usage: { ...fixtureObservation().usage, output: 99, totalTokens: 99 },
      }),
    ).rejects.toThrow("Conflicting usage observation");
  });
});

function fixtureObservation(): RuntimeUsageObservation {
  return {
    observationId: "obs-1",
    occurredAt: "2026-08-25T00:00:00.000Z",
    executionId: "execution-1",
    invocationId: "invocation-1",
    contextId: "context-1",
    runId: "run-1",
    runtimeId: "codex-local",
    executor: { id: "expert-1", name: "Expert" },
    usage: {
      measurement: "reported",
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
