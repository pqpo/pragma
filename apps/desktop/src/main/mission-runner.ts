import {
  createPragma,
  createFileExecutionStore,
  createRuntimeRegistry,
  ExpertAgentHumanRequestSchema,
  type Expert,
  type ExpertAgentHumanRequest,
  type ExpertAgentHumanResponse,
  type ExpertAgentManagedTool,
  type ExpertAgentToolCallResult,
  type ExpertSession,
  type MutableExecution,
  type RuntimeRegistry,
} from "@pragma/core";
import type { InvocableResource } from "@pragma/interpreter";
import type { PragmaExpertResource, PragmaResource } from "@pragma/interpreter/ast";
import type {
  HumanInteractionRequest,
  HumanInteractionResponse,
  InvocationTree,
} from "@pragma/shared";
import { createClaudeCodeRuntime } from "@pragma/runtime-claude-code";
import { createCodexRuntime } from "@pragma/runtime-codex";
import { createPiRuntime } from "@pragma/runtime-pi";

import type { Mission, MissionHumanInteraction, MissionWorkItem } from "../shared/desktop-api.ts";
import type { CapabilityCredentialStore } from "./capability-credential-store.ts";
import type { CapabilityStore } from "./capability-store.ts";
import { createDesktopExpertAgent } from "./desktop-expert-factory.ts";
import { pragmaExpertResourceToDesktopDefinition } from "./expert-definition-store.ts";
import type { MissionStore } from "./mission-store.ts";
import type { ModelProviderStore } from "./model-provider-store.ts";
import type { PragmaProjectStore } from "./pragma-project-store.ts";

export interface MissionRunner {
  run(id: string): Promise<Mission>;
  sendMessage(input: {
    readonly id: string;
    readonly content: string;
    readonly requestId: string;
  }): Promise<Mission>;
  listWorkItems(id: string): Promise<readonly MissionWorkItem[]>;
  delete(id: string): Promise<void>;
  listHumanInteractions(id: string): Promise<readonly MissionHumanInteraction[]>;
  respondToHumanInteraction(input: {
    readonly missionId: string;
    readonly interactionId: string;
    readonly requestId: string;
    readonly response: HumanInteractionResponse;
  }): Promise<void>;
}

type PendingMissionOperation =
  | { readonly kind: "run"; readonly promise: Promise<Mission> }
  | { readonly kind: "message"; readonly promise: Promise<Mission> }
  | { readonly kind: "delete"; readonly promise: Promise<void> };

