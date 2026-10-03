import { basename } from "node:path";
import { z } from "zod";
import {
  MissionExecutionOwner,
  type MissionExecutionOwnerAccess,
} from "./missions/execution-owner.ts";
import {
  createLocalHostMissionCommandAdmission,
  type LocalHostMissionCommandAdmission,
} from "./mission-command-admission.ts";
import { createSqliteExecutionStore } from "./execution/sqlite-execution-store.ts";

import type {
  ExecutionStore,
  ExpertSession,
  ExpertSessionStore,
  ExpertTurn,
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
  createPragma,
  ExecutionController,
  ExpertAgentHumanRequestSchema,
  ExpertAgentHumanResponseSchema,
  FlowInterruptionUnconfirmedError,
  runtimeSupportsSteer,
  SteerNotDispatchedError,
  unwrapInvocationOutput,
} from "@pragma/core";
import {
  HumanInteractionResponseSchema,
  isTerminalExecutionStatus,
  JsonValueSchema,
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
  mapExecutionEvent,
  readPendingInteraction,
  toCoreResponse,
  type LocalHostCoreDefinition,
  type LocalHostCoreExecutorDefinition,
  type LocalHostCoreRunComposition,
} from "./core-run.ts";
import { createLocalHostMissionEventProjector } from "./mission-event-projector.ts";
import { dispatchMissionCommand } from "./missions/command-dispatcher.ts";
import type {
  MissionControlApplication,
  MissionControlExecutionOutcome,
  MissionControlTargetResolution,
} from "./missions/controller/mission-control.ts";
import type {
  MissionCommandConsumer,
  MissionControllerGuard,
} from "./missions/controller/mission-controller-store.ts";
import { MissionSemanticWritePendingError } from "./missions/controller/mission-controller-store.ts";
import {
  createPinnedBindingRecoveryError,
  type MissionPinnedBinding,
} from "./missions/controller/pinned-binding.ts";
import { createRunRedactor, type RunRedactor } from "./redaction.ts";
import type { LocalHostRunMissionPort, LocalHostRunTerminal } from "./run.ts";
import type { createLocalHostNodeMissionCompiler } from "./node-mission-compiler.ts";

const coreMissionControlFactory = Symbol("local-host.core-mission-control");
const humanResponseReceiptSchema = z.object({
  interactionId: z.string().min(1),
  requestId: z.string().min(1),
  response: ExpertAgentHumanResponseSchema,
});

