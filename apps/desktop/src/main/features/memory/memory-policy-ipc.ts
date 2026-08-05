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
  DesktopMemoryExtractionJobSchema,
  DesktopMemoryExtractionJobListSchema,
  RetryDesktopMemoryExtractionJobSchema,
  DesktopKnowledgeCandidateSchema,
  DesktopKnowledgeCandidateListSchema,
  ListDesktopKnowledgeCandidatesSchema,
  UpdateDesktopKnowledgeCandidateSchema,
  RejectDesktopKnowledgeCandidateSchema,
  PublishDesktopKnowledgeCandidateSchema,
  CreateDesktopKnowledgeSuccessorSchema,
  DesktopKnowledgeSchema,
  DesktopKnowledgeJobSchema,
  DesktopKnowledgeJobListSchema,
  RetryDesktopKnowledgeJobSchema,
  GetDesktopKnowledgeSourceSchema,
  DesktopKnowledgeSourceSchema,
} from "../../../shared/contracts/index.ts";
import type { DesktopMemoryPlane } from "./desktop-memory-plane.ts";
import type { MissionStore } from "../missions/mission-store.ts";

export function installMemoryPolicyHandlers(
  plane: DesktopMemoryPlane,
  options: { readonly missions: MissionStore },
): void {
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
    const jobs = [
      ...(await Promise.all(
        (await plane.episodicStore.listExtractionJobs()).map(
          async (job) =>
            await toDesktopExtractionJob("episodic", job, plane.episodicStore, options.missions),
        ),
      )),
      ...(await Promise.all(
        (await plane.semanticStore.listExtractionJobs()).map(
          async (job) =>
            await toDesktopExtractionJob("semantic", job, plane.semanticStore, options.missions),
        ),
      )),
    ].toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return DesktopMemoryExtractionJobListSchema.parse(jobs.slice(0, 100));
  });
  ipcMain.handle("memory-extraction-jobs:retry", async (_event, input: unknown) => {
    const parsed = RetryDesktopMemoryExtractionJobSchema.parse(input);
    await plane.retryMemoryJob(parsed);
    const store = parsed.module === "episodic" ? plane.episodicStore : plane.semanticStore;
    const job = (await store.listExtractionJobs()).find((candidate) => candidate.id === parsed.id);
    if (job === undefined) throw new Error("memory_extraction_job_not_found");
    return DesktopMemoryExtractionJobSchema.parse(
      await toDesktopExtractionJob(parsed.module, job, store, options.missions),
    );
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
    const items = [
      ...(parsed.module === "all" || parsed.module === "episodic"
        ? (await plane.episodicStore.list()).map(toDesktopEpisode)
        : []),
      ...(parsed.module === "all" || parsed.module === "semantic"
        ? (await plane.semanticStore.list()).map(toDesktopFact)
        : []),
      ...(parsed.module === "all" || parsed.module === "knowledge"
        ? (await plane.knowledgeStore.list()).map(toDesktopKnowledge)
        : []),
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
      const record = await plane.episodicStore.get(parsed.id);
      if (record === undefined) throw new Error("memory_item_not_found");
      return DesktopMemoryItemSchema.parse(toDesktopEpisode(record));
    }
    if (parsed.module === "semantic") {
      const record = await plane.semanticStore.get(parsed.id);
      if (record === undefined) throw new Error("memory_item_not_found");
      return DesktopMemoryItemSchema.parse(toDesktopFact(record));
    }
    const record = await plane.knowledgeStore.get(parsed.id);
    if (record === undefined) throw new Error("memory_item_not_found");
    return DesktopMemoryItemSchema.parse(toDesktopKnowledge(record));
  });
  ipcMain.handle("memory-items:history", async (_event, input: unknown) => {
    const parsed = DesktopMemoryItemRefSchema.parse(input);
    return DesktopMemoryItemListSchema.parse(
      parsed.module === "episodic"
        ? (await plane.episodicStore.history(parsed.id)).map(toDesktopEpisode)
        : parsed.module === "semantic"
          ? (await plane.semanticStore.history(parsed.id)).map(toDesktopFact)
          : (await plane.knowledgeStore.history(parsed.id)).map(toDesktopKnowledge),
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
    const result = await plane.tightenMemoryAccess(parsed);
    return DesktopMemoryItemSchema.parse(
      result.module === "episodic"
        ? toDesktopEpisode(result.record)
        : result.module === "semantic"
          ? toDesktopFact(result.record)
          : toDesktopKnowledge(result.record),
    );
  });
  ipcMain.handle("memory-items:invalidate", async (_event, input: unknown) => {
    const parsed = ReviewDesktopMemoryItemSchema.parse(input);
    const result = await plane.invalidateMemoryItem(parsed);
    return DesktopMemoryItemSchema.parse(
      result.module === "episodic"
        ? toDesktopEpisode(result.record)
        : result.module === "semantic"
          ? toDesktopFact(result.record)
          : toDesktopKnowledge(result.record),
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
  ipcMain.handle("memory-knowledge-jobs:list", async () =>
    DesktopKnowledgeJobListSchema.parse(await plane.knowledgeStore.listJobs()),
  );
  ipcMain.handle("memory-knowledge-jobs:retry", async (_event, input: unknown) => {
    const parsed = RetryDesktopKnowledgeJobSchema.parse(input);
    await plane.knowledgeStore.retryJob({ ...parsed, now: new Date() });
    const job = (await plane.knowledgeStore.listJobs()).find(
      (candidate) => candidate.id === parsed.id,
    );
    if (job === undefined) throw new Error("knowledge_job_not_found");
    return DesktopKnowledgeJobSchema.parse(job);
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

function toDesktopEpisode(record: import("@pragma/memory").EpisodicMemoryRecord) {
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

function toDesktopFact(record: import("@pragma/shared").SemanticFact) {
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

function toDesktopKnowledge(record: import("@pragma/shared").Knowledge) {
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
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    guidance: record.content.guidance,
    normalizedKey: record.content.normalizedKey,
    sourceRefs: record.sourceRefs,
    origin: record.origin.kind,
  };
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

async function toDesktopExtractionJob(
  module: "episodic" | "semantic",
  job:
    import("@pragma/memory").EpisodicExtractionJob | import("@pragma/memory").SemanticExtractionJob,
  store:
    import("@pragma/memory").EpisodicMemoryStore | import("@pragma/memory").SemanticMemoryStore,
  missions?: MissionStore,
) {
  const hasPayload = ["waiting_idle", "pending", "running", "needs_attention"].includes(job.status);
  const evidence = hasPayload
    ? module === "episodic"
      ? await (store as import("@pragma/memory").EpisodicMemoryStore).readEvidenceForJob(
          job as import("@pragma/memory").EpisodicExtractionJob,
        )
      : await (store as import("@pragma/memory").SemanticMemoryStore).readEvidenceForJob(
          job as import("@pragma/memory").SemanticExtractionJob,
        )
    : [];
  const omitted =
    module === "episodic"
      ? await (store as import("@pragma/memory").EpisodicMemoryStore).readOmissionStatsForJob(
          job as import("@pragma/memory").EpisodicExtractionJob,
        )
      : await (store as import("@pragma/memory").SemanticMemoryStore).readOmissionStatsForJob(
          job as import("@pragma/memory").SemanticExtractionJob,
        );
  const conversationTitle =
    missions !== undefined && job.conversationRef.type === "pragma.mission"
      ? await missions
          .get(job.conversationRef.id)
          .then((mission) => (mission.origin.type === "user" ? mission.title : undefined))
          .catch(() => undefined)
      : undefined;
  return {
    module,
    id: job.id,
    revision: job.revision,
    status: job.status,
    conversationRef: job.conversationRef,
    ...(conversationTitle === undefined ? {} : { conversationTitle }),
    sourceExecutionCount: job.sourceExecutionIds.length,
    sourceUpdatedAt: job.sourceUpdatedAt,
    ...(job.eligibleAt === undefined ? {} : { eligibleAt: job.eligibleAt }),
    attempts: job.attempts,
    totalAttempts: job.totalAttempts,
    ...(job.lastErrorCode === undefined ? {} : { lastErrorCode: job.lastErrorCode }),
    ...(job.failureClass === undefined ? {} : { failureClass: job.failureClass }),
    evidenceRecords: evidence.length,
    evidenceBytes: evidence.reduce(
      (total, item) => total + Buffer.byteLength(JSON.stringify(item)),
      0,
    ),
    omittedRecords: omitted.records,
    updatedAt: job.updatedAt,
    ...(job.attentionSince === undefined ? {} : { attentionSince: job.attentionSince }),
    ...(job.completedAt === undefined ? {} : { completedAt: job.completedAt }),
    ...(job.expiredAt === undefined ? {} : { expiredAt: job.expiredAt }),
  };
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