export function createMissionRunner(options: {
  readonly missions: MissionStore;
  readonly project: PragmaProjectStore;
  readonly capabilityStore: CapabilityStore;
  readonly capabilityCredentials: CapabilityCredentialStore;
  readonly capabilitiesPath: string;
  readonly pragmaHome: string;
  readonly modelProviders: ModelProviderStore;
  readonly runtimes?: RuntimeRegistry | undefined;
}): MissionRunner {
  const runtimes = options.runtimes ?? createDesktopRuntimeRegistry();
  const executionStore = createFileExecutionStore({ pragmaHome: options.pragmaHome });
  const app = createPragma({
    pragmaHome: options.pragmaHome,
    runtimes,
    executionStore,
  });
  const active = new Map<string, MutableExecution & { readonly result: Promise<unknown> }>();
  const sessions = new Map<string, ExpertSession>();
  const pendingOperations = new Map<string, PendingMissionOperation>();

  const trackOperation = (id: string, operation: PendingMissionOperation): void => {
    pendingOperations.set(id, operation);
    const clear = () => {
      if (pendingOperations.get(id) === operation) pendingOperations.delete(id);
    };
    void operation.promise.then(clear, clear);
  };

  const forgetActive = (
    id: string,
    execution: MutableExecution & { readonly result: Promise<unknown> },
  ): void => {
    if (active.get(id) === execution) active.delete(id);
  };

  const runMission = async (id: string): Promise<Mission> => {
    const mission = await options.missions.get(id);
    if (active.has(mission.id)) return mission;
    const project = await options.project.openRevision(mission.project.revision);
    const compiled = await project.compile<InvocableResource>(mission.executor.ref, {
      workspace: mission.workspace.path,
      runtimes,
      createExpert: async ({ resource, tools, workspace }) =>
        await createExpert(resource, tools, workspace, mission.project.revision, options),
    });
    const startedAt = new Date().toISOString();

    if ("kind" in compiled.value && compiled.value.kind === "flow") {
      const runtime = resolveRootRuntime(project.listResources(), mission.executor.ref, runtimes);
      const recoverable =
        mission.execution !== undefined &&
        ["queued", "running", "waiting"].includes(mission.execution.status);
      const handle = recoverable
        ? await app.flows.recover(compiled.value, {
            executionId: mission.execution!.id,
            runtime,
          })
        : await app.flows.start(compiled.value, {
            input: { goal: mission.goal, workspace: mission.workspace.path },
            runtime,
          });
      const running = await options.missions.updateExecution(mission.id, {
        id: handle.executionId,
        status: "running",
        startedAt,
      });
      active.set(mission.id, handle);
      observeExecution(
        options.missions,
        mission.id,
        handle,
        startedAt,
        () => {
          forgetActive(mission.id, handle);
        },
        undefined,
        async (result) => {
          await appendExecutionReply(options.missions, mission.id, handle, result);
        },
      );
      return running;
    }

    const recoverable =
      mission.execution !== undefined &&
      mission.execution.sessionId !== undefined &&
      ["queued", "running", "waiting"].includes(mission.execution.status);
    const session =
      sessions.get(mission.id) ??
      (recoverable
        ? await app.experts.resumeSession(compiled.value, {
            sessionId: mission.execution!.sessionId!,
          })
        : await app.experts.createSession(compiled.value, {
            runtime: resolveRootRuntime(project.listResources(), mission.executor.ref, runtimes),
          }));
    sessions.set(mission.id, session);
    const turn = await session.prompt(
      recoverable
        ? [
            "[Pragma mission recovery]",
            "The previous Desktop process ended before this mission finished.",
            "Continue the pinned mission from the restored ExpertSession context.",
            `Mission goal: ${mission.goal}`,
          ].join("\n")
        : mission.goal,
    );
    const running = await options.missions.updateExecution(mission.id, {
      id: turn.executionId,
      sessionId: session.sessionId,
      status: "running",
      startedAt,
    });
    active.set(mission.id, turn);
    observeExecution(
      options.missions,
      mission.id,
      turn,
      startedAt,
      async () => {
        try {
          await waitForExpertTurnSettlement(session, turn.requestId);
        } finally {
          forgetActive(mission.id, turn);
        }
      },
      session.sessionId,
      async (result) => {
        await appendExecutionReply(options.missions, mission.id, turn, result);
      },
    );
    return running;
  };

  const sendMissionMessage = async (input: {
    readonly id: string;
    readonly content: string;
    readonly requestId: string;
  }): Promise<Mission> => {
    const mission = await options.missions.get(input.id);
    if (mission.executor.kind === "flow") {
      throw new Error("Flow missions accept input through workflow steps, not chat messages.");
    }
    if (mission.lifecycleStatus !== "active") {
      throw new Error("Reopen this mission before sending another message.");
    }
    if (active.has(mission.id)) {
      throw new Error("Wait for the current expert turn before sending another message.");
    }
    const project = await options.project.openRevision(mission.project.revision);
    const compiled = await project.compile<InvocableResource>(mission.executor.ref, {
      workspace: mission.workspace.path,
      runtimes,
      createExpert: async ({ resource, tools, workspace }) =>
        await createExpert(resource, tools, workspace, mission.project.revision, options),
    });
    if ("kind" in compiled.value && compiled.value.kind === "flow") {
      throw new Error("Flow missions cannot receive chat messages.");
    }
    const session =
      sessions.get(mission.id) ??
      (mission.execution?.sessionId === undefined
        ? await app.experts.createSession(compiled.value, {
            runtime: resolveRootRuntime(project.listResources(), mission.executor.ref, runtimes),
          })
        : await app.experts.resumeSession(compiled.value, {
            sessionId: mission.execution.sessionId,
          }));
    sessions.set(mission.id, session);
    await options.missions.appendMessage(mission.id, {
      id: input.requestId,
      role: "user",
      content: input.content,
      createdAt: new Date().toISOString(),
    });
    const turn = await session.prompt(input.content, { requestId: input.requestId });
    const startedAt = new Date().toISOString();
    const running = await options.missions.updateExecution(mission.id, {
      id: turn.executionId,
      sessionId: session.sessionId,
      status: "running",
      startedAt,
    });
    active.set(mission.id, turn);
    observeExecution(
      options.missions,
      mission.id,
      turn,
      startedAt,
      async () => {
        try {
          await waitForExpertTurnSettlement(session, turn.requestId);
        } finally {
          forgetActive(mission.id, turn);
        }
      },
      session.sessionId,
      async (result) => {
        await appendExecutionReply(options.missions, mission.id, turn, result);
      },
    );
    return running;
  };

  const deleteMission = async (id: string): Promise<void> => {
    if (active.has(id)) {
      throw new Error("Stop the active execution before deleting this mission.");
    }
    const session = sessions.get(id);
    if (session !== undefined) {
      await session.close("Mission deleted.");
      sessions.delete(id);
    }
    await options.missions.remove(id);
  };

  return {
    async run(id) {
      const pending = pendingOperations.get(id);
      if (pending?.kind === "run") return await pending.promise;
      if (pending !== undefined) {
        throw new Error("Wait for the current mission operation to finish.");
      }
      const started = runMission(id);
      trackOperation(id, { kind: "run", promise: started });
      return await started;
    },
    async sendMessage(input) {
      if (pendingOperations.has(input.id)) {
        throw new Error("Wait for the current mission operation to finish.");
      }
      const sending = sendMissionMessage(input);
      trackOperation(input.id, { kind: "message", promise: sending });
      return await sending;
    },
    async listWorkItems(id) {
      const mission = await options.missions.get(id);
      if (mission.execution === undefined) return [];
      const tree = await executionStore.getTree(mission.execution.id);
      return tree === undefined ? [] : flattenWorkItems(tree);
    },
    async delete(id) {
      if (pendingOperations.has(id)) {
        throw new Error("Wait for the current mission operation to finish.");
      }
      const deleting = deleteMission(id);
      trackOperation(id, { kind: "delete", promise: deleting });
      await deleting;
    },
    async listHumanInteractions(id) {
      const execution = active.get(id);
      if (execution === undefined) return [];
      const events = (await execution.listEvents({ scope: { kind: "all" }, limit: 1_000 })).items;
      const responded = new Set(
        events
          .filter((event) => event.type === "human.responded")
          .map((event) => String((event.data as { interactionId?: unknown }).interactionId)),
      );
      return events.flatMap((event) => {
        if (event.type !== "human.requested") return [];
        const data = event.data as { interactionId?: unknown; request?: unknown };
        const interactionId = String(data.interactionId ?? "");
        if (interactionId === "" || responded.has(interactionId)) return [];
        const request = ExpertAgentHumanRequestSchema.safeParse(data.request);
        return request.success
          ? [{ interactionId, request: toDesktopHumanRequest(request.data) }]
          : [];
      });
    },
    async respondToHumanInteraction(input) {
      const execution = active.get(input.missionId);
      if (execution === undefined) {
        throw new Error("This human interaction is not active in the current Desktop process.");
      }
      const request = await findHumanRequest(execution, input.interactionId);
      await execution.respondToHumanInteraction(
        input.interactionId,
        toExpertHumanResponse(request, input.response),
        {
          requestId: input.requestId,
        },
      );
    },
  };
}

