import { basename } from "node:path";

import type {
  ExpertSession,
  ExpertSessionStore,
  ExecutionStore,
  Flow,
  FlowExecution,
  FlowSpec,
  HostContextBindings,
  HostContextBindingsResolver,
  PragmaApp,
  PragmaLoggerProvider,
  RuntimeResolver,
  UsageSink,
} from "@pragma/core";
import {
  createFileExpertSessionStore,
  createFileExecutionStore,
  createPragma,
  unwrapInvocationOutput,
} from "@pragma/core";
import {
  HumanInteractionResponseSchema,
  JsonValueSchema,
  isTerminalExecutionStatus,
  type WorkspaceSelection,
} from "@pragma/shared";
import {
  createIntegrationError,
  ExecutorDescriptorSchema,
  IntegrationErrorSchema,
  type ExecutorDescriptor,
  type ExecutorReference,
  type HumanInteractionRequestEnvelope,
  type MissionCommand,
} from "@pragma/shared/integration";

import {
  createPinnedBindingRecoveryError,
  type MissionPinnedBinding,
} from "./missions/controller/pinned-binding.ts";
import type {
  MissionCommandConsumer,
  MissionControllerGuard,
} from "./missions/controller/mission-controller-store.ts";
import {
  readPendingInteraction,
  mapExecutionEvent,
  toCoreResponse,
  type LocalHostCoreDefinition,
  type LocalHostCoreExecutorDefinition,
  type LocalHostCoreRunComposition,
} from "./core-run.ts";
import { createLocalHostMissionEventProjector } from "./mission-event-projector.ts";
import { createRunRedactor, type RunRedactor } from "./redaction.ts";
import type { LocalHostRunMissionPort, LocalHostRunTerminal } from "./run.ts";
import type {
  MissionControlExecutionOutcome,
  MissionControlTargetResolution,
} from "./missions/controller/mission-control.ts";

export interface LocalHostCoreMissionControlAdapter {
  readonly consumer: MissionCommandConsumer;
  readonly assertAcquisitionAllowed: (missionId: string) => Promise<void>;
  readonly resolveStrictTarget: (input: {
    readonly missionId: string;
    readonly expectedExecutionId?: string | undefined;
  }) => Promise<MissionControlTargetResolution | undefined>;
  readonly resolveExecutionTarget: (input: {
    readonly missionId: string;
    readonly expectedExecutionId?: string | undefined;
  }) => Promise<string | undefined>;
  readonly recoverMission: (missionId: string) => Promise<void>;
  readonly release: (missionId: string) => Promise<void>;
  readonly releaseAfterHumanCheckpoint: (
    missionId: string,
    guard: MissionControllerGuard,
  ) => Promise<void>;
  readonly waitExecution: (input: {
    readonly missionId: string;
    readonly executionId: string;
    readonly pollIntervalMs?: number | undefined;
  }) => Promise<MissionControlExecutionOutcome>;
}

export type LocalHostCoreActiveOwner =
  | {
      readonly kind: "session";
      readonly session: ExpertSession;
      readonly executor: LocalHostCoreExecutorDefinition;
    }
  | {
      readonly kind: "flow";
      readonly execution: FlowExecution;
      readonly executor: LocalHostCoreExecutorDefinition;
    };

/**
 * Core adapter for the durable Mission Inbox. The controller owns the
 * Mission lease; this adapter owns only the recovered ExpertSession or Flow
 * handle and performs every Runtime operation outside the aggregate lock.
 */
