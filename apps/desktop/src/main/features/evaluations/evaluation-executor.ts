import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { EVALUATION_JUDGE_EXPERT_REF } from "@pragma/built-in-agents";
import type { PragmaAdapterHost, PragmaBindingRecord } from "@pragma/interpreter";
import {
  AgentEvaluationCaseResultSchema,
  AgentEvaluationJudgeResultSchema,
  evaluateAgentHardAssertions,
  type AgentEvaluationToolTrace,
} from "@pragma/evaluation";
import type { PragmaAgentEvaluationCase } from "@pragma/evaluation/ast";

import type {
  AgentEvaluationRun,
  Mission,
  MissionModelOverride,
} from "../../../shared/contracts/index.ts";
import { parseDesktopCapabilityBindingRef } from "../../platform/bindings/desktop-binding-ref.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { MissionRunner } from "../missions/mission-runner.ts";
import type { MissionStore } from "../missions/mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { EvaluationStore } from "./evaluation-store.ts";
import type { AgentEvaluationCaseExecutor } from "./evaluation-service.ts";

interface MockExecution {
  readonly testCase: PragmaAgentEvaluationCase;
  readonly calls: AgentEvaluationToolTrace[];
  readonly nextByTool: Map<string, number>;
}

export interface EvaluationMockAdapterRegistry {
  begin(runId: string, testCase: PragmaAgentEvaluationCase): void;
  finish(runId: string, caseId: string): readonly AgentEvaluationToolTrace[];
  forMission(mission: Mission, fallback: PragmaAdapterHost): PragmaAdapterHost;
}

export function createEvaluationMockAdapterRegistry(
  capabilities: CapabilityStore,
): EvaluationMockAdapterRegistry {
  const active = new Map<string, MockExecution>();
  return {
    begin(runId, testCase) {
      active.set(`${runId}:${testCase.id}`, { testCase, calls: [], nextByTool: new Map() });
    },
    finish(runId, caseId) {
      const key = `${runId}:${caseId}`;
      const execution = active.get(key);
      active.delete(key);
      return execution?.calls ?? [];
    },
    forMission(mission, fallback) {
      if (mission.origin.type !== "system-evaluation" || mission.origin.phase !== "subject") {
        return fallback;
      }
      const execution = active.get(`${mission.origin.runId}:${mission.origin.caseId}`);
      if (execution === undefined) return fallback;
      return {
        ...fallback,
        async resolveBinding(ref): Promise<PragmaBindingRecord | undefined> {
          const parsed = parseDesktopCapabilityBindingRef(ref);
          if (parsed === undefined) return await fallback.resolveBinding(ref);
          const capability = await capabilities.get(parsed.id, parsed.revision);
          if (capability.definition.kind === "skill") return await fallback.resolveBinding(ref);
          const names = capabilityToolNames(capability.definition);
          return {
            ref,
            revision: String(parsed.revision),
            fingerprint: createHash("sha256")
              .update(JSON.stringify({ ref, mocks: execution.testCase.mocks }))
              .digest("hex"),
            value: {
              contribution: {
                mcp: {
                  mcpServers: {
                    [capability.manifest.runtimeKey]: {
                      name: `${capability.manifest.name} evaluation fixture`,
                      transport: "in-process" as const,
                      allowTools: names,
                      toolApprovals: Object.fromEntries(
                        names.map((name) => [name, { mode: "none" }]),
                      ),
                      inProcess: {
                        async listTools() {
                          return names.map((name) => ({
                            name,
                            description: `Deterministic evaluation fixture for ${name}.`,
                            inputSchema: { type: "object", additionalProperties: true },
                          }));
                        },
                        async callTool(name: string, input: unknown) {
                          const fixture = execution.testCase.mocks.find(
                            (mock) => mock.name === name,
                          );
                          const index = execution.nextByTool.get(name) ?? 0;
                          execution.nextByTool.set(name, index + 1);
                          const outcome = fixture?.outcomes[index];
                          if (outcome === undefined) {
                            const error = `No mock outcome configured for ${name} call ${index + 1}.`;
                            execution.calls.push({ name, status: "failed", input, error });
                            throw new Error(error);
                          }
                          if (!partialMatch(input, outcome.expectInput)) {
                            const error = `Mock input mismatch for ${name} call ${index + 1}.`;
                            execution.calls.push({ name, status: "failed", input, error });
                            throw new Error(error);
                          }
                          if ("error" in outcome) {
                            execution.calls.push({
                              name,
                              status: "failed",
                              input,
                              error: outcome.error,
                            });
                            throw new Error(outcome.error);
                          }
                          execution.calls.push({
                            name,
                            status: "succeeded",
                            input,
                            outputPreview: preview(outcome.output),
                          });
                          return {
                            content: [{ type: "text", text: preview(outcome.output, 8_000) }],
                            structuredContent: outcome.output,
                          };
                        },
                      },
                    },
                  },
                },
              },
            },
          };
        },
      };
    },
  };
}

