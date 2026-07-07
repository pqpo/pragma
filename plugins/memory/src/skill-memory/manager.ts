import { readFile } from "node:fs/promises";

import type {
  ExpertAgentPluginSessionContext,
  ExpertAgentPluginSetupContext,
  ExpertAgentPluginStreamEventContext,
  ExpertAgentPluginTaskSubmittedContext,
} from "@pragma/core";
import { readExecutionRunScope } from "@pragma/core";
import type { MemorySystem } from "../memory-system/index.ts";

import {
  JSON_EXTENSION,
  MARKDOWN_EXTENSION,
  RUNS_EVIDENCE_PREFIX,
  TASKS_PREFIX,
  WORKFLOWS_EVIDENCE_PREFIX,
} from "../memory-context/constants.ts";
import { resolveConfig } from "./config.ts";
import {
  createStoredContext,
  exists,
  regenerateSummary,
  resolveContextPath,
  resolveMemoryArtifactRoots,
  writeJson,
  writeStoredMarkdown,
} from "../memory-context/filesystem.ts";
import { deriveLessonsFromEvidence, renderTaskSummary, renderWorkflowSummary } from "./rendering.ts";
import { MemoryRunEvidenceSchema, MemoryWorkflowEvidenceSchema } from "./schema.ts";
import type { MemoryRunEvidence, MemoryWorkflowEvidence } from "./schema.ts";
import {
  containsSensitiveContent,
  dedupeStrings,
  readErrorMessage,
  sanitizeIdSegment,
  stringifyOutput,
  trimCharacters,
} from "./utils.ts";

export class SkillMemoryManager {
  private readonly context: ExpertAgentPluginSetupContext & {
    readonly memorySystem: MemorySystem;
  };
  private readonly agentId: string;
  private readonly runLocks = new Map<string, Promise<void>>();
  private readonly workflowLocks = new Map<string, Promise<void>>();
  private readonly runtimeSessionWorkflowIds = new Map<string, Set<string>>();

  constructor(
    context: ExpertAgentPluginSetupContext & {
      readonly memorySystem: MemorySystem;
    },
  ) {
    this.context = context;
    this.agentId = context.agent?.id ?? "unknown-agent";
  }

  async recordStreamEvent(streamContext: ExpertAgentPluginStreamEventContext): Promise<void> {
    const config = await resolveConfig(this.context);

    if (!config.enabled || !config.generateMemories) {
      return;
    }

    const roots = resolveMemoryArtifactRoots(this.context.workspaceRoot, config, this.agentId);
    const rootDir = roots.contextRootDir;
    const workflowRunId = readWorkflowRunId(streamContext.context);

    if (workflowRunId === undefined) {
      return;
    }

    const runId = sanitizeIdSegment(streamContext.runId);
    const now = new Date().toISOString();
    await this.withSerializedMutation(this.runLocks, runId, async () => {
      const evidence = await this.readOrCreateRunEvidence(rootDir, {
        workflowRunId,
        runId,
        query: "Task submitted",
        runtimeSessionId: streamContext.session.runtimeSession.id,
        externalContext: streamContext.context?.attributes?.["externalContext"] === true,
        now,
      });

      applyStreamEvent(
        evidence,
        streamContext.event,
        config.maxOutputExcerptChars,
        config.maxToolExcerptChars,
      );
      evidence.updatedAt = now;
      await writeJson(
        resolveContextPath(rootDir, `${RUNS_EVIDENCE_PREFIX}${runId}${JSON_EXTENSION}`),
        evidence,
      );
    });
  }

