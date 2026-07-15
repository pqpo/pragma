import { randomUUID } from "node:crypto";

import {
  HumanInteractionResponseSchema,
  isFinalExecutionStatus as isFinal,
  type ExecutionRecord,
  type HumanInteractionRequest,
  type HumanInteractionResponse,
  type Invocation,
} from "@pragma/shared";

import { isExpertTeam, type ExpertDefinition, type ExpertTeam } from "../agent/expert-team.ts";
import { describeExpertExecutionDefinition } from "../agent/expert-definition-descriptor.ts";
import type { RuntimeRegistry } from "../runtime-registry.ts";
import type {
  ExpertAgentHumanRequest,
  ExpertAgentHumanResponse,
  ExpertAgentUserQuestion,
} from "../tools/managed-tool.ts";
import { ExecutionController, runExpertInvocation } from "../execution/expert-runner.ts";
import {
  ContextResolutionService,
  closeExecutionContexts,
  prepareExecutionContextClosure,
  type RuntimeContextResolution,
} from "../execution/context-resolution-service.ts";
import {
  describeContextIdResolver,
  freshContextIdResolver,
} from "../execution/context-id-resolver.ts";
import type { ExecutionStore } from "../execution/execution-store.ts";
import { InvocationService } from "../execution/invocation-service.ts";
import {
  StoredExecutionView,
  type ExecutionView,
  type MutableExecution,
} from "../execution/execution-view.ts";
import type {
  CompiledFlowStep,
  Flow,
  FlowSpec,
  FlowState,
  FlowTaskContext,
  FlowDestination,
  FlowRepeatTarget,
  FlowTerminal,
  FlowTransition,
  HumanTaskDefinition,
} from "./flow.ts";

export interface StartFlowRequest<TInput = unknown> {
  readonly input: TInput;
  readonly executionId?: string | undefined;
  readonly runtime?: string | undefined;
}

export interface FlowExecution extends MutableExecution {
  readonly result: Promise<unknown>;
}

export type FlowExecutionView = ExecutionView;

export class FlowExecutionManager {
  private readonly active = new Map<
    string,
    { readonly controller: ExecutionController; readonly handle: FlowExecution }
  >();

  constructor(
    private readonly executions: ExecutionStore,
    private readonly runtimes: RuntimeRegistry,
  ) {}

