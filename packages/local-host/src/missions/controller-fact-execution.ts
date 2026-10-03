import type {
  DurableExecutionStore,
  ExpertSessionStore,
  PragmaLoggerProvider,
  RuntimeResolver,
  UsageSink,
} from "@pragma/core";
import type { LocalHostCoreRunComposition } from "../core-run.ts";
import { createCoreRunExecutorPort } from "../core-run.ts";
import { createLocalHostCoreMissionControlAdapter } from "../core-control-adapter.ts";
import type { LocalHostCoreMissionControlAdapter } from "../core-control-adapter.ts";
import { createControllerRunMissionPort } from "../run.ts";
import type { MissionControllerStore } from "./controller/mission-controller-store.ts";
import type { MissionOwnerScope } from "./controller/owner-scope.ts";
import type { MissionPinnedBinding } from "./controller/pinned-binding.ts";
import type { MissionExecutionOwnerAccess } from "./execution-owner.ts";
import type { LocalHostNodeMissionCompiler } from "../node-mission-compiler.ts";
import type { LocalHostRunExecutorPort } from "../run.ts";

/** Historical controller facts are read directly; this port never invents an envelope. */
export interface LocalHostMissionControllerFactResources {
  readonly controller: MissionControllerStore;
  readonly hasEnvelope: (missionId: string) => Promise<boolean>;
  readonly resolveSessionId: (missionId: string) => Promise<string | undefined>;
  readonly resolveMissionBinding: (missionId: string) => Promise<MissionPinnedBinding | undefined>;
  readonly executors: LocalHostCoreRunComposition["executors"];
  readonly compiler?:
    Pick<LocalHostNodeMissionCompiler, "service" | "prepare" | "readiness"> | undefined;
  readonly createHostContextBindings?: LocalHostCoreRunComposition["createHostContextBindings"];
  readonly usageSink?: UsageSink | undefined;
  readonly memory?:
    | {
        linked(input: {
          missionId: string;
          executionId: string;
          projectId?: string;
        }): Promise<void>;
        recovering(missionId: string, executionId: string): Promise<void | (() => Promise<void>)>;
        admitting?(missionId: string, requestId: string): Promise<void | (() => Promise<void>)>;
        terminal(missionId: string, executionId: string, waiting?: boolean): Promise<void>;
        readonly release?: (() => Promise<void>) | undefined;
      }
    | undefined;
}

