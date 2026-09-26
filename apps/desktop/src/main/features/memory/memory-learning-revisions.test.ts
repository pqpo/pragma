import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CapabilityStoreError, type CapabilityStore } from "../capabilities/capability-store.ts";
import {
  ContextStoreStoreError,
  type ContextStoreStore,
} from "../context-stores/context-store-store.ts";
import type { SkillRevisionService } from "../capabilities/skill-revision-service.ts";
import type { ContextStoreRevisionService } from "../context-stores/context-store-revision-service.ts";
import { createMemoryLearningRevisions } from "./memory-learning-revisions.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pragma-memory-revisions-"));
  roots.push(root);
  const expertRef = "expert:1h2j3k4m5n6p7q8r";
  const knowledgeJobId = randomUUID();
  const skillJobId = randomUUID();
  let knowledgeState = "pending_review";
  let skillState = "pending_review";
  let capabilityKind = "skill";
  let capabilityMissing = false;
  const knowledgeStart = vi.fn(
    async (request: { readonly operation: string; readonly storeId: string }) => {
      void request;
      return { id: knowledgeJobId };
    },
  );
  const skillStart = vi.fn(async (request: { readonly capabilityId: string }) => ({
    id: skillJobId,
    capabilityId: request.capabilityId,
  }));
  const mountStore = vi.fn(async () => undefined);
  const bindSkill = vi.fn(async () => undefined);
  const existingStoreIds = new Set<string>();
  const createStore = vi.fn(async (request: { readonly id?: string }) => {
    const id = request.id ?? randomUUID();
    existingStoreIds.add(id);
    return { id };
  });
  const createSkill = vi.fn(async () => {
    capabilityMissing = false;
    return {};
  });
  const service = createMemoryLearningRevisions({
    statePath: join(root, "state", "memory-learning-revisions"),
    knowledgeRevisions: {
      submit: knowledgeStart,
      get: async () => ({ state: knowledgeState }),
      scheduleProcessing: vi.fn(),
    } as unknown as ContextStoreRevisionService,
    skillRevisions: {
      start: skillStart,
      get: async () => ({ state: skillState }),
      scheduleProcessing: vi.fn(),
    } as unknown as SkillRevisionService,
    contextStores: {
      getSnapshot: async (id: string) => {
        if (!existingStoreIds.has(id)) {
          throw new ContextStoreStoreError("store_not_found", "Missing store");
        }
        return {};
      },
      createFromSnapshot: createStore,
    } as unknown as ContextStoreStore,
    capabilities: {
      get: async () => {
        if (capabilityMissing) {
          throw new CapabilityStoreError("capability_not_found", "Missing capability");
        }
        return { definition: { kind: capabilityKind, name: "Skill", description: "Reusable" } };
      },
      createGeneratedSkill: createSkill,
    } as unknown as CapabilityStore,
    expertExists: async () => true,
    mountStore,
    bindSkill,
  });
  return {
    root,
    expertRef,
    service,
    knowledgeStart,
    skillStart,
    mountStore,
    bindSkill,
    createStore,
    createSkill,
    mergeKnowledge: () => {
      knowledgeState = "merged";
    },
    publishSkill: () => {
      skillState = "completed";
    },
    setCapabilityKind: (kind: string) => {
      capabilityKind = kind;
    },
    setCapabilityMissing: () => {
      capabilityMissing = true;
    },
  };
}

