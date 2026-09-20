import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CapabilityStore } from "./capability-store.ts";
import { copySkillTree } from "./skill-revision-draft-store.ts";
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
  it("stores the editable tree in the owning Workspace and removes it after submission", async () => {
    const fixture = await createService();
    const job = await fixture.service.start(request("expert-reflection"));
    const inspection = await fixture.service.inspectDraft(job.draftId);
    const expectedDraftPath = join(
      fixture.workspacePath,
      ".pragma",
      "skill-revision-drafts",
      job.draftId,
      "worktree",
    );
    expect(inspection.draftPath).toBe(expectedDraftPath);
    await expect(stat(join(expectedDraftPath, "SKILL.md"))).resolves.toBeDefined();

    const pending = await fixture.service.submitDraft({
      draftId: job.draftId,
      expectedRevision: inspection.draft.revision,
      expectedWorkingTreeHash: inspection.workingTree.hash,
      summary: "Move the draft into review.",
    });

    await expect(stat(dirname(expectedDraftPath))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fixture.service.getReview(pending.id)).resolves.toMatchObject({
      jobId: pending.id,
      draftId: job.draftId,
    });
  });

  it("discards a submitted draft from its immutable candidate snapshot", async () => {
    const fixture = await createService();
    const job = await fixture.service.start(request("expert-reflection"));
    const inspection = await fixture.service.inspectDraft(job.draftId);
    await fixture.service.submitDraft({
      draftId: job.draftId,
      expectedRevision: inspection.draft.revision,
      expectedWorkingTreeHash: inspection.workingTree.hash,
      summary: "Discard this submitted candidate.",
    });
    const submitted = await fixture.service.getDraft(job.draftId);

    await fixture.service.discardDraft({
      draftId: submitted.id,
      expectedRevision: submitted.revision,
      expectedWorkingTreeHash: submitted.submissionHash!,
    });

    await expect(fixture.service.list()).resolves.toEqual([]);
    await expect(fixture.service.listDrafts()).resolves.toEqual([]);
    await expect(stat(join(fixture.draftsPath, submitted.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("discards a rejected submitted draft from its immutable candidate snapshot", async () => {
    const fixture = await createService();
    const job = await fixture.service.start(request("expert-reflection"));
    const inspection = await fixture.service.inspectDraft(job.draftId);
    const pending = await fixture.service.submitDraft({
      draftId: job.draftId,
      expectedRevision: inspection.draft.revision,
      expectedWorkingTreeHash: inspection.workingTree.hash,
      summary: "Reject and discard this submitted candidate.",
    });
    await fixture.service.reject(pending.id, pending.revision);
    const rejected = await fixture.service.getDraft(job.draftId);

    await fixture.service.discardDraft({
      draftId: rejected.id,
      expectedRevision: rejected.revision,
      expectedWorkingTreeHash: rejected.submissionHash!,
    });

    await expect(fixture.service.list()).resolves.toEqual([]);
    await expect(fixture.service.listDrafts()).resolves.toEqual([]);
  });

  it("replays a committed submission cleanup journal after restart", async () => {
    const fixture = await createService();
    const job = await fixture.service.start(request("expert-reflection"));
    const inspection = await fixture.service.inspectDraft(job.draftId);
    const pending = await fixture.service.submitDraft({
      draftId: job.draftId,
      expectedRevision: inspection.draft.revision,
      expectedWorkingTreeHash: inspection.workingTree.hash,
      summary: "Persist the submitted snapshot.",
    });
    const draft = await fixture.service.getDraft(job.draftId);
    const workspaceDraftPath = join(
      fixture.workspacePath,
      ".pragma",
      "skill-revision-drafts",
      draft.id,
    );
    await mkdir(join(workspaceDraftPath, "worktree"), { recursive: true });
    const journalPath = join(fixture.statePath, "submission-cleanup-journals", `${draft.id}.json`);
    await writeFile(
      journalPath,
      `${JSON.stringify({
        schemaVersion: "pragma.skill-revision-submission-cleanup/v1",
        draftId: draft.id,
        jobId: pending.id,
        workspacePath: draft.workspacePath,
        submissionHash: draft.submissionHash,
        draftRevision: draft.revision,
        jobRevision: pending.revision,
        state: "committed",
      })}\n`,
    );
    const recovered = createSkillRevisionService({
      statePath: fixture.statePath,
      draftsPath: fixture.draftsPath,
      draftsTrashPath: fixture.draftsTrashPath,
      capabilities: fixture.capabilities,
      resolveWorkspacePath: async () => fixture.workspacePath,
    });

    await recovered.getDraft(draft.id);

    await expect(stat(workspaceDraftPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("repairs the Job when submission crashes after committing the Draft", async () => {
    const fixture = await createService();
    const originalJob = await fixture.service.start(request("expert-reflection"));
    const inspection = await fixture.service.inspectDraft(originalJob.draftId);
    const pending = await fixture.service.submitDraft({
      draftId: originalJob.draftId,
      expectedRevision: inspection.draft.revision,
      expectedWorkingTreeHash: inspection.workingTree.hash,
      summary: "Recover both submitted records.",
    });
    const draft = await fixture.service.getDraft(originalJob.draftId);
    const workspaceDraftPath = join(
      fixture.workspacePath,
      ".pragma",
      "skill-revision-drafts",
      draft.id,
    );
    await mkdir(join(workspaceDraftPath, "worktree"), { recursive: true });
    await writeFile(
      join(fixture.statePath, "jobs", `${originalJob.id}.json`),
      `${JSON.stringify(originalJob)}\n`,
    );
    await writeFile(
      join(fixture.statePath, "submission-cleanup-journals", `${draft.id}.json`),
      `${JSON.stringify({
        schemaVersion: "pragma.skill-revision-submission-cleanup/v1",
        draftId: draft.id,
        jobId: originalJob.id,
        workspacePath: draft.workspacePath,
        submissionHash: draft.submissionHash,
        draftRevision: draft.revision,
        jobRevision: pending.revision,
        state: "prepared",
      })}\n`,
    );
    await expect(fixture.service.getDraft(draft.id)).resolves.toMatchObject({
      state: "pending_review",
    });
    await expect(fixture.service.get(originalJob.id)).resolves.toMatchObject({
      revision: pending.revision,
      state: "pending_review",
    });
    await expect(stat(workspaceDraftPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("abandons a prepared cleanup journal when neither submitted record was committed", async () => {
    const fixture = await createService();
    const job = await fixture.service.start(request("expert-reflection"));
    const draft = await fixture.service.getDraft(job.draftId);
    const journalPath = join(fixture.statePath, "submission-cleanup-journals", `${draft.id}.json`);
    await mkdir(dirname(journalPath), { recursive: true });
    await writeFile(
      journalPath,
      `${JSON.stringify({
        schemaVersion: "pragma.skill-revision-submission-cleanup/v1",
        draftId: draft.id,
        jobId: job.id,
        workspacePath: draft.workspacePath,
        submissionHash: "f".repeat(64),
        draftRevision: draft.revision + 1,
        jobRevision: job.revision + 1,
        state: "prepared",
      })}\n`,
    );
    const recovered = createSkillRevisionService({
      statePath: fixture.statePath,
      draftsPath: fixture.draftsPath,
      draftsTrashPath: fixture.draftsTrashPath,
      capabilities: fixture.capabilities,
      resolveWorkspacePath: async () => fixture.workspacePath,
    });

    await expect(recovered.getDraft(draft.id)).resolves.toMatchObject({ state: "editing" });
    await expect(recovered.get(job.id)).resolves.toMatchObject({ state: "editing" });
    await expect(stat(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(join(fixture.workspacePath, ".pragma", "skill-revision-drafts", draft.id, "worktree")),
    ).resolves.toBeDefined();
  });

  it("does not block submitted records or delete an unverified cleanup target", async () => {
    const fixture = await createService();
    const job = await fixture.service.start(request("expert-reflection"));
    const inspection = await fixture.service.inspectDraft(job.draftId);
    const pending = await fixture.service.submitDraft({
      draftId: job.draftId,
      expectedRevision: inspection.draft.revision,
      expectedWorkingTreeHash: inspection.workingTree.hash,
      summary: "Keep cleanup failures non-blocking.",
    });
    const draft = await fixture.service.getDraft(job.draftId);
    const unrelatedWorkspace = join(dirname(fixture.workspacePath), "unrelated-workspace");
    const sentinel = join(
      unrelatedWorkspace,
      ".pragma",
      "skill-revision-drafts",
      draft.id,
      "sentinel.txt",
    );
    await mkdir(dirname(sentinel), { recursive: true });
    await writeFile(sentinel, "keep\n");
    await writeFile(
      join(fixture.statePath, "submission-cleanup-journals", `${draft.id}.json`),
      `${JSON.stringify({
        schemaVersion: "pragma.skill-revision-submission-cleanup/v1",
        draftId: draft.id,
        jobId: pending.id,
        workspacePath: unrelatedWorkspace,
        submissionHash: draft.submissionHash,
        draftRevision: draft.revision,
        jobRevision: pending.revision,
        state: "committed",
      })}\n`,
    );
    const warn = vi.fn();
    const recovered = createSkillRevisionService({
      statePath: fixture.statePath,
      draftsPath: fixture.draftsPath,
      draftsTrashPath: fixture.draftsTrashPath,
      capabilities: fixture.capabilities,
      resolveWorkspacePath: async () => fixture.workspacePath,
      warn,
    });

    await expect(recovered.getDraft(draft.id)).resolves.toMatchObject({ state: "pending_review" });
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep\n");
    expect(warn).toHaveBeenCalledWith(
      "Failed to recover a submitted Skill draft cleanup.",
      expect.anything(),
    );
  });

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
      resolveWorkspacePath: async () => fixture.workspacePath,
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
    const replacementWorkspaceRoot = join(
      fixture.workspacePath,
      ".pragma",
      "skill-revision-drafts",
      replacement.draftId,
    );
    await expect(stat(replacementWorkspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });

    // Recreate the exact crash window where both replacement records were committed but the
    // Workspace cleanup had not run and the original conflict had not yet been superseded.
    await mkdir(join(replacementWorkspaceRoot, "worktree"), { recursive: true });
    await writeFile(join(replacementWorkspaceRoot, "worktree", "sentinel.txt"), "remove\n");
    await writeFile(
      join(fixture.statePath, "jobs", `${conflicted.id}.json`),
      `${JSON.stringify(conflicted)}\n`,
    );
    const recoveredService = createSkillRevisionService({
      statePath: fixture.statePath,
      draftsPath: fixture.draftsPath,
      draftsTrashPath: fixture.draftsTrashPath,
      capabilities: fixture.capabilities,
      resolveWorkspacePath: async () => fixture.workspacePath,
    });
    await expect(recoveredService.retry(conflicted.id, conflicted.revision)).resolves.toMatchObject(
      {
        id: replacement.id,
        draftId: replacement.draftId,
      },
    );
    await expect(stat(replacementWorkspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
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

  it("returns review metadata and loads file previews on demand", async () => {
    const fixture = await createService();
    const missionId = randomUUID();
    const job = await fixture.service.start(request("expert-reflection"), { missionId });
    const draft = await fixture.service.inspectDraft(job.draftId, missionId);
    await writeFile(
      join(draft.draftPath!, "SKILL.md"),
      "---\nname: safe-workflow\ndescription: Safe workflow.\n---\n\nFollow the safer workflow.\n",
    );
    await mkdir(join(draft.draftPath!, "references"));
    await writeFile(join(draft.draftPath!, "references", "checks.md"), "# Checks\n\nRun tests.\n");
    await writeFile(join(draft.draftPath!, "asset.bin"), Uint8Array.from([0, 255, 42]));
    const ready = await fixture.service.inspectDraft(job.draftId, missionId);
    await fixture.service.submitDraft({
      draftId: job.draftId,
      expectedRevision: ready.draft.revision,
      expectedWorkingTreeHash: ready.workingTree.hash,
      summary: "Review every changed file.",
      missionId,
    });

    const review = await fixture.service.getReview(job.id);
    expect(review).toMatchObject({
      jobId: job.id,
      draftId: job.draftId,
      operations: [
        {
          path: "SKILL.md",
          operation: "modified",
          before: { executable: false },
          after: { executable: false },
        },
        { path: "asset.bin", operation: "added", before: null, after: { executable: false } },
        {
          path: "references/checks.md",
          operation: "added",
          before: null,
          after: { executable: false },
        },
      ],
    });
    expect(review.baseSnapshotHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(review.candidateSnapshotHash).toMatch(/^[a-f0-9]{64}$/u);

    await expect(fixture.service.getReviewFile(job.id, "SKILL.md")).resolves.toMatchObject({
      jobId: job.id,
      path: "SKILL.md",
      before: {
        content:
          "---\nname: safe-workflow\ndescription: Safe workflow.\n---\n\nFollow the workflow.\n",
        unavailableReason: null,
      },
      after: {
        content:
          "---\nname: safe-workflow\ndescription: Safe workflow.\n---\n\nFollow the safer workflow.\n",
        unavailableReason: null,
      },
    });
    await expect(fixture.service.getReviewFile(job.id, "asset.bin")).resolves.toMatchObject({
      before: null,
      after: { content: null, unavailableReason: "binary", executable: false },
    });
  });

  it("keeps executable-only changes visible in review metadata", async () => {
    const fixture = await createService();
    await mkdir(join(fixture.sourcePath, "scripts"));
    await writeFile(join(fixture.sourcePath, "scripts", "verify.mjs"), "export const ok = true;\n");
    await chmod(join(fixture.sourcePath, "scripts", "verify.mjs"), 0o644);
    const missionId = randomUUID();
    const job = await fixture.service.start(request("expert-reflection"), { missionId });
    const draft = await fixture.service.inspectDraft(job.draftId, missionId);
    await chmod(join(draft.draftPath!, "scripts", "verify.mjs"), 0o755);

    const review = await fixture.service.getReview(job.id);
    expect(review.operations).toContainEqual(
      expect.objectContaining({
        path: "scripts/verify.mjs",
        operation: "modified",
        before: expect.objectContaining({ executable: false }),
        after: expect.objectContaining({ executable: true }),
      }),
    );
  });

  it("supports a legal 600-file directory move with 1,200 review operations", async () => {
    const fixture = await createService();
    const oldDirectory = join(fixture.sourcePath, "references", "old");
    await mkdir(oldDirectory, { recursive: true });
    await Promise.all(
      Array.from({ length: 600 }, async (_, index) => {
        const name = `${index.toString().padStart(3, "0")}.md`;
        await writeFile(join(oldDirectory, name), `# Reference ${index}\n`);
      }),
    );
    const missionId = randomUUID();
    const job = await fixture.service.start(request("expert-reflection"), { missionId });
    const draft = await fixture.service.inspectDraft(job.draftId, missionId);
    await rename(
      join(draft.draftPath!, "references", "old"),
      join(draft.draftPath!, "references", "new"),
    );
    const review = await fixture.service.getReview(job.id);
    expect(review.operations).toHaveLength(1_200);
    expect(review.operations.filter((operation) => operation.operation === "added")).toHaveLength(
      600,
    );
    expect(review.operations.filter((operation) => operation.operation === "deleted")).toHaveLength(
      600,
    );
  });

  it("does not send line-unbounded file content through the review IPC contract", async () => {
    const fixture = await createService();
    const missionId = randomUUID();
    const job = await fixture.service.start(request("expert-reflection"), { missionId });
    const draft = await fixture.service.inspectDraft(job.draftId, missionId);
    await mkdir(join(draft.draftPath!, "references"));
    await writeFile(join(draft.draftPath!, "references", "large.md"), "line\n".repeat(6_000));
    const changed = await fixture.service.inspectDraft(job.draftId, missionId);
    await fixture.service.submitDraft({
      draftId: job.draftId,
      expectedRevision: changed.draft.revision,
      expectedWorkingTreeHash: changed.workingTree.hash,
      summary: "Add a large reference.",
      missionId,
    });

    await expect(
      fixture.service.getReviewFile(job.id, "references/large.md"),
    ).resolves.toMatchObject({
      before: null,
      after: { content: null, unavailableReason: "line_limit", sizeBytes: 30_000 },
    });
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
    await expect(fixture.service.retry(rejected.id, rejected.revision)).rejects.toMatchObject({
      code: "skill_revision_base_changed",
    });
    await expect(fixture.service.get(rejected.id)).resolves.toMatchObject({
      state: "rejected",
      revision: rejected.revision,
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
    await mkdir(join(fixture.draftsPath, draftId, "worktree"), { recursive: true });
    await writeFile(
      join(fixture.draftsPath, draftId, "worktree", "SKILL.md"),
      "---\nname: safe-workflow\ndescription: Safe workflow.\n---\n",
    );

    await expect(fixture.service.get(jobId)).resolves.toMatchObject({
      schemaVersion: "pragma.skill-revision-job/v4",
      revision: 5,
      request: { schemaVersion: "pragma.skill-revision-request/v4", operation: "revise" },
    });
    await expect(fixture.service.getDraft(draftId)).resolves.toMatchObject({
      schemaVersion: "pragma.skill-revision-draft/v4",
      operation: "revise",
      workspacePath: fixture.workspacePath,
    });
    await expect(
      readFile(join(fixture.statePath, "migration-backups", `${jobId}.v2.json`), "utf8"),
    ).resolves.toContain("pragma.skill-revision-job/v2");
    await expect(
      readFile(join(fixture.statePath, "migration-backups", `draft-${draftId}.v1.json`), "utf8"),
    ).resolves.toContain("pragma.skill-revision-draft/v1");
  });

  it("moves a frozen v3 editable worktree into the resolved Workspace on first access", async () => {
    let resolvedWorkspace = "";
    const resolveWorkspacePath = vi.fn(async () => resolvedWorkspace);
    const fixture = await createService({ resolveWorkspacePath });
    resolvedWorkspace = fixture.workspacePath;
    const historicalDraft = await historicalFixture("skill-revision-draft-v3.json");
    const draftId = String(historicalDraft["id"]);
    const legacyWorktree = join(fixture.draftsPath, draftId, "worktree");
    await mkdir(legacyWorktree, { recursive: true });
    await writeFile(
      join(legacyWorktree, "SKILL.md"),
      "---\nname: safe-workflow\ndescription: Safe workflow.\n---\n",
    );
    await writeFile(
      join(fixture.draftsPath, draftId, "draft.json"),
      `${JSON.stringify(historicalDraft)}\n`,
    );

    const migrated = await fixture.service.getDraft(draftId);
    const migratedWorktree = join(
      fixture.workspacePath,
      ".pragma",
      "skill-revision-drafts",
      draftId,
      "worktree",
    );

    expect(migrated).toMatchObject({
      schemaVersion: "pragma.skill-revision-draft/v4",
      workspacePath: fixture.workspacePath,
    });
    await expect(stat(join(migratedWorktree, "SKILL.md"))).resolves.toBeDefined();
    await expect(stat(legacyWorktree)).rejects.toMatchObject({ code: "ENOENT" });
    expect(resolveWorkspacePath).toHaveBeenCalledWith(historicalDraft["activeMissionId"], draftId);
  });

  it("rejects copying a Skill tree into itself before creating the target", async () => {
    const fixture = await createService();
    const source = join(fixture.workspacePath, "source");
    const nestedTarget = join(source, ".pragma", "skill-revision-drafts", randomUUID());
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: nested\ndescription: Nested.\n---\n");

    await expect(copySkillTree(source, nestedTarget)).rejects.toMatchObject({
      code: "skill_revision_invalid_copy_target",
    });
    await expect(stat(nestedTarget)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a legacy Mission worktree as its migration Workspace before creating metadata", async () => {
    let legacyWorkspace = "";
    const fixture = await createService({
      resolveWorkspacePath: async () => legacyWorkspace,
    });
    const historicalDraft = await historicalFixture("skill-revision-draft-v3.json");
    const draftId = String(historicalDraft["id"]);
    legacyWorkspace = join(fixture.draftsPath, draftId, "worktree");
    await mkdir(legacyWorkspace, { recursive: true });
    await writeFile(
      join(legacyWorkspace, "SKILL.md"),
      "---\nname: safe-workflow\ndescription: Safe workflow.\n---\n",
    );
    await writeFile(
      join(fixture.draftsPath, draftId, "draft.json"),
      `${JSON.stringify(historicalDraft)}\n`,
    );

    await expect(fixture.service.getDraft(draftId)).rejects.toMatchObject({
      code: "skill_revision_invalid_copy_target",
    });
    await expect(stat(join(legacyWorkspace, ".pragma"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an unsubmitted rejected v3 worktree when migrating it into the Workspace", async () => {
    const fixture = await createService();
    const historical = await historicalFixture("skill-revision-draft-v3.json");
    const draftId = String(historical["id"]);
    const historicalDraft = {
      ...historical,
      state: "rejected",
      activeMissionId: undefined,
      error: {
        code: "skill_revision_base_changed",
        message: "The Skill changed after this draft was created.",
      },
    };
    const legacyWorktree = join(fixture.draftsPath, draftId, "worktree");
    const migratedWorktree = join(
      fixture.workspacePath,
      ".pragma",
      "skill-revision-drafts",
      draftId,
      "worktree",
    );
    const skill = "---\nname: safe-workflow\ndescription: Safe workflow.\n---\n";
    await mkdir(legacyWorktree, { recursive: true });
    await writeFile(join(legacyWorktree, "SKILL.md"), skill);
    await writeFile(
      join(fixture.draftsPath, draftId, "draft.json"),
      `${JSON.stringify(historicalDraft)}\n`,
    );

    await expect(fixture.service.getDraft(draftId)).resolves.toMatchObject({
      schemaVersion: "pragma.skill-revision-draft/v4",
      state: "rejected",
    });
    await expect(readFile(join(migratedWorktree, "SKILL.md"), "utf8")).resolves.toBe(skill);
    await expect(stat(legacyWorktree)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an unsubmitted worktree when finishing an interrupted v3 migration", async () => {
    const fixture = await createService();
    const historical = await historicalFixture("skill-revision-draft-v3.json");
    const draftId = String(historical["id"]);
    const historicalDraft = {
      ...historical,
      state: "rejected",
      activeMissionId: undefined,
      error: {
        code: "skill_revision_base_changed",
        message: "The Skill changed after this draft was created.",
      },
    };
    const legacyWorktree = join(fixture.draftsPath, draftId, "worktree");
    const targetWorktree = join(
      fixture.workspacePath,
      ".pragma",
      "skill-revision-drafts",
      draftId,
      "worktree",
    );
    const backupPath = join(fixture.statePath, "migration-backups", `draft-${draftId}.v3.json`);
    const journalPath = join(
      fixture.statePath,
      "migration-journals",
      `draft-${draftId}.v3-to-v4.json`,
    );
    const skill = "---\nname: safe-workflow\ndescription: Safe workflow.\n---\n";
    await mkdir(targetWorktree, { recursive: true });
    await mkdir(join(fixture.draftsPath, draftId), { recursive: true });
    await mkdir(dirname(backupPath), { recursive: true });
    await mkdir(dirname(journalPath), { recursive: true });
    await writeFile(join(targetWorktree, "SKILL.md"), skill);
    await writeFile(backupPath, `${JSON.stringify(historicalDraft)}\n`);
    await writeFile(
      join(fixture.draftsPath, draftId, "draft.json"),
      `${JSON.stringify({
        ...historicalDraft,
        schemaVersion: "pragma.skill-revision-draft/v4",
        workspacePath: fixture.workspacePath,
      })}\n`,
    );
    await writeFile(
      journalPath,
      `${JSON.stringify({
        schemaVersion: "pragma.skill-revision-migration/v1",
        kind: "draft",
        recordId: draftId,
        recordPath: join(fixture.draftsPath, draftId, "draft.json"),
        backupPath,
        sourceHash: jsonHash(historicalDraft),
        sourceVersion: "pragma.skill-revision-draft/v3",
        targetVersion: "pragma.skill-revision-draft/v4",
        workspacePath: fixture.workspacePath,
        sourceWorktreePath: legacyWorktree,
        targetWorktreePath: targetWorktree,
      })}\n`,
    );

    await expect(fixture.service.getDraft(draftId)).resolves.toMatchObject({
      state: "rejected",
    });
    await expect(readFile(join(targetWorktree, "SKILL.md"), "utf8")).resolves.toBe(skill);
    await expect(stat(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replays an interrupted v3 Workspace migration from its stable journal", async () => {
    const fixture = await createService();
    const historicalDraft = await historicalFixture("skill-revision-draft-v3.json");
    const draftId = String(historicalDraft["id"]);
    const legacyWorktree = join(fixture.draftsPath, draftId, "worktree");
    const targetWorktree = join(
      fixture.workspacePath,
      ".pragma",
      "skill-revision-drafts",
      draftId,
      "worktree",
    );
    const skill = "---\nname: safe-workflow\ndescription: Safe workflow.\n---\n";
    await mkdir(legacyWorktree, { recursive: true });
    await mkdir(targetWorktree, { recursive: true });
    await writeFile(join(legacyWorktree, "SKILL.md"), skill);
    await writeFile(join(targetWorktree, "SKILL.md"), skill);
    await writeFile(
      join(fixture.draftsPath, draftId, "draft.json"),
      `${JSON.stringify(historicalDraft)}\n`,
    );
    const backupPath = join(fixture.statePath, "migration-backups", `draft-${draftId}.v3.json`);
    const journalPath = join(
      fixture.statePath,
      "migration-journals",
      `draft-${draftId}.v3-to-v4.json`,
    );
    await mkdir(dirname(backupPath), { recursive: true });
    await mkdir(dirname(journalPath), { recursive: true });
    await writeFile(backupPath, `${JSON.stringify(historicalDraft)}\n`);
    await writeFile(
      journalPath,
      `${JSON.stringify({
        schemaVersion: "pragma.skill-revision-migration/v1",
        kind: "draft",
        recordId: draftId,
        recordPath: join(fixture.draftsPath, draftId, "draft.json"),
        backupPath,
        sourceHash: jsonHash(historicalDraft),
        sourceVersion: "pragma.skill-revision-draft/v3",
        targetVersion: "pragma.skill-revision-draft/v4",
        workspacePath: fixture.workspacePath,
        sourceWorktreePath: legacyWorktree,
        targetWorktreePath: targetWorktree,
      })}\n`,
    );

    await expect(fixture.service.getDraft(draftId)).resolves.toMatchObject({
      schemaVersion: "pragma.skill-revision-draft/v4",
      workspacePath: fixture.workspacePath,
    });
    await expect(readFile(join(targetWorktree, "SKILL.md"), "utf8")).resolves.toBe(skill);
    await expect(stat(legacyWorktree)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
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
    await mkdir(join(fixture.draftsPath, draftId, "worktree"), { recursive: true });
    await writeFile(
      join(fixture.draftsPath, draftId, "worktree", "SKILL.md"),
      "---\nname: safe-workflow\ndescription: Safe workflow.\n---\n",
    );
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
      schemaVersion: "pragma.skill-revision-draft/v4",
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
    const futureDraft = { ...draft, schemaVersion: "pragma.skill-revision-draft/v5" };
    await writeFile(jobPath, `${JSON.stringify(futureJob)}\n`);
    await writeFile(draftPath, `${JSON.stringify(futureDraft)}\n`);

    await expect(fixture.service.get(job.id)).rejects.toThrow();
    await expect(fixture.service.getDraft(draft.id)).rejects.toThrow();
    await expect(readFile(jobPath, "utf8")).resolves.toContain("pragma.skill-revision-job/v5");
    await expect(readFile(draftPath, "utf8")).resolves.toContain("pragma.skill-revision-draft/v5");
  });

  it("deletes Skill revision tasks in any state", async () => {
    const fixture = await createService();
    const job = await fixture.service.start(request("expert-reflection"));
    const editing = await fixture.service.inspectDraft(job.draftId);
    const pending = await fixture.service.submitDraft({
      draftId: job.draftId,
      expectedRevision: editing.draft.revision,
      expectedWorkingTreeHash: editing.workingTree.hash,
      summary: "Review this revision.",
    });

    await fixture.service.delete(pending.id, pending.revision);

    await expect(fixture.service.list()).resolves.toEqual([]);
    await expect(fixture.service.listDrafts()).resolves.toEqual([]);

    const nextJob = await fixture.service.start(request("expert-reflection"));
    const nextEditing = await fixture.service.inspectDraft(nextJob.draftId);
    const nextPending = await fixture.service.submitDraft({
      draftId: nextJob.draftId,
      expectedRevision: nextEditing.draft.revision,
      expectedWorkingTreeHash: nextEditing.workingTree.hash,
      summary: "Review this revision.",
    });
    const rejected = await fixture.service.reject(nextPending.id, nextPending.revision);
    const reopened = await fixture.service.retry(rejected.id, rejected.revision);
    expect(reopened.state).toBe("pending_review");
    const rejectedAgain = await fixture.service.reject(reopened.id, reopened.revision);
    await fixture.service.delete(rejectedAgain.id, rejectedAgain.revision);

    await expect(fixture.service.get(rejectedAgain.id)).resolves.toMatchObject({
      state: "rejected",
      error: { code: "draft_discarded" },
    });
    await expect(fixture.service.list()).resolves.toEqual([]);
    await expect(fixture.service.listDrafts()).resolves.toEqual([]);
    await expect(fixture.service.getDraft(job.draftId)).rejects.toThrow();
  });

  it("deletes the managed draft together with a needs-attention task", async () => {
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
            summary: "Add an unsafe helper.",
            operations: [
              {
                operation: "upsert" as const,
                path: "scripts/run.mjs",
                content: "export const run = () => fetch('https://example.test');\n",
              },
            ],
          };
        },
      },
    });
    const started = await fixture.service.submit(legacyRequest());
    await fixture.service.processPending();
    const failed = await fixture.service.get(started.id);
    expect(failed.state).toBe("needs_attention");
    const editing = await fixture.service.inspectDraft(failed.draftId);
    expect(editing.draft.state).toBe("editing");

    await fixture.service.delete(failed.id, failed.revision);

    await expect(fixture.service.list()).resolves.toEqual([]);
    await expect(fixture.service.listDrafts()).resolves.toEqual([]);
    await expect(fixture.service.getDraft(failed.draftId)).rejects.toThrow();
    await expect(
      fixture.service.start(request("expert-reflection"), { draftId: failed.draftId }),
    ).rejects.toThrow();
    await expect(
      fixture.service.submitDraft({
        draftId: failed.draftId,
        expectedRevision: editing.draft.revision,
        expectedWorkingTreeHash: editing.workingTree.hash,
        summary: "Cannot submit a discarded draft.",
      }),
    ).rejects.toThrow();
  });

  it("deletes completed review history without removing the published Skill", async () => {
    const fixture = await createService();
    const job = await fixture.service.start(request("expert-reflection"));
    const editing = await fixture.service.inspectDraft(job.draftId);
    const pending = await fixture.service.submitDraft({
      draftId: job.draftId,
      expectedRevision: editing.draft.revision,
      expectedWorkingTreeHash: editing.workingTree.hash,
      summary: "Publish this revision.",
    });
    const completed = await fixture.service.approve(pending.id, pending.revision);
    expect(completed).toMatchObject({ state: "completed", publishedRevision: 2 });

    await fixture.service.delete(completed.id, completed.revision);

    await expect(fixture.service.list()).resolves.toEqual([]);
    await expect(fixture.capabilities.get(capabilityId)).resolves.toMatchObject({
      definition: { kind: "skill", name: "safe-workflow" },
    });
    expect(fixture.publish).toHaveBeenCalledOnce();
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
    readonly resolveWorkspacePath?: Parameters<
      typeof createSkillRevisionService
    >[0]["resolveWorkspacePath"];
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
  const workspacePath = join(root, "workspace");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  const canonicalWorkspacePath = await realpath(workspacePath);
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
    workspacePath: canonicalWorkspacePath,
    statePath: join(root, "state"),
    draftsPath: join(root, "data", "skill-revision-drafts"),
    draftsTrashPath: join(root, "trash", "skill-revision-drafts"),
    capabilities,
    service: createSkillRevisionService({
      statePath: join(root, "state"),
      draftsPath: join(root, "data", "skill-revision-drafts"),
      draftsTrashPath: join(root, "trash", "skill-revision-drafts"),
      capabilities,
      resolveWorkspacePath: options.resolveWorkspacePath ?? (async () => canonicalWorkspacePath),
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