export function createLocalHostCoreMissionControlAdapter(options: {
  readonly runtimes: RuntimeResolver;
  readonly pragmaHome?: string | undefined;
  readonly app?: PragmaApp | undefined;
  readonly executions?: ExecutionStore | undefined;
  readonly sessions?: ExpertSessionStore | undefined;
  /** Mission event sink shared with the initial Local Host run path. */
  readonly mission: Pick<LocalHostRunMissionPort, "controller" | "append">;
  readonly redactor?: RunRedactor | undefined;
  readonly usageSink?: UsageSink | undefined;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
  readonly hostContextBindings?: HostContextBindings | undefined;
  readonly resolveHostContextBindings?: HostContextBindingsResolver | undefined;
  readonly createHostContextBindings?: LocalHostCoreRunComposition["createHostContextBindings"];
  readonly executors:
    | readonly LocalHostCoreExecutorDefinition[]
    | ((input: {
        readonly ref: ExecutorReference;
        readonly projectId?: string | undefined;
        readonly revision?: number | undefined;
        readonly workspace: WorkspaceSelection;
      }) => Promise<LocalHostCoreExecutorDefinition | undefined>);
  readonly resolveActiveOwner?:
    ((missionId: string) => Promise<LocalHostCoreActiveOwner | undefined>) | undefined;
  readonly resolveMissionBinding: (missionId: string) => Promise<MissionPinnedBinding | undefined>;
  /** Release the Mission lease after a recovered lower-level owner settles. */
  readonly releaseMissionOwner?: ((missionId: string) => Promise<void>) | undefined;
  /** Used to avoid releasing a lease while a newer Inbox item is arriving. */
  readonly hasPendingMissionCommands?: ((missionId: string) => Promise<boolean>) | undefined;
}): LocalHostCoreMissionControlAdapter {
  const executions =
    options.executions ?? createFileExecutionStore({ pragmaHome: options.pragmaHome });
  const sessions =
    options.sessions ??
    createFileExpertSessionStore({
      executions,
      ...(options.pragmaHome === undefined ? {} : { pragmaHome: options.pragmaHome }),
    });
  // Only cache owners recovered by this control adapter.  A live owner that
  // belongs to the ordinary run executor must be resolved fresh on every
  // command; caching it here would leave a closed ExpertSession behind after
  // the foreground run releases its resources.
  const recoveredOwners = new Map<string, CoreMissionOwner>();
  const settlementTasks = new Map<string, Promise<void>>();
  const redactor = options.redactor ?? createRunRedactor();

  const createApp = (hostContextBindings?: HostContextBindings): PragmaApp =>
    options.app ??
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

  const resolveExecutor = async (
    binding: MissionPinnedBinding,
  ): Promise<LocalHostCoreExecutorDefinition> => {
    const workspace = workspaceFromBinding(binding);
    const candidate =
      typeof options.executors === "function"
        ? await options.executors({
            ref: binding.executor.ref,
            workspace,
            ...(binding.executor.source === "project"
              ? {
                  projectId: binding.executor.project.projectId,
                  revision: binding.executor.project.revision,
                }
              : {}),
          })
        : options.executors.find(
            (entry) =>
              entry.descriptor.ref.kind === binding.executor.ref.kind &&
              entry.descriptor.ref.id === binding.executor.ref.id &&
              (binding.executor.source !== "project" ||
                (entry.descriptor.project?.projectId === binding.executor.project.projectId &&
                  entry.descriptor.project.revision === binding.executor.project.revision &&
                  entry.descriptor.project.fingerprint === binding.executor.project.fingerprint)),
          );
    if (candidate === undefined) {
      throw createIntegrationError({
        code: "EXECUTOR_NOT_FOUND",
        category: "not_found",
        message: `Executor not found: ${binding.executor.ref.kind}:${binding.executor.ref.id}.`,
        details: { missionId: binding.executor.ref.id },
      });
    }
    const descriptor = ExecutorDescriptorSchema.parse(candidate.descriptor);
    assertExecutorMatchesBinding(descriptor, binding);
    return { descriptor, definition: candidate.definition };
  };

  const readBinding = async (missionId: string): Promise<MissionPinnedBinding> => {
    const binding = await options.resolveMissionBinding(missionId);
    if (binding === undefined)
      throw createPinnedBindingRecoveryError({
        reason: "mission_pinned_binding_required",
        missionId,
      });
    return binding;
  };

  const assertAcquisitionAllowed = async (missionId: string): Promise<void> => {
    await resolveExecutor(await readBinding(missionId));
  };

  const recover = async (missionId: string): Promise<CoreMissionOwner> => {
    const existing = recoveredOwners.get(missionId);
    if (existing !== undefined) return existing;
    const active = await options.resolveActiveOwner?.(missionId);
    if (active !== undefined) {
      return active;
    }
    const binding = await readBinding(missionId);
    const executor = await resolveExecutor(binding);
    const app = await createControlApp({
      options,
      binding,
      missionId,
      createApp,
    });
    const owner = await recoverOwner({
      app,
      sessions,
      executions,
      missionId,
      executor,
    });
    recoveredOwners.set(missionId, owner);
    return owner;
  };

  const recoverMission = async (missionId: string): Promise<void> => {
    await recover(missionId);
  };

  const settleRecoveredOwner = async (
    missionId: string,
    guard: MissionControllerGuard,
  ): Promise<void> => {
    if (options.releaseMissionOwner === undefined) return;
    // Let ExpertSession/FlowExecution finish the microtask that starts the
    // newly accepted prompt before deciding that an acquired owner is idle.
    await unrefDelay(25);
    for (;;) {
      const owner = recoveredOwners.get(missionId);
      if (owner === undefined) return;
      if (await options.hasPendingMissionCommands?.(missionId)) {
        await unrefDelay(50);
        continue;
      }

      if (owner.kind === "session") {
        const [state, prompts] = await Promise.all([
          owner.session.getState(),
          owner.session.getPromptQueue(),
        ]);
        if (
          state.activeExecutionId !== undefined ||
          prompts.some((prompt) => prompt.status === "running")
        ) {
          await unrefDelay(100);
          continue;
        }
        await projectRecoveredOwner({
          missionId,
          guard,
          executionIds: state.executionIds,
          executions,
          mission: options.mission,
          redactor,
        });
        const checkpointed =
          state.lastStatus === "waiting" || prompts.some((prompt) => prompt.status === "queued");
        if (checkpointed) await owner.session.releaseAfterHumanCheckpoint();
        else await owner.session.releaseAfterTerminal();
      } else {
        const execution = await executions.get(missionId);
        if (execution !== undefined && !isTerminalExecutionStatus(execution.status)) {
          const waitingForHuman =
            execution.status === "waiting" &&
            (await executions.listInvocations(missionId)).some(
              (invocation) =>
                invocation.status === "waiting" && invocation.waitReason === "human_input",
            );
          if (!waitingForHuman) {
            await unrefDelay(100);
            continue;
          }
        }
        await projectRecoveredOwner({
          missionId,
          guard,
          executionIds: [missionId],
          executions,
          mission: options.mission,
          redactor,
        });
      }

      // Lower-level release is complete. Remove the recovered handle before
      // releasing the Mission lease so a concurrent command can reconstruct a
      // fresh owner; the callback performs its own final pending-item check.
      if (recoveredOwners.get(missionId) === owner) recoveredOwners.delete(missionId);
      await options.releaseMissionOwner(missionId);
      return;
    }
  };

  const scheduleRecoveredOwnerSettlement = (
    missionId: string,
    guard: MissionControllerGuard,
  ): void => {
    if (options.releaseMissionOwner === undefined || !recoveredOwners.has(missionId)) return;
    if (settlementTasks.has(missionId)) return;
    const task = settleRecoveredOwner(missionId, guard).finally(() => {
      if (settlementTasks.get(missionId) === task) settlementTasks.delete(missionId);
    });
    settlementTasks.set(missionId, task);
  };

  const settleUnbackedMissionOwner = async (missionId: string): Promise<void> => {
    if (options.releaseMissionOwner === undefined) return;
    // The lower-level recovery may have failed before it could publish a
    // recovered owner (for example, Flow send or queue mutation rejection).
    // Give the poller a turn to finish the durable outcome, then release the
    // Mission lease if no newer command or ordinary live owner needs it.
    await unrefDelay(25);
    if (recoveredOwners.has(missionId)) return;
    if (options.resolveActiveOwner !== undefined) {
      const active = await options.resolveActiveOwner(missionId);
      if (active !== undefined) return;
    }
    if (await options.hasPendingMissionCommands?.(missionId)) return;
    await options.releaseMissionOwner(missionId);
  };

  const scheduleUnbackedMissionOwnerSettlement = (missionId: string): void => {
    if (options.releaseMissionOwner === undefined || recoveredOwners.has(missionId)) return;
    if (settlementTasks.has(missionId)) return;
    const task = settleUnbackedMissionOwner(missionId).finally(() => {
      if (settlementTasks.get(missionId) === task) settlementTasks.delete(missionId);
    });
    settlementTasks.set(missionId, task);
  };

  const resolveStrictTarget = async (input: {
    readonly missionId: string;
    readonly expectedExecutionId?: string | undefined;
  }): Promise<MissionControlTargetResolution | undefined> => {
    await assertStrictSteerSupported(input.missionId);
    const current = await readActiveExpertTarget(sessions, input.missionId);
    if (
      current !== undefined &&
      input.expectedExecutionId !== undefined &&
      input.expectedExecutionId !== current.executionId
    ) {
      throw createIntegrationError({
        code: "STEER_TARGET_CHANGED",
        category: "conflict",
        message: "Strict Mission steer target changed before command submission.",
        details: {
          missionId: input.missionId,
          expectedExecutionId: input.expectedExecutionId,
          executionId: current.executionId,
        },
      });
    }
    return current;
  };

  const resolveExecutionTarget = async (input: {
    readonly missionId: string;
    readonly expectedExecutionId?: string | undefined;
  }): Promise<string | undefined> => {
    const current = await readCurrentExecutionId(sessions, executions, input.missionId);
    if (input.expectedExecutionId !== undefined && current !== input.expectedExecutionId) {
      throw createIntegrationError({
        code: "COMMAND_REJECTED",
        category: "conflict",
        message: "The expected execution is no longer active.",
        details: {
          reason: "execution_target_changed",
          missionId: input.missionId,
          expectedExecutionId: input.expectedExecutionId,
          ...(current === undefined ? {} : { executionId: current }),
        },
      });
    }
    return current;
  };

  const assertStrictSteerSupported = async (missionId: string): Promise<void> => {
    const active = await options.resolveActiveOwner?.(missionId);
    if (active !== undefined) {
      if (active.kind === "flow") {
        throw commandRejected(missionId, "steer_not_supported");
      }
      if (!(await sessionSupportsSteer(active.session, options.runtimes))) {
        throw commandRejected(missionId, "steer_not_supported");
      }
      return;
    }
    const execution = await executions.get(missionId);
    if (execution?.kind === "flow") throw commandRejected(missionId, "steer_not_supported");
    // A persisted owner without a live in-process handle is only consulted
    // after an exact pin has been resolved. This never reads a project head.
    const binding = await options.resolveMissionBinding(missionId);
    if (binding?.executor.ref.kind === "flow") {
      throw commandRejected(missionId, "steer_not_supported");
    }
    if (binding !== undefined) {
      const executor = await resolveExecutor(await Promise.resolve(binding));
      const session = await sessions.get(missionId);
      const supportsSteer =
        session === undefined
          ? executor.descriptor.capabilities.steerable
          : await sessionRecordSupportsSteer(session, options.runtimes);
      if (!supportsSteer) {
        throw commandRejected(missionId, "steer_not_supported");
      }
    }
  };

  const validateStrictTarget = async (input: {
    readonly command: MissionCommand;
    readonly guard: MissionControllerGuard;
  }): Promise<void> => {
    const { command } = input;
    if (command.kind !== "steer" && command.kind !== "queue.steer") return;
    await assertStrictSteerSupported(command.missionId);
    const current = await resolveStrictTarget({ missionId: command.missionId });
    const target = command.target;
    if (target?.executionId === undefined || target.turnId === undefined) {
      throw createIntegrationError({
        code: "STEER_TARGET_NOT_ACTIVE",
        category: "conflict",
        message: "Mission has no active Expert or Team turn for strict steer.",
        details: { missionId: command.missionId },
      });
    }
    if (current === undefined) {
      throw createIntegrationError({
        code: "STEER_TARGET_CHANGED",
        category: "conflict",
        message: "Strict Mission steer target changed before command apply.",
        details: {
          missionId: command.missionId,
          expectedExecutionId: target.executionId,
          expectedTurnId: target.turnId,
        },
      });
    }
    if (current.executionId !== target.executionId || current.turnId !== target.turnId) {
      throw createIntegrationError({
        code: "STEER_TARGET_CHANGED",
        category: "conflict",
        message: "Strict Mission steer target changed before command apply.",
        details: {
          missionId: command.missionId,
          expectedExecutionId: target.executionId,
          executionId: current.executionId,
          expectedTurnId: target.turnId,
          turnId: current.turnId,
        },
      });
    }
  };

  const adapter: LocalHostCoreMissionControlAdapter = {
    assertAcquisitionAllowed,
    resolveStrictTarget,
    resolveExecutionTarget,
    recoverMission,
    waitExecution: async (input) => await waitForExecution(executions, input),
    release: async (missionId) => {
      const owner = recoveredOwners.get(missionId);
      if (owner === undefined) return;
      if (owner.kind === "session") {
        await owner.session.releaseAfterTerminal();
      }
      recoveredOwners.delete(missionId);
    },
    releaseAfterHumanCheckpoint: async (missionId, guard) => {
      const owner = recoveredOwners.get(missionId);
      if (owner === undefined) return;
      const executionIds =
        owner.kind === "session" ? (await owner.session.getState()).executionIds : [missionId];
      await projectRecoveredOwner({
        missionId,
        guard,
        executionIds,
        executions,
        mission: options.mission,
        redactor,
      });
      if (owner.kind === "session") {
        await owner.session.releaseAfterHumanCheckpoint();
      }
      recoveredOwners.delete(missionId);
    },
    consumer: {
      validateStrictTarget,
      async apply({ command, guard }) {
        // The first check happens before Runtime work. Repeat it immediately
        // before the Core call so a target change in the intervening window
        // cannot turn strict steer into an enqueue or another target.
        await validateStrictTarget({ command, guard });
        return {
          result: await applyCoreMissionCommand({ command, executions, recover }),
        };
      },
      afterOutcome({ command, guard }) {
        if (recoveredOwners.has(command.missionId)) {
          scheduleRecoveredOwnerSettlement(command.missionId, guard);
        } else {
          scheduleUnbackedMissionOwnerSettlement(command.missionId);
        }
      },
    },
  };
  return adapter;
}