function createDesktopRuntimeRegistry(): RuntimeRegistry {
  return createRuntimeRegistry({
    defaultRuntime: "codex",
    runtimes: [
      createCodexRuntime({ descriptor: { id: "codex" } }),
      createClaudeCodeRuntime({ descriptor: { id: "claude-code" } }),
      createPiRuntime({ descriptor: { id: "pi" } }),
    ],
  });
}

async function createExpert(
  resource: PragmaExpertResource,
  tools: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[],
  workspace: string,
  revision: number,
  options: {
    readonly capabilityStore: CapabilityStore;
    readonly capabilityCredentials: CapabilityCredentialStore;
    readonly capabilitiesPath: string;
    readonly modelProviders: ModelProviderStore;
  },
): Promise<Expert> {
  const definition = pragmaExpertResourceToDesktopDefinition(
    resource,
    revision,
    new Date().toISOString(),
  );
  return await createDesktopExpertAgent({
    definition,
    workspace,
    store: options.capabilityStore,
    credentials: options.capabilityCredentials,
    capabilitiesPath: options.capabilitiesPath,
    overrides: {
      tools,
      ...(await resolveExpertModels(resource, options)),
    },
  });
}

async function resolveExpertModels(
  resource: PragmaExpertResource,
  options: { readonly modelProviders: ModelProviderStore },
) {
  const runtime = resource.spec.runtime;
  if (runtime?.model === undefined) return {};
  if (runtime.id !== "pi") {
    return { models: { defaultModelName: runtime.model, providers: [] } };
  }
  if (runtime.provider === undefined) {
    throw new Error(`Expert ${resource.metadata.id} must configure a PI model provider.`);
  }
  const provider = await options.modelProviders.getCredentials(runtime.provider);
  return {
    models: {
      defaultModelName: runtime.model,
      providers: [
        {
          provider: runtime.provider,
          modelNames: provider.models,
          baseApi: provider.baseUrl,
          key: provider.apiKey,
          api: "openai-completions" as const,
        },
      ],
    },
  };
}

