import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MemorySkillCandidateSchema } from "../../../shared/contracts/index.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { SkillRevisionService } from "../capabilities/skill-revision-service.ts";
import { createMemorySkillPromotionService } from "./memory-skill-promotion.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Memory Skill promotion", () => {
  it("migrates an evaluating v1 candidate to needs_attention for synchronous resubmission", async () => {
    const statePath = join(tmpdir(), `pragma-memory-skill-migration-${randomUUID()}`);
    roots.push(statePath);
    const id = "00000000-0000-4000-8000-000000000009";
    const candidatePath = join(statePath, "candidates", `${id}.json`);
    const legacy = await legacyCandidate(id);
    await mkdir(join(statePath, "candidates"), { recursive: true });
    await writeFile(candidatePath, JSON.stringify(legacy));
    const service = createMemorySkillPromotionService({
      statePath,
      capabilities: {} as CapabilityStore,
      revisions: {} as SkillRevisionService,
      expertExists: async () => true,
      bindSkill: async () => undefined,
    });

    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({
        schemaVersion: "pragma.memory-skill-candidate/v2",
        revision: 3,
        state: "needs_attention",
        lastErrorCode: "skill_candidate_validation_required",
      }),
    ]);
    const stored = JSON.parse(await readFile(candidatePath, "utf8")) as Record<string, unknown>;
    expect(stored).not.toHaveProperty("evaluation");
    expect(stored).not.toHaveProperty("replayCases");
    await expect(
      readFile(join(statePath, "migration-backups", `${id}.v1.json`), "utf8"),
    ).resolves.toContain("pragma.memory-skill-candidate/v1");
  });

  it("finishes a candidate migration journal left after atomic replacement", async () => {
    const statePath = join(tmpdir(), `pragma-memory-skill-recovery-${randomUUID()}`);
    roots.push(statePath);
    const id = "00000000-0000-4000-8000-000000000008";
    const candidatePath = join(statePath, "candidates", `${id}.json`);
    const backupPath = join(statePath, "migration-backups", `${id}.v1.json`);
    const journalPath = join(statePath, "migration-journals", `${id}.v1-to-v2.json`);
    const legacy = await legacyCandidate(id);
    const current = {
      ...legacy,
      schemaVersion: "pragma.memory-skill-candidate/v2",
      revision: 3,
      state: "needs_attention",
      lastErrorCode: "skill_candidate_validation_required",
    } as Record<string, unknown>;
    delete current["replayCases"];
    delete current["boundaryCase"];
    delete current["evaluation"];
    await mkdir(join(statePath, "candidates"), { recursive: true });
    await mkdir(join(statePath, "migration-backups"), { recursive: true });
    await mkdir(join(statePath, "migration-journals"), { recursive: true });
    await writeFile(candidatePath, JSON.stringify(current));
    await writeFile(backupPath, JSON.stringify(legacy));
    await writeFile(
      journalPath,
      JSON.stringify({
        schemaVersion: "pragma.memory-skill-candidate-migration/v1",
        candidateId: id,
        sourceVersion: "pragma.memory-skill-candidate/v1",
        targetVersion: "pragma.memory-skill-candidate/v2",
        recordPath: candidatePath,
        backupPath,
        sourceHash: createHash("sha256").update(JSON.stringify(legacy)).digest("hex"),
      }),
    );
    const service = promotionService(statePath);

    await expect(service.list()).resolves.toHaveLength(1);
    await expect(readFile(journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replays a migration journal left before record replacement deterministically", async () => {
    const statePath = join(tmpdir(), `pragma-memory-skill-recovery-source-${randomUUID()}`);
    roots.push(statePath);
    const id = "00000000-0000-4000-8000-000000000006";
    const candidatePath = join(statePath, "candidates", `${id}.json`);
    const backupPath = join(statePath, "migration-backups", `${id}.v1.json`);
    const journalPath = join(statePath, "migration-journals", `${id}.v1-to-v2.json`);
    const legacy = await legacyCandidate(id);
    await mkdir(join(statePath, "candidates"), { recursive: true });
    await mkdir(join(statePath, "migration-backups"), { recursive: true });
    await mkdir(join(statePath, "migration-journals"), { recursive: true });
    await writeFile(candidatePath, JSON.stringify(legacy));
    await writeFile(backupPath, JSON.stringify(legacy));
    await writeFile(
      journalPath,
      JSON.stringify({
        schemaVersion: "pragma.memory-skill-candidate-migration/v1",
        candidateId: id,
        sourceVersion: "pragma.memory-skill-candidate/v1",
        targetVersion: "pragma.memory-skill-candidate/v2",
        recordPath: candidatePath,
        backupPath,
        sourceHash: createHash("sha256").update(JSON.stringify(legacy)).digest("hex"),
      }),
    );

    const [migrated] = await promotionService(statePath).list();

    expect(migrated).toMatchObject({
      schemaVersion: "pragma.memory-skill-candidate/v2",
      updatedAt: legacy.updatedAt,
    });
    await expect(readFile(journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a future candidate version without replacing it", async () => {
    const statePath = join(tmpdir(), `pragma-memory-skill-future-${randomUUID()}`);
    roots.push(statePath);
    const id = "00000000-0000-4000-8000-000000000007";
    const candidatePath = join(statePath, "candidates", `${id}.json`);
    const future = {
      ...(await legacyCandidate(id)),
      schemaVersion: "pragma.memory-skill-candidate/v3",
    };
    await mkdir(join(statePath, "candidates"), { recursive: true });
    await writeFile(candidatePath, JSON.stringify(future));

    await expect(promotionService(statePath).list()).rejects.toThrow();
    await expect(readFile(candidatePath, "utf8")).resolves.toContain(
      "pragma.memory-skill-candidate/v3",
    );
  });

  it("serializes concurrent validation updates and rejects the stale revision", async () => {
    const statePath = join(tmpdir(), `pragma-memory-skill-promotion-${randomUUID()}`);
    roots.push(statePath);
    const candidate = MemorySkillCandidateSchema.parse({
      schemaVersion: "pragma.memory-skill-candidate/v2",
      id: "00000000-0000-4000-8000-000000000001",
      revision: 1,
      expertRef: "expert:0000000000000001",
      sourceDigest: "a".repeat(64),
      normalizedKey: "safe-workflow",
      sourceRefs: [1, 2, 3].map((revision) => ({
        kind: "episodic",
        id: `episode-${revision}`,
        revision,
      })),
      package: validPackage(),
      route: { type: "create" },
      state: "needs_attention",
      lastErrorCode: "skill_candidate_validation_required",
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    });
    const candidatesPath = join(statePath, "candidates");
    await mkdir(candidatesPath, { recursive: true });
    await writeFile(join(candidatesPath, `${candidate.id}.json`), JSON.stringify(candidate));

    const service = createMemorySkillPromotionService({
      statePath,
      capabilities: {} as CapabilityStore,
      revisions: {} as SkillRevisionService,
      expertExists: async () => true,
      bindSkill: async () => undefined,
    });

    const results = await Promise.allSettled([
      service.update({
        id: candidate.id,
        expectedRevision: candidate.revision,
        package: candidate.package,
      }),
      service.update({
        id: candidate.id,
        expectedRevision: candidate.revision,
        package: candidate.package,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: "skill_candidate_revision_conflict" }),
    });
    await expect(
      readFile(join(statePath, "migration-backups", `${candidate.id}.v1.json`), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a Memory revision pending until the formal Skill revision is published", async () => {
    const statePath = join(tmpdir(), `pragma-memory-skill-revision-${randomUUID()}`);
    roots.push(statePath);
    const candidateId = "00000000-0000-4000-8000-000000000005";
    const bindingId = "10000000-0000-4000-8000-000000000005";
    const capabilityId = "20000000-0000-4000-8000-000000000005";
    const jobId = "30000000-0000-4000-8000-000000000005";
    const candidate = MemorySkillCandidateSchema.parse({
      schemaVersion: "pragma.memory-skill-candidate/v2",
      id: candidateId,
      revision: 1,
      expertRef: "expert:0000000000000001",
      sourceDigest: "b".repeat(64),
      normalizedKey: "safe-workflow",
      sourceRefs: [1, 2, 3].map((revision) => ({
        kind: "episodic",
        id: `episode-${revision}`,
        revision,
      })),
      package: validPackage(),
      route: {
        type: "needs_target",
        options: [
          { bindingId, capabilityId, name: "safe-workflow", description: "Safe." },
          {
            bindingId: "10000000-0000-4000-8000-000000000006",
            capabilityId: "20000000-0000-4000-8000-000000000006",
            name: "other-workflow",
            description: "Other.",
          },
        ],
      },
      state: "needs_target",
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    });
    let jobState = "editing";
    const revisions = {
      submit: async () => ({ id: jobId }),
      get: async () => ({ id: jobId, state: jobState }),
    } as unknown as SkillRevisionService;
    await mkdir(join(statePath, "candidates"), { recursive: true });
    await writeFile(
      join(statePath, "candidates", `${candidate.id}.json`),
      JSON.stringify(candidate),
    );
    await writeFile(
      join(statePath, "bindings.json"),
      JSON.stringify({
        schemaVersion: "pragma.memory-skill-bindings/v1",
        bindings: [
          {
            bindingId,
            expertRef: candidate.expertRef,
            capabilityId,
            normalizedKeys: ["existing-pattern"],
            lastSourceDigest: "c".repeat(64),
            updatedAt: candidate.updatedAt,
          },
        ],
      }),
    );
    const service = createMemorySkillPromotionService({
      statePath,
      capabilities: {} as CapabilityStore,
      revisions,
      expertExists: async () => true,
      bindSkill: async () => undefined,
    });

    const pending = await service.resolveTarget({
      id: candidate.id,
      expectedRevision: candidate.revision,
      target: { type: "revise", bindingId },
    });
    expect(pending).toMatchObject({
      state: "revision_pending",
      capabilityId,
      revisionJobId: jobId,
    });
    const before = JSON.parse(await readFile(join(statePath, "bindings.json"), "utf8")) as {
      bindings: Array<{ normalizedKeys: string[] }>;
    };
    expect(before.bindings[0]?.normalizedKeys).toEqual(["existing-pattern"]);

    jobState = "completed";
    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({ state: "promoted", capabilityId, revisionJobId: jobId }),
    ]);
    const after = JSON.parse(await readFile(join(statePath, "bindings.json"), "utf8")) as {
      bindings: Array<{ normalizedKeys: string[] }>;
    };
    expect(after.bindings[0]?.normalizedKeys).toEqual(["existing-pattern", "safe-workflow"]);
  });

  it("isolates a missing revision Job and keeps other Experts recoverable", async () => {
    const statePath = join(tmpdir(), `pragma-memory-skill-orphan-${randomUUID()}`);
    roots.push(statePath);
    const missingCandidateId = "00000000-0000-4000-8000-000000000011";
    const completedCandidateId = "00000000-0000-4000-8000-000000000012";
    const missingJobId = "30000000-0000-4000-8000-000000000011";
    const completedJobId = "30000000-0000-4000-8000-000000000012";
    const missingCapabilityId = "20000000-0000-4000-8000-000000000011";
    const completedCapabilityId = "20000000-0000-4000-8000-000000000012";
    const missingBindingId = "10000000-0000-4000-8000-000000000011";
    const completedBindingId = "10000000-0000-4000-8000-000000000012";
    const timestamp = "2026-08-06T00:00:00.000Z";
    const pendingCandidate = (input: {
      id: string;
      expertRef: string;
      normalizedKey: string;
      capabilityId: string;
      bindingId: string;
      jobId: string;
    }) =>
      MemorySkillCandidateSchema.parse({
        schemaVersion: "pragma.memory-skill-candidate/v2",
        id: input.id,
        revision: 1,
        expertRef: input.expertRef,
        sourceDigest: input.id.replaceAll("-", "").padEnd(64, "0"),
        normalizedKey: input.normalizedKey,
        sourceRefs: [1, 2, 3].map((revision) => ({
          kind: "episodic",
          id: `episode-${input.id}-${revision}`,
          revision,
        })),
        package: { ...validPackage(), name: input.normalizedKey },
        route: { type: "revise", bindingId: input.bindingId },
        state: "revision_pending",
        capabilityId: input.capabilityId,
        revisionJobId: input.jobId,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    const missingCandidate = pendingCandidate({
      id: missingCandidateId,
      expertRef: "expert:0000000000000001",
      normalizedKey: "missing-job-workflow",
      capabilityId: missingCapabilityId,
      bindingId: missingBindingId,
      jobId: missingJobId,
    });
    const completedCandidate = pendingCandidate({
      id: completedCandidateId,
      expertRef: "expert:0000000000000002",
      normalizedKey: "completed-workflow",
      capabilityId: completedCapabilityId,
      bindingId: completedBindingId,
      jobId: completedJobId,
    });
    await mkdir(join(statePath, "candidates"), { recursive: true });
    await Promise.all(
      [missingCandidate, completedCandidate].map(
        async (candidate) =>
          await writeFile(
            join(statePath, "candidates", `${candidate.id}.json`),
            JSON.stringify(candidate),
          ),
      ),
    );
    await writeFile(
      join(statePath, "bindings.json"),
      JSON.stringify({
        schemaVersion: "pragma.memory-skill-bindings/v1",
        bindings: [
          {
            bindingId: missingBindingId,
            expertRef: missingCandidate.expertRef,
            capabilityId: missingCapabilityId,
            normalizedKeys: ["existing-missing-pattern"],
            lastSourceDigest: "a".repeat(64),
            updatedAt: timestamp,
          },
          {
            bindingId: completedBindingId,
            expertRef: completedCandidate.expertRef,
            capabilityId: completedCapabilityId,
            normalizedKeys: ["existing-completed-pattern"],
            lastSourceDigest: "b".repeat(64),
            updatedAt: timestamp,
          },
        ],
      }),
    );
    let missingJobRestored = false;
    const service = createMemorySkillPromotionService({
      statePath,
      capabilities: {
        async get(id: string) {
          return {
            manifest: { latestRevision: 2 },
            definition: {
              kind: "skill",
              name: id === completedCapabilityId ? "completed-workflow" : "missing-job-workflow",
              description: "Recovered Skill.",
            },
          };
        },
      } as unknown as CapabilityStore,
      revisions: {
        async get(id: string) {
          if (id === missingJobId && !missingJobRestored) {
            throw Object.assign(new Error("Skill revision job not found."), {
              code: "skill_revision_job_not_found",
            });
          }
          return { id, state: id === completedJobId ? "completed" : "editing" };
        },
      } as unknown as SkillRevisionService,
      expertExists: async () => true,
      bindSkill: async () => undefined,
    });

    const candidates = await service.list();
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: missingCandidateId,
          state: "revision_pending",
          lastErrorCode: "memory_skill_revision_job_missing",
        }),
        expect.objectContaining({ id: completedCandidateId, state: "promoted" }),
      ]),
    );
    await expect(
      service.targetReader.listTargets({ expertRef: completedCandidate.expertRef }),
    ).resolves.toEqual([
      expect.objectContaining({
        bindingId: completedBindingId,
        capabilityId: completedCapabilityId,
      }),
    ]);
    await expect(service.recover()).resolves.toBeUndefined();

    missingJobRestored = true;
    const recovered = (await service.list()).find(
      (candidate) => candidate.id === missingCandidateId,
    );
    expect(recovered).toMatchObject({ state: "revision_pending" });
    expect(recovered?.lastErrorCode).toBeUndefined();
    await expect(
      service.reject({ id: recovered!.id, expectedRevision: recovered!.revision }),
    ).resolves.toMatchObject({ state: "rejected" });
  });
});

function validPackage() {
  return {
    name: "safe-workflow",
    description: "Run a safe workflow.",
    files: [
      {
        path: "SKILL.md",
        content:
          "---\nname: safe-workflow\ndescription: Run a safe workflow.\n---\n\nFollow the workflow.",
      },
    ],
  };
}

async function legacyCandidate(
  id: string,
): Promise<Record<string, unknown> & { readonly updatedAt: string }> {
  const fixture = JSON.parse(
    await readFile(join(import.meta.dirname, "fixtures", "memory-skill-candidate-v1.json"), "utf8"),
  ) as Record<string, unknown>;
  const updatedAt = fixture["updatedAt"];
  if (typeof updatedAt !== "string") throw new Error("historical fixture has no updatedAt");
  return { ...fixture, id, updatedAt };
}

function promotionService(statePath: string) {
  return createMemorySkillPromotionService({
    statePath,
    capabilities: {} as CapabilityStore,
    revisions: {} as SkillRevisionService,
    expertExists: async () => true,
    bindSkill: async () => undefined,
  });
}
