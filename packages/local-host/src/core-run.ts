import type {
  ExpertDefinition,
  ExpertSessionStore,
  ExecutionEvent,
  ExecutionStore,
  FlowExecution,
  Flow,
  FlowSpec,
  HostContextBindings,
  HostContextBindingsResolver,
  PragmaApp,
  PragmaLoggerProvider,
  RuntimeResolver,
  UsageSink,
  ExpertTurn,
} from "@pragma/core";
import {
  createFileExecutionStore,
  createFileExpertSessionStore,
  createPragma,
  AsyncPushQueue,
  isHumanInteractionCheckpointError,
} from "@pragma/core";
import {
  HumanInteractionRequestSchema,
  HumanInteractionResponseSchema,
  JsonValueSchema,
  type WorkspaceSelection,
  type AgentMessageUsage,
  type HumanInteractionRequest,
  type HumanInteractionResponse,
  type JsonValue,
} from "@pragma/shared";
import {
  ExecutorDescriptorSchema,
  HumanInteractionRequestEnvelopeSchema,
  HumanInteractionResponseEnvelopeSchema,
  type ExecutorDescriptor,
  type ExecutorReference,
  type HumanInteractionRequestEnvelope,
} from "@pragma/shared/integration";
import { createIntegrationError } from "@pragma/shared/integration";

import {
  type LocalHostRunEvent,
  type LocalHostRunExecutorPort,
  type LocalHostRunHandle,
  type LocalHostRunRequest,
  type LocalHostRunTerminal,
  type ResolvedRunExecutor,
} from "./run.ts";

export type LocalHostCoreDefinition = ExpertDefinition | FlowSpec<unknown, unknown> | Flow;

export interface LocalHostCoreExecutorDefinition extends ResolvedRunExecutor {
  readonly descriptor: ExecutorDescriptor;
  readonly definition: LocalHostCoreDefinition;
}

export interface LocalHostCoreRunComposition {
  readonly runtimes: RuntimeResolver;
  readonly pragmaHome?: string | undefined;
  readonly app?: PragmaApp | undefined;
  readonly executions?: ExecutionStore | undefined;
  readonly sessions?: ExpertSessionStore | undefined;
  readonly usageSink?: UsageSink | undefined;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
  readonly hostContextBindings?: HostContextBindings | undefined;
  readonly resolveHostContextBindings?: HostContextBindingsResolver | undefined;
  /** Resolve Mission-scoped bindings without sharing a ContextSystem across runs. */
  readonly createHostContextBindings?:
    | ((input: {
        readonly missionId: string;
        readonly request: LocalHostRunRequest;
        readonly executor: LocalHostCoreExecutorDefinition;
      }) => HostContextBindings | Promise<HostContextBindings>)
    | undefined;
  readonly executors:
    | readonly LocalHostCoreExecutorDefinition[]
    | ((input: {
        readonly ref: ExecutorReference;
        readonly projectId?: string | undefined;
        readonly revision?: number | undefined;
        readonly workspace: WorkspaceSelection;
      }) => Promise<LocalHostCoreExecutorDefinition | undefined>);
}

/**
 * Adapts Core's stable ExpertSession/Flow execution handles to the Host run
 * port.  Runtime packages are deliberately absent from this module; the
 * composition root supplies only a RuntimeResolver.
 */
