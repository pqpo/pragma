import { randomUUID } from "node:crypto";

import {
  isFinalExecutionStatus as isFinal,
  type ExecutionRecord,
  type HumanInteractionRequest,
  type Invocation,
} from "@pragma/shared";

import { isExpertTeam, type ExpertDefinition, type ExpertTeam } from "../agent/expert-team.ts";
import type { RuntimeRegistry } from "../runtime-registry.ts";
import { ExecutionController, runExpertInvocation } from "../execution/expert-runner.ts";
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
    const now = new Date().toISOString();
    const record: ExecutionRecord = {
      schemaVersion: "pragma.execution/v4",
      executionId,
      version: 0,
      kind: "flow",
      definition: { id: flow.id, version: flow.version, kind: "flow" },
      rootInvocationId: executionId,
      status: "queued",
      input,
      state: { __flowDefinitionGraph: createFlowDefinitionGraph(flow) },
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
    return this.activate(flow, executionId, request.runtime, claimId);
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
        .filter(
          (invocation) => invocation.status === "interrupted" && invocation.agentId === undefined,
        )
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
    return this.activate(flow, request.executionId, request.runtime, claimId);
  }

  private activate(
    flow: Flow,
    executionId: string,
    runtime: string | undefined,
    claimId: string,
  ): FlowExecution {
    const controller = new ExecutionController(executionId, this.executions);
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
        controller,
        store: this.executions,
        runtimes: this.runtimes,
        runtime,
      });
      const usage = controller.getUsage();
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
        events: [
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
      const storedError = serializeError(error);
      const usage = controller.getUsage();
      const current = await this.executions.get(executionId);
      if (current !== undefined && isFinal(current.status)) {
        if (usage !== undefined) await this.executions.update(executionId, { usage });
      } else {
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
          events: [
            {
              invocationId: root.invocationId,
              type: `invocation.${status}`,
              data: { error: storedError },
            },
            {
              invocationId: executionId,
              type: `execution.${status}`,
              data: { message: error instanceof Error ? error.message : String(error) },
            },
          ],
        });
      }
    } finally {
      controller.finish();
      await controller.closeRuntimes();
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
  readonly controller: ExecutionController;
  readonly store: ExecutionStore;
  readonly runtimes: RuntimeRegistry;
  readonly runtime?: string | undefined;
}): Promise<unknown> {
  let stepId: string | undefined = options.flow.startStepId;
  while (stepId !== undefined) {
    if (options.controller.isCancelled()) throw new Error("FlowExecution was cancelled.");
    const step = options.flow.steps.get(stepId);
    if (step === undefined) throw new Error(`Flow step not found: ${stepId}`);
    const invocation = await findOrCreateStepInvocation(options, step);
    let output: unknown;
    if (invocation.status === "succeeded") {
      output = invocation.output;
    } else {
      output = await runStep(options, step, invocation);
    }
    await applyReductionOnce(options, step, invocation.invocationId, output);
    const transition = options.flow.transitions.get(stepId);
    if (transition === undefined) throw new Error(`Flow step has no transition: ${stepId}`);
    const target =
      transition.type === "next"
        ? transition.target
        : (transition.cases.get(String(readField(output, transition.field))) ??
          transition.fallback);
    if (target === undefined) throw new Error(`Flow route has no matching target: ${stepId}`);
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

async function runStep(
  options: Parameters<typeof runFlow>[0],
  step: CompiledFlowStep,
  invocation: Invocation,
): Promise<unknown> {
  try {
    const record = (await options.store.get(options.executionId))!;
    const input =
      typeof step.options.input === "function"
        ? step.options.input({ state: record.state })
        : (step.options.input ?? options.input);
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
    const contextId = invocation.invocationId;
    return await runExpertInvocation({
      executionId: options.executionId,
      invocationId: invocation.invocationId,
      parentInvocationId: options.flowInvocationId,
      expert,
      prompt: typeof input === "string" ? input : JSON.stringify(input),
      owner: { type: "flow-execution", ownerId: options.executionId },
      runtimeId: step.options.runtime ?? options.runtime,
      contextId,
      runtimeSnapshot: invocation.runtimeContext,
      runtimeScope: "invocation",
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
    {
      kind: "user_question",
      toolName: "askUserQuestion",
      questions: [
        {
          question: request.prompt ?? request.title ?? "Response required",
          header: request.title ?? "Human task",
          kind: "text",
          options: [],
        },
      ],
    },
    `human:${invocation.invocationId}`,
  );
  await putStatus(options.store, options.executionId, invocation, "succeeded", response);
  return response;
}

async function findOrCreateStepInvocation(
  options: Parameters<typeof runFlow>[0],
  step: CompiledFlowStep,
): Promise<Invocation> {
  const definition = definitionRef(step.definition);
  const existing = (await options.store.listInvocations(options.executionId)).find(
    (candidate) =>
      candidate.parentInvocationId === options.flowInvocationId && candidate.nodeId === step.id,
  );
  if (existing !== undefined) return existing;
  const now = new Date().toISOString();
  const invocationId = randomUUID();
  const invocation: Invocation = {
    invocationId,
    rootInvocationId: (await options.store.get(options.executionId))!.rootInvocationId,
    parentInvocationId: options.flowInvocationId,
    nodeId: step.id,
    definition,
    contextId: invocationId,
    ...(definition.kind === "expert" || definition.kind === "expert-team"
      ? {
          executorId: isExpertTeam(step.definition as ExpertDefinition)
            ? (step.definition as ExpertTeam).coordinator.id
            : definition.id,
        }
      : {}),
    status: "queued",
    input: options.input,
    createdAt: now,
    updatedAt: now,
  };
  await options.store.commit({
    commitId: randomUUID(),
    executionId: options.executionId,
    invocationPuts: [invocation],
    events: [
      {
        invocationId: invocation.invocationId,
        type: "invocation.queued",
        data: {},
      },
    ],
  });
  return invocation;
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

function createFlowDefinitionGraph(flow: Flow): unknown {
  return visitFlowDefinition(flow, new Set<Flow>());
}

function visitFlowDefinition(flow: Flow, ancestors: Set<Flow>): unknown {
  if (ancestors.has(flow)) throw new Error(`Cyclic sub Flow definition: ${flow.id}`);
  const nextAncestors = new Set(ancestors).add(flow);
  return {
    definition: { id: flow.id, version: flow.version, kind: "flow" },
    steps: [...flow.steps.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((step) => ({ nodeId: step.id, definition: describeDefinition(step.definition) })),
  };

  function describeDefinition(definition: CompiledFlowStep["definition"]): unknown {
    if ("kind" in definition && definition.kind === "flow") {
      return visitFlowDefinition(definition, nextAncestors);
    }
    if ("kind" in definition && definition.kind === "expert-team") {
      return {
        definition: definitionRef(definition),
        coordinator: {
          id: definition.coordinator.id,
          version: definition.coordinator.version,
        },
        members: [...definition.members]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((member) => ({ id: member.id, version: member.version })),
      };
    }
    return definitionRef(definition);
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
