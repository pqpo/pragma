import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { STORE_REVISION_EXPERT_REF } from "@pragma/built-in-agents";
import { createContextStoreStore } from "../context-stores/context-store-store.ts";
import { createContextStoreRevisionService } from "../context-stores/context-store-revision-service.ts";
import { createMissionStore } from "./mission-store.ts";
import { MissionUpdateSchema } from "../../../shared/contracts/index.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("lists only background revisions while retaining foreground revision details after reopening storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-mission-source-"));
  roots.push(root);
  const contextStores = createContextStoreStore({ storesPath: join(root, "stores") });
  const target = await contextStores.create({ mode: "blank", name: "Knowledge", description: "" });
  const revisions = createContextStoreRevisionService({
    contextStores,
    statePath: join(root, "jobs"),
    draftsPath: join(root, "drafts"),
    generator: { generate: async () => undefined },
  });
  const getRevisionSource = async (jobId: string) => (await revisions.get(jobId)).request.source;
  const onReadIssue = vi.fn();
  const options = { missionsPath: join(root, "missions"), getRevisionSource, onReadIssue };
  const missions = createMissionStore(options);
  const base = {
    workspace: { path: root, basename: "workspace" },
    goal: "Revise knowledge",
    project: { id: "studio", revision: 1 },
    executor: {
      kind: "expert" as const,
      ref: STORE_REVISION_EXPERT_REF,
      name: "Store Revision Agent",
    },
  };
  const visible = [];
  const manual = await missions.create(base);
  visible.push(manual.id);
  const automation = await missions.create({
    ...base,
    origin: { type: "automation", automationRef: "automation:m9a8n9nxvvyb4j01" },
  });
  visible.push(automation.id);
  let foregroundId = "";
  for (const source of ["user", "memory-learning", "expert-reflection"] as const) {
    const job = await revisions.start({
      schemaVersion: "pragma.context-store-revision-request/v1",
      storeId: target.id,
      prompt: source,
      source,
      ...(source === "user"
        ? {}
        : { sourceDigest: (source === "memory-learning" ? "a" : "b").repeat(64) }),
      ...(source === "expert-reflection"
        ? {
            provenance: {
              executionId: "execution",
              invocationId: "invocation",
              expertId: "expert",
            },
          }
        : {}),
    });
    const mission = await missions.create({
      ...base,
      origin: { type: "system-store-revision", jobId: job.id, storeId: target.id },
    });
    const expectedType = source === "expert-reflection" ? "internal" : "managed-automation";
    expect(await missions.getListSource(mission)).toMatchObject({ type: expectedType });
    const update = MissionUpdateSchema.parse({
      kind: "upsert",
      mission,
      source: await missions.getListSource(mission),
    });
    expect(update).toMatchObject({ kind: "upsert", source: { type: expectedType } });
    if (source === "expert-reflection") foregroundId = mission.id;
    else visible.push(mission.id);
  }
  await missions.create({ ...base, origin: { type: "system-memory", jobId: "curator" } });
  const skillRevision = await missions.create({
    ...base,
    origin: {
      type: "system-skill-revision",
      jobId: "00000000-0000-4000-8000-000000000001",
      capabilityId: "00000000-0000-4000-8000-000000000002",
    },
  });
  visible.push(skillRevision.id);
  const orphan = await missions.create({
    ...base,
    origin: {
      type: "system-store-revision",
      jobId: "00000000-0000-4000-8000-000000000099",
      storeId: target.id,
    },
  });
  const reopened = createMissionStore(options);
  expect((await reopened.list()).map((entry) => entry.id).sort()).toEqual(visible.sort());
  expect((await reopened.get(foregroundId)).id).toBe(foregroundId);
  expect(await reopened.getListSource(await reopened.get(foregroundId))).toEqual({
    type: "internal",
  });
  expect(onReadIssue).toHaveBeenCalledWith(
    expect.objectContaining({
      missionId: orphan.id,
      error: expect.objectContaining({
        message: expect.stringContaining("mission_revision_source_unavailable"),
      }),
    }),
  );
});
