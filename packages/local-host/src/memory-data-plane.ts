import {
  PragmaPaths,
  createFileCanonicalEventFeed,
  withFileLock,
  type CanonicalEventFeed,
  type DurableExecutionStore,
  type PragmaLogger,
} from "@pragma/core";
import {
  MemoryModuleRegistry,
  createEpisodicMemoryModule,
  createExecutionEvidenceAdapter,
  createFileMemoryExtractionSettingsStore,
  createFileMemoryExtractorProfileStore,
  createFileMemoryPipelineStateStore,
  createFileMemoryPolicyStore,
  createKnowledgeMemoryModule,
  createKnowledgeSourceReader,
  createMemoryActivityStore,
  createMemoryEvidenceFeed,
  createMemoryEvidencePublisher,
  createMemoryPipelineScheduler,
  createSemanticMemoryModule,
  createSkillMemoryModule,
  createSkillSourceReader,
  type KnowledgeLearningSink,
  type KnowledgeMemoryModule,
  type SkillLearningSink,
  type SkillLearningTargetReader,
} from "@pragma/memory";
import { join } from "node:path";
import { createSqliteExecutionStore } from "./execution/sqlite-execution-store.ts";
import { createLocalHostMemorySubjectIdentityStore } from "./memory-subject-identity.ts";

export async function createLocalHostMemoryDataPlane(options: {
  readonly pragmaHome: string;
  readonly logger: PragmaLogger;
  readonly canonical?: CanonicalEventFeed;
  readonly executionStore?: DurableExecutionStore;
  readonly knowledgeLearningSink?: KnowledgeLearningSink | undefined;
  readonly skillLearningSink?: SkillLearningSink | undefined;
  readonly skillLearningTargetReader?: SkillLearningTargetReader | undefined;
}) {
  const canonical =
    options.canonical ?? (await createFileCanonicalEventFeed({ pragmaHome: options.pragmaHome }));
  const executionStore =
    options.executionStore ??
    createSqliteExecutionStore({
      logger: options.logger,
      pragmaHome: options.pragmaHome,
      canonicalEventFeed: canonical,
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
  const knowledgeRef: { current?: KnowledgeMemoryModule } = {};
  const semantic = await createSemanticMemoryModule({
    pragmaHome: options.pragmaHome,
    extractionSettings,
    async onProjectionChanged({ rootRef }) {
      const current = knowledgeRef.current;
      if (current === undefined) throw new Error("knowledge_memory_module_not_ready");
      await current.scheduleRoot(rootRef);
    },
  });
  const knowledge = await createKnowledgeMemoryModule({
    pragmaHome: options.pragmaHome,
    sourceReader: createKnowledgeSourceReader({
      episodic: episodic.store,
      semantic: semantic.store,
    }),
    learningSink:
      options.knowledgeLearningSink ??
      ({
        async submit() {
          throw new Error("knowledge_learning_sink_unavailable");
        },
      } satisfies KnowledgeLearningSink),
  });
  knowledgeRef.current = knowledge;
  const skill = await createSkillMemoryModule({
    pragmaHome: options.pragmaHome,
    sourceReader: createSkillSourceReader({ episodic: episodic.store, semantic: semantic.store }),
    targetReader:
      options.skillLearningTargetReader ??
      ({
        async listTargets() {
          return [];
        },
      } satisfies SkillLearningTargetReader),
    learningSink:
      options.skillLearningSink ??
      ({
        async submit() {
          throw new Error("skill_learning_sink_unavailable");
        },
      } satisfies SkillLearningSink),
  });
  const activity = createMemoryActivityStore({ pragmaHome: options.pragmaHome });
  registry.register(episodic);
  registry.register(knowledge);
  registry.register(semantic);
  registry.register(skill);
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
  const identities = createLocalHostMemorySubjectIdentityStore(options);
  const paths = new PragmaPaths(options);
  const flushDelivery = async () =>
    await withFileLock(join(paths.memoryStateRoot(), "delivery.lock"), async () => {
      await executionStore.recoverPendingCanonicalEvents();
      const adapted = await adapter.runOnce();
      await scheduler.runOnce({ background: false });
      return adapted;
    });
  const registerExecutionContext = async (input: {
    executionId: string;
    missionId: string;
    projectId?: string;
  }) => {
    const principalRefs = [
      await identities.getLocalUserRef(),
      ...(input.projectId === undefined
        ? []
        : [{ type: "pragma.project" as const, id: input.projectId }]),
    ];
    const conversationRef = { type: "pragma.mission" as const, id: input.missionId };
    const now = new Date();
    await activity.registerExecutionContext({
      executionId: input.executionId,
      conversationRef,
      principalRefs,
    });
    await semantic.registerExecutionSubjects({
      executionId: input.executionId,
      subjectRefs: principalRefs,
    });
    await Promise.all([
      episodic.bindExecutionConversation({ executionId: input.executionId, conversationRef, now }),
      semantic.bindExecutionConversation({ executionId: input.executionId, conversationRef, now }),
    ]);
  };
  const setConversationState = async (input: {
    missionId: string;
    state: "active" | "running" | "completed";
  }) => {
    const conversationRef = { type: "pragma.mission" as const, id: input.missionId };
    const now = new Date();
    await Promise.all([
      episodic.setConversationState({ conversationRef, state: input.state, now }),
      semantic.setConversationState({ conversationRef, state: input.state, now }),
    ]);
  };
  return {
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
  };
}
