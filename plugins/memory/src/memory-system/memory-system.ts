import {
  normalizeExperienceRecord,
  normalizeFactRecord,
  normalizeSkillRecord,
  renderAlwaysOnMemorySummary,
  resolveMemorySummaryConfig,
  type MemorySummaryConfig,
} from "./summary.ts";
import { createDefaultMemoryDistillationPipeline } from "./promotion-pipeline.ts";
import {
  errorMemory,
  okMemory,
  type MemoryDistillationPipeline,
  type MemoryEvidenceGetInput,
  type MemoryEvidenceListInput,
  type MemoryEvidenceRecord,
  type MemoryEvidenceStore,
  type MemoryEvidenceWriteInput,
  type ExperienceMemoryGetInput,
  type ExperienceMemoryListInput,
  type ExperienceMemoryStore,
  type FactMemoryGetInput,
  type FactMemoryListInput,
  type FactMemoryStore,
  type MemoryResult,
  type MemoryResultError,
  type MemoryStoreRegistration,
  type MemorySystemOptions,
  type MemorySystemRuntimeRetrieveInput,
  type RuntimeMemoryRetrieval,
  type SkillMemoryGetInput,
  type SkillMemoryListInput,
  type SkillMemoryStore,
  type TaskMemoryAppendInput,
  type TaskMemoryArchiveInput,
  type TaskMemoryGetInput,
  type TaskMemoryListInput,
  type TaskMemoryPatchInput,
  type TaskMemoryStore,
} from "./types.ts";

export class MemorySystem {
  private taskStore: TaskMemoryStore | undefined;
  private evidenceStore: MemoryEvidenceStore | undefined;
  private experienceStore: ExperienceMemoryStore | undefined;
  private factStore: FactMemoryStore | undefined;
  private skillStore: SkillMemoryStore | undefined;
  private readonly summaryConfig: MemorySummaryConfig;
  private summaryArtifactRegenerator:
    (() => Promise<void>) | undefined;
  private distillationChain = Promise.resolve();
  readonly distillation: MemoryDistillationPipeline | undefined;
  readonly onDistillationError: ((error: MemoryResultError) => void) | undefined;

  constructor(options: MemorySystemOptions = {}) {
    this.taskStore = options.taskStore;
    this.evidenceStore = options.evidenceStore;
    this.experienceStore = options.experienceStore;
    this.factStore = options.factStore;
    this.skillStore = options.skillStore;
    this.summaryConfig = resolveMemorySummaryConfig(options.summaryConfig);
    this.distillation = options.distillation ?? createDefaultMemoryDistillationPipeline();
    this.onDistillationError = options.onDistillationError;
  }

  setSummaryArtifactRegenerator(regenerator: () => Promise<void>): void {
    this.summaryArtifactRegenerator = regenerator;
  }

  registerTaskStore(
    input: MemoryStoreRegistration<TaskMemoryStore>,
  ): MemoryResult<{ readonly type: "task" }> {
    if (this.taskStore !== undefined) {
      return errorMemory("store_already_registered", "Task memory store is already registered.");
    }

    this.taskStore = input.store;
    return okMemory({ type: "task" });
  }

  registerEvidenceStore(
    input: MemoryStoreRegistration<MemoryEvidenceStore>,
  ): MemoryResult<{ readonly type: "evidence" }> {
    if (this.evidenceStore !== undefined) {
      return errorMemory("store_already_registered", "Memory evidence store is already registered.");
    }

    this.evidenceStore = input.store;
    return okMemory({ type: "evidence" });
  }

  registerExperienceStore(
    input: MemoryStoreRegistration<ExperienceMemoryStore>,
  ): MemoryResult<{ readonly type: "experience" }> {
    if (this.experienceStore !== undefined) {
      return errorMemory("store_already_registered", "Experience memory store is already registered.");
    }

    this.experienceStore = input.store;
    return okMemory({ type: "experience" });
  }

  registerFactStore(
    input: MemoryStoreRegistration<FactMemoryStore>,
  ): MemoryResult<{ readonly type: "fact" }> {
    if (this.factStore !== undefined) {
      return errorMemory("store_already_registered", "Fact memory store is already registered.");
    }

    this.factStore = input.store;
    return okMemory({ type: "fact" });
  }

  registerSkillStore(
    input: MemoryStoreRegistration<SkillMemoryStore>,
  ): MemoryResult<{ readonly type: "skill" }> {
    if (this.skillStore !== undefined) {
      return errorMemory("store_already_registered", "Skill memory store is already registered.");
    }

    this.skillStore = input.store;
    return okMemory({ type: "skill" });
  }

