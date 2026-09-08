import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SkillRevisionJob } from "@pragma/built-in-agents/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CapabilityStore } from "./capability-store.ts";
import { createSkillRevisionService } from "./skill-revision-service.ts";

const roots: string[] = [];
const capabilityId = "00000000-0000-4000-8000-000000000001";
const baseContentHash = "a".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Skill revision service", () => {
  it("publishes a passing Memory learning revision without an unreachable review step", async () => {
    const { service, updateGeneratedSkill } = createService();

    await service.submit(memoryRequest());
    await service.processPending();

    expect(updateGeneratedSkill).toHaveBeenCalledWith({
      id: capabilityId,
      package: expect.objectContaining({ description: "Updated workflow." }),
    });
    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({ state: "completed", revision: 6 }),
    ]);
  });

  it("resumes a passing Memory revision that stopped after evaluation", async () => {
    const { service, statePath, updateGeneratedSkill } = createService();
    const timestamp = "2026-09-08T00:00:00.000Z";
    const job: SkillRevisionJob = {
      schemaVersion: "pragma.skill-revision-job/v1",
      id: randomUUID(),
      revision: 3,
      request: memoryRequest(),
      state: "pending_review",
      changeSet: changeSet(),
      evaluation: passingEvaluation(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const jobsPath = join(statePath, "jobs");
    await mkdir(jobsPath, { recursive: true });
    await writeFile(join(jobsPath, `${job.id}.json`), JSON.stringify(job));

    await service.processPending();

    expect(updateGeneratedSkill).toHaveBeenCalledOnce();
    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({ id: job.id, state: "completed", revision: 5 }),
    ]);
  });

  it("records completion without publishing twice after a post-commit crash", async () => {
    const { service, statePath, updateGeneratedSkill } = createService({ alreadyApplied: true });
    const timestamp = "2026-09-08T00:00:00.000Z";
    const job: SkillRevisionJob = {
      schemaVersion: "pragma.skill-revision-job/v1",
      id: randomUUID(),
      revision: 5,
      request: memoryRequest(),
      state: "applying",
      changeSet: changeSet(),
      evaluation: passingEvaluation(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const jobsPath = join(statePath, "jobs");
    await mkdir(jobsPath, { recursive: true });
    await writeFile(join(jobsPath, `${job.id}.json`), JSON.stringify(job));

    await service.processPending();

    expect(updateGeneratedSkill).not.toHaveBeenCalled();
    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({ id: job.id, state: "completed", revision: 6 }),
    ]);
  });
});

function createService(options: { readonly alreadyApplied?: boolean } = {}) {
  const statePath = join(tmpdir(), `pragma-skill-revisions-${randomUUID()}`);
  roots.push(statePath);
  const updateGeneratedSkill = vi.fn(async () => undefined);
  const capabilities = {
    async get(_id: string, requestedRevision?: number) {
      const applied = options.alreadyApplied === true && requestedRevision === undefined;
      return {
        manifest: { latestRevision: applied ? 2 : 1 },
        definition: {
          kind: "skill",
          name: "safe-workflow",
          description: applied ? "Updated workflow." : "Safe workflow.",
          contentHash: applied ? "d".repeat(64) : baseContentHash,
        },
      };
    },
    async listSkillFiles() {
      return [{ path: "SKILL.md" }];
    },
    async getSkillFile(input: { readonly revision: number }) {
      return {
        content:
          input.revision === 2
            ? "---\nname: safe-workflow\ndescription: Updated workflow.\n---\n\nFollow the improved workflow."
            : "---\nname: safe-workflow\ndescription: Safe workflow.\n---\n\nFollow the workflow.",
      };
    },
    updateGeneratedSkill,
  } as unknown as CapabilityStore;
  return {
    statePath,
    updateGeneratedSkill,
    service: createSkillRevisionService({
      statePath,
      capabilities,
      generator: {
        async generate() {
          return changeSet();
        },
      },
      evaluator: {
        async evaluate() {
          return passingEvaluation();
        },
      },
    }),
  };
}

function memoryRequest() {
  return {
    schemaVersion: "pragma.skill-revision-request/v1" as const,
    capabilityId,
    source: "memory-learning" as const,
    sourceDigest: "b".repeat(64),
    sourceRefs: [1, 2, 3].map((revision) => ({
      kind: "episodic" as const,
      id: `episode-${revision}`,
      revision,
    })),
    replayCases: [1, 2, 3].map((index) => ({
      objective: `Replay ${index}`,
      requiredBehaviors: ["Complete the workflow."],
      forbiddenBehaviors: [],
    })),
    boundaryCase: {
      objective: "Reject an unrelated request.",
      requiredBehaviors: ["Explain that the workflow does not apply."],
      forbiddenBehaviors: [],
    },
    prompt: "Improve the workflow from validated Memory evidence.",
  };
}

function changeSet() {
  return {
    schemaVersion: "pragma.skill-revision-change-set/v1" as const,
    capabilityId,
    baseRevision: 1,
    baseContentHash,
    name: "safe-workflow",
    description: "Updated workflow.",
    summary: "Improve the instructions.",
    operations: [
      {
        operation: "upsert" as const,
        path: "SKILL.md",
        content:
          "---\nname: safe-workflow\ndescription: Updated workflow.\n---\n\nFollow the improved workflow.",
      },
    ],
  };
}

function passingEvaluation() {
  return {
    schemaVersion: "pragma.skill-evaluation-snapshot/v1" as const,
    subjectHash: "c".repeat(64),
    passed: true,
    staticChecksPassed: true,
    scriptTestsPassed: true,
    profileRevision: 1,
    runtimeId: "test-runtime",
    providerId: "test-provider",
    modelId: "test-model",
    cases: [1, 2, 3, 4].map((index) => ({
      id: `case-${index}`,
      kind: index === 4 ? ("boundary" as const) : ("source-replay" as const),
      passed: true,
      assertions: [{ dimension: "correctness" as const, passed: true, message: "Passed." }],
    })),
    evaluatedAt: "2026-09-08T00:00:00.000Z",
  };
}
