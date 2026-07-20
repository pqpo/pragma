import { createHash, randomUUID } from "node:crypto";

import {
  createPragma,
  createFileExecutionStore,
  ExpertAgentHumanRequestSchema,
  StoredExecutionView,
  type AgentMessageRecord,
  type ExecutionOutputItem,
  type ExpertAgentAutomaticHumanInteractionHandler,
  type ExpertAgentHumanRequest,
  type ExpertAgentHumanResponse,
  type ExpertSession,
  type MutableExecution,
  type RuntimeResolver,
  type RuntimeModelSelection,
} from "@pragma/core";
import type {
  InvocableResource,
  CompiledResource,
  PragmaAdapterHost,
  PragmaBindingRecord,
} from "@pragma/interpreter";
import type {
  HumanInteractionRequest,
  HumanInteractionResponse,
  InvocationTree,
} from "@pragma/shared";

import type {
  Mission,
  MissionChatEntry,
  MissionChatSnapshot,
  MissionChatUpdate,
  MissionChatQuery,
  MissionHumanInteraction,
  MissionModelOverride,
  MissionWorkItem,
  DesktopToolPermissionMode,
  UpdateMissionOptions,
} from "../shared/desktop-api.ts";
import type { CapabilityCredentialStore } from "./capability-credential-store.ts";
import type { CapabilityStore } from "./capability-store.ts";
import { resolveExpertCapabilities } from "./desktop-expert-factory.ts";
import type { ContextStoreStore } from "./context-store-store.ts";
import {
  parseDesktopCapabilityBindingRef,
  parseDesktopContextBindingRef,
} from "./desktop-binding-ref.ts";
import type { MissionStore, MissionTimelineTurn } from "./mission-store.ts";
import type { PragmaProjectStore } from "./pragma-project-store.ts";
import type { PluginStore } from "./plugin-store.ts";