  async listTaskMemory(input: TaskMemoryListInput) {
    return await this.requireTaskStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.list(input);
    });
  }

  async getTaskMemory(input: TaskMemoryGetInput) {
    return await this.requireTaskStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.get(input);
    });
  }

  async appendTaskMemory(input: TaskMemoryAppendInput) {
    return await this.requireTaskStore().then(async (store) => {
      if (!store.ok) {
        return store;
      }

      const appended = await store.value.append(input);

      if (appended.ok) {
        await this.refreshSummaryArtifact();
      }

      return appended;
    });
  }

  async patchTaskMemory(input: TaskMemoryPatchInput) {
    return await this.requireTaskStore().then(async (store) => {
      if (!store.ok) {
        return store;
      }

      const patched = await store.value.patch(input);

      if (patched.ok) {
        await this.refreshSummaryArtifact();
      }

      return patched;
    });
  }

  async archiveTaskMemory(input: TaskMemoryArchiveInput) {
    return await this.requireTaskStore().then(async (store) => {
      if (!store.ok) {
        return store;
      }

      const archived = await store.value.archive(input);

      if (!archived.ok) {
        return archived;
      }

      await this.refreshSummaryArtifact();
      const evidenceWrites = await Promise.all(
        archived.value.map(async (record) => {
          return await this.recordEvidence({
            record: {
              id: `evidence-task-archive-${record.id}`,
              type: "evidence",
              kind: "task_archive",
              agentId: input.actorAgentId,
              scope: record.scope,
              workflowRunId: record.workflowRunId,
              taskRunId: record.taskRunId,
              runtimeSessionId: record.runtimeSessionId,
              payload: { task: record },
              createdAt: record.provenance.updatedAt,
              updatedAt: record.provenance.updatedAt,
              provenance: {
                createdBy: "task-memory",
                updatedBy: "task-memory",
                source: "task-memory",
                createdAt: record.provenance.updatedAt,
                updatedAt: record.provenance.updatedAt,
                evidence: [
                  {
                    type: "memory",
                    id: record.id,
                    memory: { type: "task", id: record.id },
                  },
                ],
              },
            },
          });
        }),
      );

      for (const write of evidenceWrites) {
        if (!write.ok) {
          this.onDistillationError?.(write.error);
        }
      }
      return archived;
    });
  }

  async listEvidence(input: MemoryEvidenceListInput) {
    return await this.requireEvidenceStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.list(input);
    });
  }

  async getEvidence(input: MemoryEvidenceGetInput) {
    return await this.requireEvidenceStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.get(input);
    });
  }

  async recordEvidence(
    input: MemoryEvidenceWriteInput,
    options: {
      readonly waitUntilProcessed?: boolean | undefined;
    } = {},
  ) {
    return await this.requireEvidenceStore().then(async (store) => {
      if (!store.ok) {
        return store;
      }

      const written = await store.value.write(input);

      if (!written.ok) {
        return written;
      }

      this.enqueueDistillation([written.value]);

      if (options.waitUntilProcessed === true) {
        await this.awaitIdle();
      }

      return written;
    });
  }

  async awaitIdle(): Promise<void> {
    await this.distillationChain;
  }

  async listExperiences(input: ExperienceMemoryListInput) {
    return await this.requireExperienceStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.list(input);
    });
  }

  async getExperience(input: ExperienceMemoryGetInput) {
    return await this.requireExperienceStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.get(input);
    });
  }

  async listFacts(input: FactMemoryListInput) {
    return await this.requireFactStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.list(input);
    });
  }

  async getFact(input: FactMemoryGetInput) {
    return await this.requireFactStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.get(input);
    });
  }

  async listSkills(input: SkillMemoryListInput) {
    return await this.requireSkillStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.list(input);
    });
  }

  async getSkill(input: SkillMemoryGetInput) {
    return await this.requireSkillStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.get(input);
    });
  }

  async retrieveForRuntime(
    input: MemorySystemRuntimeRetrieveInput,
  ): Promise<MemoryResult<RuntimeMemoryRetrieval>> {
    const [task, experiences, facts, skills] = await Promise.all([
      this.taskStore?.retrieveForRuntime(input.request, input.options?.task) ??
        Promise.resolve(
          okMemory({
            shared: [],
            private: [],
            combined: [],
          }),
        ),
      this.experienceStore?.retrieveForRuntime(input.request, input.options?.experience) ??
        Promise.resolve(okMemory([])),
      this.factStore?.retrieveForRuntime(input.request, input.options?.fact) ??
        Promise.resolve(okMemory([])),
      this.skillStore?.retrieveForRuntime(input.request, input.options?.skill) ??
        Promise.resolve(okMemory([])),
    ]);

    if (!task.ok) {
      return task;
    }

    if (!experiences.ok) {
      return experiences;
    }

    if (!facts.ok) {
      return facts;
    }

    if (!skills.ok) {
      return skills;
    }

    return okMemory({
      task: task.value,
      experiences: experiences.value,
      facts: facts.value,
      skills: skills.value,
    });
  }

  async buildAlwaysOnSummary(input: {
    readonly agentId: string;
  }): Promise<MemoryResult<string>> {
    const [tasks, experiences, facts, skills] = await Promise.all([
      this.taskStore?.listForSummary({ actorAgentId: input.agentId }) ?? Promise.resolve(okMemory([])),
      this.experienceStore?.list({}) ?? Promise.resolve(okMemory([])),
      this.factStore?.list({ onlyActive: true }) ?? Promise.resolve(okMemory([])),
      this.skillStore?.list({}) ?? Promise.resolve(okMemory([])),
    ]);

    if (!tasks.ok) {
      return tasks;
    }

    if (!experiences.ok) {
      return experiences;
    }

    if (!facts.ok) {
      return facts;
    }

    if (!skills.ok) {
      return skills;
    }

    return okMemory(
      renderAlwaysOnMemorySummary({
        tasks: tasks.value,
        experiences: experiences.value,
        facts: facts.value,
        skills: skills.value,
        config: this.summaryConfig,
      }),
    );
  }

  async buildContextArtifacts(input: {
    readonly agentId: string;
  }): Promise<
    MemoryResult<
      readonly {
        readonly id: string;
        readonly content: string;
        readonly description: string;
        readonly trigger: "always_on" | "model_decision" | "manual";
      }[]
    >
  > {
    const [tasks, experiences, facts] = await Promise.all([
      this.taskStore?.listForSummary({ actorAgentId: input.agentId }) ?? Promise.resolve(okMemory([])),
      this.experienceStore?.list({}) ?? Promise.resolve(okMemory([])),
      this.factStore?.list({ onlyActive: true }) ?? Promise.resolve(okMemory([])),
    ]);

    if (!tasks.ok) {
      return tasks;
    }

    if (!experiences.ok) {
      return experiences;
    }

    if (!facts.ok) {
      return facts;
    }

    return okMemory([
      ...tasks.value.map((record) => ({
        id: `task-memory/${record.id}.md`,
        content: renderTaskMemoryArtifact(record),
        description: `Task memory projection for ${record.id}.`,
        trigger: "manual" as const,
      })),
      ...experiences.value.map((record) => ({
        id: `experience-memory/${record.id}.md`,
        content: renderExperienceMemoryArtifact(record),
        description: `Experience memory projection for ${record.id}.`,
        trigger: "manual" as const,
      })),
      ...facts.value.map((record) => ({
        id: `fact-memory/${record.id}.md`,
        content: renderFactMemoryArtifact(record),
        description: `Fact memory projection for ${record.id}.`,
        trigger: "manual" as const,
      })),
    ]);
  }

  private async requireTaskStore(): Promise<MemoryResult<TaskMemoryStore>> {
    return this.taskStore === undefined
      ? errorMemory("store_unavailable", "Task memory store is not registered.")
      : okMemory(this.taskStore);
  }

  private async requireEvidenceStore(): Promise<MemoryResult<MemoryEvidenceStore>> {
    return this.evidenceStore === undefined
      ? errorMemory("store_unavailable", "Memory evidence store is not registered.")
      : okMemory(this.evidenceStore);
  }

  private async requireExperienceStore(): Promise<MemoryResult<ExperienceMemoryStore>> {
    return this.experienceStore === undefined
      ? errorMemory("store_unavailable", "Experience memory store is not registered.")
      : okMemory(this.experienceStore);
  }

  private async requireFactStore(): Promise<MemoryResult<FactMemoryStore>> {
    return this.factStore === undefined
      ? errorMemory("store_unavailable", "Fact memory store is not registered.")
      : okMemory(this.factStore);
  }

  private async requireSkillStore(): Promise<MemoryResult<SkillMemoryStore>> {
    return this.skillStore === undefined
      ? errorMemory("store_unavailable", "Skill memory store is not registered.")
      : okMemory(this.skillStore);
  }

  private enqueueDistillation(records: readonly MemoryEvidenceRecord[]): void {
    if (records.length === 0) {
      return;
    }

    this.distillationChain = this.distillationChain.then(async () => {
      await this.runDistillationSafely(() => this.distillEvidence(records));
    });
  }

  private async distillEvidence(
    records: readonly MemoryEvidenceRecord[],
  ): Promise<MemoryResult<void>> {
    if (this.distillation === undefined || records.length === 0) {
      return okMemory(undefined);
    }

    const proposal = await this.distillation.distill({
      evidence: records,
    });

    if (!proposal.ok) {
      return proposal;
    }

    return await this.applyDistillationProposal(proposal.value);
  }

  private async applyDistillationProposal(
    proposal: import("./types.ts").MemoryDistillationProposal,
  ): Promise<MemoryResult<void>> {
    if (this.experienceStore !== undefined) {
      for (const candidate of proposal.experiences) {
        const written = await this.experienceStore.upsert(
          normalizeExperienceRecord(candidate.record, this.summaryConfig.perRecordMaxChars),
        );

        if (!written.ok) {
          return written;
        }
      }
    }

    if (this.factStore !== undefined) {
      for (const candidate of proposal.facts) {
        const written = await this.factStore.upsert(
          normalizeFactRecord(candidate.record, this.summaryConfig.perRecordMaxChars),
        );

        if (!written.ok) {
          return written;
        }
      }
    }

    if (this.skillStore !== undefined) {
      for (const candidate of proposal.skills) {
        const written = await this.skillStore.upsert(
          normalizeSkillRecord(candidate.record, this.summaryConfig.perRecordMaxChars),
        );

        if (!written.ok) {
          return written;
        }
      }
    }

    await this.refreshSummaryArtifact();
    return okMemory(undefined);
  }

  private async runDistillationSafely(operation: () => Promise<MemoryResult<void>>): Promise<void> {
    try {
      const result = await operation();

      if (!result.ok) {
        this.onDistillationError?.(result.error);
      }
    } catch (error) {
      this.onDistillationError?.({
        code: "store_error",
        message: "Memory distillation failed unexpectedly.",
        details: {
          cause: error,
        },
      });
    }
  }

  private async refreshSummaryArtifact(): Promise<void> {
    await this.summaryArtifactRegenerator?.();
  }
}

