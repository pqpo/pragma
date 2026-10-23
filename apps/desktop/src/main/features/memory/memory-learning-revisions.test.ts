import {
  ContextStoreRevisionRequestSchema,
  SkillRevisionRequestV4Schema,
} from "@pragma/built-in-agents";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CapabilityStoreError, type CapabilityStore } from "@pragma/local-host/deployment";
import {
  createContextStoreStore,
  ContextStoreStoreError,
  type ContextStoreStore,
} from "@pragma/local-host/deployment";
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
  const skillJobs = new Map<
    string,
    {
      id: string;
      state: string;
      supersededBy?: string;
      request?: { source: string; capabilityId: string };
    }
  >();
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
    skillWorkspacePath: join(root, "workspace", "system-memory"),
    knowledgeRevisions: {
      submit: knowledgeStart,
      get: async () => ({ state: knowledgeState }),
      scheduleProcessing: vi.fn(),
    } as unknown as ContextStoreRevisionService,
    skillRevisions: {
      start: skillStart,
      get: async (id: string) => skillJobs.get(id) ?? { id, state: skillState },
      scheduleProcessing: vi.fn(),
    } as unknown as SkillRevisionService,
    contextStores: {
      list: async () =>
        [...existingStoreIds].map((id) => ({
          id,
          name: "Knowledge",
          description: "Guidance",
          status: "ready",
          contentRevision: 1,
          snapshotHash: "c".repeat(64),
        })),
      get: async (id: string) => {
        if (!existingStoreIds.has(id))
          throw new ContextStoreStoreError("store_not_found", "Missing store");
        return { id, status: "ready", contentRevision: 1, snapshotHash: "c".repeat(64) };
      },
      getSnapshot: async (id: string) => {
        if (!existingStoreIds.has(id)) {
          throw new ContextStoreStoreError("store_not_found", "Missing store");
        }
        return { files: [] };
      },
      createFromSnapshot: createStore,
    } as unknown as ContextStoreStore,
    capabilities: {
      list: async () => [],
      getSkillDocument: async () => ({
        content: "# Workflow\nRun scripts/verify.py and read references/guide.md.",
      }),
      listSkillFiles: vi.fn(async () => [
        { path: "SKILL.md", size: 70 },
        { path: "scripts/verify.py", size: 40 },
        { path: "references/guide.md", size: 40 },
      ]),
      getSkillFile: vi.fn(async (input: { id: string; revision?: number; path: string }) => ({
        capabilityId: input.id,
        revision: input.revision ?? 1,
        path: input.path,
        content:
          input.path === "scripts/verify.py"
            ? "assert verify_all_outputs()"
            : "# Actual reference guide",
        size: 40,
      })),
      get: async (id: string) => {
        if (capabilityMissing) {
          throw new CapabilityStoreError("capability_not_found", "Missing capability");
        }
        return {
          manifest: { id, latestRevision: 1 },
          health: { status: "ready" },
          definition: {
            kind: capabilityKind,
            name: "Skill",
            description: "Reusable",
            contentHash: "c".repeat(64),
          },
        };
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
    skillJobId,
    skillStart,
    mountStore,
    bindSkill,
    createStore,
    createSkill,
    mergeKnowledge: () => {
      knowledgeState = "merged";
      for (const [request] of knowledgeStart.mock.calls) existingStoreIds.add(request.storeId);
    },
    publishSkill: () => {
      skillState = "completed";
    },
    setSkillJob: (
      id: string,
      job: {
        state: string;
        supersededBy?: string;
        request?: { source: string; capabilityId: string };
      },
    ) => {
      skillJobs.set(id, { id, ...job });
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
      plan: {
        action: "apply" as const,
        ...knowledgePlanFields(),
        name: "Knowledge",
        description: "Reusable knowledge",
      },
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
    await f.service.submitKnowledge({
      ...input,
      plan: {
        ...input.plan,
        target: {
          type: "revise",
          storeId: f.knowledgeStart.mock.calls[0]![0].storeId,
          baseRevision: 1,
          snapshotHash: "c".repeat(64),
        },
      },
      sourceDigest: "e".repeat(64),
    });
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
      plan: {
        action: "apply" as const,
        ...knowledgePlanFields(),
        name: "Knowledge",
        description: "Guidance",
      },
      sources: [],
    };
    await f.service.submitKnowledge({ ...base, sourceDigest: "a".repeat(64) });
    await expect(
      f.service.submitKnowledge({ ...base, sourceDigest: "b".repeat(64) }),
    ).rejects.toThrow("memory_revision_pending");
    await expect(
      f.service.assertKnowledgeAvailable({ expertRef: f.expertRef, sourceDigest: "b".repeat(64) }),
    ).rejects.toThrow("memory_revision_pending");
    await expect(
      f.service.assertKnowledgeAvailable({ expertRef: f.expertRef, sourceDigest: "a".repeat(64) }),
    ).resolves.toBeUndefined();
    expect(f.knowledgeStart).toHaveBeenCalledTimes(1);
    f.mergeKnowledge();
    expect(await f.service.reconcile()).toBe(true);
    expect(await f.service.reconcile()).toBe(false);
    await expect(
      f.service.assertKnowledgeAvailable({ expertRef: f.expertRef, sourceDigest: "b".repeat(64) }),
    ).resolves.toBeUndefined();
    await f.service.submitKnowledge({
      ...base,
      plan: {
        ...base.plan,
        target: {
          type: "revise",
          storeId: f.knowledgeStart.mock.calls[0]![0].storeId,
          baseRevision: 1,
          snapshotHash: "c".repeat(64),
        },
      },
      sourceDigest: "b".repeat(64),
    });
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
    expect(f.skillStart).toHaveBeenCalledWith(expect.anything(), {
      workspacePath: join(f.root, "workspace", "system-memory"),
    });
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
    await expect(
      f.service.assertSkillsAvailable({
        expertRef: f.expertRef,
        sourceDigest: "b".repeat(64),
        plan: base.plan,
      }),
    ).rejects.toThrow("memory_revision_pending");
    await expect(
      f.service.assertSkillsAvailable({
        expertRef: f.expertRef,
        sourceDigest: "a".repeat(64),
        plan: base.plan,
      }),
    ).resolves.toBeUndefined();
    await expect(
      f.service.assertSkillsAvailable({
        expertRef: f.expertRef,
        sourceDigest: "b".repeat(64),
        plan: {
          action: "apply",
          changes: [{ ...base.plan.changes[0]!, normalizedKey: "workflow.independent" }],
        },
      }),
    ).resolves.toBeUndefined();
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

  it("follows a superseded Skill creation and binds its published replacement", async () => {
    const f = await fixture();
    const sourceRefs = [1, 2, 3].map((revision) => ({
      kind: "episodic" as const,
      id: `episode-${revision}`,
      revision,
    }));
    await f.service.submitSkills({
      expertRef: f.expertRef,
      sourceDigest: "a".repeat(64),
      plan: {
        action: "apply",
        changes: [
          {
            name: "Workflow",
            description: "Reusable workflow",
            normalizedKey: "workflow.replaced",
            sourceRefs,
            target: { type: "create" },
          },
        ],
      },
      sources: [],
    });
    const replacementJobId = randomUUID();
    const replacementCapabilityId = randomUUID();
    f.setSkillJob(f.skillJobId, {
      state: "superseded",
      supersededBy: replacementJobId,
    });
    f.setSkillJob(replacementJobId, {
      state: "pending_review",
      request: { source: "memory-learning", capabilityId: replacementCapabilityId },
    });
    expect(await f.service.reconcile()).toBe(false);
    const statePath = join(f.root, "state", "memory-learning-revisions", "bindings.json");
    expect(JSON.parse(await readFile(statePath, "utf8")).skills).toMatchObject([
      {
        revisionJobId: replacementJobId,
        capabilityId: replacementCapabilityId,
        revisionPending: true,
        mounted: false,
      },
    ]);
    f.setSkillJob(replacementJobId, {
      state: "completed",
      request: { source: "memory-learning", capabilityId: replacementCapabilityId },
    });
    expect(await f.service.reconcile()).toBe(true);
    expect(f.bindSkill).toHaveBeenCalledWith(f.expertRef, replacementCapabilityId);
    expect(await f.service.reconcile()).toBe(false);
    expect(f.bindSkill).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(statePath, "utf8")).skills).toMatchObject([
      {
        revisionJobId: replacementJobId,
        capabilityId: replacementCapabilityId,
        revisionPending: false,
        mounted: true,
      },
    ]);
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
        schemaVersion: "pragma.memory-learning-revisions/v3",
        knowledge: [],
        skills: [],
      }),
    );
    await expect(f.service.reconcile()).rejects.toThrow();
    expect(await readFile(join(currentRoot, "bindings.json"), "utf8")).toContain("/v3");
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

