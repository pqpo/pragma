import type { PragmaLogger } from "@pragma/core";
import {
  createMissionControlApplication,
  type MissionControlClient,
} from "./controller/mission-control.ts";
import {
  createControllerRunMissionPort,
  createLocalHostRunApplication,
  type LocalHostRunExecutorPort,
} from "../run.ts";
import {
  createLocalHostMissionExecutionService,
  type LocalHostMissionExecutionServiceOptions,
  type LocalHostMissionExecutionService,
} from "./execution-service.ts";
import { createLocalHostMissionExecutionRunPort } from "./execution-run-port.ts";
import type { LocalHostMissionControllerComposition } from "./controller/composition.ts";
import type { MissionControllerGuard } from "./controller/mission-controller-store.ts";
import { MissionExecutionOwner } from "./execution-owner.ts";
import type { MissionExecutionUseCases } from "./mission-execution-use-cases.ts";

/** Concrete resources may vary by Host; command and execution policy cannot. */
export interface LocalHostMissionApplicationOptions {
  readonly execution: LocalHostMissionExecutionServiceOptions;
  readonly closeResources?: (() => Promise<void>) | undefined;
  readonly lifecycle: LocalHostMissionControllerComposition;
  readonly client: MissionControlClient;
  readonly logger?: PragmaLogger | undefined;
  readonly resolveExecutor: LocalHostRunExecutorPort["resolve"];
  readonly beforeStart?: LocalHostRunExecutorPort["assertStartAllowed"] | undefined;
  readonly assertMission?: ((missionId: string) => Promise<void>) | undefined;
  readonly onOwnerStartError?:
    | ((input: { readonly missionId: string; readonly error: unknown }) => Promise<void> | void)
    | undefined;
}

export type LocalHostMissionApplication = Omit<
  LocalHostMissionExecutionService,
  | "missionControl"
  | "startLocalHostRun"
  | "assertLocalHostRunAllowed"
  | "validateLocalHostRunInput"
  | "resumeLocalHostMission"
> & {
  dispose(): Promise<void>;
  readonly integration: {
    readonly run: ReturnType<typeof createLocalHostRunApplication>;
    readonly missionControl: {
      readonly commands: ReturnType<typeof createMissionControlApplication>;
      readonly resume: MissionExecutionUseCases["resumeLocalHostMission"];
    };
  };
};

const canonicalMissionApplications = new WeakSet<object>();
export function isLocalHostMissionApplication(
  value: unknown,
): value is LocalHostMissionApplication {
  return typeof value === "object" && value !== null && canonicalMissionApplications.has(value);
}

/** The sole Desktop/CLI composition of the Mission execution and command kernel. */
export function createLocalHostMissionApplication(
  options: LocalHostMissionApplicationOptions,
): LocalHostMissionApplication {
  const { controller, ownerScope } = options.lifecycle;
  const executionOwner = options.execution.executionOwner ?? new MissionExecutionOwner();
  const service = createLocalHostMissionExecutionService({
    ...options.execution,
    ownerScope,
    executionOwner,
  });
  const control = service.missionControl;
  const commands = createMissionControlApplication({
    controller,
    ownerScope,
    client: options.client,
    logger: options.logger,
    consumer: control.consumer,
    assertMission: options.assertMission,
    assertAcquisitionAllowed: control.assertAcquisitionAllowed,
    resolveStrictTarget: control.resolveStrictTarget,
    resolveExecutionTarget: control.resolveExecutionTarget,
    waitExecution: control.waitExecution,
    onOwnerStartError: options.onOwnerStartError,
  });
  const sharedExecutors = createLocalHostMissionExecutionRunPort(service, options.resolveExecutor);
  const run = createLocalHostRunApplication({
    executors: {
      ...sharedExecutors,
      assertStartAllowed: async (input) => {
        await options.beforeStart?.(input);
        await sharedExecutors.assertStartAllowed?.(input);
      },
    },
    mission: createControllerRunMissionPort(controller, { ownerScope }),
    commandConsumer: control.consumer,
  });
  control.bindApplication(commands);
  const pendingLeaseReleases = new Map<string, MissionControllerGuard>();
  let disposing: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (disposing !== undefined) return disposing;
    disposing = (async () => {
      const errors: unknown[] = [];
      let retainedRuntimeOwner = false;
      const ids = new Set([
        ...executionOwner.missionIds(),
        ...ownerScope.ownedMissionIds(),
        ...pendingLeaseReleases.keys(),
      ]);
      for (const id of ids) {
        try {
          await service.stopLocalController(id);
        } catch (error) {
          errors.push(error);
        }
        // Bounded stop can return while Native teardown is still pending. Its
        // owner and lease must remain until the exact Runtime has stopped.
        if (
          executionOwner.controlOwner(id) !== undefined ||
          executionOwner.session(id) !== undefined ||
          executionOwner.active(id) !== undefined
        ) {
          retainedRuntimeOwner = true;
          errors.push(new Error(`Mission ${id} retained its Runtime owner during shutdown.`));
          continue;
        }
        const retryGuard = pendingLeaseReleases.get(id);
        const guard = retryGuard ?? ownerScope.currentGuard(id);
        try {
          if (retryGuard !== undefined)
            await controller.release({ missionId: id, guard: retryGuard });
          else await ownerScope.release(id, guard);
          pendingLeaseReleases.delete(id);
        } catch (error) {
          // A successor may already own an expired/previously released claim.
          // Never revoke it while retrying this application's old release.
          if (
            retryGuard !== undefined &&
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "MISSION_FENCING_REJECTED"
          )
            pendingLeaseReleases.delete(id);
          else {
            if (guard !== undefined) pendingLeaseReleases.set(id, guard);
            errors.push(error);
          }
        }
        try {
          await commands.stopOwner(id);
        } catch (error) {
          errors.push(error);
        }
      }
      if (!retainedRuntimeOwner) {
        try {
          await options.closeResources?.();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0)
        throw new AggregateError(errors, "Mission application shutdown failed.");
    })().catch((error: unknown) => {
      // Concurrent callers share one attempt; a failed attempt remains retryable.
      disposing = undefined;
      throw error;
    });
    return disposing;
  };
  const application = Object.assign(service, {
    dispose,
    integration: { run, missionControl: { commands, resume: service.resumeLocalHostMission } },
  });
  canonicalMissionApplications.add(application);
  return application;
}