export function createCoreRunExecutorPort(
  options: LocalHostCoreRunComposition,
): LocalHostRunExecutorPort {
  const executions =
    options.executions ?? createFileExecutionStore({ pragmaHome: options.pragmaHome });
  const sessions =
    options.sessions ??
    createFileExpertSessionStore({
      executions,
      ...(options.pragmaHome === undefined ? {} : { pragmaHome: options.pragmaHome }),
    });
  const createApp = (hostContextBindings?: HostContextBindings): PragmaApp =>
    createPragma({
      pragmaHome: options.pragmaHome,
      runtimes: options.runtimes,
      executionStore: executions,
      expertSessionStore: sessions,
      ...(options.usageSink === undefined ? {} : { usageSink: options.usageSink }),
      ...(options.loggerProvider === undefined ? {} : { loggerProvider: options.loggerProvider }),
      ...(hostContextBindings === undefined ? {} : { hostContextBindings }),
      ...(options.resolveHostContextBindings === undefined
        ? {}
        : { resolveHostContextBindings: options.resolveHostContextBindings }),
    });
  const active = new Map<string, CoreRunHandleState>();

  const resolve = async (input: {
    readonly ref: ExecutorReference;
    readonly projectId?: string | undefined;
    readonly revision?: number | undefined;
    readonly workspace: WorkspaceSelection;
  }): Promise<LocalHostCoreExecutorDefinition | undefined> => {
    const candidate =
      typeof options.executors === "function"
        ? await options.executors(input)
        : options.executors.find(
            (entry) =>
              entry.descriptor.ref.kind === input.ref.kind &&
              entry.descriptor.ref.id === input.ref.id &&
              (input.projectId === undefined ||
                entry.descriptor.project?.projectId === input.projectId) &&
              (input.revision === undefined ||
                entry.descriptor.project?.revision === input.revision),
          );
    if (candidate === undefined) return undefined;
    return {
      descriptor: ExecutorDescriptorSchema.parse(candidate.descriptor),
      definition: candidate.definition,
    };
  };

  return {
    resolve,
    validateInput: async ({ request, executor }) => {
      const coreExecutor = executor as LocalHostCoreExecutorDefinition;
      if (coreExecutor.descriptor.ref.kind !== "flow") return;
      if (!isFlowDefinition(coreExecutor.definition)) {
        throw new Error(
          `Flow executor definition is not a FlowSpec: ${coreExecutor.descriptor.ref.id}`,
        );
      }
      try {
        const input = coreExecutor.definition.input?.parse(request.input);
        return input === undefined ? undefined : { input };
      } catch {
        throw createIntegrationError({
          code: "INPUT_SCHEMA_INVALID",
          category: "usage",
          message: "Flow input does not match the executor schema.",
        });
      }
    },
    start: async (input) => {
      const definition = input.executor as LocalHostCoreExecutorDefinition;
      if (definition.definition === undefined) {
        throw new Error(`Core executor definition is missing: ${input.request.executor.id}`);
      }
      const runApp =
        options.app ??
        createApp(
          options.createHostContextBindings === undefined
            ? options.hostContextBindings
            : await options.createHostContextBindings({
                missionId: input.missionId,
                request: input.request,
                executor: definition,
              }),
        );
      const coreHandle = await startCoreDefinition({
        app: runApp,
        executions,
        sessions,
        definition,
        request: input.request,
        missionId: input.missionId,
      });
      const state = createCoreRunHandleState({
        coreHandle: coreHandle.handle,
        release: coreHandle.release,
        executions,
        missionId: input.missionId,
        onEvent: input.onEvent,
      });
      active.set(coreHandle.handle.executionId, state);
      void state.pump.finally(() => {
        if (active.get(coreHandle.handle.executionId) === state)
          active.delete(coreHandle.handle.executionId);
      });
      return state.handle;
    },
    respond: async (input) => {
      const state = active.get(input.executionId);
      if (state === undefined) {
        throw createIntegrationError({
          code: "INTERACTION_NOT_PENDING",
          category: "conflict",
          message: `Human interaction is not active: ${input.interactionId}.`,
        });
      }
      await state.respond(input.interactionId, input.response, input.requestId);
    },
  };
}

interface CoreRunHandleState {
  readonly handle: LocalHostRunHandle;
  readonly pump: Promise<void>;
  readonly respond: (interactionId: string, response: unknown, requestId: string) => Promise<void>;
}

interface StartedCoreHandle {
  readonly handle: ExpertTurn | FlowExecution;
  readonly release: () => Promise<void>;
}

async function startCoreDefinition(options: {
  readonly app: PragmaApp;
  readonly executions: ExecutionStore;
  readonly sessions: ExpertSessionStore;
  readonly definition: LocalHostCoreExecutorDefinition;
  readonly request: LocalHostRunRequest;
  readonly missionId: string;
}): Promise<StartedCoreHandle> {
  if (options.definition.descriptor.ref.kind === "flow") {
    if (!isFlowDefinition(options.definition.definition)) {
      throw new Error(
        `Flow executor definition is not a FlowSpec: ${options.definition.descriptor.ref.id}`,
      );
    }
    const existing = await options.executions.get(options.missionId);
    if (existing !== undefined) {
      return {
        handle: await options.app.flows.recover(options.definition.definition, {
          executionId: options.missionId,
        }),
        release: async () => undefined,
      };
    }
    return {
      handle: await options.app.flows.start(options.definition.definition, {
        input: options.request.input ?? {},
        executionId: options.missionId,
      }),
      release: async () => undefined,
    };
  }
  if (isFlowDefinition(options.definition.definition)) {
    throw new Error(
      `Non-Flow executor definition is a FlowSpec: ${options.definition.descriptor.ref.id}`,
    );
  }
  const existing = await options.sessions.get(options.missionId);
  const session =
    existing === undefined
      ? await options.app.experts.createSession(options.definition.definition, {
          sessionId: options.missionId,
        })
      : await options.app.experts.resumeSession(options.definition.definition, {
          sessionId: options.missionId,
        });
  try {
    return {
      handle: await session.prompt(
        options.request.prompt ?? JSON.stringify(options.request.input ?? null),
        { requestId: options.request.requestId },
      ),
      release: async () => await session.releaseAfterTerminal(),
    };
  } catch (error) {
    await session.releaseAfterTerminal().catch(() => undefined);
    throw error;
  }
}