export function createMissionAgentEvaluationExecutor(options: {
  readonly missions: MissionStore;
  readonly runner: MissionRunner;
  readonly project: PragmaProjectStore;
  readonly store: EvaluationStore;
  readonly mocks: EvaluationMockAdapterRegistry;
  readonly workspaceRoot: string;
}): AgentEvaluationCaseExecutor {
  return {
    async execute({ run, evaluationCase, setPhase, signal }) {
      throwIfCancelled(signal);
      const project = await options.project.openRevision(run.projectRevision);
      const target = project.listResources().find((resource) => {
        if (resource.kind !== "Expert" && resource.kind !== "ExpertTeam") return false;
        const prefix = resource.kind === "Expert" ? "expert" : "team";
        return `${prefix}:${resource.metadata.id}` === run.targetRef;
      });
      if (target === undefined || (target.kind !== "Expert" && target.kind !== "ExpertTeam")) {
        await project.dispose();
        throw new Error(`Pinned evaluation target is unavailable: ${run.targetRef}.`);
      }
      await project.dispose();
      const workspace = join(options.workspaceRoot, run.id, evaluationCase.id);
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      if (run.executionMode === "mock") options.mocks.begin(run.id, evaluationCase);
      let subjectTrace: readonly AgentEvaluationToolTrace[] = [];
      let subject: Awaited<ReturnType<typeof runMission>>;
      try {
        subject = await runMission({
          missions: options.missions,
          runner: options.runner,
          workspace,
          run,
          caseId: evaluationCase.id,
          phase: "subject",
          goal: evaluationCase.prompt,
          title: `Evaluate ${target.metadata.name}: ${evaluationCase.name}`,
          executor: {
            kind: target.kind === "Expert" ? "expert" : "team",
            ref: run.targetRef,
            name: target.metadata.name,
          },
          toolPermissionMode: "auto-approve",
          signal,
        });
      } finally {
        if (run.executionMode === "mock") {
          subjectTrace = options.mocks.finish(run.id, evaluationCase.id);
        }
      }
      if (run.executionMode === "live") subjectTrace = traceFromMission(subject.entries);
      const assertions = evaluateAgentHardAssertions({
        case: evaluationCase,
        output: subject.output,
        toolTrace: subjectTrace,
      });
      throwIfCancelled(signal);
      await setPhase("judge");
      const settings = await options.store.getSettings();
      const judge = await runMission({
        missions: options.missions,
        runner: options.runner,
        workspace,
        run,
        caseId: evaluationCase.id,
        phase: "judge",
        goal: judgePrompt(evaluationCase, subject.output, subjectTrace, assertions),
        title: `Judge: ${evaluationCase.name}`,
        executor: {
          kind: "expert",
          ref: EVALUATION_JUDGE_EXPERT_REF,
          name: "Evaluation Judge Agent",
        },
        toolPermissionMode: "request-approval",
        signal,
        ...(settings.judge.mode === "pinned" ? { modelOverride: settings.judge.model } : {}),
      });
      const verdict = AgentEvaluationJudgeResultSchema.parse(parseJsonObject(judge.output));
      const expectedIds = evaluationCase.criteria.map((criterion) => criterion.id).sort();
      const actualIds = verdict.criteria.map((criterion) => criterion.id).sort();
      if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
        throw new Error("Judge response criterion IDs do not match the evaluation case.");
      }
      return AgentEvaluationCaseResultSchema.parse({
        caseId: evaluationCase.id,
        output: subject.output,
        toolTrace: subjectTrace,
        assertions,
        judge: verdict,
        resolved: assertions.every((assertion) => assertion.passed) && verdict.resolved,
      });
    },
  };
}

