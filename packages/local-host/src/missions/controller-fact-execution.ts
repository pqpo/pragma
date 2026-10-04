import type {
  DurableExecutionStore,
  ExpertSessionStore,
  PragmaLoggerProvider,
  RuntimeResolver,
  UsageSink,
} from "@pragma/core";
import type { LocalHostCoreRunComposition } from "../core-run.ts";
import type { MissionControllerStore } from "./controller/mission-controller-store.ts";
import type { MissionOwnerScope } from "./controller/owner-scope.ts";
import type { MissionPinnedBinding } from "./controller/pinned-binding.ts";
import type { MissionExecutionOwnerAccess } from "./execution-owner.ts";
import type { LocalHostNodeMissionCompiler } from "../node-mission-compiler.ts";

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

/** Map historical facts to resource ports. Lifecycle policy belongs to the execution service. */
export function createControllerFactRunComposition(options: {
  readonly pragmaHome: string;
  readonly runtimes: RuntimeResolver;
  readonly executions: DurableExecutionStore;
  readonly sessions: ExpertSessionStore;
  readonly ownerAccess: MissionExecutionOwnerAccess;
  readonly ownerScope?: MissionOwnerScope | undefined;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
  readonly resources: LocalHostMissionControllerFactResources;
  readonly onBackgroundFailure: (error: unknown) => void;
}): LocalHostCoreRunComposition {
  const { resources } = options;
  return {
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
    onBackgroundFailure: options.onBackgroundFailure,
    onPromptAdmitting: resources.memory?.admitting,
    onExecutionAccepted: async ({ missionId, executionId, request }) =>
      await resources.memory?.linked({
        missionId,
        executionId,
        ...(request.project === undefined ? {} : { projectId: request.project.projectId }),
      }),
    onExecutionCheckpointed: async ({ missionId, executionId }) => {
      await resources.memory?.terminal(missionId, executionId, true);
      await resources.memory?.release?.();
    },
    onExecutionTerminal: async ({ missionId, executionId }) => {
      await resources.memory?.terminal(missionId, executionId);
      await resources.memory?.release?.();
    },
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
  };
}
