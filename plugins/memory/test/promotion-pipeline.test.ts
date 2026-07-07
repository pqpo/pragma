import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  errorMemory,
  MemorySystem,
  createDefaultMemoryDistillationPipeline,
  createFileSystemExperienceMemoryStore,
  createFileSystemFactMemoryStore,
  createFileSystemTaskMemoryStore,
} from "../src/index.ts";
import { createFileSystemMemoryEvidenceStore } from "../src/evidence/store.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("memory distillation pipeline", () => {
  it("distills archived task memory into experience memory through evidence", async () => {
    const workspace = await createWorkspaceDir();
    const memorySystem = await createMemorySystem(workspace);

    const appended = await memorySystem.appendTaskMemory({
      actorAgentId: "agent-a",
      record: {
        type: "task",
        scope: "session",
        workflowRunId: "workflow-1",
        runtimeSessionId: "session-1",
        visibility: "shared",
        kind: "handoff",
        content: "Completed repository scan.",
        status: "resolved",
      },
    });
    expect(appended.ok).toBe(true);

    await memorySystem.archiveTaskMemory({
      actorAgentId: "agent-a",
      workflowRunId: "workflow-1",
    });
    await memorySystem.awaitIdle();

    const experiences = await memorySystem.listExperiences({
      workflowRunId: "workflow-1",
    });
    expect(experiences).toMatchObject({
      ok: true,
      value: [
        expect.objectContaining({ type: "experience", content: "Completed repository scan." }),
      ],
    });
  });

  it("distills workflow evidence into facts when stable signals are present", async () => {
    const workspace = await createWorkspaceDir();
    const memorySystem = await createMemorySystem(workspace);

    await memorySystem.recordEvidence(
      {
        record: {
          id: "workflow-1",
          type: "evidence",
          kind: "workflow",
          agentId: "agent-a",
          scope: "workspace",
          workflowRunId: "workflow-1",
          payload: {
            workflowRunId: "workflow-1",
            runtimeSessionIds: ["runtime-session-1"],
            runIds: ["run-1"],
            externalContext: false,
            runs: [
              {
                query: "Locate loop runtime code",
                status: "succeeded",
                outputExcerpt: "@pragma/core loop code is located at packages/core/src/loop.",
                lessons: [],
                tools: [],
              },
            ],
          },
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
          provenance: {
            createdAt: "2026-07-06T00:00:00.000Z",
            updatedAt: "2026-07-06T00:00:00.000Z",
            evidence: [{ type: "workflow", id: "workflow-1" }],
          },
        },
      },
      { waitUntilProcessed: true },
    );

    const facts = await memorySystem.listFacts({
      onlyActive: true,
    });
    expect(facts).toMatchObject({
      ok: true,
      value: [
        expect.objectContaining({
          confidence: "verified",
          statement: expect.stringContaining("packages/core/src/loop"),
        }),
      ],
    });
  });

  it("does not distill time-sensitive experience summaries into facts", async () => {
    const workspace = await createWorkspaceDir();
    const memorySystem = await createMemorySystem(workspace);

    await memorySystem.recordEvidence(
      {
        record: {
          id: "workflow-sensitive",
          type: "evidence",
          kind: "workflow",
          agentId: "agent-a",
          scope: "workspace",
          workflowRunId: "workflow-sensitive",
          payload: {
            workflowRunId: "workflow-sensitive",
            runtimeSessionIds: ["runtime-session-sensitive"],
            runIds: ["run-1"],
            externalContext: false,
            runs: [
              {
                query: "Locate temporary debug file",
                status: "succeeded",
                outputExcerpt: "Today the temporary debug file was under tmp/runtime.",
                lessons: [],
                tools: [],
              },
            ],
          },
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
          provenance: {
            createdAt: "2026-07-06T00:00:00.000Z",
            updatedAt: "2026-07-06T00:00:00.000Z",
            evidence: [{ type: "workflow", id: "workflow-sensitive" }],
          },
        },
      },
      { waitUntilProcessed: true },
    );

    const facts = await memorySystem.listFacts({
      onlyActive: true,
    });
    expect(facts).toEqual({
      ok: true,
      value: [],
    });
  });

  it("does not fail archiveTaskMemory when distillation throws", async () => {
    const workspace = await createWorkspaceDir();
    const onDistillationError = vi.fn();
    const memorySystem = await createMemorySystem(workspace, {
      onDistillationError,
      distillation: {
        async distill() {
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
        runtimeSessionId: "session-1",
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
    await memorySystem.awaitIdle();

    expect(archived.ok).toBe(true);
    expect(onDistillationError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "store_error",
      }),
    );
  });

  it("reports archived task evidence write failures", async () => {
    const workspace = await createWorkspaceDir();
    const onDistillationError = vi.fn();
    const memorySystem = new MemorySystem({
      taskStore: createFileSystemTaskMemoryStore({
        agentId: "agent-a",
        filePath: join(workspace, "task.json"),
      }),
      onDistillationError,
    });

    await memorySystem.appendTaskMemory({
      actorAgentId: "agent-a",
      record: {
        type: "task",
        scope: "session",
        workflowRunId: "workflow-1",
        runtimeSessionId: "session-1",
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
    expect(onDistillationError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "store_unavailable",
      }),
    );
  });

  it("reports distillation store write failures without failing evidence writes", async () => {
    const workspace = await createWorkspaceDir();
    const onDistillationError = vi.fn();
    const memorySystem = await createMemorySystem(workspace, {
      onDistillationError,
      factStoreOverride: {
        async upsert() {
          return errorMemory("store_error", "fact store write failed");
        },
      },
    });

    const written = await memorySystem.recordEvidence(
      {
        record: {
          id: "workflow-1",
          type: "evidence",
          kind: "workflow",
          agentId: "agent-a",
          scope: "workspace",
          workflowRunId: "workflow-1",
          payload: {
            workflowRunId: "workflow-1",
            runtimeSessionIds: ["runtime-session-1"],
            runIds: ["run-1"],
            externalContext: false,
            runs: [
              {
                query: "Locate loop runtime code",
                status: "succeeded",
                outputExcerpt: "@pragma/core loop code is located at packages/core/src/loop.",
                lessons: [],
                tools: [],
              },
            ],
          },
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
          provenance: {
            createdAt: "2026-07-06T00:00:00.000Z",
            updatedAt: "2026-07-06T00:00:00.000Z",
            evidence: [{ type: "workflow", id: "workflow-1" }],
          },
        },
      },
      { waitUntilProcessed: true },
    );

    expect(written.ok).toBe(true);
    expect(onDistillationError).toHaveBeenCalledWith({
      code: "store_error",
      message: "fact store write failed",
    });
  });
});

async function createWorkspaceDir(): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), "tmp-memory-distillation-"));
  tempDirs.push(dir);
  return dir;
}

