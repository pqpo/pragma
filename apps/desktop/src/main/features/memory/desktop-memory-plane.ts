import {
  EXECUTION_CURRENT_EXPERT_ID_ATTR,
  readExecutionRunScope,
  createFileCanonicalEventFeed,
  createFileExecutionStore,
  type FileExecutionStore,
  type ExpertAgentRunContext,
  type PragmaLogger,
} from "@pragma/core";
import {
  MemoryModuleRegistry,
  createEpisodicMemoryModule,
  createKnowledgeMemoryModule,
  createKnowledgeSourceReader,
  createSemanticMemoryModule,
  createFileMemoryExtractionSettingsStore,
  createFileMemoryExtractorProfileStore,
  createExecutionEvidenceAdapter,
  createFederatedMemoryContextStore,
  createFileMemoryPolicyStore,
  createFileMemoryPipelineStateStore,
  createMemoryEvidenceFeed,
  createMemoryEvidencePublisher,
  createMemoryPipelineScheduler,
  createMemoryActivityStore,
  MemoryRecallScopeSchema,
  type MemoryPolicyStore,
  type MemoryRecallScope,
  type EpisodicMemoryExtractor,
  type KnowledgeMemoryExtractor,
  type KnowledgeMemoryStore,
  type MemoryExtractorProfileStore,
  type MemoryExtractionSettingsStore,
  type SemanticMemoryExtractor,
  type SemanticMemoryStore,
  type EpisodicMemoryStore,
  type MemoryActivityStore,
  DEFAULT_MEMORY_STORAGE_POLICY,
  EXECUTION_EVIDENCE_ADAPTER_ID,
} from "@pragma/memory";

import { createDesktopMemorySubjectIdentityStore } from "./memory-subject-identity.ts";
import { createMemoryCleanupJournal } from "./memory-cleanup-journal.ts";

export type DesktopMemoryMutationResult =
  | {
      readonly module: "episodic";
      readonly record: import("@pragma/memory").EpisodicMemoryRecord;
    }
  | {
      readonly module: "semantic";
      readonly record: import("@pragma/shared").SemanticFact;
    }
  | {
      readonly module: "knowledge";
      readonly record: import("@pragma/shared").Knowledge;
    };