  async start<TInput>(
    definition: FlowSpec<TInput, unknown> | Flow,
    request: StartFlowRequest<TInput>,
  ): Promise<FlowExecution> {
    const flow = compileFlow(definition);
    const input = flow.input?.parse(request.input) ?? request.input;
    const executionId = request.executionId ?? randomUUID();
    const runtimeId = this.runtimes.resolve(request.runtime).descriptor.id;
    validateFlowRuntimeConfiguration(flow, this.runtimes, runtimeId);
    const now = new Date().toISOString();
    const record: ExecutionRecord = {
      schemaVersion: "pragma.execution/v5",
      executionId,
      version: 0,
      kind: "flow",
      definition: { id: flow.id, version: flow.version, kind: "flow" },
      rootInvocationId: executionId,
      status: "queued",
      input,
      state: {
        __flowDefinitionGraph: createFlowDefinitionGraph(flow),
        __requestedRuntimeId: runtimeId,
      },
      lastAppliedSequence: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.executions.create(record, {
      invocationId: executionId,
      rootInvocationId: executionId,
      contextId: executionId,
      definition: record.definition,
      status: "queued",
      input,
      createdAt: now,
      updatedAt: now,
    });
    const claimId = randomUUID();
    await this.executions.claimRecovery(executionId, claimId, 30_000);
    return this.activate(flow, executionId, runtimeId, claimId);
  }

  async open(request: { readonly executionId: string }): Promise<FlowExecutionView> {
    const record = await this.executions.get(request.executionId);
    if (record === undefined || record.kind !== "flow") {
      throw new Error(`FlowExecution not found: ${request.executionId}`);
    }
    return new StoredExecutionView(request.executionId, this.executions);
  }

  async recover(
    definition: FlowSpec | Flow,
    request: { readonly executionId: string; readonly runtime?: string | undefined },
  ): Promise<FlowExecution> {
    const flow = compileFlow(definition);
    const record = await this.executions.get(request.executionId);
    if (record === undefined || record.kind !== "flow") {
      throw new Error(`FlowExecution not found: ${request.executionId}`);
    }
    if (record.definition.id !== flow.id || record.definition.version !== flow.version) {
      throw new Error(`Flow definition mismatch for Execution ${request.executionId}.`);
    }
    const storedGraph = record.state["__flowDefinitionGraph"];
    const currentGraph = createFlowDefinitionGraph(flow);
    if (
      storedGraph === undefined ||
      stableStringify(storedGraph) !== stableStringify(currentGraph)
    ) {
      throw new Error(`Flow definition graph mismatch for Execution ${request.executionId}.`);
    }
    const runtimeId = this.runtimes.resolve(request.runtime).descriptor.id;
    validateFlowRuntimeConfiguration(flow, this.runtimes, runtimeId);
    if (record.state["__requestedRuntimeId"] !== runtimeId) {
      throw new Error(`Flow Runtime mismatch for Execution ${request.executionId}.`);
    }
    if (isFinal(record.status)) {
      throw new Error(`Cannot recover terminal FlowExecution: ${record.status}`);
    }
    const active = this.active.get(request.executionId);
    if (active !== undefined) return active.handle;
    const claimId = randomUUID();
    if (!(await this.executions.claimRecovery(request.executionId, claimId, 30_000))) {
      throw new Error(`FlowExecution recovery is already claimed: ${request.executionId}`);
    }
    for (const invocation of await this.executions.listInvocations(request.executionId)) {
      if (!isFinal(invocation.status) && invocation.status !== "waiting") {
        await this.executions.putInvocation(request.executionId, {
          ...invocation,
          status: "interrupted",
          updatedAt: new Date().toISOString(),
        });
      }
    }
    await this.executions.update(request.executionId, { status: "interrupted" });
    const interrupted = await this.executions.listInvocations(request.executionId);
    await this.executions.commit({
      commitId: `flow-recovery-prepared:${claimId}`,
      executionId: request.executionId,
      recoveryClaimId: claimId,
      executionPatch: { status: "queued" },
      invocationPatches: interrupted
        .filter((invocation) => invocation.status === "interrupted")
        .map((invocation) => ({
          invocationId: invocation.invocationId,
          patch: { status: "queued" as const },
        })),
      events: [
        {
          invocationId: record.rootInvocationId,
          type: "execution.recovery.prepared",
          data: { claimId },
        },
      ],
    });
    return this.activate(flow, request.executionId, runtimeId, claimId);
  }

  private activate(
    flow: Flow,
    executionId: string,
    runtime: string | undefined,
    claimId: string,
  ): FlowExecution {
    const controller = new ExecutionController(executionId, this.executions, undefined, {
      closeContextsOnCancel: true,
    });
    const handle = this.createHandle(executionId, controller);
    this.active.set(executionId, { controller, handle });
    const renewal = setInterval(() => {
      void this.executions.claimRecovery(executionId, claimId, 30_000);
    }, 10_000);
    renewal.unref();
    void this.execute(flow, executionId, controller, runtime).finally(() => {
      clearInterval(renewal);
      this.active.delete(executionId);
    });
    return handle;
  }

  private async execute(
    flow: Flow,
    executionId: string,
    controller: ExecutionController,
    runtime?: string,
  ): Promise<void> {
    const root = (await this.executions.getInvocation(executionId, executionId))!;
    await this.executions.commit({
      commitId: randomUUID(),
      executionId,
      executionPatch: { status: "running" },
      invocationPatches: [{ invocationId: root.invocationId, patch: { status: "running" } }],
      events: [{ invocationId: executionId, type: "execution.started", data: {} }],
    });
    try {
      const output = await runFlow({
        flow,
        executionId,
        flowInvocationId: executionId,
        input: (await this.executions.get(executionId))!.input,
        owner: { type: "flow-execution", ownerId: executionId },
        controller,
        store: this.executions,
        runtimes: this.runtimes,
        runtime,
      });
      const usage = controller.getUsage();
      const closure = await prepareExecutionContextClosure(this.executions, executionId);
      await this.executions.commit({
        commitId: `flow-succeeded:${executionId}`,
        executionId,
        executionPatch: {
          status: "succeeded",
          output,
          ...(usage === undefined ? {} : { usage }),
        },
        invocationPatches: [
          { invocationId: root.invocationId, patch: { status: "succeeded", output } },
        ],
        contextPatches: closure.contextPatches,
        agentPatches: closure.agentPatches,
        events: [
          ...closure.events,
          {
            invocationId: root.invocationId,
            type: "invocation.succeeded",
            data: { output },
          },
          { invocationId: executionId, type: "execution.succeeded", data: { output } },
        ],
      });
    } catch (error) {
      const status = controller.isCancelled() ? "cancelled" : "failed";
      const terminalError =
        status === "cancelled" ? (controller.getCancellationReason() ?? error) : error;
      const storedError = serializeError(terminalError);
      const usage = controller.getUsage();
      const current = await this.executions.get(executionId);
      if (current !== undefined && isFinal(current.status)) {
        if (usage !== undefined) await this.executions.update(executionId, { usage });
      } else {
        const closure = await prepareExecutionContextClosure(this.executions, executionId);
        await this.executions.commit({
          commitId: `flow-${status}:${executionId}`,
          executionId,
          executionPatch: {
            status,
            error: storedError,
            ...(usage === undefined ? {} : { usage }),
          },
          invocationPatches: [
            { invocationId: root.invocationId, patch: { status, error: storedError } },
          ],
          contextPatches: closure.contextPatches,
          agentPatches: closure.agentPatches,
          events: [
            ...closure.events,
            {
              invocationId: root.invocationId,
              type: `invocation.${status}`,
              data: { error: storedError },
            },
            {
              invocationId: executionId,
              type: `execution.${status}`,
              data: {
                message:
                  terminalError instanceof Error ? terminalError.message : String(terminalError),
              },
            },
          ],
        });
      }
    } finally {
      try {
        await controller.closeRuntimes();
      } finally {
        try {
          await closeExecutionContexts(this.executions, executionId);
        } finally {
          controller.finish();
        }
      }
    }
  }

  private createHandle(executionId: string, controller: ExecutionController): FlowExecution {
    const view = new StoredExecutionView(executionId, this.executions);
    return Object.assign(view, {
      result: waitForResult(this.executions, executionId),
      cancel: async (reason?: string) => await controller.cancel(reason),
      respondToHumanInteraction: async (
        interactionId: string,
        response: unknown,
        options: { readonly requestId: string },
      ) => await controller.respond(interactionId, response, options.requestId),
    });
  }
}

async function runFlow(options: {
  readonly flow: Flow;
  readonly executionId: string;
  readonly flowInvocationId: string;
  readonly input: unknown;
  readonly owner:
    | { readonly type: "expert-session"; readonly ownerId: string }
    | { readonly type: "flow-execution"; readonly ownerId: string };
  readonly controller: ExecutionController;
  readonly store: ExecutionStore;
  readonly runtimes: RuntimeRegistry;
  readonly runtime?: string | undefined;
}): Promise<unknown> {
  let stepId: string | undefined = options.flow.startStepId;
  const visits = new Map<string, number>();
  while (stepId !== undefined) {
    if (options.controller.isCancelled()) throw new Error("FlowExecution was cancelled.");
    await ensureLoopEntry(options, stepId);
    const step = options.flow.steps.get(stepId);
    if (step === undefined) throw new Error(`Flow step not found: ${stepId}`);
    const visit = visits.get(stepId) ?? 0;
    visits.set(stepId, visit + 1);
    const stepInvocations = await findStepInvocations(options, step);
    const existingInvocation = stepInvocations[visit];
    let input: unknown;
    let invocation: Invocation;
    if (existingInvocation !== undefined) {
      input = existingInvocation.input;
      invocation = existingInvocation;
    } else {
      await recordNodeVisit(options);
      try {
        input = resolveStepInput(
          step,
          (await options.store.get(options.executionId))!.state,
          options.input,
        );
      } catch (error) {
        const failed = await createStepInvocation(options, step, options.input, visit);
        await putStatus(
          options.store,
          options.executionId,
          failed,
          "failed",
          undefined,
          serializeError(error),
        );
        throw error;
      }
      invocation = await createStepInvocation(options, step, input, visit);
    }
    let output: unknown;
    if (invocation.status === "succeeded") {
      output = invocation.output;
    } else {
      output = await runStep(options, step, invocation, input);
    }
    await applyReductionOnce(options, step, invocation.invocationId, output);
    const transition = options.flow.transitions.get(stepId);
    if (transition === undefined) throw new Error(`Flow step has no transition: ${stepId}`);
    const target = await applyTransitionOnce(options, invocation, output, transition);
    if ("type" in target) {
      if (target.type === "fail")
        throw new Error(target.reason ?? `Flow ${options.flow.id} failed.`);
      stepId = undefined;
    } else {
      stepId = target.id;
    }
  }
  const record = (await options.store.get(options.executionId))!;
  const output = options.flow.result?.({ state: record.state }) ?? record.state;
  return options.flow.output?.parse(output) ?? output;
}

export async function runNestedFlowInvocation(options: {
  readonly flow: Flow;
  readonly executionId: string;
  readonly flowInvocationId: string;
  readonly input: unknown;
  readonly owner:
    | { readonly type: "expert-session"; readonly ownerId: string }
    | { readonly type: "flow-execution"; readonly ownerId: string };
  readonly controller: ExecutionController;
  readonly store: ExecutionStore;
  readonly runtimes: RuntimeRegistry;
  readonly runtime?: string | undefined;
}): Promise<unknown> {
  validateFlowRuntimeConfiguration(
    options.flow,
    options.runtimes,
    options.runtimes.resolve(options.runtime).descriptor.id,
  );
  return await runFlow(options);
}

async function runStep(
  options: Parameters<typeof runFlow>[0],
  step: CompiledFlowStep,
  invocation: Invocation,
  input: unknown,
): Promise<unknown> {
  try {
    const record = (await options.store.get(options.executionId))!;
    if ("kind" in step.definition && step.definition.kind === "task") {
      await putStatus(options.store, options.executionId, invocation, "running");
      const parsedInput = step.definition.inputSchema?.parse(input) ?? input;
      const output = await step.definition.handler({
        input: parsedInput,
        state: record.state,
        executionId: options.executionId,
        invocationId: invocation.invocationId,
        emitOutput: async (value) => {
          await options.store.appendEvent(
            options.executionId,
            invocation.invocationId,
            "invocation.progress",
            { value },
          );
        },
      } as FlowTaskContext);
      if (options.controller.isCancelled()) throw new Error("FlowExecution was cancelled.");
      const parsed = step.definition.outputSchema?.parse(output) ?? output;
      await putStatus(options.store, options.executionId, invocation, "succeeded", parsed);
      return parsed;
    }
    if ("kind" in step.definition && step.definition.kind === "human-task") {
      return await runHumanTask(options, step.definition, invocation, input, record.state);
    }
    if ("kind" in step.definition && step.definition.kind === "flow") {
      await putStatus(options.store, options.executionId, invocation, "running");
      const output = await runFlow({
        ...options,
        flow: step.definition,
        flowInvocationId: invocation.invocationId,
        input,
      });
      await putStatus(options.store, options.executionId, invocation, "succeeded", output);
      return output;
    }
    const expert = step.definition as ExpertDefinition;
    const context = await options.store.getContext(options.executionId, invocation.contextId);
    if (context === undefined) {
      throw new Error(`Runtime Context not found: ${invocation.contextId}.`);
    }
    return await runExpertInvocation({
      executionId: options.executionId,
      invocationId: invocation.invocationId,
      parentInvocationId: options.flowInvocationId,
      expert,
      prompt: typeof input === "string" ? input : JSON.stringify(input),
      owner: options.owner,
      ...(readFlowStepRuntimeByExpert(step) === undefined
        ? {}
        : { runtimeByExpert: readFlowStepRuntimeByExpert(step) }),
      context,
      controller: options.controller,
      store: options.store,
      runtimes: options.runtimes,
    });
  } catch (error) {
    const latest = await options.store.getInvocation(options.executionId, invocation.invocationId);
    if (latest !== undefined && !isFinal(latest.status)) {
      await putStatus(
        options.store,
        options.executionId,
        latest,
        options.controller.isCancelled() ? "cancelled" : "failed",
        undefined,
        serializeError(error),
      );
    }
    throw error;
  }
}

async function runHumanTask(
  options: Parameters<typeof runFlow>[0],
  definition: HumanTaskDefinition,
  invocation: Invocation,
  input: unknown,
  state: FlowState,
): Promise<unknown> {
  await putStatus(options.store, options.executionId, invocation, "waiting");
  const context: FlowTaskContext = {
    input,
    state,
    executionId: options.executionId,
    invocationId: invocation.invocationId,
    emitOutput: async (value) => {
      await options.store.appendEvent(
        options.executionId,
        invocation.invocationId,
        "invocation.progress",
        { value },
      );
    },
  };
  const request: HumanInteractionRequest =
    typeof definition.request === "function"
      ? await definition.request(context)
      : definition.request;
  const response = await options.controller.requestHumanInteraction(
    invocation.invocationId,
    toExpertHumanRequest(request),
    `human:${invocation.invocationId}`,
  );
  const output = fromExpertHumanResponse(request, response);
  await putStatus(options.store, options.executionId, invocation, "succeeded", output);
  return output;
}

function toExpertHumanRequest(request: HumanInteractionRequest): ExpertAgentHumanRequest {
  return {
    kind: "user_question",
    toolName: "askUserQuestion",
    questions: humanInteractionQuestions(request),
  };
}

function humanInteractionQuestions(
  request: HumanInteractionRequest,
): readonly ExpertAgentUserQuestion[] {
  if (request.questions !== undefined && request.questions.length > 0) {
    return request.questions;
  }
  const question = request.prompt ?? request.title ?? "Response required";
  const header = request.title ?? humanInteractionHeader(request.kind);
  if (request.options !== undefined && request.options.length > 0) {
    return [{ question, header, kind: "single_choice", options: request.options }];
  }
  if (request.kind === "approval") {
    return [
      {
        question,
        header,
        kind: "single_choice",
        options: [
          { label: "approve", description: "Approve and continue." },
          { label: "reject", description: "Reject and stop this path." },
        ],
      },
    ];
  }
  return [{ question, header, kind: "text", options: [] }];
}

function humanInteractionHeader(kind: HumanInteractionRequest["kind"]): string {
  switch (kind) {
    case "approval":
      return "Approval";
    case "review_gate":
      return "Review gate";
    case "manual_intervention":
      return "Manual intervention";
    case "question":
      return "Question";
  }
}

function fromExpertHumanResponse(
  request: HumanInteractionRequest,
  response: ExpertAgentHumanResponse,
): HumanInteractionResponse {
  if (response.kind !== "user_question") {
    throw new Error(`HumanTask received an unsupported response: ${response.kind}`);
  }
  if (!response.answered) {
    throw new Error(response.reason ?? "HumanTask was not answered.");
  }
  const questions = humanInteractionQuestions(request);
  const answers = readHumanAnswers(response.answers, questions);
  const decisionQuestion = questions.find((question) => question.kind === "single_choice");
  const notesQuestion = questions.find((question) => question.kind === "text");
  const decision =
    decisionQuestion === undefined
      ? undefined
      : readHumanAnswer(answers, decisionQuestion.question);
  const notes =
    notesQuestion === undefined ? undefined : readHumanAnswer(answers, notesQuestion.question);
  const approved =
    request.kind === "approval" ? isApprovedHumanDecision(questions, decision) : undefined;
  return HumanInteractionResponseSchema.parse({
    answers,
    ...(decision === undefined ? {} : { decision }),
    ...(notes === undefined ? {} : { notes }),
    ...(approved === undefined ? {} : { approved }),
  });
}

function readHumanAnswers(
  value: unknown,
  questions: readonly ExpertAgentUserQuestion[],
): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  if (questions.length === 1 && value !== undefined) {
    return { [questions[0]!.question]: value };
  }
  return {};
}

