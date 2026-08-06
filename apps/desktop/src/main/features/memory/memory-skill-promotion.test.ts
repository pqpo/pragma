import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
  it("serializes concurrent retries and rejects the stale revision", async () => {
    const statePath = join(tmpdir(), `pragma-memory-skill-promotion-${randomUUID()}`);
    roots.push(statePath);
    const candidate = MemorySkillCandidateSchema.parse({
      schemaVersion: "pragma.memory-skill-candidate/v1",
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
      package: {
        name: "safe-workflow",
        description: "Run a safe workflow.",
        files: [
          {
            path: "SKILL.md",
            content:
              "---\nname: safe-workflow\ndescription: Run a safe workflow.\n---\n\nFollow the workflow.",
          },
        ],
      },
      replayCases: [1, 2, 3].map((index) => ({
        objective: `Replay ${index}`,
        requiredBehaviors: ["Complete the workflow."],
        forbiddenBehaviors: [],
      })),
      boundaryCase: {
        objective: "Reject an out-of-scope request.",
        requiredBehaviors: ["Explain that the workflow does not apply."],
        forbiddenBehaviors: [],
      },
      route: { type: "create" },
      state: "needs_attention",
      lastErrorCode: "skill_evaluation_failed",
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
      evaluator: {
        async evaluate() {
          return await new Promise<never>(() => undefined);
        },
      },
      expertExists: async () => true,
      bindSkill: async () => undefined,
    });

    const results = await Promise.allSettled([
      service.retry({ id: candidate.id, expectedRevision: candidate.revision }),
      service.retry({ id: candidate.id, expectedRevision: candidate.revision }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: "skill_candidate_revision_conflict" }),
    });
  });
});