type CoreMissionOwner = LocalHostCoreActiveOwner;

async function recoverOwner(options: {
  readonly app: PragmaApp;
  readonly sessions: ExpertSessionStore;
  readonly executions: ExecutionStore;
  readonly missionId: string;
  readonly executor: LocalHostCoreExecutorDefinition;
}): Promise<CoreMissionOwner> {
  const kind = options.executor.descriptor.ref.kind;
  if (kind === "flow") {
    if (!isFlowDefinition(options.executor.definition)) {
      throw new Error(
        `Flow executor definition is not a Flow: ${options.executor.descriptor.ref.id}`,
      );
    }
    if ((await options.executions.get(options.missionId)) === undefined) {
      throw commandRejected(options.missionId, "execution_not_found");
    }
    return {
      kind: "flow",
      execution: await options.app.flows.recover(options.executor.definition, {
        executionId: options.missionId,
      }),
      executor: options.executor,
    };
  }
  if (isFlowDefinition(options.executor.definition)) {
    throw new Error(
      `Non-Flow executor definition is a Flow: ${options.executor.descriptor.ref.id}`,
    );
  }
  if ((await options.sessions.get(options.missionId)) === undefined) {
    throw commandRejected(options.missionId, "session_not_found");
  }
  return {
    kind: "session",
    session: await options.app.experts.resumeSession(options.executor.definition, {
      sessionId: options.missionId,
    }),
    executor: options.executor,
  };
}

