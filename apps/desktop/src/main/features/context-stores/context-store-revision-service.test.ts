import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createContextStoreRevisionService,
  type ContextStoreRevisionExecutor,
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
    readonly executor?: ContextStoreRevisionExecutor | undefined;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "pragma-store-revisions-"));
  directories.push(directory);
  const contextStores = createContextStoreStore({
    storesPath: join(directory, "data", "context-stores"),
  });
  const draftsPath = join(directory, "data", "context-store-drafts");
  const serviceRef: { current?: ContextStoreRevisionService } = {};
  const executor: ContextStoreRevisionExecutor = options.executor ?? {
    async execute({ draftId, request }) {
      const service = serviceRef.current;
      if (service === undefined) throw new Error("Revision service is not initialized.");
      const resolved = await service.resolveDraft(draftId);
      const added = await resolved.store.addContext({
        id: "items/revised.md",
        content: `# ${request.prompt}\n`,
        metadata: { description: "Revised", trigger: "manual", priority: "normal" },
      });
      if (!added.ok) throw new Error(added.error.message);
      const draft = await service.getDraft(draftId);
      await service.submitDraft(draftId, draft.revision, request.prompt);
    },
  };
  const service = createContextStoreRevisionService({
    statePath: join(directory, "state", "context-store-revisions"),
    draftsPath,
    contextStores,
    executor,
    onRevisionDetached: options.onRevisionDetached,
  });
  serviceRef.current = service;
  const store = await contextStores.create({ mode: "blank", name: "Knowledge", description: "" });
  return { directory, draftsPath, contextStores, service, store };
}

