import { createHash } from "node:crypto";

import {
  KnowledgeRevisionDraftFileSchema,
  KnowledgeRevisionDraftInspectionSchema,
  KnowledgeRevisionDraftSummarySchema,
} from "@pragma/built-in-agents";
import type {
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
import type { ContextStoreStore } from "./context-store-store.ts";

export function createDesktopKnowledgeRevisionSubmissionPort(options: {
  readonly project: PragmaProjectStore;
  readonly contextStores: ContextStoreStore;
  readonly revisions: ContextStoreRevisionService;
  readonly additionalMountResources?: (() => readonly PragmaResource[]) | undefined;
  readonly inlineMission?:
    | {
        readonly id: string;
        readonly allowedStoreIds: ReadonlySet<string>;
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

  return {
    async listTargets() {
      return (await targets()).map((target) => target.target);
    },
    async listDrafts(input) {
      const inlineMission = options.inlineMission;
      const selectedStoreId =
        input.targetRef === undefined
          ? undefined
          : (await targets()).find((candidate) => candidate.target.targetRef === input.targetRef)
              ?.storeId;
      if (input.targetRef !== undefined && selectedStoreId === undefined) {
        throw new Error("knowledge_revision_target_unavailable");
      }
      const drafts = await options.revisions.listDrafts(
        selectedStoreId === undefined ? {} : { storeId: selectedStoreId },
      );
      return drafts.map((draft) =>
        KnowledgeRevisionDraftSummarySchema.parse({
          draftId: draft.id,
          revision: draft.revision,
          name: draft.name,
          storeId: draft.storeId,
          baseRevision: draft.baseRevision,
          state: draft.state,
          ...(draft.activeMissionId === undefined
            ? {}
            : { activeMissionId: draft.activeMissionId }),
          ...(inlineMission !== undefined &&
          draft.activeMissionId === inlineMission.id &&
          inlineMission.allowedStoreIds.has(draft.storeId)
            ? { writableNamespace: inlineMission.writableNamespaceForStore(draft.storeId) }
            : {}),
          ...(draft.submittedRevision === undefined
            ? {}
            : { submittedRevision: draft.submittedRevision }),
          ...(draft.summary === undefined ? {} : { summary: draft.summary }),
          createdAt: draft.createdAt,
          updatedAt: draft.updatedAt,
        }),
      );
    },
    async start(input) {
      const inlineMission = options.inlineMission;
      const selected = (await targets()).find(
        (candidate) => candidate.target.targetRef === input.targetRef,
      );
      if (selected === undefined) throw new Error("knowledge_revision_target_unavailable");
      if (inlineMission !== undefined && !inlineMission.allowedStoreIds.has(selected.storeId)) {
        throw new Error("knowledge_revision_target_not_mounted");
      }
      const sourceDigest = digestSubmission(input, selected.storeId, input.prompt, input.draftId);
      const activeRevisionJobId = await inlineMission?.activeRevisionJobIdForStore(
        selected.storeId,
      );
      if (activeRevisionJobId !== undefined) {
        if (inlineMission === undefined) throw new Error("knowledge_revision_mission_unavailable");
        const active = await options.revisions.get(activeRevisionJobId);
        if (active.request.sourceDigest === sourceDigest) {
          return {
            jobId: active.id,
            draftId: active.draftId,
            missionId: active.missionId,
            state: active.state,
            target: selected.target,
            writableNamespace: inlineMission.writableNamespaceForStore(selected.storeId),
          };
        }
        throw new Error("knowledge_revision_already_attached");
      }
      const job = await options.revisions.start(
        {
          schemaVersion: "pragma.context-store-revision-request/v1",
          storeId: selected.storeId,
          prompt: input.prompt,
          source: "expert-reflection",
          sourceDigest,
          provenance: {
            executionId: input.executionId,
            invocationId: input.invocationId,
            expertId: input.expertId,
            ...(input.teamId === undefined ? {} : { teamId: input.teamId }),
          },
        },
        {
          ...(input.draftId === undefined ? {} : { draftId: input.draftId }),
          ...(input.draftName === undefined ? {} : { draftName: input.draftName }),
        },
      );
      let writableNamespace: string | undefined;
      if (inlineMission === undefined) {
        options.revisions.scheduleProcessing();
      } else {
        const attachedHere = job.missionId === undefined;
        const previousMissionId =
          job.missionId === undefined || job.missionId === inlineMission.id
            ? undefined
            : job.missionId;
        if (attachedHere) {
          await options.revisions.attachMission(job.id, inlineMission.id);
        }
        try {
          ({ writableNamespace } = await inlineMission.mountDraft({
            storeId: selected.storeId,
            draftId: job.draftId,
            revisionJobId: job.id,
            ...(previousMissionId === undefined ? {} : { previousMissionId }),
          }));
        } catch (error) {
          if (attachedHere) {
            await options.revisions.detachMission(job.id, inlineMission.id);
          }
          throw error;
        }
      }
      const attached = await options.revisions.get(job.id);
      return {
        jobId: attached.id,
        draftId: attached.draftId,
        missionId: attached.missionId,
        state: attached.state,
        target: selected.target,
        ...(writableNamespace === undefined ? {} : { writableNamespace }),
      };
    },
    async getDraft(input) {
      const draft = await options.revisions.getDraft(input.draftId);
      const writableNamespace =
        options.inlineMission !== undefined &&
        draft.activeMissionId === options.inlineMission.id &&
        options.inlineMission.allowedStoreIds.has(draft.storeId)
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
          content: file.content,
          metadata: file.metadata,
          revision: file.revision,
          etag: file.etag,
          sizeBytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
      const current = await options.contextStores.getSnapshot(draft.storeId);
      return KnowledgeRevisionDraftInspectionSchema.parse({
        mode: "summary",
        draft: {
          draftId: draft.id,
          revision: draft.revision,
          name: draft.name,
          storeId: draft.storeId,
          baseRevision: draft.baseRevision,
          baseSnapshotHash: draft.baseSnapshotHash,
          state: draft.state,
          activeMissionId: draft.activeMissionId,
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
      return await options.revisions.inspectRebase(input.draftId);
    },
    async rebase(input) {
      return await options.revisions.rebase({
        draftId: input.draftId,
        expectedRevision: input.expectedRevision,
        resolutions: input.resolutions,
      });
    },
    async submitDraft(input) {
      return await options.revisions.submitDraft(
        input.draftId,
        input.expectedRevision,
        input.summary,
      );
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
