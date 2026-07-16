import {
  createPragma,
  createFileExecutionStore,
  createRuntimeRegistry,
  ExpertAgentHumanRequestSchema,
  StoredExecutionView,
  type AgentMessageRecord,
  type ExecutionOutputItem,
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

import type {
  Mission,
  MissionChatEntry,
  MissionChatSnapshot,
  MissionChatUpdate,
  MissionHumanInteraction,
  MissionWorkItem,
} from "../shared/desktop-api.ts";
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
  getChat(id: string): Promise<MissionChatSnapshot>;
  subscribeChat(listener: (update: MissionChatUpdate) => void): () => void;
  interrupt(id: string): Promise<Mission>;
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
  | { readonly kind: "interrupt"; readonly promise: Promise<Mission> }
  | { readonly kind: "delete"; readonly promise: Promise<void> };

interface ActiveMissionExecution {
  readonly handle: MutableExecution & { readonly result: Promise<unknown> };
  readonly settlement: Promise<void>;
}

interface LiveMissionChat {
  readonly executionId: string;
  readonly entries: MissionChatEntry[];
  close: () => Promise<void>;
  sequence: number;
}

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
  const active = new Map<string, ActiveMissionExecution>();
  const sessions = new Map<string, ExpertSession>();
  const pendingOperations = new Map<string, PendingMissionOperation>();
  const chatListeners = new Set<(update: MissionChatUpdate) => void>();
  const chatRevisions = new Map<string, number>();
  const chatTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const liveChats = new Map<string, LiveMissionChat>();
  const historyCache = new Map<
    string,
    { readonly signature: string; readonly entries: MissionChatEntry[] }
  >();
  const executorNameCache = new Map<string, ReadonlyMap<string, string>>();

  const trackOperation = (id: string, operation: PendingMissionOperation): void => {
    pendingOperations.set(id, operation);
    const clear = () => {
      if (pendingOperations.get(id) === operation) pendingOperations.delete(id);
    };
    void operation.promise.then(clear, clear);
  };

  const emitChatUpdate = (id: string): void => {
    const revision = (chatRevisions.get(id) ?? 0) + 1;
    chatRevisions.set(id, revision);
    const update = { missionId: id, revision } satisfies MissionChatUpdate;
    for (const listener of chatListeners) {
      try {
        listener(update);
      } catch (error) {
        console.error(`Failed to notify Mission chat listeners for ${id}.`, error);
      }
    }
  };

  const scheduleChatUpdate = (id: string, immediate = false): void => {
    const timer = chatTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    if (immediate) {
      chatTimers.delete(id);
      emitChatUpdate(id);
      return;
    }
    const next = setTimeout(() => {
      chatTimers.delete(id);
      emitChatUpdate(id);
    }, 50);
    next.unref();
    chatTimers.set(id, next);
  };

  const forgetActive = async (id: string, executionId: string): Promise<void> => {
    if (active.get(id)?.handle.executionId === executionId) active.delete(id);
    const live = liveChats.get(id);
    if (live?.executionId === executionId) {
      await live.close();
      liveChats.delete(id);
    }
    scheduleChatUpdate(id, true);
  };

  const trackExecution = (input: {
    readonly missionId: string;
    readonly handle: MutableExecution & { readonly result: Promise<unknown> };
    readonly startedAt: string;
    readonly sessionId?: string | undefined;
    readonly onFinished?: (() => void | Promise<void>) | undefined;
    readonly onSucceeded?: ((result: unknown) => void | Promise<void>) | undefined;
  }): void => {
    const live = observeMissionChat(input.handle, () => scheduleChatUpdate(input.missionId));
    liveChats.set(input.missionId, live);
    const settlement = observeExecution(
      options.missions,
      input.missionId,
      input.handle,
      input.startedAt,
      input.onFinished ?? (() => undefined),
      input.sessionId,
      input.onSucceeded,
    ).finally(async () => await forgetActive(input.missionId, input.handle.executionId));
    active.set(input.missionId, { handle: input.handle, settlement });
    scheduleChatUpdate(input.missionId, true);
    void settlement.catch((error: unknown) => {
      console.error(`Failed to observe Mission execution ${input.handle.executionId}.`, error);
    });
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
      trackExecution({
        missionId: mission.id,
        handle,
        startedAt,
        onSucceeded: async (result) => {
          await appendExecutionReply(options.missions, mission.id, handle, result);
        },
      });
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
    trackExecution({
      missionId: mission.id,
      handle: turn,
      startedAt,
      sessionId: session.sessionId,
      onFinished: async () => await waitForExpertTurnSettlement(session, turn.requestId),
      onSucceeded: async (result) => {
        await appendExecutionReply(options.missions, mission.id, turn, result);
      },
    });
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
    trackExecution({
      missionId: mission.id,
      handle: turn,
      startedAt,
      sessionId: session.sessionId,
      onFinished: async () => await waitForExpertTurnSettlement(session, turn.requestId),
      onSucceeded: async (result) => {
        await appendExecutionReply(options.missions, mission.id, turn, result);
      },
    });
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

  const getChatSnapshot = async (id: string): Promise<MissionChatSnapshot> => {
    const mission = await options.missions.get(id);
    const signature = JSON.stringify(mission.messages);
    let cached = historyCache.get(id);
    if (cached?.signature !== signature) {
      cached = {
        signature,
        entries: await readMissionChatHistory(mission, executionStore),
      };
      historyCache.set(id, cached);
    }

    const currentLive = liveChats.get(id);
    const entries = [...cached.entries];
    if (
      currentLive !== undefined &&
      !mission.messages.some(
        (message) =>
          message.role === "assistant" && message.executionId === currentLive.executionId,
      )
    ) {
      entries.push(...currentLive.entries);
    }

    const projectKey = `${mission.project.id}:${mission.project.revision}`;
    let names = executorNameCache.get(projectKey);
    if (names === undefined) {
      const project = await options.project.openRevision(mission.project.revision);
      names = new Map(
        project.listResources().map((resource) => [resource.metadata.id, resource.metadata.name]),
      );
      executorNameCache.set(projectKey, names);
    }
    const namedEntries = entries.map((entry) => {
      if (entry.executorName !== undefined || entry.executorId === undefined) return entry;
      return {
        ...entry,
        executorName: names.get(entry.executorId) ?? entry.executorId,
      };
    });
    const current = active.get(id);
    const pendingInteractions =
      current === undefined ? [] : await listPendingHumanInteractions(current.handle);

    return {
      missionId: mission.id,
      revision: chatRevisions.get(id) ?? 0,
      entries: namedEntries,
      pendingInteractions,
      ...(mission.execution === undefined
        ? {}
        : {
            execution: {
              id: mission.execution.id,
              status: mission.execution.status,
              interruptible:
                current?.handle.executionId === mission.execution.id &&
                ["queued", "running", "waiting"].includes(mission.execution.status),
              ...(mission.execution.error === undefined ? {} : { error: mission.execution.error }),
            },
          }),
    };
  };

  const interruptMission = async (id: string): Promise<Mission> => {
    const mission = await options.missions.get(id);
    const current = active.get(id);
    if (current === undefined || current.handle.executionId !== mission.execution?.id) {
      if (
        mission.execution === undefined ||
        !["queued", "running", "waiting"].includes(mission.execution.status)
      ) {
        return mission;
      }
      throw new Error("Resume this execution before interrupting it.");
    }
    await current.handle.cancel("Interrupted by user.");
    await current.settlement;
    return await options.missions.get(id);
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
    async getChat(id) {
      return await getChatSnapshot(id);
    },
    subscribeChat(listener) {
      chatListeners.add(listener);
      return () => chatListeners.delete(listener);
    },
    async interrupt(id) {
      const pending = pendingOperations.get(id);
      if (pending?.kind === "interrupt") return await pending.promise;
      if (pending !== undefined) {
        throw new Error("Wait for the current mission operation to finish.");
      }
      const interrupting = interruptMission(id);
      trackOperation(id, { kind: "interrupt", promise: interrupting });
      return await interrupting;
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
      const chatTimer = chatTimers.get(id);
      if (chatTimer !== undefined) clearTimeout(chatTimer);
      chatTimers.delete(id);
      const liveChat = liveChats.get(id);
      if (liveChat !== undefined) await liveChat.close();
      liveChats.delete(id);
      const deleting = deleteMission(id);
      trackOperation(id, { kind: "delete", promise: deleting });
      await deleting;
      historyCache.delete(id);
      chatRevisions.delete(id);
    },
    async listHumanInteractions(id) {
      const execution = active.get(id);
      if (execution === undefined) return [];
      return await listPendingHumanInteractions(execution.handle);
    },
    async respondToHumanInteraction(input) {
      const execution = active.get(input.missionId);
      if (execution === undefined) {
        throw new Error("This human interaction is not active in the current Desktop process.");
      }
      const request = await findHumanRequest(execution.handle, input.interactionId);
      await execution.handle.respondToHumanInteraction(
        input.interactionId,
        toExpertHumanResponse(request, input.response),
        {
          requestId: input.requestId,
        },
      );
      scheduleChatUpdate(input.missionId, true);
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
): Promise<void> {
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
  return (async () => {
    let status: "succeeded" | "failed" | "cancelled" = "succeeded";
    let failure: unknown;
    let result: unknown;
    try {
      result = await execution.result;
    } catch (error) {
      const state = await execution.getState().catch(() => undefined);
      status =
        state?.status === "cancelled" || state?.status === "interrupted" ? "cancelled" : "failed";
      failure = error;
    }
    if (status === "succeeded") {
      try {
        await onSucceeded?.(result);
      } catch (error) {
        console.error(`Failed to persist Mission reply for ${execution.executionId}.`, error);
      }
    }
    try {
      await onFinished();
    } catch (error) {
      console.error(`Failed to finish Mission execution ${execution.executionId}.`, error);
    }
    if (status !== "succeeded") {
      try {
        await appendTerminalExecutionReply(missions, missionId, execution, status, failure);
      } catch (error) {
        console.error(`Failed to persist Mission outcome for ${execution.executionId}.`, error);
      }
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
  })().finally(() => clearInterval(probe));
}

async function appendExecutionReply(
  missions: MissionStore,
  missionId: string,
  execution: Pick<MutableExecution, "executionId" | "getMessageHistory">,
  result: unknown,
): Promise<void> {
  const histories = await execution.getMessageHistory({ scope: { kind: "root" } }).catch(() => []);
  const assistantText = latestAssistantText(histories.flatMap((history) => history.messages));
  const content = formatValue(assistantText ?? result, 200_000).trim();
  await missions.appendMessage(missionId, {
    id: execution.executionId,
    role: "assistant",
    content: content === "" ? "Execution completed without a text result." : content,
    createdAt: new Date().toISOString(),
    executionId: execution.executionId,
  });
}

async function appendTerminalExecutionReply(
  missions: MissionStore,
  missionId: string,
  execution: Pick<MutableExecution, "executionId" | "getMessageHistory">,
  status: "failed" | "cancelled",
  failure: unknown,
): Promise<void> {
  const histories = await execution.getMessageHistory({ scope: { kind: "root" } }).catch(() => []);
  const assistantText = latestAssistantText(histories.flatMap((history) => history.messages));
  const failureMessage = failure instanceof Error ? failure.message : String(failure ?? "");
  const fallback =
    status === "cancelled"
      ? "Execution interrupted."
      : failureMessage.trim() === ""
        ? "Execution failed."
        : `Execution failed: ${failureMessage}`;
  await missions.appendMessage(missionId, {
    id: execution.executionId,
    role: "assistant",
    content: truncate(assistantText?.trim() || fallback, 200_000),
    createdAt: new Date().toISOString(),
    executionId: execution.executionId,
  });
}

function latestAssistantText(records: readonly AgentMessageRecord[]): string | undefined {
  return records
    .map((record) => record.message)
    .filter((message) => message.role === "assistant")
    .map((message) =>
      message.content
        .flatMap((content) => (content.type === "text" ? [content.text] : []))
        .join("\n"),
    )
    .filter((content) => content.trim() !== "")
    .at(-1);
}

async function readMissionChatHistory(
  mission: Mission,
  executionStore: ReturnType<typeof createFileExecutionStore>,
): Promise<MissionChatEntry[]> {
  const entries: MissionChatEntry[] = [];
  for (const message of mission.messages) {
    if (message.role === "user") {
      entries.push({
        id: message.id,
        kind: "user",
        content: message.content,
        createdAt: message.createdAt,
        ...(message.executionId === undefined ? {} : { executionId: message.executionId }),
      });
      continue;
    }

    let richEntries: MissionChatEntry[] = [];
    if (message.executionId !== undefined) {
      const view = new StoredExecutionView(message.executionId, executionStore);
      const histories = await view.getMessageHistory({ scope: { kind: "all" } }).catch(() => []);
      richEntries = finalizeHistoricalChatEntries(
        messageRecordsToChatEntries(histories.flatMap((history) => history.messages)),
      );
    }
    if (richEntries.length > 0) {
      entries.push(...richEntries);
    } else {
      entries.push({
        id: message.id,
        kind: "assistant",
        content: message.content,
        streaming: false,
        createdAt: message.createdAt,
        ...(message.executionId === undefined ? {} : { executionId: message.executionId }),
      });
    }
  }
  return entries;
}

function finalizeHistoricalChatEntries(entries: readonly MissionChatEntry[]): MissionChatEntry[] {
  return entries.map((entry) =>
    entry.kind === "tool" && entry.status === "running"
      ? {
          ...entry,
          status: "failed",
          error: entry.error ?? "Execution ended before this tool completed.",
        }
      : entry,
  );
}

function messageRecordsToChatEntries(records: readonly AgentMessageRecord[]): MissionChatEntry[] {
  const entries: MissionChatEntry[] = [];
  for (const record of [...records].sort((left, right) => left.sequence - right.sequence)) {
    const base = {
      executionId: record.executionId,
      invocationId: record.invocationId,
      ...(record.executorId === undefined ? {} : { executorId: record.executorId }),
      createdAt: new Date(record.message.timestamp).toISOString(),
    };
    if (record.message.role === "assistant") {
      record.message.content.forEach((content, index) => {
        if (content.type === "thinking" && content.thinking !== "") {
          entries.push({
            ...base,
            id: `${record.executionId}:${record.invocationId}:${record.sequence}:${index}`,
            kind: "thinking",
            content: truncate(content.thinking, 200_000),
            streaming: false,
          });
        } else if (content.type === "text" && content.text !== "") {
          entries.push({
            ...base,
            id: `${record.executionId}:${record.invocationId}:${record.sequence}:${index}`,
            kind: "assistant",
            content: truncate(content.text, 200_000),
            streaming: false,
          });
        } else if (content.type === "toolCall") {
          entries.push({
            ...base,
            id: `tool:${record.executionId}:${content.id}`,
            kind: "tool",
            toolCallId: content.id,
            toolName: content.name,
            status: "running",
            inputPreview: preview(content.arguments),
          });
        }
      });
      continue;
    }
    if (record.message.role !== "toolResult") continue;
    const message = record.message;
    const existingIndex = entries.findIndex(
      (entry) =>
        entry.kind === "tool" &&
        entry.executionId === record.executionId &&
        entry.toolCallId === message.toolCallId,
    );
    const outputPreview = preview(
      message.content
        .flatMap((content) => (content.type === "text" ? [content.text] : []))
        .join("\n"),
    );
    const tool: MissionChatEntry = {
      ...base,
      id: `tool:${record.executionId}:${message.toolCallId}`,
      kind: "tool",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      status: message.isError ? "failed" : "succeeded",
      ...(message.isError
        ? { error: outputPreview ?? "Tool failed." }
        : outputPreview === undefined
          ? {}
          : { outputPreview }),
    };
    const existing = entries[existingIndex];
    if (existingIndex === -1 || existing?.kind !== "tool") entries.push(tool);
    else entries[existingIndex] = { ...existing, ...tool };
  }
  return entries;
}

function observeMissionChat(
  execution: MutableExecution & { readonly result: Promise<unknown> },
  onChange: () => void,
): LiveMissionChat {
  const chat: LiveMissionChat = {
    executionId: execution.executionId,
    entries: [],
    sequence: 0,
    close: async () => undefined,
  };
  let closed = false;
  const outputSubscription = execution.subscribeOutput({ scope: { kind: "all" } });
  const eventSubscription = execution.subscribeEvents({ scope: { kind: "all" } });
  const outputTask = outputSubscription
    .then(async (subscription) => {
      try {
        for await (const item of subscription) {
          if (closed) break;
          consumeLiveChatOutput(chat, item);
          onChange();
        }
      } finally {
        await subscription.close();
      }
    })
    .catch(() => undefined);
  const eventTask = eventSubscription
    .then(async (subscription) => {
      try {
        for await (const event of subscription) {
          if (closed) break;
          if (
            event.type === "human.requested" ||
            event.type === "human.responded" ||
            event.type.startsWith("execution.")
          ) {
            onChange();
          }
        }
      } finally {
        await subscription.close();
      }
    })
    .catch(() => undefined);
  chat.close = async () => {
    if (closed) return;
    closed = true;
    const subscriptions = await Promise.allSettled([outputSubscription, eventSubscription]);
    await Promise.allSettled(
      subscriptions.flatMap((subscription) =>
        subscription.status === "fulfilled" ? [subscription.value.close()] : [],
      ),
    );
    await Promise.allSettled([outputTask, eventTask]);
  };
  return chat;
}

function consumeLiveChatOutput(chat: LiveMissionChat, item: ExecutionOutputItem): void {
  const base = {
    executionId: item.executionId,
    invocationId: item.invocationId,
    ...(item.executorId === undefined ? {} : { executorId: item.executorId }),
    createdAt: item.occurredAt,
  };
  if (item.channel === "thought") {
    const content = item.delta ?? formatValue(item.value, 200_000);
    if (content === "") return;
    const current = chat.entries.at(-1);
    if (current?.kind === "thinking" && current.invocationId === item.invocationId) {
      current.content = truncate(current.content + content, 200_000);
      current.streaming = true;
    } else {
      chat.entries.push({
        ...base,
        id: `${item.executionId}:${item.invocationId}:thinking:${chat.sequence++}`,
        kind: "thinking",
        content: truncate(content, 200_000),
        streaming: true,
      });
    }
    return;
  }
  if (item.channel === "message") {
    const content = item.delta ?? completedMessageText(item.value);
    if (content === "") return;
    markInvocationThinkingComplete(chat.entries, item.invocationId);
    const current = chat.entries.at(-1);
    if (
      item.delta !== undefined &&
      current?.kind === "assistant" &&
      current.invocationId === item.invocationId
    ) {
      current.content = truncate(current.content + content, 200_000);
      current.streaming = true;
    } else if (
      item.delta === undefined &&
      chat.entries.some(
        (entry) => entry.kind === "assistant" && entry.invocationId === item.invocationId,
      )
    ) {
      const last = [...chat.entries]
        .reverse()
        .find((entry) => entry.kind === "assistant" && entry.invocationId === item.invocationId);
      if (last?.kind === "assistant") last.streaming = false;
    } else {
      chat.entries.push({
        ...base,
        id: `${item.executionId}:${item.invocationId}:answer:${chat.sequence++}`,
        kind: "assistant",
        content: truncate(content, 200_000),
        streaming: item.delta !== undefined,
      });
    }
    return;
  }
  if (item.channel === "tool") {
    const payload = asRecord(item.value);
    if (item.delta !== undefined) {
      const tool = [...chat.entries]
        .reverse()
        .find(
          (entry) =>
            entry.kind === "tool" &&
            entry.invocationId === item.invocationId &&
            entry.status === "running",
        );
      if (tool?.kind === "tool") {
        tool.outputPreview = preview(
          `${tool.outputPreview ?? ""}${normalizeToolDelta(item.delta)}`,
        );
      }
      return;
    }
    const toolCallId = readString(payload, "toolCallId") || item.sourceEventId;
    const existing = chat.entries.find(
      (entry) => entry.kind === "tool" && entry.toolCallId === toolCallId,
    );
    const toolName = readString(payload, "toolName") || "tool";
    if (existing?.kind === "tool") {
      if (payload["message"] !== undefined) {
        existing.status = "failed";
        existing.error = readString(payload, "message") || "Tool failed.";
      } else if (payload["approvalId"] !== undefined) {
        existing.status = "approval_required";
      } else if (payload["outputPreview"] !== undefined) {
        existing.status = "succeeded";
        existing.outputPreview = preview(payload["outputPreview"]);
      }
      return;
    }
    markInvocationThinkingComplete(chat.entries, item.invocationId);
    chat.entries.push({
      ...base,
      id: `tool:${item.executionId}:${toolCallId}`,
      kind: "tool",
      toolCallId,
      toolName,
      status:
        payload["message"] !== undefined
          ? "failed"
          : payload["approvalId"] !== undefined
            ? "approval_required"
            : payload["outputPreview"] !== undefined
              ? "succeeded"
              : "running",
      ...(payload["inputPreview"] === undefined
        ? {}
        : { inputPreview: preview(payload["inputPreview"]) }),
      ...(payload["outputPreview"] === undefined
        ? {}
        : { outputPreview: preview(payload["outputPreview"]) }),
      ...(payload["message"] === undefined
        ? {}
        : { error: readString(payload, "message") || "Tool failed." }),
    });
    return;
  }
  if (item.channel === "result") {
    const content = formatValue(item.value, 200_000);
    if (
      content !== "" &&
      !chat.entries.some(
        (entry) => entry.kind === "assistant" && entry.invocationId === item.invocationId,
      )
    ) {
      chat.entries.push({
        ...base,
        id: `${item.executionId}:${item.invocationId}:result:${chat.sequence++}`,
        kind: "assistant",
        content,
        streaming: false,
      });
    }
  }
}

async function listPendingHumanInteractions(
  execution: Pick<MutableExecution, "listEvents">,
): Promise<MissionHumanInteraction[]> {
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
    return request.success ? [{ interactionId, request: toDesktopHumanRequest(request.data) }] : [];
  });
}

function completedMessageText(value: unknown): string {
  if (typeof value === "string") return value;
  const content = asRecord(value)["content"];
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => {
      const record = asRecord(item);
      return record["type"] === "text" ? [readString(record, "text")] : [];
    })
    .join("");
}

function normalizeToolDelta(delta: string): string {
  try {
    const parsed = JSON.parse(delta) as unknown;
    const content = asRecord(parsed)["content"];
    if (!Array.isArray(content)) return formatValue(parsed, 800);
    return content.map((item) => readString(asRecord(item), "text")).join("\n");
  } catch {
    return delta;
  }
}

function markInvocationThinkingComplete(entries: MissionChatEntry[], invocationId: string): void {
  for (const entry of entries) {
    if (entry.kind === "thinking" && entry.invocationId === invocationId) entry.streaming = false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function preview(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const formatted = formatValue(value, 801);
  return formatted === "" ? undefined : formatted;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1).trimEnd()}…`;
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
