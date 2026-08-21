import { ipcMain, type BrowserWindow } from "electron";

import {
  DesktopAssetMemoryPolicySnapshotSchema,
  DesktopGlobalMemoryPolicySnapshotSchema,
  DesktopMemoryPlaneStatusSchema,
  DesktopMemoryExtractorProfileSchema,
  DesktopMemoryExtractionSettingsSchema,
  GetDesktopAssetMemoryPolicySchema,
  UpdateDesktopAssetMemoryPolicySchema,
  UpdateDesktopGlobalMemoryPolicySchema,
  UpdateDesktopMemoryExtractorProfileSchema,
  UpdateDesktopMemoryExtractionSettingsSchema,
  DesktopSemanticFactSchema,
  ReviseDesktopSemanticFactSchema,
  ReviewDesktopSemanticFactSchema,
  DesktopMemoryItemSchema,
  DesktopMemoryItemListSchema,
  ListDesktopMemoryItemsSchema,
  DesktopMemoryItemRefSchema,
  GetDesktopMemoryEvidenceSchema,
  DesktopMemoryEvidenceSchema,
  TightenDesktopMemoryAccessSchema,
  ReviewDesktopMemoryItemSchema,
  DesktopMissionMemoryActivitySchema,
  GetDesktopMissionMemoryActivitySchema,
  ListDesktopMemoryExtractionJobsSchema,
  ManageDesktopMemoryExtractionTaskSchema,
  DesktopMemoryExtractionTaskRefSchema,
  DesktopMemoryExtractionTaskDetailSchema,
  DesktopMemoryExtractionActiveTaskListSchema,
  DesktopMemoryExtractionRunRefSchema,
  MissionChatSnapshotSchema,
  MemoryKnowledgeInitializationCandidateSchema,
  ListMemoryKnowledgeInitializationCandidatesSchema,
  MemoryKnowledgeInitializationCandidateRefSchema,
  UpdateMemoryKnowledgeInitializationCandidateSchema,
  ContextStoreSchema,
} from "../../../shared/contracts/index.ts";
import type { DesktopMemoryPlane } from "./desktop-memory-plane.ts";
import type { MissionStore } from "../missions/mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { DesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import type { MemoryKnowledgePromotionService } from "./memory-knowledge-promotion.ts";
import {
  getDesktopMemoryExtractionTaskDetail,
  listDesktopMemoryExtractionActiveTasks,
  listDesktopMemoryExtractionJobs,
} from "./memory-extraction-jobs.ts";
import type { DesktopMemoryCurator } from "./memory-curator.ts";
import {
  loadMemorySubjectNameIndex,
  selectMemorySubjectNames,
  type MemorySubjectNameIndex,
  type MemorySubjectReference,
} from "./memory-subject-names.ts";