async function createControlApp(options: {
  readonly options: Parameters<typeof createLocalHostCoreMissionControlAdapter>[0];
  readonly binding: MissionPinnedBinding;
  readonly missionId: string;
  readonly createApp: (hostContextBindings?: HostContextBindings) => PragmaApp;
}): Promise<PragmaApp> {
  if (options.options.createHostContextBindings === undefined) {
    return options.createApp(options.options.hostContextBindings);
  }
  const executor = await resolveForContext(options.options, options.binding);
  const workspace = workspaceFromBinding(options.binding);
  const request = {
    requestId: options.binding.requestId,
    command: options.binding.command,
    executor: executor.descriptor.ref,
    workspace,
    detach: false,
  } as const;
  return options.createApp(
    await options.options.createHostContextBindings({
      missionId: options.missionId,
      request,
      executor,
    }),
  );
}

async function resolveForContext(
  options: Parameters<typeof createLocalHostCoreMissionControlAdapter>[0],
  binding: MissionPinnedBinding,
): Promise<LocalHostCoreExecutorDefinition> {
  const workspace = workspaceFromBinding(binding);
  const candidate =
    typeof options.executors === "function"
      ? await options.executors({
          ref: binding.executor.ref,
          workspace,
          ...(binding.executor.source === "project"
            ? {
                projectId: binding.executor.project.projectId,
                revision: binding.executor.project.revision,
              }
            : {}),
        })
      : options.executors.find(
          (entry) =>
            entry.descriptor.ref.kind === binding.executor.ref.kind &&
            entry.descriptor.ref.id === binding.executor.ref.id &&
            (binding.executor.source !== "project" ||
              (entry.descriptor.project?.projectId === binding.executor.project.projectId &&
                entry.descriptor.project.revision === binding.executor.project.revision &&
                entry.descriptor.project.fingerprint === binding.executor.project.fingerprint)),
        );
  if (candidate === undefined)
    throw createIntegrationError({
      code: "EXECUTOR_NOT_FOUND",
      category: "not_found",
      message: `Executor not found: ${binding.executor.ref.kind}:${binding.executor.ref.id}.`,
    });
  const descriptor = ExecutorDescriptorSchema.parse(candidate.descriptor);
  assertExecutorMatchesBinding(descriptor, binding);
  return {
    descriptor,
    definition: candidate.definition,
  };
}