function readHumanAnswer(
  answers: Readonly<Record<string, unknown>>,
  question: string,
): string | undefined {
  const answer = answers[question];
  return typeof answer === "string" && answer.trim() !== "" ? answer.trim() : undefined;
}

function isApprovedHumanDecision(
  questions: readonly ExpertAgentUserQuestion[],
  decision: string | undefined,
): boolean {
  const positiveLabel = questions.find((question) => question.kind === "single_choice")?.options[0]
    ?.label;
  return (
    positiveLabel !== undefined &&
    decision?.toLocaleLowerCase() === positiveLabel.toLocaleLowerCase()
  );
}

async function findStepInvocations(
  options: Parameters<typeof runFlow>[0],
  step: CompiledFlowStep,
): Promise<readonly Invocation[]> {
  return (await options.store.listInvocations(options.executionId)).filter(
    (candidate) =>
      candidate.parentInvocationId === options.flowInvocationId && candidate.nodeId === step.id,
  );
}

async function createStepInvocation(
  options: Parameters<typeof runFlow>[0],
  step: CompiledFlowStep,
  input: unknown,
  visit: number,
): Promise<Invocation> {
  const definition = definitionRef(step.definition);
  const now = new Date().toISOString();
  const invocationId = randomUUID();
  let contextResolution: RuntimeContextResolution | undefined;
  if (definition.kind === "expert" || definition.kind === "expert-team") {
    const expert = step.definition as ExpertDefinition;
    const nativeExpert = isExpertTeam(expert) ? expert.coordinator : expert;
    const record = (await options.store.get(options.executionId))!;
    contextResolution = await new ContextResolutionService(options.store).resolve({
      executionId: options.executionId,
      invocationId,
      parentInvocationId: options.flowInvocationId,
      input,
      state: record.state,
      source: {
        kind: "flow",
        flowId: options.flow.id,
        stepId: step.id,
        visit: visit + 1,
      },
      owner: options.owner,
      expert: { id: nativeExpert.id, version: nativeExpert.version },
      runtimeId: options.runtimes.resolve(
        resolveFlowStepRuntimeId(step, nativeExpert.id, options.runtime),
      ).descriptor.id,
      resolver:
        ("contextId" in step.options ? step.options.contextId : undefined) ??
        freshContextIdResolver,
    });
  }
  const invocation: Invocation = {
    invocationId,
    rootInvocationId: (await options.store.get(options.executionId))!.rootInvocationId,
    parentInvocationId: options.flowInvocationId,
    nodeId: step.id,
    definition,
    contextId: contextResolution?.context.contextId ?? invocationId,
    ...(contextResolution === undefined
      ? {}
      : {
          contextResolution: {
            resolver: contextResolution.resolver,
            disposition: contextResolution.disposition,
          },
        }),
    ...(definition.kind === "expert" || definition.kind === "expert-team"
      ? {
          executorId: isExpertTeam(step.definition as ExpertDefinition)
            ? (step.definition as ExpertTeam).coordinator.id
            : definition.id,
        }
      : {}),
    status: "queued",
    input,
    createdAt: now,
    updatedAt: now,
  };
  await options.store.commit({
    commitId: randomUUID(),
    executionId: options.executionId,
    invocationPuts: [invocation],
    ...(contextResolution?.contextPut === undefined
      ? {}
      : { contextPuts: [contextResolution.contextPut] }),
    events: [
      ...(contextResolution?.events ?? []),
      {
        invocationId: invocation.invocationId,
        type: "invocation.queued",
        data: {},
      },
    ],
  });
  return invocation;
}