describe("context store sparse draft revisions", () => {
  it("keeps an intentionally unsubmitted Agent draft editable and attached", async () => {
    const missionId = "22222222-2222-4222-8222-222222222226";
    const serviceRef: { current?: ContextStoreRevisionService } = {};
    const execute = vi.fn<ContextStoreRevisionExecutor["execute"]>(async (input) => {
      if (serviceRef.current === undefined) throw new Error("revision_service_unavailable");
      await serviceRef.current.attachMission(input.jobId, missionId);
      const resolved = await serviceRef.current.resolveDraft(input.draftId);
      await resolved.store.addContext({ id: "items/review-first.md", content: "# Review first\n" });
    });
    const fixtureResult = await fixture({ executor: { execute } });
    serviceRef.current = fixtureResult.service;
    const activeService = serviceRef.current;
    const job = await activeService.start({
      schemaVersion: "pragma.context-store-revision-request/v1",
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
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("releases stale Mission ownership before retrying a failed task", async () => {
    const missionId = "22222222-2222-4222-8222-222222222226";
    const serviceRef: { current?: ContextStoreRevisionService } = {};
    const { service, store } = await fixture({
      executor: {
        async execute(input) {
          if (serviceRef.current === undefined) throw new Error("revision_service_unavailable");
          await serviceRef.current.attachMission(input.jobId, missionId);
          throw new Error("mission failed");
        },
      },
    });
    serviceRef.current = service;
    const job = await service.start({
      schemaVersion: "pragma.context-store-revision-request/v1",
      storeId: store.id,
      prompt: "Retry after Mission failure",
      source: "user",
    });

    await service.processPending();
    const failed = await service.get(job.id);
    expect(failed).toMatchObject({ state: "needs_attention", missionId });
    await expect(service.getDraft(job.draftId)).resolves.toMatchObject({
      state: "editing",
      activeMissionId: missionId,
    });

    const retried = await service.retry(failed.id, failed.revision);
    expect(retried).toMatchObject({ state: "editing", missionId: undefined });
    const retryDraft = await service.getDraft(job.draftId);
    expect(retryDraft.state).toBe("editing");
    expect(retryDraft.activeMissionId).toBeUndefined();
  });

  it("deduplicates machine submissions and persists only an overlay before approval", async () => {
    const { draftsPath, contextStores, service, store } = await fixture();
    const request = {
      schemaVersion: "pragma.context-store-revision-request/v1" as const,
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
      baseSnapshotHash: draft.baseSnapshotHash,
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

  it("removes a rejected draft and retries from the current store", async () => {
    const { service, store } = await fixture();
    const job = await service.start(
      {
        schemaVersion: "pragma.context-store-revision-request/v1",
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
    await expect(service.getDraft(job.draftId)).rejects.toMatchObject({ code: "draft_not_found" });
    const rejectedJob = await service.get(job.id);
    const attempts = await Promise.allSettled([
      service.retry(rejectedJob.id, rejectedJob.revision),
      service.retry(rejectedJob.id, rejectedJob.revision),
    ]);
    expect(attempts.map((attempt) => attempt.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    const retried = attempts.find(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof service.retry>>> =>
        attempt.status === "fulfilled",
    )!.value;
    expect(retried.draftId).not.toBe(job.draftId);
    await expect(service.getDraft(retried.draftId)).resolves.toMatchObject({ state: "editing" });
    await expect(service.listDrafts({ storeId: store.id })).resolves.toHaveLength(1);
  });

  it("makes repeated Mission attachment idempotent", async () => {
    const { service, store } = await fixture();
    const job = await service.start({
      schemaVersion: "pragma.context-store-revision-request/v1",
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
      schemaVersion: "pragma.context-store-revision-request/v1",
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

  it("does not revive submitted or terminal revisions when attaching a Mission", async () => {
    const { service, store } = await fixture();
    const job = await service.start({
      schemaVersion: "pragma.context-store-revision-request/v1",
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
      schemaVersion: "pragma.context-store-revision-request/v1",
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

  it("rejects and detaches a discarded draft revision job", async () => {
    const onRevisionDetached = vi.fn(async () => undefined);
    const { service, store } = await fixture({ onRevisionDetached });
    const first = await service.start({
      schemaVersion: "pragma.context-store-revision-request/v1",
      storeId: store.id,
      prompt: "First revision attempt",
      source: "user",
    });
    const missionId = "22222222-2222-4222-8222-222222222228";
    await service.attachMission(first.id, missionId);
    const firstStore = await service.resolveDraft(first.draftId);
    await firstStore.store.addContext({ id: "items/shared.md", content: "First" });
    const firstEdited = await service.getDraft(first.draftId);
    await service.submitDraft(first.draftId, firstEdited.revision, "First attempt");
    const current = await service.getDraft(first.draftId);

    await service.discardDraft(current.id, current.revision);

    await expect(service.get(first.id)).resolves.toMatchObject({ state: "rejected" });
    const rejectedFirst = await service.get(first.id);
    expect(rejectedFirst).toMatchObject({
      state: "rejected",
      error: { code: "draft_discarded" },
    });
    expect(rejectedFirst.missionId).toBeUndefined();
    expect(onRevisionDetached).toHaveBeenCalledWith({
      missionId,
      jobId: first.id,
      draftId: first.draftId,
      storeId: store.id,
    });
  });

  it("keeps only the merged task record and removes its draft", async () => {
    const { service, store } = await fixture();
    const job = await service.start({
      schemaVersion: "pragma.context-store-revision-request/v1",
      storeId: store.id,
      prompt: "Keep merged summary",
      source: "user",
    });
    const resolved = await service.resolveDraft(job.draftId);
    await resolved.store.addContext({ id: "items/history.md", content: "Keep" });
    const edited = await service.getDraft(job.draftId);
    await service.submitDraft(job.draftId, edited.revision, "Ready for approval");
    const pending = await service.get(job.id);
    await service.approve(job.id, pending.revision);
    await expect(service.getDraft(job.draftId)).rejects.toMatchObject({ code: "draft_not_found" });
    await expect(service.get(job.id)).resolves.toMatchObject({
      state: "merged",
      request: { prompt: "Keep merged summary" },
    });
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
      executor: { async execute() {} },
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
      schemaVersion: "pragma.context-store-revision-request/v1",
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
    const mutationLock = vi.spyOn(contextStores, "withMutationLock");
    const rebased = await service.rebase({
      draftId: draft.id,
      expectedRevision: draft.revision,
      resolutions: [],
    });
    expect(rebased).toMatchObject({
      state: "editing",
      baseSnapshotHash: (await contextStores.getSnapshot(store.id)).snapshotHash,
    });
    expect(mutationLock).toHaveBeenCalledWith(store.id, expect.any(Function));
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
        schemaVersion: "pragma.context-store-revision-request/v1",
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
        schemaVersion: "pragma.context-store-revision-request/v1",
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
    const { directory, service, contextStores, store } = await fixture();
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

    const retainedBase = {
      ...(await contextStores.getSnapshot(store.id)),
      snapshotHash: "0".repeat(64),
    };
    const readLegacySnapshot = vi.fn(async () => retainedBase);
    await service.migrateLegacyStoreReferences(store.id, readLegacySnapshot);

    const [migrated] = await service.list();
    expect(migrated).toMatchObject({
      schemaVersion: "pragma.context-store-revision-job/v2",
      id: source.id,
      revision: 5,
      state: "pending_review",
      draftId: replayDraftId,
    });
    const draft = await service.getDraft(migrated!.draftId);
    expect(draft).toMatchObject({
      state: "pending_review",
      baseSnapshotHash: "0".repeat(64),
      overlay: { files: [expect.objectContaining({ id: "items/approval.md" })] },
    });
    expect(readLegacySnapshot).toHaveBeenCalledWith(1);
    await expect(
      readFile(join(statePath, "migration-backups", `${source.id}.v1.json`), "utf8"),
    ).resolves.toContain('"pragma.context-store-revision-job/v1"');
    await expect(
      readFile(join(statePath, "migrations", `${source.id}.v1-to-v2.json`), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("backs up a terminal v1 task without retaining a completed draft", async () => {
    const { directory, service, store } = await fixture();
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
    source.state = "completed";
    source.request.storeId = store.id;
    source.changeSet.storeId = store.id;
    const statePath = join(directory, "state", "context-store-revisions");
    await mkdir(join(statePath, "jobs"), { recursive: true });
    await writeFile(join(statePath, "jobs", `${source.id}.json`), `${JSON.stringify(source)}\n`);

    const [migrated] = await service.list();
    expect(migrated).toMatchObject({ id: source.id, state: "merged" });
    await expect(service.getDraft(migrated!.draftId)).rejects.toMatchObject({
      code: "draft_not_found",
    });
    await expect(
      readFile(join(statePath, "migration-backups", `${source.id}.v1.json`), "utf8"),
    ).resolves.toContain('"state": "completed"');
  });

  it("recovers an applied merge after an unrelated current-state edit", async () => {
    const { directory, draftsPath, contextStores, service, store } = await fixture();
    const started = await service.start({
      schemaVersion: "pragma.context-store-revision-request/v1",
      storeId: store.id,
      prompt: "Add recovery guidance",
      source: "user",
    });
    await service.processPending();
    const pending = await service.get(started.id);
    const draft = await service.getDraft(pending.draftId);
    const changeSet = await service.getDraftChangeSet(draft.id);
    await contextStores.applyChangeSet(changeSet);
    const applied = await contextStores.getSnapshot(store.id);
    await contextStores.createFile(store.id, "items/unrelated.md", "# Unrelated\n");

    const mergingRevision = draft.revision + 1;
    await writeFile(
      join(draftsPath, draft.id, "draft.json"),
      `${JSON.stringify({
        ...draft,
        revision: mergingRevision,
        state: "merging",
        submittedRevision: mergingRevision,
        mergeTargetSnapshotHash: applied.snapshotHash,
      })}\n`,
    );
    await writeFile(
      join(directory, "state", "context-store-revisions", "jobs", `${pending.id}.json`),
      `${JSON.stringify({ ...pending, revision: pending.revision + 1, state: "merging" })}\n`,
    );

    await service.processPending();

    await expect(service.get(pending.id)).resolves.toMatchObject({ state: "merged" });
    await expect(service.getDraft(draft.id)).rejects.toMatchObject({ code: "draft_not_found" });
    await expect(contextStores.getContent(store.id, "items/revised.md")).resolves.toBeDefined();
    await expect(contextStores.getContent(store.id, "items/unrelated.md")).resolves.toBeDefined();
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
      state: "pending_review",
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
      schemaVersion: "pragma.context-store-revision-request/v1",
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