export function installMemoryPolicyHandlers(
  plane: DesktopMemoryPlane,
  options: {
    readonly missions: MissionStore;
    readonly project: PragmaProjectStore;
    readonly systemExperts: Pick<DesktopSystemExpertRegistry, "list">;
    readonly knowledgePromotion: MemoryKnowledgePromotionService;
    readonly curator: DesktopMemoryCurator;
    readonly getWindow: () => BrowserWindow | null;
    readonly onGlobalPolicyUpdated?: (() => void | Promise<void>) | undefined;
  },
): void {
  const loadSubjectNameIndex = (): Promise<MemorySubjectNameIndex> =>
    loadMemorySubjectNameIndex({
      getProject: () => options.project.get(),
      listSystemExperts: () => options.systemExperts.list(),
    });
  const globalSnapshot = async () => {
    const revision = await plane.policies.getGlobal();
    return DesktopGlobalMemoryPolicySnapshotSchema.parse({
      revision: revision.revision,
      effectiveFrom: revision.effectiveFrom,
      policy: revision.policy,
    });
  };
  const assetSnapshot = async (targetRef: { readonly type: string; readonly id: string }) => {
    const revision = await plane.policies.getOverride(targetRef);
    const effective = await plane.policies.resolveAt({
      rootRef: targetRef,
      occurredAt: new Date().toISOString(),
    });
    return DesktopAssetMemoryPolicySnapshotSchema.parse({
      targetRef,
      revision: revision.revision,
      effectiveFrom: revision.effectiveFrom,
      policy: revision.policy,
      effective,
    });
  };

  ipcMain.handle("memory-policy:global:get", globalSnapshot);
  ipcMain.handle("memory-policy:global:update", async (_event, input: unknown) => {
    const parsed = UpdateDesktopGlobalMemoryPolicySchema.parse(input);
    await plane.policies.updateGlobal(parsed);
    await options.onGlobalPolicyUpdated?.();
    return await globalSnapshot();
  });
  ipcMain.handle("memory-policy:asset:get", async (_event, input: unknown) => {
    const parsed = GetDesktopAssetMemoryPolicySchema.parse(input);
    return await assetSnapshot(parsed.targetRef);
  });
  ipcMain.handle("memory-policy:asset:update", async (_event, input: unknown) => {
    const parsed = UpdateDesktopAssetMemoryPolicySchema.parse(input);
    await plane.policies.updateOverride(parsed);
    return await assetSnapshot(parsed.targetRef);
  });
  ipcMain.handle("memory-plane:status", async () =>
    DesktopMemoryPlaneStatusSchema.parse(await plane.getStatus()),
  );
  ipcMain.handle("memory-extraction-jobs:list", async (_event, input: unknown) => {
    return await listDesktopMemoryExtractionJobs(
      plane,
      options,
      ListDesktopMemoryExtractionJobsSchema.parse(input),
    );
  });
  ipcMain.handle("memory-extraction-jobs:manage", async (_event, input: unknown) => {
    await plane.manageMemoryJob(ManageDesktopMemoryExtractionTaskSchema.parse(input));
  });
  ipcMain.handle("memory-extraction-active-tasks:list", async () =>
    DesktopMemoryExtractionActiveTaskListSchema.parse(
      await listDesktopMemoryExtractionActiveTasks(plane, options),
    ),
  );
  ipcMain.handle("memory-extraction-task-detail:get", async (_event, input: unknown) => {
    return DesktopMemoryExtractionTaskDetailSchema.parse(
      await getDesktopMemoryExtractionTaskDetail(
        plane,
        options,
        DesktopMemoryExtractionTaskRefSchema.parse(input),
      ),
    );
  });
  ipcMain.handle("memory-extraction-run-chat:get", async (_event, input: unknown) => {
    const chat = await options.curator.getRunChat(
      DesktopMemoryExtractionRunRefSchema.parse(input).runId,
    );
    if (chat === undefined) throw new Error("memory_extraction_run_not_found");
    return MissionChatSnapshotSchema.parse(chat);
  });
  options.curator.subscribeRunChat((update) => {
    options.getWindow()?.webContents.send("memory-extraction-run-chat:updated", update);
  });
  ipcMain.handle("memory-extractor-profile:get", async () =>
    DesktopMemoryExtractorProfileSchema.parse(await plane.extractorProfiles.get()),
  );
  ipcMain.handle("memory-extractor-profile:update", async (_event, input: unknown) => {
    const parsed = UpdateDesktopMemoryExtractorProfileSchema.parse(input);
    const profile = await plane.extractorProfiles.update(parsed);
    await plane.wakeMemoryJobs();
    return DesktopMemoryExtractorProfileSchema.parse(profile);
  });
  ipcMain.handle("memory-extraction-settings:get", async () =>
    DesktopMemoryExtractionSettingsSchema.parse(await plane.extractionSettings.get()),
  );
  ipcMain.handle("memory-extraction-settings:update", async (_event, input: unknown) => {
    const parsed = UpdateDesktopMemoryExtractionSettingsSchema.parse(input);
    return DesktopMemoryExtractionSettingsSchema.parse(
      await plane.extractionSettings.update(parsed),
    );
  });
  ipcMain.handle("memory-semantic:revise", async (_event, input: unknown) => {
    const parsed = ReviseDesktopSemanticFactSchema.parse(input);
    return DesktopSemanticFactSchema.parse(await plane.reviseSemanticFact(parsed));
  });
  ipcMain.handle("memory-semantic:verify", async (_event, input: unknown) => {
    const parsed = ReviewDesktopSemanticFactSchema.parse(input);
    return DesktopSemanticFactSchema.parse(await plane.verifySemanticFact(parsed));
  });
  ipcMain.handle("memory-items:list", async (_event, input: unknown) => {
    const parsed = ListDesktopMemoryItemsSchema.parse(input ?? {});
    const [episodes, facts, subjectNameIndex] = await Promise.all([
      parsed.module === "all" || parsed.module === "episodic"
        ? plane.episodicStore.list()
        : Promise.resolve([]),
      parsed.module === "all" || parsed.module === "semantic"
        ? plane.semanticStore.list()
        : Promise.resolve([]),
      loadSubjectNameIndex(),
    ]);
    const items = [
      ...episodes.map((record) => toDesktopEpisode(record, subjectNameIndex)),
      ...facts.map((record) => toDesktopFact(record, subjectNameIndex)),
    ]
      .filter((item) => parsed.status === "all" || item.status === parsed.status)
      .filter((item) => {
        const query = parsed.query.toLocaleLowerCase();
        return query === "" || `${item.title}\n${item.summary}`.toLocaleLowerCase().includes(query);
      })
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, parsed.limit);
    return DesktopMemoryItemListSchema.parse(items);
  });
  ipcMain.handle("memory-items:get", async (_event, input: unknown) => {
    const parsed = DesktopMemoryItemRefSchema.parse(input);
    if (parsed.module === "episodic") {
      const [record, subjectNameIndex] = await Promise.all([
        plane.episodicStore.get(parsed.id),
        loadSubjectNameIndex(),
      ]);
      if (record === undefined) throw new Error("memory_item_not_found");
      return DesktopMemoryItemSchema.parse(toDesktopEpisode(record, subjectNameIndex));
    }
    const [record, subjectNameIndex] = await Promise.all([
      plane.semanticStore.get(parsed.id),
      loadSubjectNameIndex(),
    ]);
    if (record === undefined) throw new Error("memory_item_not_found");
    return DesktopMemoryItemSchema.parse(toDesktopFact(record, subjectNameIndex));
  });
  ipcMain.handle("memory-items:history", async (_event, input: unknown) => {
    const parsed = DesktopMemoryItemRefSchema.parse(input);
    if (parsed.module === "episodic") {
      const [records, subjectNameIndex] = await Promise.all([
        plane.episodicStore.history(parsed.id),
        loadSubjectNameIndex(),
      ]);
      return DesktopMemoryItemListSchema.parse(
        records.map((record) => toDesktopEpisode(record, subjectNameIndex)),
      );
    }
    const [records, subjectNameIndex] = await Promise.all([
      plane.semanticStore.history(parsed.id),
      loadSubjectNameIndex(),
    ]);
    return DesktopMemoryItemListSchema.parse(
      records.map((record) => toDesktopFact(record, subjectNameIndex)),
    );
  });
  ipcMain.handle("memory-items:evidence", async (_event, input: unknown) => {
    const parsed = GetDesktopMemoryEvidenceSchema.parse(input);
    const item =
      parsed.module === "episodic"
        ? await plane.episodicStore.get(parsed.id)
        : await plane.semanticStore.get(parsed.id);
    if (item === undefined || !item.evidenceRefs.includes(parsed.evidenceId)) {
      throw new Error("memory_evidence_not_found");
    }
    const evidence =
      parsed.module === "episodic"
        ? await plane.episodicStore.getEvidence(parsed.evidenceId)
        : await plane.semanticStore.getEvidence(parsed.evidenceId);
    if (evidence === undefined) throw new Error("memory_evidence_not_found");
    return DesktopMemoryEvidenceSchema.parse(evidence);
  });
  ipcMain.handle("memory-items:tighten", async (_event, input: unknown) => {
    const parsed = TightenDesktopMemoryAccessSchema.parse(input);
    const [result, subjectNameIndex] = await Promise.all([
      plane.tightenMemoryAccess(parsed),
      loadSubjectNameIndex(),
    ]);
    return DesktopMemoryItemSchema.parse(
      result.module === "episodic"
        ? toDesktopEpisode(result.record, subjectNameIndex)
        : toDesktopFact(result.record, subjectNameIndex),
    );
  });
  ipcMain.handle("memory-items:invalidate", async (_event, input: unknown) => {
    const parsed = ReviewDesktopMemoryItemSchema.parse(input);
    const [result, subjectNameIndex] = await Promise.all([
      plane.invalidateMemoryItem(parsed),
      loadSubjectNameIndex(),
    ]);
    return DesktopMemoryItemSchema.parse(
      result.module === "episodic"
        ? toDesktopEpisode(result.record, subjectNameIndex)
        : toDesktopFact(result.record, subjectNameIndex),
    );
  });
  ipcMain.handle("memory-items:forget", async (_event, input: unknown) => {
    const parsed = ReviewDesktopMemoryItemSchema.parse(input);
    await plane.forgetMemoryItem({
      module: parsed.module,
      id: parsed.id,
      expectedRevision: parsed.expectedRevision,
      reason: parsed.reason,
    });
  });
  ipcMain.handle("memory-knowledge-initializations:list", async (_event, input: unknown) =>
    MemoryKnowledgeInitializationCandidateSchema.array().parse(
      await options.knowledgePromotion.list(
        ListMemoryKnowledgeInitializationCandidatesSchema.parse(input ?? {}),
      ),
    ),
  );
  ipcMain.handle("memory-knowledge-initializations:update", async (_event, input: unknown) =>
    MemoryKnowledgeInitializationCandidateSchema.parse(
      await options.knowledgePromotion.update(
        UpdateMemoryKnowledgeInitializationCandidateSchema.parse(input),
      ),
    ),
  );
  ipcMain.handle("memory-knowledge-initializations:reject", async (_event, input: unknown) =>
    MemoryKnowledgeInitializationCandidateSchema.parse(
      await options.knowledgePromotion.reject(
        MemoryKnowledgeInitializationCandidateRefSchema.parse(input),
      ),
    ),
  );
  ipcMain.handle("memory-knowledge-initializations:create-store", async (_event, input: unknown) =>
    ContextStoreSchema.parse(
      await options.knowledgePromotion.createStore(
        MemoryKnowledgeInitializationCandidateRefSchema.parse(input),
      ),
    ),
  );
  ipcMain.handle("memory-mission:activity", async (_event, input: unknown) => {
    const parsed = GetDesktopMissionMemoryActivitySchema.parse(input);
    const executionIds = await missionExecutionIds(options.missions, parsed.missionId);
    return DesktopMissionMemoryActivitySchema.parse({
      missionId: parsed.missionId,
      executions: await Promise.all(
        executionIds.map(async (executionId) => await plane.activity.summarize(executionId)),
      ),
    });
  });
}

