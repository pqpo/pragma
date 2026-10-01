import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileCanonicalEventFeed, type RuntimeUsageObservation } from "@pragma/core";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

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

  it.each([false, true])(
    "recovers custodied Usage after a failed ledger write with intake unavailable=%s",
    async (unavailable) => {
      const root = await mkdtemp(join(tmpdir(), "pragma-source-usage-"));
      roots.push(root);
      const path = join(root, "usage", "observations.json");
      const deliveryPath = join(root, "delivery.sqlite");
      const feed = await createFileCanonicalEventFeed({ pragmaHome: root });
      const observation = {
        ...fixtureObservation(),
        executionId: "00000000-0000-4000-8000-000000000111",
        invocationId: "00000000-0000-4000-8000-000000000111",
      };
      const timestamp = observation.occurredAt;
      await feed.append([
        {
          schemaVersion: "pragma.canonical-event/v1",
          eventId: "usage-observed",
          topic: "pragma.execution.event.committed",
          schemaRef: "pragma.execution-event/v5",
          sourceRef: {
            type: "pragma.execution-event",
            id: "usage-observed",
            ownerRef: { type: "pragma.execution", id: observation.executionId },
            cursor: "1",
          },
          relatedRefs: [],
          correlationId: observation.executionId,
          occurredAt: timestamp,
          payload: {
            schemaVersion: "pragma.execution-event/v5",
            eventId: "usage-observed",
            cursor: { executionId: observation.executionId, sequence: 1 },
            executionId: observation.executionId,
            invocationId: observation.invocationId,
            type: "runtime.usage.observed",
            data: { schemaVersion: "pragma.runtime-usage-observed/v1", observation },
            occurredAt: timestamp,
          },
        },
      ]);
      await mkdir(join(root, "usage"));
      await writeFile(path, "invalid-json");
      const error = vi.fn();
      const sink = createLocalHostUsageSink({ path, deliveryPath, feed, onError: error });
      sink.record(observation);
      await vi.waitFor(() => expect(error).toHaveBeenCalled());
      await sink.close();
      const receipt = new DatabaseSync(deliveryPath);
      expect(
        receipt.prepare("SELECT value FROM usage_delivery_metadata WHERE key='cursor'").get(),
      ).toMatchObject({ value: "1" });
      expect(
        receipt.prepare("SELECT COUNT(*) AS count FROM usage_delivery_pending").get(),
      ).toMatchObject({ count: 1 });
      receipt.close();
      await rm(path);
      const receiveError = vi.fn();
      let sourceUnavailable = unavailable;
      const read = vi.fn(async (...args: Parameters<typeof feed.read>) => {
        if (sourceUnavailable) throw new Error("source unavailable");
        return await feed.read(...args);
      });
      const restored = createLocalHostUsageSink({
        path,
        deliveryPath,
        feed: { ...feed, read },
        onError: receiveError,
      });
      try {
        await expect(restored.drain()).resolves.toBeUndefined();
        await expect(restored.list()).resolves.toEqual([observation]);
        await expect(restored.list()).resolves.toEqual([observation]);
        expect(restored.safeThrough()).toBe(1);
        expect(restored.inspect().pending).toBe(0);
        if (unavailable) {
          expect(receiveError).toHaveBeenCalled();
          expect(restored.inspect()).toMatchObject({
            state: "degraded",
            errorCode: "USAGE_DELIVERY_RECEIVE_FAILED",
          });
          sourceUnavailable = false;
          await restored.drain();
          expect(restored.inspect()).toMatchObject({ state: "healthy", pending: 0 });
          await expect(restored.list()).resolves.toEqual([observation]);
        }
      } finally {
        await restored.close();
        await feed.close();
      }
    },
  );
  it("serializes concurrent drains and waits for them before closing custody", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-usage-drain-"));
    roots.push(root);
    const feed = await createFileCanonicalEventFeed({ pragmaHome: root });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi.fn(async () => {
      await barrier;
      return { items: [], nextCursor: { sequence: 0 } };
    });
    const sink = createLocalHostUsageSink({
      path: join(root, "usage.json"),
      deliveryPath: join(root, "delivery.sqlite"),
      feed: { ...feed, read },
    });
    const first = sink.drain();
    const second = sink.drain();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    let closed = false;
    const closing = sink.close().then(() => {
      closed = true;
    });
    try {
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(read).toHaveBeenCalledOnce();
      release();
      await Promise.all([first, second, closing]);
      expect(closed).toBe(true);
      expect(read).toHaveBeenCalledOnce();
    } finally {
      release();
      await sink.close();
      await feed.close();
    }
  });
  it("retries receipt initialization after a transient filesystem failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-usage-open-"));
    roots.push(root);
    const feed = await createFileCanonicalEventFeed({ pragmaHome: root });
    const deliveryPath = join(root, "delivery.sqlite");
    await mkdir(deliveryPath);
    const sink = createLocalHostUsageSink({ path: join(root, "usage.json"), deliveryPath, feed });
    try {
      await expect(sink.drain()).rejects.toThrow();
      await rm(deliveryPath, { recursive: true });
      await expect(sink.drain()).resolves.toBeUndefined();
      expect(sink.safeThrough()).toBe(0);
    } finally {
      await sink.close();
      await feed.close();
    }
  });
  it("takes custody of an unreadable envelope without blocking later source pages", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-usage-unreadable-"));
    roots.push(root);
    const feed = await createFileCanonicalEventFeed({ pragmaHome: root });
    const read = vi.fn(async (input: Parameters<typeof feed.read>[0]) =>
      input.after?.sequence === 0
        ? {
            items: [
              {
                kind: "unreadable" as const,
                cursor: { sequence: 1 },
                eventId: "damaged",
                errorCode: "invalid_envelope" as const,
              },
            ],
            nextCursor: { sequence: 1 },
          }
        : { items: [], nextCursor: { sequence: 1 } },
    );
    const error = vi.fn();
    const sink = createLocalHostUsageSink({
      path: join(root, "usage.json"),
      deliveryPath: join(root, "delivery.sqlite"),
      feed: { ...feed, read },
      onError: error,
    });
    try {
      await sink.drain();
      expect(sink.safeThrough()).toBe(1);
      expect(sink.inspect()).toMatchObject({
        state: "degraded",
        errorCode: "USAGE_DELIVERY_INVALID_ENVELOPE",
      });
      expect(error).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      await sink.close();
      await feed.close();
    }
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