function resolveStepInput(step: CompiledFlowStep, state: FlowState, flowInput: unknown): unknown {
  return typeof step.options.input === "function"
    ? step.options.input({ state, flowInput })
    : (step.options.input ?? flowInput);
}

async function applyReductionOnce(
  options: Parameters<typeof runFlow>[0],
  step: CompiledFlowStep,
  invocationId: string,
  output: unknown,
): Promise<void> {
  const record = (await options.store.get(options.executionId))!;
  const key = `__reduced:${invocationId}`;
  if (record.state[key] === true) return;
  const state = { ...record.state };
  step.options.reduce?.({ state, output });
  state[key] = true;
  state[`result:${step.id}`] = output;
  await options.store.update(options.executionId, { state });
}

function definitionRef(definition: CompiledFlowStep["definition"]): Invocation["definition"] {
  if ("kind" in definition && definition.kind === "task")
    return { id: definition.id, version: definition.version, kind: "task" };
  if ("kind" in definition && definition.kind === "human-task")
    return { id: definition.id, version: definition.version, kind: "human-task" };
  if ("kind" in definition && definition.kind === "flow")
    return { id: definition.id, version: definition.version, kind: "flow" };
  const expert = definition as ExpertDefinition;
  return {
    id: expert.id,
    version: expert.version,
    kind: isExpertTeam(expert) ? "expert-team" : "expert",
  };
}

