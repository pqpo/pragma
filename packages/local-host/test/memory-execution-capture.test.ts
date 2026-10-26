import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PragmaPaths } from "@pragma/core";
import { STORE_REVISION_EXPERT_REF, ContextStoreRevisionJobSchema } from "@pragma/built-in-agents";
import { CanonicalEventEnvelopeSchema } from "@pragma/shared";
import { createMissionStore } from "../src/missions/repository/mission-store.ts";
import { createMissionDeliveryReceiptStore } from "../src/mission-delivery-receipt-store.ts";
import { excludeInternalMemoryExecution } from "../src/memory-execution-capture.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it.each(["memory-learning", "user", "expert-reflection"] as const)(
  "classifies historical %s Revision from its authority",
  async (source) => {
    const root = await mkdtemp(join(tmpdir(), "pragma-memory-origin-"));
    roots.push(root);
    const paths = new PragmaPaths({ pragmaHome: root });
    const jobId = randomUUID(),
      storeId = randomUUID();
    const mission = await createMissionStore({ missionsPath: paths.missionsRoot() }).create({
      workspace: { path: root, basename: "fixture" },
      goal: "Revise",
      project: { id: "studio", revision: 1 },
      executor: { kind: "expert", ref: STORE_REVISION_EXPERT_REF, name: "Revision" },
      origin: { type: "system-store-revision", jobId, storeId },
    });
    const receipts = await createMissionDeliveryReceiptStore({
      path: paths.missionDelivery(),
      onNotice: () => undefined,
    });
    await receipts.registerLink(
      "execution",
      mission.id,
      JSON.stringify({ mission, requestId: randomUUID() }),
    );
    await receipts.close();
    const event = CanonicalEventEnvelopeSchema.parse({
      schemaVersion: "pragma.canonical-event/v1",
      eventId: randomUUID(),
      topic: "pragma.execution.event.committed",
      schemaRef: "pragma.execution-event/v5",
      sourceRef: { type: "pragma.execution", id: "execution" },
      relatedRefs: [
        {
          relation: "pragma.execution-root",
          ref: { type: "pragma.expert", id: STORE_REVISION_EXPERT_REF.slice(7) },
        },
      ],
      correlationId: "execution",
      occurredAt: new Date().toISOString(),
      payload: {},
    });
    const directory = join(paths.stateRoot(), "context-store-revisions", "jobs");
    await mkdir(directory, { recursive: true });
    const job = ContextStoreRevisionJobSchema.parse({
      schemaVersion: "pragma.context-store-revision-job/v4",
      id: jobId,
      revision: 1,
      draftId: randomUUID(),
      missionId: mission.id,
      request: {
        schemaVersion: "pragma.context-store-revision-request/v2",
        operation: "revise",
        storeId,
        prompt: "Revise from authorized sources",
        source,
        ...(source === "user" ? {} : { sourceDigest: "a".repeat(64) }),
        ...(source === "expert-reflection"
          ? {
              provenance: {
                executionId: "execution",
                invocationId: "invocation",
                expertId: "0000000000st0rev",
              },
            }
          : {}),
      },
      state: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await writeFile(join(directory, `${jobId}.json`), JSON.stringify(job));
    expect(await excludeInternalMemoryExecution(event, root)).toBe(source === "memory-learning");
    await rm(join(directory, `${jobId}.json`));
    await expect(excludeInternalMemoryExecution(event, root)).rejects.toMatchObject({
      code: "memory_execution_origin_unavailable",
    });
  },
);
