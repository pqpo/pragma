import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PragmaPaths } from "@pragma/core";
import { MemoryEvidenceEnvelopeSchema } from "@pragma/shared";
import { afterEach, describe, expect, it } from "vitest";

import {
  MemoryModuleRegistry,
  createFederatedMemoryContextStore,
  createMemoryActivityStore,
  memoryQueryDigest,
} from "../src/index.ts";
import { createProbeMemoryModule } from "../src/testing/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Memory activity", () => {
  it("audits agent-driven ContextStore operations without storing the raw search query", async () => {
    const pragmaHome = await temporaryRoot();
    const activity = createMemoryActivityStore({ pragmaHome });
    const registry = new MemoryModuleRegistry();
    const first = createProbeMemoryModule({
      pragmaHome,
      id: "pragma.memory.first",
      prefix: "first",
    });
    const second = createProbeMemoryModule({
      pragmaHome,
      id: "pragma.memory.second",
      prefix: "second",
    });
    const query = "do-not-store-this-query";
    await first.consume([probeEvidence(`${query}-first`)]);
    await second.consume([probeEvidence(`${query}-second`)]);
    registry.register(first);
    registry.register(second);

    const context = createFederatedMemoryContextStore(registry, {
      activity,
      resolveRecallScope: () => ({
        rootRef: { type: "pragma.expert", id: "expert-a" },
        expertRef: { type: "pragma.expert", id: "expert-a" },
      }),
      now: () => new Date("2026-08-03T10:00:00.000Z"),
    });
    const runContext = {
      attributes: {
        "execution.executionId": "execution-activity",
        "execution.invocationId": "invocation-activity",
      },
    };
    await context.listContext({ context: runContext });
    const search = await context.searchContext({ query, maxResults: 3, context: runContext });
    expect(search.ok && search.value.map((match) => match.id.split("/")[0])).toEqual([
      "first",
      "second",
      "first",
    ]);
    await context.readContext({ id: "guide.md", context: runContext });

    const recalls = await activity.listRecall("execution-activity");
    expect(recalls.map((item) => item.operation).toSorted()).toEqual(["list", "read", "search"]);
    expect(recalls.find((item) => item.operation === "search")).toMatchObject({
      queryDigest: memoryQueryDigest(query),
      queryLength: query.length,
      outcome: "allowed",
      reason: "matched",
    });
    expect(JSON.stringify(recalls)).not.toContain(query);
    const database = await readFile(
      new PragmaPaths({ pragmaHome }).memoryExecutionActivity("execution-activity"),
    );
    expect(database.includes(Buffer.from(query))).toBe(false);
  });

  it("summarizes capture outcomes per execution", async () => {
    const activity = createMemoryActivityStore({ pragmaHome: await temporaryRoot() });
    for (const [sourceEventId, outcome] of [
      ["published", "published"],
      ["skipped", "skipped"],
      ["failed", "failed"],
    ] as const) {
      await activity.recordCapture({
        schemaVersion: "pragma.memory-capture-activity/v1",
        sourceEventId,
        executionId: "execution-capture",
        outcome,
        reason: outcome,
        occurredAt: "2026-08-03T10:00:00.000Z",
      });
    }
    await expect(activity.summarize("execution-capture")).resolves.toMatchObject({
      capture: { published: 1, skipped: 1, failed: 1 },
      recall: { list: 0, search: 0, read: 0, denied: 0, failed: 0 },
    });
  });
});

function probeEvidence(messageId: string) {
  return MemoryEvidenceEnvelopeSchema.parse({
    schemaVersion: "pragma.memory-evidence/v1",
    messageId,
    topic: "execution.message.appended",
    schemaRef: "pragma.memory.execution-message/v2",
    sourceRef: {
      type: "pragma.execution-event",
      id: messageId,
      canonicalEventId: `canonical-${messageId}`,
    },
    subjectRefs: [{ type: "pragma.execution", id: "execution-activity" }],
    correlationId: "execution-activity",
    occurredAt: "2026-08-03T10:00:00.000Z",
    visibility: { mode: "host-private" },
    sensitivity: "confidential",
    bindings: [
      {
        consumerRef: { type: "pragma.expert", id: "expert-a" },
        access: "allow",
      },
    ],
    attribution: {
      rootRef: { type: "pragma.expert", id: "expert-a" },
      producerRefs: [{ type: "pragma.expert", id: "expert-a" }],
    },
    policySnapshot: {
      capture: true,
      recall: true,
      learning: "disabled",
      appliedRevisions: [],
    },
    payload: { message: { role: "user", text: "safe" } },
  });
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-memory-activity-"));
  roots.push(root);
  return root;
}