function compileFlow(definition: FlowSpec | Flow): Flow {
  return definition instanceof Object && "compile" in definition
    ? (definition as FlowSpec).compile()
    : (definition as Flow);
}

async function putStatus(
  store: ExecutionStore,
  executionId: string,
  invocation: Invocation,
  status: Invocation["status"],
  output?: unknown,
  error?: unknown,
): Promise<void> {
  const data = {
    ...(output === undefined ? {} : { output }),
    ...(error === undefined ? {} : { error }),
  };
  await new InvocationService(executionId, store).transition({
    invocationId: invocation.invocationId,
    status,
    patch: data,
    data,
  });
}

function readField(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[field];
}

const FLOW_CONTROL_STATE_KEY = "__pragma.flowControl";

interface StoredFlowTarget {
  readonly type: "step" | "end" | "fail";
  readonly id?: string | undefined;
  readonly reason?: string | undefined;
}

interface StoredFlowControl {
  readonly loops: Record<string, { iteration: number; status: "active" | "exited" | "exhausted" }>;
  readonly transitions: Record<string, { target: StoredFlowTarget }>;
  readonly nodeVisits: Record<string, number>;
}

async function recordNodeVisit(options: Parameters<typeof runFlow>[0]): Promise<void> {
  const record = (await options.store.get(options.executionId))!;
  const control = readFlowControl(record.state[FLOW_CONTROL_STATE_KEY]);
  const next = (control.nodeVisits[options.flowInvocationId] ?? 0) + 1;
  if (next > options.flow.maxNodeVisits) {
    throw new Error(
      `Flow ${options.flow.id} exceeded maxNodeVisits (${options.flow.maxNodeVisits}).`,
    );
  }
  control.nodeVisits[options.flowInvocationId] = next;
  await options.store.commit({
    commitId: `flow-node-visit:${options.flowInvocationId}:${next}`,
    executionId: options.executionId,
    executionPatch: { state: { ...record.state, [FLOW_CONTROL_STATE_KEY]: control } },
  });
}

