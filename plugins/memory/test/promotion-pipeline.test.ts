import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  errorMemory,
  MemorySystem,
  createDefaultMemoryPromotionPipeline,
  createFileSystemExperienceMemoryStore,
  createFileSystemFactMemoryStore,
  createFileSystemTaskMemoryStore,
} from "../src/index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("memory promotion pipeline", () => {
  it("promotes archived task memory into experience memory", async () => {
    const experienceStore = await createExperienceStore();
    const taskStore = await createTaskStore();
    const memorySystem = new MemorySystem({
      taskStore,
      experienceStore,
      promotions: createDefaultMemoryPromotionPipeline(),
    });

    const appended = await memorySystem.appendTaskMemory({
      actorAgentId: "agent-a",
      record: {
        type: "task",
        scope: "session",
        workflowRunId: "workflow-1",
        visibility: "shared",
        kind: "handoff",
        content: "Completed repository scan.",
        status: "resolved",
      },
    });
    expect(appended.ok).toBe(true);
    if (!appended.ok) {
      return;
    }

    await memorySystem.archiveTaskMemory({
      actorAgentId: "agent-a",
      workflowRunId: "workflow-1",
    });

    const experiences = await memorySystem.listExperiences({
      workflowRunId: "workflow-1",
    });
    expect(experiences).toMatchObject({
      ok: true,
      value: [expect.objectContaining({ type: "experience" })],
    });
  });

  it("promotes stable experience summaries into facts", async () => {
    const experienceStore = await createExperienceStore();
    const factStore = await createFactStore();
    const memorySystem = new MemorySystem({
      experienceStore,
      factStore,
      promotions: createDefaultMemoryPromotionPipeline(),
    });

    const written = await memorySystem.writeExperience({
      record: {
        id: "experience-1",
        type: "experience",
        scope: "workspace",
        title: "Loop code ownership",
        summary: "@pragma/core loop code is located at packages/core/src/loop.",
        kind: "tool",
        content: "@pragma/core loop code is located at packages/core/src/loop.",
        status: "summarized",
        provenance: {
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
          evidence: [{ type: "external", id: "search-1" }],
        },
      },
    });

    expect(written.ok).toBe(true);

    const facts = await memorySystem.listFacts({
      onlyActive: true,
    });
    expect(facts).toMatchObject({
      ok: true,
      value: [
        expect.objectContaining({
          statement: "@pragma/core loop code is located at packages/core/src/loop.",
          confidence: "verified",
        }),
      ],
    });
  });

  it("does not promote time-sensitive experience summaries into facts", async () => {
    const experienceStore = await createExperienceStore();
    const factStore = await createFactStore();
    const memorySystem = new MemorySystem({
      experienceStore,
      factStore,
      promotions: createDefaultMemoryPromotionPipeline(),
    });

    await memorySystem.writeExperience({
      record: {
        id: "experience-1",
        type: "experience",
        scope: "workspace",
        summary: "Today the temporary debug file was under tmp/runtime.",
        kind: "tool",
        content: "Today the temporary debug file was under tmp/runtime.",
        status: "summarized",
        provenance: {
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
          evidence: [{ type: "external", id: "search-1" }],
        },
      },
    });

    const facts = await memorySystem.listFacts({
      onlyActive: true,
    });
    expect(facts).toEqual({
      ok: true,
      value: [],
    });
  });

  it("does not fail archiveTaskMemory when promotion throws", async () => {
    const onPromotionError = vi.fn();
    const experienceStore = await createExperienceStore();
    const taskStore = await createTaskStore();
    const memorySystem = new MemorySystem({
      taskStore,
      experienceStore,
      onPromotionError,
      promotions: {
        async proposeFromTask() {
          throw new Error("boom");
        },
      },
    });

    await memorySystem.appendTaskMemory({
      actorAgentId: "agent-a",
      record: {
        type: "task",
        scope: "session",
        workflowRunId: "workflow-1",
        visibility: "shared",
        kind: "handoff",
        content: "Completed repository scan.",
        status: "resolved",
      },
    });

    const archived = await memorySystem.archiveTaskMemory({
      actorAgentId: "agent-a",
      workflowRunId: "workflow-1",
    });

    expect(archived.ok).toBe(true);
    expect(onPromotionError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "store_error",
      }),
    );
  });

  it("reports promotion store write failures without failing experience writes", async () => {
    const onPromotionError = vi.fn();
    const experienceStore = await createExperienceStore();
    const factStore = await createFactStore();
    const memorySystem = new MemorySystem({
      experienceStore,
      factStore: {
        ...factStore,
        async write() {
          return errorMemory("store_error", "fact store write failed");
        },
      },
      onPromotionError,
      promotions: createDefaultMemoryPromotionPipeline(),
    });

    const written = await memorySystem.writeExperience({
      record: {
        id: "experience-1",
        type: "experience",
        scope: "workspace",
        title: "Loop code ownership",
        summary: "@pragma/core loop code is located at packages/core/src/loop.",
        kind: "tool",
        content: "@pragma/core loop code is located at packages/core/src/loop.",
        status: "summarized",
        provenance: {
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
          evidence: [{ type: "external", id: "search-1" }],
        },
      },
    });

    expect(written.ok).toBe(true);
    expect(onPromotionError).toHaveBeenCalledWith({
      code: "store_error",
      message: "fact store write failed",
    });
  });
});

async function createTaskStore() {
  const dir = await mkdtemp(join(process.cwd(), "tmp-promotion-task-"));
  tempDirs.push(dir);

  return createFileSystemTaskMemoryStore({
    agentId: "promotion-agent",
    filePath: join(dir, "task.json"),
  });
}

async function createExperienceStore() {
  const dir = await mkdtemp(join(process.cwd(), "tmp-promotion-experience-"));
  tempDirs.push(dir);

  return createFileSystemExperienceMemoryStore({
    agentId: "promotion-agent",
    filePath: join(dir, "experience.json"),
  });
}

async function createFactStore() {
  const dir = await mkdtemp(join(process.cwd(), "tmp-promotion-fact-"));
  tempDirs.push(dir);

  return createFileSystemFactMemoryStore({
    agentId: "promotion-agent",
    filePath: join(dir, "fact.json"),
  });
}
