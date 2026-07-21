import { createHash, randomUUID } from "node:crypto";

import {
  createPragma,
  createFileExecutionStore,
  createFileExpertSessionStore,
  defineExpert,
  ExecutionWorkHistoryReader,
  ExpertAgentHumanRequestSchema,
  isExpertTeam,
  StoredExecutionView,
  type AgentMessageRecord,
  type ExecutionWorkRecord,
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
  ExpertAgentStreamEvent,
  RuntimeContextRecord,
  RuntimeEnvironmentBinding,
} from "@pragma/shared";
import { ExpertAgentStreamEventSchema } from "@pragma/shared";

import type {
  Mission,
  MissionChatEntry,
  MissionChatPatch,
  MissionChatSnapshot,
  MissionChatUpdate,
  MissionChatQuery,
  MissionHumanInteraction,
  MissionModelOverride,
  MissionWorkOutputSnapshot,
  MissionWorkRecord,
  MissionWorkSnapshot,
  MissionWorkUpdate,
  GetMissionWorkOutput,
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
import {
  normalizeMissionTitle,
  type MissionStore,
  type MissionTimelineTurn,
} from "./mission-store.ts";
import type { PragmaProjectStore } from "./pragma-project-store.ts";
import type { PluginStore } from "./plugin-store.ts";

export interface MissionRunner {
  run(id: string): Promise<Mission>;
  summarizeTitle(id: string): Promise<Mission>;
  updateOptions(input: UpdateMissionOptions): Promise<Mission>;
  sendMessage(input: {
    readonly id: string;
    readonly content: string;
    readonly requestId: string;
  }): Promise<Mission>;
  getChat(input: MissionChatQuery): Promise<MissionChatSnapshot>;
  getRuntimeBinding(id: string): Promise<RuntimeEnvironmentBinding | undefined>;
  subscribeChat(listener: (update: MissionChatUpdate) => void): () => void;
  subscribeWork(listener: (update: MissionWorkUpdate) => void): () => void;
  interrupt(id: string): Promise<Mission>;
  getWork(id: string): Promise<MissionWorkSnapshot>;
  getWorkOutput(input: GetMissionWorkOutput): Promise<MissionWorkOutputSnapshot>;
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

interface MissionExecutionContext {
  readonly app: ReturnType<typeof createPragma>;
  readonly runtimes: RuntimeResolver;
  readonly setToolPermissionMode: (mode: DesktopToolPermissionMode) => void;
}

const MISSION_TITLE_SUMMARY_TIMEOUT_MS = 45_000;

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
  const expertSessionStore = createFileExpertSessionStore({
    executions: executionStore,
    pragmaHome: options.pragmaHome,
  });
  const workHistory = new ExecutionWorkHistoryReader(executionStore);
  const runtimeResolverForToolPermissionMode = (mode: DesktopToolPermissionMode) =>
    options.runtimesForToolPermissionMode?.(mode) ?? options.runtimes;
  const automaticHumanInteractionHandlerForToolPermissionMode = (mode: DesktopToolPermissionMode) =>
    options.automaticHumanInteractionHandlerForToolPermissionMode?.(mode) ??
    options.automaticHumanInteractionHandler;
  const executionContexts = new Map<string, MissionExecutionContext>();
  const executionContext = (mission: Pick<Mission, "id" | "toolPermissionMode">) => {
    const existing = executionContexts.get(mission.id);
    if (existing !== undefined) return existing;
    let toolPermissionMode = mission.toolPermissionMode;
    const runtimes: RuntimeResolver = {
      getDefaultRuntimeId: async () =>
        await runtimeResolverForToolPermissionMode(toolPermissionMode).getDefaultRuntimeId(),
      bind: async (request) =>
        await runtimeResolverForToolPermissionMode(toolPermissionMode).bind(request),
      resolve: async (request) =>
        await runtimeResolverForToolPermissionMode(toolPermissionMode).resolve(request),
    };
    const context = {
      runtimes,
      app: createPragma({
        pragmaHome: options.pragmaHome,
        runtimes,
        executionStore,
        expertSessionStore,
        automaticHumanInteractionHandler: async (request) =>
          await automaticHumanInteractionHandlerForToolPermissionMode(toolPermissionMode)?.(
            request,
          ),
      }),
      setToolPermissionMode: (mode: DesktopToolPermissionMode) => {
        toolPermissionMode = mode;
      },
    };
    executionContexts.set(mission.id, context);
    return context;
  };
  const active = new Map<string, ActiveMissionExecution>();
  const sessions = new Map<string, ExpertSession>();
  const pendingOperations = new Map<string, PendingMissionOperation>();
  const chatListeners = new Set<(update: MissionChatUpdate) => void>();
  const chatRevisions = new Map<string, number>();
  const liveChats = new Map<string, LiveMissionChat>();
  const workListeners = new Set<(update: MissionWorkUpdate) => void>();
  const workRevisions = new Map<string, number>();
  const liveWorkOutputs = new Map<string, Map<string, LiveMissionChat>>();
  const executorNameCache = new Map<string, ReadonlyMap<string, string>>();
  const titleExperts = new Map<string, ReturnType<typeof defineExpert>>();

  const getExecutorNames = async (
    mission: Pick<Mission, "project">,
  ): Promise<ReadonlyMap<string, string>> => {
    const projectKey = `${mission.project.id}:${mission.project.revision}`;
    const existing = executorNameCache.get(projectKey);
    if (existing !== undefined) return existing;
    const project = await options.project.openRevision(mission.project.revision);
    const names = new Map(
      project.listResources().map((resource) => [resource.metadata.id, resource.metadata.name]),
    );
    executorNameCache.set(projectKey, names);
    return names;
  };

  const getTitleExpert = (workspace: string) => {
    const existing = titleExperts.get(workspace);
    if (existing !== undefined) return existing;
    const expert = defineExpert({
      id: "pragma-desktop-mission-title",
      name: "Mission title summarizer",
      description: "Creates concise titles for Desktop Missions.",
      instructions: [
        "Create a concise UI title that captures the user's main intent.",
        "Use the same language as the request and preserve important technical identifiers.",
        "Return only the title as plain text, with no quotes, Markdown, or ending punctuation.",
        "Keep Chinese titles within 24 characters and other titles within 48 characters.",
        "Do not use tools or perform the requested work.",
      ].join("\n"),
      tags: ["system", "title"],
      version: "1.0.0",
      scope: "pragma.desktop",
      workspace,
      pragmaHome: options.pragmaHome,
    });
    titleExperts.set(workspace, expert);
    return expert;
  };

  const trackOperation = (id: string, operation: PendingMissionOperation): void => {
    pendingOperations.set(id, operation);
    const clear = () => {
      if (pendingOperations.get(id) === operation) pendingOperations.delete(id);
    };
    void operation.promise.then(clear, clear);
  };

  const emitChatUpdate = (
    id: string,
    update:
      | { readonly kind: "patch"; readonly patches: readonly MissionChatPatch[] }
      | { readonly kind: "invalidate" },
  ): void => {
    const revision = (chatRevisions.get(id) ?? 0) + 1;
    chatRevisions.set(id, revision);
    const notification: MissionChatUpdate =
      update.kind === "patch"
        ? { missionId: id, revision, kind: "patch", patches: [...update.patches] }
        : { missionId: id, revision, kind: "invalidate" };
    for (const listener of chatListeners) {
      try {
        listener(notification);
      } catch (error) {
        console.error(`Failed to notify Mission chat listeners for ${id}.`, error);
      }
    }
  };

  const emitChatPatches = (id: string, patches: readonly MissionChatPatch[]): void => {
    if (patches.length > 0) emitChatUpdate(id, { kind: "patch", patches });
  };

  const invalidateChat = (id: string): void => emitChatUpdate(id, { kind: "invalidate" });

  const invalidateWork = (id: string): void => {
    const revision = (workRevisions.get(id) ?? 0) + 1;
    workRevisions.set(id, revision);
    const update: MissionWorkUpdate = { missionId: id, revision };
    for (const listener of workListeners) {
      try {
        listener(update);
      } catch (error) {
        console.error(`Failed to notify Mission work listeners for ${id}.`, error);
      }
    }
  };

  const forgetActive = async (id: string, executionId: string): Promise<void> => {
    if (active.get(id)?.handle.executionId === executionId) active.delete(id);
    const live = liveChats.get(id);
    if (live?.executionId === executionId) {
      await live.close();
      liveChats.delete(id);
    }
    liveWorkOutputs.delete(id);
    invalidateChat(id);
    invalidateWork(id);
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

  const readMissionRootContext = async (
    mission: Mission,
  ): Promise<RuntimeContextRecord | undefined> => {
    const sessionId = mission.execution?.sessionId;
    if (sessionId === undefined) return undefined;
    const record = await expertSessionStore.get(sessionId);
    return record?.contexts[record.rootContextId];
  };

  const trackExecution = (input: {
    readonly missionId: string;
    readonly handle: MutableExecution & { readonly result: Promise<unknown> };
    readonly startedAt: string;
    readonly inputMessageId: string;
    readonly sessionId?: string | undefined;
    readonly onFinished?: (() => void | Promise<void>) | undefined;
  }): void => {
    const live = observeMissionChat(
      input.handle,
      (patches) => emitChatPatches(input.missionId, patches),
      () => invalidateChat(input.missionId),
      (item) => {
        const sessionId = item.source.sessionId;
        if (item.source.parentSessionId !== undefined && sessionId !== undefined) {
          const recordId = `runtime-agent:${sessionId}`;
          const byRecord = liveWorkOutputs.get(input.missionId) ?? new Map();
          const output =
            byRecord.get(recordId) ??
            ({
              executionId: item.executionId,
              entries: [],
              sequence: 0,
              close: async () => undefined,
            } satisfies LiveMissionChat);
          byRecord.set(recordId, output);
          liveWorkOutputs.set(input.missionId, byRecord);
          if (item.channel !== "agent" && item.channel !== "progress") {
            consumeLiveChatOutput(output, item);
          }
        }
        invalidateWork(input.missionId);
      },
    );
    liveChats.set(input.missionId, live);
    const settlement = observeExecution(
      options.missions,
      input.missionId,
      input.handle,
      input.startedAt,
      input.inputMessageId,
      input.onFinished ?? (() => undefined),
      input.sessionId,
    ).finally(async () => await forgetActive(input.missionId, input.handle.executionId));
    active.set(input.missionId, { handle: input.handle, settlement });
    invalidateChat(input.missionId);
    invalidateWork(input.missionId);
    void settlement.catch((error: unknown) => {
      console.error(`Failed to observe Mission execution ${input.handle.executionId}.`, error);
    });
  };

  const runMission = async (id: string): Promise<Mission> => {
    const mission = await options.missions.get(id);
    if (active.has(mission.id)) return mission;
    const { app, runtimes: baseRuntimes } = executionContext(mission);
    const runtimes = withMissionRuntimeBinding(baseRuntimes, await readMissionRootContext(mission));
    const compiled = await compileMissionExecutor(mission, runtimes);
    const modelSelection = toRuntimeModelSelection(mission.modelOverride);
    if (mission.modelOverride !== undefined) {
      await runtimes.bind({
        runtimeId: requireRootRuntimeId(compiled),
        modelSelection,
      });
    }
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
        status: "running",
        startedAt: executionStartedAt,
      });
      trackExecution({
        missionId: mission.id,
        handle,
        startedAt: executionStartedAt,
        inputMessageId,
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
    const recoveredPrompt = recoverable
      ? (await session.getPromptQueue()).find(
          (prompt) =>
            prompt.executionId === mission.execution!.id &&
            prompt.mode === "enqueue" &&
            prompt.status === "queued",
        )
      : undefined;
    const recoveredTurn =
      recoveredPrompt === undefined
        ? undefined
        : (await session.listTurns()).find(
            (candidate) => candidate.executionId === mission.execution!.id,
          );
    if (recoveredPrompt !== undefined && recoveredTurn === undefined) {
      throw new Error(`Recoverable Expert turn not found: ${mission.execution!.id}`);
    }
    const inputMessageId = recoverable
      ? mission.execution!.inputMessageId
      : mission.initialMessageId;
    const turn =
      recoveredTurn ??
      (await session.prompt(
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
        },
      ));
    const executionStartedAt =
      recoveredTurn === undefined ? startedAt : mission.execution!.startedAt;
    await options.missions.appendExecutionReference({
      missionId: mission.id,
      inputMessageId,
      executionId: turn.executionId,
      createdAt: executionStartedAt,
    });
    const running = await options.missions.updateExecution(mission.id, {
      id: turn.executionId,
      inputMessageId,
      sessionId: session.sessionId,
      status: recoveredTurn === undefined ? "running" : "waiting",
      startedAt: executionStartedAt,
    });
    trackExecution({
      missionId: mission.id,
      handle: turn,
      startedAt: executionStartedAt,
      inputMessageId,
      sessionId: session.sessionId,
      onFinished: async () => await waitForExpertTurnSettlement(session, turn.requestId),
    });
    return running;
  };

  const summarizeMissionTitle = async (id: string): Promise<Mission> => {
    const mission = await options.missions.get(id);
    const initialTitle = mission.title;
    const { app, runtimes: baseRuntimes } = executionContext(mission);
    const runtimes = withMissionRuntimeBinding(baseRuntimes, await readMissionRootContext(mission));
    const compiled = await compileMissionExecutor(mission, runtimes);
    const rootExpert =
      "kind" in compiled.value && compiled.value.kind === "flow"
        ? undefined
        : isExpertTeam(compiled.value)
          ? compiled.value.coordinator
          : compiled.value;
    const modelSelection =
      toRuntimeModelSelection(mission.modelOverride) ?? rootExpert?.models?.default;
    const titleExpert = await getTitleExpert(mission.workspace.path);
    const session = await app.experts.createSession(titleExpert, {
      runtime: compiled.rootRuntimeId,
      ...(modelSelection === undefined ? {} : { modelSelection }),
    });
    try {
      const turn = await session.prompt(
        `Summarize this Mission request as a short title:\n\n${mission.goal}`,
        { requestId: randomUUID() },
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        turn.result,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            void turn.cancel("Mission title summary timed out.");
            reject(new Error("Mission title summary timed out."));
          }, MISSION_TITLE_SUMMARY_TIMEOUT_MS);
          timeout.unref();
        }),
      ]).finally(() => {
        if (timeout !== undefined) clearTimeout(timeout);
      });
      const title = normalizeGeneratedMissionTitle(result);
      return await options.missions.updateTitle(mission.id, title, {
        expectedTitle: initialTitle,
      });
    } finally {
      await session.close("Mission title summary completed.").catch(() => undefined);
    }
  };

  const sendMissionMessage = async (input: {
    readonly id: string;
    readonly content: string;
    readonly requestId: string;
  }): Promise<Mission> => {
    const mission = await options.missions.get(input.id);
    const { app, runtimes: baseRuntimes } = executionContext(mission);
    const rootContext = await readMissionRootContext(mission);
    const runtimes = withMissionRuntimeBinding(baseRuntimes, rootContext);
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
    if ("kind" in compiled.value && compiled.value.kind === "flow") {
      throw new Error("Flow missions cannot receive chat messages.");
    }
    const rootExpert = isExpertTeam(compiled.value) ? compiled.value.coordinator : compiled.value;
    const desiredModelSelection =
      mission.execution?.sessionId === undefined
        ? (modelSelection ?? rootExpert.models?.default)
        : modelSelection;
    const promptModelSelection = matchesBoundModel(
      desiredModelSelection,
      rootContext?.modelSelection,
    )
      ? undefined
      : desiredModelSelection;
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
      ...(promptModelSelection === undefined ? {} : { modelSelection: promptModelSelection }),
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
      status: "running",
      startedAt,
    });
    trackExecution({
      missionId: mission.id,
      handle: turn,
      startedAt,
      inputMessageId: input.requestId,
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
    const baseRuntimes = runtimeResolverForToolPermissionMode(input.toolPermissionMode);
    const runtimes = withMissionRuntimeBinding(baseRuntimes, await readMissionRootContext(mission));
    await compileMissionExecutor(prospective, runtimes);
    if (input.toolPermissionMode !== mission.toolPermissionMode) {
      await sessions.get(mission.id)?.refreshRuntimeSessions();
    }
    const updated = await options.missions.updateOptions(mission.id, {
      toolPermissionMode: input.toolPermissionMode,
      ...(prospective.modelOverride === undefined
        ? {}
        : { modelOverride: prospective.modelOverride }),
    });
    executionContexts.get(mission.id)?.setToolPermissionMode(input.toolPermissionMode);
    return updated;
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
    executionContexts.delete(id);
  };

  const getChatSnapshot = async (input: MissionChatQuery): Promise<MissionChatSnapshot> => {
    const mission = await options.missions.get(input.id);
    const timeline = await options.missions.readTimelinePage(mission.id, input);
    const capturedLive = liveChats.get(mission.id);
    const entries = await readMissionChatHistory(
      timeline.turns,
      executionStore,
      capturedLive?.executionId,
    );

    const names = await getExecutorNames(mission);
    const current = active.get(mission.id);
    const pendingInteractions =
      current === undefined ? [] : await listPendingHumanInteractions(current.handle);

    // Keep using the projection captured before history was read. The execution may settle across
    // the awaits above; looking it up again would omit both durable history (which was skipped for
    // the captured live execution) and the live entries that were removed during settlement.
    if (input.beforeSequence === undefined && capturedLive !== undefined) {
      entries.push(...capturedLive.entries.map((entry) => ({ ...entry })));
    }
    // Mission execution state can change while history and executor metadata are being read. Read
    // it again immediately before the revision so a snapshot cannot pair a stale `running` state
    // with the terminal invalidation revision.
    const latestMission = await options.missions.get(mission.id);
    const revision = chatRevisions.get(mission.id) ?? 0;
    const namedEntries = entries.map((entry) => {
      if (entry.executorName !== undefined || entry.executorId === undefined) return entry;
      return {
        ...entry,
        executorName: names.get(entry.executorId) ?? entry.executorId,
      };
    });
    return {
      missionId: mission.id,
      revision,
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
      ...(latestMission.execution === undefined
        ? {}
        : {
            execution: {
              id: latestMission.execution.id,
              status: latestMission.execution.status,
              interruptible:
                current?.handle.executionId === latestMission.execution.id &&
                ["queued", "running", "waiting"].includes(latestMission.execution.status),
              ...(latestMission.execution.error === undefined
                ? {}
                : { error: latestMission.execution.error }),
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

  const readMissionExecutionIds = async (mission: Mission): Promise<readonly string[]> => {
    if (mission.execution?.sessionId !== undefined) {
      const session = await expertSessionStore.get(mission.execution.sessionId);
      if (session !== undefined) return session.executionIds;
    }
    const executionIds: string[] = [];
    let beforeSequence: number | undefined;
    do {
      const page = await options.missions.readTimelinePage(mission.id, {
        ...(beforeSequence === undefined ? {} : { beforeSequence }),
        limit: 100,
      });
      executionIds.push(
        ...page.turns.flatMap((turn) => (turn.executionId === undefined ? [] : [turn.executionId])),
      );
      beforeSequence = page.nextBeforeSequence;
    } while (beforeSequence !== undefined);
    return [...new Set(executionIds)].toSorted();
  };

  const getWorkSnapshot = async (id: string): Promise<MissionWorkSnapshot> => {
    const mission = await options.missions.get(id);
    const executionIds = await readMissionExecutionIds(mission);
    const records = await workHistory.listRecords({
      executionIds,
      ...(mission.execution?.sessionId === undefined
        ? {}
        : { rootSessionId: mission.execution.sessionId }),
    });
    const names = await getExecutorNames(mission);
    const runtimeAgentOrdinals = createRuntimeAgentOrdinals(records);
    return {
      missionId: mission.id,
      revision: workRevisions.get(mission.id) ?? 0,
      records: records.map((record): MissionWorkRecord => {
        const tasks = record.tasks.map((task) => ({
          taskId: task.taskId,
          executionId: task.executionId,
          invocationId: task.invocationId,
          runId: task.runId,
          ...(task.sequence === undefined ? {} : { sequence: task.sequence }),
          status: task.status,
          inputSummary: formatValue(task.input, 500),
          ...(task.output === undefined ? {} : { outputSummary: formatValue(task.output, 1_000) }),
          ...(task.error === undefined ? {} : { error: formatValue(task.error, 10_000) }),
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        }));
        const latest = tasks.at(-1);
        const resolvedName =
          record.displayName ??
          (record.executorId === undefined ? undefined : names.get(record.executorId)) ??
          (record.kind === "root" ? mission.executor.name : undefined);
        const fallbackOrdinal =
          record.kind === "runtime-agent" && resolvedName === undefined
            ? runtimeAgentOrdinals.get(record.recordId)
            : undefined;
        const title =
          resolvedName ??
          (fallbackOrdinal === undefined ? undefined : `Subagent ${fallbackOrdinal}`) ??
          record.executorId ??
          record.kind;
        return {
          recordId: record.recordId,
          kind: record.kind,
          sessionId: record.sessionId,
          ...(record.parentRecordId === undefined ? {} : { parentRecordId: record.parentRecordId }),
          title,
          ...(fallbackOrdinal === undefined ? {} : { fallbackOrdinal }),
          ...(record.executorId === undefined ? {} : { executorId: record.executorId }),
          origin: record.origin,
          status: record.status,
          tasks,
          summary: latest?.outputSummary ?? latest?.inputSummary ?? title,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        };
      }),
    };
  };

  const getWorkOutput = async (input: GetMissionWorkOutput): Promise<MissionWorkOutputSnapshot> => {
    const mission = await options.missions.get(input.id);
    const executionIds = await readMissionExecutionIds(mission);
    const records = await workHistory.listRecords({
      executionIds,
      ...(mission.execution?.sessionId === undefined
        ? {}
        : { rootSessionId: mission.execution.sessionId }),
    });
    const record = records.find((candidate) => candidate.recordId === input.recordId);
    if (record === undefined) throw new Error(`Mission work record not found: ${input.recordId}`);
    const durableEntries = messageRecordsToChatEntries(
      await workHistory.readOutput({ executionIds, record }),
    );
    const liveEntries = liveWorkOutputs.get(mission.id)?.get(record.recordId)?.entries ?? [];
    const liveExecutionIds = new Set(liveEntries.flatMap((entry) => entry.executionId ?? []));
    const byId = new Map<string, MissionChatEntry>();
    for (const entry of durableEntries) {
      if (entry.executionId === undefined || !liveExecutionIds.has(entry.executionId)) {
        byId.set(entry.id, { ...entry });
      }
    }
    for (const entry of liveEntries) byId.set(entry.id, { ...entry });
    const entries = [...byId.values()].toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
    const requestedEnd =
      input.beforeCursor === undefined ? entries.length : Number(input.beforeCursor);
    const end = Number.isInteger(requestedEnd)
      ? Math.max(0, Math.min(entries.length, requestedEnd))
      : entries.length;
    const start = Math.max(0, end - input.limit);
    return {
      missionId: mission.id,
      recordId: record.recordId,
      revision: workRevisions.get(mission.id) ?? 0,
      entries: entries.slice(start, end),
      ...(start === 0 ? {} : { nextBeforeCursor: String(start) }),
    };
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
    async summarizeTitle(id) {
      return await summarizeMissionTitle(id);
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
    async getRuntimeBinding(id) {
      return (await readMissionRootContext(await options.missions.get(id)))?.runtime;
    },
    subscribeChat(listener) {
      chatListeners.add(listener);
      return () => chatListeners.delete(listener);
    },
    subscribeWork(listener) {
      workListeners.add(listener);
      return () => workListeners.delete(listener);
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
    async getWork(id) {
      return await getWorkSnapshot(id);
    },
    async getWorkOutput(input) {
      return await getWorkOutput(input);
    },
    async delete(id) {
      if (pendingOperations.has(id)) {
        throw new Error("Wait for the current mission operation to finish.");
      }
      const liveChat = liveChats.get(id);
      if (liveChat !== undefined) await liveChat.close();
      liveChats.delete(id);
      const deleting = deleteMission(id);
      trackOperation(id, { kind: "delete", promise: deleting });
      await deleting;
      chatRevisions.delete(id);
      workRevisions.delete(id);
      liveWorkOutputs.delete(id);
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
      invalidateChat(input.missionId);
    },
  };
}

function createRuntimeAgentOrdinals(
  records: readonly ExecutionWorkRecord[],
): ReadonlyMap<string, number> {
  const nextByParent = new Map<string, number>();
  const ordinals = new Map<string, number>();
  const ordered = [...records].toSorted((left, right) => {
    const created = left.createdAt.localeCompare(right.createdAt);
    return created === 0 ? left.recordId.localeCompare(right.recordId) : created;
  });
  for (const record of ordered) {
    if (record.kind !== "runtime-agent") continue;
    const parentKey = record.parentRecordId ?? "";
    const ordinal = (nextByParent.get(parentKey) ?? 0) + 1;
    nextByParent.set(parentKey, ordinal);
    ordinals.set(record.recordId, ordinal);
  }
  return ordinals;
}

export function normalizeGeneratedMissionTitle(result: unknown): string {
  if (typeof result !== "string") {
    throw new Error("Mission title summary did not return text.");
  }
  const firstLine = result
    .trim()
    .split(/\r?\n/u)
    .find((line) => line.trim() !== "");
  if (firstLine === undefined) throw new Error("Mission title summary was empty.");
  const unwrapped = firstLine
    .trim()
    .replace(/^#{1,6}\s+/u, "")
    .replace(/^["'`]+|["'`]+$/gu, "")
    .replace(/[。.!！?？]+$/u, "");
  return normalizeMissionTitle(unwrapped);
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

function withMissionRuntimeBinding(
  runtimes: RuntimeResolver,
  context: RuntimeContextRecord | undefined,
): RuntimeResolver {
  if (context === undefined) return runtimes;
  const binding = context.runtime;
  return {
    getDefaultRuntimeId: async () => binding.runtimeId,
    bind: async (request = {}) =>
      request.runtimeId === undefined || request.runtimeId === binding.runtimeId
        ? await runtimes.resolve({
            binding,
            ...(request.modelSelection === undefined && context.modelSelection === undefined
              ? {}
              : {
                  modelSelection: matchesBoundModel(request.modelSelection, context.modelSelection)
                    ? context.modelSelection
                    : request.modelSelection,
                }),
          })
        : await runtimes.bind(request),
    resolve: async (request) => await runtimes.resolve(request),
  };
}

function matchesBoundModel(
  requested: RuntimeModelSelection | undefined,
  bound: RuntimeModelSelection | undefined,
): boolean {
  if (requested === undefined) return bound !== undefined;
  return (
    requested.model.providerId === bound?.model.providerId &&
    requested.model.modelId === bound.model.modelId &&
    requested.thinkingLevel === bound.thinkingLevel
  );
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
    const activityEntries = await readHistoricalAgentActivityEntries(view, turn.sequence);
    const richEntries = finalizeHistoricalChatEntries(
      [
        ...messageRecordsToChatEntries(
          histories
            .flatMap((history) => history.messages)
            .filter((record) => record.source?.parentSessionId === undefined),
        ).map((entry) => ({
          ...entry,
          timelineSequence: turn.sequence,
        })),
        ...activityEntries,
      ].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
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

async function readHistoricalAgentActivityEntries(
  view: StoredExecutionView,
  timelineSequence: number,
): Promise<MissionChatEntry[]> {
  const events: ExpertAgentStreamEvent[] = [];
  let after: { executionId: string; sequence: number } | undefined;
  do {
    const page = await view.listEvents({ scope: { kind: "all" }, limit: 1_000, after });
    for (const event of page.items) {
      if (event.type !== "runtime.event") continue;
      const parsed = ExpertAgentStreamEventSchema.safeParse(event.data);
      if (
        parsed.success &&
        (parsed.data.type === "agent.command" || parsed.data.type.startsWith("run."))
      ) {
        events.push(parsed.data);
      }
    }
    after = page.nextCursor;
  } while (after !== undefined);
  const byId = new Map<string, MissionChatEntry>();
  for (const event of events) {
    const isCommand = event.type === "agent.command";
    if (!isCommand && event.source.parentSessionId === undefined) continue;
    const action = isCommand ? event.payload.action : "run";
    const commandId = isCommand
      ? event.payload.commandId
      : `${event.source.sessionId ?? event.runId}:${event.runId}:run`;
    const phase = isCommand
      ? event.payload.phase
      : event.type === "run.started"
        ? "started"
        : event.type === "run.completed"
          ? "completed"
          : "failed";
    byId.set(`agent:${view.executionId}:${commandId}`, {
      id: `agent:${view.executionId}:${commandId}`,
      timelineSequence,
      executionId: view.executionId,
      kind: "agent_activity",
      commandId,
      action,
      phase,
      ...(isCommand && event.payload.senderSessionId !== undefined
        ? { senderSessionId: event.payload.senderSessionId }
        : {}),
      targetSessionIds: isCommand
        ? event.payload.targetSessionIds
        : event.source.sessionId === undefined
          ? []
          : [event.source.sessionId],
      ...(event.source.displayName === undefined ? {} : { label: event.source.displayName }),
      ...(isCommand && event.payload.error !== undefined
        ? { error: event.payload.error }
        : event.type === "run.failed"
          ? { error: event.payload.message }
          : {}),
      createdAt: event.emittedAt,
    });
  }
  return [...byId.values()];
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
  onOutput: (patches: readonly MissionChatPatch[]) => void,
  onInvalidate: () => void,
  onItem: (item: ExecutionOutputItem) => void,
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
          onItem(item);
          const patches = consumeLiveChatOutput(chat, item);
          if (patches.length > 0) onOutput(patches);
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
            onInvalidate();
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

function consumeLiveChatOutput(
  chat: LiveMissionChat,
  item: ExecutionOutputItem,
): MissionChatPatch[] {
  const base = {
    executionId: item.executionId,
    invocationId: item.invocationId,
    ...(item.executorId === undefined ? {} : { executorId: item.executorId }),
    createdAt: item.occurredAt,
  };
  if (item.channel === "agent") {
    const payload = asRecord(item.value);
    const eventType = readString(payload, "type");
    const action = eventType.startsWith("run.")
      ? "run"
      : readAgentActivityAction(readString(payload, "action"));
    if (action === undefined) return [];
    const commandId =
      readString(payload, "commandId") ||
      `${item.source.sessionId ?? item.runId}:${item.runId}:${action}`;
    const phase =
      eventType === "run.failed" || eventType === "run.cancelled"
        ? "failed"
        : eventType === "run.completed"
          ? "completed"
          : eventType === "run.started"
            ? "started"
            : readAgentActivityPhase(readString(payload, "phase"));
    if (phase === undefined) return [];
    const id = `agent:${item.executionId}:${commandId}`;
    const targets = payload["targetSessionIds"];
    const targetSessionIds = Array.isArray(targets)
      ? targets.filter((value): value is string => typeof value === "string" && value !== "")
      : item.source.sessionId === undefined
        ? []
        : [item.source.sessionId];
    const entry: MissionChatEntry = {
      ...base,
      id,
      kind: "agent_activity",
      commandId,
      action,
      phase,
      ...(readString(payload, "senderSessionId") === ""
        ? {}
        : { senderSessionId: readString(payload, "senderSessionId") }),
      targetSessionIds,
      ...(item.source.displayName === undefined ? {} : { label: item.source.displayName }),
      ...(readString(payload, "error") === ""
        ? eventType !== "run.failed"
          ? {}
          : { error: readString(payload, "message") || "Subagent failed." }
        : { error: readString(payload, "error") }),
    };
    const index = chat.entries.findIndex((candidate) => candidate.id === id);
    if (index === -1) chat.entries.push(entry);
    else chat.entries[index] = entry;
    return [{ type: "entry.upsert", entry }];
  }
  if (item.source.parentSessionId !== undefined) return [];
  if (item.channel === "thought") {
    const content = item.delta ?? formatValue(item.value, 200_000);
    if (content === "") return [];
    const current = chat.entries.at(-1);
    if (current?.kind === "thinking" && current.invocationId === item.invocationId) {
      const canAppend = current.content.length + content.length <= 200_000;
      current.content = truncate(current.content + content, 200_000);
      const patches: MissionChatPatch[] = canAppend
        ? [{ type: "entry.append", entryId: current.id, field: "content", delta: content }]
        : [{ type: "entry.upsert", entry: { ...current } }];
      if (!current.streaming) {
        current.streaming = true;
        patches.push({ type: "entry.streaming", entryId: current.id, streaming: true });
      }
      return patches;
    } else {
      const entry = {
        ...base,
        id: `${item.executionId}:${item.invocationId}:thinking:${chat.sequence++}`,
        kind: "thinking" as const,
        content: truncate(content, 200_000),
        streaming: true,
      };
      chat.entries.push(entry);
      return [{ type: "entry.upsert", entry: { ...entry } }];
    }
  }
  if (item.channel === "message") {
    const content = item.delta ?? completedMessageText(item.value);
    const patches = markInvocationThinkingComplete(chat.entries, item.invocationId);
    const current = chat.entries.at(-1);
    if (
      item.delta !== undefined &&
      current?.kind === "assistant" &&
      current.invocationId === item.invocationId
    ) {
      const canAppend = current.content.length + content.length <= 200_000;
      current.content = truncate(current.content + content, 200_000);
      if (content !== "") {
        patches.push(
          canAppend
            ? { type: "entry.append", entryId: current.id, field: "content", delta: content }
            : { type: "entry.upsert", entry: { ...current } },
        );
      }
      if (!current.streaming) {
        current.streaming = true;
        patches.push({ type: "entry.streaming", entryId: current.id, streaming: true });
      }
    } else if (
      item.delta === undefined &&
      chat.entries.some(
        (entry) => entry.kind === "assistant" && entry.invocationId === item.invocationId,
      )
    ) {
      const last = [...chat.entries]
        .reverse()
        .find((entry) => entry.kind === "assistant" && entry.invocationId === item.invocationId);
      if (last?.kind === "assistant" && last.streaming) {
        last.streaming = false;
        patches.push({ type: "entry.streaming", entryId: last.id, streaming: false });
      }
    } else if (content !== "") {
      const entry = {
        ...base,
        id: `${item.executionId}:${item.invocationId}:answer:${chat.sequence++}`,
        kind: "assistant" as const,
        content: truncate(content, 200_000),
        streaming: item.delta !== undefined,
      };
      chat.entries.push(entry);
      patches.push({ type: "entry.upsert", entry: { ...entry } });
    }
    return patches;
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
        const delta = normalizeToolDelta(item.delta);
        const canAppend = (tool.outputPreview?.length ?? 0) + delta.length <= 801;
        tool.outputPreview = preview(`${tool.outputPreview ?? ""}${delta}`);
        return delta === ""
          ? []
          : canAppend
            ? [{ type: "entry.append", entryId: tool.id, field: "outputPreview", delta }]
            : [{ type: "entry.upsert", entry: { ...tool } }];
      }
      return [];
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
      return [{ type: "entry.upsert", entry: { ...existing } }];
    }
    const patches = markInvocationThinkingComplete(chat.entries, item.invocationId);
    const entry: MissionChatEntry = {
      ...base,
      id: `tool:${item.executionId}:${toolCallId}`,
      kind: "tool" as const,
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
    };
    chat.entries.push(entry);
    patches.push({ type: "entry.upsert", entry: { ...entry } });
    return patches;
  }
  if (item.channel === "result") {
    const content = formatValue(item.value, 200_000);
    if (
      content !== "" &&
      !chat.entries.some(
        (entry) => entry.kind === "assistant" && entry.invocationId === item.invocationId,
      )
    ) {
      const entry = {
        ...base,
        id: `${item.executionId}:${item.invocationId}:result:${chat.sequence++}`,
        kind: "assistant" as const,
        content,
        streaming: false,
      };
      chat.entries.push(entry);
      return [{ type: "entry.upsert", entry: { ...entry } }];
    }
  }
  return [];
}

function readAgentActivityAction(
  value: string,
): Extract<MissionChatEntry, { kind: "agent_activity" }>["action"] | undefined {
  switch (value) {
    case "spawn":
    case "wait":
    case "list":
    case "send":
    case "resume":
    case "interrupt":
      return value;
    default:
      return undefined;
  }
}

function readAgentActivityPhase(
  value: string,
): Extract<MissionChatEntry, { kind: "agent_activity" }>["phase"] | undefined {
  switch (value) {
    case "started":
    case "completed":
    case "failed":
      return value;
    default:
      return undefined;
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

function markInvocationThinkingComplete(
  entries: MissionChatEntry[],
  invocationId: string,
): MissionChatPatch[] {
  const patches: MissionChatPatch[] = [];
  for (const entry of entries) {
    if (entry.kind === "thinking" && entry.invocationId === invocationId && entry.streaming) {
      entry.streaming = false;
      patches.push({ type: "entry.streaming", entryId: entry.id, streaming: false });
    }
  }
  return patches;
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