async function ensureLoopEntry(
  options: Parameters<typeof runFlow>[0],
  stepId: string,
): Promise<void> {
  const entering = [...options.flow.loops.values()].filter((loop) => loop.entryStepId === stepId);
  if (entering.length === 0) return;
  const record = (await options.store.get(options.executionId))!;
  const control = readFlowControl(record.state[FLOW_CONTROL_STATE_KEY]);
  const events: { invocationId: string; type: string; data: unknown }[] = [];
  let changed = false;
  for (const loop of entering) {
    const loopStateKey = flowLoopStateKey(options.flowInvocationId, loop.id);
    if (control.loops[loopStateKey] !== undefined) continue;
    control.loops[loopStateKey] = { iteration: 1, status: "active" };
    events.push({
      invocationId: options.flowInvocationId,
      type: "flow.loop.entered",
      data: { loopId: loop.id, iteration: 1, entryStepId: loop.entryStepId },
    });
    changed = true;
  }
  if (!changed) return;
  await options.store.commit({
    commitId: randomUUID(),
    executionId: options.executionId,
    executionPatch: { state: { ...record.state, [FLOW_CONTROL_STATE_KEY]: control } },
    events,
  });
}

async function applyTransitionOnce(
  options: Parameters<typeof runFlow>[0],
  invocation: Invocation,
  output: unknown,
  transition: FlowTransition,
): Promise<{ readonly id: string } | FlowTerminal> {
  const record = (await options.store.get(options.executionId))!;
  const control = readFlowControl(record.state[FLOW_CONTROL_STATE_KEY]);
  const existing = control.transitions[invocation.invocationId];
  if (existing !== undefined) return restoreFlowTarget(existing.target);

  let destination: FlowDestination | undefined;
  let target: { readonly id: string } | FlowTerminal | undefined;
  const events: { invocationId: string; type: string; data: unknown }[] = [];
  if (transition.type === "next") {
    destination = transition.target;
  } else if (transition.type === "route") {
    destination =
      transition.cases.get(String(readField(output, transition.field))) ?? transition.fallback;
  } else {
    destination = transition;
  }
  if (destination !== undefined && isFlowRepeatTarget(destination)) {
    const loop = options.flow.loops.get(destination.loopId);
    if (loop === undefined)
      throw new Error(`Flow repeat references unknown loop: ${destination.loopId}`);
    if (!loop.stepIds.has(invocation.nodeId ?? "")) {
      throw new Error(`Flow repeat source is outside loop ${loop.id}: ${invocation.nodeId ?? ""}`);
    }
    if (destination.target.id !== loop.entryStepId) {
      throw new Error(`Flow repeat must target loop entry ${loop.entryStepId}: ${loop.id}`);
    }
    const loopStateKey = flowLoopStateKey(options.flowInvocationId, loop.id);
    const current = control.loops[loopStateKey] ?? {
      iteration: 1,
      status: "active" as const,
    };
    if (current.iteration >= loop.maxIterations) {
      control.loops[loopStateKey] = { ...current, status: "exhausted" };
      target = loop.onLimit ?? {
        type: "fail",
        reason: `Flow loop ${loop.id} exceeded maxIterations (${loop.maxIterations}).`,
      };
      events.push({
        invocationId: invocation.invocationId,
        type: "flow.loop.exhausted",
        data: { loopId: loop.id, iteration: current.iteration },
      });
    } else {
      const iteration = current.iteration + 1;
      control.loops[loopStateKey] = { iteration, status: "active" };
      target = destination.target;
      events.push({
        invocationId: invocation.invocationId,
        type: "flow.loop.repeated",
        data: {
          loopId: loop.id,
          iteration,
          fromStepId: invocation.nodeId,
          toStepId: destination.target.id,
        },
      });
    }
  } else {
    target = destination;
  }
  if (target === undefined) {
    throw new Error(
      `Flow route has no matching target: ${invocation.nodeId ?? invocation.invocationId}`,
    );
  }

  for (const loop of options.flow.loops.values()) {
    const loopStateKey = flowLoopStateKey(options.flowInvocationId, loop.id);
    const current = control.loops[loopStateKey];
    if (current?.status !== "active" || !loop.stepIds.has(invocation.nodeId ?? "")) continue;
    const targetId = "id" in target ? target.id : undefined;
    if (targetId !== undefined && loop.stepIds.has(targetId)) continue;
    control.loops[loopStateKey] = { ...current, status: "exited" };
    events.push({
      invocationId: invocation.invocationId,
      type: "flow.loop.exited",
      data: { loopId: loop.id, iteration: current.iteration, targetStepId: targetId },
    });
  }

  control.transitions[invocation.invocationId] = { target: storeFlowTarget(target) };
  await options.store.commit({
    commitId: `flow-transition:${invocation.invocationId}`,
    executionId: options.executionId,
    executionPatch: { state: { ...record.state, [FLOW_CONTROL_STATE_KEY]: control } },
    events,
  });
  return target;
}