function toDesktopEpisode(
  record: import("@pragma/memory").EpisodicMemoryRecord,
  subjectNameIndex: MemorySubjectNameIndex,
) {
  return {
    module: "episodic" as const,
    id: record.id,
    revision: record.revision,
    status: record.status,
    title: record.goal.text,
    summary: record.summary.text,
    rootRefs: record.rootRefs,
    producerRefs: record.producerRefs,
    evidenceRefs: record.evidenceRefs,
    visibility: record.visibility,
    sensitivity: record.sensitivity,
    bindings: record.bindings,
    subjectNames: memoryItemSubjectNames(record, subjectNameIndex),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    executionId: record.executionId,
    goal: record.goal.text,
    outcome: record.outcome.status,
    valueScore: record.valueScore,
    attempts: record.attempts.map(({ description, result }) => ({
      description,
      ...(result === undefined ? {} : { result }),
    })),
    failuresAndRecoveries: record.failuresAndRecoveries.map(({ failure, recovery }) => ({
      failure,
      ...(recovery === undefined ? {} : { recovery }),
    })),
  };
}

function toDesktopFact(
  record: import("@pragma/shared").SemanticFact,
  subjectNameIndex: MemorySubjectNameIndex,
) {
  return {
    module: "semantic" as const,
    id: record.id,
    revision: record.revision,
    status: record.status,
    title: record.statement,
    summary: record.statement,
    rootRefs: record.rootRefs,
    producerRefs: record.producerRefs,
    evidenceRefs: record.evidenceRefs,
    visibility: record.visibility,
    sensitivity: record.sensitivity,
    bindings: record.bindings,
    subjectNames: memoryItemSubjectNames(record, subjectNameIndex),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    statement: record.statement,
    subjectRefs: record.subjectRefs,
    predicate: record.predicate,
    normalizedValue: record.normalizedValue,
    confidence: record.confidence,
    ...(record.verifiedAt === undefined ? {} : { verifiedAt: record.verifiedAt }),
    ...(record.reviewAt === undefined ? {} : { reviewAt: record.reviewAt }),
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    conflictsWith: record.conflictsWith,
  };
}

function memoryItemSubjectNames(
  item: {
    readonly rootRefs: readonly MemorySubjectReference[];
    readonly producerRefs: readonly MemorySubjectReference[];
    readonly bindings: readonly { readonly consumerRef: MemorySubjectReference }[];
  },
  subjectNameIndex: MemorySubjectNameIndex,
): Record<string, string> {
  return selectMemorySubjectNames(subjectNameIndex, [
    ...item.rootRefs,
    ...item.producerRefs,
    ...item.bindings.map((binding) => binding.consumerRef),
  ]);
}

async function missionExecutionIds(store: MissionStore, missionId: string): Promise<string[]> {
  const ids = new Set<string>();
  let beforeSequence: number | undefined;
  do {
    const page = await store.readTimelinePage(missionId, {
      ...(beforeSequence === undefined ? {} : { beforeSequence }),
      limit: 200,
    });
    for (const turn of page.turns) if (turn.executionId !== undefined) ids.add(turn.executionId);
    beforeSequence = page.nextBeforeSequence;
  } while (beforeSequence !== undefined);
  return [...ids];
}