/** The canonical service owns both formats with the same Core boundaries and owner registry. */
export function createControllerFactExecutionPorts(options: {
  readonly pragmaHome: string;
  readonly ownerLifetime: "host" | "request";
  readonly runtimes: RuntimeResolver;
  readonly executions: DurableExecutionStore;
  readonly sessions: ExpertSessionStore;
  readonly ownerAccess: MissionExecutionOwnerAccess;
  readonly ownerScope?: MissionOwnerScope | undefined;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
  readonly resources: LocalHostMissionControllerFactResources;
  readonly onBackgroundFailure: (error: unknown) => void;
}): {
  readonly run: LocalHostRunExecutorPort;
  readonly control: LocalHostCoreMissionControlAdapter;
} {
  const { resources } = options;
  const hasPending = async (missionId: string) =>
    (await resources.controller.listOperations({ missionId })).some(
      (operation) => operation.state === "queued" || operation.state === "applying",
    );
  const completeResources = (missionId: string, executionId: string, waiting = false): void => {
    void resources.memory
      ?.terminal(missionId, executionId, waiting)
      .finally(async () => await resources.memory?.release?.())
      .catch(options.onBackgroundFailure);
  };
  const core = createCoreRunExecutorPort({
    pragmaHome: options.pragmaHome,
    runtimes: options.runtimes,
    executions: options.executions,
    sessions: options.sessions,
    ownerAccess: options.ownerAccess,
    usageSink: resources.usageSink,
    loggerProvider: options.loggerProvider,
    createHostContextBindings: resources.createHostContextBindings,
    executors: resources.executors,
    resolveSessionId: resources.resolveSessionId,
    createMissionExecutionOwnershipAssertion:
      options.ownerScope === undefined
        ? undefined
        : (missionId) => {
            const guard = options.ownerScope!.currentGuard(missionId);
            return async () => {
              if (guard === undefined)
                throw new Error(`Mission execution owner is unavailable: ${missionId}`);
              await options.ownerScope!.assertOwnership(missionId, guard);
            };
          },
  });
  const control = createLocalHostCoreMissionControlAdapter({
    pragmaHome: options.pragmaHome,
    runtimes: options.runtimes,
    executions: options.executions,
    sessions: options.sessions,
    ownerAccess: options.ownerAccess,
    usageSink: resources.usageSink,
    loggerProvider: options.loggerProvider,
    createHostContextBindings: resources.createHostContextBindings,
    createMissionExecutionOwnershipAssertion:
      options.ownerScope === undefined
        ? undefined
        : (missionId) => {
            const guard = options.ownerScope!.currentGuard(missionId);
            return async () => {
              if (guard === undefined)
                throw new Error(`Mission execution owner is unavailable: ${missionId}`);
              await options.ownerScope!.assertOwnership(missionId, guard);
            };
          },
    executors: resources.executors,
    compiler: resources.compiler,
    resolveSessionId: resources.resolveSessionId,
    resolveMissionBinding: resources.resolveMissionBinding,
    mission: createControllerRunMissionPort(resources.controller, {
      ownerScope: options.ownerScope,
    }),
    hasPendingMissionCommands: hasPending,
    assertMissionOwnership: async (missionId, guard) =>
      await options.ownerScope?.assertOwnership(missionId, guard),
    currentMissionGuard: (missionId) => options.ownerScope?.currentGuard(missionId),
    onPromptAdmitting: async (missionId, requestId) =>
      await resources.memory?.admitting?.(missionId, requestId),
    onExecutionAccepted: async ({ missionId, executionId }) => {
      await resources.memory?.linked({ missionId, executionId }).catch(options.onBackgroundFailure);
    },
    onOwnerRecovering: async (missionId) => {
      const sessionId = await resources.resolveSessionId(missionId);
      const state = sessionId === undefined ? undefined : await options.sessions.get(sessionId);
      const executionId = state?.executionIds.at(-1) ?? missionId;
      await resources.memory?.recovering(missionId, executionId);
    },
    ...(options.ownerLifetime === "request"
      ? {
          releaseMissionOwner: async (missionId, guard) => {
            await options.ownerScope?.assertOwnership(missionId, guard);
            if (await hasPending(missionId)) return;
            const sessionId = await resources.resolveSessionId(missionId);
            const session =
              sessionId === undefined ? undefined : await options.sessions.get(sessionId);
            const execution =
              session === undefined ? await options.executions.get(missionId) : undefined;
            await options.ownerScope?.assertOwnership(missionId, guard);
            const executionId = session?.executionIds.at(-1) ?? execution?.executionId;
            if (executionId !== undefined)
              completeResources(
                missionId,
                executionId,
                session?.lastStatus === "waiting" || execution?.status === "waiting",
              );
            await options.ownerScope?.release(missionId, guard);
          },
        }
      : {}),
  });
  const run: LocalHostRunExecutorPort = {
    resolve: core.resolve,
    ...(core.validateInput === undefined ? {} : { validateInput: core.validateInput }),
    start: async (input) => {
      const rollback = await resources.memory?.admitting?.(
        input.missionId,
        input.request.requestId,
      );
      const handle = await core.start(input).catch(async (error: unknown) => {
        if (rollback !== undefined) await rollback().catch(options.onBackgroundFailure);
        completeResources(input.missionId, input.request.requestId);
        throw error;
      });
      try {
        await resources.memory?.linked({
          missionId: input.missionId,
          executionId: handle.executionId,
          ...(input.request.project === undefined
            ? {}
            : { projectId: input.request.project.projectId }),
        });
      } catch (error) {
        await handle.cancel?.("Mission resource registration failed").catch(() => undefined);
        await handle.release?.().catch(() => undefined);
        completeResources(input.missionId, input.request.requestId);
        throw error;
      }
      void handle.result.then((terminal) => {
        completeResources(
          input.missionId,
          handle.executionId,
          terminal.status === "input_required",
        );
      }, options.onBackgroundFailure);
      return handle;
    },
    respond: core.respond,
  };
  return { run, control };
}