function isFlowRepeatTarget(destination: FlowDestination): destination is FlowRepeatTarget {
  return "type" in destination && destination.type === "repeat";
}

function flowLoopStateKey(flowInvocationId: string, loopId: string): string {
  return `${flowInvocationId}:${loopId}`;
}

function readFlowControl(value: unknown): StoredFlowControl {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { loops: {}, transitions: {}, nodeVisits: {} };
  }
  const record = value as Partial<StoredFlowControl>;
  return {
    loops: { ...(record.loops ?? {}) },
    transitions: { ...(record.transitions ?? {}) },
    nodeVisits: { ...(record.nodeVisits ?? {}) },
  };
}

function storeFlowTarget(target: { readonly id: string } | FlowTerminal): StoredFlowTarget {
  if ("id" in target) return { type: "step", id: target.id };
  return target.type === "end"
    ? { type: "end" }
    : { type: "fail", ...(target.reason === undefined ? {} : { reason: target.reason }) };
}

function restoreFlowTarget(target: StoredFlowTarget): { readonly id: string } | FlowTerminal {
  if (target.type === "step") {
    if (target.id === undefined) throw new Error("Stored Flow step target is missing its id.");
    return { id: target.id };
  }
  return target.type === "end"
    ? { type: "end" }
    : { type: "fail", ...(target.reason === undefined ? {} : { reason: target.reason }) };
}

function createFlowDefinitionGraph(flow: Flow): unknown {
  return visitFlowDefinition(flow, new Set<Flow>());
}

