import { readExecutionRunScope, type FileExecutionStore, type PragmaLogger } from "@pragma/core";
import {
  createFederatedMemoryContextStore,
  MemoryRecallScopeSchema,
  type MemoryPolicyStore,
  type MemoryRecallScope,
  type EpisodicMemoryExtractor,
  type KnowledgeLearningPlanner,
  type KnowledgeMemoryModule,
  type KnowledgeLearningSink,
  type SkillLearningSink,
  type SkillLearningTargetReader,
  type SkillLearningPlanner,
  type SkillMemoryModule,
  type MemoryExtractorProfileStore,
  type MemoryExtractionSettingsStore,
  type SemanticMemoryExtractor,
  type SemanticMemoryStore,
  type EpisodicMemoryStore,
  type MemoryActivityStore,
  DEFAULT_MEMORY_STORAGE_POLICY,
  EXECUTION_EVIDENCE_ADAPTER_ID,
} from "@pragma/memory";

import {
  createLocalHostMemoryDataPlane,
  createLocalHostMemorySubjectIdentityStore,
  resolveMemoryRecallScope,
  createLocalHostMemoryContextService,
} from "@pragma/local-host";
import { createMemoryCleanupJournal } from "./memory-cleanup-journal.ts";

export type DesktopMemoryMutationResult =
  | {
      readonly module: "episodic";
      readonly record: import("@pragma/memory").EpisodicMemoryRecord;
    }
  | {
      readonly module: "semantic";
      readonly record: import("@pragma/shared").SemanticFact;
    };

export interface DesktopMemoryContextStoreViewInput {
  readonly rootRef: MemoryRecallScope["rootRef"];
  readonly expertRef?: MemoryRecallScope["expertRef"] | undefined;
  readonly projectId: string;
  readonly policyScope?:
    | {
        readonly rootRef: MemoryRecallScope["rootRef"];
        readonly producerRefs?: readonly NonNullable<MemoryRecallScope["expertRef"]>[] | undefined;
      }
    | undefined;
}

export type DesktopMemoryContextStoreViewStatus = "available" | "empty" | "recall_disabled";

