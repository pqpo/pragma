import { readFile } from "node:fs/promises";

import type {
  ExpertAgentPluginSessionContext,
  ExpertAgentPluginSetupContext,
  ExpertAgentPluginStreamEventContext,
  ExpertAgentPluginTaskSubmittedContext,
} from "@pragma/core";
import type { MemorySystem } from "../memory-system/index.ts";

import {
  JSON_EXTENSION,
  MARKDOWN_EXTENSION,
  RUNS_EVIDENCE_PREFIX,
  SESSIONS_EVIDENCE_PREFIX,
  TASKS_PREFIX,
} from "./constants.ts";
import { resolveConfig } from "./config.ts";
import {
  createStoredContext,
  exists,
  readStoredContext,
  regenerateSummary,
  resolveContextPath,
  resolveMemoryRoot,
  writeJson,
  writeStoredMarkdown,
} from "./filesystem.ts";
import {
  deriveLessonsFromEvidence,
  deriveSkillId,
  mergeSkillContent,
  renderSessionSummary,
  renderTaskSummary,
} from "./rendering.ts";
import { MemoryRunEvidenceSchema, MemorySessionEvidenceSchema } from "./schema.ts";
import type { MemoryRunEvidence, MemorySessionEvidence } from "./schema.ts";
import {
  containsSensitiveContent,
  dedupeStrings,
  extractLastUpdatedSessions,
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
  private readonly sessionLocks = new Map<string, Promise<void>>();

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

    const rootDir = resolveMemoryRoot(this.context.workspaceRoot, config, this.agentId);
    const sessionId = sanitizeIdSegment(streamContext.session.systemSessionId);
    const runId = sanitizeIdSegment(streamContext.runId);
    const now = new Date().toISOString();
    await this.withSerializedMutation(this.runLocks, runId, async () => {
      const evidence = await this.readOrCreateRunEvidence(rootDir, {
        sessionId,
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

    const rootDir = resolveMemoryRoot(this.context.workspaceRoot, config, this.agentId);
    const sessionId = sanitizeIdSegment(taskContext.session.systemSessionId);
    const runId = sanitizeIdSegment(taskContext.runId);
    const now = new Date().toISOString();
    const externalContext = taskContext.context?.attributes?.["externalContext"] === true;
    const evidence = await this.withSerializedMutation(this.runLocks, runId, async () => {
      const runEvidence = await this.readOrCreateRunEvidence(rootDir, {
        sessionId,
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
        runEvidence.status =
          taskContext.session.runState === "cancelled" ? "cancelled" : "failed";
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

    await this.withSerializedMutation(this.sessionLocks, sessionId, async () => {
      const sessionEvidence = await this.readOrCreateSessionEvidence(rootDir, {
        sessionId,
        runtimeSessionId: taskContext.session.runtimeSession.id,
        externalContext,
        now,
      });
      sessionEvidence.runIds = dedupeStrings([...sessionEvidence.runIds, runId]);
      sessionEvidence.externalContext = sessionEvidence.externalContext || externalContext;
      sessionEvidence.updatedAt = now;
      sessionEvidence.consolidationState = "pending";
      await writeJson(
        resolveContextPath(rootDir, `${SESSIONS_EVIDENCE_PREFIX}${sessionId}${JSON_EXTENSION}`),
        sessionEvidence,
      );
    });

    await this.writeTaskSummary(rootDir, sessionId, evidence, now);
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

    lockMap.set(key, previous.then(() => current, () => current));

    await previous;

    try {
      return await operation();
    } finally {
      releaseCurrent?.();
      if (lockMap.get(key) === current) {
        lockMap.delete(key);
      }
    }
  }

  async finalizeSession(sessionContext: ExpertAgentPluginSessionContext): Promise<void> {
    const config = await resolveConfig(this.context);

    if (!config.enabled || !config.generateMemories) {
      return;
    }

    const rootDir = resolveMemoryRoot(this.context.workspaceRoot, config, this.agentId);
    const sessionId = sanitizeIdSegment(sessionContext.session.systemSessionId);
    const sessionEvidencePath = resolveContextPath(
      rootDir,
      `${SESSIONS_EVIDENCE_PREFIX}${sessionId}${JSON_EXTENSION}`,
    );

    if (!(await exists(sessionEvidencePath))) {
      return;
    }

    const sessionEvidence = MemorySessionEvidenceSchema.parse(
      JSON.parse(await readFile(sessionEvidencePath, "utf8")) as unknown,
    );
    const runEvidence = await Promise.all(
      sessionEvidence.runIds.map(async (runId) => {
        const path = resolveContextPath(rootDir, `${RUNS_EVIDENCE_PREFIX}${runId}${JSON_EXTENSION}`);
        return MemoryRunEvidenceSchema.parse(
          JSON.parse(await readFile(path, "utf8")) as unknown,
        );
      }),
    );
    const now = new Date().toISOString();

    await this.writeSessionSummary(rootDir, sessionEvidence, runEvidence, now);

    if (!(config.disableOnExternalContext && sessionEvidence.externalContext)) {
      await this.mergeSkillCard(rootDir, sessionEvidence, runEvidence, now);
    }

    sessionEvidence.consolidationState = "skills_updated";
    sessionEvidence.updatedAt = now;
    await writeJson(sessionEvidencePath, sessionEvidence);
    await regenerateSummary(rootDir, this.context.memorySystem, this.agentId);
  }

  private async readOrCreateRunEvidence(
    rootDir: string,
    options: {
      readonly sessionId: string;
      readonly runId: string;
      readonly query: string;
      readonly runtimeSessionId: string;
      readonly externalContext: boolean;
      readonly now: string;
    },
  ): Promise<MemoryRunEvidence> {
    const path = resolveContextPath(rootDir, `${RUNS_EVIDENCE_PREFIX}${options.runId}${JSON_EXTENSION}`);

    if (await exists(path)) {
      return MemoryRunEvidenceSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
    }

    const evidence = MemoryRunEvidenceSchema.parse({
      agentId: this.agentId,
      sessionId: options.sessionId,
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

  private async readOrCreateSessionEvidence(
    rootDir: string,
    options: {
      readonly sessionId: string;
      readonly runtimeSessionId: string;
      readonly externalContext: boolean;
      readonly now: string;
    },
  ): Promise<MemorySessionEvidence> {
    const path = resolveContextPath(
      rootDir,
      `${SESSIONS_EVIDENCE_PREFIX}${options.sessionId}${JSON_EXTENSION}`,
    );

    if (await exists(path)) {
      return MemorySessionEvidenceSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
    }

    const evidence = MemorySessionEvidenceSchema.parse({
      agentId: this.agentId,
      sessionId: options.sessionId,
      runtimeSessionId: options.runtimeSessionId,
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
    sessionId: string,
    evidence: MemoryRunEvidence,
    now: string,
  ): Promise<void> {
    const id = `${TASKS_PREFIX}${sessionId}/${evidence.runId}${MARKDOWN_EXTENSION}`;
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
        sessionId,
        runId: evidence.runId,
        updatedAt: now,
        audit: { createdBy: "skill-memory", createdFromRunId: evidence.runId },
        model: "taskSummaryModel",
      },
    );
  }

  private async writeSessionSummary(
    rootDir: string,
    sessionEvidence: MemorySessionEvidence,
    runEvidence: readonly MemoryRunEvidence[],
    now: string,
  ): Promise<void> {
    const id = `${TASKS_PREFIX}${sessionEvidence.sessionId}/session${MARKDOWN_EXTENSION}`;
    await writeStoredMarkdown(
      rootDir,
      createStoredContext({
        id,
        content: renderSessionSummary(sessionEvidence, runEvidence),
        metadata: {
          description: `LLM-style session summary for ${sessionEvidence.sessionId}.`,
          trigger: "manual",
        },
      }),
      {
        schemaVersion: "pragma.memory-session-summary/v1",
        agentId: this.agentId,
        sessionId: sessionEvidence.sessionId,
        updatedAt: now,
        audit: { createdBy: "skill-memory" },
        model: "sessionSummaryModel",
      },
    );
  }

  private async mergeSkillCard(
    rootDir: string,
    sessionEvidence: MemorySessionEvidence,
    runEvidence: readonly MemoryRunEvidence[],
    now: string,
  ): Promise<void> {
    const skillId = deriveSkillId(runEvidence);
    const id = `skills/${skillId}.md`;
    const existing = (await exists(resolveContextPath(rootDir, id)))
      ? await readStoredContext(rootDir, id)
      : undefined;
    await writeStoredMarkdown(
      rootDir,
      createStoredContext({
        id,
        content: mergeSkillContent(existing?.content, sessionEvidence, runEvidence),
        metadata: {
          description: `Detailed skill card derived from session ${sessionEvidence.sessionId}.`,
          trigger: "model_decision",
        },
      }),
      {
        schemaVersion: "pragma.memory-skill/v1",
        agentId: this.agentId,
        skillId,
        updatedAt: now,
        audit: { createdBy: "skill-memory" },
        model: "skillMergeModel",
        sessions: dedupeStrings([
          sessionEvidence.sessionId,
          ...extractLastUpdatedSessions(existing?.content),
        ]),
      },
    );
  }
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
