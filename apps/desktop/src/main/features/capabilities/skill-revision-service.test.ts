import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  it("publishes a raw package including binary files and executable scripts", async () => {
    const fixture = await createService();
    const missionId = randomUUID();
    const job = await fixture.service.start(request("memory-learning"), {
      missionId,
    });
    const draft = await fixture.service.inspectDraft(job.draftId, job.missionId);
    await writeFile(join(draft.draftPath!, "asset.bin"), Uint8Array.from([0, 255, 42]));
    await mkdir(join(draft.draftPath!, "scripts"));
    await writeFile(join(draft.draftPath!, "scripts", "verify.mjs"), "process.exit(0);\n");
    await chmod(join(draft.draftPath!, "scripts", "verify.mjs"), 0o755);

    const inspected = await fixture.service.inspectDraft(job.draftId, job.missionId);
    await fixture.service.submitDraft({
      draftId: job.draftId,
      expectedRevision: inspected.draft.revision,
      expectedWorkingTreeHash: inspected.workingTree.hash,
      summary: "Add a binary fixture and executable verifier.",
      missionId,
    });
    await fixture.service.processPending();

    const completed = await fixture.service.get(job.id);
    expect(completed.error).toBeUndefined();
    expect(completed).toMatchObject({ state: "completed" });
    expect(fixture.publish).toHaveBeenCalledOnce();
    const published = fixture.publish.mock.calls[0]![0];
    await expect(readFile(join(published.sourcePath, "asset.bin"))).resolves.toEqual(
      Buffer.from([0, 255, 42]),
    );
  });

  it("rejects a stale base and preserves a read-only reference", async () => {
    const fixture = await createService();
    const missionId = randomUUID();
    const job = await fixture.service.start(request("expert-reflection"), {
      missionId,
    });
    const inspected = await fixture.service.inspectDraft(job.draftId, job.missionId);
    fixture.setCurrentRevision(2);
    const rejected = await fixture.service.submitDraft({
      draftId: job.draftId,
      expectedRevision: inspected.draft.revision,
      expectedWorkingTreeHash: inspected.workingTree.hash,
      summary: "No longer current.",
      missionId,
    });

    expect(rejected).toMatchObject({
      state: "rejected",
      error: { code: "skill_revision_base_changed" },
    });
    const reference = await fixture.service.inspectDraft(job.draftId, job.missionId);
    expect(reference).toMatchObject({ stale: true, referencePath: expect.any(String) });
    expect(reference.draftPath).toBeUndefined();
  });

  it("resumes the existing Job instead of creating a duplicate", async () => {
    const fixture = await createService();
    const missionId = randomUUID();
    const initial = await fixture.service.start(request("expert-reflection"), { missionId });
    await fixture.service.detachMission(initial.id, missionId);
    const resumed = await fixture.service.start(request("expert-reflection"), {
      draftId: initial.draftId,
      missionId,
    });
    expect(resumed.id).toBe(initial.id);
    await expect(fixture.service.list()).resolves.toHaveLength(1);
  });

  it("does not allow a missing or different Mission identity to take over a draft", async () => {
    const fixture = await createService();
    const ownerMissionId = randomUUID();
    const job = await fixture.service.start(request("expert-reflection"), {
      missionId: ownerMissionId,
    });
    const inspected = await fixture.service.inspectDraft(job.draftId, ownerMissionId);

    await expect(
      fixture.service.submitDraft({
        draftId: job.draftId,
        expectedRevision: inspected.draft.revision,
        expectedWorkingTreeHash: inspected.workingTree.hash,
        summary: "Attempt an ownerless submission.",
      }),
    ).rejects.toMatchObject({ code: "skill_revision_owned_by_another_context" });
    await expect(
      fixture.service.start(request("expert-reflection"), {
        draftId: job.draftId,
        missionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "skill_revision_owned_by_another_context" });
  });

  it("omits discarded drafts from live Job listings", async () => {
    const fixture = await createService();
    const missionId = randomUUID();
    const job = await fixture.service.start(request("expert-reflection"), { missionId });
    const inspected = await fixture.service.inspectDraft(job.draftId, missionId);

    await fixture.service.discardDraft({
      draftId: job.draftId,
      expectedRevision: inspected.draft.revision,
      expectedWorkingTreeHash: inspected.workingTree.hash,
      missionId,
    });

    await expect(fixture.service.list()).resolves.toEqual([]);
  });

  it("applies generated deletions to the managed worktree", async () => {
    const fixture = await createService({
      generator: {
        async generate() {
          return {
            schemaVersion: "pragma.skill-revision-change-set/v1" as const,
            capabilityId,
            baseRevision: 1,
            baseContentHash,
            name: "safe-workflow",
            description: "Safe workflow.",
            summary: "Remove obsolete guidance.",
            operations: [{ operation: "delete" as const, path: "references/obsolete.md" }],
          };
        },
      },
    });
    await mkdir(join(fixture.sourcePath, "references"));
    await writeFile(join(fixture.sourcePath, "references", "obsolete.md"), "Obsolete.\n");

    const job = await fixture.service.submit(legacyRequest());
    const draft = await fixture.service.inspectDraft(job.draftId);

    await expect(
      readFile(join(draft.referencePath!, "references", "obsolete.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await fixture.service.processPending();
  });

  it("recovers an interrupted publication during startup processing", async () => {
    const fixture = await createService();
    const missionId = randomUUID();
    const job = await fixture.service.start(request("expert-reflection"), { missionId });
    const inspected = await fixture.service.inspectDraft(job.draftId, missionId);
    await fixture.service.submitDraft({
      draftId: job.draftId,
      expectedRevision: inspected.draft.revision,
      expectedWorkingTreeHash: inspected.workingTree.hash,
      summary: "Ready to publish.",
      missionId,
    });
    await fixture.service.processPending();
    const pendingJob = await fixture.service.get(job.id);
    const pendingDraft = await fixture.service.getDraft(job.draftId);
    await writeFile(
      join(fixture.statePath, "jobs", `${job.id}.json`),
      `${JSON.stringify({ ...pendingJob, state: "publishing" })}\n`,
    );
    await writeFile(
      join(fixture.draftsPath, job.draftId, "draft.json"),
      `${JSON.stringify({ ...pendingDraft, state: "publishing" })}\n`,
    );

    await fixture.service.processPending();

    await expect(fixture.service.get(job.id)).resolves.toMatchObject({ state: "completed" });
    await expect(fixture.service.getDraft(job.draftId)).resolves.toMatchObject({
      state: "completed",
    });
  });
});

async function createService(
  options: {
    readonly generator?: Parameters<typeof createSkillRevisionService>[0]["generator"];
  } = {},
) {
  const root = join(tmpdir(), `pragma-skill-revisions-${randomUUID()}`);
  roots.push(root);
  const sourcePath = join(root, "formal", "1");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(
    join(sourcePath, "SKILL.md"),
    "---\nname: safe-workflow\ndescription: Safe workflow.\n---\n\nFollow the workflow.\n",
  );
  let currentRevision = 1;
  const publish = vi.fn(async (input: { readonly sourcePath: string }) => {
    void input;
    return { manifest: { latestRevision: 2 } };
  });
  const capabilities = {
    async get(_id: string, requestedRevision?: number) {
      const revision = requestedRevision ?? currentRevision;
      return {
        manifest: { latestRevision: revision },
        definition: {
          kind: "skill",
          name: "safe-workflow",
          description: "Safe workflow.",
          contentHash: revision === 1 ? baseContentHash : "d".repeat(64),
        },
      };
    },
    async skillFilesPath() {
      return sourcePath;
    },
    publishSkillRevisionCandidate: publish,
  } as unknown as CapabilityStore;
  return {
    publish,
    setCurrentRevision(revision: number) {
      currentRevision = revision;
    },
    sourcePath,
    statePath: join(root, "state"),
    draftsPath: join(root, "data", "skill-revision-drafts"),
    service: createSkillRevisionService({
      statePath: join(root, "state"),
      draftsPath: join(root, "data", "skill-revision-drafts"),
      draftsTrashPath: join(root, "trash", "skill-revision-drafts"),
      capabilities,
      ...(options.generator === undefined ? {} : { generator: options.generator }),
      evaluator: {
        async evaluate() {
          return passingEvaluation();
        },
      },
    }),
  };
}

function legacyRequest() {
  return {
    schemaVersion: "pragma.skill-revision-request/v1" as const,
    capabilityId,
    source: "memory-learning" as const,
    sourceDigest: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    sourceRefs: [],
    replayCases: [1, 2, 3].map((index) => ({
      objective: `Replay ${index}`,
      requiredBehaviors: ["Pass"],
      forbiddenBehaviors: [],
    })),
    boundaryCase: {
      objective: "Boundary",
      requiredBehaviors: ["Decline"],
      forbiddenBehaviors: [],
    },
    prompt: "Remove obsolete guidance.",
  };
}

function request(source: "memory-learning" | "expert-reflection") {
  return {
    schemaVersion: "pragma.skill-revision-request/v2" as const,
    capabilityId,
    source,
    sourceDigest: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    sourceRefs: [],
    ...(source === "memory-learning"
      ? {
          replayCases: [1, 2, 3].map((index) => ({
            objective: `Replay ${index}`,
            requiredBehaviors: ["Pass"],
            forbiddenBehaviors: [],
          })),
          boundaryCase: {
            objective: "Boundary",
            requiredBehaviors: ["Decline"],
            forbiddenBehaviors: [],
          },
        }
      : {}),
    prompt: "Improve the workflow.",
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
