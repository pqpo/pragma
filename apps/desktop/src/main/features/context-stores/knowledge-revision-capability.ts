import { createHash } from "node:crypto";

import {
  KnowledgeRevisionDraftFileSchema,
  KnowledgeRevisionToolError,
  KnowledgeRevisionDraftInspectionSchema,
  KnowledgeRevisionDraftSummarySchema,
  KnowledgeRevisionDraftReceiptSchema,
  KnowledgeRevisionConflictPageSchema,
  KnowledgeRevisionConflictContentSchema,
  PragmaContentChunkSchema,
} from "@pragma/built-in-agents";
import type {
  ContextStoreDraft,
  ContextStoreRevisionJob,
  KnowledgeRevisionSubmissionPort,
  KnowledgeRevisionTarget,
  KnowledgeRevisionToolInvocation,
} from "@pragma/built-in-agents";
import {
  canonicalPragmaResourceRef,
  type PragmaExpertResource,
  type PragmaExpertTeamResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";

import {
  classifyDesktopContextResource,
  createDesktopContextResource,
} from "../../platform/bindings/desktop-bound-resource-policy.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { ContextStoreRevisionService } from "./context-store-revision-service.ts";
import { ContextStoreStoreError, type ContextStoreStore } from "./context-store-store.ts";
import { paginateManagementItems } from "../built-in-agents/management-pagination.ts";
import { reservedRevisionResourceId } from "../built-in-agents/revision-resource-id.ts";

export function createDesktopKnowledgeRevisionSubmissionPort(options: {
  readonly project: PragmaProjectStore;
  readonly contextStores: ContextStoreStore;
  readonly revisions: ContextStoreRevisionService;
  readonly additionalMountResources?: (() => readonly PragmaResource[]) | undefined;
  readonly continueMission?:
    | ((input: {
        readonly missionId: string;
        readonly jobId: string;
        readonly draftId: string;
        readonly prompt: string;
        readonly requestId: string;
      }) => Promise<void>)
    | undefined;
  readonly inlineMission?:
    | {
        readonly id: string;
        readonly assertOwnership?: (
          job: ContextStoreRevisionJob,
          input: KnowledgeRevisionToolInvocation,
        ) => Promise<void>;
        readonly activeRevisionJobIdForStore: (storeId: string) => Promise<string | undefined>;
        readonly writableNamespaceForStore: (storeId: string) => string;
        readonly mountDraft: (input: {
          readonly storeId: string;
          readonly draftId: string;
          readonly revisionJobId: string;
          readonly previousMissionId?: string | undefined;
        }) => Promise<{ readonly writableNamespace: string }>;
      }
    | undefined;
}): KnowledgeRevisionSubmissionPort {
  const targets = async (): Promise<readonly ResolvedTarget[]> => {
    const [stores, project] = await Promise.all([
      options.contextStores.list(),
      options.project.get(),
    ]);
    const mounts = collectMounts([
      ...project.resources,
      ...(options.additionalMountResources?.() ?? []),
    ]);

    return stores
      .map((store): ResolvedTarget => {
        const targetRef = canonicalPragmaResourceRef(
          createDesktopContextResource({ owner: "project-expert", storeId: store.id }),
        );
        const targetMounts = mounts.get(store.id) ?? [];
        return {
          storeId: store.id,
          target: {
            targetRef,
            name: store.name,
            description: store.description,
            revision: store.contentRevision,
            mounted: targetMounts.length > 0,
            mounts: targetMounts,
          },
        };
      })
      .toSorted(
        (left, right) =>
          left.target.name.localeCompare(right.target.name) ||
          left.target.targetRef.localeCompare(right.target.targetRef),
      );
  };

  const assertDraftOwnership = async (
    input: KnowledgeRevisionToolInvocation & { readonly draftId: string },
  ) => {
    if (options.inlineMission?.assertOwnership === undefined) return;
    const draft = await options.revisions.getDraft(input.draftId);
    if (draft.activeMissionId === undefined) return;
    if (draft.activeMissionId !== options.inlineMission.id) {
      throw new KnowledgeRevisionToolError(
        "revision_conflict",
        "knowledge_revision_owned_by_another_mission",
        false,
      );
    }
    const jobId = await options.inlineMission.activeRevisionJobIdForStore(draft.storeId);
    if (jobId === undefined) {
      throw new KnowledgeRevisionToolError(
        "unavailable",
        "knowledge_revision_owner_unavailable",
        false,
      );
    }
    const job = await options.revisions.get(jobId);
    if (job.draftId !== draft.id || job.missionId !== options.inlineMission.id) {
      throw new KnowledgeRevisionToolError(
        "revision_conflict",
        "knowledge_revision_owner_mismatch",
        false,
      );
    }
    await options.inlineMission.assertOwnership(job, input);
  };

  return {
    async listTargets(input) {
      const query = input.query?.toLocaleLowerCase();
      const items = (await targets())
        .map((target) => target.target)
        .filter(
          (target) =>
            (input.mounted === undefined || target.mounted === input.mounted) &&
            (query === undefined ||
              [target.targetRef, target.name, target.description].some((value) =>
                value.toLocaleLowerCase().includes(query),
              )),
        );
      return paginateManagementItems({
        items,
        scope: "knowledge_revision_list_targets",
        fingerprintValue: items,
        filters: { mounted: input.mounted, query },
        cursor: input.cursor,
        limit: input.limit,
      });
    },
    async listDrafts(input) {
      const inlineMission = options.inlineMission;
      const selectedStoreId =
        input.targetRef === undefined
          ? undefined
          : (await targets()).find((candidate) => candidate.target.targetRef === input.targetRef)
              ?.storeId;
      if (input.targetRef !== undefined && selectedStoreId === undefined) {
        throw new KnowledgeRevisionToolError(
          "not_found",
          "knowledge_revision_target_unavailable",
          false,
        );
      }
      const drafts = await options.revisions.listDraftsWithRecovery(
        selectedStoreId === undefined ? {} : { storeId: selectedStoreId },
      );
      const states = input.states === undefined ? undefined : new Set(input.states);
      const query = input.query?.toLocaleLowerCase();
      const items = drafts
        .map(({ draft, recovery }) =>
          KnowledgeRevisionDraftSummarySchema.parse({
            draftId: draft.id,
            revision: draft.revision,
            name: draft.name,
            storeId: draft.storeId,
            baseRevision: draft.baseRevision,
            operation: draft.operation,
            ...(draft.resourceName === undefined ? {} : { resourceName: draft.resourceName }),
            ...(draft.resourceDescription === undefined
              ? {}
              : { resourceDescription: draft.resourceDescription }),
            state: draft.state,
            ...(draft.activeMissionId === undefined
              ? {}
              : { activeMissionId: draft.activeMissionId }),
            ...(recovery === undefined ? {} : { recovery }),
            ...(inlineMission !== undefined && draft.activeMissionId === inlineMission.id
              ? { writableNamespace: inlineMission.writableNamespaceForStore(draft.storeId) }
              : {}),
            ...(draft.submittedRevision === undefined
              ? {}
              : { submittedRevision: draft.submittedRevision }),
            ...(draft.summary === undefined ? {} : { summary: draft.summary }),
            createdAt: draft.createdAt,
            updatedAt: draft.updatedAt,
          }),
        )
        .filter(
          (draft) =>
            (states === undefined || states.has(draft.state)) &&
            (query === undefined ||
              [draft.draftId, draft.name, draft.summary ?? ""].some((value) =>
                value.toLocaleLowerCase().includes(query),
              )),
        );
      return paginateManagementItems({
        items,
        scope: "knowledge_revision_list_drafts",
        fingerprintValue: items.map(({ draftId, revision }) => [draftId, revision]),
        filters: { targetRef: input.targetRef, states: input.states, query },
        cursor: input.cursor,
        limit: input.limit,
      });
    },
    async start(input) {
      const inlineMission = options.inlineMission;
      const continuedDraft =
        input.draftId === undefined ? undefined : await options.revisions.getDraft(input.draftId);
      const allTargets = await targets();
      const selected =
        input.targetRef !== undefined
          ? allTargets.find((candidate) => candidate.target.targetRef === input.targetRef)
          : continuedDraft?.operation === "revise"
            ? allTargets.find((candidate) => candidate.storeId === continuedDraft.storeId)
            : undefined;
      if (input.targetRef !== undefined && selected === undefined) {
        throw new KnowledgeRevisionToolError(
          "not_found",
          "knowledge_revision_target_unavailable",
          false,
        );
      }
      if (
        continuedDraft !== undefined &&
        selected !== undefined &&
        (continuedDraft.operation === "create" || selected.storeId !== continuedDraft.storeId)
      ) {
        throw new KnowledgeRevisionToolError(
          "revision_conflict",
          "knowledge_revision_target_draft_mismatch",
          false,
        );
      }
      const storeId =
        input.create !== undefined
          ? reservedRevisionResourceId("context-store", input)
          : (continuedDraft?.storeId ?? selected!.storeId);
      const operation: "create" | "revise" =
        input.create !== undefined || continuedDraft?.operation === "create" ? "create" : "revise";
      const creation =
        input.create ??
        (continuedDraft?.operation === "create"
          ? {
              name: continuedDraft.resourceName!,
              description: continuedDraft.resourceDescription!,
            }
          : undefined);
      const sourceDigest = digestSubmission(input, storeId, input.prompt, input.draftId);
      const request = {
        schemaVersion: "pragma.context-store-revision-request/v2" as const,
        operation,
        storeId,
        ...(creation === undefined
          ? {}
          : { resourceName: creation.name, resourceDescription: creation.description }),
        prompt: input.prompt,
        source: "expert-reflection" as const,
        sourceDigest,
        provenance: {
          executionId: input.executionId,
          invocationId: input.invocationId,
          expertId: input.expertId,
          ...(input.teamId === undefined ? {} : { teamId: input.teamId }),
        },
      };
      if (inlineMission === undefined) {
        if (input.draftId !== undefined) {
          const { recovery } = await options.revisions.getDraftWithRecovery(input.draftId);
          if (recovery?.code === "mission_unreadable") {
            throw new KnowledgeRevisionToolError("unavailable", recovery.message, false);
          }
        }
        const job = await options.revisions.start(request, {
          ...(input.draftId === undefined ? {} : { draftId: input.draftId }),
          ...(input.draftName === undefined ? {} : { draftName: input.draftName }),
        });
        if (input.draftId !== undefined && job.request.sourceDigest !== sourceDigest) {
          if (job.missionId === undefined) {
            if (!["editing", "running"].includes(job.state)) {
              throw new KnowledgeRevisionToolError(
                "unavailable",
                "The revision task is not editable. Inspect its state and finish review or recovery before continuing.",
                false,
              );
            }
            throw new KnowledgeRevisionToolError(
              "already_attached",
              "This draft already has a task awaiting its Mission. Wait for that task to start before sending another request.",
              false,
            );
          }
          if (options.continueMission === undefined) {
            throw new KnowledgeRevisionToolError(
              "unavailable",
              "knowledge_revision_mission_continuation_unavailable",
              false,
            );
          }
          // One durable Mission prompt per tool operation, including retries after uncertain delivery.
          const requestId = `${sourceDigest.slice(0, 8)}-${sourceDigest.slice(8, 12)}-4${sourceDigest.slice(13, 16)}-8${sourceDigest.slice(17, 20)}-${sourceDigest.slice(20, 32)}`;
          await options.continueMission({
            missionId: job.missionId,
            jobId: job.id,
            draftId: job.draftId,
            prompt: input.prompt,
            requestId,
          });
        } else if (["editing", "running"].includes(job.state)) {
          options.revisions.scheduleProcessing();
        } else if (job.state === "needs_attention") {
          throw new KnowledgeRevisionToolError(
            "unavailable",
            "The revision task needs attention. Inspect its Mission and recover the task before retrying.",
            false,
          );
        }

        return {
          jobId: job.id,
          draftId: job.draftId,
          ...(job.missionId === undefined ? {} : { missionId: job.missionId }),
          state: job.state,
          ...(selected === undefined
            ? { creation: { resourceId: storeId, ...creation! } }
            : { target: selected.target }),
        };
      }
      const activeRevisionJobId = await inlineMission.activeRevisionJobIdForStore(storeId);
      if (activeRevisionJobId !== undefined) {
        const active = await options.revisions.get(activeRevisionJobId);
        await inlineMission.assertOwnership?.(active, input);
        if (input.draftId !== undefined && input.draftId !== active.draftId) {
          throw new KnowledgeRevisionToolError(
            "revision_conflict",
            "A different draft is already active for this Mission target. Continue that draft or finish it first.",
            false,
          );
        }
        const { writableNamespace } = await inlineMission.mountDraft({
          storeId,
          draftId: active.draftId,
          revisionJobId: active.id,
        });
        return {
          jobId: active.id,
          draftId: active.draftId,
          missionId: active.missionId,
          state: active.state,
          ...(selected === undefined
            ? { creation: { resourceId: storeId, ...creation! } }
            : { target: selected.target }),
          writableNamespace,
        };
      }
      const job = await options.revisions.startForMission({
        request,
        missionId: inlineMission.id,
        ...(input.draftId === undefined ? {} : { draftId: input.draftId }),
        ...(input.draftName === undefined ? {} : { draftName: input.draftName }),
      });
      await inlineMission.assertOwnership?.(job, input);
      const previousMissionId =
        job.missionId === undefined || job.missionId === inlineMission.id
          ? undefined
          : job.missionId;
      const { writableNamespace } = await inlineMission.mountDraft({
        storeId,
        draftId: job.draftId,
        revisionJobId: job.id,
        ...(previousMissionId === undefined ? {} : { previousMissionId }),
      });
      const attached = await options.revisions.get(job.id);
      return {
        jobId: attached.id,
        draftId: attached.draftId,
        missionId: attached.missionId,
        state: attached.state,
        ...(selected === undefined
          ? { creation: { resourceId: storeId, ...creation! } }
          : { target: selected.target }),
        writableNamespace,
      };
    },
    async getDraft(input) {
      const { draft, recovery } = await options.revisions.getDraftWithRecovery(input.draftId);
      const writableNamespace =
        options.inlineMission !== undefined && draft.activeMissionId === options.inlineMission.id
          ? options.inlineMission.writableNamespaceForStore(draft.storeId)
          : undefined;
      if (input.fileId !== undefined) {
        const file = await options.revisions.getDraftFile({
          draftId: input.draftId,
          id: input.fileId,
        });
        const bytes = Buffer.from(file.content, "utf8");
        return KnowledgeRevisionDraftFileSchema.parse({
          mode: "file",
          draftId: draft.id,
          ...(writableNamespace === undefined ? {} : { writableNamespace }),
          draftRevision: draft.revision,
          id: file.id,
          content: contentChunk(file.content, input.offset ?? 0, input.limitChars ?? 20_000),
          metadata: file.metadata,
          revision: file.revision,
          etag: file.etag,
          sizeBytes: bytes.byteLength,
        });
      }
      const current = await currentSnapshotForDraft(draft, options.contextStores);
      return KnowledgeRevisionDraftInspectionSchema.parse({
        mode: "summary",
        draft: {
          draftId: draft.id,
          revision: draft.revision,
          name: draft.name,
          storeId: draft.storeId,
          baseRevision: draft.baseRevision,
          operation: draft.operation,
          ...(draft.resourceName === undefined ? {} : { resourceName: draft.resourceName }),
          ...(draft.resourceDescription === undefined
            ? {}
            : { resourceDescription: draft.resourceDescription }),
          baseSnapshotHash: draft.baseSnapshotHash,
          state: draft.state,
          activeMissionId: draft.activeMissionId,
          ...(recovery === undefined ? {} : { recovery }),
          ...(writableNamespace === undefined ? {} : { writableNamespace }),
          submittedRevision: draft.submittedRevision,
          summary: draft.summary,
          createdAt: draft.createdAt,
          updatedAt: draft.updatedAt,
        },
        currentStoreRevision: current.revision,
        currentSnapshotHash: current.snapshotHash,
        stale:
          current.revision !== draft.baseRevision ||
          current.snapshotHash !== draft.baseSnapshotHash,
        overlay: {
          files: draft.overlay.files.map((file) => {
            const bytes = Buffer.from(file.content, "utf8");
            return {
              id: file.id,
              metadata: file.metadata,
              sizeBytes: bytes.byteLength,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            };
          }),
          deletedFiles: draft.overlay.deletedFiles,
          directories: draft.overlay.directories,
          deletedDirectories: draft.overlay.deletedDirectories,
        },
      });
    },
    async inspectRebase(input) {
      const inspection = await options.revisions.inspectRebase(input.draftId);
      const summaries = inspection.conflicts.map((conflict) => ({
        id: conflict.id,
        kind: conflict.kind,
        availableSides: [
          ...(conflict.baseContent === undefined ? [] : ["base" as const]),
          ...(conflict.currentContent === undefined ? [] : ["current" as const]),
          ...(conflict.draftContent === undefined ? [] : ["draft" as const]),
        ],
      }));
      return KnowledgeRevisionConflictPageSchema.parse({
        draftId: inspection.draftId,
        draftRevision: inspection.draftRevision,
        currentStoreRevision: inspection.currentStoreRevision,
        currentSnapshotHash: inspection.currentSnapshotHash,
        ...paginateManagementItems({
          items: summaries,
          scope: `knowledge_revision_inspect_rebase:${input.draftId}`,
          fingerprintValue: [inspection.draftRevision, inspection.currentSnapshotHash, summaries],
          filters: {},
          cursor: input.cursor,
          limit: input.limit,
        }),
      });
    },
    async getRebaseConflict(input) {
      const inspection = await options.revisions.inspectRebase(input.draftId);
      const conflict = inspection.conflicts.find((candidate) => candidate.id === input.conflictId);
      if (conflict === undefined)
        throw new Error(`Knowledge revision conflict not found: ${input.conflictId}`);
      const source =
        input.side === "base"
          ? conflict.baseContent
          : input.side === "current"
            ? conflict.currentContent
            : conflict.draftContent;
      if (source === undefined)
        throw new Error(`Knowledge revision conflict side unavailable: ${input.side}`);
      return KnowledgeRevisionConflictContentSchema.parse({
        draftId: input.draftId,
        conflictId: input.conflictId,
        side: input.side,
        content: contentChunk(source, input.offset, input.limitChars),
      });
    },
    async rebase(input) {
      await assertDraftOwnership(input);
      const draft = await options.revisions.rebase({
        draftId: input.draftId,
        expectedRevision: input.expectedRevision,
        resolutions: input.resolutions,
      });
      return await draftReceipt(draft, options.contextStores);
    },
    async submitDraft(input) {
      await assertDraftOwnership(input);
      const draft = await options.revisions.submitDraft(
        input.draftId,
        input.expectedRevision,
        input.summary,
      );
      return await draftReceipt(draft, options.contextStores);
    },
    async discardDraft(input) {
      await assertDraftOwnership(input);
      await options.revisions.discardDraft(input.draftId, input.expectedRevision);
      return { draftId: input.draftId, discarded: true };
    },
  };
}

interface ResolvedTarget {
  readonly storeId: string;
  readonly target: KnowledgeRevisionTarget;
}

type KnowledgeRevisionTargetMount = KnowledgeRevisionTarget["mounts"][number];

function collectMounts(
  resources: readonly PragmaResource[],
): ReadonlyMap<string, KnowledgeRevisionTargetMount[]> {
  const storeIdsByRef = new Map(
    resources.flatMap((resource) => {
      const storeId = classifyDesktopContextResource(resource);
      return storeId === undefined
        ? []
        : ([[canonicalPragmaResourceRef(resource), storeId]] as const);
    }),
  );
  const mounts = new Map<string, KnowledgeRevisionTargetMount[]>();
  const append = (ref: string, mount: KnowledgeRevisionTargetMount): void => {
    const storeId = storeIdsByRef.get(ref);
    if (storeId === undefined) return;
    const current = mounts.get(storeId) ?? [];
    current.push(mount);
    mounts.set(storeId, current);
  };

  for (const resource of resources) {
    if (resource.kind === "Expert") collectExpertMounts(resource, append);
    if (resource.kind === "ExpertTeam") collectTeamMounts(resource, append);
  }
  return mounts;
}

function collectExpertMounts(
  expert: PragmaExpertResource,
  append: (ref: string, mount: KnowledgeRevisionTargetMount) => void,
): void {
  for (const binding of expert.spec.contextStores) {
    append(binding.ref, {
      ownerKind: "expert",
      ownerRef: canonicalPragmaResourceRef(expert),
      ownerName: expert.metadata.name,
      namespace: binding.namespace,
      required: binding.required,
    });
  }
}

function collectTeamMounts(
  team: PragmaExpertTeamResource,
  append: (ref: string, mount: KnowledgeRevisionTargetMount) => void,
): void {
  for (const binding of team.spec.contextStores) {
    append(binding.ref, {
      ownerKind: "team",
      ownerRef: canonicalPragmaResourceRef(team),
      ownerName: team.metadata.name,
      namespace: binding.namespace,
      required: binding.required,
      visibility: binding.visibility,
    });
  }
}

function digestSubmission(
  input: KnowledgeRevisionToolInvocation,
  storeId: string,
  prompt: string,
  draftId?: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.executionId,
        input.invocationId,
        input.expertId,
        input.teamId ?? null,
        storeId,
        draftId ?? null,
        prompt,
        input.operationId,
      ]),
    )
    .digest("hex");
}

