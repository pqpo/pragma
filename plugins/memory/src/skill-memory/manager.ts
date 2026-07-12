import { readFile } from "node:fs/promises";

import type {
  ExpertAgentPluginSessionContext,
  ExpertAgentPluginSetupContext,
  ExpertAgentPluginStreamEventContext,
  ExpertAgentPluginTaskSubmittedContext,
  RuntimeSessionRef,
} from "@pragma/core";
import { readExecutionRunScope } from "@pragma/core";
import type { MemorySystem } from "../memory-system/index.ts";
import { dedupeRuntimeSessions } from "../memory-system/runtime-session.ts";

import {
  JSON_EXTENSION,
  MARKDOWN_EXTENSION,
  RUNS_EVIDENCE_PREFIX,
  TASKS_PREFIX,
  EXECUTIONS_EVIDENCE_PREFIX,
} from "../context-projection/constants.ts";
import { resolveConfig } from "./config.ts";
import {
  createStoredContext,
  exists,
  regenerateSummary,
  resolveContextPath,
  resolveMemoryArtifactRoots,
  writeJson,
  writeStoredMarkdown,
} from "../context-projection/filesystem.ts";
import {
  deriveLessonsFromEvidence,
  renderTaskSummary,
  renderExecutionSummary,
} from "./rendering.ts";
import { MemoryRunEvidenceSchema, MemoryExecutionEvidenceSchema } from "./schema.ts";
import type { MemoryRunEvidence, MemoryExecutionEvidence } from "./schema.ts";
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
  private readonly executionLocks = new Map<string, Promise<void>>();
  private readonly runtimeSessionExecutionIds = new Map<string, Set<string>>();

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
    const executionId = readExecutionId(streamContext.context);

    if (executionId === undefined) {
      return;
    }

    const runId = sanitizeIdSegment(streamContext.runId);
    const now = new Date().toISOString();
    await this.withSerializedMutation(this.runLocks, runId, async () => {
      const evidence = await this.readOrCreateRunEvidence(rootDir, {
        executionId,
        runId,
        query: "Task submitted",
        runtimeSession: streamContext.session.runtimeSession,
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
    const executionId = readExecutionId(taskContext.context);

    if (executionId === undefined) {
      return;
    }

    const runId = sanitizeIdSegment(taskContext.runId);
    const now = new Date().toISOString();
    const externalContext = taskContext.context?.attributes?.["externalContext"] === true;
    const evidence = await this.withSerializedMutation(this.runLocks, runId, async () => {
      const runEvidence = await this.readOrCreateRunEvidence(rootDir, {
        executionId,
        runId,
        query: taskContext.submission.query,
        runtimeSession: taskContext.session.runtimeSession,
        externalContext,
        now,
      });

      runEvidence.query = taskContext.submission.query;
      runEvidence.externalContext = externalContext;
      runEvidence.runtimeSession = taskContext.session.runtimeSession;
      runEvidence.source = {
        runtimeSession: taskContext.session.runtimeSession,
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

    this.trackRuntimeSessionExecution(taskContext.session.systemSessionId, executionId);

    await this.withSerializedMutation(this.executionLocks, executionId, async () => {
      const executionEvidence = await this.readOrCreateExecutionEvidence(rootDir, {
        executionId,
        runtimeSession: taskContext.session.runtimeSession,
        externalContext,
        now,
      });
      executionEvidence.runIds = dedupeStrings([...executionEvidence.runIds, runId]);
      executionEvidence.runtimeSessions = dedupeRuntimeSessions([
        ...executionEvidence.runtimeSessions,
        taskContext.session.runtimeSession,
      ]);
      executionEvidence.externalContext = executionEvidence.externalContext || externalContext;
      executionEvidence.updatedAt = now;
      executionEvidence.consolidationState = "pending";
      await writeJson(
        resolveContextPath(rootDir, `${EXECUTIONS_EVIDENCE_PREFIX}${executionId}${JSON_EXTENSION}`),
        executionEvidence,
      );
    });

    await this.writeTaskSummary(rootDir, executionId, evidence, now);
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
    const executionIds = this.runtimeSessionExecutionIds.get(systemSessionId);

    if (executionIds === undefined) {
      return;
    }

    for (const executionId of executionIds) {
      await this.finalizeExecution(roots, config, executionId);
    }

    this.runtimeSessionExecutionIds.delete(systemSessionId);
  }

  private async finalizeExecution(
    roots: ReturnType<typeof resolveMemoryArtifactRoots>,
    config: Awaited<ReturnType<typeof resolveConfig>>,
    executionId: string,
  ): Promise<void> {
    const rootDir = roots.contextRootDir;
    const executionEvidencePath = resolveContextPath(
      rootDir,
      `${EXECUTIONS_EVIDENCE_PREFIX}${executionId}${JSON_EXTENSION}`,
    );

    if (!(await exists(executionEvidencePath))) {
      return;
    }

    const executionEvidence = MemoryExecutionEvidenceSchema.parse(
      JSON.parse(await readFile(executionEvidencePath, "utf8")) as unknown,
    );
    const runEvidence = await Promise.all(
      executionEvidence.runIds.map(async (runId) => {
        const path = resolveContextPath(
          rootDir,
          `${RUNS_EVIDENCE_PREFIX}${runId}${JSON_EXTENSION}`,
        );
        return MemoryRunEvidenceSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
      }),
    );
    const now = new Date().toISOString();

    await this.writeExecutionSummary(rootDir, executionEvidence, runEvidence, now);

    if (!(config.disableOnExternalContext && executionEvidence.externalContext)) {
      await this.context.memorySystem.recordEvidence(
        {
          record: {
            id: `execution-${executionEvidence.executionId}`,
            type: "evidence",
            kind: "execution",
            agentId: this.agentId,
            scope: "session",
            executionId: executionEvidence.executionId,
            runtimeSession: executionEvidence.runtimeSessions[0],
            payload: {
              executionId: executionEvidence.executionId,
              runtimeSessions: executionEvidence.runtimeSessions,
              runIds: executionEvidence.runIds,
              externalContext: executionEvidence.externalContext,
              runs: runEvidence.map((run) => ({
                query: run.query,
                status: run.status,
                outputExcerpt: run.outputExcerpt,
                errorMessage: run.errorMessage,
                lessons: run.lessons,
                tools: run.tools,
              })),
            },
            createdAt: executionEvidence.createdAt,
            updatedAt: now,
            provenance: {
              createdBy: "skill-memory",
              updatedBy: "skill-memory",
              source: "execution-evidence",
              createdAt: executionEvidence.createdAt,
              updatedAt: now,
              evidence: [
                { type: "execution", id: executionEvidence.executionId },
                ...executionEvidence.runIds.map((runId) => ({ type: "run" as const, id: runId })),
              ],
            },
          },
        },
        {
          waitUntilProcessed: true,
        },
      );
    }

    executionEvidence.consolidationState = "skills_updated";
    executionEvidence.updatedAt = now;
    await writeJson(executionEvidencePath, executionEvidence);
    await regenerateSummary(roots, this.context.memorySystem, this.agentId);
  }

  private async readOrCreateRunEvidence(
    rootDir: string,
    options: {
      readonly executionId: string;
      readonly runId: string;
      readonly query: string;
      readonly runtimeSession: RuntimeSessionRef;
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
      executionId: options.executionId,
      runtimeSession: options.runtimeSession,
      runId: options.runId,
      query: options.query,
      status: "running",
      externalContext: options.externalContext,
      createdAt: options.now,
      updatedAt: options.now,
      source: {
        runtimeSession: options.runtimeSession,
      },
      audit: { createdBy: "skill-memory" },
    });
    await writeJson(path, evidence);
    return evidence;
  }

  private async readOrCreateExecutionEvidence(
    rootDir: string,
    options: {
      readonly executionId: string;
      readonly runtimeSession: RuntimeSessionRef;
      readonly externalContext: boolean;
      readonly now: string;
    },
  ): Promise<MemoryExecutionEvidence> {
    const path = resolveContextPath(
      rootDir,
      `${EXECUTIONS_EVIDENCE_PREFIX}${options.executionId}${JSON_EXTENSION}`,
    );

    if (await exists(path)) {
      return MemoryExecutionEvidenceSchema.parse(
        JSON.parse(await readFile(path, "utf8")) as unknown,
      );
    }

    const evidence = MemoryExecutionEvidenceSchema.parse({
      agentId: this.agentId,
      executionId: options.executionId,
      runtimeSessions: [options.runtimeSession],
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
    executionId: string,
    evidence: MemoryRunEvidence,
    now: string,
  ): Promise<void> {
    const id = `${TASKS_PREFIX}executions/${executionId}/${evidence.runId}${MARKDOWN_EXTENSION}`;
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
        executionId,
        runId: evidence.runId,
        updatedAt: now,
        audit: { createdBy: "skill-memory", createdFromRunId: evidence.runId },
      },
    );
  }

  private async writeExecutionSummary(
    rootDir: string,
    executionEvidence: MemoryExecutionEvidence,
    runEvidence: readonly MemoryRunEvidence[],
    now: string,
  ): Promise<void> {
    const id = `${TASKS_PREFIX}executions/${executionEvidence.executionId}/execution${MARKDOWN_EXTENSION}`;
    await writeStoredMarkdown(
      rootDir,
      createStoredContext({
        id,
        content: renderExecutionSummary(executionEvidence, runEvidence),
        metadata: {
          description: `LLM-style execution summary for ${executionEvidence.executionId}.`,
          trigger: "manual",
        },
      }),
      {
        schemaVersion: "pragma.memory-execution-summary/v1",
        agentId: this.agentId,
        executionId: executionEvidence.executionId,
        updatedAt: now,
        audit: { createdBy: "skill-memory" },
      },
    );
  }

  private trackRuntimeSessionExecution(systemSessionId: string, executionId: string): void {
    const key = sanitizeIdSegment(systemSessionId);
    const executionIds = this.runtimeSessionExecutionIds.get(key) ?? new Set<string>();
    executionIds.add(executionId);
    this.runtimeSessionExecutionIds.set(key, executionIds);
  }
}

function readExecutionId(
  context: ExpertAgentPluginTaskSubmittedContext["context"],
): string | undefined {
  const executionId = readExecutionRunScope(context).executionId;
  return executionId === undefined ? undefined : sanitizeIdSegment(executionId);
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