  async recordTask(taskContext: ExpertAgentPluginTaskSubmittedContext): Promise<void> {
    const config = await resolveConfig(this.context);

    if (!config.enabled || !config.generateMemories) {
      return;
    }

    const roots = resolveMemoryArtifactRoots(this.context.workspaceRoot, config, this.agentId);
    const rootDir = roots.contextRootDir;
    const workflowRunId = readWorkflowRunId(taskContext.context);

    if (workflowRunId === undefined) {
      return;
    }

    const runId = sanitizeIdSegment(taskContext.runId);
    const now = new Date().toISOString();
    const externalContext = taskContext.context?.attributes?.["externalContext"] === true;
    const evidence = await this.withSerializedMutation(this.runLocks, runId, async () => {
      const runEvidence = await this.readOrCreateRunEvidence(rootDir, {
        workflowRunId,
        runId,
        query: taskContext.submission.query,
        runtimeSessionId: taskContext.session.runtimeSession.id,
        externalContext,
        now,
      });

      runEvidence.query = taskContext.submission.query;
      runEvidence.externalContext = externalContext;
      runEvidence.runtimeSessionId = taskContext.session.runtimeSession.id;
      runEvidence.source = {
        runtimeKind: taskContext.session.runtime.kind,
        runtimeSessionId: taskContext.session.runtimeSession.id,
      };

      if (taskContext.result !== undefined) {
        const output = stringifyOutput(taskContext.result.result.output);
        runEvidence.status = "succeeded";
        runEvidence.outputExcerpt = trimCharacters(output, config.maxOutputExcerptChars);
        if (output.length >= config.minRunOutputChars && !containsSensitiveContent(output)) {
          runEvidence.lessons = [...deriveLessonsFromEvidence(runEvidence)];
        }
      } else if (taskContext.error !== undefined) {
        const errorMessage = trimCharacters(
          readErrorMessage(taskContext.error),
          config.maxOutputExcerptChars,
        );
        runEvidence.status = taskContext.session.runState === "cancelled" ? "cancelled" : "failed";
        runEvidence.errorMessage = errorMessage;
        if (!containsSensitiveContent(errorMessage)) {
          runEvidence.lessons = [...deriveLessonsFromEvidence(runEvidence)];
        }
      }

      runEvidence.updatedAt = now;
      await writeJson(
        resolveContextPath(rootDir, `${RUNS_EVIDENCE_PREFIX}${runId}${JSON_EXTENSION}`),
        runEvidence,
      );

      return runEvidence;
    });

    this.trackRuntimeSessionWorkflow(taskContext.session.systemSessionId, workflowRunId);

    await this.withSerializedMutation(this.workflowLocks, workflowRunId, async () => {
      const workflowEvidence = await this.readOrCreateWorkflowEvidence(rootDir, {
        workflowRunId,
        runtimeSessionId: taskContext.session.runtimeSession.id,
        externalContext,
        now,
      });
      workflowEvidence.runIds = dedupeStrings([...workflowEvidence.runIds, runId]);
      workflowEvidence.runtimeSessionIds = dedupeStrings([
        ...workflowEvidence.runtimeSessionIds,
        taskContext.session.runtimeSession.id,
      ]);
      workflowEvidence.externalContext = workflowEvidence.externalContext || externalContext;
      workflowEvidence.updatedAt = now;
      workflowEvidence.consolidationState = "pending";
      await writeJson(
        resolveContextPath(rootDir, `${WORKFLOWS_EVIDENCE_PREFIX}${workflowRunId}${JSON_EXTENSION}`),
        workflowEvidence,
      );
    });

    await this.writeTaskSummary(rootDir, workflowRunId, evidence, now);
  }

  private async withSerializedMutation<T>(
    lockMap: Map<string, Promise<void>>,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = lockMap.get(key) ?? Promise.resolve();
    let releaseCurrent: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const next = previous.then(
      () => current,
      () => current,
    );

    lockMap.set(key, next);

    await previous;

    try {
      return await operation();
    } finally {
      releaseCurrent?.();
      if (lockMap.get(key) === next) {
        lockMap.delete(key);
      }
    }
  }

  async finalizeSession(sessionContext: ExpertAgentPluginSessionContext): Promise<void> {
    const config = await resolveConfig(this.context);

    if (!config.enabled || !config.generateMemories) {
      return;
    }

    const roots = resolveMemoryArtifactRoots(this.context.workspaceRoot, config, this.agentId);
    const systemSessionId = sanitizeIdSegment(sessionContext.session.systemSessionId);
    const workflowRunIds = this.runtimeSessionWorkflowIds.get(systemSessionId);

    if (workflowRunIds === undefined) {
      return;
    }

    for (const workflowRunId of workflowRunIds) {
      await this.finalizeWorkflow(roots, config, workflowRunId);
    }

    this.runtimeSessionWorkflowIds.delete(systemSessionId);
  }