async function draftReceipt(draft: ContextStoreDraft, stores: ContextStoreStore) {
  const current = await currentSnapshotForDraft(draft, stores);
  return KnowledgeRevisionDraftReceiptSchema.parse({
    draftId: draft.id,
    revision: draft.revision,
    state: draft.state,
    baseRevision: draft.baseRevision,
    stale:
      current.revision !== draft.baseRevision || current.snapshotHash !== draft.baseSnapshotHash,
    changedPaths: [
      ...draft.overlay.files.map((file) => file.id),
      ...draft.overlay.deletedFiles,
      ...draft.overlay.directories,
      ...draft.overlay.deletedDirectories,
    ],
    ...(draft.submittedRevision === undefined
      ? {}
      : { submittedRevision: draft.submittedRevision }),
  });
}

async function currentSnapshotForDraft(
  draft: ContextStoreDraft,
  stores: ContextStoreStore,
): Promise<{ readonly revision: number; readonly snapshotHash: string }> {
  if (draft.operation === "revise") return await stores.getSnapshot(draft.storeId);
  try {
    return await stores.getSnapshot(draft.storeId);
  } catch (error) {
    if (error instanceof ContextStoreStoreError && error.code === "store_not_found") {
      return { revision: 0, snapshotHash: draft.baseSnapshotHash };
    }
    throw error;
  }
}

function contentChunk(source: string, offset: number, limitChars: number) {
  const content = source.slice(offset, offset + limitChars);
  const nextOffset = offset + content.length;
  return PragmaContentChunkSchema.parse({
    content,
    offset,
    sizeChars: content.length,
    totalChars: source.length,
    sha256: createHash("sha256").update(source).digest("hex"),
    complete: nextOffset >= source.length,
    ...(nextOffset < source.length ? { nextOffset } : {}),
  });
}