export interface DesktopMemoryPlane {
  readonly executionStore: FileExecutionStore;
  readonly policies: MemoryPolicyStore;
  readonly extractorProfiles: MemoryExtractorProfileStore;
  readonly extractionSettings: MemoryExtractionSettingsStore;
  readonly semanticStore: SemanticMemoryStore;
  readonly episodicStore: EpisodicMemoryStore;
  readonly knowledgeStore: KnowledgeMemoryStore;
  readonly activity: MemoryActivityStore;
  readonly contextStore: import("@pragma/core").ExpertAgentContextStore;
  setEpisodicExtractor(extractor: EpisodicMemoryExtractor | undefined): Promise<void>;
  setSemanticExtractor(extractor: SemanticMemoryExtractor | undefined): Promise<void>;
  setKnowledgeExtractor(extractor: KnowledgeMemoryExtractor | undefined): Promise<void>;
  publishKnowledgeCandidate(
    input: Omit<Parameters<KnowledgeMemoryStore["publishCandidate"]>[0], "actorRef" | "now">,
  ): Promise<import("@pragma/shared").Knowledge>;
  createKnowledgeSuccessor(
    input: Omit<Parameters<KnowledgeMemoryStore["createSuccessor"]>[0], "actorRef" | "now">,
  ): Promise<import("@pragma/shared").KnowledgeCandidate>;
  registerMemoryExecutionContext(input: {
    readonly executionId: string;
    readonly missionId: string;
    readonly projectId: string;
  }): Promise<void>;
  setMemoryConversationState(input: {
    readonly missionId: string;
    readonly state: "active" | "running" | "completed";
  }): Promise<void>;
  reviseSemanticFact(
    input: Omit<Parameters<SemanticMemoryStore["revise"]>[0], "actorRef" | "now">,
  ): Promise<import("@pragma/shared").SemanticFact>;
  verifySemanticFact(
    input: Omit<Parameters<SemanticMemoryStore["verify"]>[0], "actorRef" | "now">,
  ): Promise<import("@pragma/shared").SemanticFact>;
  tightenMemoryAccess(input: {
    readonly module: "episodic" | "semantic" | "knowledge";
    readonly id: string;
    readonly expectedRevision: number;
    readonly reason: string;
    readonly bindings?: import("@pragma/shared").MemoryRevisionBinding[] | undefined;
    readonly visibility?: import("@pragma/shared").MemoryVisibilityPolicy | undefined;
  }): Promise<DesktopMemoryMutationResult>;
  invalidateMemoryItem(input: {
    readonly module: "episodic" | "semantic" | "knowledge";
    readonly id: string;
    readonly expectedRevision: number;
    readonly reason: string;
  }): Promise<DesktopMemoryMutationResult>;
  forgetMemoryItem(input: {
    readonly module: "episodic" | "semantic";
    readonly id: string;
    readonly expectedRevision: number;
    readonly reason: string;
  }): Promise<void>;
  wakeMemoryJobs(): Promise<void>;
  manageMemoryJob(input: {
    readonly module: "episodic" | "semantic" | "knowledge";
    readonly action: "expedite" | "retry" | "interrupt" | "delete";
    readonly id: string;
    readonly expectedRevision: number;
  }): Promise<void>;
  deleteExecutionState(executionIds: readonly string[]): Promise<void>;
  maintainStorage(): Promise<void>;
  getStatus(): Promise<{
    readonly state: "running" | "stopped" | "degraded";
    readonly feed: import("@pragma/core").CanonicalEventFeedDiagnostic & {
      readonly safeThroughSequence: number;
      readonly blockedBytes: number;
    };
    readonly delivery: { readonly pending: number; readonly quarantined: number };
    readonly lastError?: { readonly code: string; readonly occurredAt: string } | undefined;
    readonly modules: readonly import("@pragma/shared").MemoryModuleDiagnostic[];
    readonly storagePolicy: Readonly<Record<string, string | number>>;
    readonly maintenance: {
      readonly lastRunAt?: string | undefined;
      readonly deletedEvents: number;
      readonly reclaimedBytes: number;
      readonly deletedDeadLetters: number;
      readonly deadLetterEntries: number;
      readonly deadLetterBytes: number;
    };
  }>;
  start(): void;
  stop(): Promise<void>;
}

export function resolveMemoryModuleHealthStatus(
  status: "healthy" | "degraded" | "unavailable",
  needsAttention: number,
): "healthy" | "degraded" | "unavailable" {
  return needsAttention > 0 && status === "healthy" ? "degraded" : status;
}