it("retries settlement wake failures before committing the resolved binding", async () => {
  const f = await fixture();
  await f.service.submitKnowledge({
    expertRef: f.expertRef,
    sourceDigest: "a".repeat(64),
    plan: { action: "apply", ...knowledgePlanFields(), name: "Knowledge", description: "Guidance" },
    sources: [],
  });
  f.mergeKnowledge();
  const wake = vi.fn(async () => undefined).mockRejectedValueOnce(new Error("wake interrupted"));
  await expect(f.service.reconcile(wake)).rejects.toThrow("wake interrupted");
  await expect(
    f.service.assertKnowledgeAvailable({ expertRef: f.expertRef, sourceDigest: "b".repeat(64) }),
  ).rejects.toThrow("memory_revision_pending");
  expect(await f.service.reconcile(wake)).toBe(true);
  expect(wake).toHaveBeenCalledTimes(2);
  await expect(
    f.service.assertKnowledgeAvailable({ expertRef: f.expertRef, sourceDigest: "b".repeat(64) }),
  ).resolves.toBeUndefined();
  expect(await f.service.reconcile(wake)).toBe(false);
  expect(wake).toHaveBeenCalledTimes(2);
});

it("recovers a missed historical wake once per process even without a new settlement", async () => {
  const f = await fixture();
  await f.service.submitKnowledge({
    expertRef: f.expertRef,
    sourceDigest: "a".repeat(64),
    plan: { action: "apply", ...knowledgePlanFields(), name: "Knowledge", description: "Guidance" },
    sources: [],
  });
  f.mergeKnowledge();
  expect(await f.service.reconcile()).toBe(true);
  const wake = vi.fn(async () => undefined);
  expect(await f.service.reconcile(wake)).toBe(false);
  expect(await f.service.reconcile(wake)).toBe(false);
  expect(wake).toHaveBeenCalledOnce();
});