export interface LocalHostCoreMissionControlAdapter {
  readonly [coreMissionControlFactory]: true;
  readonly bindApplication: (application: MissionControlApplication) => void;
  readonly consumer: MissionCommandConsumer;
  readonly assertAcquisitionAllowed: (
    missionId: string,
    purpose?: "execute" | "stop",
  ) => Promise<void>;
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
      readonly executor?: LocalHostCoreExecutorDefinition;
    }
  | {
      readonly kind: "flow";
      readonly execution: Pick<
        FlowExecution,
        "executionId" | "cancel" | "respondToHumanInteraction"
      >;
      readonly executor?: LocalHostCoreExecutorDefinition;
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
  readonly mission?: Pick<LocalHostRunMissionPort, "controller" | "append"> | undefined;
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
        readonly purpose?: "execute" | "stop" | undefined;
      }) => Promise<LocalHostCoreExecutorDefinition | undefined>);
  readonly assertMissionReady?:
    ((missionId: string, purpose?: "execute" | "stop") => Promise<void>) | undefined;
  readonly compiler?:
    | Pick<
        ReturnType<typeof createLocalHostNodeMissionCompiler>,
        "service" | "prepare" | "readiness"
      >
    | undefined;
  readonly resolveExecutionId?: ((missionId: string) => Promise<string | undefined>) | undefined;
  readonly resolveSessionId?: ((missionId: string) => Promise<string | undefined>) | undefined;
  readonly ownerAccess?: MissionExecutionOwnerAccess | undefined;
  /** Narrow R3 recovery port: returns a Core handle, never applies a command. */
  readonly recoverActiveOwner?:
    ((missionId: string) => Promise<LocalHostCoreActiveOwner>) | undefined;
  /** Narrow compile/Core port for stopping a cold Flow without running its graph. */
  readonly stopFlow?:
    | ((
        missionId: string,
        executionId: string,
        reason: string | undefined,
        signal: AbortSignal,
      ) => Promise<void>)
    | undefined;
  readonly admission?: LocalHostMissionCommandAdmission<Record<string, unknown>> | undefined;
  readonly resolveInteractionHandle?:
    | ((
        missionId: string,
        executionId: string,
      ) =>
        | Pick<ExpertTurn, "respondToHumanInteraction">
        | undefined
        | Promise<Pick<ExpertTurn, "respondToHumanInteraction"> | undefined>)
    | undefined;
  readonly executionSettlement?: ((missionId: string) => Promise<unknown> | undefined) | undefined;
  readonly runWithGuard?:
    | (<T>(
        missionId: string,
        guard: MissionControllerGuard,
        operation: () => Promise<T>,
      ) => Promise<T>)
    | undefined;
  readonly onCommandApplied?:
    ((command: MissionCommand, result: Record<string, unknown>) => Promise<void>) | undefined;
  readonly onApplicationBound?: ((application: MissionControlApplication) => void) | undefined;
  readonly onCommandOutcome?: MissionCommandConsumer["afterOutcome"];
  readonly resolveActiveOwner?:
    ((missionId: string) => Promise<LocalHostCoreActiveOwner | undefined>) | undefined;
  readonly resolveMissionBinding: (missionId: string) => Promise<MissionPinnedBinding | undefined>;
  /** Host lifecycle before recovering an owner that may resume Runtime work. */
  readonly onOwnerRecovering?: ((missionId: string) => Promise<void>) | undefined;
  /** Release the Mission lease after a recovered lower-level owner settles. */
  readonly releaseMissionOwner?: ((missionId: string) => Promise<void>) | undefined;
  /** Used to avoid releasing a lease while a newer Inbox item is arriving. */
  readonly hasPendingMissionCommands?: ((missionId: string) => Promise<boolean>) | undefined;
}): LocalHostCoreMissionControlAdapter {
  const executions =
    options.executions ?? createSqliteExecutionStore({ pragmaHome: options.pragmaHome });
  const sessions =
    options.sessions ??
    createFileExpertSessionStore({
      executions,
      ...(options.pragmaHome === undefined ? {} : { pragmaHome: options.pragmaHome }),
    });
  const owners = options.ownerAccess ?? new MissionExecutionOwner();
  const recoveredOwner = (missionId: string) =>
    owners.controlOwnerOrigin(missionId) === "recovered"
      ? owners.controlOwner(missionId)
      : undefined;
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
    purpose: "execute" | "stop" = "execute",
  ): Promise<LocalHostCoreExecutorDefinition> => {
    const workspace = workspaceFromBinding(binding);
    const candidate =
      typeof options.executors === "function"
        ? await options.executors({
            ref: binding.executor.ref,
            workspace,
            purpose,
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
    return { ...candidate, descriptor };
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

  const assertAcquisitionAllowed = async (
    missionId: string,
    purpose: "execute" | "stop" = "execute",
  ): Promise<void> => {
    await options.assertMissionReady?.(missionId, purpose);
    if (
      owners.controlOwner(missionId) !== undefined ||
      (await options.resolveActiveOwner?.(missionId)) !== undefined
    )
      return;
    if (options.recoverActiveOwner !== undefined) return;
    await resolveExecutor(await readBinding(missionId), purpose);
  };

  const recover = async (
    missionId: string,
    admissionOwned = false,
    preparedExecutor?: LocalHostCoreExecutorDefinition,
  ): Promise<CoreMissionOwner> => {
    const existing = owners.controlOwner(missionId);
    if (existing !== undefined) return existing;
    const active =
      owners.controlOwner(missionId) ?? (await options.resolveActiveOwner?.(missionId));
    if (active !== undefined) {
      owners.setControlOwner(missionId, active, "live");
      return active;
    }
    if (options.recoverActiveOwner !== undefined) {
      return await owners.recoverControlOwner(
        missionId,
        () => options.recoverActiveOwner!(missionId),
        { admission: "owned" },
      );
    }
    return await owners.recoverControlOwner(
      missionId,
      async () => {
        const binding = await readBinding(missionId);
        const executor = preparedExecutor ?? (await resolveExecutor(binding));
        assertExecutorMatchesBinding(executor.descriptor, binding);
        const app = await createControlApp({
          options,
          binding,
          executor,
          missionId,
          createApp,
        });
        await options.onOwnerRecovering?.(missionId);
        const owner = await recoverOwner({
          app,
          sessions,
          executions,
          missionId,
          executor,
        });
        return owner;
      },
      { admission: admissionOwned ? "owned" : "acquire" },
    );
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
      const owner = recoveredOwner(missionId);
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
          mission: options.mission!,
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
          mission: options.mission!,
          redactor,
        });
      }

      // Lower-level release is complete. Remove the recovered handle before
      // releasing the Mission lease so a concurrent command can reconstruct a
      // fresh owner; the callback performs its own final pending-item check.
      if (
        recoveredOwner(missionId) !== owner ||
        !owners.deleteControlOwnerIfCurrent(missionId, owner)
      )
        return;
      await options.releaseMissionOwner(missionId);
      return;
    }
  };

  const scheduleRecoveredOwnerSettlement = (
    missionId: string,
    guard: MissionControllerGuard,
  ): void => {
    if (options.releaseMissionOwner === undefined || !(recoveredOwner(missionId) !== undefined))
      return;
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
    if (recoveredOwner(missionId) !== undefined) return;
    if (options.resolveActiveOwner !== undefined) {
      const active = await options.resolveActiveOwner(missionId);
      if (active !== undefined) return;
    }
    if (await options.hasPendingMissionCommands?.(missionId)) return;
    await options.releaseMissionOwner(missionId);
  };

  const scheduleUnbackedMissionOwnerSettlement = (missionId: string): void => {
    if (options.releaseMissionOwner === undefined || recoveredOwner(missionId) !== undefined)
      return;
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
    const active =
      owners.controlOwner(input.missionId) ?? (await options.resolveActiveOwner?.(input.missionId));
    if (active?.kind === "flow") await assertStrictSteerSupported(input.missionId);
    const sessionId =
      active?.kind === "session"
        ? active.session.sessionId
        : ((await options.resolveSessionId?.(input.missionId)) ?? input.missionId);
    const current = await readActiveExpertTarget(sessions, sessionId);
    if (current !== undefined) await assertStrictSteerSupported(input.missionId);
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
    const active =
      owners.controlOwner(input.missionId) ?? (await options.resolveActiveOwner?.(input.missionId));
    const sessionId =
      active?.kind === "session"
        ? active.session.sessionId
        : ((await options.resolveSessionId?.(input.missionId)) ?? input.missionId);
    const current =
      active?.kind === "flow"
        ? active.execution.executionId
        : await readCurrentExecutionId(
            sessions,
            executions,
            sessionId,
            (await options.resolveExecutionId?.(input.missionId)) ?? input.missionId,
          );
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
    const active =
      owners.controlOwner(missionId) ?? (await options.resolveActiveOwner?.(missionId));
    if (active !== undefined) {
      if (active.kind === "flow") {
        throw commandRejected(missionId, "steer_not_supported");
      }
      if (!(await sessionSupportsSteer(active.session, options.runtimes))) {
        throw commandRejected(missionId, "steer_not_supported");
      }
      return;
    }
    const execution = await executions.get(
      (await options.resolveExecutionId?.(missionId)) ?? missionId,
    );
    if (execution?.kind === "flow") throw commandRejected(missionId, "steer_not_supported");
    const sessionId = (await options.resolveSessionId?.(missionId)) ?? missionId;
    const persistedSession = await sessions.get(sessionId);
    if (persistedSession !== undefined) {
      if (!(await sessionRecordSupportsSteer(persistedSession, options.runtimes)))
        throw commandRejected(missionId, "steer_not_supported");
      return;
    }
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
    if (command.kind === "steer" || command.kind === "queue.steer") {
      const active =
        owners.controlOwner(command.missionId) ??
        (await options.resolveActiveOwner?.(command.missionId));
      const sessionId =
        active?.kind === "session"
          ? active.session.sessionId
          : ((await options.resolveSessionId?.(command.missionId)) ?? command.missionId);
      const duplicate = (await sessions.listPrompts(sessionId)).find(
        (prompt) =>
          prompt.requestId ===
            (command.payload.kind === "queue.steer"
              ? command.payload.requestId
              : command.request.requestId) &&
          (command.kind === "queue.steer"
            ? prompt.mode === "enqueue" && prompt.deliveryAttempt?.kind === "queue_steer"
            : prompt.mode === "steer" && prompt.deliveryAttempt?.kind === "strict_steer") &&
          prompt.status === "succeeded" &&
          prompt.deliveryAttempt?.state === "confirmed",
      );
      if (duplicate !== undefined) return;
    }
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

  const prepareCompilation = async (missionId: string, owner: CoreMissionOwner) => {
    const compiler = options.compiler;
    if (compiler === undefined) return undefined;
    const binding = await readBinding(missionId);
    const executor = owner.executor;
    if (executor?.compilation === undefined)
      throw commandRejected(missionId, "executor_compilation_identity_required");
    const scope = compiler.service.createRequestScope({
      id: missionId,
      project:
        binding.executor.source === "project"
          ? { id: binding.executor.project.projectId, revision: binding.executor.project.revision }
          : { id: "built_in", revision: 1 },
      executor: {
        kind: binding.executor.ref.kind,
        ref: `${binding.executor.ref.kind}:${binding.executor.ref.id}`,
        name: executor.descriptor.name,
      },
      workspace: { path: binding.workspace.canonicalPath },
      contextMounts: [],
    });
    const prepared = await compiler.prepare(scope, {
      hasOwner: true,
      ...executor.compilation,
    });
    // Node has no durable successor Session pointer yet. Preserve the original
    // Session and reject a changed authority instead of executing its old tools.
    if (!prepared.cacheHit || prepared.definitionChanged)
      throw commandRejected(missionId, "executor_environment_changed_requires_successor");
    return prepared;
  };

  const defaultAdmission = createLocalHostMissionCommandAdmission({
    getMission: async (id: string) => {
      const active = owners.controlOwner(id);
      const kind =
        active?.kind === "flow"
          ? "flow"
          : active?.kind === "session"
            ? "expert"
            : ((await executions.get(id))?.kind ??
              (await options.resolveMissionBinding(id))?.executor.ref.kind ??
              "expert");
      return { id, lifecycleStatus: "active", executor: { kind }, execution: true };
    },
    admit: (id, operation) => owners.admit(id, operation),
    withController: async (_id, operation) => await operation(),
    settleTerminal: async () => false,
    contextBindingsChanging: () => false,
    successorRequired: () => false,
    hasActive: () => true,
    session: (id) => {
      const owner = owners.controlOwner(id);
      return owner?.kind === "session" ? owner.session : undefined;
    },
    createPreparationScope: (mission) => {
      if (options.compiler === undefined) return undefined;
      const owner = owners.controlOwner(mission.id);
      return (async () => {
        const actualOwner = owner ?? (await options.resolveActiveOwner?.(mission.id));
        if (actualOwner !== undefined) {
          if (owner === undefined) owners.setControlOwner(mission.id, actualOwner, "live");
          await prepareCompilation(mission.id, actualOwner);
          return { authorityChecked: true, checkedOwner: actualOwner, executor: undefined };
        }
        if (options.recoverActiveOwner !== undefined || typeof options.executors !== "function")
          return { authorityChecked: false, checkedOwner: undefined, executor: undefined };
        // Default catalog resolution already validates readiness and compiles
        // against one pinned Revision scope. Keep that result for this request's
        // recovery instead of resolving and immediately preparing it again.
        const executor = await resolveExecutor(await readBinding(mission.id));
        if (executor.compilation === undefined)
          throw commandRejected(mission.id, "executor_compilation_identity_required");
        return { authorityChecked: true, checkedOwner: undefined, executor };
      })();
    },
    assertReady: async (_mission, scope) => {
      await scope;
    },
    startInitialRun: async () => undefined,
    prepare: async (mission, _input, _acceptedAt, scope) => {
      const preparation = await scope;
      const owner = await recover(mission.id, true, preparation?.executor);
      if (owner.kind !== "session") throw commandRejected(mission.id, "send_not_supported");
      if (
        preparation?.authorityChecked !== true ||
        (preparation.checkedOwner !== undefined
          ? owner !== preparation.checkedOwner
          : owner.executor !== preparation.executor)
      )
        await prepareCompilation(mission.id, owner);
      return {
        session: owner.session,
        definitionChanged: false,
        contextStoresChanged: false,
        createSession: async () => owner.session,
        rememberSession: () => undefined,
      };
    },
    forgetSession: () => undefined,
    projectAccepted: async ({ mission, prepared, turn, requestedMode }) => {
      if (options.compiler !== undefined) {
        let invalidated = false;
        const invalidate = () => {
          if (invalidated) return;
          invalidated = true;
          options.compiler!.readiness.invalidate();
        };
        void turn.result.catch(invalidate);
        void turn.settled
          .then(async () => {
            if ((await executions.get(turn.executionId))?.status === "failed") invalidate();
          })
          .catch(invalidate);
      }
      const queue = await prepared.session.getPromptQueue();
      const queueState = await prepared.session.getPromptQueueState();
      const queuedPosition = queue
        .filter((prompt) => prompt.mode === "enqueue" && prompt.status === "queued")
        .findIndex((prompt) => prompt.requestId === turn.requestId);
      return {
        missionId: mission.id,
        executionId: turn.executionId,
        turnId: turn.requestId,
        mode: requestedMode,
        queueState: queueState.state,
        ...(queuedPosition < 0 ? {} : { queuePosition: queuedPosition + 1 }),
      };
    },
  });
  const send = options.admission ?? defaultAdmission;

  const readResponseReceipt = async (
    command: MissionCommand,
  ): Promise<Record<string, unknown> | undefined> => {
    if (command.payload.kind !== "respond" || command.target?.interactionId === undefined)
      return undefined;
    const interactionId = command.target.interactionId;
    const checked = new Set<string>();
    let originalInteractionFound = false;
    const read = async (executionId: string | undefined) => {
      if (executionId === undefined || checked.has(executionId)) return undefined;
      checked.add(executionId);
      const events = await executions.readEvents(executionId);
      const requested = events.find(
        (event) =>
          event.type === "human.requested" &&
          typeof event.data === "object" &&
          event.data !== null &&
          "interactionId" in event.data &&
          event.data.interactionId === interactionId,
      );
      if (requested !== undefined) {
        z.object({
          interactionId: z.string().min(1),
          request: ExpertAgentHumanRequestSchema,
        }).parse(requested.data);
        originalInteractionFound = true;
      }
      const responded = events.find((event) => {
        if (event.type !== "human.responded") return false;
        const data = event.data;
        return (
          typeof data === "object" &&
          data !== null &&
          "interactionId" in data &&
          data.interactionId === interactionId
        );
      });
      if (responded === undefined) return undefined;
      if (requested === undefined)
        throw new Error(`Human response receipt has no original request: ${interactionId}.`);
      const receipt = humanResponseReceiptSchema.parse(responded.data);
      if (receipt.requestId !== command.request.requestId)
        throw createIntegrationError({
          code: "INTERACTION_NOT_PENDING",
          category: "conflict",
          message: "Human interaction was already answered by another request.",
          details: { missionId: command.missionId, interactionId },
        });
      return { missionId: command.missionId, executionId, interactionId };
    };
    // Reconcile receipts before opening a Session or activating a Flow. A
    // terminal execution can acknowledge its durable response without recovery.
    const targetIds =
      command.target.executionId === undefined
        ? [await options.resolveExecutionId?.(command.missionId), command.missionId]
        : [command.target.executionId];
    for (const id of targetIds) {
      const receipt = await read(id);
      if (receipt !== undefined) return receipt;
      if (originalInteractionFound) return undefined;
    }
    // An explicitly pinned target is authoritative, including the absence of a
    // receipt. Normal replies must not scan historical Session turns.
    if (command.target.executionId !== undefined) return undefined;
    const active =
      owners.controlOwner(command.missionId) ??
      (await options.resolveActiveOwner?.(command.missionId));
    if (active?.kind === "flow") return undefined;
    const sessionId =
      active?.session.sessionId ??
      (await options.resolveSessionId?.(command.missionId)) ??
      command.missionId;
    const session =
      active?.kind === "session" ? await active.session.getState() : await sessions.get(sessionId);
    for (const id of session?.executionIds.toReversed() ?? []) {
      const receipt = await read(id);
      if (receipt !== undefined) return receipt;
    }
    return undefined;
  };

  const adapter: LocalHostCoreMissionControlAdapter = {
    [coreMissionControlFactory]: true,
    bindApplication: (application) => options.onApplicationBound?.(application),
    assertAcquisitionAllowed,
    resolveStrictTarget,
    resolveExecutionTarget,
    recoverMission,
    waitExecution: async (input) => await waitForExecution(executions, input),
    release: async (missionId) => {
      const owner = recoveredOwner(missionId);
      if (owner === undefined) return;
      if (owner.kind === "session") {
        await owner.session.releaseAfterTerminal();
      }
      owners.deleteControlOwnerIfCurrent(missionId, owner);
    },
    releaseAfterHumanCheckpoint: async (missionId, guard) => {
      const owner = recoveredOwner(missionId);
      if (owner === undefined) return;
      const executionIds =
        owner.kind === "session" ? (await owner.session.getState()).executionIds : [missionId];
      await projectRecoveredOwner({
        missionId,
        guard,
        executionIds,
        executions,
        mission: options.mission!,
        redactor,
      });
      if (owner.kind === "session") {
        await owner.session.releaseAfterHumanCheckpoint();
      }
      owners.deleteControlOwnerIfCurrent(missionId, owner);
    },
    consumer: {
      validateStrictTarget,
      async apply({ command, guard, signal }) {
        if (signal.aborted)
          throw createIntegrationError({
            code: "COMMAND_RESULT_TIMEOUT",
            category: "conflict",
            message: "Mission command application was cancelled before dispatch.",
            details: { missionId: command.missionId, commandId: command.commandId },
          });
        // The first check happens before Runtime work. Repeat it immediately
        // before the Core call so a target change in the intervening window
        // cannot turn strict steer into an enqueue or another target.
        const execute = async () => {
          await validateStrictTarget({ command, guard });
          let result: Record<string, unknown>;
          const receipt = await readResponseReceipt(command);
          if (receipt !== undefined) {
            result = receipt;
          } else if (
            (command.kind === "send" || command.kind === "steer") &&
            (command.payload.kind === "send" || command.payload.kind === "steer")
          ) {
            result = await send({
              id: command.missionId,
              signal,
              content: command.payload.input.prompt,
              requestId: command.request.requestId,
              requestedAt: command.request.requestedAt,
              mode: command.kind === "steer" ? "steer" : "enqueue",
              attachments: command.payload.input.attachments,
              ...(command.target === undefined ? {} : { target: command.target }),
            });
          } else {
            result = await applyCoreMissionCommand({
              command,
              executions,
              recover,
              resolveExecutionId: options.resolveExecutionId,
              stopFlow: async (executionId, reason) => {
                try {
                  if (options.stopFlow !== undefined) {
                    await options.stopFlow(command.missionId, executionId, reason, signal);
                  } else {
                    const binding = await readBinding(command.missionId);
                    const executor = await resolveExecutor(binding, "stop");
                    if (!isFlowDefinition(executor.definition))
                      throw commandRejected(command.missionId, "flow_definition_required");
                    const app = await createControlApp({
                      options,
                      binding,
                      executor,
                      missionId: command.missionId,
                      createApp,
                    });
                    await app.flows.stop(executor.definition, { executionId, reason, signal });
                  }
                  if (owners instanceof MissionExecutionOwner)
                    owners.clearControlIssue(command.missionId);
                } catch (error: unknown) {
                  if (error instanceof FlowInterruptionUnconfirmedError) {
                    if (owners instanceof MissionExecutionOwner)
                      owners.setControlIssue(command.missionId, {
                        state: "interrupt_uncertain",
                        reasonCode: "MISSION_INTERRUPT_UNCERTAIN",
                        observedAt: new Date().toISOString(),
                      });
                    options.loggerProvider
                      ?.createLogger({ component: "local-host.mission-control" })
                      .warn(
                        "mission.interrupt_native_stop_uncertain",
                        "Native Flow interruption was not confirmed.",
                        {
                          missionId: command.missionId,
                          executionId,
                          code: "MISSION_INTERRUPT_UNCERTAIN",
                          nativeStopCode: error.code,
                        },
                      );
                    throw new MissionSemanticWritePendingError({ cause: error });
                  }
                  throw error;
                }
              },
              retainedOwner:
                owners.controlOwner(command.missionId) ??
                (await options.resolveActiveOwner?.(command.missionId)),
              resolveInteractionHandle: options.resolveInteractionHandle,
              interrupt: async (owner, current, reason) => {
                const stop =
                  owner.kind === "session"
                    ? owner.session.cancelPromptQueue(reason ?? "Stopped and cleared by user.")
                    : owner.execution.cancel(reason ?? "Interrupted by user.");
                const cancellation = await settleWithin(stop, 5_000);
                const pending = options.executionSettlement?.(command.missionId);
                const settlement =
                  pending === undefined
                    ? { status: "fulfilled" as const }
                    : await settleWithin(pending, 30_000);
                if (cancellation.status !== "fulfilled" || settlement.status !== "fulfilled") {
                  if (owners instanceof MissionExecutionOwner)
                    owners.setControlIssue(command.missionId, {
                      state: "interrupt_uncertain",
                      reasonCode: "MISSION_INTERRUPT_UNCERTAIN",
                      observedAt: new Date().toISOString(),
                    });
                  const persisted = await executions.get(current);
                  if (persisted !== undefined && !isTerminalExecutionStatus(persisted.status))
                    await new ExecutionController(current, executions).cancel(
                      "Forced Mission interruption after settlement timeout.",
                    );
                  owners.deleteControlOwnerIfCurrent(command.missionId, owner);
                  options.loggerProvider
                    ?.createLogger({ component: "local-host.mission-control" })
                    .warn(
                      "mission.interrupt_settlement_uncertain",
                      "Mission interruption did not settle cooperatively.",
                      {
                        missionId: command.missionId,
                        executionId: current,
                        cancellation: cancellation.status,
                        settlement: settlement.status,
                        code: "MISSION_INTERRUPT_UNCERTAIN",
                      },
                    );
                } else if (owners instanceof MissionExecutionOwner)
                  owners.clearControlIssue(command.missionId);
              },
            });
          }
          if (options.onCommandApplied !== undefined)
            await options.onCommandApplied(command, result).catch((error: unknown) => {
              throw error instanceof MissionSemanticWritePendingError
                ? error
                : new MissionSemanticWritePendingError({ cause: error });
            });
          return { result };
        };
        return options.runWithGuard === undefined
          ? await execute()
          : await options.runWithGuard(command.missionId, guard, execute);
      },
      async afterOutcome(outcome) {
        const { command, guard } = outcome;
        await options.onCommandOutcome?.(outcome);
        if (recoveredOwner(command.missionId) !== undefined) {
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
      ...(options.executor.environment === undefined
        ? {}
        : { environment: options.executor.environment }),
    }),
    executor: options.executor,
  };
}

async function createControlApp(options: {
  readonly options: Parameters<typeof createLocalHostCoreMissionControlAdapter>[0];
  readonly binding: MissionPinnedBinding;
  readonly executor: LocalHostCoreExecutorDefinition;
  readonly missionId: string;
  readonly createApp: (hostContextBindings?: HostContextBindings) => PragmaApp;
}): Promise<PragmaApp> {
  if (options.options.createHostContextBindings === undefined) {
    return options.createApp(options.options.hostContextBindings);
  }
  const executor = options.executor;
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

async function applyCoreMissionCommand(options: {
  readonly command: MissionCommand;
  readonly executions: ExecutionStore;
  readonly recover: (missionId: string) => Promise<CoreMissionOwner>;
  readonly resolveExecutionId?: ((missionId: string) => Promise<string | undefined>) | undefined;
  readonly stopFlow: (executionId: string, reason: string | undefined) => Promise<void>;
  readonly retainedOwner?: CoreMissionOwner | undefined;
  readonly resolveInteractionHandle?:
    | ((
        missionId: string,
        executionId: string,
      ) =>
        | Pick<ExpertTurn, "respondToHumanInteraction">
        | undefined
        | Promise<Pick<ExpertTurn, "respondToHumanInteraction"> | undefined>)
    | undefined;
  readonly interrupt: (
    owner: CoreMissionOwner,
    executionId: string,
    reason?: string,
  ) => Promise<void>;
}): Promise<Record<string, unknown>> {
  const { command } = options;
  // Reject unsupported Flow mutations before recovery. Recovering a Flow can
  // allocate a live Core owner, so a rejected send/queue command must not
  // create that side effect merely to discover the executor kind.
  const persistedExecution =
    options.retainedOwner === undefined
      ? await options.executions.get(
          (await options.resolveExecutionId?.(command.missionId)) ?? command.missionId,
        )
      : undefined;
  if (
    (options.retainedOwner?.kind === "flow" || persistedExecution?.kind === "flow") &&
    command.payload.kind !== "interrupt" &&
    command.payload.kind !== "respond"
  ) {
    throw commandRejected(command.missionId, `${command.kind.replaceAll(".", "_")}_not_supported`);
  }
  if (
    options.retainedOwner === undefined &&
    persistedExecution?.kind === "flow" &&
    command.payload.kind === "interrupt"
  ) {
    const target = command.target?.executionId;
    if (target !== undefined && target !== persistedExecution.executionId)
      throw executionTargetChanged(command.missionId, target, persistedExecution.executionId);
    await options.stopFlow(persistedExecution.executionId, command.payload.reason);
    return {
      missionId: command.missionId,
      executionId: persistedExecution.executionId,
      targetStatus: "interrupted",
    };
  }
  const owner = options.retainedOwner ?? (await options.recover(command.missionId));
  if (owner.kind === "flow") {
    if (command.payload.kind === "interrupt") {
      const target = command.target?.executionId;
      if (target !== undefined && target !== owner.execution.executionId) {
        throw executionTargetChanged(command.missionId, target, owner.execution.executionId);
      }
      await options.interrupt(owner, owner.execution.executionId, command.payload.reason);
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

  return await dispatchMissionCommand(command, {
    async send(command) {
      throw commandRejected(command.missionId, "send_requires_admission");
    },
    async steer(command) {
      throw commandRejected(command.missionId, "steer_requires_admission");
    },
    async respond(command) {
      return await applySessionResponse(
        owner.session,
        options.executions,
        command,
        options.resolveInteractionHandle,
      );
    },
    async interrupt(command) {
      const state = await owner.session.getState();
      const current = state.activeExecutionId;
      const expected = command.target?.executionId;
      if (current === undefined) {
        const previousId = state.executionIds.at(-1);
        const previous =
          previousId === undefined ? undefined : await options.executions.get(previousId);
        if (
          previous !== undefined &&
          (previous.status === "cancelled" || previous.status === "interrupted") &&
          (expected === undefined || expected === previous.executionId)
        ) {
          return {
            missionId: command.missionId,
            executionId: previous.executionId,
            targetStatus: "interrupted",
          };
        }
        if (expected === undefined || !state.executionIds.includes(expected)) {
          throw commandRejected(command.missionId, "no_active_execution");
        }
        await options.interrupt(owner, expected, command.payload.reason);
        return {
          missionId: command.missionId,
          executionId: expected,
          targetStatus: "interrupted",
        };
      }
      if (expected !== undefined && expected !== current) {
        throw executionTargetChanged(command.missionId, expected, current);
      }
      await options.interrupt(owner, current, command.payload.reason);
      return {
        missionId: command.missionId,
        executionId: current,
        targetStatus: "interrupted",
      };
    },
    async "queue.remove"(command) {
      try {
        await owner.session.removeQueuedPrompt(command.payload.requestId);
      } catch {
        throw commandRejected(command.missionId, "queue_item_not_queued");
      }
      return { missionId: command.missionId, requestId: command.payload.requestId, changed: true };
    },
    async "queue.resume"(command) {
      const before = await owner.session.getPromptQueueState();
      await owner.session.resumePromptQueue({ recovery: command.payload.recovery });
      return {
        missionId: command.missionId,
        changed: before.state === "paused",
        state: before.state === "paused" ? "running" : before.state,
      };
    },
    async "queue.steer"(command) {
      try {
        const turn = await owner.session.steerQueuedPrompt(
          command.payload.requestId,
          command.target?.executionId === undefined || command.target.turnId === undefined
            ? undefined
            : {
                target: { executionId: command.target.executionId, turnId: command.target.turnId },
              },
        );
        return {
          missionId: command.missionId,
          executionId: turn.executionId,
          turnId: turn.requestId,
          requestId: command.payload.requestId,
          mode: "steer",
        };
      } catch (error) {
        if (isIntegrationError(error)) throw error;
        if (error instanceof SteerNotDispatchedError && error.reason === "target_changed") {
          throw createIntegrationError({
            code: "STEER_TARGET_CHANGED",
            category: "conflict",
            message: "The active execution changed while steering the queued prompt.",
            details: { missionId: command.missionId },
          });
        }
        throw createIntegrationError({
          code: "COMMAND_REJECTED",
          category: "conflict",
          message:
            error instanceof Error ? error.message : "The queued prompt could not be steered.",
          details: { missionId: command.missionId, reason: "queue_item_not_steerable" },
        });
      }
    },
    async "queue.try-steer"(command) {
      try {
        const attempt = await owner.session.attemptQueuedPromptSteer(command.payload.requestId);
        return attempt.outcome === "steered"
          ? {
              missionId: command.missionId,
              executionId: attempt.turn.executionId,
              requestId: command.payload.requestId,
              queueSteer: {
                outcome: "steered",
                executionId: attempt.turn.executionId,
              },
            }
          : {
              missionId: command.missionId,
              requestId: command.payload.requestId,
              queueSteer: attempt,
            };
      } catch (error) {
        if (isIntegrationError(error)) throw error;
        throw createIntegrationError({
          code: "COMMAND_REJECTED",
          category: "conflict",
          message:
            error instanceof Error ? error.message : "The queued prompt could not be steered.",
          details: { missionId: command.missionId, reason: "queue_item_not_steerable" },
        });
      }
    },
  });
}

async function applySessionResponse(
  session: ExpertSession,
  executions: ExecutionStore,
  command: MissionCommand,
  resolveHandle?: (
    missionId: string,
    executionId: string,
  ) =>
    | Pick<ExpertTurn, "respondToHumanInteraction">
    | undefined
    | Promise<Pick<ExpertTurn, "respondToHumanInteraction"> | undefined>,
): Promise<Record<string, unknown>> {
  const interactionId = command.target?.interactionId;
  if (interactionId === undefined) throw commandRejected(command.missionId, "interaction_required");
  if (command.payload.kind !== "respond") {
    throw commandRejected(command.missionId, "respond_payload_required");
  }
  const state = await session.getState();
  const candidates = [
    ...new Set(
      [
        command.target?.executionId,
        state.activeExecutionId,
        ...state.executionIds.toReversed(),
      ].filter((id): id is string => id !== undefined),
    ),
  ];
  let turns: Awaited<ReturnType<ExpertSession["listTurns"]>> | undefined;
  for (const executionId of candidates) {
    const envelope = await readPendingInteraction(
      executions,
      executionId,
      command.missionId,
      new Map(),
      interactionId,
    ).catch(() => undefined);
    if (envelope === undefined) continue;
    let turn = await resolveHandle?.(command.missionId, executionId);
    if (turn === undefined) {
      turns ??= await session.listTurns();
      turn = turns.find((candidate) => candidate.executionId === executionId);
    }
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
  execution: Pick<FlowExecution, "executionId" | "cancel" | "respondToHumanInteraction">,
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
  readonly mission?: Pick<LocalHostRunMissionPort, "controller" | "append"> | undefined;
  readonly redactor: RunRedactor;
}): Promise<void> {
  const snapshot = await options.mission!.controller.readSnapshot({
    missionId: options.missionId,
  });
  const knownEventIds = new Set(snapshot.events.map((event) => event.eventId));
  const projector = createLocalHostMissionEventProjector({
    missionId: options.missionId,
    guard: options.guard,
    mission: options.mission!,
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
  flowExecutionId = missionId,
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
  const execution = await executions.get(flowExecutionId);
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
  return resolved === undefined ? false : await runtimeSupportsSteer(resolved.adapter);
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

async function settleWithin(
  operation: Promise<unknown>,
  milliseconds: number,
): Promise<{ readonly status: "fulfilled" | "rejected" | "timed_out" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return await Promise.race([
    operation.then(
      () => ({ status: "fulfilled" as const }),
      () => ({ status: "rejected" as const }),
    ),
    new Promise<{ readonly status: "timed_out" }>((resolve) => {
      timer = setTimeout(() => resolve({ status: "timed_out" }), milliseconds);
      timer.unref();
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