async function applyCoreMissionCommand(options: {
  readonly command: MissionCommand;
  readonly executions: ExecutionStore;
  readonly recover: (missionId: string) => Promise<CoreMissionOwner>;
}): Promise<Record<string, unknown>> {
  const { command } = options;
  // Reject unsupported Flow mutations before recovery. Recovering a Flow can
  // allocate a live Core owner, so a rejected send/queue command must not
  // create that side effect merely to discover the executor kind.
  const persistedExecution = await options.executions.get(command.missionId);
  if (
    persistedExecution?.kind === "flow" &&
    command.payload.kind !== "interrupt" &&
    command.payload.kind !== "respond"
  ) {
    throw commandRejected(command.missionId, `${command.kind.replaceAll(".", "_")}_not_supported`);
  }
  const owner = await options.recover(command.missionId);
  if (owner.kind === "flow") {
    if (command.payload.kind === "interrupt") {
      const target = command.target?.executionId;
      if (target !== undefined && target !== owner.execution.executionId) {
        throw executionTargetChanged(command.missionId, target, owner.execution.executionId);
      }
      await owner.execution.cancel(command.payload.reason);
      return {
        missionId: command.missionId,
        executionId: owner.execution.executionId,
        targetStatus: "interrupted",
      };
    }
    if (command.payload.kind === "respond") {
      return await applyFlowResponse(owner.execution, options.executions, command);
    }
    throw commandRejected(command.missionId, `${command.kind.replaceAll(".", "_")}_not_supported`);
  }

  switch (command.payload.kind) {
    case "send": {
      const turn = await owner.session.prompt(command.payload.input.prompt, {
        requestId: command.request.requestId,
        mode: "enqueue",
      });
      const queue = await owner.session.getPromptQueue();
      const queueState = await owner.session.getPromptQueueState();
      const queuedPosition = queue
        .filter((prompt) => prompt.mode === "enqueue" && prompt.status === "queued")
        .findIndex((prompt) => prompt.requestId === command.request.requestId);
      return {
        missionId: command.missionId,
        executionId: turn.executionId,
        turnId: turn.requestId,
        mode: "enqueue",
        queueState: queueState.state,
        ...(queuedPosition < 0 ? {} : { queuePosition: queuedPosition + 1 }),
      };
    }
    case "steer": {
      const turn = await owner.session.prompt(command.payload.input.prompt, {
        requestId: command.request.requestId,
        mode: "steer",
      });
      return {
        missionId: command.missionId,
        executionId: turn.executionId,
        turnId: turn.requestId,
        mode: "steer",
      };
    }
    case "respond":
      return await applySessionResponse(owner.session, options.executions, command);
    case "interrupt": {
      const state = await owner.session.getState();
      const current = state.activeExecutionId;
      const expected = command.target?.executionId;
      if (current === undefined) {
        if (expected === undefined || !state.executionIds.includes(expected)) {
          throw commandRejected(command.missionId, "no_active_execution");
        }
        await owner.session.abortExecution(expected, command.payload.reason);
        return {
          missionId: command.missionId,
          executionId: expected,
          targetStatus: "interrupted",
        };
      }
      if (expected !== undefined && expected !== current) {
        throw executionTargetChanged(command.missionId, expected, current);
      }
      await owner.session.abort(command.payload.reason);
      return {
        missionId: command.missionId,
        executionId: current,
        targetStatus: "interrupted",
      };
    }
    case "queue.remove":
      try {
        await owner.session.removeQueuedPrompt(command.payload.requestId);
      } catch {
        throw commandRejected(command.missionId, "queue_item_not_queued");
      }
      return { missionId: command.missionId, requestId: command.payload.requestId, changed: true };
    case "queue.resume": {
      const before = await owner.session.getPromptQueueState();
      await owner.session.resumePromptQueue();
      return {
        missionId: command.missionId,
        changed: before.state === "paused",
        state: before.state === "paused" ? "running" : before.state,
      };
    }
    case "queue.steer": {
      try {
        const turn = await owner.session.steerQueuedPrompt(command.payload.requestId);
        return {
          missionId: command.missionId,
          executionId: turn.executionId,
          turnId: turn.requestId,
          requestId: command.payload.requestId,
          mode: "steer",
        };
      } catch (error) {
        if (isIntegrationError(error)) throw error;
        if (error instanceof Error && error.message.includes("changed")) {
          throw createIntegrationError({
            code: "STEER_TARGET_CHANGED",
            category: "conflict",
            message: "The active execution changed while steering the queued prompt.",
            details: { missionId: command.missionId },
          });
        }
        throw commandRejected(command.missionId, "queue_item_not_steerable");
      }
    }
  }
}