it("allows independent Skill creation while another target awaits review", async () => {
  const f = await fixture();
  const input = (normalizedKey: string, sourceDigest: string) => ({
    expertRef: f.expertRef,
    sourceDigest,
    plan: {
      action: "apply" as const,
      changes: [
        {
          name: normalizedKey,
          description: "Reusable workflow",
          normalizedKey,
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
  });
  await f.service.submitSkills(input("workflow.first", "a".repeat(64)));
  const independent = input("workflow.independent", "b".repeat(64));
  await expect(f.service.assertSkillsAvailable(independent)).resolves.toBeUndefined();
  await f.service.submitSkills(independent);
  expect(f.skillStart).toHaveBeenCalledTimes(2);
  const pendingCapabilityId = f.skillStart.mock.calls[0]![0].capabilityId;
  await expect(
    f.service.assertSkillsAvailable({
      ...independent,
      plan: {
        action: "apply",
        changes: [
          {
            ...independent.plan.changes[0]!,
            normalizedKey: "workflow.alias",
            target: { type: "revise", capabilityId: pendingCapabilityId },
          },
        ],
      },
    }),
  ).rejects.toThrow("memory_revision_pending");
});

function knowledgePlanFields() {
  return {
    rationale: "Add supported reusable knowledge.",
    sourceRefs: [],
    maturity: "validated-artifact" as const,
    target: {
      type: "create" as const,
      justification:
        "A complete independently useful verified guide with no related existing base.",
    },
  };
}

it("reuses an ordinary unmounted knowledge base and mounts it only after reviewed publication", async () => {
  const f = await fixture();
  const contextStores = createContextStoreStore({ storesPath: join(f.root, "knowledge") });
  const related = await contextStores.createFromSnapshot({
    name: "Migration handbook",
    description: "Persistent schema upgrades and recovery",
    files: [
      {
        id: "guide.md",
        content: "# Migration\nPreserve backups and restore interrupted journals.",
        metadata: { trigger: "model_decision", priority: "normal" },
      },
    ],
    author: "user",
    summary: "Create a manual knowledge base.",
  });
  let merged = false;
  const service = createMemoryLearningRevisions({
    statePath: join(f.root, "ordinary-bindings"),
    skillWorkspacePath: join(f.root, "workspace"),
    knowledgeRevisions: {
      submit: f.knowledgeStart,
      get: async () => ({ state: merged ? "merged" : "pending_review" }),
      scheduleProcessing: vi.fn(),
    } as unknown as ContextStoreRevisionService,
    skillRevisions: {} as SkillRevisionService,
    contextStores,
    capabilities: {} as CapabilityStore,
    expertExists: async () => true,
    mountedAssets: async () => ({ stores: [], skills: [] }),
    mountStore: f.mountStore,
    bindSkill: f.bindSkill,
  });
  const targets = await service.listKnowledgeTargets({ expertRef: f.expertRef });
  expect(targets).toEqual([expect.objectContaining({ storeId: related.id, mounted: false })]);
  const target = targets[0]!;
  expect(await service.readKnowledgeTarget(target)).toContain("restore interrupted journals");
  const plan = {
    action: "apply" as const,
    ...knowledgePlanFields(),
    name: related.name,
    description: related.description,
    maturity: "incremental" as const,
    target: {
      type: "revise" as const,
      storeId: target.storeId,
      baseRevision: target.baseRevision,
      snapshotHash: target.snapshotHash,
    },
  };
  await service.submitKnowledge({
    expertRef: f.expertRef,
    sourceDigest: "a".repeat(64),
    plan,
    sources: [],
  });
  expect(f.knowledgeStart).toHaveBeenCalledWith(
    expect.objectContaining({ operation: "revise", storeId: related.id }),
  );
  expect(f.mountStore).not.toHaveBeenCalled();
  // A different expert must wait for this same target, while an unrelated new topic remains available.
  await expect(
    service.assertKnowledgeAvailable({
      expertRef: "expert:2h2j3k4m5n6p7q8r",
      sourceDigest: "b".repeat(64),
      plan,
    }),
  ).rejects.toThrow("memory_revision_pending");
  await expect(
    service.assertKnowledgeAvailable({
      expertRef: f.expertRef,
      sourceDigest: "b".repeat(64),
      plan: {
        ...plan,
        name: "Other topic",
        target: { type: "create", justification: "An unrelated mature topic." },
      },
    }),
  ).resolves.toBeUndefined();
  merged = true;
  await service.reconcile();
  expect(f.mountStore).toHaveBeenCalledWith(f.expertRef, related.id);
  // A stale plan never silently creates a replacement base.
  await contextStores.createFile(related.id, "new.md", "# New content");
  await expect(
    service.submitKnowledge({
      expertRef: f.expertRef,
      sourceDigest: "c".repeat(64),
      plan,
      sources: [],
    }),
  ).rejects.toThrow("memory_learning_target_changed");
  expect(f.knowledgeStart).toHaveBeenCalledOnce();
});

it("upgrades a real v1 binding written by the historical service without losing its pending revision", async () => {
  const f = await fixture();
  const dir = join(f.root, "state", "memory-learning-revisions");
  await mkdir(dir, { recursive: true });
  const historical = await readFile(
    new URL("./fixtures/memory-learning-bindings-v1.json", import.meta.url),
    "utf8",
  );
  await writeFile(join(dir, "bindings.json"), historical);
  await f.service.reconcile();
  const current = JSON.parse(await readFile(join(dir, "bindings.json"), "utf8"));
  const old = JSON.parse(historical);
  expect(current).toMatchObject({
    schemaVersion: "pragma.memory-learning-revisions/v2",
    knowledge: [{ ...old.knowledge[0], topicKey: `legacy:${old.knowledge[0].storeId}` }],
  });
  expect(
    JSON.parse(await readFile(join(dir, "migration-backups", "bindings-v1.json"), "utf8")),
  ).toEqual(old);
  const unchanged = await readFile(join(dir, "bindings.json"), "utf8");
  await f.service.reconcile();
  expect(await readFile(join(dir, "bindings.json"), "utf8")).toBe(unchanged);
});

it("replays an interrupted v1 to v2 binding migration from its stable journal", async () => {
  const f = await fixture();
  const dir = join(f.root, "state", "memory-learning-revisions");
  await mkdir(dir, { recursive: true });
  const old = JSON.parse(
    await readFile(new URL("./fixtures/memory-learning-bindings-v1.json", import.meta.url), "utf8"),
  );
  const current = {
    ...old,
    schemaVersion: "pragma.memory-learning-revisions/v2",
    knowledge: old.knowledge.map((item: { storeId: string }) => ({
      ...item,
      topicKey: `legacy:${item.storeId}`,
    })),
  };
  await writeFile(join(dir, "bindings.json"), JSON.stringify(old));
  await writeFile(
    join(dir, "migration-v2.json"),
    JSON.stringify({
      schemaVersion: "pragma.state-migration/v1",
      resource: { family: "pragma.memory-learning-revisions", id: "bindings" },
      fromVersion: 1,
      toVersion: 2,
      documents: { "bindings.json": current, "migration-backups/bindings-v1.json": old },
    }),
  );
  await f.service.reconcile();
  expect(JSON.parse(await readFile(join(dir, "bindings.json"), "utf8"))).toEqual(current);
  await expect(stat(join(dir, "migration-v2.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps Skill identity keys scoped to the requesting expert while sharing target occupancy", async () => {
  const f = await fixture();
  const otherExpert = "expert:2h2j3k4m5n6p7q8r";
  const change = {
    name: "Workflow",
    description: "Reusable workflow",
    normalizedKey: "workflow.foreign",
    sourceRefs: [{ kind: "episodic" as const, id: "episode", revision: 1 }],
    target: { type: "create" as const },
  };
  await f.service.submitSkills({
    expertRef: otherExpert,
    sourceDigest: "a".repeat(64),
    sources: [],
    plan: { action: "apply", changes: [change] },
  });
  const capabilityId = f.skillStart.mock.calls[0]![0].capabilityId;
  // The same local target is visible while pending, but another expert's keys do not own this expert's identity.
  expect(await f.service.listSkillTargets({ expertRef: f.expertRef })).toMatchObject([
    { capabilityId, pending: true, normalizedKeys: [`skill:${capabilityId}`] },
  ]);
  f.publishSkill();
  await f.service.reconcile();
  await f.service.submitSkills({
    expertRef: f.expertRef,
    sourceDigest: "b".repeat(64),
    sources: [],
    plan: {
      action: "apply",
      changes: [
        {
          ...change,
          normalizedKey: "workflow.own",
          target: { type: "revise", capabilityId, baseRevision: 1, contentHash: "c".repeat(64) },
        },
      ],
    },
  });
  await f.service.reconcile();
  expect(await f.service.listSkillTargets({ expertRef: f.expertRef })).toMatchObject([
    { capabilityId, normalizedKeys: ["workflow.own"] },
  ]);
});

it("exposes a pinned Skill package catalog and lazily reads scripts and references", async () => {
  const f = await fixture();
  const target = {
    bindingId: randomUUID(),
    capabilityId: "1h2j3k4m5n6p7q8r",
    name: "Workflow",
    description: "Existing workflow",
    normalizedKeys: ["workflow"],
    baseRevision: 1,
    contentHash: "c".repeat(64),
  };
  const body = JSON.parse(await f.service.readSkillTarget(target));
  expect(body.files.map((file: { path: string }) => file.path)).toEqual([
    "SKILL.md",
    "scripts/verify.py",
    "references/guide.md",
  ]);
  expect(body.document).toContain("scripts/verify.py");
  expect(body).not.toHaveProperty("contents");
  expect(await f.service.readSkillTargetFile(target, "scripts/verify.py")).toBe(
    "assert verify_all_outputs()",
  );
  expect(await f.service.readSkillTargetFile(target, "references/guide.md")).toContain(
    "Actual reference guide",
  );
});

it("submits complete maximum-sized Unicode sources to both Knowledge and Skill revision owners", async () => {
  const f = await fixture();
  f.knowledgeStart.mockImplementation(async (request) => {
    ContextStoreRevisionRequestSchema.parse(request);
    return { id: randomUUID() };
  });
  f.skillStart.mockImplementation(async (request) => {
    SkillRevisionRequestV4Schema.parse(request);
    return { id: f.skillJobId, capabilityId: request.capabilityId };
  });
  const source = {
    ref: { kind: "episodic" as const, id: "maximum-workflow", revision: 1 },
    rootRef: { type: "pragma.expert", id: "expert-a" },
    producerRefs: [],
    sourceExecutionIds: [],
    title: "Verified complete artifact",
    body: "验".repeat(409980) + "validated-at-end",
    observedAt: "2026-08-01T00:00:00.000Z",
    verified: true,
    outcome: "succeeded" as const,
    hasSuccessfulRecovery: false,
    visibility: { mode: "host-private" as const },
    sensitivity: "internal" as const,
  };
  await f.service.submitKnowledge({
    expertRef: f.expertRef,
    sourceDigest: "e".repeat(64),
    sources: [source],
    plan: {
      action: "apply",
      ...knowledgePlanFields(),
      name: "Verified guide",
      description: "Reusable artifact",
      sourceRefs: [source.ref],
    },
  });
  await f.service.submitSkills({
    expertRef: f.expertRef,
    sourceDigest: "e".repeat(64),
    sources: [source],
    plan: {
      action: "apply",
      changes: [
        {
          name: "Verified workflow",
          description: "Reusable workflow",
          normalizedKey: "verified.workflow",
          sourceRefs: [source.ref],
          target: { type: "create" },
        },
      ],
    },
  });
  expect(f.knowledgeStart).toHaveBeenCalledWith(
    expect.objectContaining({ prompt: expect.stringContaining("validated-at-end") }),
  );
  expect(f.skillStart).toHaveBeenCalledWith(
    expect.objectContaining({ prompt: expect.stringContaining("validated-at-end") }),
    expect.anything(),
  );
});