function visitFlowDefinition(flow: Flow, ancestors: Set<Flow>): unknown {
  if (ancestors.has(flow)) throw new Error(`Cyclic sub Flow definition: ${flow.id}`);
  const nextAncestors = new Set(ancestors).add(flow);
  return {
    definition: { id: flow.id, version: flow.version, kind: "flow" },
    maxNodeVisits: flow.maxNodeVisits,
    loops: [...flow.loops.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((loop) => ({
        id: loop.id,
        entryStepId: loop.entryStepId,
        stepIds: [...loop.stepIds].sort(),
        maxIterations: loop.maxIterations,
        ...(loop.onLimit === undefined ? {} : { onLimit: loop.onLimit }),
      })),
    steps: [...flow.steps.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((step) => ({
        nodeId: step.id,
        definition: describeDefinition(step.definition),
        options: describeStepOptions(step),
      })),
    transitions: [...flow.transitions.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([stepId, transition]) => ({ stepId, transition: describeTransition(transition) })),
  };

  function describeDefinition(definition: CompiledFlowStep["definition"]): unknown {
    if ("kind" in definition && definition.kind === "flow") {
      return visitFlowDefinition(definition, nextAncestors);
    }
    if (!("kind" in definition) || definition.kind === "expert-team") {
      return describeExpertExecutionDefinition(definition as ExpertDefinition);
    }
    return definitionRef(definition);
  }

  function describeStepOptions(step: CompiledFlowStep): unknown {
    const kind = definitionRef(step.definition).kind;
    const resolver =
      kind === "expert" || kind === "expert-team"
        ? (("contextId" in step.options ? step.options.contextId : undefined) ??
          freshContextIdResolver)
        : undefined;
    const runtimeByExpert = readFlowStepRuntimeByExpert(step);
    return {
      ...(!("runtime" in step.options) || step.options.runtime === undefined
        ? {}
        : { runtime: step.options.runtime }),
      ...(runtimeByExpert === undefined
        ? {}
        : {
            runtimeByExpert: Object.fromEntries(
              Object.entries(runtimeByExpert).sort(([left], [right]) => left.localeCompare(right)),
            ),
          }),
      ...(resolver === undefined ? {} : { contextId: describeContextIdResolver(resolver) }),
    };
  }

  function describeTransition(
    transition: Flow["transitions"] extends ReadonlyMap<string, infer T> ? T : never,
  ): unknown {
    if (transition.type === "next") return { type: "next", target: transition.target };
    if (transition.type === "repeat") {
      return { type: "repeat", loopId: transition.loopId, target: transition.target };
    }
    return {
      type: "route",
      field: transition.field,
      cases: [...transition.cases.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ...(transition.fallback === undefined ? {} : { fallback: transition.fallback }),
    };
  }
}

function readFlowStepRuntimeByExpert(
  step: CompiledFlowStep,
): Readonly<Record<string, string>> | undefined {
  return "runtimeByExpert" in step.options ? step.options.runtimeByExpert : undefined;
}

function resolveFlowStepRuntimeId(
  step: CompiledFlowStep,
  expertId: string,
  fallbackRuntimeId: string | undefined,
): string | undefined {
  const explicitRuntime = "runtime" in step.options ? step.options.runtime : undefined;
  return explicitRuntime ?? readFlowStepRuntimeByExpert(step)?.[expertId] ?? fallbackRuntimeId;
}

function validateFlowRuntimeConfiguration(
  flow: Flow,
  runtimes: RuntimeRegistry,
  fallbackRuntimeId: string,
  visited: Set<Flow> = new Set(),
): void {
  if (visited.has(flow)) return;
  visited.add(flow);
  for (const step of flow.steps.values()) {
    if ("kind" in step.definition && step.definition.kind === "flow") {
      validateFlowRuntimeConfiguration(step.definition, runtimes, fallbackRuntimeId, visited);
      continue;
    }
    const definition = definitionRef(step.definition);
    if (definition.kind !== "expert" && definition.kind !== "expert-team") continue;
    const expert = step.definition as ExpertDefinition;
    const nativeExpert = isExpertTeam(expert) ? expert.coordinator : expert;
    runtimes.resolve(resolveFlowStepRuntimeId(step, nativeExpert.id, fallbackRuntimeId));
    for (const runtimeId of Object.values(readFlowStepRuntimeByExpert(step) ?? {})) {
      runtimes.resolve(runtimeId);
    }
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function waitForResult(store: ExecutionStore, executionId: string): Promise<unknown> {
  while (true) {
    const record = await store.get(executionId);
    if (record === undefined) throw new Error(`Execution not found: ${executionId}`);
    if (record.status === "succeeded") return record.output;
    if (record.status === "failed" || record.status === "cancelled")
      throw new Error(readErrorMessage(record.error) ?? record.status);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function serializeError(error: unknown): unknown {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : error;
}

function readErrorMessage(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return error === undefined ? undefined : String(error);
}
