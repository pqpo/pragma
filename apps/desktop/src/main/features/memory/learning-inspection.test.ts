import { MEMORY_LEARNING_INSPECTION_PAGE_CHARACTERS as PAGE } from "@pragma/shared";
import { expect, it, vi } from "vitest";
import type { ExistingMemorySkillTarget, SkillSourceSnapshot } from "@pragma/shared";
import type { ExistingKnowledgeLearningTarget } from "@pragma/memory";
import { createLearningInspection } from "./learning-inspection.ts";

const source: SkillSourceSnapshot = {
  ref: { kind: "episodic", id: "workflow", revision: 1 },
  rootRef: { type: "pragma.expert", id: "expert-a" },
  producerRefs: [{ type: "pragma.expert", id: "expert-a" }],
  sourceExecutionIds: ["execution-a"],
  title: "Verified workflow",
  body: "A".repeat(PAGE * 2 + 1000) + "\nValidation: independently checked all outputs.",
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

it("pages complete source content without requiring source inspection coverage", async () => {
  const inspection = createLearningInspection([source], []);
  expect(() => inspection.validate(plan)).not.toThrow();
  const page = JSON.parse(
    await inspection.read({
      action: "inspect",
      collection: "sources",
      handle: "episodic:workflow",
    }),
  );
  expect(page.nextOffset).toBe(PAGE);
  await inspection.read({
    action: "inspect",
    collection: "sources",
    handle: "episodic:workflow",
    offset: PAGE * 2,
  });
  expect(() => inspection.validate(plan)).not.toThrow();
  const middle = JSON.parse(
    await inspection.read({
      action: "inspect",
      collection: "sources",
      handle: "episodic:workflow",
      offset: PAGE,
    }),
  );
  expect(middle.nextOffset).toBe(PAGE * 2);
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

it("reads related target bodies lazily without requiring target inspection coverage", async () => {
  const target = {
    storeId: "11111111-1111-4111-8111-111111111111",
    name: "Migration guide",
    description: "Schema upgrades",
    baseRevision: 1,
    snapshotHash: "a".repeat(64),
    mounted: true,
  };
  const load = vi.fn(async () => "# Existing guide\n" + "B".repeat(PAGE + 2000));
  const inspection = createLearningInspection([source], [target], load);
  await inspection.read({ action: "inspect", collection: "targets" });
  expect(load).not.toHaveBeenCalled();
  for (const offset of [0, PAGE, PAGE * 2])
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
  expect(() => inspection.validate(revision)).not.toThrow();
  await inspection.read({ action: "inspect", collection: "targets", handle: target.storeId });
  expect(() => inspection.validate(revision)).not.toThrow();
  await inspection.read({
    action: "inspect",
    collection: "targets",
    handle: target.storeId,
    offset: PAGE,
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

it("accepts a new asset without target catalog inspection and preserves optional catalog pagination", async () => {
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
  expect(() => inspection.validate(plan)).not.toThrow();
  await inspection.read({ action: "inspect", collection: "targets", query: "nonexistent" });
  expect(() => inspection.validate(plan)).not.toThrow();
  const first = JSON.parse(await inspection.read({ action: "inspect", collection: "targets" }));
  expect(first.nextOffset).toBe(50);
  expect(() => inspection.validate(plan)).not.toThrow();
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

it("reads declared Skill scripts lazily without requiring file inspection coverage", async () => {
  const target = {
    bindingId: "11111111-1111-4111-8111-111111111111",
    capabilityId: "1h2j3k4m5n6p7q8r",
    name: "Workflow",
    description: "Existing workflow",
    normalizedKeys: ["workflow.test"],
    baseRevision: 1,
    contentHash: "a".repeat(64),
  };
  const file = vi.fn(async () => "def verify():\n" + "x".repeat(PAGE + 1000));
  const inspection = createLearningInspection(
    [{ ...source, body: "Verified workflow" }],
    [target],
    async () => "# Skill\nSee scripts/verify.py",
    file,
  );
  await inspection.read({ action: "inspect", collection: "targets" });
  await inspection.read({ action: "inspect", collection: "targets", handle: target.capabilityId });
  await inspection.read({ action: "inspect", collection: "sources", handle: "episodic:workflow" });
  expect(file).not.toHaveBeenCalled();
  const change = {
    ...plan.changes[0]!,
    targetFiles: ["SKILL.md", "scripts/verify.py"],
    target: {
      type: "revise" as const,
      capabilityId: target.capabilityId,
      baseRevision: target.baseRevision,
      contentHash: target.contentHash,
    },
  };
  expect(() => inspection.validate({ action: "apply", changes: [change] })).not.toThrow();
  await inspection.read({
    action: "inspect",
    collection: "targets",
    handle: target.capabilityId,
    path: "scripts/verify.py",
  });
  expect(() => inspection.validate({ action: "apply", changes: [change] })).not.toThrow();
  await inspection.read({
    action: "inspect",
    collection: "targets",
    handle: target.capabilityId,
    path: "scripts/verify.py",
    offset: PAGE,
  });
  expect(() => inspection.validate({ action: "apply", changes: [change] })).not.toThrow();
  expect(file).toHaveBeenCalledOnce();
});

it("reports unreadable package files without requiring their inspection for plan acceptance", async () => {
  const target = {
    bindingId: "11111111-1111-4111-8111-111111111111",
    capabilityId: "1h2j3k4m5n6p7q8r",
    name: "Workflow",
    description: "Existing workflow",
    normalizedKeys: ["workflow.test"],
    baseRevision: 1,
    contentHash: "a".repeat(64),
  };
  const inspection = createLearningInspection(
    [{ ...source, body: "Verified workflow" }],
    [target],
    async () => "# Skill",
    async () => {
      throw Object.assign(new Error("Unreadable binary file"), {
        code: "memory_learning_target_file_unreadable",
      });
    },
  );
  await inspection.read({ action: "inspect", collection: "targets" });
  await inspection.read({ action: "inspect", collection: "targets", handle: target.capabilityId });
  await inspection.read({ action: "inspect", collection: "sources", handle: "episodic:workflow" });
  expect(
    JSON.parse(
      await inspection.read({
        action: "inspect",
        collection: "targets",
        handle: target.capabilityId,
        path: "scripts/check.bin",
      }),
    ),
  ).toMatchObject({ error: "target_file_unreadable" });
  expect(() =>
    inspection.validate({
      action: "apply",
      changes: [
        {
          ...plan.changes[0]!,
          targetFiles: ["SKILL.md", "scripts/check.bin"],
          target: {
            type: "revise",
            capabilityId: target.capabilityId,
            baseRevision: 1,
            contentHash: target.contentHash,
          },
        },
      ],
    }),
  ).not.toThrow();
});

it.each(["knowledge", "skill"] as const)(
  "accepts a %s revision without target reads while rejecting stale, pending or unknown targets",
  async (kind) => {
    const sourceSnapshot = { ...source, body: "Verified workflow" };
    const target: ExistingKnowledgeLearningTarget | ExistingMemorySkillTarget =
      kind === "knowledge"
        ? {
            storeId: "11111111-1111-4111-8111-111111111111",
            name: "Knowledge",
            description: "Guide",
            baseRevision: 1,
            snapshotHash: "a".repeat(64),
            mounted: true,
          }
        : {
            bindingId: "11111111-1111-4111-8111-111111111111",
            capabilityId: "1h2j3k4m5n6p7q8r",
            name: "Skill",
            description: "Workflow",
            normalizedKeys: ["workflow.test"],
            baseRevision: 1,
            contentHash: "a".repeat(64),
          };
    const revision =
      "storeId" in target
        ? {
            action: "apply" as const,
            name: target.name,
            description: target.description,
            rationale: "Add verified guidance",
            maturity: "incremental" as const,
            sourceRefs: [
              { kind: "episodic" as const, id: source.ref.id, revision: source.ref.revision },
            ],
            target: {
              type: "revise" as const,
              storeId: target.storeId,
              baseRevision: target.baseRevision,
              snapshotHash: target.snapshotHash,
            },
          }
        : {
            action: "apply" as const,
            changes: [
              {
                ...plan.changes[0]!,
                targetFiles: ["SKILL.md", "scripts/verify.py"],
                target: {
                  type: "revise" as const,
                  capabilityId: target.capabilityId,
                  baseRevision: target.baseRevision,
                  contentHash: target.contentHash,
                },
              },
            ],
          };
    const readTarget = vi.fn(async () => "# Target");
    for (const [targets, valid] of [
      [[target], true],
      [[{ ...target, baseRevision: 2 }], false],
      [
        [
          "storeId" in target
            ? { ...target, snapshotHash: "b".repeat(64) }
            : { ...target, contentHash: "b".repeat(64) },
        ],
        false,
      ],
      [[{ ...target, pending: true }], false],
      [[], false],
    ] as const) {
      const inspection = createLearningInspection([sourceSnapshot], targets, readTarget);
      await inspection.read({
        action: "inspect",
        collection: "sources",
        handle: "episodic:workflow",
      });
      if (valid) expect(() => inspection.validate(revision)).not.toThrow();
      else expect(() => inspection.validate(revision)).toThrow("Use the supplied current");
    }
    expect(readTarget).not.toHaveBeenCalled();
  },
);

it("rejects invented source identities and revisions without requiring inspection records", async () => {
  const inspection = createLearningInspection([{ ...source, body: "Verified workflow" }], []);
  for (const ref of [
    { ...source.ref, kind: "semantic" as const },
    { ...source.ref, id: "invented" },
    { ...source.ref, revision: 2 },
  ]) {
    expect(() =>
      inspection.validate({ ...plan, changes: [{ ...plan.changes[0]!, sourceRefs: [ref] }] }),
    ).toThrow("Cite only exact supplied sourceRefs");
  }
});
