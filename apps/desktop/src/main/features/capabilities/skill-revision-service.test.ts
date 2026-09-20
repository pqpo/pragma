import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CapabilityStore } from "./capability-store.ts";
import {
  createSkillRevisionService,
  SkillRevisionValidationError,
} from "./skill-revision-service.ts";

const roots: string[] = [];
const capabilityId = "00000000-0000-4000-8000-000000000001";
const baseContentHash = "a".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Skill revision service", () => {
  it("publishes an approved empty-baseline Skill as revision 1", async () => {
    const fixture = await createService();
    const missionId = randomUUID();
    const reservedId = "90000000-0000-4000-8000-000000000003";
    const job = await fixture.service.start(
      {
        schemaVersion: "pragma.skill-revision-request/v4",
        operation: "create",
        capabilityId: reservedId,
        resourceName: "created-skill",
        resourceDescription: "Created skill.",
        source: "expert-reflection",
        sourceDigest: "e".repeat(64),
        sourceRefs: [],
        prompt: "Create the Skill.",
      },
      { missionId },
    );
    const draft = await fixture.service.inspectDraft(job.draftId, missionId);
    expect(draft).toMatchObject({ currentRevision: 0, stale: false, changes: [] });
    await writeFile(
      join(draft.draftPath!, "SKILL.md"),
      "---\nname: created-skill\ndescription: Created skill.\n---\n\nFollow the workflow.\n",
    );
    const ready = await fixture.service.inspectDraft(job.draftId, missionId);
    await fixture.service.submitDraft({
      draftId: job.draftId,
      expectedRevision: ready.draft.revision,
      expectedWorkingTreeHash: ready.workingTree.hash,
      summary: "Create the Skill.",
      missionId,
    });
    await fixture.service.processPending();
    expect(fixture.publishNew).not.toHaveBeenCalled();
    const pending = await fixture.service.get(job.id);
    expect(pending.state).toBe("pending_review");
    const completed = await fixture.service.approve(pending.id, pending.revision);
    expect(completed).toMatchObject({ state: "completed", publishedRevision: 1 });
    expect(fixture.publishNew).toHaveBeenCalledWith(
      expect.objectContaining({
        id: reservedId,
        name: "created-skill",
        description: "Created skill.",
      }),
    );

    const completedDraft = await fixture.service.getDraft(job.draftId);
    await writeFile(
      join(fixture.statePath, "jobs", `${job.id}.json`),
      `${JSON.stringify({ ...completed, state: "publishing" })}\n`,
    );
    await writeFile(
      join(fixture.draftsPath, job.draftId, "draft.json"),
      `${JSON.stringify({ ...completedDraft, state: "publishing" })}\n`,
    );
    await fixture.service.processPending();

    await expect(fixture.service.get(job.id)).resolves.toMatchObject({ state: "completed" });
    expect(fixture.publishNew).toHaveBeenCalledTimes(2);
  });

  it("recovers a publication interrupted after persisting the approval intent", async () => {
    const fixture = await createService();
    const job = await fixture.service.start(request("expert-reflection"));
    const editing = await fixture.service.inspectDraft(job.draftId);
    await fixture.service.submitDraft({
      draftId: job.draftId,
      expectedRevision: editing.draft.revision,
      expectedWorkingTreeHash: editing.workingTree.hash,
      summary: "Approve this revision.",
    });
    const pending = await fixture.service.get(job.id);
    const pendingDraft = await fixture.service.getDraft(job.draftId);
    await writeFile(
      join(fixture.draftsPath, job.draftId, "draft.json"),
      `${JSON.stringify({
        ...pendingDraft,
        revision: pendingDraft.revision + 1,
        state: "publishing",
      })}\n`,
    );

    const recovered = createSkillRevisionService({
      statePath: fixture.statePath,
      draftsPath: fixture.draftsPath,
      draftsTrashPath: fixture.draftsTrashPath,
      capabilities: fixture.capabilities,
    });
    await recovered.processPending();

    await expect(recovered.get(pending.id)).resolves.toMatchObject({
      state: "completed",
      publishedRevision: 2,
    });
    expect(fixture.publish).toHaveBeenCalledTimes(1);

    const unapproved = await recovered.start(request("expert-reflection"));
    const unapprovedDraft = await recovered.inspectDraft(unapproved.draftId);
    await recovered.submitDraft({
      draftId: unapproved.draftId,
      expectedRevision: unapprovedDraft.draft.revision,
      expectedWorkingTreeHash: unapprovedDraft.workingTree.hash,
      summary: "Do not publish without approval intent.",
    });
    await recovered.processPending();
    await expect(recovered.get(unapproved.id)).resolves.toMatchObject({ state: "pending_review" });
    expect(fixture.publish).toHaveBeenCalledTimes(1);
  });

  it("isolates a failed interrupted publication from later generated revisions", async () => {
    const fixture = await createService({
      async publish() {
        throw Object.assign(new Error("Publication backend unavailable."), {
          code: "publication_unavailable",
        });
      },
      generator: {
        async generate() {
          return {
            schemaVersion: "pragma.skill-revision-change-set/v2" as const,
            operation: "revise" as const,
            capabilityId,
            baseRevision: 1,
            baseContentHash,
            name: "safe-workflow",
            description: "Safe workflow.",
            summary: "Process the independent queued revision.",
            operations: [
              {
                operation: "upsert" as const,
                path: "references/queued.md",
                content: "Independent queued revision.\n",
              },
            ],
          };
        },
      },
    });
    const interrupted = await fixture.service.start(request("expert-reflection"));
    const editing = await fixture.service.inspectDraft(interrupted.draftId);
    await fixture.service.submitDraft({
      draftId: interrupted.draftId,
      expectedRevision: editing.draft.revision,
      expectedWorkingTreeHash: editing.workingTree.hash,
      summary: "Publish this revision.",
    });
    const interruptedDraft = await fixture.service.getDraft(interrupted.draftId);
    await writeFile(
      join(fixture.draftsPath, interrupted.draftId, "draft.json"),
      `${JSON.stringify({
        ...interruptedDraft,
        revision: interruptedDraft.revision + 1,
        state: "publishing",
      })}\n`,
    );
    const independent = await fixture.service.submit(legacyRequest());

    await fixture.service.processPending();

    await expect(fixture.service.get(interrupted.id)).resolves.toMatchObject({
      state: "needs_attention",
      error: { code: "publication_unavailable" },
    });
    await expect(fixture.service.get(independent.id)).resolves.toMatchObject({
      state: "pending_review",
    });
  });

  it("returns actionable validation diagnostics without changing the editable draft", async () => {
    const fixture = await createService();
    const job = await fixture.service.start(request("expert-reflection"));
    const inspected = await fixture.service.inspectDraft(job.draftId);
    await writeFile(
      join(inspected.draftPath!, "SKILL.md"),
      "---\nname: safe-workflow\ndescription: Safe workflow.\n---\n",
    );
    await mkdir(join(inspected.draftPath!, "scripts"));
    await mkdir(join(inspected.draftPath!, "tests"));
    await writeFile(
      join(inspected.draftPath!, "scripts", "unsafe.mjs"),
      "export const run = () => fetch('https://example.test');\n",
    );
    await writeFile(
      join(inspected.draftPath!, "tests", "unsafe.test.mjs"),
      "import '../scripts/unsafe.mjs';\n",
    );
    const invalid = await fixture.service.inspectDraft(job.draftId);
    await expect(
      fixture.service.submitDraft({
        draftId: job.draftId,
        expectedRevision: invalid.draft.revision,
        expectedWorkingTreeHash: invalid.workingTree.hash,
        summary: "Validate this candidate.",
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      retryable: true,
      validation: {
        passed: false,
        diagnostics: [
          expect.objectContaining({
            path: "scripts/unsafe.mjs",
            code: "skill_network_access_forbidden",
          }),
        ],
      },
    } satisfies Partial<SkillRevisionValidationError>);
    await expect(fixture.service.get(job.id)).resolves.toMatchObject({ state: "editing" });
    await expect(fixture.service.getDraft(job.draftId)).resolves.toMatchObject({
      state: "editing",
    });
  });

  it("recovers a creation candidate under a new id after the reserved id is occupied", async () => {
    let occupied = true;
    const fixture = await createService({
      async publishNew(input) {
        if (occupied) {
          throw Object.assign(
            new Error("The reserved Skill id is already occupied by different content."),
            { code: "revision_conflict" },
          );
        }
        void input;
        return { manifest: { latestRevision: 1 } };
      },
    });
    const reservedId = "90000000-0000-4000-8000-000000000013";
    const job = await fixture.service.start({
      schemaVersion: "pragma.skill-revision-request/v4",
      operation: "create",
      capabilityId: reservedId,
      resourceName: "recovered-skill",
      resourceDescription: "Recovered Skill.",
      source: "expert-reflection",
      sourceDigest: "f".repeat(64),
      sourceRefs: [],
      prompt: "Create the recovered Skill.",
    });
    const editing = await fixture.service.inspectDraft(job.draftId);
    await writeFile(
      join(editing.draftPath!, "SKILL.md"),
      "---\nname: recovered-skill\ndescription: Recovered Skill.\n---\n\nKeep this candidate.\n",
    );
    await mkdir(join(editing.draftPath!, "scripts"));
    await writeFile(join(editing.draftPath!, "scripts", "verify.mjs"), "process.exit(0);\n");
    await mkdir(join(editing.draftPath!, "tests"));
    await writeFile(
      join(editing.draftPath!, "tests", "verify.test.mjs"),
      "import '../scripts/verify.mjs';\n",
    );
    await chmod(join(editing.draftPath!, "scripts", "verify.mjs"), 0o755);
    const ready = await fixture.service.inspectDraft(job.draftId);
    await fixture.service.submitDraft({
      draftId: job.draftId,
      expectedRevision: ready.draft.revision,
      expectedWorkingTreeHash: ready.workingTree.hash,
      summary: "Preserve and recover this candidate.",
    });
    await fixture.service.processPending();
    const pending = await fixture.service.get(job.id);
    await expect(fixture.service.approve(pending.id, pending.revision)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    const conflicted = await fixture.service.get(job.id);
    expect(conflicted).toMatchObject({
      state: "needs_attention",
      error: { code: "skill_creation_id_conflict" },
    });

    const replacement = await fixture.service.retry(conflicted.id, conflicted.revision);
    expect(replacement.id).not.toBe(job.id);
    expect(replacement.draftId).not.toBe(job.draftId);
    expect(replacement.request.capabilityId).not.toBe(reservedId);
    await expect(fixture.service.get(job.id)).resolves.toMatchObject({
      state: "superseded",
      supersededBy: replacement.id,
    });
    await expect(fixture.service.retry(conflicted.id, conflicted.revision)).rejects.toMatchObject({
      code: "skill_revision_conflict",
    });
    await fixture.service.processPending();
    const recoveredDraft = await fixture.service.getDraft(replacement.draftId);
    const recoveredCandidatePath = join(
      fixture.draftsPath,
      replacement.draftId,
      "submissions",
      recoveredDraft.submissionHash!,
    );
    await expect(readFile(join(recoveredCandidatePath, "SKILL.md"), "utf8")).resolves.toContain(
      "Keep this candidate.",
    );
    expect((await stat(join(recoveredCandidatePath, "scripts", "verify.mjs"))).mode & 0o111).toBe(
      0o111,
    );

    occupied = false;
    const recoveredPending = await fixture.service.get(replacement.id);
    expect(recoveredPending.state).toBe("pending_review");
    const completed = await fixture.service.approve(recoveredPending.id, recoveredPending.revision);
    expect(completed).toMatchObject({ state: "completed", publishedRevision: 1 });
    expect(fixture.publishNew.mock.calls.at(-1)?.[0]).toMatchObject({
      id: replacement.request.capabilityId,
      candidateContentHash: recoveredDraft.submissionHash,
    });
  });

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
    await mkdir(join(draft.draftPath!, "tests"));
    await writeFile(
      join(draft.draftPath!, "tests", "verify.test.mjs"),
      "import '../scripts/verify.mjs';\n",
    );

    const inspected = await fixture.service.inspectDraft(job.draftId, job.missionId);
    await fixture.service.submitDraft({
      draftId: job.draftId,
      expectedRevision: inspected.draft.revision,
      expectedWorkingTreeHash: inspected.workingTree.hash,
      summary: "Add a binary fixture and executable verifier.",
      missionId,
    });
    await fixture.service.processPending();

    const pending = await fixture.service.get(job.id);
    expect(pending.error).toBeUndefined();
    expect(pending).toMatchObject({ state: "pending_review" });
    const completed = await fixture.service.approve(pending.id, pending.revision);
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
            schemaVersion: "pragma.skill-revision-change-set/v2" as const,
            operation: "revise" as const,
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
    await fixture.service.processPending();
    const draft = await fixture.service.inspectDraft(job.draftId);

    await expect(
      readFile(join(draft.referencePath!, "references", "obsolete.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restarts a Memory revision Agent after synchronous validation fails", async () => {
    let attempt = 0;
    const fixture = await createService({
      generator: {
        async generate() {
          attempt += 1;
          return {
            schemaVersion: "pragma.skill-revision-change-set/v2" as const,
            operation: "revise" as const,
            capabilityId,
            baseRevision: 1,
            baseContentHash,
            name: "safe-workflow",
            description: "Safe workflow.",
            summary: "Add a checked helper.",
            operations:
              attempt === 1
                ? [
                    {
                      operation: "upsert" as const,
                      path: "scripts/run.mjs",
                      content: "export const run = () => fetch('https://example.test');\n",
                    },
                    {
                      operation: "upsert" as const,
                      path: "tests/run.test.mjs",
                      content: "import '../scripts/run.mjs';\n",
                    },
                  ]
                : [
                    {
                      operation: "upsert" as const,
                      path: "scripts/run.mjs",
                      content: "export const run = () => 'safe';\n",
                    },
                  ],
          };
        },
      },
    });

    const started = await fixture.service.submit(legacyRequest());
    await fixture.service.processPending();
    const failed = await fixture.service.get(started.id);
    expect(failed).toMatchObject({ state: "needs_attention", error: { code: "invalid_input" } });

    await fixture.service.retry(failed.id, failed.revision);
    await fixture.service.processPending();

    await expect(fixture.service.get(started.id)).resolves.toMatchObject({
      state: "pending_review",
    });
    expect(attempt).toBe(2);
  });

  it("accepts a managed Skill Revision Mission that submits its mounted draft", async () => {
    const serviceRef: { current?: ReturnType<typeof createSkillRevisionService> } = {};
    const missionId = randomUUID();
    const fixture = await createService({
      generator: {
        async generate(input) {
          if (serviceRef.current === undefined) throw new Error("service unavailable");
          await serviceRef.current.attachMission(input.jobId, missionId);
          const inspection = await serviceRef.current.inspectDraft(input.draftId, missionId);
          await serviceRef.current.submitDraft({
            draftId: input.draftId,
            expectedRevision: inspection.draft.revision,
            expectedWorkingTreeHash: inspection.workingTree.hash,
            summary: "Submit the mounted Memory revision.",
            missionId,
          });
          return undefined;
        },
      },
    });
    serviceRef.current = fixture.service;

    const started = await fixture.service.submit(legacyRequest());
    await fixture.service.processPending();

    await expect(fixture.service.get(started.id)).resolves.toMatchObject({
      state: "pending_review",
      missionId,
    });
  });

  it("migrates frozen historical job and draft fixtures to creation-aware schemas", async () => {
    const fixture = await createService();
    const historicalJob = await historicalFixture("skill-revision-job-v2.json");
    const historicalDraft = await historicalFixture("skill-revision-draft-v1.json");
    const jobId = String(historicalJob["id"]);
    const draftId = String(historicalDraft["id"]);
    await mkdir(join(fixture.statePath, "jobs"), { recursive: true });
    await mkdir(join(fixture.draftsPath, draftId), { recursive: true });
    await writeFile(
      join(fixture.statePath, "jobs", `${jobId}.json`),
      `${JSON.stringify(historicalJob)}\n`,
    );
    await writeFile(
      join(fixture.draftsPath, draftId, "draft.json"),
      `${JSON.stringify(historicalDraft)}\n`,
    );

    await expect(fixture.service.get(jobId)).resolves.toMatchObject({
      schemaVersion: "pragma.skill-revision-job/v4",
      revision: 5,
      request: { schemaVersion: "pragma.skill-revision-request/v4", operation: "revise" },
    });
    await expect(fixture.service.getDraft(draftId)).resolves.toMatchObject({
      schemaVersion: "pragma.skill-revision-draft/v3",
      operation: "revise",
    });
    await expect(
      readFile(join(fixture.statePath, "migration-backups", `${jobId}.v2.json`), "utf8"),
    ).resolves.toContain("pragma.skill-revision-job/v2");
    await expect(
      readFile(join(fixture.statePath, "migration-backups", `draft-${draftId}.v1.json`), "utf8"),
    ).resolves.toContain("pragma.skill-revision-draft/v1");
  });

  it("reads current revision records without running a migration", async () => {
    const fixture = await createService();
    const job = await fixture.service.start(request("expert-reflection"));
    const jobPath = join(fixture.statePath, "jobs", `${job.id}.json`);
    const draftPath = join(fixture.draftsPath, job.draftId, "draft.json");
    const beforeJob = await readFile(jobPath, "utf8");
    const beforeDraft = await readFile(draftPath, "utf8");

    await fixture.service.get(job.id);
    await fixture.service.getDraft(job.draftId);

    await expect(readFile(jobPath, "utf8")).resolves.toBe(beforeJob);
    await expect(readFile(draftPath, "utf8")).resolves.toBe(beforeDraft);
    await expect(
      readFile(join(fixture.statePath, "migration-backups", `${job.id}.v2.json`), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replays completed adjacent-migration journals after atomic replacement", async () => {
    const fixture = await createService();
    const historicalJob = await historicalFixture("skill-revision-job-v2.json");
    const historicalDraft = await historicalFixture("skill-revision-draft-v1.json");
    const jobId = String(historicalJob["id"]);
    const draftId = String(historicalDraft["id"]);
    const jobPath = join(fixture.statePath, "jobs", `${jobId}.json`);
    const draftPath = join(fixture.draftsPath, draftId, "draft.json");
    await mkdir(join(fixture.statePath, "jobs"), { recursive: true });
    await mkdir(join(fixture.draftsPath, draftId), { recursive: true });
    await writeFile(jobPath, `${JSON.stringify(historicalJob)}\n`);
    await writeFile(draftPath, `${JSON.stringify(historicalDraft)}\n`);
    await fixture.service.get(jobId);
    await fixture.service.getDraft(draftId);

    const jobBackupPath = join(fixture.statePath, "migration-backups", `${jobId}.v2.json`);
    const draftBackupPath = join(
      fixture.statePath,
      "migration-backups",
      `draft-${draftId}.v1.json`,
    );
    const jobJournalPath = join(
      fixture.statePath,
      "migration-journals",
      `job-${jobId}.v2-to-v3.json`,
    );
    const draftJournalPath = join(
      fixture.statePath,
      "migration-journals",
      `draft-${draftId}.v1-to-v2.json`,
    );
    await mkdir(join(fixture.statePath, "migration-journals"), { recursive: true });
    await writeFile(
      jobJournalPath,
      `${JSON.stringify({
        schemaVersion: "pragma.skill-revision-migration/v1",
        kind: "job",
        recordId: jobId,
        recordPath: jobPath,
        backupPath: jobBackupPath,
        sourceHash: jsonHash(JSON.parse(await readFile(jobBackupPath, "utf8"))),
        sourceVersion: "pragma.skill-revision-job/v2",
        targetVersion: "pragma.skill-revision-job/v3",
      })}\n`,
    );
    await writeFile(
      draftJournalPath,
      `${JSON.stringify({
        schemaVersion: "pragma.skill-revision-migration/v1",
        kind: "draft",
        recordId: draftId,
        recordPath: draftPath,
        backupPath: draftBackupPath,
        sourceHash: jsonHash(JSON.parse(await readFile(draftBackupPath, "utf8"))),
        sourceVersion: "pragma.skill-revision-draft/v1",
        targetVersion: "pragma.skill-revision-draft/v2",
      })}\n`,
    );
    // Cover both crash points: the Job replacement has not happened yet, while the Draft
    // replacement completed before its journal could be removed.
    await writeFile(jobPath, `${JSON.stringify(historicalJob)}\n`);

    await expect(fixture.service.get(jobId)).resolves.toMatchObject({
      schemaVersion: "pragma.skill-revision-job/v4",
    });
    await fixture.service.getDraft(draftId);

    await expect(readFile(jobJournalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(draftJournalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("chains a frozen v1 job through managed storage into v4", async () => {
    const fixture = await createService();
    const historicalJob = await historicalFixture("skill-revision-job-v1.json");
    const jobId = String(historicalJob["id"]);
    await mkdir(join(fixture.statePath, "jobs"), { recursive: true });
    await writeFile(
      join(fixture.statePath, "jobs", `${jobId}.json`),
      `${JSON.stringify(historicalJob)}\n`,
    );

    const migrated = await fixture.service.get(jobId);

    expect(migrated).toMatchObject({
      schemaVersion: "pragma.skill-revision-job/v4",
      revision: 4,
      request: { schemaVersion: "pragma.skill-revision-request/v4", operation: "revise" },
    });
    await expect(fixture.service.getDraft(migrated.draftId)).resolves.toMatchObject({
      schemaVersion: "pragma.skill-revision-draft/v3",
      operation: "revise",
    });
    await expect(
      readFile(join(fixture.statePath, "migration-backups", `${jobId}.v1.json`), "utf8"),
    ).resolves.toContain("pragma.skill-revision-job/v1");
    await expect(
      readFile(join(fixture.statePath, "migration-backups", `${jobId}.v2.json`), "utf8"),
    ).resolves.toContain("pragma.skill-revision-job/v2");
  });

  it("rejects future job and draft versions without replacing them", async () => {
    const fixture = await createService();
    const job = await fixture.service.start(request("expert-reflection"));
    const draft = await fixture.service.getDraft(job.draftId);
    const jobPath = join(fixture.statePath, "jobs", `${job.id}.json`);
    const draftPath = join(fixture.draftsPath, draft.id, "draft.json");
    const futureJob = { ...job, schemaVersion: "pragma.skill-revision-job/v5" };
    const futureDraft = { ...draft, schemaVersion: "pragma.skill-revision-draft/v4" };
    await writeFile(jobPath, `${JSON.stringify(futureJob)}\n`);
    await writeFile(draftPath, `${JSON.stringify(futureDraft)}\n`);

    await expect(fixture.service.get(job.id)).rejects.toThrow();
    await expect(fixture.service.getDraft(draft.id)).rejects.toThrow();
    await expect(readFile(jobPath, "utf8")).resolves.toContain("pragma.skill-revision-job/v5");
    await expect(readFile(draftPath, "utf8")).resolves.toContain("pragma.skill-revision-draft/v4");
  });

  it("deletes only terminal or actionable Skill revision tasks", async () => {
    const fixture = await createService();
    const job = await fixture.service.start(request("expert-reflection"));
    const editing = await fixture.service.inspectDraft(job.draftId);
    const pending = await fixture.service.submitDraft({
      draftId: job.draftId,
      expectedRevision: editing.draft.revision,
      expectedWorkingTreeHash: editing.workingTree.hash,
      summary: "Review this revision.",
    });

    await expect(fixture.service.delete(pending.id, pending.revision)).rejects.toMatchObject({
      code: "skill_revision_state_invalid",
    });

    const rejected = await fixture.service.reject(pending.id, pending.revision);
    const reopened = await fixture.service.retry(rejected.id, rejected.revision);
    expect(reopened.state).toBe("pending_review");
    const rejectedAgain = await fixture.service.reject(reopened.id, reopened.revision);
    await fixture.service.delete(rejectedAgain.id, rejectedAgain.revision);

    await expect(fixture.service.get(rejectedAgain.id)).rejects.toMatchObject({
      code: "skill_revision_job_not_found",
    });
    await expect(fixture.service.list()).resolves.toEqual([]);
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
    readonly publish?: (input: {
      readonly sourcePath: string;
    }) => Promise<{ readonly manifest: { readonly latestRevision: number } }>;
    readonly publishNew?: (input: {
      readonly id: string;
      readonly sourcePath: string;
    }) => Promise<{ readonly manifest: { readonly latestRevision: number } }>;
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
  const publish = vi.fn(async (input: { readonly sourcePath: string }) =>
    options.publish === undefined
      ? { manifest: { latestRevision: 2 } }
      : await options.publish(input),
  );
  const publishNew = vi.fn(async (input: { readonly id: string; readonly sourcePath: string }) =>
    options.publishNew === undefined
      ? { manifest: { latestRevision: 1 } }
      : await options.publishNew(input),
  );
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
    publishNewSkillRevisionCandidate: publishNew,
  } as unknown as CapabilityStore;
  return {
    publish,
    publishNew,
    setCurrentRevision(revision: number) {
      currentRevision = revision;
    },
    sourcePath,
    statePath: join(root, "state"),
    draftsPath: join(root, "data", "skill-revision-drafts"),
    draftsTrashPath: join(root, "trash", "skill-revision-drafts"),
    capabilities,
    service: createSkillRevisionService({
      statePath: join(root, "state"),
      draftsPath: join(root, "data", "skill-revision-drafts"),
      draftsTrashPath: join(root, "trash", "skill-revision-drafts"),
      capabilities,
      ...(options.generator === undefined ? {} : { generator: options.generator }),
    }),
  };
}

function legacyRequest() {
  return {
    schemaVersion: "pragma.skill-revision-submission/v1" as const,
    capabilityId,
    source: "memory-learning" as const,
    sourceDigest: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    sourceRefs: [],
    prompt: "Remove obsolete guidance.",
  };
}

function request(source: "memory-learning" | "expert-reflection") {
  return {
    schemaVersion: "pragma.skill-revision-request/v4" as const,
    operation: "revise" as const,
    capabilityId,
    source,
    sourceDigest: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    sourceRefs: [],
    prompt: "Improve the workflow.",
  };
}

async function historicalFixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(import.meta.dirname, "fixtures", name), "utf8")) as Record<
    string,
    unknown
  >;
}

function jsonHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
