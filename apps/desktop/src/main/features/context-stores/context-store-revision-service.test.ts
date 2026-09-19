import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createContextStoreRevisionService,
  type ContextStoreRevisionGenerator,
  type ContextStoreRevisionService,
} from "./context-store-revision-service.ts";
import { createContextStoreStore } from "./context-store-store.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture(
  options: {
    readonly onRevisionDetached?:
      | ((input: {
          readonly missionId: string;
          readonly jobId: string;
          readonly draftId: string;
          readonly storeId: string;
        }) => Promise<void>)
      | undefined;
    readonly generator?: ContextStoreRevisionGenerator | undefined;
    readonly failPrompt?: string;
    readonly beforeGenerate?: (prompt: string) => Promise<void>;
    readonly isMissionAvailable?: ((missionId: string) => Promise<boolean>) | undefined;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "pragma-store-revisions-"));
  directories.push(directory);
  const contextStores = createContextStoreStore({
    storesPath: join(directory, "data", "context-stores"),
  });
  const draftsPath = join(directory, "data", "context-store-drafts");
  const service = createContextStoreRevisionService({
    statePath: join(directory, "state", "context-store-revisions"),
    draftsPath,
    contextStores,
    generator: options.generator ?? {
      async generate({ request, snapshot }) {
        await options.beforeGenerate?.(request.prompt);
        if (request.prompt === options.failPrompt) throw new Error("Runtime failed");
        return {
          schemaVersion: "pragma.context-store-change-set/v2" as const,
          operation: "revise" as const,
          storeId: request.storeId,
          baseRevision: snapshot.revision,
          baseSnapshotHash: snapshot.snapshotHash,
          summary: request.prompt,
          operations: [
            {
              operation: "upsert" as const,
              id: "items/revised.md",
              content: `# ${request.prompt}\n`,
              metadata: {
                description: "Revised",
                trigger: "manual" as const,
                priority: "normal" as const,
              },
            },
          ],
        };
      },
    },
    isMissionAvailable: options.isMissionAvailable,
    onRevisionDetached: options.onRevisionDetached,
  });
  const store = await contextStores.create({ mode: "blank", name: "Knowledge", description: "" });
  return { directory, draftsPath, contextStores, service, store };
}

