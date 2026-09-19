import { createHash, randomUUID } from "node:crypto";

import {
  KnowledgeRevisionToolError,
  ReadySkillRevisionDraftSummarySchema,
  ReadySkillRevisionTargetSchema,
  SkillRevisionDraftSummarySchema,
  SkillRevisionDiscardDraftResultSchema,
  SkillRevisionDraftInspectionSchema,
  SkillRevisionDraftPageSchema,
  SkillRevisionDraftReceiptSchema,
  SkillRevisionStartResultSchema,
  SkillRevisionTargetPageSchema,
  type SkillRevisionSubmissionPort,
} from "@pragma/built-in-agents";

import { paginateManagementItems } from "../built-in-agents/management-pagination.ts";
import type { CapabilityStore } from "./capability-store.ts";
import type { SkillRevisionService } from "./skill-revision-service.ts";

export function createDesktopSkillRevisionSubmissionPort(options: {
  readonly capabilities: CapabilityStore;
  readonly revisions: SkillRevisionService;
  readonly inlineMissionId?: string | undefined;
  readonly mountDraft?:
    | ((input: {
        readonly missionId: string;
        readonly draftId: string;
        readonly jobId: string;
        readonly capabilityId: string;
      }) => Promise<void>)
    | undefined;
  readonly unmountDraft?:
    | ((input: { readonly missionId: string; readonly draftId: string }) => Promise<void>)
    | undefined;
}): SkillRevisionSubmissionPort {
  const targets = async () =>
    (await options.capabilities.list())
      .filter((capability) => capability.definition.kind === "skill")
      .map((capability) => {
        if (capability.definition.kind !== "skill") {
          throw new Error("The filtered capability is not a Skill.");
        }
        return ReadySkillRevisionTargetSchema.parse({
          availability: "ready",
          targetRef: targetRef(capability.manifest.id),
          capabilityId: capability.manifest.id,
          name: capability.definition.name,
          description: capability.definition.description,
          revision: capability.manifest.latestRevision,
          contentHash: capability.definition.contentHash,
          mounted: false,
        });
      })
      .toSorted(
        (left, right) =>
          left.name.localeCompare(right.name) || left.targetRef.localeCompare(right.targetRef),
      );

  const resolveTarget = async (ref: string) => {
    const target = (await targets()).find((candidate) => candidate.targetRef === ref);
    if (target === undefined) {
      throw new KnowledgeRevisionToolError("not_found", "skill_revision_target_unavailable", false);
    }
    return target;
  };

  return {
    async listTargets(input) {
      const query = input.query?.toLocaleLowerCase();
      const items = (await targets()).filter(
        (target) =>
          (input.mounted === undefined || target.mounted === input.mounted) &&
          (query === undefined ||
            [target.targetRef, target.name, target.description].some((value) =>
              value.toLocaleLowerCase().includes(query),
            )),
      );
      return SkillRevisionTargetPageSchema.parse(
        paginateManagementItems({
          items,
          scope: "skill_revision_list_targets",
          fingerprintValue: items,
          filters: { mounted: input.mounted, query },
          cursor: input.cursor,
          limit: input.limit,
        }),
      );
    },
    async listDrafts(input) {
      const selected =
        input.targetRef === undefined ? undefined : await resolveTarget(input.targetRef);
      const states = input.states === undefined ? undefined : new Set(input.states);
      const query = input.query?.toLocaleLowerCase();
      const jobs = await options.revisions.list({
        ...(selected === undefined ? {} : { capabilityId: selected.capabilityId }),
      });
      const readyItems = await Promise.all(
        jobs.map(async (job) => {
          const draft = await options.revisions.getDraft(job.draftId);
          const ownsDraft = draft.activeMissionId === options.inlineMissionId;
          const inspection = ownsDraft
            ? await options.revisions.inspectDraft(draft.id, options.inlineMissionId)
            : undefined;
          return ReadySkillRevisionDraftSummarySchema.parse({
            availability: "ready",
            draftId: draft.id,
            jobId: job.id,
            revision: draft.revision,
            capabilityId: draft.capabilityId,
            name: draft.name,
            baseRevision: draft.baseRevision,
            operation: draft.operation,
            ...(draft.resourceDescription === undefined
              ? {}
              : { resourceDescription: draft.resourceDescription }),
            state: draft.state,
            ...(job.missionId === undefined ? {} : { missionId: job.missionId }),
            ...(inspection?.draftPath === undefined ? {} : { draftPath: inspection.draftPath }),
            ...(draft.summary === undefined ? {} : { summary: draft.summary }),
            ...(draft.error === undefined ? {} : { error: draft.error }),
            createdAt: draft.createdAt,
            updatedAt: draft.updatedAt,
          });
        }),
      );
      const degradedItems = (await options.revisions.listDiagnostics())
        .filter((item) => item.kind === "draft")
        .flatMap((item) => {
          const parsed = SkillRevisionDraftSummarySchema.safeParse({
            availability: "degraded",
            draftId: item.id,
            diagnostic: { code: item.code, message: item.message, retryable: false },
          });
          return parsed.success ? [parsed.data] : [];
        });
      const filtered = readyItems.filter(
        (draft) =>
          (states === undefined || states.has(draft.state)) &&
          (query === undefined ||
            [draft.draftId, draft.name, draft.summary ?? ""].some((value) =>
              value.toLocaleLowerCase().includes(query),
            )),
      );
      return SkillRevisionDraftPageSchema.parse(
        paginateManagementItems({
          items: [...filtered, ...degradedItems],
          scope: "skill_revision_list_drafts",
          fingerprintValue: filtered.map(({ draftId, revision }) => [draftId, revision]),
          filters: { targetRef: input.targetRef, states: input.states, query },
          cursor: input.cursor,
          limit: input.limit,
        }),
      );
    },
    async start(input) {
      const continuedDraft =
        input.draftId === undefined ? undefined : await options.revisions.getDraft(input.draftId);
      const target =
        input.targetRef !== undefined
          ? await resolveTarget(input.targetRef)
          : continuedDraft?.operation === "revise"
            ? await resolveTarget(targetRef(continuedDraft.capabilityId))
            : undefined;
      if (
        continuedDraft !== undefined &&
        input.targetRef !== undefined &&
        (continuedDraft.operation === "create" ||
          target?.capabilityId !== continuedDraft.capabilityId)
      ) {
        throw new KnowledgeRevisionToolError(
          "revision_conflict",
          "skill_revision_target_draft_mismatch",
          false,
        );
      }
      const capabilityId =
        input.create !== undefined
          ? randomUUID()
          : (continuedDraft?.capabilityId ?? target!.capabilityId);
      const operation: "create" | "revise" =
        input.create !== undefined || continuedDraft?.operation === "create" ? "create" : "revise";
      const creation =
        input.create ??
        (continuedDraft?.operation === "create"
          ? { name: continuedDraft.name, description: continuedDraft.resourceDescription! }
          : undefined);
      const sourceDigest = createHash("sha256")
        .update(
          JSON.stringify({
            capabilityId,
            prompt: input.prompt,
            draftId: input.draftId,
            provenance: {
              executionId: input.executionId,
              invocationId: input.invocationId,
              expertId: input.expertId,
              teamId: input.teamId,
            },
          }),
        )
        .digest("hex");
      const job = await options.revisions.start(
        {
          schemaVersion: "pragma.skill-revision-request/v3",
          operation,
          capabilityId,
          ...(creation === undefined
            ? {}
            : { resourceName: creation.name, resourceDescription: creation.description }),
          prompt: input.prompt,
          source: "expert-reflection",
          sourceDigest,
          provenance: {
            executionId: input.executionId,
            invocationId: input.invocationId,
            expertId: input.expertId,
            ...(input.teamId === undefined ? {} : { teamId: input.teamId }),
          },
          sourceRefs: [],
        },
        {
          ...(input.draftId === undefined ? {} : { draftId: input.draftId }),
          ...(input.draftName === undefined ? {} : { draftName: input.draftName }),
          ...(options.inlineMissionId === undefined ? {} : { missionId: options.inlineMissionId }),
        },
      );
      const inspection = await options.revisions.inspectDraft(job.draftId, options.inlineMissionId);
      if (options.inlineMissionId !== undefined && options.mountDraft !== undefined) {
        await options.mountDraft({
          missionId: options.inlineMissionId,
          draftId: job.draftId,
          jobId: job.id,
          capabilityId,
        });
      }
      return SkillRevisionStartResultSchema.parse({
        jobId: job.id,
        draftId: job.draftId,
        ...(job.missionId === undefined ? {} : { missionId: job.missionId }),
        state: job.state,
        ...(target === undefined
          ? { creation: { resourceId: capabilityId, ...creation! } }
          : { target }),
        ...(inspection.draftPath === undefined ? {} : { draftPath: inspection.draftPath }),
      });
    },
    async getDraft(input) {
      const inspection = await options.revisions.inspectDraft(
        input.draftId,
        options.inlineMissionId,
      );
      const job = (await options.revisions.list()).find(
        (candidate) => candidate.draftId === input.draftId,
      );
      if (job === undefined) {
        throw new KnowledgeRevisionToolError("not_found", "skill_revision_job_not_found", false);
      }
      const summary = ReadySkillRevisionDraftSummarySchema.parse({
        availability: "ready",
        draftId: inspection.draft.id,
        jobId: job.id,
        revision: inspection.draft.revision,
        capabilityId: inspection.draft.capabilityId,
        name: inspection.draft.name,
        baseRevision: inspection.draft.baseRevision,
        operation: inspection.draft.operation,
        ...(inspection.draft.resourceDescription === undefined
          ? {}
          : { resourceDescription: inspection.draft.resourceDescription }),
        state: inspection.draft.state,
        ...(job.missionId === undefined ? {} : { missionId: job.missionId }),
        ...(inspection.draftPath === undefined ? {} : { draftPath: inspection.draftPath }),
        ...(inspection.referencePath === undefined
          ? {}
          : { referencePath: inspection.referencePath }),
        ...(inspection.draft.summary === undefined ? {} : { summary: inspection.draft.summary }),
        ...(inspection.draft.error === undefined ? {} : { error: inspection.draft.error }),
        createdAt: inspection.draft.createdAt,
        updatedAt: inspection.draft.updatedAt,
      });
      return SkillRevisionDraftInspectionSchema.parse({
        draft: summary,
        workingTreeHash: inspection.workingTree.hash,
        currentRevision: inspection.currentRevision,
        currentContentHash: inspection.currentContentHash,
        stale: inspection.stale,
        ...paginateManagementItems({
          items: inspection.changes,
          scope: `skill_revision_get_draft:${input.draftId}`,
          fingerprintValue: [inspection.workingTree.hash, inspection.currentContentHash],
          filters: {},
          cursor: input.cursor,
          limit: input.limit,
        }),
      });
    },
    async submitDraft(input) {
      const job = await options.revisions.submitDraft({
        draftId: input.draftId,
        expectedRevision: input.expectedRevision,
        expectedWorkingTreeHash: input.expectedWorkingTreeHash,
        summary: input.summary,
        ...(options.inlineMissionId === undefined ? {} : { missionId: options.inlineMissionId }),
      });
      const draft = await options.revisions.getDraft(job.draftId);
      return SkillRevisionDraftReceiptSchema.parse({
        draftId: draft.id,
        jobId: job.id,
        revision: draft.revision,
        state: job.state,
      });
    },
    async discardDraft(input) {
      await options.revisions.discardDraft({
        draftId: input.draftId,
        expectedRevision: input.expectedRevision,
        expectedWorkingTreeHash: input.expectedWorkingTreeHash,
        ...(options.inlineMissionId === undefined ? {} : { missionId: options.inlineMissionId }),
      });
      if (options.inlineMissionId !== undefined && options.unmountDraft !== undefined) {
        await options.unmountDraft({ missionId: options.inlineMissionId, draftId: input.draftId });
      }
      return SkillRevisionDiscardDraftResultSchema.parse({
        draftId: input.draftId,
        discarded: true,
      });
    },
  };
}

function targetRef(capabilityId: string): string {
  return `skill:${capabilityId}`;
}
