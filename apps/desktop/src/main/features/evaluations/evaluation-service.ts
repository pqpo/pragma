import { randomUUID } from "node:crypto";

import {
  selectAgentEvaluationCaseIds,
  summarizeAgentEvaluationTasks,
  type AgentEvaluationCaseResult,
} from "@pragma/evaluation";
import type { PragmaAgentEvaluationCase } from "@pragma/evaluation/ast";
import { canonicalPragmaResourceRef } from "@pragma/interpreter/ast";

import {
  AgentEvaluationRunSchema,
  CreateAgentEvaluationRunSchema,
  UpdateEvaluationQueueSettingsSchema,
  type AgentEvaluationRun,
  type CreateAgentEvaluationRun,
  type EvaluationQueueSettings,
  type RetryAgentEvaluationTask,
  type UpdateEvaluationQueueSettings,
} from "../../../shared/contracts/index.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { EvaluationStore } from "./evaluation-store.ts";

export interface AgentEvaluationCaseExecutor {
  execute(input: {
    readonly run: AgentEvaluationRun;
    readonly evaluationCase: PragmaAgentEvaluationCase;
    readonly setPhase: (phase: "subject" | "judge") => Promise<void>;
    readonly signal: AbortSignal;
  }): Promise<AgentEvaluationCaseResult>;
}

export interface EvaluationService {
  getSettings(): Promise<EvaluationQueueSettings>;
  updateSettings(input: UpdateEvaluationQueueSettings): Promise<EvaluationQueueSettings>;
  createRun(input: CreateAgentEvaluationRun): Promise<AgentEvaluationRun>;
  listRuns(): Promise<AgentEvaluationRun[]>;
  getRun(id: string): Promise<AgentEvaluationRun>;
  cancelRun(id: string): Promise<AgentEvaluationRun>;
  retryTask(input: RetryAgentEvaluationTask): Promise<AgentEvaluationRun>;
  start(): Promise<void>;
  dispose(): void;
}