function resolveRootRuntime(
  resources: readonly PragmaResource[],
  ref: string,
  runtimes: RuntimeRegistry,
): string {
  const parsed = /^(expert|team|flow):([^@]+)@(.+)$/.exec(ref);
  if (parsed === null) return runtimes.defaultRuntime;
  let resource = resources.find(
    (candidate) =>
      resourceKind(candidate) === parsed[1] &&
      candidate.metadata.id === parsed[2] &&
      candidate.metadata.version === parsed[3],
  );
  if (resource?.kind === "ExpertTeam") {
    const coordinator = /^expert:([^@]+)@(.+)$/.exec(resource.spec.coordinator.ref);
    resource = resources.find(
      (candidate) =>
        candidate.kind === "Expert" &&
        candidate.metadata.id === coordinator?.[1] &&
        candidate.metadata.version === coordinator?.[2],
    );
  }
  return resource?.kind === "Expert"
    ? (resource.spec.runtime?.id ?? runtimes.defaultRuntime)
    : runtimes.defaultRuntime;
}

function observeExecution(
  missions: MissionStore,
  missionId: string,
  execution: {
    readonly executionId: string;
    readonly result: Promise<unknown>;
    readonly getState: () => Promise<{ readonly status: string }>;
    readonly listEvents: MutableExecution["listEvents"];
    readonly getMessageHistory: MutableExecution["getMessageHistory"];
  },
  startedAt: string,
  onFinished: () => void | Promise<void>,
  sessionId?: string,
  onSucceeded?: (result: unknown) => void | Promise<void>,
): void {
  let lastObservedStatus: string | undefined;
  const probe = setInterval(() => {
    void execution
      .getState()
      .then(async (state) => {
        const waiting = state.status === "waiting" || (await hasPendingHumanInteraction(execution));
        if (!waiting) {
          const resumed = lastObservedStatus === "waiting" && state.status === "running";
          lastObservedStatus = state.status;
          if (resumed) {
            await missions.updateExecution(
              missionId,
              {
                id: execution.executionId,
                ...(sessionId === undefined ? {} : { sessionId }),
                status: "running",
                startedAt,
              },
              {
                executionId: execution.executionId,
                statuses: ["queued", "running", "waiting"],
              },
            );
          }
          return;
        }
        if (lastObservedStatus === "waiting") return;
        lastObservedStatus = "waiting";
        await missions.updateExecution(
          missionId,
          {
            id: execution.executionId,
            ...(sessionId === undefined ? {} : { sessionId }),
            status: "waiting",
            startedAt,
          },
          {
            executionId: execution.executionId,
            statuses: ["queued", "running", "waiting"],
          },
        );
      })
      .catch(() => {
        // The result observer below records terminal failures.
      });
  }, 500);
  probe.unref();
  void (async () => {
    let status: "succeeded" | "failed" | "cancelled" = "succeeded";
    let failure: unknown;
    let result: unknown;
    try {
      result = await execution.result;
    } catch (error) {
      const state = await execution.getState().catch(() => undefined);
      status = state?.status === "cancelled" ? "cancelled" : "failed";
      failure = error;
    }
    if (status === "succeeded") {
      try {
        await onSucceeded?.(result);
      } catch (error) {
        console.error(`Failed to persist Mission reply for ${execution.executionId}.`, error);
      }
    }
    clearInterval(probe);
    try {
      await onFinished();
    } catch (error) {
      console.error(`Failed to finish Mission execution ${execution.executionId}.`, error);
    }
    await missions.updateExecution(
      missionId,
      {
        id: execution.executionId,
        ...(sessionId === undefined ? {} : { sessionId }),
        status,
        startedAt,
        finishedAt: new Date().toISOString(),
        ...(status === "failed"
          ? { error: failure instanceof Error ? failure.message : String(failure) }
          : {}),
      },
      {
        executionId: execution.executionId,
        statuses: ["queued", "running", "waiting"],
      },
    );
  })().catch((error: unknown) => {
    console.error(`Failed to persist terminal Mission execution ${execution.executionId}.`, error);
  });
}

