import { describe, expect, it } from "vitest";

import { ContextSystem, ExpertAgent, MemorySystem, okMemory } from "../../src/index.ts";
import type {
  ExperienceMemoryRecord,
  ExperienceMemoryStore,
  FactMemoryRecord,
  FactMemoryStore,
  SkillMemoryRecord,
  SkillMemoryStore,
  TaskMemoryRecord,
  TaskMemoryStore,
} from "../../src/index.ts";

describe("MemorySystem", () => {
  it("aggregates runtime retrieval from typed stores", async () => {
    const system = new MemorySystem({
      taskStore: createTaskStore(),
      experienceStore: createExperienceStore(),
      factStore: createFactStore(),
      skillStore: createSkillStore(),
    });

    const result = await system.retrieveForRuntime({
      request: {
        agentId: "memory-agent",
      },
    });

    expect(result).toEqual(
      okMemory({
        task: {
          shared: [createTaskMemory("shared-task-memory", "shared")],
          private: [createTaskMemory("private-task-memory", "private", "memory-agent")],
          combined: [
            createTaskMemory("shared-task-memory", "shared"),
            createTaskMemory("private-task-memory", "private", "memory-agent"),
          ],
        },
        experiences: [createExperienceMemory()],
        facts: [createFactMemory()],
        skills: [createSkillMemory()],
      }),
    );
  });

  it("injects retrieved memory into the agent context", async () => {
    const agent = await ExpertAgent.create({
      id: "memory-agent",
      name: "Memory Agent",
      description: "Uses typed memory retrieval.",
      tags: ["memory"],
      version: "0.0.0",
      scope: "workspace",
      workspace: "/tmp/pragma-memory-test",
      contextSystem: new ContextSystem(),
      memorySystem: new MemorySystem({
        taskStore: createTaskStore(),
        factStore: createFactStore(),
        skillStore: createSkillStore(),
      }),
    });

    const context = await agent.buildContext();

    expect(context.systemPrompt).toContain("Memory retrieval");
    expect(context.systemPrompt).toContain("Task memory");
    expect(context.systemPrompt).toContain("Fact memory");
    expect(context.systemPrompt).toContain("Skill memory");
    expect(context.memory.task.combined).toHaveLength(2);
    expect(context.memory.facts[0]?.statement).toContain("StateManager is the source of truth");
  });

  it("rejects duplicate typed store registration", () => {
    const system = new MemorySystem({
      taskStore: createTaskStore(),
    });

    const result = system.registerTaskStore({
      store: createTaskStore(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.code).toBe("store_already_registered");
  });
});

function createTaskStore(): TaskMemoryStore {
  return {
    async list() {
      return okMemory([]);
    },
    async get() {
      return okMemory(createTaskMemory("shared-task-memory", "shared"));
    },
    async write(input) {
      return okMemory(input.record);
    },
    async update(input) {
      return okMemory(input.record);
    },
    async delete(input) {
      return okMemory({ id: input.id });
    },
    async archive() {
      return okMemory([]);
    },
    async search() {
      return okMemory([]);
    },
    async retrieveForRuntime(input) {
      const shared = [createTaskMemory("shared-task-memory", "shared")];
      const privateItems =
        input.agentId === "memory-agent"
          ? [createTaskMemory("private-task-memory", "private", "memory-agent")]
          : [];

      return okMemory({
        shared,
        private: privateItems,
        combined: [...shared, ...privateItems],
      });
    },
  };
}

function createExperienceStore(): ExperienceMemoryStore {
  return {
    async list() {
      return okMemory([createExperienceMemory()]);
    },
    async get() {
      return okMemory(createExperienceMemory());
    },
    async write(input) {
      return okMemory(input.record);
    },
    async update(input) {
      return okMemory(input.record);
    },
    async delete(input) {
      return okMemory({ id: input.id });
    },
    async search() {
      return okMemory([]);
    },
    async retrieveForRuntime() {
      return okMemory([createExperienceMemory()]);
    },
  };
}

function createFactStore(): FactMemoryStore {
  return {
    async list() {
      return okMemory([createFactMemory()]);
    },
    async get() {
      return okMemory(createFactMemory());
    },
    async write(input) {
      return okMemory(input.record);
    },
    async update(input) {
      return okMemory(input.record);
    },
    async delete(input) {
      return okMemory({ id: input.id });
    },
    async search() {
      return okMemory([]);
    },
    async retrieveForRuntime() {
      return okMemory([createFactMemory()]);
    },
  };
}

function createSkillStore(): SkillMemoryStore {
  return {
    async list() {
      return okMemory([createSkillMemory()]);
    },
    async get() {
      return okMemory(createSkillMemory());
    },
    async write(input) {
      return okMemory(input.record);
    },
    async update(input) {
      return okMemory(input.record);
    },
    async delete(input) {
      return okMemory({ id: input.id });
    },
    async search() {
      return okMemory([]);
    },
    async retrieveForRuntime() {
      return okMemory([createSkillMemory()]);
    },
  };
}

function createTaskMemory(
  id: string,
  visibility: TaskMemoryRecord["visibility"],
  ownerAgentId?: string,
): TaskMemoryRecord {
  return {
    id,
    type: "task",
    scope: "session",
    visibility,
    ownerAgentId,
    kind: visibility === "shared" ? "handoff" : "note",
    content:
      visibility === "shared"
        ? "Database migration is complete. API validation remains."
        : "Validate prompt assembly before publishing memory results.",
    status: "active",
    title: id,
    provenance: {
      createdAt: "2026-07-06T00:00:00.000Z",
      updatedAt: "2026-07-06T00:00:00.000Z",
      evidence: [],
    },
  };
}

function createExperienceMemory(): ExperienceMemoryRecord {
  return {
    id: "experience-1",
    type: "experience",
    scope: "session",
    kind: "recovery",
    content: "A failed runtime registration was fixed by resolving the runtime id before task dispatch.",
    status: "recorded",
    title: "Runtime recovery",
    provenance: {
      createdAt: "2026-07-06T00:00:00.000Z",
      updatedAt: "2026-07-06T00:00:00.000Z",
      evidence: [],
    },
  };
}

function createFactMemory(): FactMemoryRecord {
  return {
    id: "fact-1",
    type: "fact",
    scope: "workspace",
    title: "Loop authority boundary",
    statement: "StateManager is the source of truth for workflow and task state.",
    confidence: "verified",
    observedAt: "2026-07-06T00:00:00.000Z",
    verifiedAt: "2026-07-06T00:00:00.000Z",
    provenance: {
      createdAt: "2026-07-06T00:00:00.000Z",
      updatedAt: "2026-07-06T00:00:00.000Z",
      evidence: [],
    },
  };
}

function createSkillMemory(): SkillMemoryRecord {
  return {
    id: "skill-1",
    type: "skill",
    scope: "workspace",
    title: "Task memory design",
    summary: "Keep mailbox, state, and task memory separate but composed.",
    problemClass: "multi-agent task coordination",
    recommendedApproach: [
      "Use mailbox for directed messages.",
      "Use task memory for collaborative working notes.",
    ],
    goodPractices: ["Archive task memory after task completion."],
    antiPatterns: ["Do not treat task memory as the state source of truth."],
    failureModes: ["Private notes leak into shared coordination state."],
    recoveryPlaybook: ["Move authoritative state transitions back into StateManager."],
    provenance: {
      createdAt: "2026-07-06T00:00:00.000Z",
      updatedAt: "2026-07-06T00:00:00.000Z",
      evidence: [],
    },
  };
}