describe("Memory revision learning bindings", () => {
  it("keeps create submission idempotent across retries and mounts only after merge", async () => {
    const f = await fixture();
    const digest = "a".repeat(64);
    const input = {
      expertRef: f.expertRef,
      sourceDigest: digest,
      plan: { action: "apply" as const, name: "Knowledge", description: "Reusable knowledge" },
      sources: [],
    };
    await f.service.submitKnowledge(input);
    await f.service.submitKnowledge(input);
    expect(f.knowledgeStart).toHaveBeenCalledTimes(1);
    await f.service.reconcile();
    expect(f.mountStore).not.toHaveBeenCalled();
    f.mergeKnowledge();
    await f.service.reconcile();
    expect(f.mountStore).toHaveBeenCalledTimes(1);
    await f.service.reconcile();
    expect(f.mountStore).toHaveBeenCalledTimes(1);
    await f.service.submitKnowledge({ ...input, sourceDigest: "e".repeat(64) });
    expect(f.knowledgeStart).toHaveBeenCalledTimes(2);
    expect(f.knowledgeStart.mock.calls[1]?.[0]).toMatchObject({
      operation: "revise",
      storeId: f.knowledgeStart.mock.calls[0]?.[0].storeId,
    });
  });

  it("defers newer Knowledge evidence until the current revision settles", async () => {
    const f = await fixture();
    const base = {
      expertRef: f.expertRef,
      plan: { action: "apply" as const, name: "Knowledge", description: "Guidance" },
      sources: [],
    };
    await f.service.submitKnowledge({ ...base, sourceDigest: "a".repeat(64) });
    await expect(
      f.service.submitKnowledge({ ...base, sourceDigest: "b".repeat(64) }),
    ).rejects.toThrow("memory_revision_pending");
    expect(f.knowledgeStart).toHaveBeenCalledTimes(1);
    f.mergeKnowledge();
    expect(await f.service.reconcile()).toBe(true);
    expect(await f.service.reconcile()).toBe(false);
    await f.service.submitKnowledge({ ...base, sourceDigest: "b".repeat(64) });
    expect(f.knowledgeStart).toHaveBeenCalledTimes(2);
    expect(f.knowledgeStart.mock.calls[1]?.[0].operation).toBe("revise");
  });

  it("keeps a stable Skill identity when submission retries after failure", async () => {
    const f = await fixture();
    f.skillStart.mockRejectedValueOnce(new Error("offline"));
    const sourceRefs = [1, 2, 3].map((revision) => ({
      kind: "episodic" as const,
      id: `episode-${revision}`,
      revision,
    }));
    const input = {
      expertRef: f.expertRef,
      sourceDigest: "b".repeat(64),
      plan: {
        action: "apply" as const,
        changes: [
          {
            name: "Workflow",
            description: "Reusable workflow",
            normalizedKey: "workflow.test",
            sourceRefs,
            target: { type: "create" as const },
          },
        ],
      },
      sources: [],
    };
    await expect(f.service.submitSkills(input)).rejects.toThrow("offline");
    await f.service.submitSkills(input);
    expect(f.skillStart).toHaveBeenCalledTimes(2);
    const firstId = f.skillStart.mock.calls[0]?.[0].capabilityId;
    expect(f.skillStart.mock.calls[1]?.[0].capabilityId).toBe(firstId);
    await f.service.reconcile();
    expect(f.bindSkill).not.toHaveBeenCalled();
    f.publishSkill();
    await f.service.reconcile();
    expect(f.bindSkill).toHaveBeenCalledWith(f.expertRef, firstId);
  });

  it("defers newer Skill evidence until the current revision settles", async () => {
    const f = await fixture();
    const base = {
      expertRef: f.expertRef,
      plan: {
        action: "apply" as const,
        changes: [
          {
            name: "Workflow",
            description: "Reusable workflow",
            normalizedKey: "workflow.test",
            sourceRefs: [1, 2, 3].map((revision) => ({
              kind: "episodic" as const,
              id: `episode-${revision}`,
              revision,
            })),
            target: { type: "create" as const },
          },
        ],
      },
      sources: [],
    };
    await f.service.submitSkills({ ...base, sourceDigest: "a".repeat(64) });
    await expect(f.service.submitSkills({ ...base, sourceDigest: "b".repeat(64) })).rejects.toThrow(
      "memory_revision_pending",
    );
    expect(f.skillStart).toHaveBeenCalledTimes(1);
    f.publishSkill();
    expect(await f.service.reconcile()).toBe(true);
    expect(await f.service.reconcile()).toBe(false);
    const capabilityId = f.skillStart.mock.calls[0]![0].capabilityId;
    await f.service.submitSkills({
      ...base,
      sourceDigest: "b".repeat(64),
      plan: {
        action: "apply",
        changes: [{ ...base.plan.changes[0]!, target: { type: "revise", capabilityId } }],
      },
    });
    expect(f.skillStart).toHaveBeenCalledTimes(2);
    expect(f.skillStart.mock.calls[1]![0].capabilityId).toBe(capabilityId);
  });

  it("fails closed when an existing Skill target resolves to another capability kind", async () => {
    const f = await fixture();
    const capabilityId = randomUUID();
    const legacyRoot = join(f.root, "state", "memory-skill-promotion");
    await mkdir(legacyRoot, { recursive: true });
    await writeFile(
      join(legacyRoot, "bindings.json"),
      JSON.stringify({
        schemaVersion: "pragma.memory-skill-bindings/v1",
        bindings: [
          {
            bindingId: randomUUID(),
            expertRef: f.expertRef,
            capabilityId,
            normalizedKeys: ["workflow.old"],
            lastSourceDigest: "a".repeat(64),
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
    );
    f.setCapabilityKind("http_service");
    await expect(f.service.listSkillTargets({ expertRef: f.expertRef })).rejects.toThrow(
      "memory_skill_target_not_skill",
    );
  });

  it("serializes revisions when legacy keys share one Skill capability", async () => {
    const f = await fixture();
    const capabilityId = randomUUID();
    const legacyRoot = join(f.root, "state", "memory-skill-promotion");
    await mkdir(legacyRoot, { recursive: true });
    await writeFile(
      join(legacyRoot, "bindings.json"),
      JSON.stringify({
        schemaVersion: "pragma.memory-skill-bindings/v1",
        bindings: [
          {
            bindingId: randomUUID(),
            expertRef: f.expertRef,
            capabilityId,
            normalizedKeys: ["workflow.first", "workflow.second"],
            lastSourceDigest: "a".repeat(64),
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const input = {
      expertRef: f.expertRef,
      sourceDigest: "b".repeat(64),
      plan: {
        action: "apply" as const,
        changes: ["workflow.first", "workflow.second"].map((normalizedKey) => ({
          name: normalizedKey,
          description: "Reusable workflow",
          normalizedKey,
          sourceRefs: [1, 2, 3].map((revision) => ({
            kind: "episodic" as const,
            id: `episode-${revision}`,
            revision,
          })),
          target: { type: "revise" as const, capabilityId },
        })),
      },
      sources: [],
    };
    await expect(f.service.submitSkills(input)).rejects.toThrow("memory_revision_pending");
    expect(f.skillStart).toHaveBeenCalledTimes(1);
    f.publishSkill();
    expect(await f.service.reconcile()).toBe(true);
    await f.service.submitSkills(input);
    expect(f.skillStart).toHaveBeenCalledTimes(2);
  });

  it("replays an approved Knowledge promotion journal before archiving", async () => {
    const f = await fixture();
    const directory = join(f.root, "state", "memory-knowledge-promotion");
    const candidateId = randomUUID();
    const storeId = randomUUID();
    await mkdir(join(directory, "candidates"), { recursive: true });
    await writeFile(
      join(directory, "promotion.json"),
      JSON.stringify({
        schemaVersion: "pragma.memory-knowledge-promotion-journal/v1",
        candidateId,
        expertRef: f.expertRef,
        storeId,
      }),
    );
    await writeFile(
      join(directory, "candidates", `${candidateId}.json`),
      JSON.stringify({
        schemaVersion: "pragma.memory-knowledge-initialization-candidate/v2",
        id: candidateId,
        state: "pending_review",
        expertRef: f.expertRef,
        sourceDigest: "a".repeat(64),
        name: "Recovered knowledge",
        description: "Approved before upgrade",
        files: [
          {
            id: "guide.md",
            content: "# Recovered knowledge\n",
            metadata: { trigger: "manual", priority: "normal" },
          },
        ],
      }),
    );
    await f.service.reconcile();
    expect(f.createStore).toHaveBeenCalledWith(expect.objectContaining({ id: storeId }));
    expect(f.mountStore).toHaveBeenCalledWith(f.expertRef, storeId);
    expect(
      JSON.parse(
        await readFile(join(f.root, "state", "memory-learning-revisions", "bindings.json"), "utf8"),
      ).knowledge,
    ).toMatchObject([{ storeId, mounted: true, revisionPending: false }]);
    expect(
      await readFile(
        join(
          f.root,
          "archives",
          "memory-learning-v1",
          "memory-knowledge-promotion",
          "promotion.json",
        ),
        "utf8",
      ),
    ).toContain(candidateId);
  });

  it("replays a legacy promotion after a crash between creation and binding", async () => {
    const f = await fixture();
    const directory = join(f.root, "state", "memory-knowledge-promotion");
    const candidateId = randomUUID();
    const storeId = randomUUID();
    await mkdir(join(directory, "candidates"), { recursive: true });
    await writeFile(
      join(directory, "promotion.json"),
      JSON.stringify({
        schemaVersion: "pragma.memory-knowledge-promotion-journal/v1",
        candidateId,
        expertRef: f.expertRef,
        storeId,
      }),
    );
    await writeFile(
      join(directory, "candidates", `${candidateId}.json`),
      JSON.stringify({
        schemaVersion: "pragma.memory-knowledge-initialization-candidate/v2",
        id: candidateId,
        state: "pending_review",
        expertRef: f.expertRef,
        sourceDigest: "a".repeat(64),
        name: "Recovered knowledge",
        description: "Approved before upgrade",
        files: [
          {
            id: "guide.md",
            content: "# Recovered knowledge\n",
            metadata: { trigger: "manual", priority: "normal" },
          },
        ],
      }),
    );
    f.mountStore.mockRejectedValueOnce(new Error("simulated crash"));
    await expect(f.service.reconcile()).rejects.toThrow("simulated crash");
    expect(f.createStore).toHaveBeenCalledTimes(1);
    await f.service.reconcile();
    expect(f.createStore).toHaveBeenCalledTimes(1);
    expect(f.mountStore).toHaveBeenCalledTimes(2);
  });

  it("replays an approved Skill promotion journal before archiving", async () => {
    const f = await fixture();
    const directory = join(f.root, "state", "memory-skill-promotion");
    const candidateId = randomUUID();
    const capabilityId = randomUUID();
    await mkdir(join(directory, "candidates"), { recursive: true });
    await writeFile(
      join(directory, "promotion.json"),
      JSON.stringify({
        schemaVersion: "pragma.memory-skill-promotion-journal/v1",
        candidateId,
        expertRef: f.expertRef,
        capabilityId,
      }),
    );
    await writeFile(
      join(directory, "candidates", `${candidateId}.json`),
      JSON.stringify({
        schemaVersion: "pragma.memory-skill-candidate/v2",
        id: candidateId,
        state: "approved",
        expertRef: f.expertRef,
        sourceDigest: "b".repeat(64),
        normalizedKey: "workflow.recovered",
        package: {
          name: "Recovered Skill",
          description: "Approved before upgrade",
          files: [{ path: "SKILL.md", content: "# Recovered Skill\n" }],
        },
      }),
    );
    f.setCapabilityMissing();
    await f.service.reconcile();
    expect(f.createSkill).toHaveBeenCalledWith(expect.objectContaining({ id: capabilityId }));
    expect(f.bindSkill).toHaveBeenCalledWith(f.expertRef, capabilityId);
    expect(
      JSON.parse(
        await readFile(join(f.root, "state", "memory-learning-revisions", "bindings.json"), "utf8"),
      ).skills,
    ).toMatchObject([{ capabilityId, mounted: true, revisionPending: false }]);
  });

  it("migrates approved bindings and archives discarded candidate stores on first access", async () => {
    const f = await fixture();
    const legacyKnowledge = join(f.root, "state", "memory-knowledge-promotion");
    const legacySkill = join(f.root, "state", "memory-skill-promotion");
    await Promise.all([
      mkdir(join(legacyKnowledge, "candidates"), { recursive: true }),
      mkdir(join(legacySkill, "candidates"), { recursive: true }),
    ]);
    const storeId = randomUUID();
    const capabilityId = randomUUID();
    const updatedAt = "2026-08-01T00:00:00.000Z";
    await writeFile(
      join(legacyKnowledge, "bindings.json"),
      JSON.stringify({
        schemaVersion: "pragma.memory-knowledge-store-bindings/v1",
        bindings: [
          { expertRef: f.expertRef, storeId, lastSourceDigest: "c".repeat(64), updatedAt },
        ],
      }),
    );
    await writeFile(
      join(legacySkill, "bindings.json"),
      JSON.stringify({
        schemaVersion: "pragma.memory-skill-bindings/v1",
        bindings: [
          {
            bindingId: randomUUID(),
            expertRef: f.expertRef,
            capabilityId,
            normalizedKeys: ["workflow.old"],
            lastSourceDigest: "d".repeat(64),
            updatedAt,
          },
        ],
      }),
    );
    await writeFile(join(legacySkill, "candidates", "pending.json"), "pending");
    const targets = await f.service.listSkillTargets({ expertRef: f.expertRef });
    expect(targets).toMatchObject([{ capabilityId, normalizedKeys: ["workflow.old"] }]);
    const state = JSON.parse(
      await readFile(join(f.root, "state", "memory-learning-revisions", "bindings.json"), "utf8"),
    );
    expect(state.knowledge).toMatchObject([{ storeId, mounted: true }]);
    expect(
      await readFile(
        join(
          f.root,
          "archives",
          "memory-learning-v1",
          "memory-skill-promotion",
          "candidates",
          "pending.json",
        ),
        "utf8",
      ),
    ).toBe("pending");
    await f.service.listSkillTargets({ expertRef: f.expertRef });
    expect(
      JSON.parse(
        await readFile(join(f.root, "state", "memory-learning-revisions", "bindings.json"), "utf8"),
      ),
    ).toEqual(state);
  });

  it("rejects a future unified binding version without archiving the source", async () => {
    const f = await fixture();
    const currentRoot = join(f.root, "state", "memory-learning-revisions");
    const legacyRoot = join(f.root, "state", "memory-knowledge-promotion");
    await Promise.all([
      mkdir(currentRoot, { recursive: true }),
      mkdir(legacyRoot, { recursive: true }),
    ]);
    await writeFile(
      join(currentRoot, "bindings.json"),
      JSON.stringify({
        schemaVersion: "pragma.memory-learning-revisions/v2",
        knowledge: [],
        skills: [],
      }),
    );
    await expect(f.service.reconcile()).rejects.toThrow();
    expect(await readFile(join(currentRoot, "bindings.json"), "utf8")).toContain("/v2");
    expect((await stat(legacyRoot)).isDirectory()).toBe(true);
  });

  it("replays archiving after a crash between unified-state write and legacy cleanup", async () => {
    const f = await fixture();
    const currentRoot = join(f.root, "state", "memory-learning-revisions");
    const legacyRoot = join(f.root, "state", "memory-skill-promotion");
    await Promise.all([
      mkdir(currentRoot, { recursive: true }),
      mkdir(legacyRoot, { recursive: true }),
    ]);
    await writeFile(
      join(currentRoot, "bindings.json"),
      JSON.stringify({
        schemaVersion: "pragma.memory-learning-revisions/v1",
        knowledge: [],
        skills: [],
      }),
    );
    await writeFile(join(legacyRoot, "bindings.json"), "original backup");
    await f.service.reconcile();
    expect(
      await readFile(
        join(f.root, "archives", "memory-learning-v1", "memory-skill-promotion", "bindings.json"),
        "utf8",
      ),
    ).toBe("original backup");
  });
});