async function runMission(input: {
  readonly missions: MissionStore;
  readonly runner: MissionRunner;
  readonly workspace: string;
  readonly run: AgentEvaluationRun;
  readonly caseId: string;
  readonly phase: "subject" | "judge";
  readonly goal: string;
  readonly title: string;
  readonly executor: {
    readonly kind: "expert" | "team";
    readonly ref: string;
    readonly name: string;
  };
  readonly toolPermissionMode: "request-approval" | "auto-approve";
  readonly modelOverride?: MissionModelOverride | undefined;
  readonly signal: AbortSignal;
}): Promise<{
  readonly output: string;
  readonly entries: Awaited<ReturnType<MissionRunner["getChat"]>>["entries"];
}> {
  throwIfCancelled(input.signal);
  const mission = await input.missions.create({
    workspace: { path: input.workspace, basename: basename(input.workspace) },
    goal: input.goal,
    title: input.title,
    project: { id: input.run.projectId, revision: input.run.projectRevision },
    executor: input.executor,
    origin: {
      type: "system-evaluation",
      runId: input.run.id,
      caseId: input.caseId,
      phase: input.phase,
    },
    toolPermissionMode: input.toolPermissionMode,
    ...(input.modelOverride === undefined ? {} : { modelOverride: input.modelOverride }),
  });
  const interrupt = (): void => {
    void input.runner.interrupt(mission.id).catch(() => undefined);
  };
  input.signal.addEventListener("abort", interrupt, { once: true });
  try {
    if (input.signal.aborted) await input.runner.interrupt(mission.id).catch(() => undefined);
    throwIfCancelled(input.signal);
    await input.runner.run(mission.id);
    await waitForMission(input.missions, mission.id, input.signal);
    const finished = await input.missions.get(mission.id);
    if (finished.execution?.status !== "succeeded") {
      throw new Error(finished.execution?.error ?? `${input.phase} execution failed.`);
    }
    const chat = await input.runner.getChat({ id: mission.id, limit: 100 });
    const output = chat.entries
      .filter((entry) => entry.kind === "assistant")
      .map((entry) => entry.content)
      .at(-1);
    if (output === undefined) throw new Error(`${input.phase} execution produced no output.`);
    return { output, entries: chat.entries };
  } finally {
    input.signal.removeEventListener("abort", interrupt);
    await input.runner.delete(mission.id).catch(async () => {
      await input.runner.interrupt(mission.id).catch(() => undefined);
      await input.runner.delete(mission.id).catch(() => undefined);
    });
  }
}

async function waitForMission(
  missions: MissionStore,
  id: string,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    throwIfCancelled(signal);
    const mission = await missions.get(id);
    if (
      mission.execution !== undefined &&
      ["succeeded", "failed", "cancelled"].includes(mission.execution.status)
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Evaluation execution timed out.");
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Evaluation task was cancelled.");
}

function traceFromMission(
  entries: Awaited<ReturnType<MissionRunner["getChat"]>>["entries"],
): AgentEvaluationToolTrace[] {
  return entries.flatMap((entry) =>
    entry.kind !== "tool" || (entry.status !== "succeeded" && entry.status !== "failed")
      ? []
      : [
          {
            name: entry.toolName,
            status: entry.status,
            ...(entry.inputPreview === undefined ? {} : { inputPreview: entry.inputPreview }),
            ...(entry.outputPreview === undefined ? {} : { outputPreview: entry.outputPreview }),
            ...(entry.error === undefined ? {} : { error: entry.error }),
          },
        ],
  );
}

function judgePrompt(
  testCase: PragmaAgentEvaluationCase,
  output: string,
  trace: readonly AgentEvaluationToolTrace[],
  assertions: readonly {
    readonly kind: string;
    readonly passed: boolean;
    readonly message: string;
  }[],
): string {
  return JSON.stringify({
    instruction: "Judge each criterion independently. Return only the required JSON object.",
    caseId: testCase.id,
    prompt: testCase.prompt,
    referenceAnswer: testCase.referenceAnswer,
    criteria: testCase.criteria,
    subjectOutput: output,
    toolTrace: trace.map((entry) => ({
      name: entry.name,
      status: entry.status,
      ...(entry.inputPreview === undefined ? {} : { inputPreview: entry.inputPreview }),
      ...(entry.outputPreview === undefined ? {} : { outputPreview: entry.outputPreview }),
      ...(entry.error === undefined ? {} : { error: entry.error }),
    })),
    hardAssertions: assertions,
  });
}

function parseJsonObject(value: string): unknown {
  const trimmed = value.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1];
  return JSON.parse(fenced ?? trimmed) as unknown;
}

function capabilityToolNames(
  definition: Exclude<Awaited<ReturnType<CapabilityStore["get"]>>["definition"], { kind: "skill" }>,
): string[] {
  if (definition.kind === "code_service") return [definition.tool.name];
  return definition.tools.map((tool) => tool.name);
}

function partialMatch(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) => partialMatch(actual[index], item))
    );
  if (isRecord(expected))
    return (
      isRecord(actual) &&
      Object.entries(expected).every(([key, value]) => partialMatch(actual[key], value))
    );
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preview(value: unknown, max = 800): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return serialized.length <= max ? serialized : `${serialized.slice(0, max - 1)}…`;
}