async function appendExecutionReply(
  missions: MissionStore,
  missionId: string,
  execution: Pick<MutableExecution, "executionId" | "getMessageHistory">,
  result: unknown,
): Promise<void> {
  const histories = await execution.getMessageHistory({ scope: { kind: "root" } }).catch(() => []);
  const assistantText = histories
    .flatMap((history) => history.messages)
    .map((record) => record.message)
    .filter((message) => message.role === "assistant")
    .map((message) =>
      message.content
        .flatMap((content) => (content.type === "text" ? [content.text] : []))
        .join("\n"),
    )
    .filter((content) => content.trim() !== "")
    .at(-1);
  const content = formatValue(assistantText ?? result, 200_000).trim();
  await missions.appendMessage(missionId, {
    id: execution.executionId,
    role: "assistant",
    content: content === "" ? "Execution completed without a text result." : content,
    createdAt: new Date().toISOString(),
    executionId: execution.executionId,
  });
}

function flattenWorkItems(tree: InvocationTree): MissionWorkItem[] {
  const invocation = tree.invocation;
  return [
    {
      invocationId: invocation.invocationId,
      ...(invocation.parentInvocationId === undefined
        ? {}
        : { parentInvocationId: invocation.parentInvocationId }),
      ...(invocation.nodeId === undefined ? {} : { nodeId: invocation.nodeId }),
      ...(invocation.executorId === undefined ? {} : { executorId: invocation.executorId }),
      kind: invocation.definition.kind,
      status: invocation.status,
      inputSummary: formatValue(invocation.input, 500),
      ...(invocation.output === undefined
        ? {}
        : { outputSummary: formatValue(invocation.output, 1_000) }),
    },
    ...tree.children.flatMap(flattenWorkItems),
  ];
}