async function applySessionResponse(
  session: ExpertSession,
  executions: ExecutionStore,
  command: MissionCommand,
): Promise<Record<string, unknown>> {
  const interactionId = command.target?.interactionId;
  if (interactionId === undefined) throw commandRejected(command.missionId, "interaction_required");
  if (command.payload.kind !== "respond") {
    throw commandRejected(command.missionId, "respond_payload_required");
  }
  const state = await session.getState();
  const candidates = state.executionIds;
  for (const executionId of candidates) {
    const envelope = await readPendingInteraction(
      executions,
      executionId,
      command.missionId,
      new Map(),
      interactionId,
    ).catch(() => undefined);
    if (envelope === undefined) continue;
    const turn = (await session.listTurns()).find(
      (candidate) => candidate.executionId === executionId,
    );
    if (turn === undefined) continue;
    const response = HumanInteractionResponseSchema.parse(command.payload.response);
    await turn.respondToHumanInteraction(
      interactionId,
      toCoreResponse(envelope.interaction, response),
      { requestId: command.request.requestId },
    );
    return { missionId: command.missionId, executionId, interactionId };
  }
  throw createIntegrationError({
    code: "INTERACTION_NOT_PENDING",
    category: "conflict",
    message: `Human interaction is not pending: ${interactionId}.`,
    details: { missionId: command.missionId, interactionId },
  });
}

async function applyFlowResponse(
  execution: FlowExecution,
  executions: ExecutionStore,
  command: MissionCommand,
): Promise<Record<string, unknown>> {
  const interactionId = command.target?.interactionId;
  if (interactionId === undefined || command.payload.kind !== "respond") {
    throw commandRejected(command.missionId, "interaction_required");
  }
  const envelope = await readPendingInteraction(
    executions,
    execution.executionId,
    command.missionId,
    new Map(),
    interactionId,
  );
  if (envelope === undefined) {
    throw createIntegrationError({
      code: "INTERACTION_NOT_PENDING",
      category: "conflict",
      message: `Human interaction is not pending: ${interactionId}.`,
      details: { missionId: command.missionId, interactionId },
    });
  }
  const response = HumanInteractionResponseSchema.parse(command.payload.response);
  await execution.respondToHumanInteraction(
    interactionId,
    toCoreResponse(envelope.interaction, response),
    { requestId: command.request.requestId },
  );
  return { missionId: command.missionId, executionId: execution.executionId, interactionId };
}

/**
 * Rebuild the Mission projection from the Core execution before releasing a
 * recovered owner. The initial run and this recovery path deliberately share
 * the same event projector so a Core-only recovery cannot leave Mission watch
 * behind at run.input_required.
 */