function createCoreRunHandleState(options: {
  readonly coreHandle: ExpertTurn | FlowExecution;
  readonly release: () => Promise<void>;
  readonly executions: ExecutionStore;
  readonly missionId: string;
  readonly onEvent?: ((event: LocalHostRunEvent) => void) | undefined;
}): CoreRunHandleState {
  const pending = new Map<string, HumanInteractionRequestEnvelope>();
  let settled = false;
  let resolveCheckpoint: ((terminal: LocalHostRunTerminal) => void) | undefined;
  let pump: Promise<void> = Promise.resolve();
  const checkpoint = new Promise<LocalHostRunTerminal>((resolve) => {
    resolveCheckpoint = resolve;
  });
  const complete = options.coreHandle.result.then(
    async (result): Promise<LocalHostRunTerminal> => {
      settled = true;
      await pump;
      const record = await options.executions.get(options.coreHandle.executionId);
      return {
        status: "succeeded",
        executionId: options.coreHandle.executionId,
        result: toJsonValue(result),
        ...(record?.usage === undefined ? {} : { usage: record.usage }),
      };
    },
    async (error): Promise<LocalHostRunTerminal> => {
      settled = true;
      if (isHumanInteractionCheckpointError(error)) {
        // The checkpoint path owns the durable pending result.  Do not issue
        // another Execution read here: the result race may already have
        // resolved and a late read can outlive the Host lease cleanup.
        return await checkpoint;
      }
      return await terminalFromExecution(
        options.executions,
        options.coreHandle.executionId,
        error,
        pending,
        options.missionId,
      );
    },
  );
  const handle: LocalHostRunHandle = {
    executionId: options.coreHandle.executionId,
    result: Promise.race([complete, checkpoint]),
    release: options.release,
    cancel: async (reason) => await options.coreHandle.cancel(reason),
    checkpointWaitingHuman: async () => {
      if (settled) return;
      await options.coreHandle.checkpointWaitingHuman();
      const interaction = await readPendingInteraction(
        options.executions,
        options.coreHandle.executionId,
        options.missionId,
        pending,
      );
      if (interaction === undefined) {
        throw new Error(`Human interaction checkpoint has no pending request.`);
      }
      await pump;
      resolveCheckpoint?.({
        status: "input_required",
        executionId: options.coreHandle.executionId,
        interaction,
        ...(await readUsage(options.executions, options.coreHandle.executionId)),
      });
    },
    respondToHumanInteraction: async (interactionId, response, requestId) => {
      const envelope =
        pending.get(interactionId) ??
        (await readPendingInteraction(
          options.executions,
          options.coreHandle.executionId,
          options.missionId,
          pending,
          interactionId,
        ));
      if (envelope === undefined) {
        throw createIntegrationError({
          code: "INTERACTION_NOT_PENDING",
          category: "conflict",
          message: `Human interaction is not pending: ${interactionId}.`,
        });
      }
      await options.coreHandle.respondToHumanInteraction(
        interactionId,
        toCoreResponse(envelope.interaction, response),
        { requestId },
      );
    },
  };
  const queue = new AsyncPushQueue<LocalHostRunEvent>();
  pump = (async () => {
    const subscription = await options.coreHandle.subscribeEvents({ scope: { kind: "all" } });
    try {
      for await (const event of subscription) {
        const mapped = mapExecutionEvent(
          event,
          options.missionId,
          options.coreHandle.executionId,
          pending,
        );
        options.onEvent?.(mapped);
        queue.push(mapped);
      }
    } finally {
      await subscription.close();
      queue.close();
    }
  })().catch((error) => {
    queue.fail(error);
  });
  return {
    handle: { ...handle, events: queue },
    pump,
    respond: async (interactionId, response, requestId) =>
      await handle.respondToHumanInteraction?.(interactionId, response, requestId),
  };
}