describe("context store sparse draft revisions", () => {
  it("publishes an approved creation draft as formal revision 1", async () => {
    const { directory, draftsPath, service, contextStores } = await fixture();
    const reservedId = "90000000-0000-4000-8000-000000000001";
    const job = await service.start({
      schemaVersion: "pragma.context-store-revision-request/v2",
      operation: "create",
      storeId: reservedId,
      resourceName: "Created by Agent",
      resourceDescription: "A reviewed knowledge base.",
      prompt: "Create the knowledge base.",
      source: "user",
    });
    await expect(contextStores.list()).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: reservedId })]),
    );
    const draftStore = (await service.resolveDraft(job.draftId)).store;
    for (const [id, trigger] of [
      ["guide.md", "always_on"],
      ["overview.md", "always_on"],
      ["index.md", "model_decision"],
      ["items/fact.md", "model_decision"],
    ] as const) {
      const added = await draftStore.addContext({
        id,
        content: `# ${id}\n`,
        metadata: { trigger, priority: "normal" },
      });
      expect(added.ok).toBe(true);
    }
    const draft = await service.getDraft(job.draftId);
    await service.submitDraft(draft.id, draft.revision, "Create reviewed knowledge.");
    const pending = await service.get(job.id);
    const completed = await service.approve(pending.id, pending.revision);

    expect(completed.state).toBe("merged");
    await expect(contextStores.getSnapshot(reservedId)).resolves.toMatchObject({
      revision: 1,
      files: expect.arrayContaining([expect.objectContaining({ id: "guide.md" })]),
    });
    await expect(contextStores.history(reservedId)).resolves.toEqual([
      expect.objectContaining({ revision: 1, parentRevision: null, revisionJobId: job.id }),
    ]);

    const completedDraft = await service.getDraft(job.draftId);
    await writeFile(
      join(directory, "state", "context-store-revisions", "jobs", `${job.id}.json`),
      `${JSON.stringify({ ...completed, state: "merging" })}\n`,
    );
    await writeFile(
      join(draftsPath, job.draftId, "draft.json"),
      `${JSON.stringify({
        ...completedDraft,
        state: "merging",
        submittedRevision: completedDraft.revision,
      })}\n`,
    );
    await service.processPending();

    await expect(service.get(job.id)).resolves.toMatchObject({ state: "merged" });
    await expect(contextStores.history(reservedId)).resolves.toHaveLength(1);
  });

  it("moves a creation to needs_attention when its reserved id is occupied", async () => {
    const { service, contextStores } = await fixture();
    const reservedId = "90000000-0000-4000-8000-000000000004";
    const job = await service.start({
      schemaVersion: "pragma.context-store-revision-request/v2",
      operation: "create",
      storeId: reservedId,
      resourceName: "Conflicting creation",
      resourceDescription: "Must not overwrite another resource.",
      prompt: "Create the knowledge base.",
      source: "user",
    });
    const draftStore = (await service.resolveDraft(job.draftId)).store;
    for (const [id, trigger] of [
      ["guide.md", "always_on"],
      ["overview.md", "always_on"],
      ["index.md", "model_decision"],
      ["items/fact.md", "model_decision"],
    ] as const) {
      await draftStore.addContext({
        id,
        content: `# ${id}\n`,
        metadata: { trigger, priority: "normal" },
      });
    }
    const draft = await service.getDraft(job.draftId);
    await service.submitDraft(draft.id, draft.revision, "Create reviewed knowledge.");
    await contextStores.createFromSnapshot({
      id: reservedId,
      name: "Occupied",
      description: "Existing content.",
      files: [],
      author: "user",
      summary: "Occupy the reserved id.",
    });
    const pending = await service.get(job.id);

    const conflicted = await service.approve(pending.id, pending.revision);
    expect(conflicted).toMatchObject({
      state: "needs_attention",
      error: { code: "knowledge_creation_id_conflict" },
    });
    await expect(service.getDraft(job.draftId)).resolves.toMatchObject({
      state: "needs_attention",
    });

    const replacement = await service.retry(conflicted.id, conflicted.revision);
    expect(replacement).toMatchObject({
      state: "pending_review",
      request: { operation: "create" },
    });
    expect(replacement.id).not.toBe(job.id);
    expect(replacement.draftId).not.toBe(job.draftId);
    expect(replacement.request.storeId).not.toBe(reservedId);
    await expect(service.get(job.id)).resolves.toMatchObject({
      state: "rejected",
      error: { code: "knowledge_creation_id_conflict_recovered" },
    });
    await expect(service.getDraft(replacement.draftId)).resolves.toMatchObject({
      state: "pending_review",
      summary: "Create reviewed knowledge.",
      overlay: { files: expect.arrayContaining([expect.objectContaining({ id: "guide.md" })]) },
    });
    await expect(service.retry(conflicted.id, conflicted.revision)).rejects.toMatchObject({
      code: "invalid_state",
    });

    const completed = await service.approve(replacement.id, replacement.revision);
    expect(completed.state).toBe("merged");
    await expect(contextStores.getSnapshot(replacement.request.storeId)).resolves.toMatchObject({
      revision: 1,
      files: expect.arrayContaining([expect.objectContaining({ id: "guide.md" })]),
    });
  });

  it("rejects an incomplete knowledge-base creation draft", async () => {
    const { service } = await fixture();
    const job = await service.start({
      schemaVersion: "pragma.context-store-revision-request/v2",
      operation: "create",
      storeId: "90000000-0000-4000-8000-000000000002",
      resourceName: "Incomplete",
      resourceDescription: "Missing required files.",
      prompt: "Create an incomplete knowledge base.",
      source: "user",
    });
    const draftStore = (await service.resolveDraft(job.draftId)).store;
    await draftStore.addContext({
      id: "items/only.md",
      content: "# Only\n",
      metadata: { trigger: "model_decision", priority: "normal" },
    });
    const draft = await service.getDraft(job.draftId);
    await expect(
      service.submitDraft(draft.id, draft.revision, "Incomplete."),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it.each(["merged", "discarded", "failed", "orphaned"] as const)(
    "starts another revision after a %s historical job",
    async (history) => {
      const { service, store } = await fixture({
        isMissionAvailable: async () => false,
        failPrompt: "Fail",
      });
      const request = {
        schemaVersion: "pragma.context-store-revision-request/v2" as const,
        operation: "revise" as const,
        storeId: store.id,
        prompt: "Record a fact",
        source: "expert-reflection" as const,
        provenance: {
          executionId: "execution",
          invocationId: "invocation",
          expertId: "0000000000000002",
        },
      };
      const first = await service.start({
        ...request,
        prompt: history === "failed" ? "Fail" : request.prompt,
        sourceDigest: "a".repeat(64),
      });
      if (history === "merged") {
        await service.processPending();
        const reviewed = await service.get(first.id);
        await service.approve(first.id, reviewed.revision);
      } else if (history === "discarded") {
        const draft = await service.getDraft(first.draftId);
        await service.discardDraft(draft.id, draft.revision);
      } else if (history === "failed") {
        await service.processPending();
        expect((await service.get(first.id)).state).toBe("needs_attention");
      } else {
        await service.attachMission(first.id, "22222222-2222-4222-8222-222222222226");
        await service.getDraftWithRecovery(first.draftId);
      }
      const next = await service.start({ ...request, sourceDigest: "b".repeat(64) });
      expect(next.id).not.toBe(first.id);
      expect(next.draftId).not.toBe(first.draftId);
      expect((await service.start({ ...request, sourceDigest: "b".repeat(64) })).id).toBe(next.id);
      await service.processPending();
      expect((await service.get(next.id)).state).toBe("pending_review");
    },
  );

  it("drains a new background request scheduled while another revision is processing", async () => {
    const { service, store } = await fixture({
      beforeGenerate: async (prompt) => {
        if (prompt !== "First") return;
        await service.start({
          schemaVersion: "pragma.context-store-revision-request/v2",
          operation: "revise" as const,
          storeId: store.id,
          prompt: "Second",
          source: "user",
        });
        service.scheduleProcessing();
      },
    });
    await service.start({
      schemaVersion: "pragma.context-store-revision-request/v2",
      operation: "revise" as const,
      storeId: store.id,
      prompt: "First",
      source: "user",
    });
    await service.processPending();
    const jobs = await service.list();
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.state === "pending_review")).toBe(true);
  });

  it("keeps an intentionally unsubmitted Agent draft editable and attached", async () => {
    const missionId = "22222222-2222-4222-8222-222222222226";
    const serviceRef: { current?: ContextStoreRevisionService } = {};
    const generate = vi.fn<ContextStoreRevisionGenerator["generate"]>(async (input) => {
      if (serviceRef.current === undefined) throw new Error("revision_service_unavailable");
      await serviceRef.current.attachMission(input.jobId, missionId);
      const resolved = await serviceRef.current.resolveDraft(input.draftId);
      await resolved.store.addContext({ id: "items/review-first.md", content: "# Review first\n" });
      return undefined;
    });
    const fixtureResult = await fixture({ generator: { generate } });
    serviceRef.current = fixtureResult.service;
    const activeService = serviceRef.current;
    const job = await activeService.start({
      schemaVersion: "pragma.context-store-revision-request/v2",
      operation: "revise" as const,
      storeId: fixtureResult.store.id,
      prompt: "Let me inspect the editable draft before submission",
      source: "user",
    });

    await activeService.processPending();

    const paused = await activeService.get(job.id);
    expect(paused).toMatchObject({
      state: "editing",
      missionId,
    });
    expect(paused.error).toBeUndefined();
    await expect(activeService.getDraft(job.draftId)).resolves.toMatchObject({
      state: "editing",
      activeMissionId: missionId,
    });

    await writeFile(
      join(fixtureResult.directory, "state", "context-store-revisions", "jobs", `${job.id}.json`),
      `${JSON.stringify({
        ...paused,
        state: "needs_attention",
        error: {
          code: "draft_not_submitted",
          message: "The Store Revision Agent finished without submitting its draft.",
        },
      })}\n`,
    );
    await activeService.processPending();
    await expect(activeService.get(job.id)).resolves.toMatchObject({
      state: "editing",
      missionId,
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("deduplicates machine submissions and persists only an overlay before approval", async () => {
    const { draftsPath, contextStores, service, store } = await fixture();
    const request = {
      schemaVersion: "pragma.context-store-revision-request/v2" as const,
      operation: "revise" as const,
      storeId: store.id,
      prompt: "Record the reflected invariant",
      source: "memory-learning" as const,
      sourceDigest: "b".repeat(64),
    };
    const first = await service.submit(request);
    expect((await service.submit(request)).id).toBe(first.id);
    const otherStore = await contextStores.create({
      mode: "blank",
      name: "Other knowledge",
      description: "",
    });
    const other = await service.submit({ ...request, storeId: otherStore.id });
    expect(other.id).not.toBe(first.id);
    expect(other.request.storeId).toBe(otherStore.id);

    await service.processPending();
    const staged = await service.get(first.id);
    const draft = await service.getDraft(staged.draftId);
    expect(staged.state).toBe("pending_review");
    expect(draft.overlay.files.map((file) => file.id)).toEqual(["items/revised.md"]);
    await expect(contextStores.listEntries(store.id)).resolves.toEqual([]);
    const persisted = JSON.parse(
      await readFile(join(draftsPath, draft.id, "draft.json"), "utf8"),
    ) as {
      overlay: { files: { id: string }[] };
    };
    expect(persisted.overlay.files).toEqual([expect.objectContaining({ id: "items/revised.md" })]);

    const merged = await service.approve(staged.id, staged.revision);
    expect(merged.state).toBe("merged");
    await expect(contextStores.getContent(store.id, "items/revised.md")).resolves.toMatchObject({
      content: "# Record the reflected invariant\n",
    });
  });

  it("routes unmodified reads to the immutable base and writes through the sparse overlay", async () => {
    const { service, contextStores, store } = await fixture();
    await contextStores.createFile(store.id, "items/base.md", "# Base\n");
    await contextStores.createFile(store.id, "items/untouched.md", "# Untouched\n");
    const draft = await service.createDraft({ storeId: store.id, name: "Edit base" });
    const resolved = await service.resolveDraft(draft.id);

    await expect(resolved.store.readContext({ id: "items/untouched.md" })).resolves.toMatchObject({
      ok: true,
      value: { content: "# Untouched\n" },
    });
    const current = await resolved.store.readContext({ id: "items/base.md" });
    if (!current.ok) throw new Error(current.error.message);
    await expect(
      resolved.store.editContext({
        id: "items/base.md",
        mode: "replace",
        content: "# Draft\n",
        expectedRevision: current.value.revision,
      }),
    ).resolves.toMatchObject({ ok: true, value: { content: "# Draft\n" } });

    const changed = await service.getDraft(draft.id);
    expect(changed.overlay.files.map((file) => file.id)).toEqual(["items/base.md"]);
    expect(changed.overlay.files.some((file) => file.content.includes("Untouched"))).toBe(false);
    await expect(service.getDraftChangeSet(draft.id)).resolves.toMatchObject({
      baseRevision: draft.baseRevision,
      operations: [
        {
          operation: "upsert",
          id: "items/base.md",
          previousContent: "# Base\n",
          content: "# Draft\n",
        },
      ],
    });
    await expect(contextStores.getContent(store.id, "items/base.md")).resolves.toMatchObject({
      content: "# Base\n",
    });
  });

  it("locates submit validation failures by knowledge file id", async () => {
    const { service, contextStores, store } = await fixture();
    await contextStores.createFile(store.id, "guide.md", "# Guide\n", {
      trigger: "always_on",
      priority: "critical",
    });
    await contextStores.createFile(store.id, "overview.md", "# Overview\n", {
      trigger: "always_on",
      priority: "normal",
    });
    await contextStores.createFile(store.id, "index.md", "# Index\n", {
      trigger: "model_decision",
      priority: "normal",
    });
    await contextStores.createFile(store.id, "items/base.md", "# Base\n");
    const draft = await service.createDraft({ storeId: store.id, name: "Broken navigation" });
    const resolved = await service.resolveDraft(draft.id);
    const overview = await resolved.store.readContext({ id: "overview.md" });
    if (!overview.ok) throw new Error(overview.error.message);
    await resolved.store.editContext({
      id: "overview.md",
      mode: "replace",
      content: "# Overview\n\n[Missing](items/missing.md)\n",
      expectedRevision: overview.value.revision,
    });
    const edited = await service.getDraft(draft.id);

    await expect(
      service.submitDraft(draft.id, edited.revision, "Break a link"),
    ).rejects.toMatchObject({
      code: "validation_failed",
      message: expect.stringContaining("overview.md: Internal Markdown link target does not exist"),
      details: {
        diagnostics: [
          {
            id: "overview.md",
            reason: "Internal Markdown link target does not exist: items/missing.md",
          },
        ],
      },
    });
  });

  it("keeps a submitted draft immutable until review rejects it", async () => {
    const { service, store } = await fixture();
    const job = await service.start(
      {
        schemaVersion: "pragma.context-store-revision-request/v2",
        operation: "revise" as const,
        storeId: store.id,
        prompt: "Collaborate on the draft",
        source: "user",
      },
      { draftName: "Collaborative" },
    );
    const missionId = "22222222-2222-4222-8222-222222222222";
    await service.attachMission(job.id, missionId);
    const resolved = await service.resolveDraft(job.draftId);
    await resolved.store.addContext({ id: "items/a.md", content: "A" });
    const edited = await service.getDraft(job.draftId);
    const submitted = await service.submitDraft(edited.id, edited.revision, "Add A");
    const again = await service.resolveDraft(submitted.id);
    await expect(again.store.addContext({ id: "items/b.md", content: "B" })).resolves.toMatchObject(
      {
        ok: false,
        error: {
          code: "permission_denied",
          message:
            "Only an editing knowledge draft can be changed; submitted and non-editable drafts are read-only.",
        },
      },
    );
    await expect(
      service.rebase({
        draftId: submitted.id,
        expectedRevision: submitted.revision,
        resolutions: [],
      }),
    ).rejects.toMatchObject({
      code: "invalid_state",
      message: "Only an editable knowledge draft can be rebased.",
    });

    await expect(service.getDraft(job.draftId)).resolves.toEqual(submitted);
    await expect(service.get(job.id)).resolves.toMatchObject({
      state: "pending_review",
      missionId,
    });

    const pending = await service.get(job.id);
    await service.reject(job.id, pending.revision);
    const rejectedDraft = await service.resolveDraft(job.draftId);
    await expect(
      rejectedDraft.store.addContext({ id: "items/b.md", content: "B" }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("makes repeated Mission attachment idempotent", async () => {
    const { service, store } = await fixture();
    const job = await service.start({
      schemaVersion: "pragma.context-store-revision-request/v2",
      operation: "revise" as const,
      storeId: store.id,
      prompt: "Attach once",
      source: "user",
    });
    const missionId = "22222222-2222-4222-8222-222222222223";

    const attached = await service.attachMission(job.id, missionId);
    const draft = await service.getDraft(job.draftId);
    await expect(service.attachMission(job.id, missionId)).resolves.toEqual(attached);
    await expect(service.getDraft(job.draftId)).resolves.toEqual(draft);
  });

  it("releases a submitted Mission draft without changing its review state", async () => {
    const { service, store } = await fixture();
    const job = await service.start({
      schemaVersion: "pragma.context-store-revision-request/v2",
      operation: "revise" as const,
      storeId: store.id,
      prompt: "Submit before detaching",
      source: "user",
    });
    const missionId = "22222222-2222-4222-8222-222222222224";
    await service.attachMission(job.id, missionId);
    const resolved = await service.resolveDraft(job.draftId);
    await resolved.store.addContext({ id: "items/review.md", content: "Ready" });
    const edited = await service.getDraft(job.draftId);
    const submitted = await service.submitDraft(job.draftId, edited.revision, "Ready for review");

    await expect(service.detachMission(job.id, missionId)).resolves.toMatchObject({
      state: "pending_review",
      missionId: undefined,
    });
    const detachedDraft = await service.getDraft(submitted.id);
    expect(detachedDraft.state).toBe("pending_review");
    expect(detachedDraft.activeMissionId).toBeUndefined();
  });

  it("preserves an orphaned draft while releasing its missing Mission claim", async () => {
    const { service, store } = await fixture();
    const job = await service.start({
      schemaVersion: "pragma.context-store-revision-request/v2",
      operation: "revise" as const,
      storeId: store.id,
      prompt: "Preserve the orphaned draft",
      source: "user",
    });
    const missionId = "22222222-2222-4222-8222-222222222229";
    await service.attachMission(job.id, missionId);
    const resolved = await service.resolveDraft(job.draftId);
    await resolved.store.addContext({ id: "items/orphan.md", content: "Keep this" });

    await service.releaseMissionClaim({
      draftId: job.draftId,
      missionId,
      jobId: job.id,
      reason: "mission_orphaned",
    });

    const recoveredDraft = await service.getDraft(job.draftId);
    expect(recoveredDraft).toMatchObject({
      state: "editing",
      overlay: { files: [{ id: "items/orphan.md", content: "Keep this" }] },
    });
    expect(recoveredDraft.activeMissionId).toBeUndefined();
    const recoveredJob = await service.get(job.id);
    expect(recoveredJob).toMatchObject({
      state: "needs_attention",
      error: { code: "mission_orphaned" },
    });
    expect(recoveredJob.missionId).toBeUndefined();
  });

  it("repairs a deleted Mission claim when its task is read", async () => {
    const missionId = "22222222-2222-4222-8222-222222222238";
    const { service, store } = await fixture({
      isMissionAvailable: async (candidate) => candidate !== missionId,
    });
    const job = await service.start({
      schemaVersion: "pragma.context-store-revision-request/v2",
      operation: "revise" as const,
      storeId: store.id,
      prompt: "Keep the editable overlay after the Mission is removed",
      source: "user",
    });
    await service.attachMission(job.id, missionId);
    const draft = await service.resolveDraft(job.draftId);
    await draft.store.addContext({ id: "items/keep.md", content: "Keep this overlay" });

    const [recoveredJob] = await service.list();
    expect(recoveredJob).toMatchObject({
      id: job.id,
      state: "needs_attention",
      error: { code: "mission_orphaned" },
    });
    expect(recoveredJob?.missionId).toBeUndefined();
    expect((await service.getDraft(job.draftId)).activeMissionId).toBeUndefined();
    await expect(draft.store.readContext({ id: "items/keep.md" })).resolves.toMatchObject({
      ok: true,
      value: expect.objectContaining({ content: "Keep this overlay" }),
    });
  });

  it("replays an interrupted Mission-claim release", async () => {
    const { directory, service, store } = await fixture();
    const job = await service.start({
      schemaVersion: "pragma.context-store-revision-request/v2",
      operation: "revise" as const,
      storeId: store.id,
      prompt: "Recover the release journal",
      source: "user",
    });
    const missionId = "22222222-2222-4222-8222-222222222230";
    await service.attachMission(job.id, missionId);
    const journals = join(directory, "state", "context-store-revisions", "claim-releases");
    await mkdir(journals, { recursive: true });
    await writeFile(
      join(journals, `${job.draftId}-${job.id}-${missionId}.json`),
      `${JSON.stringify({
        schemaVersion: "pragma.context-store-revision-claim-release/v1",
        draftId: job.draftId,
        jobId: job.id,
        missionId,
        reason: "mission_orphaned",
      })}\n`,
    );

    await service.recoverMissionClaimReleases();

    expect((await service.getDraft(job.draftId)).activeMissionId).toBeUndefined();
    const recoveredJob = await service.get(job.id);
    expect(recoveredJob).toMatchObject({
      state: "needs_attention",
      error: { code: "mission_orphaned" },
    });
    expect(recoveredJob.missionId).toBeUndefined();
  });

  it("continues recovering valid claim releases when another release journal is malformed", async () => {
    const { directory, service, store } = await fixture();
    const job = await service.start({
      schemaVersion: "pragma.context-store-revision-request/v2",
      operation: "revise" as const,
      storeId: store.id,
      prompt: "Recover despite another damaged release journal",
      source: "user",
    });
    const missionId = "22222222-2222-4222-8222-222222222240";
    await service.attachMission(job.id, missionId);
    const journals = join(directory, "state", "context-store-revisions", "claim-releases");
    await mkdir(journals, { recursive: true });
    await writeFile(
      join(journals, `${job.draftId}-${job.id}-${missionId}.json`),
      `${JSON.stringify({
        schemaVersion: "pragma.context-store-revision-claim-release/v1",
        draftId: job.draftId,
        jobId: job.id,
        missionId,
        reason: "mission_orphaned",
      })}\n`,
    );
    await writeFile(join(journals, "broken.json"), "{invalid");

    await service.recoverMissionClaimReleases();

    const recovered = await service.get(job.id);
    expect(recovered.error).toMatchObject({ code: "mission_orphaned" });
    expect(recovered.missionId).toBeUndefined();
  });

  it("recovers one durable Mission claim after interruption before the Mission mount", async () => {
    const { contextStores, directory, store, service } = await fixture();
    const missionId = "22222222-2222-4222-8222-222222222231";
    const request = {
      schemaVersion: "pragma.context-store-revision-request/v2" as const,
      operation: "revise" as const,
      storeId: store.id,
      prompt: "First attempt interrupted before mount",
      source: "user" as const,
    };

    const claimed = await service.startForMission({ request, missionId });
    const restarted = createContextStoreRevisionService({
      statePath: join(directory, "state", "context-store-revisions"),
      draftsPath: join(directory, "data", "context-store-drafts"),
      contextStores,
      generator: { generate: async () => undefined },
    });

    // A process restart must not create another task merely because the Mission mount was not written.
    const recovered = await restarted.getMissionActiveJob({ missionId, storeId: store.id });
    expect(recovered).toMatchObject({ id: claimed.id, draftId: claimed.draftId, missionId });
    const retry = await restarted.startForMission({
      missionId,
      request: { ...request, prompt: "Different retry input must reuse the same claim" },
    });
    expect(retry.id).toBe(claimed.id);
    await restarted.completeMissionClaimMount({
      missionId,
      storeId: store.id,
      jobId: claimed.id,
      draftId: claimed.draftId,
    });
    await expect(
      restarted.getMissionActiveJob({ missionId, storeId: store.id }),
    ).resolves.toMatchObject({
      id: claimed.id,
    });
  });

  it("does not create another job for a draft still owned by a failed Mission", async () => {
    const { service, store } = await fixture({
      beforeGenerate: async () => {
        await service.attachMission(job.id, "22222222-2222-4222-8222-222222222253");
        throw new Error("Runtime failed after Mission attachment");
      },
    });
    const request = {
      schemaVersion: "pragma.context-store-revision-request/v2" as const,
      operation: "revise" as const,
      storeId: store.id,
      prompt: "Revise",
      source: "user" as const,
    };
    const job = await service.start(request);
    await service.processPending();
    expect((await service.get(job.id)).state).toBe("needs_attention");
    await expect(
      service.start({ ...request, prompt: "Try again" }, { draftId: job.draftId }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    expect(await service.list()).toHaveLength(1);
    expect((await service.getDraft(job.draftId)).activeMissionId).toBeDefined();
  });

  it("submits the active task rather than reviving an earlier stopped task for the same draft", async () => {
    const { service, store, directory } = await fixture();
    const request = {
      schemaVersion: "pragma.context-store-revision-request/v2" as const,
      operation: "revise" as const,
      storeId: store.id,
      prompt: "Revise",
      source: "user" as const,
    };
    const old = await service.start(request);
    const oldMission = "22222222-2222-4222-8222-222222222251";
    await service.attachMission(old.id, oldMission);
    await service.releaseMissionClaim({
      draftId: old.draftId,
      jobId: old.id,
      missionId: oldMission,
      reason: "mission_orphaned",
    });
    // Ensure the historical record is enumerated before the current owner, independently of UUID randomness.
    const jobsPath = join(directory, "state", "context-store-revisions", "jobs");
    const stopped = JSON.parse(await readFile(join(jobsPath, `${old.id}.json`), "utf8"));
    const oldId = "00000000-0000-4000-8000-000000000001";
    await writeFile(join(jobsPath, `${oldId}.json`), JSON.stringify({ ...stopped, id: oldId }));
    await rm(join(jobsPath, `${old.id}.json`));
    const active = await service.startForMission({
      request,
      draftId: old.draftId,
      missionId: "22222222-2222-4222-8222-222222222252",
    });
    const resolved = await service.resolveDraft(old.draftId);
    expect(
      await resolved.store.addContext({ id: "items/recovered.md", content: "# Recovered\n" }),
    ).toMatchObject({ ok: true });
    const draft = await service.getDraft(old.draftId);
    await service.submitDraft(draft.id, draft.revision, "Recovered changes");
    expect((await service.get(active.id)).state).toBe("pending_review");
    expect((await service.get(oldId)).state).toBe("needs_attention");
  });

  it("rejects a different explicit draft inside the Mission claim lock", async () => {
    const { service, store } = await fixture();
    const drafts = await Promise.all(
      ["First", "Second"].map((name) => service.createDraft({ storeId: store.id, name })),
    );
    const missionId = "22222222-2222-4222-8222-222222222250";
    const request = {
      schemaVersion: "pragma.context-store-revision-request/v2" as const,
      operation: "revise" as const,
      storeId: store.id,
      prompt: "Continue",
      source: "user" as const,
    };
    const results = await Promise.allSettled(
      drafts.map((draft) => service.startForMission({ request, missionId, draftId: draft.id })),
    );
    const accepted = results.filter((result) => result.status === "fulfilled");
    expect(accepted).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: {
        code: "invalid_state",
        message: "A different draft is already active for this Mission target.",
      },
    });
    const job = accepted[0]!.value;
    await service.completeMissionClaimMount({
      missionId,
      storeId: store.id,
      jobId: job.id,
      draftId: job.draftId,
    });
    const other = drafts.find((draft) => draft.id !== job.draftId)!;
    await expect(
      service.startForMission({ request, missionId, draftId: other.id }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    expect((await service.getDraft(other.id)).activeMissionId).toBeUndefined();
  });

  it("serializes concurrent changed-input starts to one Mission claim", async () => {
    const { service, store } = await fixture();
    const missionId = "22222222-2222-4222-8222-222222222232";
    const start = (prompt: string) =>
      service.startForMission({
        missionId,
        request: {
          schemaVersion: "pragma.context-store-revision-request/v2",
          operation: "revise" as const,
          storeId: store.id,
          prompt,
          source: "user",
        },
      });

    const [first, second] = await Promise.all([start("First prompt"), start("Second prompt")]);
    expect(second).toMatchObject({ id: first.id, draftId: first.draftId, missionId });
    await expect(service.list({ storeId: store.id })).resolves.toEqual([
      expect.objectContaining({ id: first.id }),
    ]);
    await expect(service.listDrafts({ storeId: store.id })).resolves.toEqual([
      expect.objectContaining({ id: first.draftId, activeMissionId: missionId }),
    ]);
  });

  it("serializes two Mission claims that continue the same draft", async () => {
    const { service, store } = await fixture();
    const draft = await service.createDraft({ storeId: store.id, name: "Continue me" });
    const start = (missionId: string, prompt: string) =>
      service.startForMission({
        missionId,
        draftId: draft.id,
        request: {
          schemaVersion: "pragma.context-store-revision-request/v2",
          operation: "revise" as const,
          storeId: store.id,
          prompt,
          source: "user",
        },
      });

    const [first, second] = await Promise.all([
      start("22222222-2222-4222-8222-222222222234", "First Mission"),
      start("22222222-2222-4222-8222-222222222235", "Second Mission"),
    ]);

    expect(second).toMatchObject({ id: first.id, draftId: draft.id, missionId: first.missionId });
    await expect(service.list({ storeId: store.id })).resolves.toEqual([
      expect.objectContaining({ id: first.id, draftId: draft.id }),
    ]);
  });

  it("keeps unreadable linked Missions isolated to their individual draft records", async () => {
    const missionId = "22222222-2222-4222-8222-222222222233";
    const { service, store } = await fixture({
      isMissionAvailable: async (candidate) => {
        if (candidate === missionId) throw new Error("Mission storage is temporarily unreadable.");
        return true;
      },
    });
    const claimed = await service.start({
      schemaVersion: "pragma.context-store-revision-request/v2",
      operation: "revise" as const,
      storeId: store.id,
      prompt: "Keep the draft available for direct recovery",
      source: "user",
    });
    await service.attachMission(claimed.id, missionId);
    const healthy = await service.createDraft({ storeId: store.id, name: "Healthy" });

    await expect(service.list()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: claimed.id })]),
    );
    await expect(service.listDraftsWithRecovery()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          draft: expect.objectContaining({ id: claimed.draftId }),
          recovery: expect.objectContaining({ code: "mission_unreadable" }),
        }),
        expect.objectContaining({ draft: expect.objectContaining({ id: healthy.id }) }),
      ]),
    );
  });

  it("continues listing healthy drafts when one draft record is malformed", async () => {
    const { draftsPath, service, store } = await fixture();
    const healthy = await service.createDraft({ storeId: store.id, name: "Healthy" });
    await mkdir(join(draftsPath, "broken"), { recursive: true });
    await writeFile(join(draftsPath, "broken", "draft.json"), "{invalid");

    await expect(service.listDrafts()).resolves.toEqual([
      expect.objectContaining({ id: healthy.id }),
    ]);
  });

  it("fails closed when a malformed draft prevents checking Store deletion references", async () => {
    const { draftsPath, service, store } = await fixture();
    await mkdir(join(draftsPath, "broken"), { recursive: true });
    await writeFile(join(draftsPath, "broken", "draft.json"), "{invalid");

    await expect(service.hasActiveJobs(store.id)).resolves.toBe(true);
  });

  it("reconciles a terminal Mission claim after its first detach attempt is interrupted", async () => {
    let detachAttempts = 0;
    const onRevisionDetached = vi.fn(async () => {
      detachAttempts += 1;
      if (detachAttempts === 1) throw new Error("Interrupted before restoring the Mission mount.");
    });
    const { service, store } = await fixture({ onRevisionDetached });
    const job = await service.start({
      schemaVersion: "pragma.context-store-revision-request/v2",
      operation: "revise" as const,
      storeId: store.id,
      prompt: "Recover the rejected Mission claim",
      source: "user",
    });
    const missionId = "22222222-2222-4222-8222-222222222241";
    await service.attachMission(job.id, missionId);
    const resolved = await service.resolveDraft(job.draftId);
    await resolved.store.addContext({ id: "items/rejected.md", content: "Review me" });
    const edited = await service.getDraft(job.draftId);
    await service.submitDraft(job.draftId, edited.revision, "Ready for rejection");
    const rejected = await service.reject(job.id, (await service.get(job.id)).revision);
    expect(rejected).toMatchObject({ state: "rejected", missionId });

    await service.processPending();

    const recovered = await service.get(job.id);
    expect(recovered.state).toBe("rejected");
    expect(recovered.missionId).toBeUndefined();
    expect(onRevisionDetached).toHaveBeenCalledTimes(2);
  });

  it("does not revive submitted or terminal revisions when attaching a Mission", async () => {
    const { service, store } = await fixture();
    const job = await service.start({
      schemaVersion: "pragma.context-store-revision-request/v2",
      operation: "revise" as const,
      storeId: store.id,
      prompt: "Submit before an invalid attach",
      source: "user",
    });
    const resolved = await service.resolveDraft(job.draftId);
    await resolved.store.addContext({ id: "items/review.md", content: "Ready" });
    const edited = await service.getDraft(job.draftId);
    await service.submitDraft(job.draftId, edited.revision, "Ready for review");

    await expect(
      service.attachMission(job.id, "22222222-2222-4222-8222-222222222225"),
    ).rejects.toThrow("Only editable knowledge revisions can be attached");
    const unchanged = await service.get(job.id);
    expect(unchanged.state).toBe("pending_review");
    expect(unchanged.missionId).toBeUndefined();
  });

  it("discards a submitted draft, rejects its revision job, and detaches its Mission", async () => {
    const onRevisionDetached = vi.fn(async () => undefined);
    const { service, store } = await fixture({ onRevisionDetached });
    const job = await service.start({
      schemaVersion: "pragma.context-store-revision-request/v2",
      operation: "revise" as const,
      storeId: store.id,
      prompt: "Replace an obsolete submitted draft",
      source: "user",
    });
    const missionId = "22222222-2222-4222-8222-222222222227";
    await service.attachMission(job.id, missionId);
    const resolved = await service.resolveDraft(job.draftId);
    await resolved.store.addContext({ id: "items/replacement.md", content: "Ready" });
    const edited = await service.getDraft(job.draftId);
    const submitted = await service.submitDraft(job.draftId, edited.revision, "Ready for review");

    await expect(service.discardDraft(submitted.id, submitted.revision - 1)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    await service.discardDraft(submitted.id, submitted.revision);

    await expect(service.getDraft(submitted.id)).rejects.toMatchObject({
      code: "draft_not_found",
    });
    const rejected = await service.get(job.id);
    expect(rejected).toMatchObject({
      state: "rejected",
      error: { code: "draft_discarded" },
    });
    expect(rejected.missionId).toBeUndefined();
    expect(onRevisionDetached).toHaveBeenCalledWith({
      missionId,
      jobId: job.id,
      draftId: job.draftId,
      storeId: store.id,
    });
  });

  it("rejects and detaches every revision job associated with a discarded draft", async () => {
    const onRevisionDetached = vi.fn(async () => undefined);
    const { service, store } = await fixture({ onRevisionDetached });
    const first = await service.start({
      schemaVersion: "pragma.context-store-revision-request/v2",
      operation: "revise" as const,
      storeId: store.id,
      prompt: "First revision attempt",
      source: "user",
    });
    const firstStore = await service.resolveDraft(first.draftId);
    await firstStore.store.addContext({ id: "items/shared.md", content: "First" });
    const firstEdited = await service.getDraft(first.draftId);
    await service.submitDraft(first.draftId, firstEdited.revision, "First attempt");
    const firstPending = await service.get(first.id);
    await service.reject(first.id, firstPending.revision);

    const second = await service.start(
      {
        schemaVersion: "pragma.context-store-revision-request/v2",
        operation: "revise" as const,
        storeId: store.id,
        prompt: "Second revision attempt",
        source: "user",
      },
      { draftId: first.draftId },
    );
    const missionId = "22222222-2222-4222-8222-222222222228";
    await service.attachMission(second.id, missionId);
    const current = await service.getDraft(first.draftId);

    await service.discardDraft(current.id, current.revision);

    await expect(service.get(first.id)).resolves.toMatchObject({ state: "rejected" });
    const rejectedSecond = await service.get(second.id);
    expect(rejectedSecond).toMatchObject({
      state: "rejected",
      error: { code: "draft_discarded" },
    });
    expect(rejectedSecond.missionId).toBeUndefined();
    expect(onRevisionDetached).toHaveBeenCalledWith({
      missionId,
      jobId: second.id,
      draftId: first.draftId,
      storeId: store.id,
    });
  });

  it("retains merged drafts as revision history", async () => {
    const { service, store } = await fixture();
    const job = await service.start({
      schemaVersion: "pragma.context-store-revision-request/v2",
      operation: "revise" as const,
      storeId: store.id,
      prompt: "Keep merged history",
      source: "user",
    });
    const resolved = await service.resolveDraft(job.draftId);
    await resolved.store.addContext({ id: "items/history.md", content: "Keep" });
    const edited = await service.getDraft(job.draftId);
    await service.submitDraft(job.draftId, edited.revision, "Ready for approval");
    const pending = await service.get(job.id);
    await service.approve(job.id, pending.revision);
    const merged = await service.getDraft(job.draftId);

    await expect(service.discardDraft(merged.id, merged.revision)).rejects.toMatchObject({
      code: "invalid_state",
      message: "Merged drafts are retained as revision history.",
    });
    await expect(service.getDraft(merged.id)).resolves.toMatchObject({ state: "merged" });
  });

  it("merges list and search results, persists tombstones, and recovers after restart", async () => {
    const { directory, draftsPath, service, contextStores, store } = await fixture();
    await contextStores.createFile(store.id, "items/base.md", "# Base searchable phrase\n");
    await contextStores.createFile(store.id, "items/delete.md", "# Remove me\n");
    const draft = await service.createDraft({ storeId: store.id, name: "Overlay routing" });
    const resolved = await service.resolveDraft(draft.id);
    const removed = await resolved.store.readContext({ id: "items/delete.md" });
    if (!removed.ok) throw new Error(removed.error.message);
    await expect(resolved.store.deleteContext({ id: "items/delete.md" })).resolves.toMatchObject({
      ok: true,
      value: {
        effect: "item_deleted",
        message: expect.stringContaining("deletedFiles"),
      },
    });
    await resolved.store.addContext({ id: "items/new.md", content: "# New searchable phrase\n" });
    await expect(resolved.store.deleteContext({ id: "items/new.md" })).resolves.toMatchObject({
      ok: true,
      value: {
        effect: "local_change_removed",
        message: expect.stringContaining("matches the baseline"),
      },
    });
    await resolved.store.addContext({ id: "items/new.md", content: "# New searchable phrase\n" });

    const restarted = createContextStoreRevisionService({
      statePath: join(directory, "state", "context-store-revisions"),
      draftsPath,
      contextStores,
      generator: {
        async generate() {
          return undefined;
        },
      },
    });
    const recovered = (await restarted.resolveDraft(draft.id)).store;
    const listed = await recovered.listContext();
    expect(listed).toMatchObject({
      ok: true,
      value: [
        expect.objectContaining({ id: "items/base.md" }),
        expect.objectContaining({ id: "items/new.md" }),
      ],
    });
    await expect(recovered.readContext({ id: "items/delete.md" })).resolves.toMatchObject({
      ok: false,
      error: { code: "context_not_found" },
    });
    const matches = await recovered.searchContext({ query: "searchable phrase" });
    expect(matches).toMatchObject({ ok: true });
    if (!matches.ok) throw new Error(matches.error.message);
    expect(matches.value.map((match) => match.id).toSorted()).toEqual([
      "items/base.md",
      "items/new.md",
    ]);
    const persisted = JSON.parse(
      await readFile(join(draftsPath, draft.id, "draft.json"), "utf8"),
    ) as {
      overlay: { deletedFiles: string[]; files: { id: string }[] };
    };
    expect(persisted.overlay.deletedFiles).toEqual(["items/delete.md"]);
    expect(persisted.overlay.files).toEqual([expect.objectContaining({ id: "items/new.md" })]);
  });

  it("requires an explicit rebase after the formal store advances", async () => {
    const { service, contextStores, store } = await fixture();
    const job = await service.submit({
      schemaVersion: "pragma.context-store-revision-request/v2",
      operation: "revise" as const,
      storeId: store.id,
      prompt: "Add retry guidance",
      source: "user",
    });
    await service.processPending();
    const staged = await service.get(job.id);
    await contextStores.createFile(store.id, "user-note.md", "# User note\n");

    const stale = await service.approve(staged.id, staged.revision);
    expect(stale.state).toBe("needs_rebase");
    const draft = await service.getDraft(stale.draftId);
    const inspection = await service.inspectRebase(draft.id);
    expect(inspection.conflicts).toEqual([]);
    const revisionLock = vi.spyOn(contextStores, "withRevisionLock");
    const rebased = await service.rebase({
      draftId: draft.id,
      expectedRevision: draft.revision,
      resolutions: [],
    });
    expect(rebased).toMatchObject({ state: "editing", baseRevision: 2 });
    expect(revisionLock).toHaveBeenCalledWith(store.id, expect.any(Function));
  });

  it("deletes revision task records in every lifecycle state", async () => {
    const { directory, service, store } = await fixture();
    const jobsPath = join(directory, "state", "context-store-revisions", "jobs");
    const states = [
      "editing",
      "running",
      "pending_review",
      "merging",
      "merged",
      "rejected",
      "needs_rebase",
      "needs_attention",
    ] as const;

    for (const state of states) {
      const job = await service.start({
        schemaVersion: "pragma.context-store-revision-request/v2",
        operation: "revise" as const,
        storeId: store.id,
        prompt: `Delete ${state}`,
        source: "user",
      });
      await writeFile(join(jobsPath, `${job.id}.json`), `${JSON.stringify({ ...job, state })}\n`);

      await expect(service.delete(job.id, job.revision)).resolves.toBeUndefined();
    }

    await expect(service.list()).resolves.toEqual([]);
  });

  it("resolves same-path rebase conflicts and rechecks CAS at approval", async () => {
    const { service, contextStores, store } = await fixture();
    const base = await contextStores.createFile(store.id, "items/shared.md", "# Base\n");
    const job = await service.start(
      {
        schemaVersion: "pragma.context-store-revision-request/v2",
        operation: "revise" as const,
        storeId: store.id,
        prompt: "Revise shared guidance",
        source: "user",
      },
      { draftName: "Shared guidance" },
    );
    const draftStore = (await service.resolveDraft(job.draftId)).store;
    const draftBase = await draftStore.readContext({ id: "items/shared.md" });
    if (!draftBase.ok) throw new Error(draftBase.error.message);
    const draftEdit = await draftStore.editContext({
      id: "items/shared.md",
      mode: "replace",
      content: "# Draft\n",
      expectedRevision: draftBase.value.revision,
    });
    expect(draftEdit).toMatchObject({ ok: true });
    let draft = await service.getDraft(job.draftId);
    draft = await service.submitDraft(draft.id, draft.revision, "Revise shared guidance");
    await contextStores.updateFile(
      store.id,
      "items/shared.md",
      "# Published\n",
      base.metadata,
      base.revision!,
    );
    const stale = await service.approve(job.id, (await service.get(job.id)).revision);
    expect(stale.state).toBe("needs_rebase");
    draft = await service.getDraft(draft.id);
    const inspection = await service.inspectRebase(draft.id);
    expect(inspection.conflicts).toEqual([
      expect.objectContaining({ id: "items/shared.md", kind: "modified" }),
    ]);
    draft = await service.rebase({
      draftId: draft.id,
      expectedRevision: draft.revision,
      resolutions: [{ id: "items/shared.md", resolution: "keep_draft" }],
    });
    await service.submitDraft(draft.id, draft.revision, "Keep the draft wording");
    const current = await contextStores.getContent(store.id, "items/shared.md");
    await contextStores.updateFile(
      store.id,
      "items/shared.md",
      "# Published again\n",
      current.metadata,
      current.revision!,
    );
    await expect(
      service.approve(job.id, (await service.get(job.id)).revision),
    ).resolves.toMatchObject({ state: "needs_rebase" });
  });

  it("migrates a real v1 pending-review fixture to a sparse draft with backup", async () => {
    const { directory, service, store } = await fixture();
    const source = JSON.parse(
      await readFile(
        join(import.meta.dirname, "fixtures", "context-store-revision-job-v1.json"),
        "utf8",
      ),
    ) as {
      id: string;
      request: { storeId: string };
      changeSet: { storeId: string };
    };
    source.request.storeId = store.id;
    source.changeSet.storeId = store.id;
    const statePath = join(directory, "state", "context-store-revisions");
    await mkdir(join(statePath, "jobs"), { recursive: true });
    await mkdir(join(statePath, "migrations"), { recursive: true });
    const replayDraftId = "33333333-3333-4333-8333-333333333333";
    await writeFile(
      join(statePath, "migrations", `${source.id}.v1-to-v2.json`),
      `${JSON.stringify({
        schemaVersion: "pragma.context-store-revision-v1-to-v2/v1",
        draftId: replayDraftId,
      })}\n`,
    );
    await writeFile(join(statePath, "jobs", `${source.id}.json`), `${JSON.stringify(source)}\n`);

    const [migrated] = await service.list();
    expect(migrated).toMatchObject({
      schemaVersion: "pragma.context-store-revision-job/v3",
      id: source.id,
      revision: 6,
      state: "pending_review",
      draftId: replayDraftId,
    });
    const draft = await service.getDraft(migrated!.draftId);
    expect(draft).toMatchObject({
      state: "pending_review",
      overlay: { files: [expect.objectContaining({ id: "items/approval.md" })] },
    });
    await expect(
      readFile(join(statePath, "migration-backups", `${source.id}.v1.json`), "utf8"),
    ).resolves.toContain('"pragma.context-store-revision-job/v1"');
    await expect(
      readFile(join(statePath, "migrations", `${source.id}.v1-to-v2.json`), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates a v1 applying job into the recoverable merging state", async () => {
    const { directory, service, contextStores, store } = await fixture();
    const source = JSON.parse(
      await readFile(
        join(import.meta.dirname, "fixtures", "context-store-revision-job-v1.json"),
        "utf8",
      ),
    ) as {
      id: string;
      state: string;
      request: { storeId: string };
      changeSet: { storeId: string };
    };
    source.state = "applying";
    source.request.storeId = store.id;
    source.changeSet.storeId = store.id;
    const statePath = join(directory, "state", "context-store-revisions");
    await mkdir(join(statePath, "jobs"), { recursive: true });
    await writeFile(join(statePath, "jobs", `${source.id}.json`), `${JSON.stringify(source)}\n`);

    const [migrated] = await service.list();
    expect(migrated).toMatchObject({ state: "merging" });
    await expect(service.getDraft(migrated!.draftId)).resolves.toMatchObject({
      state: "merging",
      submittedRevision: 1,
    });

    await service.processPending();

    await expect(service.get(source.id)).resolves.toMatchObject({ state: "merged" });
    await expect(contextStores.getContent(store.id, "items/approval.md")).resolves.toMatchObject({
      content: "# Approval\n\nRequire an explicit reviewer.\n",
    });
  });

  it("replays an interrupted merging job through the existing Store journal transaction", async () => {
    const onRevisionDetached = vi.fn(async () => undefined);
    const { directory, service, contextStores, store } = await fixture({ onRevisionDetached });
    const job = await service.submit({
      schemaVersion: "pragma.context-store-revision-request/v2",
      operation: "revise" as const,
      storeId: store.id,
      prompt: "Recover merge",
      source: "user",
    });
    await service.processPending();
    const pending = await service.get(job.id);
    const jobPath = join(directory, "state", "context-store-revisions", "jobs", `${job.id}.json`);
    const missionId = "22222222-2222-4222-8222-222222222224";
    await writeFile(jobPath, `${JSON.stringify({ ...pending, state: "merging", missionId })}\n`);

    await service.processPending();

    const recovered = await service.get(job.id);
    expect(recovered.state).toBe("merged");
    expect(recovered.missionId).toBeUndefined();
    await expect(contextStores.getContent(store.id, "items/revised.md")).resolves.toMatchObject({
      content: "# Recover merge\n",
    });
    expect(onRevisionDetached).toHaveBeenCalledWith({
      missionId,
      jobId: job.id,
      draftId: pending.draftId,
      storeId: store.id,
    });
  });

  it("keeps file etags stable across repeated overlay edits and rejects stale writes", async () => {
    const { service, contextStores, store } = await fixture();
    await contextStores.createFile(store.id, "items/base.md", "# Base\n");
    const draft = await service.createDraft({ storeId: store.id, name: "CAS" });
    const firstStore = (await service.resolveDraft(draft.id)).store;
    const first = await firstStore.readContext({ id: "items/base.md" });
    if (!first.ok) throw new Error(first.error.message);
    const edited = await firstStore.editContext({
      id: "items/base.md",
      mode: "replace",
      content: "# First\n",
      expectedRevision: first.value.revision,
    });
    if (!edited.ok) throw new Error(edited.error.message);
    await expect(
      firstStore.editContext({
        id: "items/base.md",
        mode: "replace",
        content: "# Second\n",
        expectedRevision: edited.value.revision,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      firstStore.editContext({
        id: "items/base.md",
        mode: "replace",
        content: "# Stale\n",
        expectedRevision: first.value.revision,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "context_conflict" } });
  });
});