async function projectRecoveredOwner(options: {
  readonly missionId: string;
  readonly guard: MissionControllerGuard;
  readonly executionIds: readonly string[];
  readonly executions: ExecutionStore;
  readonly mission: Pick<LocalHostRunMissionPort, "controller" | "append">;
  readonly redactor: RunRedactor;
}): Promise<void> {
  const snapshot = await options.mission.controller.readSnapshot({
    missionId: options.missionId,
  });
  const knownEventIds = new Set(snapshot.events.map((event) => event.eventId));
  const projector = createLocalHostMissionEventProjector({
    missionId: options.missionId,
    guard: options.guard,
    mission: options.mission,
    redactor: options.redactor,
    knownEventIds,
  });

  for (const executionId of new Set(options.executionIds)) {
    const events = await options.executions.readEvents(executionId);
    const pending = new Map<string, HumanInteractionRequestEnvelope>();
    const mappedEvents = events.map((event) =>
      mapExecutionEvent(event, options.missionId, executionId, pending),
    );
    let lastKnownIndex = -1;
    events.forEach((event, index) => {
      if (knownEventIds.has(event.eventId)) lastKnownIndex = index;
    });
    for (const event of mappedEvents.slice(lastKnownIndex + 1)) {
      await projector.append(event);
    }
    const terminal = await terminalFromRecoveredExecution({
      executions: options.executions,
      executionId,
      missionId: options.missionId,
      pending,
    });
    if (terminal !== undefined) await projector.appendTerminal(terminal);
  }
  await projector.flush();
}

async function terminalFromRecoveredExecution(options: {
  readonly executions: ExecutionStore;
  readonly executionId: string;
  readonly missionId: string;
  readonly pending: Map<string, HumanInteractionRequestEnvelope>;
}): Promise<LocalHostRunTerminal | undefined> {
  const execution = await options.executions.get(options.executionId);
  if (execution === undefined) return undefined;
  if (execution.status === "waiting") {
    const interaction = await readPendingInteraction(
      options.executions,
      options.executionId,
      options.missionId,
      options.pending,
    );
    return interaction === undefined
      ? undefined
      : {
          status: "input_required",
          executionId: options.executionId,
          interaction,
          ...(execution.usage === undefined ? {} : { usage: execution.usage }),
        };
  }
  if (execution.status === "succeeded") {
    return {
      status: "succeeded",
      executionId: options.executionId,
      result: toJsonValue(
        execution.output === undefined ? undefined : unwrapInvocationOutput(execution.output),
      ),
      ...(execution.usage === undefined ? {} : { usage: execution.usage }),
    };
  }
  if (execution.status === "failed") {
    return {
      status: "failed",
      executionId: options.executionId,
      error: executionError(execution.error),
      ...(execution.usage === undefined ? {} : { usage: execution.usage }),
    };
  }
  if (execution.status === "cancelled" || execution.status === "interrupted") {
    return {
      status: "interrupted",
      executionId: options.executionId,
      ...(execution.usage === undefined ? {} : { usage: execution.usage }),
    };
  }
  return undefined;
}

async function readActiveExpertTarget(
  sessions: ExpertSessionStore,
  missionId: string,
): Promise<MissionControlTargetResolution | undefined> {
  const state = await sessions.get(missionId);
  if (state?.activeExecutionId === undefined) return undefined;
  const prompt = (await sessions.listPrompts(missionId)).find(
    (candidate) =>
      candidate.executionId === state.activeExecutionId &&
      candidate.status === "running" &&
      candidate.mode === "enqueue",
  );
  return prompt === undefined
    ? undefined
    : { executionId: prompt.executionId, turnId: prompt.requestId };
}

async function readCurrentExecutionId(
  sessions: ExpertSessionStore,
  executions: ExecutionStore,
  missionId: string,
): Promise<string | undefined> {
  const session = await sessions.get(missionId);
  if (session?.activeExecutionId !== undefined) return session.activeExecutionId;
  if (session !== undefined) {
    const events = await sessions.listEvents(missionId);
    const lastQueueControl = events
      .toReversed()
      .find(
        (event) => event.type === "prompt.queue-paused" || event.type === "prompt.queue-resumed",
      );
    if (lastQueueControl?.type === "prompt.queue-paused") return undefined;
    for (const executionId of session.executionIds.toReversed()) {
      const candidate = await executions.get(executionId);
      if (candidate !== undefined && ["running", "waiting"].includes(candidate.status)) {
        return candidate.executionId;
      }
    }
  }
  const execution = await executions.get(missionId);
  return execution !== undefined && ["running", "waiting"].includes(execution.status)
    ? execution.executionId
    : undefined;
}