export async function createDesktopMemoryPlane(options: {
  readonly pragmaHome: string;
  readonly logger: PragmaLogger;
  readonly pollIntervalMs?: number | undefined;
}): Promise<DesktopMemoryPlane> {
  const canonical = await createFileCanonicalEventFeed({ pragmaHome: options.pragmaHome });
  const executionStore = createFileExecutionStore({
    pragmaHome: options.pragmaHome,
    canonicalEventFeed: canonical,
    onCanonicalEventDeliveryError: (error, context) => {
      options.logger.warn(
        "desktop.memory_event_delivery_deferred",
        "A canonical event handoff was preserved for background recovery.",
        { ...context, error },
      );
    },
  });
  const state = createFileMemoryPipelineStateStore({ pragmaHome: options.pragmaHome });
  const policies = createFileMemoryPolicyStore({ pragmaHome: options.pragmaHome });
  const extractorProfiles = createFileMemoryExtractorProfileStore({
    pragmaHome: options.pragmaHome,
  });
  const extractionSettings = createFileMemoryExtractionSettingsStore({
    pragmaHome: options.pragmaHome,
  });
  const publisher = createMemoryEvidencePublisher(canonical);
  const registry = new MemoryModuleRegistry();
  const episodic = await createEpisodicMemoryModule({
    pragmaHome: options.pragmaHome,
    extractionSettings,
  });
  const semantic = await createSemanticMemoryModule({
    pragmaHome: options.pragmaHome,
    extractionSettings,
  });
  const knowledge = await createKnowledgeMemoryModule({
    pragmaHome: options.pragmaHome,
    sourceReader: createKnowledgeSourceReader({
      episodic: episodic.store,
      semantic: semantic.store,
    }),
  });
  const subjectIdentities = createDesktopMemorySubjectIdentityStore({
    pragmaHome: options.pragmaHome,
  });
  const activity = createMemoryActivityStore({ pragmaHome: options.pragmaHome });
  const cleanup = createMemoryCleanupJournal({
    pragmaHome: options.pragmaHome,
    feed: canonical,
    episodic: episodic.store,
    semantic: semantic.store,
  });
  registry.register(episodic);
  registry.register(knowledge);
  registry.register(semantic);
  const contextStore = createFederatedMemoryContextStore(registry, {
    resolveRecallScope: async (context) => {
      const executionId = readExecutionRunScope(context).executionId;
      const executionContext =
        executionId === undefined ? undefined : await activity.getExecutionContext(executionId);
      return await resolveDesktopMemoryRecallScope(
        policies,
        context,
        new Date(),
        executionContext?.principalRefs ?? [],
      );
    },
    activity,
  });
  const adapter = createExecutionEvidenceAdapter({
    source: canonical,
    publisher,
    checkpoints: state,
    deadLetters: state,
    policies,
    activity,
  });
  const scheduler = createMemoryPipelineScheduler({
    registry,
    feed: createMemoryEvidenceFeed(canonical),
    publisher,
    checkpoints: state,
    deadLetters: state,
    outbox: state,
  });
  let stopped = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let lastError: { readonly code: string; readonly occurredAt: string } | undefined;
  let reportedExtractionIssues = new Set<string>();
  let maintenanceRunning: Promise<void> | undefined;
  let lastMaintenanceAtMs = 0;
  let safeThroughSequence = 0;
  let blockedBytes = 0;
  let maintenanceDiagnostic: {
    readonly lastRunAt?: string | undefined;
    readonly deletedEvents: number;
    readonly reclaimedBytes: number;
    readonly deletedDeadLetters: number;
    readonly deadLetterEntries: number;
    readonly deadLetterBytes: number;
  } = {
    deletedEvents: 0,
    reclaimedBytes: 0,
    deletedDeadLetters: 0,
    deadLetterEntries: 0,
    deadLetterBytes: 0,
  };

  const maintainStorage = async (): Promise<void> => {
    if (maintenanceRunning !== undefined) return await maintenanceRunning;
    maintenanceRunning = (async () => {
      const maintenanceNow = new Date();
      await cleanup.recover();
      const consumerIds = [
        EXECUTION_EVIDENCE_ADAPTER_ID,
        ...registry.list().map((module) => module.descriptor.id),
      ];
      const checkpoints = await Promise.all(consumerIds.map(async (id) => await state.read(id)));
      safeThroughSequence = Math.min(...checkpoints.map((checkpoint) => checkpoint.sequence));
      const feed = await canonical.maintain({
        safeThrough: { sequence: safeThroughSequence },
        retainAfter: new Date(
          maintenanceNow.getTime() - DEFAULT_MEMORY_STORAGE_POLICY.canonicalFeedRetentionMs,
        ).toISOString(),
        targetBytes: DEFAULT_MEMORY_STORAGE_POLICY.canonicalFeedTargetBytes,
      });
      await Promise.all([
        episodic.store.maintain(maintenanceNow),
        knowledge.store.maintain(maintenanceNow),
        semantic.store.maintain(maintenanceNow),
      ]);
      const pipeline = await state.maintain(maintenanceNow);
      const deadLetters = await state.inspectDeadLetters();
      blockedBytes = feed.blockedBytes;
      lastMaintenanceAtMs = maintenanceNow.getTime();
      maintenanceDiagnostic = {
        lastRunAt: maintenanceNow.toISOString(),
        deletedEvents: feed.deletedEvents,
        reclaimedBytes: feed.reclaimedLogicalBytes,
        deletedDeadLetters: pipeline.deletedDeadLetters,
        deadLetterEntries: deadLetters.entries,
        deadLetterBytes: deadLetters.bytes,
      };
    })();
    try {
      await maintenanceRunning;
    } finally {
      maintenanceRunning = undefined;
    }
  };

  const markDegraded = (code: string, error?: unknown): void => {
    if (lastError?.code === code) return;
    lastError = { code, occurredAt: new Date().toISOString() };
    options.logger.error(
      "desktop.memory_pipeline_degraded",
      "The Memory pipeline is degraded and will keep retrying.",
      error ?? new Error(code),
      { code },
    );
  };

  const schedule = (): void => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      running = tick().finally(() => {
        running = undefined;
        schedule();
      });
    }, options.pollIntervalMs ?? 1_000);
  };

  const reportExtractionIssues = (
    issues: readonly {
      readonly moduleId: string;
      readonly work: {
        readonly needsAttention: number;
        readonly lastErrorCode?: string | undefined;
      };
    }[],
  ): void => {
    const current = new Set<string>();
    for (const issue of issues) {
      const code = issue.work.lastErrorCode ?? "memory_extraction_needs_attention";
      const key = `${issue.moduleId}\0${code}`;
      current.add(key);
      if (reportedExtractionIssues.has(key)) continue;
      options.logger.error(
        "desktop.memory_extraction_needs_attention",
        "A Memory extraction module has jobs that need attention.",
        new Error(
          `${issue.moduleId} has ${issue.work.needsAttention} extraction job(s) that need attention.`,
        ),
        { moduleId: issue.moduleId, code, needsAttention: issue.work.needsAttention },
      );
    }
    reportedExtractionIssues = current;
  };

  const tick = async (): Promise<void> => {
    try {
      const recovery = await executionStore.recoverPendingCanonicalEvents();
      const adapted = await adapter.runOnce();
      await scheduler.runOnce();
      if (Date.now() - lastMaintenanceAtMs >= DEFAULT_MEMORY_STORAGE_POLICY.maintenanceIntervalMs) {
        await maintainStorage();
      }
      const [episodicWork, knowledgeWork, semanticWork] = await Promise.all([
        episodic.store.inspect(),
        knowledge.store.inspect(),
        semantic.store.inspect(),
      ]);
      const extractionIssues = [
        { moduleId: episodic.descriptor.id, work: episodicWork },
        { moduleId: knowledge.descriptor.id, work: knowledgeWork },
        { moduleId: semantic.descriptor.id, work: semanticWork },
      ].filter((item) => item.work.needsAttention > 0);
      reportExtractionIssues(extractionIssues);
      if (recovery.quarantined > 0) {
        markDegraded("canonical_event_handoff_quarantined");
      } else if (recovery.failed > 0) {
        markDegraded("canonical_event_delivery_failed");
      } else if (extractionIssues[0] !== undefined) {
        const extractionIssue = extractionIssues[0];
        const code = extractionIssue.work.lastErrorCode ?? "memory_extraction_needs_attention";
        markDegraded(
          code,
          new Error(
            `${extractionIssue.moduleId} has ${extractionIssue.work.needsAttention} extraction job(s) that need attention.`,
          ),
        );
      } else {
        lastError = undefined;
      }
      if (recovery.recovered > 0 || adapted.published > 0) {
        options.logger.info("desktop.memory_pipeline_progress", "Memory pipeline advanced.", {
          recovered: recovery.recovered,
          pending: recovery.pending,
          failed: recovery.failed,
          published: adapted.published,
          skipped: adapted.skipped,
        });
      }
    } catch (error) {
      markDegraded("memory_pipeline_iteration_failed", error);
    }
  };

  return {
    executionStore,
    policies,
    extractorProfiles,
    extractionSettings,
    semanticStore: semantic.store,
    episodicStore: episodic.store,
    knowledgeStore: knowledge.store,
    activity,
    contextStore,
    async setEpisodicExtractor(extractor) {
      await episodic.setExtractor(extractor);
      scheduler.wake();
    },
    async setSemanticExtractor(extractor) {
      await semantic.setExtractor(extractor);
      scheduler.wake();
    },
    async setKnowledgeExtractor(extractor) {
      await knowledge.setExtractor(extractor);
      scheduler.wake();
    },
    async publishKnowledgeCandidate(input) {
      return await knowledge.store.publishCandidate({
        ...input,
        actorRef: await subjectIdentities.getLocalUserRef(),
        now: new Date(),
      });
    },
    async createKnowledgeSuccessor(input) {
      return await knowledge.store.createSuccessor({
        ...input,
        actorRef: await subjectIdentities.getLocalUserRef(),
        now: new Date(),
      });
    },
    async registerMemoryExecutionContext(input) {
      const localUser = await subjectIdentities.getLocalUserRef();
      const principalRefs = [localUser, { type: "pragma.project" as const, id: input.projectId }];
      const conversationRef = { type: "pragma.mission" as const, id: input.missionId };
      await activity.registerExecutionContext({
        executionId: input.executionId,
        conversationRef,
        principalRefs,
      });
      const now = new Date();
      await Promise.all([
        semantic.registerExecutionSubjects({
          executionId: input.executionId,
          subjectRefs: principalRefs,
        }),
        episodic.bindExecutionConversation({
          executionId: input.executionId,
          conversationRef,
          now,
        }),
        semantic.bindExecutionConversation({
          executionId: input.executionId,
          conversationRef,
          now,
        }),
      ]);
      await Promise.all([
        episodic.setConversationState({ conversationRef, state: "running", now }),
        semantic.setConversationState({ conversationRef, state: "running", now }),
      ]);
      scheduler.wake();
    },
    async setMemoryConversationState(input) {
      const conversationRef = { type: "pragma.mission" as const, id: input.missionId };
      const now = new Date();
      await Promise.all([
        episodic.setConversationState({ conversationRef, state: input.state, now }),
        semantic.setConversationState({ conversationRef, state: input.state, now }),
      ]);
      scheduler.wake();
    },
    async reviseSemanticFact(input) {
      return await semantic.store.revise({
        ...input,
        actorRef: await subjectIdentities.getLocalUserRef(),
        now: new Date(),
      });
    },
    async verifySemanticFact(input) {
      return await semantic.store.verify({
        ...input,
        actorRef: await subjectIdentities.getLocalUserRef(),
        now: new Date(),
      });
    },
    async tightenMemoryAccess(input) {
      const actorRef = await subjectIdentities.getLocalUserRef();
      const common = {
        id: input.id,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
        actorRef,
        now: new Date(),
        ...(input.bindings === undefined ? {} : { bindings: input.bindings }),
        ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      };
      if (input.module === "episodic") {
        return { module: "episodic", record: await episodic.store.tightenAccess(common) };
      }
      if (input.module === "semantic") {
        return { module: "semantic", record: await semantic.store.tightenAccess(common) };
      }
      return { module: "knowledge", record: await knowledge.store.tightenAccess(common) };
    },
    async invalidateMemoryItem(input) {
      const common = {
        id: input.id,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
        actorRef: await subjectIdentities.getLocalUserRef(),
        now: new Date(),
      };
      if (input.module === "episodic") {
        return { module: "episodic", record: await episodic.store.invalidate(common) };
      }
      if (input.module === "semantic") {
        return { module: "semantic", record: await semantic.store.invalidate(common) };
      }
      return { module: "knowledge", record: await knowledge.store.withdraw(common) };
    },
    async forgetMemoryItem(input) {
      const common = {
        id: input.id,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
        actorRef: await subjectIdentities.getLocalUserRef(),
        now: new Date(),
      };
      if (input.module === "episodic") await episodic.store.forget(common);
      else await semantic.store.forget(common);
    },
    async wakeMemoryJobs() {
      await Promise.all([
        episodic.store.wakeNeedsAttention(new Date(), "configuration"),
        knowledge.store.wakeNeedsAttention(new Date(), "configuration"),
        semantic.store.wakeNeedsAttention(new Date(), "configuration"),
      ]);
      scheduler.wake();
    },
    async manageMemoryJob(input) {
      const command = {
        id: input.id,
        expectedRevision: input.expectedRevision,
        now: new Date(),
      };
      const store =
        input.module === "episodic"
          ? episodic.store
          : input.module === "semantic"
            ? semantic.store
            : knowledge.store;
      if (input.action === "expedite") await store.expediteJob(command);
      else if (input.action === "retry") await store.retryJob(command);
      else if (input.action === "delete") await store.deleteJob(command);
      else if (input.action === "interrupt") {
        // Interrupt routes through the Module so the persisted transition and in-flight abort agree.
        if (input.module === "episodic") await episodic.interruptExtractionJob(command);
        else if (input.module === "semantic") await semantic.interruptExtractionJob(command);
        else await knowledge.interruptExtractionJob(command);
      } else {
        const unsupported: never = input.action;
        throw new Error(`memory_extraction_job_action_unsupported:${String(unsupported)}`);
      }
      scheduler.wake();
    },
    async deleteExecutionState(executionIds) {
      await cleanup.cleanup(executionIds);
      await maintainStorage();
    },
    async maintainStorage() {
      await maintainStorage();
    },
    async getStatus() {
      const delivery = await executionStore.inspectCanonicalEventDelivery();
      const modules: import("@pragma/shared").MemoryModuleDiagnostic[] = [];
      for (const module of registry.list()) {
        const diagnostic = registry.diagnostic(module.descriptor.id);
        if (diagnostic === undefined) continue;
        if (
          module.descriptor.id !== episodic.descriptor.id &&
          module.descriptor.id !== semantic.descriptor.id &&
          module.descriptor.id !== knowledge.descriptor.id
        ) {
          modules.push(diagnostic);
          continue;
        }
        let work: NonNullable<import("@pragma/shared").MemoryModuleDiagnostic["work"]> & {
          readonly lastErrorCode?: string | undefined;
        };
        if (module.descriptor.id === episodic.descriptor.id) {
          const diagnostic = await episodic.store.inspect();
          work = {
            records: diagnostic.episodes,
            pending: diagnostic.pending,
            running: diagnostic.running,
            needsAttention: diagnostic.needsAttention,
            rejected: diagnostic.rejected,
            expired: diagnostic.expired,
            evidenceRecords: diagnostic.evidenceRecords,
            evidenceBytes: diagnostic.evidenceBytes,
            truncatedExecutions: diagnostic.truncatedExecutions,
            lastErrorCode: diagnostic.lastErrorCode,
          };
        } else if (module.descriptor.id === semantic.descriptor.id) {
          const diagnostic = await semantic.store.inspect();
          work = {
            records: diagnostic.facts,
            pending: diagnostic.pending,
            running: diagnostic.running,
            needsAttention: diagnostic.needsAttention,
            rejected: diagnostic.rejected,
            expired: diagnostic.expired,
            evidenceRecords: diagnostic.evidenceRecords,
            evidenceBytes: diagnostic.evidenceBytes,
            truncatedExecutions: diagnostic.truncatedExecutions,
            lastErrorCode: diagnostic.lastErrorCode,
          };
        } else {
          const diagnostic = await knowledge.store.inspect();
          work = {
            records: diagnostic.knowledge,
            pending: diagnostic.pending,
            running: diagnostic.running,
            needsAttention: diagnostic.needsAttention,
            rejected: diagnostic.rejected,
            expired: 0,
            evidenceRecords: 0,
            evidenceBytes: 0,
            truncatedExecutions: 0,
            lastErrorCode: diagnostic.lastErrorCode,
          };
        }
        modules.push({
          ...diagnostic,
          status: resolveMemoryModuleHealthStatus(diagnostic.status, work.needsAttention),
          ...(work.lastErrorCode === undefined ? {} : { lastErrorCode: work.lastErrorCode }),
          work: {
            records: work.records,
            pending: work.pending,
            running: work.running,
            needsAttention: work.needsAttention,
            rejected: work.rejected,
            expired: work.expired,
            evidenceRecords: work.evidenceRecords,
            evidenceBytes: work.evidenceBytes,
            truncatedExecutions: work.truncatedExecutions,
          },
        });
      }
      return {
        state: stopped
          ? "stopped"
          : lastError !== undefined ||
              delivery.quarantined > 0 ||
              blockedBytes > 0 ||
              modules.some((module) => module.status !== "healthy")
            ? "degraded"
            : "running",
        feed: {
          ...(await canonical.inspect()),
          safeThroughSequence,
          blockedBytes,
        },
        delivery,
        ...(lastError === undefined ? {} : { lastError }),
        modules,
        storagePolicy: desktopStoragePolicy(),
        maintenance: maintenanceDiagnostic,
      };
    },
    start() {
      if (!stopped) return;
      stopped = false;
      running = tick().finally(() => {
        running = undefined;
        schedule();
      });
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await running;
      await maintenanceRunning;
      await scheduler.stop();
      episodic.close();
      knowledge.close();
      semantic.close();
      canonical.close();
    },
  };
}