function renderTaskMemoryArtifact(record: import("./types.ts").TaskMemoryRecord): string {
  return [
    "# Task Memory",
    "",
    `- id: ${record.id}`,
    `- kind: ${record.kind}`,
    `- visibility: ${record.visibility}`,
    `- status: ${record.status}`,
    `- workflowRunId: ${record.workflowRunId}`,
    ...(record.taskRunId === undefined ? [] : [`- taskRunId: ${record.taskRunId}`]),
    ...(record.runtimeSessionId === undefined ? [] : [`- runtimeSessionId: ${record.runtimeSessionId}`]),
    ...(record.title === undefined ? [] : ["", "## Title", record.title]),
    "",
    "## Content",
    record.content,
    ...(record.items === undefined || record.items.length === 0
      ? []
      : [
          "",
          "## Todo Items",
          ...record.items.map(
            (item) => `- [${item.done ? "x" : " "}] ${item.text}${item.assigneeAgentId === undefined ? "" : ` (${item.assigneeAgentId})`}`,
          ),
        ]),
  ].join("\n");
}

function renderExperienceMemoryArtifact(record: import("./types.ts").ExperienceMemoryRecord): string {
  return [
    "# Experience Memory",
    "",
    `- id: ${record.id}`,
    `- kind: ${record.kind}`,
    `- status: ${record.status}`,
    `- scope: ${record.scope}`,
    ...(record.title === undefined ? [] : [`- title: ${record.title}`]),
    "",
    "## Summary",
    record.summary ?? "No summary recorded.",
    "",
    "## Content",
    record.content,
  ].join("\n");
}

function renderFactMemoryArtifact(record: import("./types.ts").FactMemoryRecord): string {
  return [
    "# Fact Memory",
    "",
    `- id: ${record.id}`,
    `- scope: ${record.scope}`,
    `- confidence: ${record.confidence}`,
    `- observedAt: ${record.observedAt}`,
    ...(record.verifiedAt === undefined ? [] : [`- verifiedAt: ${record.verifiedAt}`]),
    ...(record.reviewAt === undefined ? [] : [`- reviewAt: ${record.reviewAt}`]),
    ...(record.expiresAt === undefined ? [] : [`- expiresAt: ${record.expiresAt}`]),
    "",
    "## Statement",
    record.statement,
    ...(record.summary === undefined ? [] : ["", "## Summary", record.summary]),
  ].join("\n");
}