export interface DesktopMemoryPlane {
  readonly executionStore: FileExecutionStore;
  readonly policies: MemoryPolicyStore;
  readonly extractorProfiles: MemoryExtractorProfileStore;
  readonly extractionSettings: MemoryExtractionSettingsStore;
  readonly semanticStore: SemanticMemoryStore;
  readonly episodicStore: EpisodicMemoryStore;
  readonly knowledgeLearningStore: KnowledgeMemoryModule["store"];
  readonly skillLearningStore: SkillMemoryModule["store"];
  readonly activity: MemoryActivityStore;
  readonly contextStore: import("@pragma/core").ExpertAgentContextStore;
  readonly attentionSettings:
    ReturnType<typeof createLocalHostMemoryContextService>["settings"] | undefined;
  createMissionContextStore(input: {
    missionId: string;
    goal: string;
    projectId?: string;
  }): import("@pragma/core").ExpertAgentContextStore;
  stopMissionAttention(missionId: string): Promise<void>;
  getContextStoreViewStatus(
    input: DesktopMemoryContextStoreViewInput,
  ): Promise<DesktopMemoryContextStoreViewStatus>;
  createContextStoreView(
    input: DesktopMemoryContextStoreViewInput,
  ): Promise<import("@pragma/core").ExpertAgentContextStore>;
  setEpisodicExtractor(extractor: EpisodicMemoryExtractor | undefined): Promise<void>;
  setSemanticExtractor(extractor: SemanticMemoryExtractor | undefined): Promise<void>;
  setKnowledgePlanner(planner: KnowledgeLearningPlanner | undefined): Promise<void>;
  setSkillPlanner(planner: SkillLearningPlanner | undefined): Promise<void>;
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
    readonly module: "episodic" | "semantic";
    readonly id: string;
    readonly expectedRevision: number;
    readonly reason: string;
    readonly bindings?: import("@pragma/shared").MemoryRevisionBinding[] | undefined;
    readonly visibility?: import("@pragma/shared").MemoryVisibilityPolicy | undefined;
  }): Promise<DesktopMemoryMutationResult>;
  invalidateMemoryItem(input: {
    readonly module: "episodic" | "semantic";
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
  wakeRevisionLearningJobs(): Promise<void>;
  wakePipeline(): void;
  manageMemoryJob(input: {
    readonly module: "episodic" | "semantic" | "knowledge" | "skill";
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
  readonly onTick?: (() => Promise<void>) | undefined;
  readonly secrets?: import("@pragma/local-host").SecretStore | undefined;
  readonly knowledgeLearningSink?: KnowledgeLearningSink | undefined;
  readonly skillLearningSink?: SkillLearningSink | undefined;
  readonly skillLearningTargetReader?: SkillLearningTargetReader | undefined;
}): Promise<DesktopMemoryPlane> {
  const data = await createLocalHostMemoryDataPlane(options);
  const {
    canonical,
    executionStore,
    state,
    policies,
    extractorProfiles,
    extractionSettings,
    registry,
    episodic,
    semantic,
    knowledge,
    skill,
    activity,
    scheduler,
    flushDelivery,
    registerExecutionContext,
    setConversationState,
  } = data;
  const attention =
    options.secrets === undefined
      ? undefined
      : createLocalHostMemoryContextService({
          pragmaHome: options.pragmaHome,
          data,
          secrets: options.secrets,
          onDiagnostic: (code) => {
            if (code !== undefined)
              options.logger.warn("memory.attention_degraded", "Memory Attention is degraded.", {
                subsystem: "memory.attention",
                code,
              });
          },
        });
  const subjectIdentities = createLocalHostMemorySubjectIdentityStore({
    pragmaHome: options.pragmaHome,
  });
  const cleanup = createMemoryCleanupJournal({
    pragmaHome: options.pragmaHome,
    feed: canonical,
    episodic: episodic.store,
    semantic: semantic.store,
  });
  const contextStore = createFederatedMemoryContextStore(registry, {
    resolveRecallScope: async (context) => {
      const executionId = readExecutionRunScope(context).executionId;
      const executionContext =
        executionId === undefined ? undefined : await activity.getExecutionContext(executionId);
      return await resolveMemoryRecallScope(
        policies,
        context,
        new Date(),
        executionContext?.principalRefs ?? [],
      );
    },
    activity,
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
  let nextPollDelayMs = options.pollIntervalMs ?? 1_000;
  let wakeRequested = false;
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
        skill.store.maintain(maintenanceNow),
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
        if (wakeRequested) {
          wakeRequested = false;
          wakePipeline();
        } else schedule();
      });
    }, nextPollDelayMs);
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
      const learningEnabled = (await policies.getGlobal()).policy.enabled === "enabled";
      nextPollDelayMs = learningEnabled ? (options.pollIntervalMs ?? 1_000) : 30_000;
      const adapted = await flushDelivery();
      await scheduler.runBackgroundOnce();
      await options.onTick?.();
      if (Date.now() - lastMaintenanceAtMs >= DEFAULT_MEMORY_STORAGE_POLICY.maintenanceIntervalMs) {
        await maintainStorage();
      }
      const [episodicWork, knowledgeWork, semanticWork, skillWork] = await Promise.all([
        episodic.store.inspect(),
        knowledge.store.inspect(),
        semantic.store.inspect(),
        skill.store.inspect(),
      ]);
      const extractionIssues = [
        { moduleId: episodic.descriptor.id, work: episodicWork },
        { moduleId: knowledge.descriptor.id, work: knowledgeWork },
        { moduleId: semantic.descriptor.id, work: semanticWork },
        { moduleId: skill.descriptor.id, work: skillWork },
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

  const wakePipeline = (): void => {
    nextPollDelayMs = options.pollIntervalMs ?? 1_000;
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (running !== undefined) {
      wakeRequested = true;
      return;
    }
    running = tick().finally(() => {
      running = undefined;
      if (wakeRequested) {
        wakeRequested = false;
        wakePipeline();
      } else schedule();
    });
  };

  const resolveContextStoreViewScope = async (
    input: DesktopMemoryContextStoreViewInput,
  ): Promise<{ readonly scope: MemoryRecallScope; readonly available: boolean }> => {
    const localUser = await subjectIdentities.getLocalUserRef();
    const scope = MemoryRecallScopeSchema.parse({
      rootRef: input.rootRef,
      expertRef: input.expertRef,
      principalRefs: [localUser, { type: "pragma.project", id: input.projectId }],
    });
    const policyRootRef = input.policyScope?.rootRef ?? scope.rootRef;
    const producerRefs =
      input.policyScope?.producerRefs ??
      (scope.expertRef === undefined ? undefined : [scope.expertRef]);
    const policy = await policies.resolveAt({
      rootRef: policyRootRef,
      ...(producerRefs === undefined ? {} : { producerRefs }),
      occurredAt: new Date().toISOString(),
    });
    return { scope, available: policy.recall };
  };

  return {
    executionStore,
    policies,
    extractorProfiles,
    extractionSettings,
    semanticStore: semantic.store,
    episodicStore: episodic.store,
    knowledgeLearningStore: knowledge.store,
    skillLearningStore: skill.store,
    activity,
    contextStore,
    attentionSettings: attention?.settings,
    createMissionContextStore: (input) => attention?.createContextStore(input) ?? contextStore,
    stopMissionAttention: async (missionId) => {
      await attention?.stopMission(missionId);
    },
    async getContextStoreViewStatus(input) {
      const resolved = await resolveContextStoreViewScope(input);
      if (!resolved.available) return "recall_disabled";
      const [episodes, facts] = await Promise.all([
        episodic.store.listForRecall(resolved.scope),
        semantic.store.listForRecall(resolved.scope, new Date()),
      ]);
      return episodes.length > 0 || facts.length > 0 ? "available" : "empty";
    },
    async createContextStoreView(input) {
      const resolved = await resolveContextStoreViewScope(input);
      if (!resolved.available) {
        const error = new Error("Memory recall is disabled for this resource scope.");
        Object.assign(error, { code: "memory_recall_disabled" });
        throw error;
      }
      return createFederatedMemoryContextStore(registry, {
        resolveRecallScope: () => resolved.scope,
      });
    },
    async setEpisodicExtractor(extractor) {
      await episodic.setExtractor(extractor);
      wakePipeline();
    },
    async setSemanticExtractor(extractor) {
      await semantic.setExtractor(extractor);
      wakePipeline();
    },
    async setKnowledgePlanner(planner) {
      await knowledge.setPlanner(planner);
      wakePipeline();
    },
    async setSkillPlanner(planner) {
      await skill.setPlanner(planner);
      wakePipeline();
    },
    async registerMemoryExecutionContext(input) {
      await registerExecutionContext(input);
      await setConversationState({ missionId: input.missionId, state: "running" });
      wakePipeline();
    },
    async setMemoryConversationState(input) {
      await setConversationState(input);
      wakePipeline();
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
      return { module: "semantic", record: await semantic.store.tightenAccess(common) };
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
      return { module: "semantic", record: await semantic.store.invalidate(common) };
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
        semantic.store.wakeNeedsAttention(new Date(), "configuration"),
      ]);
      wakePipeline();
    },
    async wakeRevisionLearningJobs() {
      await Promise.all([
        knowledge.store.wakeNeedsAttention(new Date(), "configuration"),
        skill.store.wakeNeedsAttention(new Date(), "configuration"),
      ]);
      wakePipeline();
    },
    wakePipeline,
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
            : input.module === "knowledge"
              ? knowledge.store
              : skill.store;
      if (input.action === "expedite") await store.expediteJob(command);
      else if (input.action === "retry") await store.retryJob(command);
      else if (input.action === "delete") await store.deleteJob(command);
      else if (input.action === "interrupt") {
        // Interrupt routes through the Module so the persisted transition and in-flight abort agree.
        if (input.module === "episodic") await episodic.interruptExtractionJob(command);
        else if (input.module === "semantic") await semantic.interruptExtractionJob(command);
        else if (input.module === "knowledge") await knowledge.interruptExtractionJob(command);
        else await skill.interruptExtractionJob(command);
      } else {
        const unsupported: never = input.action;
        throw new Error(`memory_extraction_job_action_unsupported:${String(unsupported)}`);
      }
      wakePipeline();
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
          module.descriptor.id !== knowledge.descriptor.id &&
          module.descriptor.id !== skill.descriptor.id
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
          const selected =
            module.descriptor.id === skill.descriptor.id ? await skill.store.inspect() : diagnostic;
          work = {
            records: selected.jobs,
            pending: selected.pending,
            running: selected.running,
            needsAttention: selected.needsAttention,
            rejected: 0,
            expired: 0,
            evidenceRecords: 0,
            evidenceBytes: 0,
            truncatedExecutions: 0,
            lastErrorCode: selected.lastErrorCode,
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
      const attentionStatus = await attention?.settings.status().catch(() => ({
        errorCode: "attention_state_unavailable",
      }));
      const attentionError =
        attentionStatus?.errorCode === undefined
          ? undefined
          : { code: attentionStatus.errorCode, occurredAt: new Date().toISOString() };
      const currentError = lastError ?? attentionError;
      return {
        state: stopped
          ? "stopped"
          : currentError !== undefined ||
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
        ...(currentError === undefined ? {} : { lastError: currentError }),
        modules,
        storagePolicy: desktopStoragePolicy(),
        maintenance: maintenanceDiagnostic,
      };
    },
    start() {
      if (!stopped) return;
      stopped = false;
      wakePipeline();
    },
    async stop() {
      stopped = true;
      await attention?.stop();
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await running;
      await maintenanceRunning;
      await scheduler.stop();
      episodic.close();
      knowledge.close();
      skill.close();
      semantic.close();
      await canonical.close();
    },
  };
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
    episodicMaxRecords: DEFAULT_MEMORY_STORAGE_POLICY.episodicMaxRecords,
    semanticMaxRecords: DEFAULT_MEMORY_STORAGE_POLICY.semanticMaxRecords,
    episodicMaxLogicalBytes: DEFAULT_MEMORY_STORAGE_POLICY.episodicMaxLogicalBytes,
    semanticMaxLogicalBytes: DEFAULT_MEMORY_STORAGE_POLICY.semanticMaxLogicalBytes,
    memoryMaxFullRevisions: DEFAULT_MEMORY_STORAGE_POLICY.memoryMaxFullRevisions,
  };
}