async function createMemorySystem(
  workspace: string,
  options: {
    readonly distillation?: import("../src/index.ts").MemoryDistillationPipeline | undefined;
    readonly onDistillationError?:
      | ((error: import("../src/index.ts").MemoryResultError) => void)
      | undefined;
    readonly factStoreOverride?: Partial<
      Awaited<ReturnType<typeof createFileSystemFactMemoryStore>>
    >;
  } = {},
): Promise<MemorySystem> {
  const taskStore = createFileSystemTaskMemoryStore({
    agentId: "agent-a",
    filePath: join(workspace, "task.json"),
  });
  const experienceStore = createFileSystemExperienceMemoryStore({
    agentId: "agent-a",
    filePath: join(workspace, "experience.json"),
  });
  const factStore = createFileSystemFactMemoryStore({
    agentId: "agent-a",
    filePath: join(workspace, "fact.json"),
  });
  const memorySystem = new MemorySystem({
    taskStore,
    experienceStore,
    factStore:
      options.factStoreOverride === undefined
        ? factStore
        : {
            ...factStore,
            ...options.factStoreOverride,
          },
    evidenceStore: createFileSystemMemoryEvidenceStore(createPluginContext(workspace)),
    distillation: options.distillation ?? createDefaultMemoryDistillationPipeline(),
    onDistillationError: options.onDistillationError,
  });

  return memorySystem;
}

function createPluginContext(workspace: string) {
  return {
    workspaceRoot: workspace,
    agent: { id: "agent-a" },
    contextSystem: {
      async read() {
        return { ok: false, error: { code: "context_not_found", message: "not found" } };
      },
    },
    env: {},
    config: {
      skill: {
        memoryRoot: workspace,
      },
    },
  } as unknown as Parameters<typeof createFileSystemMemoryEvidenceStore>[0];
}