  private async finalizeWorkflow(
    roots: ReturnType<typeof resolveMemoryArtifactRoots>,
    config: Awaited<ReturnType<typeof resolveConfig>>,
    workflowRunId: string,
  ): Promise<void> {
    const rootDir = roots.contextRootDir;
    const workflowEvidencePath = resolveContextPath(
      rootDir,
      `${WORKFLOWS_EVIDENCE_PREFIX}${workflowRunId}${JSON_EXTENSION}`,
    );

    if (!(await exists(workflowEvidencePath))) {
      return;
    }

    const workflowEvidence = MemoryWorkflowEvidenceSchema.parse(
      JSON.parse(await readFile(workflowEvidencePath, "utf8")) as unknown,
    );
    const runEvidence = await Promise.all(
      workflowEvidence.runIds.map(async (runId) => {
        const path = resolveContextPath(
          rootDir,
          `${RUNS_EVIDENCE_PREFIX}${runId}${JSON_EXTENSION}`,
        );
        return MemoryRunEvidenceSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
      }),
    );
    const now = new Date().toISOString();

    await this.writeWorkflowSummary(rootDir, workflowEvidence, runEvidence, now);

    if (!(config.disableOnExternalContext && workflowEvidence.externalContext)) {
      await this.context.memorySystem.recordEvidence(
        {
          record: {
            id: `workflow-${workflowEvidence.workflowRunId}`,
            type: "evidence",
            kind: "workflow",
            agentId: this.agentId,
            scope: "session",
            workflowRunId: workflowEvidence.workflowRunId,
            runtimeSessionId: workflowEvidence.runtimeSessionIds[0],
            payload: {
              workflowRunId: workflowEvidence.workflowRunId,
              runtimeSessionIds: workflowEvidence.runtimeSessionIds,
              runIds: workflowEvidence.runIds,
              externalContext: workflowEvidence.externalContext,
              runs: runEvidence.map((run) => ({
                query: run.query,
                status: run.status,
                outputExcerpt: run.outputExcerpt,
                errorMessage: run.errorMessage,
                lessons: run.lessons,
                tools: run.tools,
              })),
            },
            createdAt: workflowEvidence.createdAt,
            updatedAt: now,
            provenance: {
              createdBy: "skill-memory",
              updatedBy: "skill-memory",
              source: "workflow-evidence",
              createdAt: workflowEvidence.createdAt,
              updatedAt: now,
              evidence: [
                { type: "workflow", id: workflowEvidence.workflowRunId },
                ...workflowEvidence.runIds.map((runId) => ({ type: "run" as const, id: runId })),
              ],
            },
          },
        },
        {
          waitUntilProcessed: true,
        },
      );
    }

    workflowEvidence.consolidationState = "skills_updated";
    workflowEvidence.updatedAt = now;
    await writeJson(workflowEvidencePath, workflowEvidence);
    await regenerateSummary(roots, this.context.memorySystem, this.agentId);
  }

  private async readOrCreateRunEvidence(
    rootDir: string,
    options: {
      readonly workflowRunId: string;
      readonly runId: string;
      readonly query: string;
      readonly runtimeSessionId: string;
      readonly externalContext: boolean;
      readonly now: string;
    },
  ): Promise<MemoryRunEvidence> {
    const path = resolveContextPath(
      rootDir,
      `${RUNS_EVIDENCE_PREFIX}${options.runId}${JSON_EXTENSION}`,
    );

    if (await exists(path)) {
      return MemoryRunEvidenceSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
    }

    const evidence = MemoryRunEvidenceSchema.parse({
      agentId: this.agentId,
      workflowRunId: options.workflowRunId,
      runtimeSessionId: options.runtimeSessionId,
      runId: options.runId,
      query: options.query,
      status: "running",
      externalContext: options.externalContext,
      createdAt: options.now,
      updatedAt: options.now,
      source: {
        runtimeSessionId: options.runtimeSessionId,
      },
      audit: { createdBy: "skill-memory" },
    });
    await writeJson(path, evidence);
    return evidence;
  }

  private async readOrCreateWorkflowEvidence(
    rootDir: string,
    options: {
      readonly workflowRunId: string;
      readonly runtimeSessionId: string;
      readonly externalContext: boolean;
      readonly now: string;
    },
  ): Promise<MemoryWorkflowEvidence> {
    const path = resolveContextPath(
      rootDir,
      `${WORKFLOWS_EVIDENCE_PREFIX}${options.workflowRunId}${JSON_EXTENSION}`,
    );

    if (await exists(path)) {
      return MemoryWorkflowEvidenceSchema.parse(
        JSON.parse(await readFile(path, "utf8")) as unknown,
      );
    }

    const evidence = MemoryWorkflowEvidenceSchema.parse({
      agentId: this.agentId,
      workflowRunId: options.workflowRunId,
      runtimeSessionIds: [options.runtimeSessionId],
      externalContext: options.externalContext,
      createdAt: options.now,
      updatedAt: options.now,
      audit: { createdBy: "skill-memory" },
    });
    await writeJson(path, evidence);
    return evidence;
  }

