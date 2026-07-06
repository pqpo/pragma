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
  type MemoryStoreRegistration,
  type MemorySystemOptions,
  type MemorySystemRuntimeRetrieveInput,
  type RuntimeMemoryRetrieval,
  type SkillMemoryGetInput,
  type SkillMemoryListInput,
  type SkillMemoryStore,
  type SkillMemoryUpdateInput,
  type SkillMemoryWriteInput,
  type TaskMemoryArchiveInput,
  type TaskMemoryGetInput,
  type TaskMemoryListInput,
  type TaskMemoryStore,
  type TaskMemoryUpdateInput,
  type TaskMemoryWriteInput,
} from "./types.ts";

export class MemorySystem {
  private taskStore: TaskMemoryStore | undefined;
  private experienceStore: ExperienceMemoryStore | undefined;
  private factStore: FactMemoryStore | undefined;
  private skillStore: SkillMemoryStore | undefined;
  readonly promotions: MemoryPromotionPipeline | undefined;

  constructor(options: MemorySystemOptions & { readonly promotions?: MemoryPromotionPipeline | undefined } = {}) {
    this.taskStore = options.taskStore;
    this.experienceStore = options.experienceStore;
    this.factStore = options.factStore;
    this.skillStore = options.skillStore;
    this.promotions = options.promotions;
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

  async writeTaskMemory(input: TaskMemoryWriteInput) {
    return await this.requireTaskStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.write(input);
    });
  }

  async updateTaskMemory(input: TaskMemoryUpdateInput) {
    return await this.requireTaskStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.update(input);
    });
  }

  async deleteTaskMemory(input: TaskMemoryGetInput) {
    return await this.requireTaskStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.delete(input);
    });
  }

  async archiveTaskMemory(input: TaskMemoryArchiveInput) {
    return await this.requireTaskStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.archive(input);
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
    return await this.requireExperienceStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.write(input);
    });
  }

  async updateExperience(input: ExperienceMemoryUpdateInput) {
    return await this.requireExperienceStore().then((store) => {
      if (!store.ok) {
        return store;
      }

      return store.value.update(input);
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
}