async function terminalFromExecution(
  executions: ExecutionStore,
  executionId: string,
  error: unknown,
  pending: Map<string, HumanInteractionRequestEnvelope>,
  missionId: string,
): Promise<LocalHostRunTerminal> {
  const record = await executions.get(executionId);
  const interaction = await readPendingInteraction(executions, executionId, missionId, pending);
  if (interaction !== undefined && record?.status === "waiting") {
    return {
      status: "input_required",
      executionId,
      interaction,
      ...(record.usage === undefined ? {} : { usage: record.usage }),
    };
  }
  if (record?.status === "cancelled" || record?.status === "interrupted") {
    return {
      status: "interrupted",
      executionId,
      ...(record.usage === undefined ? {} : { usage: record.usage }),
    };
  }
  return {
    status: "failed",
    executionId,
    error: createIntegrationError({
      code: "EXECUTION_FAILED",
      category: "execution",
      retryable: false,
      message: errorMessage(error),
    }),
    ...(record?.usage === undefined ? {} : { usage: record.usage }),
  };
}

async function readUsage(
  executions: ExecutionStore,
  executionId: string,
): Promise<{ readonly usage?: AgentMessageUsage | undefined }> {
  const usage = (await executions.get(executionId))?.usage;
  return usage === undefined ? {} : { usage };
}

async function readPendingInteraction(
  executions: ExecutionStore,
  executionId: string,
  missionId: string,
  pending: Map<string, HumanInteractionRequestEnvelope>,
  interactionId?: string,
): Promise<HumanInteractionRequestEnvelope | undefined> {
  const events = await executions.readEvents(executionId);
  const responded = new Set(
    events
      .filter((event) => event.type === "human.responded")
      .map((event) => String(readObject(event.data)?.["interactionId"] ?? "")),
  );
  for (const event of events) {
    if (event.type !== "human.requested") continue;
    const data = readObject(event.data);
    const id = typeof data?.["interactionId"] === "string" ? data["interactionId"] : undefined;
    if (
      id === undefined ||
      responded.has(id) ||
      (interactionId !== undefined && id !== interactionId)
    ) {
      continue;
    }
    const request = toHumanInteractionRequest(data?.["request"]);
    if (request === undefined) continue;
    const envelope = HumanInteractionRequestEnvelopeSchema.parse({
      schemaVersion: "pragma.human-interaction/v1",
      kind: "request",
      missionId,
      executionId,
      interactionId: id,
      sensitive: false,
      interaction: request,
    });
    pending.set(id, envelope);
    return envelope;
  }
  return undefined;
}

function mapExecutionEvent(
  event: ExecutionEvent,
  missionId: string,
  executionId: string,
  pending: Map<string, HumanInteractionRequestEnvelope>,
): LocalHostRunEvent {
  const data = readObject(event.data);
  if (event.type === "human.requested" && data !== undefined) {
    const interactionId =
      typeof data["interactionId"] === "string" ? data["interactionId"] : undefined;
    const request = toHumanInteractionRequest(data["request"]);
    if (interactionId !== undefined && request !== undefined) {
      const envelope = HumanInteractionRequestEnvelopeSchema.parse({
        schemaVersion: "pragma.human-interaction/v1",
        kind: "request",
        missionId,
        executionId,
        interactionId,
        sensitive: false,
        interaction: request,
      });
      pending.set(interactionId, envelope);
      return {
        type: "human.interaction.requested",
        data: toJsonValue(envelope),
        replayable: true,
        cursor: event.cursor.sequence.toString(),
      };
    }
  }
  if (event.type === "human.responded" && data !== undefined) {
    const interactionId =
      typeof data["interactionId"] === "string" ? data["interactionId"] : undefined;
    const request = interactionId === undefined ? undefined : pending.get(interactionId);
    const response =
      request === undefined ? undefined : toSharedResponse(request.interaction, data["response"]);
    if (interactionId !== undefined && request !== undefined && response !== undefined) {
      const envelope = HumanInteractionResponseEnvelopeSchema.parse({
        schemaVersion: "pragma.human-interaction/v1",
        kind: "response",
        missionId,
        executionId,
        interactionId,
        sensitive: request.sensitive,
        interaction: response,
      });
      pending.delete(interactionId);
      return {
        type: "human.interaction.resolved",
        data: toJsonValue(envelope),
        replayable: true,
        cursor: event.cursor.sequence.toString(),
      };
    }
  }
  return {
    type: event.type,
    data: toJsonValue(event.data),
    replayable: true,
    cursor: event.cursor.sequence.toString(),
  };
}