  private async writeTaskSummary(
    rootDir: string,
    workflowRunId: string,
    evidence: MemoryRunEvidence,
    now: string,
  ): Promise<void> {
    const id = `${TASKS_PREFIX}workflows/${workflowRunId}/${evidence.runId}${MARKDOWN_EXTENSION}`;
    await writeStoredMarkdown(
      rootDir,
      createStoredContext({
        id,
        content: renderTaskSummary(evidence),
        metadata: {
          description: `LLM-style task summary for run ${evidence.runId}.`,
          trigger: "manual",
        },
      }),
      {
        schemaVersion: "pragma.memory-task-summary/v1",
        agentId: this.agentId,
        workflowRunId,
        runId: evidence.runId,
        updatedAt: now,
        audit: { createdBy: "skill-memory", createdFromRunId: evidence.runId },
      },
    );
  }

  private async writeWorkflowSummary(
    rootDir: string,
    workflowEvidence: MemoryWorkflowEvidence,
    runEvidence: readonly MemoryRunEvidence[],
    now: string,
  ): Promise<void> {
    const id = `${TASKS_PREFIX}workflows/${workflowEvidence.workflowRunId}/workflow${MARKDOWN_EXTENSION}`;
    await writeStoredMarkdown(
      rootDir,
      createStoredContext({
        id,
        content: renderWorkflowSummary(workflowEvidence, runEvidence),
        metadata: {
          description: `LLM-style workflow summary for ${workflowEvidence.workflowRunId}.`,
          trigger: "manual",
        },
      }),
      {
        schemaVersion: "pragma.memory-workflow-summary/v1",
        agentId: this.agentId,
        workflowRunId: workflowEvidence.workflowRunId,
        updatedAt: now,
        audit: { createdBy: "skill-memory" },
      },
    );
  }

  private trackRuntimeSessionWorkflow(systemSessionId: string, workflowRunId: string): void {
    const key = sanitizeIdSegment(systemSessionId);
    const workflowRunIds = this.runtimeSessionWorkflowIds.get(key) ?? new Set<string>();
    workflowRunIds.add(workflowRunId);
    this.runtimeSessionWorkflowIds.set(key, workflowRunIds);
  }
}

function readWorkflowRunId(context: ExpertAgentPluginTaskSubmittedContext["context"]): string | undefined {
  const workflowRunId = readExecutionRunScope(context).workflowRunId;
  return workflowRunId === undefined ? undefined : sanitizeIdSegment(workflowRunId);
}

function applyStreamEvent(
  evidence: MemoryRunEvidence,
  event: ExpertAgentPluginStreamEventContext["event"],
  maxOutputExcerptChars: number,
  maxToolExcerptChars: number,
): void {
  switch (event.type) {
    case "run.started":
      evidence.query = event.payload.task;
      break;
    case "run.completed":
      evidence.status = "succeeded";
      break;
    case "run.failed":
      evidence.status = "failed";
      evidence.errorMessage = trimCharacters(event.payload.message, maxOutputExcerptChars);
      break;
    case "run.cancelled":
      evidence.status = "cancelled";
      evidence.errorMessage = trimCharacters(
        event.payload.reason ?? "cancelled",
        maxOutputExcerptChars,
      );
      break;
    case "message.completed":
      if (event.payload.text !== undefined) {
        evidence.outputExcerpt = trimCharacters(event.payload.text, maxOutputExcerptChars);
      }
      break;
    case "tool.started":
      upsertToolEvidence(evidence, {
        toolName: event.payload.toolName,
        status: "started",
      });
      break;
    case "tool.completed":
      upsertToolEvidence(evidence, {
        toolName: event.payload.toolName,
        status: "completed",
        outputExcerpt:
          event.payload.outputPreview === undefined
            ? undefined
            : trimCharacters(JSON.stringify(event.payload.outputPreview), maxToolExcerptChars),
      });
      break;
    case "tool.failed":
      upsertToolEvidence(evidence, {
        toolName: event.payload.toolName,
        status: "failed",
        errorMessage: trimCharacters(event.payload.message, maxToolExcerptChars),
      });
      break;
    default:
      break;
  }
}

function upsertToolEvidence(
  evidence: MemoryRunEvidence,
  update: {
    readonly toolName: string;
    readonly status: "started" | "completed" | "failed";
    readonly outputExcerpt?: string | undefined;
    readonly errorMessage?: string | undefined;
  },
): void {
  const existingIndex = evidence.tools.findIndex((tool) => tool.toolName === update.toolName);
  const next = {
    toolName: update.toolName,
    status: update.status,
    ...(update.outputExcerpt === undefined ? {} : { outputExcerpt: update.outputExcerpt }),
    ...(update.errorMessage === undefined ? {} : { errorMessage: update.errorMessage }),
  } as const;

  if (existingIndex === -1) {
    evidence.tools = [...evidence.tools, next];
    return;
  }

  evidence.tools = evidence.tools.map((tool, index) =>
    index === existingIndex
      ? {
          ...tool,
          ...next,
        }
      : tool,
  );
}