async function waitForExecution(
  executions: ExecutionStore,
  input: {
    readonly missionId: string;
    readonly executionId: string;
    readonly pollIntervalMs?: number | undefined;
  },
): Promise<MissionControlExecutionOutcome> {
  const pollIntervalMs = input.pollIntervalMs ?? 100;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw createIntegrationError({
      code: "INVALID_ARGUMENT",
      category: "usage",
      message: "Execution pollIntervalMs must be a finite positive number.",
    });
  }
  for (;;) {
    const execution = await executions.get(input.executionId);
    if (execution === undefined) {
      throw commandRejected(input.missionId, "execution_not_found");
    }
    if (execution.status === "waiting") {
      const interaction = await readPendingInteraction(
        executions,
        input.executionId,
        input.missionId,
        new Map(),
      );
      if (interaction !== undefined) {
        return {
          executionId: execution.executionId,
          status: execution.status,
          interaction: JsonValueSchema.parse(interaction),
          ...(execution.usage === undefined ? {} : { usage: execution.usage }),
        };
      }
    }
    if (isTerminalExecutionStatus(execution.status)) {
      if (execution.status === "succeeded") {
        return {
          executionId: execution.executionId,
          status: execution.status,
          result: toJsonValue(
            execution.output === undefined ? undefined : unwrapInvocationOutput(execution.output),
          ),
          ...(execution.usage === undefined ? {} : { usage: execution.usage }),
        };
      }
      if (execution.status === "failed") {
        return {
          executionId: execution.executionId,
          status: execution.status,
          error: executionError(execution.error),
          ...(execution.usage === undefined ? {} : { usage: execution.usage }),
        };
      }
      return {
        executionId: execution.executionId,
        status: execution.status,
        ...(execution.usage === undefined ? {} : { usage: execution.usage }),
      };
    }
    await delay(pollIntervalMs);
  }
}

function executionError(value: unknown) {
  const parsed = IntegrationErrorSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return createIntegrationError({
    code: "EXECUTION_FAILED",
    category: "execution",
    retryable: false,
    message: value instanceof Error ? value.message : "The execution failed.",
  });
}

function toJsonValue(value: unknown) {
  if (value === undefined) return null;
  const parsed = JsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : String(value);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function unrefDelay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function workspaceFromBinding(binding: MissionPinnedBinding): WorkspaceSelection {
  return {
    schemaVersion: "pragma.integration-workspace/v1",
    requestedPath: binding.workspace.canonicalPath,
    canonicalPath: binding.workspace.canonicalPath,
    displayName: basename(binding.workspace.canonicalPath) || binding.workspace.canonicalPath,
    identityHash: binding.workspace.identityHash,
    access: { exists: true, readable: true, writable: true },
    source: "mission",
  };
}

function assertExecutorMatchesBinding(
  descriptor: ExecutorDescriptor,
  binding: MissionPinnedBinding,
): void {
  if (
    descriptor.ref.kind !== binding.executor.ref.kind ||
    descriptor.ref.id !== binding.executor.ref.id ||
    descriptor.source !== binding.executor.source ||
    (binding.executor.source === "project" &&
      (descriptor.project?.projectId !== binding.executor.project.projectId ||
        descriptor.project.revision !== binding.executor.project.revision ||
        descriptor.project.fingerprint !== binding.executor.project.fingerprint))
  ) {
    throw createIntegrationError({
      code: "EXECUTOR_NOT_FOUND",
      category: "not_found",
      message: "The pinned executor revision is no longer available.",
    });
  }
}

async function sessionSupportsSteer(
  session: Pick<ExpertSession, "getState">,
  runtimes: RuntimeResolver,
): Promise<boolean> {
  return await sessionRecordSupportsSteer(await session.getState(), runtimes);
}

async function sessionRecordSupportsSteer(
  session: Awaited<ReturnType<ExpertSession["getState"]>>,
  runtimes: RuntimeResolver,
): Promise<boolean> {
  const rootContext = session.contexts[session.rootContextId];
  if (rootContext === undefined) return false;
  const resolved = await runtimes
    .resolve({ binding: rootContext.runtime, modelSelection: rootContext.modelSelection })
    .catch(() => undefined);
  return resolved?.adapter.descriptor.capabilities?.supportsSteer === true;
}

function isFlowDefinition(value: LocalHostCoreDefinition): value is FlowSpec | Flow {
  return "kind" in value && value.kind === "flow";
}

function commandRejected(missionId: string, reason: string) {
  return createIntegrationError({
    code: "COMMAND_REJECTED",
    category: "conflict",
    message: "The Mission command is not supported by the current execution.",
    details: { missionId, reason },
  });
}

function executionTargetChanged(missionId: string, expected: string, current: string) {
  return createIntegrationError({
    code: "COMMAND_REJECTED",
    category: "conflict",
    message: "The expected execution is no longer active.",
    details: {
      reason: "execution_target_changed",
      missionId,
      expectedExecutionId: expected,
      executionId: current,
    },
  });
}

function isIntegrationError(error: unknown): error is ReturnType<typeof createIntegrationError> {
  return (
    typeof error === "object" &&
    error !== null &&
    "schemaVersion" in error &&
    (error as { readonly schemaVersion?: unknown }).schemaVersion === "pragma.integration-error/v1"
  );
}
