import { ipcMain } from "electron";

import {
  DesktopAssetMemoryPolicySnapshotSchema,
  DesktopGlobalMemoryPolicySnapshotSchema,
  DesktopMemoryPlaneStatusSchema,
  DesktopMemoryExtractorProfileSchema,
  GetDesktopAssetMemoryPolicySchema,
  UpdateDesktopAssetMemoryPolicySchema,
  UpdateDesktopGlobalMemoryPolicySchema,
  UpdateDesktopMemoryExtractorProfileSchema,
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
  DesktopMemoryExtractionBoardSchema,
  ManageDesktopMemoryExtractionTaskSchema,
  DesktopKnowledgeCandidateSchema,
  DesktopKnowledgeCandidateListSchema,
  ListDesktopKnowledgeCandidatesSchema,
  UpdateDesktopKnowledgeCandidateSchema,
  RejectDesktopKnowledgeCandidateSchema,
  PublishDesktopKnowledgeCandidateSchema,
  CreateDesktopKnowledgeSuccessorSchema,
  DesktopKnowledgeSchema,
  GetDesktopKnowledgeSourceSchema,
  DesktopKnowledgeSourceSchema,
} from "../../../shared/contracts/index.ts";
import type { DesktopMemoryPlane } from "./desktop-memory-plane.ts";
import type { MissionStore } from "../missions/mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { DesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
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
  ipcMain.handle("memory-extraction-jobs:list", async () => {
    const [episodicJobs, semanticJobs, knowledgeJobs, missions, project] = await Promise.all([
      plane.episodicStore.listExtractionJobs(),
      plane.semanticStore.listExtractionJobs(),
      plane.knowledgeStore.listJobs(),
      options.missions.list(),
      options.project.get(),
    ]);
    const conversationJobs = [...episodicJobs, ...semanticJobs];
    const executionTitles = await options.missions.resolveExecutionTitles(
      conversationJobs
        .filter((job) => job.conversationRef.type === "pragma.execution")
        .map((job) => job.conversationRef.id),
    );
    const missionTitles = new Map(missions.map((mission) => [mission.id, mission.title]));
    const resourceTitles = new Map(
      project.resources.map((resource) => [resource.metadata.id, resource.metadata.name]),
    );
    const conversationTasks = (
      [
        ...episodicJobs.map((job) => ({ module: "episodic" as const, job })),
        ...semanticJobs.map((job) => ({ module: "semantic" as const, job })),
      ] as const
    ).flatMap(({ module, job }) => {
      const lane = extractionLane(job.status);
      if (lane === undefined) return [];
      const title =
        job.conversationRef.type === "pragma.mission"
          ? missionTitles.get(job.conversationRef.id)
          : executionTitles.get(job.conversationRef.id);
      return [
        {
          module,
          id: job.id,
          revision: job.revision,
          lane,
          ...(title === undefined ? {} : { title }),
          ...(job.status === "needs_attention" && job.lastErrorCode !== undefined
            ? { lastErrorCode: job.lastErrorCode }
            : {}),
          updatedAt: job.updatedAt,
        },
      ];
    });
    const knowledgeTasks = knowledgeJobs.flatMap((job) => {
      const lane = extractionLane(job.status);
      if (lane === undefined) return [];
      const title = resourceTitles.get(job.rootRef.id);
      return [
        {
          module: "knowledge" as const,
          id: job.id,
          revision: job.revision,
          lane,
          ...(title === undefined ? {} : { title }),
          ...(job.status === "needs_attention" && job.lastErrorCode !== undefined
            ? { lastErrorCode: job.lastErrorCode }
            : {}),
          updatedAt: job.updatedAt,
        },
      ];
    });
    const tasks = [...conversationTasks, ...knowledgeTasks].toSorted((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
    return DesktopMemoryExtractionBoardSchema.parse({
      tasks,
      counts: {
        waiting: tasks.filter((task) => task.lane === "waiting").length,
        attention: tasks.filter((task) => task.lane === "attention").length,
        running: tasks.filter((task) => task.lane === "running").length,
        completed: tasks.filter((task) => task.lane === "completed").length,
      },
    });
  });
  ipcMain.handle("memory-extraction-jobs:manage", async (_event, input: unknown) => {
    await plane.manageMemoryJob(ManageDesktopMemoryExtractionTaskSchema.parse(input));
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
    const [episodes, facts, knowledge, subjectNameIndex] = await Promise.all([
      parsed.module === "all" || parsed.module === "episodic"
        ? plane.episodicStore.list()
        : Promise.resolve([]),
      parsed.module === "all" || parsed.module === "semantic"
        ? plane.semanticStore.list()
        : Promise.resolve([]),
      parsed.module === "all" || parsed.module === "knowledge"
        ? plane.knowledgeStore.list()
        : Promise.resolve([]),
      loadSubjectNameIndex(),
    ]);
    const items = [
      ...episodes.map((record) => toDesktopEpisode(record, subjectNameIndex)),
      ...facts.map((record) => toDesktopFact(record, subjectNameIndex)),
      ...knowledge.map((record) => toDesktopKnowledge(record, subjectNameIndex)),
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
    if (parsed.module === "semantic") {
      const [record, subjectNameIndex] = await Promise.all([
        plane.semanticStore.get(parsed.id),
        loadSubjectNameIndex(),
      ]);
      if (record === undefined) throw new Error("memory_item_not_found");
      return DesktopMemoryItemSchema.parse(toDesktopFact(record, subjectNameIndex));
    }
    const [record, subjectNameIndex] = await Promise.all([
      plane.knowledgeStore.get(parsed.id),
      loadSubjectNameIndex(),
    ]);
    if (record === undefined) throw new Error("memory_item_not_found");
    return DesktopMemoryItemSchema.parse(toDesktopKnowledge(record, subjectNameIndex));
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
    if (parsed.module === "semantic") {
      const [records, subjectNameIndex] = await Promise.all([
        plane.semanticStore.history(parsed.id),
        loadSubjectNameIndex(),
      ]);
      return DesktopMemoryItemListSchema.parse(
        records.map((record) => toDesktopFact(record, subjectNameIndex)),
      );
    }
    const [records, subjectNameIndex] = await Promise.all([
      plane.knowledgeStore.history(parsed.id),
      loadSubjectNameIndex(),
    ]);
    return DesktopMemoryItemListSchema.parse(
      records.map((record) => toDesktopKnowledge(record, subjectNameIndex)),
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
        : result.module === "semantic"
          ? toDesktopFact(result.record, subjectNameIndex)
          : toDesktopKnowledge(result.record, subjectNameIndex),
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
        : result.module === "semantic"
          ? toDesktopFact(result.record, subjectNameIndex)
          : toDesktopKnowledge(result.record, subjectNameIndex),
    );
  });
  ipcMain.handle("memory-items:forget", async (_event, input: unknown) => {
    const parsed = ReviewDesktopMemoryItemSchema.parse(input);
    if (parsed.module === "knowledge") throw new Error("knowledge_forget_not_supported");
    await plane.forgetMemoryItem({
      module: parsed.module,
      id: parsed.id,
      expectedRevision: parsed.expectedRevision,
      reason: parsed.reason,
    });
  });
  ipcMain.handle("memory-knowledge-candidates:list", async (_event, input: unknown) => {
    const parsed = ListDesktopKnowledgeCandidatesSchema.parse(input ?? {});
    return DesktopKnowledgeCandidateListSchema.parse(
      await plane.knowledgeStore.listCandidates(parsed.state === "all" ? undefined : parsed.state),
    );
  });
  ipcMain.handle("memory-knowledge-candidates:update", async (_event, input: unknown) => {
    const parsed = UpdateDesktopKnowledgeCandidateSchema.parse(input);
    return DesktopKnowledgeCandidateSchema.parse(
      await plane.knowledgeStore.updateCandidate({ ...parsed, now: new Date() }),
    );
  });
  ipcMain.handle("memory-knowledge-candidates:reject", async (_event, input: unknown) => {
    const parsed = RejectDesktopKnowledgeCandidateSchema.parse(input);
    return DesktopKnowledgeCandidateSchema.parse(
      await plane.knowledgeStore.rejectCandidate({ ...parsed, now: new Date() }),
    );
  });
  ipcMain.handle("memory-knowledge-candidates:publish", async (_event, input: unknown) => {
    const parsed = PublishDesktopKnowledgeCandidateSchema.parse(input);
    return DesktopKnowledgeSchema.parse(
      await plane.publishKnowledgeCandidate({
        candidateId: parsed.id,
        expectedRevision: parsed.expectedRevision,
        reason: parsed.reason,
        bindings: parsed.bindings,
        visibility: parsed.visibility,
      }),
    );
  });
  ipcMain.handle("memory-knowledge:successor", async (_event, input: unknown) => {
    const parsed = CreateDesktopKnowledgeSuccessorSchema.parse(input);
    return DesktopKnowledgeCandidateSchema.parse(
      await plane.createKnowledgeSuccessor({
        knowledgeId: parsed.id,
        expectedRevision: parsed.expectedRevision,
        content: parsed.content,
      }),
    );
  });
  ipcMain.handle("memory-knowledge-source:get", async (_event, input: unknown) => {
    const { sourceRef } = GetDesktopKnowledgeSourceSchema.parse(input);
    if (sourceRef.kind === "episodic") {
      const record = (await plane.episodicStore.history(sourceRef.id)).find(
        (candidate) => candidate.revision === sourceRef.revision,
      );
      if (record === undefined || record.rootRefs[0] === undefined) {
        throw new Error("knowledge_source_not_found");
      }
      return DesktopKnowledgeSourceSchema.parse(toEpisodeSource(record));
    }
    const record = (await plane.semanticStore.history(sourceRef.id)).find(
      (candidate) => candidate.revision === sourceRef.revision,
    );
    if (record === undefined || record.rootRefs[0] === undefined) {
      throw new Error("knowledge_source_not_found");
    }
    return DesktopKnowledgeSourceSchema.parse(toFactSource(record));
  });
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

function toDesktopKnowledge(
  record: import("@pragma/shared").Knowledge,
  subjectNameIndex: MemorySubjectNameIndex,
) {
  return {
    module: "knowledge" as const,
    id: record.id,
    revision: record.revision,
    status: record.status,
    title: record.content.title,
    summary: record.content.summary,
    rootRefs: [record.rootRef],
    producerRefs: record.producerRefs,
    evidenceRefs: [],
    visibility: record.visibility,
    sensitivity: record.sensitivity,
    bindings: record.bindings,
    subjectNames: memoryItemSubjectNames(
      { rootRefs: [record.rootRef], producerRefs: record.producerRefs, bindings: record.bindings },
      subjectNameIndex,
    ),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    guidance: record.content.guidance,
    normalizedKey: record.content.normalizedKey,
    sourceRefs: record.sourceRefs,
    origin: record.origin.kind,
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

function toEpisodeSource(record: import("@pragma/memory").EpisodicMemoryRecord) {
  return {
    ref: { kind: "episodic" as const, id: record.id, revision: record.revision },
    rootRef: record.rootRefs[0]!,
    producerRefs: record.producerRefs,
    title: record.goal.text,
    body: `${record.summary.text}\n${record.outcome.summary}`,
    observedAt: record.updatedAt,
    verified: false,
    valueScore: record.valueScore,
    visibility: record.visibility,
    sensitivity: record.sensitivity,
  };
}

function toFactSource(record: import("@pragma/shared").SemanticFact) {
  return {
    ref: { kind: "semantic" as const, id: record.id, revision: record.revision },
    rootRef: record.rootRefs[0]!,
    producerRefs: record.producerRefs,
    title: `${record.predicate}: ${record.normalizedValue}`,
    body: record.statement,
    observedAt: record.observedAt,
    verified: record.verifiedAt !== undefined,
    visibility: record.visibility,
    sensitivity: record.sensitivity,
  };
}

function extractionLane(
  status: "waiting_idle" | "pending" | "running" | "needs_attention" | "completed" | "expired",
): "waiting" | "attention" | "running" | "completed" | undefined {
  if (status === "waiting_idle" || status === "pending") return "waiting";
  if (status === "needs_attention") return "attention";
  if (status === "running") return "running";
  if (status === "completed") return "completed";
  // Expired jobs retain diagnostics without payload, but the product board intentionally has four lanes.
  return undefined;
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