export function createEvaluationService(options: {
  readonly store: EvaluationStore;
  readonly project: PragmaProjectStore;
  readonly executor: AgentEvaluationCaseExecutor;
  readonly warn?: ((message: string, error: unknown) => void) | undefined;
}): EvaluationService {
  let disposed = false;
  let scheduled = false;
  const active = new Map<string, AbortController>();
  const taskKey = (runId: string, caseId: string) => `${runId}:${caseId}`;

  const schedule = (): void => {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void drain().catch((error: unknown) => options.warn?.("Evaluation queue failed.", error));
    });
  };

  const drain = async (): Promise<void> => {
    if (disposed) return;
    const settings = await options.store.getSettings();
    if (active.size >= settings.concurrency) return;
    const runs = (await options.store.listRuns()).reverse();
    for (const run of runs) {
      for (const task of run.tasks) {
        if (task.status !== "queued") continue;
        const key = taskKey(run.id, task.caseId);
        if (active.has(key)) continue;
        const controller = new AbortController();
        active.set(key, controller);
        void executeTask(run.id, task.caseId, controller.signal).finally(() => {
          active.delete(key);
          schedule();
        });
        if (active.size >= settings.concurrency) return;
      }
    }
  };

  const setPhase = async (
    runId: string,
    caseId: string,
    phase: "subject" | "judge",
  ): Promise<boolean> => {
    let changed = false;
    await options.store.updateRun(runId, (run) => {
      const tasks = run.tasks.map((task) => {
        const expectedStatus = phase === "subject" ? "queued" : "running-subject";
        if (task.caseId !== caseId || task.status !== expectedStatus) return task;
        changed = true;
        return {
          ...task,
          status: phase === "subject" ? ("running-subject" as const) : ("running-judge" as const),
          startedAt: task.startedAt ?? new Date().toISOString(),
        };
      });
      return refreshRun({ ...run, tasks });
    });
    return changed;
  };

  const executeTask = async (runId: string, caseId: string, signal: AbortSignal): Promise<void> => {
    try {
      const run = await options.store.getRun(runId);
      const evaluationCase = run.dataset.spec.method.cases.find((item) => item.id === caseId);
      if (evaluationCase === undefined) throw new Error(`Evaluation case not found: ${caseId}.`);
      if (signal.aborted || !(await setPhase(runId, caseId, "subject"))) return;
      const result = await options.executor.execute({
        run: await options.store.getRun(runId),
        evaluationCase,
        signal,
        setPhase: async (phase) => {
          if (signal.aborted || !(await setPhase(runId, caseId, phase))) {
            throw new Error("Evaluation task was cancelled.");
          }
        },
      });
      await options.store.updateRun(runId, (current) =>
        refreshRun({
          ...current,
          tasks: current.tasks.map((task) =>
            task.caseId === caseId && task.status !== "cancelled"
              ? {
                  ...task,
                  status: result.resolved ? "resolved" : "unresolved",
                  result,
                  finishedAt: new Date().toISOString(),
                  error: undefined,
                  errorCode: undefined,
                }
              : task,
          ),
        }),
      );
    } catch (error) {
      await options.store
        .updateRun(runId, (run) =>
          refreshRun({
            ...run,
            tasks: run.tasks.map((task) =>
              task.caseId === caseId && task.status !== "cancelled"
                ? {
                    ...task,
                    status: "needs_attention",
                    errorCode: "evaluation_case_execution_failed",
                    error: error instanceof Error ? error.message : String(error),
                    finishedAt: new Date().toISOString(),
                  }
                : task,
            ),
          }),
        )
        .catch((storeError: unknown) =>
          options.warn?.("Evaluation failure was not saved.", storeError),
        );
    }
  };

  return {
    getSettings: () => options.store.getSettings(),
    async updateSettings(input) {
      const parsed = UpdateEvaluationQueueSettingsSchema.parse(input);
      const updated = await options.store.updateSettings((current) => {
        if (current.revision !== parsed.expectedRevision) {
          throw new Error("Evaluation settings changed. Reload and try again.");
        }
        return {
          ...current,
          revision: current.revision + 1,
          concurrency: parsed.concurrency ?? current.concurrency,
          judge: parsed.judge ?? current.judge,
          updatedAt: new Date().toISOString(),
        };
      });
      schedule();
      return updated;
    },
    async createRun(input) {
      const parsed = CreateAgentEvaluationRunSchema.parse(input);
      const project = await options.project.get();
      if (project.revision !== parsed.projectRevision) {
        throw new Error("The Project changed. Reload before creating an evaluation.");
      }
      const dataset = project.resources.find(
        (resource) =>
          resource.kind === "Evaluation" &&
          canonicalPragmaResourceRef(resource) === parsed.evaluationRef,
      );
      if (dataset?.kind !== "Evaluation" || dataset.spec.method.type !== "agent-judge") {
        throw new Error(`Agent evaluation dataset not found: ${parsed.evaluationRef}.`);
      }
      const target = project.resources.find(
        (resource) =>
          (resource.kind === "Expert" || resource.kind === "ExpertTeam") &&
          canonicalPragmaResourceRef(resource) === parsed.targetRef,
      );
      if (target === undefined || (target.kind !== "Expert" && target.kind !== "ExpertTeam")) {
        throw new Error(`Evaluation target not found: ${parsed.targetRef}.`);
      }
      if (dataset.spec.method.execution.mode === "live" && !parsed.liveConfirmed) {
        throw new Error("Live evaluation requires explicit risk confirmation.");
      }
      if (parsed.sampleSize > dataset.spec.method.cases.length) {
        throw new Error("Sample size exceeds the dataset size.");
      }
      const id = randomUUID();
      const selectionSeed = randomUUID();
      const selectedCaseIds = selectAgentEvaluationCaseIds(
        dataset.spec.method.cases,
        parsed.sampleSize,
        selectionSeed,
      );
      const now = new Date().toISOString();
      const run = AgentEvaluationRunSchema.parse({
        schemaVersion: "pragma.agent-evaluation-run/v1",
        id,
        projectId: options.project.projectId,
        projectRevision: project.revision,
        evaluationRef: parsed.evaluationRef,
        evaluationName: dataset.metadata.name,
        group: dataset.spec.method.group,
        executionMode: dataset.spec.method.execution.mode,
        targetRef: parsed.targetRef,
        targetName: target.metadata.name,
        selectionSeed,
        selectedCaseIds,
        dataset,
        judgeResultVersion: "pragma.evaluation-judge-result/v1",
        status: "queued",
        tasks: selectedCaseIds.map((caseId) => ({
          caseId,
          caseName: dataset.spec.method.cases.find((item) => item.id === caseId)?.name ?? caseId,
          status: "queued",
          attempt: 1,
          createdAt: now,
        })),
        summary: summarizeAgentEvaluationTasks(selectedCaseIds.map(() => ({ state: "queued" }))),
        createdAt: now,
        updatedAt: now,
      });
      const saved = await options.store.saveRun(run);
      schedule();
      return saved;
    },
    listRuns: () => options.store.listRuns(),
    getRun: (id) => options.store.getRun(id),
    async cancelRun(id) {
      const cancelledAt = new Date().toISOString();
      const run = await options.store.updateRun(id, (current) =>
        refreshRun({
          ...current,
          tasks: current.tasks.map((task) =>
            task.status === "queued" || task.status.startsWith("running-")
              ? { ...task, status: "cancelled" as const, finishedAt: cancelledAt }
              : task,
          ),
        }),
      );
      for (const [key, controller] of active) {
        if (key.startsWith(`${id}:`)) controller.abort();
      }
      return run;
    },
    async retryTask(input) {
      const run = await options.store.updateRun(input.id, (current) =>
        refreshRun({
          ...current,
          tasks: current.tasks.map((task) =>
            task.caseId === input.caseId &&
            (task.status === "needs_attention" || task.status === "unresolved")
              ? {
                  caseId: task.caseId,
                  caseName: task.caseName,
                  status: "queued" as const,
                  attempt: task.attempt + 1,
                  createdAt: new Date().toISOString(),
                }
              : task,
          ),
        }),
      );
      schedule();
      return run;
    },
    async start() {
      const runs = await options.store.listRuns();
      await Promise.all(
        runs.map(async (run) => {
          if (!run.tasks.some((task) => task.status.startsWith("running-"))) return;
          await options.store.updateRun(run.id, (current) =>
            refreshRun({
              ...current,
              tasks: current.tasks.map((task) => {
                if (!task.status.startsWith("running-")) return task;
                return current.executionMode === "mock"
                  ? { ...task, status: "queued" as const, startedAt: undefined }
                  : {
                      ...task,
                      status: "needs_attention" as const,
                      errorCode: "live_evaluation_interrupted",
                      error: "The app stopped during a live evaluation. Retry explicitly.",
                    };
              }),
            }),
          );
        }),
      );
      schedule();
    },
    dispose() {
      disposed = true;
      for (const controller of active.values()) controller.abort();
    },
  };
}

function refreshRun(run: AgentEvaluationRun): AgentEvaluationRun {
  const terminal = run.tasks.every((task) =>
    ["resolved", "unresolved", "needs_attention", "cancelled"].includes(task.status),
  );
  const hasAttention = run.tasks.some((task) => task.status === "needs_attention");
  const hasCancelled = run.tasks.some((task) => task.status === "cancelled");
  const status =
    terminal && hasCancelled
      ? "cancelled"
      : hasAttention
        ? "needs_attention"
        : terminal
          ? "completed"
          : run.tasks.some((task) => task.status.startsWith("running-"))
            ? "running"
            : "queued";
  const now = new Date().toISOString();
  return AgentEvaluationRunSchema.parse({
    ...run,
    status,
    summary: summarizeAgentEvaluationTasks(
      run.tasks.map((task) => ({
        state: task.status,
        ...(task.result === undefined ? {} : { result: task.result }),
      })),
    ),
    updatedAt: now,
    finishedAt: terminal ? (run.finishedAt ?? now) : undefined,
  });
}
