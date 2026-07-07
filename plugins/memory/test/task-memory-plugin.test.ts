import { describe, expect, it } from "vitest";

import { ContextSystem, createNoopLoggerProvider } from "@pragma/core";

import {
  MemorySystem,
  createTaskMemoryContributions,
  okMemory,
  type TaskMemoryStore,
} from "../src/index.ts";

describe("task-memory plugin", () => {
  it("uses an injected task memory store when provided", async () => {
    const store = createStubTaskMemoryStore();
    const memorySystem = new MemorySystem();

    createTaskMemoryContributions({
      host: {},
      contextSystem: new ContextSystem(),
      memorySystem,
      workspaceRoot: "/tmp/pragma",
      env: process.env,
      config: {
        task: {
          store,
        },
      },
      logger: createNoopLoggerProvider().createLogger({
        component: "plugin",
        pluginId: "memory",
      }),
    });

    const result = await memorySystem.listTaskMemory({
      workflowRunId: "workflow-1",
      actorAgentId: "agent-a",
    });

    expect(result).toEqual(okMemory([]));
  });

  it("uses storeFactory before falling back to the default store", async () => {
    const store = createStubTaskMemoryStore();
    const memorySystem = new MemorySystem();

    createTaskMemoryContributions({
      host: {},
      contextSystem: new ContextSystem(),
      memorySystem,
      workspaceRoot: "/tmp/pragma",
      env: process.env,
      config: {
        task: {
          storeFactory: () => store,
        },
      },
      logger: createNoopLoggerProvider().createLogger({
        component: "plugin",
        pluginId: "memory",
      }),
    });

    const result = await memorySystem.listTaskMemory({
      workflowRunId: "workflow-1",
      actorAgentId: "agent-a",
    });

    expect(result).toEqual(okMemory([]));
  });
});

describe("memory plugin entry stores", () => {
  it("can register experience and fact stores explicitly", async () => {
    const memorySystem = new MemorySystem();

    const experienceResult = memorySystem.registerExperienceStore({
      store: createStubExperienceMemoryStore(),
    });
    const factResult = memorySystem.registerFactStore({
      store: createStubFactMemoryStore(),
    });

    expect(experienceResult).toEqual(okMemory({ type: "experience" }));
    expect(factResult).toEqual(okMemory({ type: "fact" }));
  });
});

function createStubTaskMemoryStore(): TaskMemoryStore {
  return {
    async list() {
      return okMemory([]);
    },
    async get() {
      throw new Error("not implemented");
    },
    async append() {
      throw new Error("not implemented");
    },
    async patch() {
      throw new Error("not implemented");
    },
    async archive() {
      throw new Error("not implemented");
    },
    async retrieveForRuntime() {
      return okMemory({
        shared: [],
        private: [],
        combined: [],
      });
    },
    async listForSummary() {
      return okMemory([]);
    },
  };
}

function createStubExperienceMemoryStore() {
  return {
    async list() {
      return okMemory([]);
    },
    async get() {
      throw new Error("not implemented");
    },
    async upsert() {
      throw new Error("not implemented");
    },
    async search() {
      return okMemory([]);
    },
    async retrieveForRuntime() {
      return okMemory([]);
    },
  };
}

function createStubFactMemoryStore() {
  return {
    async list() {
      return okMemory([]);
    },
    async get() {
      throw new Error("not implemented");
    },
    async upsert() {
      throw new Error("not implemented");
    },
    async search() {
      return okMemory([]);
    },
    async retrieveForRuntime() {
      return okMemory([]);
    },
  };
}