export interface MissionRunner {
  run(id: string): Promise<Mission>;
  updateOptions(input: UpdateMissionOptions): Promise<Mission>;
  sendMessage(input: {
    readonly id: string;
    readonly content: string;
    readonly requestId: string;
  }): Promise<Mission>;
  getChat(input: MissionChatQuery): Promise<MissionChatSnapshot>;
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
  | { readonly kind: "options"; readonly promise: Promise<Mission> }
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
  readonly contextStores?: ContextStoreStore | undefined;
  readonly plugins?: PluginStore | undefined;
  readonly runtimes: RuntimeResolver;
  readonly runtimesForToolPermissionMode?:
    | ((mode: DesktopToolPermissionMode) => RuntimeResolver)
    | undefined;
  readonly automaticHumanInteractionHandler?:
    | ExpertAgentAutomaticHumanInteractionHandler
    | undefined;
  readonly automaticHumanInteractionHandlerForToolPermissionMode?:
    | ((mode: DesktopToolPermissionMode) => ExpertAgentAutomaticHumanInteractionHandler)
    | undefined;
  readonly compileSystemExecutor?:
    | ((input: {
        readonly mission: Mission;
        readonly runtimes: RuntimeResolver;
      }) => Promise<CompiledResource<InvocableResource> | undefined>)
    | undefined;
}): MissionRunner {
  const executionStore = createFileExecutionStore({ pragmaHome: options.pragmaHome });
  const executionContexts = new Map<
    DesktopToolPermissionMode,
    { readonly app: ReturnType<typeof createPragma>; readonly runtimes: RuntimeResolver }
  >();
  const executionContext = (mode: DesktopToolPermissionMode) => {
    const existing = executionContexts.get(mode);
    if (existing !== undefined) return existing;
    const runtimes = options.runtimesForToolPermissionMode?.(mode) ?? options.runtimes;
    const context = {
      runtimes,
      app: createPragma({
        pragmaHome: options.pragmaHome,
        runtimes,
        executionStore,
        automaticHumanInteractionHandler:
          options.automaticHumanInteractionHandlerForToolPermissionMode?.(mode) ??
          options.automaticHumanInteractionHandler,
      }),
    };
    executionContexts.set(mode, context);
    return context;
  };
  const active = new Map<string, ActiveMissionExecution>();
  const sessions = new Map<string, ExpertSession>();
  const pendingOperations = new Map<string, PendingMissionOperation>();
  const chatListeners = new Set<(update: MissionChatUpdate) => void>();
  const chatRevisions = new Map<string, number>();
  const chatTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const liveChats = new Map<string, LiveMissionChat>();
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

  const compileMissionExecutor = async (
    mission: Mission,
    runtimes: RuntimeResolver,
  ): Promise<CompiledResource<InvocableResource>> => {
    const system = await options.compileSystemExecutor?.({ mission, runtimes });
    if (system !== undefined) return system;
    return await options.project.service.compile<InvocableResource>({
      projectId: mission.project.id,
      revision: mission.project.revision,
      ref: mission.executor.ref,
      workspace: mission.workspace.path,
      environmentId: "desktop",
      adapterHost: createDesktopAdapterHost(options, mission.workspace.path),
      runtimes,
      ...(mission.modelOverride === undefined
        ? {}
        : {
            rootModelSelectionOverride: toRuntimeModelSelection(mission.modelOverride),
          }),
      ...(options.plugins === undefined
        ? {}
        : {
            plugins: {
              inspect: async ({ binding }) =>
                await options.plugins!.inspect({
                  ref: binding.ref,
                  config: binding.config,
                  secretBindings: binding.secretBindings,
                }),
              resolve: async ({ binding }) =>
                await options.plugins!.resolve({
                  ref: binding.ref,
                  config: binding.config,
                  secretBindings: binding.secretBindings,
                }),
            },
          }),
    });
  };

  const trackExecution = (input: {
    readonly missionId: string;
    readonly handle: MutableExecution & { readonly result: Promise<unknown> };
    readonly startedAt: string;
    readonly inputMessageId: string;
    readonly environmentFingerprint: string;
    readonly sessionId?: string | undefined;
    readonly onFinished?: (() => void | Promise<void>) | undefined;
  }): void => {
    const live = observeMissionChat(input.handle, () => scheduleChatUpdate(input.missionId));
    liveChats.set(input.missionId, live);
    const settlement = observeExecution(
      options.missions,
      input.missionId,
      input.handle,
      input.startedAt,
      input.inputMessageId,
      input.environmentFingerprint,
      input.onFinished ?? (() => undefined),
      input.sessionId,
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
    const { app, runtimes } = executionContext(mission.toolPermissionMode);
    const compiled = await compileMissionExecutor(mission, runtimes);
    const modelSelection = toRuntimeModelSelection(mission.modelOverride);
    if (mission.modelOverride !== undefined) {
      await runtimes.bind({
        runtimeId: requireRootRuntimeId(compiled),
        modelSelection,
      });
    }
    const environmentFingerprint = missionExecutionFingerprint(
      compiled.environmentFingerprint.value,
      mission.modelOverride,
    );
    assertRecoverableEnvironment(mission, environmentFingerprint);
    const startedAt = new Date().toISOString();

    if ("kind" in compiled.value && compiled.value.kind === "flow") {
      const runtime = compiled.rootRuntimeId;
      const recoverable =
        mission.execution !== undefined &&
        ["queued", "running", "waiting"].includes(mission.execution.status);
      const inputMessageId = recoverable
        ? mission.execution!.inputMessageId
        : mission.execution === undefined
          ? mission.initialMessageId
          : randomUUID();
      if (!recoverable && mission.execution !== undefined) {
        await options.missions.appendUserMessage(mission.id, {
          id: inputMessageId,
          content: mission.goal,
          createdAt: startedAt,
        });
      }
      const executionStartedAt = recoverable ? mission.execution!.startedAt : startedAt;
      if (recoverable) {
        // Verify the durable Mission link before recover() starts the Flow again. Recovery keeps the
        // same Execution id, so the original timestamp makes this append idempotent.
        await options.missions.appendExecutionReference({
          missionId: mission.id,
          inputMessageId,
          executionId: mission.execution!.id,
          createdAt: executionStartedAt,
        });
      }
      const handle = recoverable
        ? await app.flows.recover(compiled.value, {
            executionId: mission.execution!.id,
            runtime,
          })
        : await app.flows.start(compiled.value, {
            input: { goal: mission.goal, workspace: mission.workspace.path },
            runtime,
          });
      if (!recoverable) {
        await options.missions.appendExecutionReference({
          missionId: mission.id,
          inputMessageId,
          executionId: handle.executionId,
          createdAt: executionStartedAt,
        });
      }
      const running = await options.missions.updateExecution(mission.id, {
        id: handle.executionId,
        inputMessageId,
        environmentFingerprint,
        status: "running",
        startedAt: executionStartedAt,
      });
      trackExecution({
        missionId: mission.id,
        handle,
        startedAt: executionStartedAt,
        inputMessageId,
        environmentFingerprint,
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
            runtime: compiled.rootRuntimeId,
            ...(modelSelection === undefined ? {} : { modelSelection }),
          }));
    sessions.set(mission.id, session);
    const inputMessageId = recoverable
      ? mission.execution!.inputMessageId
      : mission.initialMessageId;
    const turn = await session.prompt(
      recoverable
        ? [
            "[Pragma mission recovery]",
            "The previous Desktop process ended before this mission finished.",
            "Continue the pinned mission from the restored ExpertSession context.",
            `Mission goal: ${mission.goal}`,
          ].join("\n")
        : mission.goal,
      {
        requestId: recoverable ? randomUUID() : inputMessageId,
        ...(modelSelection === undefined ? {} : { modelSelection }),
      },
    );
    await options.missions.appendExecutionReference({
      missionId: mission.id,
      inputMessageId,
      executionId: turn.executionId,
      createdAt: startedAt,
    });
    const running = await options.missions.updateExecution(mission.id, {
      id: turn.executionId,
      inputMessageId,
      sessionId: session.sessionId,
      environmentFingerprint,
      status: "running",
      startedAt,
    });
    trackExecution({
      missionId: mission.id,
      handle: turn,
      startedAt,
      inputMessageId,
      environmentFingerprint,
      sessionId: session.sessionId,
      onFinished: async () => await waitForExpertTurnSettlement(session, turn.requestId),
    });
    return running;
  };

  const sendMissionMessage = async (input: {
    readonly id: string;
    readonly content: string;
    readonly requestId: string;
  }): Promise<Mission> => {
    const mission = await options.missions.get(input.id);
    const { app, runtimes } = executionContext(mission.toolPermissionMode);
    if (mission.executor.kind === "flow") {
      throw new Error("Flow missions accept input through workflow steps, not chat messages.");
    }
    if (mission.lifecycleStatus !== "active") {
      throw new Error("Reopen this mission before sending another message.");
    }
    if (active.has(mission.id)) {
      throw new Error("Wait for the current expert turn before sending another message.");
    }
    const compiled = await compileMissionExecutor(mission, runtimes);
    const modelSelection = toRuntimeModelSelection(mission.modelOverride);
    if (mission.modelOverride !== undefined) {
      await runtimes.bind({
        runtimeId: requireRootRuntimeId(compiled),
        modelSelection,
      });
    }
    const environmentFingerprint = missionExecutionFingerprint(
      compiled.environmentFingerprint.value,
      mission.modelOverride,
    );
    assertRecoverableEnvironment(mission, environmentFingerprint);
    if ("kind" in compiled.value && compiled.value.kind === "flow") {
      throw new Error("Flow missions cannot receive chat messages.");
    }
    const session =
      sessions.get(mission.id) ??
      (mission.execution?.sessionId === undefined
        ? await app.experts.createSession(compiled.value, {
            runtime: compiled.rootRuntimeId,
            ...(modelSelection === undefined ? {} : { modelSelection }),
          })
        : await app.experts.resumeSession(compiled.value, {
            sessionId: mission.execution.sessionId,
          }));
    sessions.set(mission.id, session);
    await options.missions.appendUserMessage(mission.id, {
      id: input.requestId,
      content: input.content,
      createdAt: new Date().toISOString(),
    });
    const turn = await session.prompt(input.content, {
      requestId: input.requestId,
      ...(modelSelection === undefined ? {} : { modelSelection }),
    });
    const startedAt = new Date().toISOString();
    await options.missions.appendExecutionReference({
      missionId: mission.id,
      inputMessageId: input.requestId,
      executionId: turn.executionId,
      createdAt: startedAt,
    });
    const running = await options.missions.updateExecution(mission.id, {
      id: turn.executionId,
      inputMessageId: input.requestId,
      sessionId: session.sessionId,
      environmentFingerprint,
      status: "running",
      startedAt,
    });
    trackExecution({
      missionId: mission.id,
      handle: turn,
      startedAt,
      inputMessageId: input.requestId,
      environmentFingerprint,
      sessionId: session.sessionId,
      onFinished: async () => await waitForExpertTurnSettlement(session, turn.requestId),
    });
    return running;
  };

  const updateMissionOptions = async (input: UpdateMissionOptions): Promise<Mission> => {
    const mission = await options.missions.get(input.id);
    if (
      active.has(mission.id) ||
      (mission.execution !== undefined &&
        ["queued", "running", "waiting"].includes(mission.execution.status))
    ) {
      throw new Error("Wait for the current execution before changing mission options.");
    }
    if (mission.executor.kind === "flow" && input.modelOverride !== null) {
      throw new Error("Flow missions do not support a model override.");
    }
    const prospective = { ...mission, toolPermissionMode: input.toolPermissionMode };
    if (input.modelOverride === null) delete prospective.modelOverride;
    else prospective.modelOverride = input.modelOverride;
    const { runtimes } = executionContext(input.toolPermissionMode);
    const compiled = await compileMissionExecutor(prospective, runtimes);
    const environmentFingerprint = missionExecutionFingerprint(
      compiled.environmentFingerprint.value,
      prospective.modelOverride,
    );
    return await options.missions.updateOptions(mission.id, {
      toolPermissionMode: input.toolPermissionMode,
      ...(prospective.modelOverride === undefined
        ? {}
        : { modelOverride: prospective.modelOverride }),
      environmentFingerprint,
    });
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

  const getChatSnapshot = async (input: MissionChatQuery): Promise<MissionChatSnapshot> => {
    const mission = await options.missions.get(input.id);
    const timeline = await options.missions.readTimelinePage(mission.id, input);
    const currentLive = liveChats.get(mission.id);
    const entries = await readMissionChatHistory(
      timeline.turns,
      executionStore,
      currentLive?.executionId,
    );
    if (input.beforeSequence === undefined && currentLive !== undefined) {
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
    const current = active.get(mission.id);
    const pendingInteractions =
      current === undefined ? [] : await listPendingHumanInteractions(current.handle);

    return {
      missionId: mission.id,
      revision: chatRevisions.get(mission.id) ?? 0,
      entries: namedEntries,
      page: {
        ...(timeline.oldestSequence === undefined
          ? {}
          : { oldestSequence: timeline.oldestSequence }),
        ...(timeline.newestSequence === undefined
          ? {}
          : { newestSequence: timeline.newestSequence }),
        ...(timeline.nextBeforeSequence === undefined
          ? {}
          : { nextBeforeSequence: timeline.nextBeforeSequence }),
      },
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
    async updateOptions(input) {
      if (pendingOperations.has(input.id)) {
        throw new Error("Wait for the current mission operation to finish.");
      }
      const updating = updateMissionOptions(input);
      trackOperation(input.id, { kind: "options", promise: updating });
      return await updating;
    },
    async sendMessage(input) {
      if (pendingOperations.has(input.id)) {
        throw new Error("Wait for the current mission operation to finish.");
      }
      const sending = sendMissionMessage(input);
      trackOperation(input.id, { kind: "message", promise: sending });
      return await sending;
    },
    async getChat(input) {
      return await getChatSnapshot(input);
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

export function createDesktopAdapterHost(
  options: {
    readonly capabilityStore: CapabilityStore;
    readonly capabilityCredentials: CapabilityCredentialStore;
    readonly capabilitiesPath: string;
    readonly contextStores?: ContextStoreStore | undefined;
  },
  projectRoot: string,
): PragmaAdapterHost {
  return {
    environmentId: "desktop",
    projectRoot,
    async resolveBinding(ref): Promise<PragmaBindingRecord | undefined> {
      const capabilityRef = parseDesktopCapabilityBindingRef(ref);
      if (capabilityRef !== undefined) {
        const capabilityId = capabilityRef.id;
        const revision = capabilityRef.revision;
        const capability = await options.capabilityStore.get(capabilityId, revision);
        const toolNames =
          capability.definition.kind === "skill"
            ? []
            : capability.definition.kind === "code_service"
              ? [capability.definition.tool.name]
              : capability.definition.tools.map((tool) => tool.name);
        const contribution = await resolveExpertCapabilities({
          expert: {
            capabilities: [
              capability.definition.kind === "skill"
                ? { kind: "skill", capabilityId, revision }
                : { kind: "tools", capabilityId, revision, toolNames },
            ],
            toolApprovals: {},
          },
          store: options.capabilityStore,
          credentials: options.capabilityCredentials,
          capabilitiesPath: options.capabilitiesPath,
        });
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              id: capabilityId,
              revision,
              definition: capability.definition,
              credentials: await options.capabilityCredentials.fingerprint(capabilityId),
            }),
          )
          .digest("hex");
        return { ref, revision: String(revision), fingerprint, value: { contribution } };
      }

      const contextId = parseDesktopContextBindingRef(ref);
      if (contextId !== undefined) {
        if (options.contextStores === undefined) {
          throw new Error(`Desktop context binding is unavailable: ${contextId}`);
        }
        const context = await options.contextStores.resolve(contextId);
        return {
          ref,
          revision: context.revision,
          fingerprint: context.revision,
          value: { store: context.store },
        };
      }
      return undefined;
    },
    async resolveArtifact(source) {
      throw new Error(
        source.type === "project"
          ? `Project artifact was not resolved by the interpreter: ${source.path}`
          : `Desktop has no external artifact resolver for: ${source.uri}`,
      );
    },
    async resolveSecret() {
      return undefined;
    },
  };
}

function assertRecoverableEnvironment(mission: Mission, fingerprint: string): void {
  if (mission.execution !== undefined && mission.execution.environmentFingerprint !== fingerprint) {
    throw new Error(
      "The Desktop environment changed since this execution started. Start a new mission instead of recovering it.",
    );
  }
}

function toRuntimeModelSelection(
  override: MissionModelOverride | undefined,
): RuntimeModelSelection | undefined {
  return override === undefined
    ? undefined
    : {
        model: { providerId: override.providerId, modelId: override.modelId },
        ...(override.thinkingLevel === undefined ? {} : { thinkingLevel: override.thinkingLevel }),
      };
}

function requireRootRuntimeId(compiled: CompiledResource<InvocableResource>): string {
  if (compiled.rootRuntimeId === undefined) {
    throw new Error("Mission executor did not resolve a root Runtime.");
  }
  return compiled.rootRuntimeId;
}

function missionExecutionFingerprint(
  compiledFingerprint: string,
  override: MissionModelOverride | undefined,
): string {
  if (override === undefined) return compiledFingerprint;
  return createHash("sha256")
    .update(JSON.stringify({ compiledFingerprint, modelOverride: override ?? null }))
    .digest("hex");
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
  inputMessageId: string,
  environmentFingerprint: string,
  onFinished: () => void | Promise<void>,
  sessionId?: string,
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
                inputMessageId,
                ...(sessionId === undefined ? {} : { sessionId }),
                environmentFingerprint,
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
            inputMessageId,
            ...(sessionId === undefined ? {} : { sessionId }),
            environmentFingerprint,
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
    try {
      await execution.result;
    } catch (error) {
      const state = await execution.getState().catch(() => undefined);
      status =
        state?.status === "cancelled" || state?.status === "interrupted" ? "cancelled" : "failed";
      failure = error;
    }
    try {
      await onFinished();
    } catch (error) {
      console.error(`Failed to finish Mission execution ${execution.executionId}.`, error);
    }
    await missions.updateExecution(
      missionId,
      {
        id: execution.executionId,
        inputMessageId,
        ...(sessionId === undefined ? {} : { sessionId }),
        environmentFingerprint,
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

async function readMissionChatHistory(
  turns: readonly MissionTimelineTurn[],
  executionStore: ReturnType<typeof createFileExecutionStore>,
  activeExecutionId?: string,
): Promise<MissionChatEntry[]> {
  const entries: MissionChatEntry[] = [];
  for (const turn of turns) {
    entries.push({
      id: turn.message.id,
      timelineSequence: turn.sequence,
      kind: "user",
      content: turn.message.content,
      createdAt: turn.message.createdAt,
      ...(turn.executionId === undefined ? {} : { executionId: turn.executionId }),
    });
    if (turn.executionId === undefined || turn.executionId === activeExecutionId) continue;

    const view = new StoredExecutionView(turn.executionId, executionStore);
    const state = await view.getState().catch(() => undefined);
    if (state === undefined) {
      entries.push({
        id: `missing:${turn.executionId}`,
        timelineSequence: turn.sequence,
        executionId: turn.executionId,
        kind: "assistant",
        content: "Execution history unavailable.",
        streaming: false,
        createdAt: turn.message.createdAt,
      });
      continue;
    }
    if (["queued", "running", "waiting"].includes(state.status)) continue;

    const histories = await view.getMessageHistory({ scope: { kind: "all" } }).catch(() => []);
    const richEntries = finalizeHistoricalChatEntries(
      messageRecordsToChatEntries(histories.flatMap((history) => history.messages)).map(
        (entry) => ({
          ...entry,
          timelineSequence: turn.sequence,
        }),
      ),
    );
    entries.push(...richEntries);
    if (!richEntries.some((entry) => entry.kind === "assistant")) {
      entries.push({
        id: `result:${turn.executionId}`,
        timelineSequence: turn.sequence,
        executionId: turn.executionId,
        kind: "assistant",
        content: executionFallback(state.status, state.output, state.error),
        streaming: false,
        createdAt: state.updatedAt,
      });
    }
  }
  return entries;
}

function executionFallback(status: string, output: unknown, error: unknown): string {
  if (status === "succeeded") {
    const content = formatValue(output, 200_000).trim();
    return content === "" ? "Execution completed without a text result." : content;
  }
  if (status === "cancelled" || status === "interrupted") return "Execution interrupted.";
  const message = readErrorMessage(error);
  return message === "" ? "Execution failed." : `Execution failed: ${message}`;
}

function readErrorMessage(error: unknown): string {
  if (typeof error === "string") return error.trim();
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message).trim();
  }
  return error === undefined ? "" : String(error).trim();
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