function toHumanInteractionRequest(value: unknown): HumanInteractionRequest | undefined {
  const parsed = HumanInteractionRequestSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (!isRecord(value)) return undefined;
  if (value["kind"] === "tool_approval") {
    return HumanInteractionRequestSchema.parse({
      kind: "approval",
      title: "Tool approval",
      prompt: typeof value["reason"] === "string" ? value["reason"] : "Approve this tool call?",
      options: [
        { value: "approve", label: "approve", description: "Allow the tool call." },
        { value: "reject", label: "reject", description: "Reject the tool call." },
      ],
      approveOption: "approve",
      data: {
        toolName: value["toolName"],
        toolCallId: value["toolCallId"],
        input: value["input"],
      },
    });
  }
  if (value["kind"] === "user_question") {
    const presentation = HumanInteractionRequestSchema.safeParse(value["presentation"]);
    if (presentation.success) return presentation.data;
    const questions = Array.isArray(value["questions"])
      ? value["questions"].flatMap((question) => {
          const parsedQuestion = userQuestionToShared(question);
          return parsedQuestion === undefined ? [] : [parsedQuestion];
        })
      : [];
    return HumanInteractionRequestSchema.parse({
      kind: "question",
      title: questions[0]?.header ?? "Question",
      prompt: questions[0]?.question ?? "Response required",
      ...(questions.length === 0 ? {} : { questions }),
    });
  }
  return undefined;
}

function userQuestionToShared(value: unknown) {
  if (!isRecord(value)) return undefined;
  const question = typeof value["question"] === "string" ? value["question"] : undefined;
  const header = typeof value["header"] === "string" ? value["header"] : undefined;
  const kind = value["kind"];
  if (
    question === undefined ||
    header === undefined ||
    (kind !== "single_choice" && kind !== "multiple_choice" && kind !== "text")
  ) {
    return undefined;
  }
  const options = Array.isArray(value["options"])
    ? value["options"].flatMap((option) => {
        if (!isRecord(option) || typeof option["label"] !== "string") return [];
        return [
          {
            label: option["label"],
            description: typeof option["description"] === "string" ? option["description"] : "",
            ...(typeof option["value"] === "string" ? { value: option["value"] } : {}),
          },
        ];
      })
    : [];
  return { question, header, kind, options };
}

function toCoreResponse(request: HumanInteractionRequest, value: unknown): unknown {
  const response = HumanInteractionResponseSchema.parse(value);
  if (request.kind === "approval") {
    const decision = response.decision ?? response.selection;
    const first = Array.isArray(decision) ? decision[0] : decision;
    return {
      kind: "tool_approval",
      approved: response.approved ?? first === request.approveOption,
      ...(response.notes === undefined ? {} : { reason: response.notes }),
    };
  }
  return {
    kind: "user_question",
    answered: true,
    ...(response.answers === undefined
      ? { answers: response.selection ?? response.data ?? response.notes }
      : { answers: response.answers }),
    ...(response.notes === undefined ? {} : { notes: response.notes }),
  };
}

function toSharedResponse(
  request: HumanInteractionRequest,
  value: unknown,
): HumanInteractionResponse | undefined {
  if (!isRecord(value)) return undefined;
  if (request.kind === "approval" && value["kind"] === "tool_approval") {
    return HumanInteractionResponseSchema.parse({
      approved: value["approved"],
      decision: value["approved"] === true ? "approve" : "reject",
      ...(typeof value["reason"] === "string" ? { notes: value["reason"] } : {}),
    });
  }
  if (value["kind"] === "user_question") {
    return HumanInteractionResponseSchema.parse({
      ...(value["answers"] === undefined ? {} : { answers: value["answers"] }),
      ...(typeof value["notes"] === "string" ? { notes: value["notes"] } : {}),
    });
  }
  return undefined;
}

function isFlowDefinition(
  value: LocalHostCoreDefinition,
): value is FlowSpec<unknown, unknown> | Flow {
  return "kind" in value && value.kind === "flow";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  const parsed = JsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