export async function resolveDesktopMemoryRecallScope(
  policies: Pick<MemoryPolicyStore, "resolveAt">,
  context: ExpertAgentRunContext | undefined,
  now: Date = new Date(),
  principalRefs: readonly import("@pragma/shared").MemorySubjectRef[] = [],
): Promise<MemoryRecallScope | undefined> {
  const source = context?.source;
  const currentExpertId = context?.attributes?.[EXECUTION_CURRENT_EXPERT_ID_ATTR];
  const scope = MemoryRecallScopeSchema.safeParse({
    rootRef: { type: source?.type, id: source?.id },
    expertRef: { type: "pragma.expert", id: currentExpertId },
    ...(principalRefs.length === 0 ? {} : { principalRefs }),
  });
  if (!scope.success) return undefined;
  const policy = await policies.resolveAt({
    rootRef: scope.data.rootRef,
    producerRefs: [scope.data.expertRef],
    occurredAt: now.toISOString(),
  });
  return policy.recall ? scope.data : undefined;
}

function desktopStoragePolicy(): Readonly<Record<string, string | number>> {
  return {
    schemaVersion: DEFAULT_MEMORY_STORAGE_POLICY.schemaVersion,
    canonicalFeedRetentionDays: 30,
    canonicalFeedTargetBytes: DEFAULT_MEMORY_STORAGE_POLICY.canonicalFeedTargetBytes,
    evidenceMaxRecordsPerExecution: DEFAULT_MEMORY_STORAGE_POLICY.evidenceMaxRecordsPerExecution,
    evidenceMaxBytesPerExecution: DEFAULT_MEMORY_STORAGE_POLICY.evidenceMaxBytesPerExecution,
    extractionPromptMaxBytes: DEFAULT_MEMORY_STORAGE_POLICY.extractionPromptMaxBytes,
    extractionIdleHours: DEFAULT_MEMORY_STORAGE_POLICY.extractionIdleMs / 3_600_000,
    jobRecordRetentionDays: 30,
    failedPayloadRetentionDays: 30,
    deadLetterRetentionDays: 30,
    deadLetterMaxEntries: DEFAULT_MEMORY_STORAGE_POLICY.deadLetterMaxEntries,
    deadLetterMaxBytes: DEFAULT_MEMORY_STORAGE_POLICY.deadLetterMaxBytes,
  };
}