function formatValue(value: unknown, maxLength: number): string {
  let content: string;
  if (typeof value === "string") {
    content = value;
  } else if (value === undefined) {
    content = "";
  } else {
    try {
      content = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      content = String(value);
    }
  }
  return content.length <= maxLength
    ? content
    : `${content.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

async function hasPendingHumanInteraction(execution: {
  readonly listEvents: MutableExecution["listEvents"];
}): Promise<boolean> {
  const events = (await execution.listEvents({ scope: { kind: "all" }, limit: 1_000 })).items;
  const responded = new Set(
    events
      .filter((event) => event.type === "human.responded")
      .map((event) => String((event.data as { interactionId?: unknown }).interactionId)),
  );
  return events.some(
    (event) =>
      event.type === "human.requested" &&
      !responded.has(String((event.data as { interactionId?: unknown }).interactionId)),
  );
}

function resourceKind(resource: PragmaResource): "expert" | "team" | "flow" {
  return resource.kind === "Expert" ? "expert" : resource.kind === "ExpertTeam" ? "team" : "flow";
}

async function findHumanRequest(
  execution: MutableExecution,
  interactionId: string,
): Promise<ExpertAgentHumanRequest> {
  const events = (await execution.listEvents({ scope: { kind: "all" }, limit: 1_000 })).items;
  const event = events.find(
    (candidate) =>
      candidate.type === "human.requested" &&
      (candidate.data as { interactionId?: unknown }).interactionId === interactionId,
  );
  if (event === undefined) throw new Error(`Human interaction was not found: ${interactionId}`);
  return ExpertAgentHumanRequestSchema.parse((event.data as { request?: unknown }).request);
}

function toDesktopHumanRequest(request: ExpertAgentHumanRequest): HumanInteractionRequest {
  if (request.kind === "tool_approval") {
    return {
      kind: "approval",
      title: request.toolName,
      prompt: request.reason ?? `Approve ${request.toolName}?`,
      data: request.input,
    };
  }
  const first = request.questions[0];
  const approval =
    request.questions.length === 1 &&
    first?.kind === "single_choice" &&
    first.options.some((option) => /^approve$/i.test(option.label)) &&
    first.options.some((option) => /^reject$/i.test(option.label));
  return {
    kind: approval ? "approval" : "question",
    ...(first === undefined ? {} : { title: first.header, prompt: first.question }),
    questions: request.questions.map((question) => ({
      ...question,
      options: question.options.map((option) => ({ ...option })),
    })),
  };
}

function toExpertHumanResponse(
  request: ExpertAgentHumanRequest,
  response: HumanInteractionResponse,
): ExpertAgentHumanResponse {
  if (request.kind === "tool_approval") {
    return {
      kind: "tool_approval",
      approved: response.approved ?? response.decision === "approved",
      ...(response.notes === undefined ? {} : { reason: response.notes }),
    };
  }
  const supplied =
    typeof response.answers === "object" && response.answers !== null
      ? { ...(response.answers as Record<string, unknown>) }
      : {};
  for (const question of request.questions) {
    if (supplied[question.question] !== undefined) continue;
    if (question.kind === "text" && response.notes !== undefined) {
      supplied[question.question] = response.notes;
      continue;
    }
    if (question.kind === "single_choice") {
      const selected =
        response.approved === undefined
          ? response.decision
          : (question.options.find((option) =>
              response.approved
                ? /^approve(?:d)?$/i.test(option.label)
                : /^reject(?:ed)?$/i.test(option.label),
            )?.label ?? response.decision);
      if (selected !== undefined) supplied[question.question] = selected;
    }
  }
  return { kind: "user_question", answered: true, answers: supplied };
}

async function waitForExpertTurnSettlement(
  session: ExpertSession,
  requestId: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [state, prompts] = await Promise.all([session.getState(), session.getPromptQueue()]);
    const prompt = prompts.find((candidate) => candidate.requestId === requestId);
    const settled =
      prompt !== undefined &&
      ["succeeded", "failed", "cancelled"].includes(prompt.status) &&
      state.activeExecutionId !== prompt.executionId;
    if (settled) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
