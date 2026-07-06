import {
  errorMemory,
  okMemory,
  type ExperienceMemoryGetInput,
  type ExperienceMemoryListInput,
  type ExperienceMemoryStore,
  type ExperienceMemoryUpdateInput,
  type ExperienceMemoryWriteInput,
  type FactMemoryGetInput,
  type FactMemoryListInput,
  type FactMemoryStore,
  type FactMemoryUpdateInput,
  type FactMemoryWriteInput,
  type MemoryPromotionPipeline,
  type MemoryResult,
  type MemoryResultError,
  type MemoryStoreRegistration,
  type MemorySystemOptions,
  type MemorySystemRuntimeRetrieveInput,
  type RuntimeMemoryRetrieval,
  type SkillMemoryGetInput,
  type SkillMemoryListInput,
  type SkillMemoryStore,
  type SkillMemoryUpdateInput,
  type SkillMemoryWriteInput,
  type TaskMemoryAppendInput,
  type TaskMemoryArchiveInput,
  type TaskMemoryGetInput,
  type TaskMemoryListInput,
  type TaskMemoryPatchInput,
  type TaskMemoryStore,
} from "./types.ts";

export class MemorySystem {
  private taskStore: TaskMemoryStore | undefined;
  private experienceStore: ExperienceMemoryStore | undefined;
  private factStore: FactMemoryStore | undefined;
  private skillStore: SkillMemoryStore | undefined;
  readonly promotions: MemoryPromotionPipeline | undefined;
  readonly onPromotionError: ((error: MemoryResultError) => void) | undefined;

  constructor(options: MemorySystemOptions = {}) {
    this.taskStore = options.taskStore;
    this.experienceStore = options.experienceStore;
    this.factStore = options.factStore;
    this.skillStore = options.skillStore;
    this.promotions = options.promotions;
    this.onPromotionError = options.onPromotionError;
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
    return await this.requireTaskStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.append(input);
    });
  }

  async patchTaskMemory(input: TaskMemoryPatchInput) {
    return await this.requireTaskStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.patch(input);
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

      await this.runPromotionSafely(() => this.promoteFromTaskRecords(archived.value));
      return archived;
    });
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

  async writeExperience(input: ExperienceMemoryWriteInput) {
    return await this.requireExperienceStore().then(async (store) => {
      if (!store.ok) {
        return store;
      }

      const written = await store.value.write(input);

      if (!written.ok) {
        return written;
      }

      await this.runPromotionSafely(() => this.promoteFromExperienceRecords([written.value]));
      return written;
    });
  }

  async updateExperience(input: ExperienceMemoryUpdateInput) {
    return await this.requireExperienceStore().then(async (store) => {
      if (!store.ok) {
        return store;
      }

      const updated = await store.value.update(input);

      if (!updated.ok) {
        return updated;
      }

      await this.runPromotionSafely(() => this.promoteFromExperienceRecords([updated.value]));
      return updated;
    });
  }

  async deleteExperience(input: ExperienceMemoryGetInput) {
    return await this.requireExperienceStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.delete(input);
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

  async writeFact(input: FactMemoryWriteInput) {
    return await this.requireFactStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.write(input);
    });
  }

  async updateFact(input: FactMemoryUpdateInput) {
    return await this.requireFactStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.update(input);
    });
  }

  async deleteFact(input: FactMemoryGetInput) {
    return await this.requireFactStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.delete(input);
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

  async writeSkill(input: SkillMemoryWriteInput) {
    return await this.requireSkillStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.write(input);
    });
  }

  async updateSkill(input: SkillMemoryUpdateInput) {
    return await this.requireSkillStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.update(input);
    });
  }

  async deleteSkill(input: SkillMemoryGetInput) {
    return await this.requireSkillStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.delete(input);
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

  private async requireTaskStore(): Promise<MemoryResult<TaskMemoryStore>> {
    return this.taskStore === undefined
      ? errorMemory("store_unavailable", "Task memory store is not registered.")
      : okMemory(this.taskStore);
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

  private async promoteFromTaskRecords(
    records: readonly import("./types.ts").TaskMemoryRecord[],
  ): Promise<MemoryResult<void>> {
    if (this.promotions?.proposeFromTask === undefined || records.length === 0) {
      return okMemory(undefined);
    }

    const proposal = await this.promotions.proposeFromTask(records);

    if (!proposal.ok) {
      return proposal;
    }

    return await this.applyPromotionProposal(proposal.value);
  }

  private async promoteFromExperienceRecords(
    records: readonly import("./types.ts").ExperienceMemoryRecord[],
  ): Promise<MemoryResult<void>> {
    if (this.promotions?.proposeFromExperience === undefined || records.length === 0) {
      return okMemory(undefined);
    }

    const proposal = await this.promotions.proposeFromExperience(records);

    if (!proposal.ok) {
      return proposal;
    }

    return await this.applyPromotionProposal(proposal.value);
  }

  private async applyPromotionProposal(
    proposal: import("./types.ts").MemoryPromotionProposal,
  ): Promise<MemoryResult<void>> {
    if (this.experienceStore !== undefined) {
      for (const candidate of proposal.experiences) {
        const existing = await this.experienceStore.get({ id: candidate.record.id });

        if (existing.ok) {
          const updated = await this.experienceStore.update({ record: candidate.record });

          if (!updated.ok) {
            return updated;
          }
          continue;
        }

        if (existing.error.code !== "memory_not_found") {
          return existing;
        }

        const written = await this.experienceStore.write({ record: candidate.record });

        if (!written.ok) {
          return written;
        }
      }
    }

    if (this.factStore !== undefined) {
      for (const candidate of proposal.facts) {
        const existing = await this.factStore.get({ id: candidate.record.id });

        if (existing.ok) {
          const updated = await this.factStore.update({ record: candidate.record });

          if (!updated.ok) {
            return updated;
          }
          continue;
        }

        if (existing.error.code !== "memory_not_found") {
          return existing;
        }

        const written = await this.factStore.write({ record: candidate.record });

        if (!written.ok) {
          return written;
        }
      }
    }

    if (this.skillStore !== undefined) {
      for (const candidate of proposal.skills) {
        const existing = await this.skillStore.get({ id: candidate.record.id });

        if (existing.ok) {
          const updated = await this.skillStore.update({ record: candidate.record });

          if (!updated.ok) {
            return updated;
          }
          continue;
        }

        if (existing.error.code !== "memory_not_found") {
          return existing;
        }

        const written = await this.skillStore.write({ record: candidate.record });

        if (!written.ok) {
          return written;
        }
      }
    }

    return okMemory(undefined);
  }

  private async runPromotionSafely(operation: () => Promise<MemoryResult<void>>): Promise<void> {
    try {
      const result = await operation();

      if (!result.ok) {
        this.onPromotionError?.(result.error);
      }
    } catch (error) {
      this.onPromotionError?.({
        code: "store_error",
        message: "Memory promotion failed unexpectedly.",
        details: {
          cause: error,
        },
      });
    }
  }
}
