import { expect, it, vi } from "vitest";
import type { SkillSourceSnapshot } from "@pragma/shared";
import { createLearningInspection } from "./learning-inspection.ts";

const source: SkillSourceSnapshot = {
  ref: { kind: "episodic", id: "workflow", revision: 1 },
  rootRef: { type: "pragma.expert", id: "expert-a" },
  producerRefs: [{ type: "pragma.expert", id: "expert-a" }],
  sourceExecutionIds: ["execution-a"],
  title: "Verified workflow",
  body: "A".repeat(17000) + "\nValidation: independently checked all outputs.",
  outcome: "succeeded",
  hasSuccessfulRecovery: false,
  observedAt: "2026-08-01T00:00:00.000Z",
  verified: true,
  visibility: { mode: "host-private" },
  sensitivity: "internal",
};
const plan = {
  action: "apply" as const,
  changes: [
    {
      name: "Workflow",
      description: "Inputs, steps and verified outputs.",
      normalizedKey: "workflow.test",
      sourceRefs: [source.ref],
      target: { type: "create" as const },
    },
  ],
};

it("requires full source coverage, including verification beyond the old 1500-character excerpt", async () => {
  const inspection = createLearningInspection([source], []);
  await inspection.read({ action: "inspect", collection: "targets" });
  const page = JSON.parse(
    await inspection.read({
      action: "inspect",
      collection: "sources",
      handle: "episodic:workflow",
    }),
  );
  expect(page.nextOffset).toBe(8000);
  await inspection.read({
    action: "inspect",
    collection: "sources",
    handle: "episodic:workflow",
    offset: 16000,
  });
  expect(() => inspection.validate(plan)).toThrow("Read the complete supplied source");
  const middle = JSON.parse(
    await inspection.read({
      action: "inspect",
      collection: "sources",
      handle: "episodic:workflow",
      offset: 8000,
    }),
  );
  expect(middle.nextOffset).toBe(16000);
  expect(() => inspection.validate(plan)).not.toThrow();
});

it("searches older sources beyond the first catalog page and never accepts an invented source", async () => {
  const sources = Array.from({ length: 150 }, (_, index) => ({
    ...source,
    ref: { ...source.ref, id: `source-${index}` },
    body: index === 149 ? "Distinct recovery journal workflow" : "Other task",
  }));
  const inspection = createLearningInspection(sources, []);
  const page = JSON.parse(
    await inspection.read({
      action: "inspect",
      collection: "sources",
      query: "Distinct recovery journal",
    }),
  );
  expect(page.entries.map((entry: { handle: string }) => entry.handle)).toEqual([
    "episodic:source-149",
  ]);
  expect(
    JSON.parse(
      await inspection.read({
        action: "inspect",
        collection: "sources",
        handle: "episodic:invented",
      }),
    ),
  ).toEqual({ error: "unknown_handle" });
});

it("reads related target bodies lazily and checks complete target coverage before revision", async () => {
  const target = {
    storeId: "11111111-1111-4111-8111-111111111111",
    name: "Migration guide",
    description: "Schema upgrades",
    baseRevision: 1,
    snapshotHash: "a".repeat(64),
    mounted: true,
  };
  const load = vi.fn(async () => "# Existing guide\n" + "B".repeat(10000));
  const inspection = createLearningInspection([source], [target], load);
  await inspection.read({ action: "inspect", collection: "targets" });
  expect(load).not.toHaveBeenCalled();
  for (const offset of [0, 8000, 16000])
    await inspection.read({
      action: "inspect",
      collection: "sources",
      handle: "episodic:workflow",
      offset,
    });
  const revision = {
    action: "apply" as const,
    name: target.name,
    description: target.description,
    rationale: "Add a supported recovery procedure.",
    maturity: "incremental" as const,
    sourceRefs: [{ kind: "episodic" as const, id: source.ref.id, revision: source.ref.revision }],
    target: {
      type: "revise" as const,
      storeId: target.storeId,
      baseRevision: target.baseRevision,
      snapshotHash: target.snapshotHash,
    },
  };
  await inspection.read({ action: "inspect", collection: "targets", handle: target.storeId });
  expect(() => inspection.validate(revision)).toThrow("Read the complete existing target");
  await inspection.read({
    action: "inspect",
    collection: "targets",
    handle: target.storeId,
    offset: 8000,
  });
  expect(load).toHaveBeenCalledOnce();
  expect(() => inspection.validate(revision)).not.toThrow();
});

it("advances source catalogs when evidence metadata exceeds the catalog byte budget", async () => {
  const large = {
    ...source,
    body: "Verified workflow",
    sourceExecutionIds: Array.from({ length: 1000 }, (_, i) => `execution-${i}-${"a".repeat(36)}`),
  };
  const inspection = createLearningInspection([large], []);
  const page = JSON.parse(await inspection.read({ action: "inspect", collection: "sources" }));
  expect(page.entries).toHaveLength(1);
  expect(page.nextOffset).toBeNull();
  expect(page.entries[0]).toMatchObject({
    handle: "episodic:workflow",
    sourceExecutionCount: 1000,
  });
});

it("requires every target catalog page before proposing a new asset", async () => {
  const targets = Array.from({ length: 51 }, (_, index) => ({
    storeId: `store-${index}`,
    name: "Knowledge",
    description: "Related existing material",
    baseRevision: 1,
    snapshotHash: "a".repeat(64),
    mounted: true,
  }));
  const inspection = createLearningInspection([{ ...source, body: "Verified workflow" }], targets);
  await inspection.read({ action: "inspect", collection: "sources", handle: "episodic:workflow" });
  await inspection.read({ action: "inspect", collection: "targets", query: "nonexistent" });
  expect(() => inspection.validate(plan)).toThrow("every page of the unfiltered target catalog");
  const first = JSON.parse(await inspection.read({ action: "inspect", collection: "targets" }));
  expect(first.nextOffset).toBe(50);
  expect(() => inspection.validate(plan)).toThrow("every page of the unfiltered target catalog");
  await inspection.read({ action: "inspect", collection: "targets", offset: first.nextOffset });
  expect(() => inspection.validate(plan)).not.toThrow();
});

it("asks the planner to combine multiple changes to one existing Skill", async () => {
  const target = {
    bindingId: "11111111-1111-4111-8111-111111111111",
    capabilityId: "1h2j3k4m5n6p7q8r",
    name: "Workflow",
    description: "Existing workflow",
    normalizedKeys: ["workflow.one", "workflow.two"],
    baseRevision: 1,
    contentHash: "a".repeat(64),
  };
  const inspection = createLearningInspection([{ ...source, body: "Verified workflow" }], [target]);
  await inspection.read({ action: "inspect", collection: "targets" });
  await inspection.read({ action: "inspect", collection: "sources", handle: "episodic:workflow" });
  await inspection.read({ action: "inspect", collection: "targets", handle: target.capabilityId });
  expect(() =>
    inspection.validate({
      action: "apply",
      changes: target.normalizedKeys.map((normalizedKey) => ({
        ...plan.changes[0]!,
        normalizedKey,
        target: {
          type: "revise",
          capabilityId: target.capabilityId,
          baseRevision: target.baseRevision,
          contentHash: target.contentHash,
        },
      })),
    }),
  ).toThrow("Combine changes to the same existing Skill");
});
