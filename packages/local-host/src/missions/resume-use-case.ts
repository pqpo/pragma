import type { ExecutionStore, ExpertSessionStore } from "@pragma/core";
import {
  createIntegrationError,
  HumanInteractionRequestEnvelopeSchema,
  IntegrationErrorSchema,
} from "@pragma/shared/integration";
import type { LocalHostMissionResumeRequest } from "../index.ts";
import type { LocalHostCoreMissionControlAdapter } from "../core-control-adapter.ts";
import type {
  MissionControlApplication,
  MissionControlExecutionOutcome,
} from "./controller/mission-control.ts";
import type {
  MissionControllerGuard,
  MissionControllerStore,
} from "./controller/mission-controller-store.ts";
import type { MissionOwnerScope } from "./controller/owner-scope.ts";
import {
  backfillMissionPinnedBinding,
  type MissionPinnedBindingBackfillPorts,
} from "./controller/pinned-binding-backfill.ts";
import { hashMissionResumePayload } from "./controller/command-payload.ts";

export async function resumeLocalHostMission(input: {
  readonly input: LocalHostMissionResumeRequest;
  readonly ownerLifetime: "host" | "request";
  readonly missionController: MissionControllerStore;
  readonly missionControl: MissionControlApplication;
  readonly coreControl: LocalHostCoreMissionControlAdapter;
  readonly ownerScope: MissionOwnerScope;
  readonly projectCatalog: MissionPinnedBindingBackfillPorts["catalog"];
  readonly resolveBuiltInExecutor: NonNullable<
    MissionPinnedBindingBackfillPorts["builtInResolver"]
  >;
  readonly expertSessionStore: ExpertSessionStore;
  readonly executionStore: ExecutionStore;
}): Promise<unknown> {
  const { input: request } = input;
  await backfillMissionPinnedBinding(
    {
      controller: input.missionController,
      catalog: input.projectCatalog,
      builtInResolver: async ({ ref, workspace }) =>
        await input.resolveBuiltInExecutor({ ref, workspace }),
      sessions: input.expertSessionStore,
      executions: input.executionStore,
    },
    request,
  );
  await input.coreControl.assertAcquisitionAllowed(request.missionId);
  const requestId = request.requestId ?? globalThis.crypto.randomUUID();
  const payloadHash = hashMissionResumePayload({
    missionId: request.missionId,
    ...(request.project === undefined ? {} : { project: request.project }),
    ...(request.expectedFingerprint === undefined
      ? {}
      : { expectedFingerprint: request.expectedFingerprint }),
  });
  const reserved = await input.missionControl.reserveOperation({
    missionId: request.missionId,
    requestId,
    payloadHash,
    kind: "resume",
  });
  if (reserved.operation.state === "applied") {
    return reserved.operation.result ?? { missionId: request.missionId, status: "resumed" };
  }
  if (reserved.operation.state === "rejected" || reserved.operation.state === "failed") {
    throw resumeOperationError(reserved.operation.error, request.missionId);
  }
  let acquired = false;
  let acquiredGuard: MissionControllerGuard | undefined;
  let recovered = false;
  let operationCompleted = false;
  try {
    const snapshot = await input.missionController.readSnapshot({ missionId: request.missionId });
    if (
      snapshot.snapshot.lease !== undefined &&
      Date.parse(snapshot.snapshot.lease.expiresAt) > Date.now()
    ) {
      const error = createIntegrationError({
        code: "MISSION_LEASE_HELD",
        category: "conflict",
        message: "Mission already has a live owner.",
        details: { missionId: request.missionId },
      });
      await input.missionControl.completeOperation({
        missionId: request.missionId,
        requestId,
        payloadHash,
        state: "rejected",
        error,
      });
      operationCompleted = true;
      throw error;
    }
  } catch (error) {
    await rejectOperation(error);
    throw error;
  }
  if (request.detach) {
    // Continue this reserved operation directly: repeating admission/backfill
    // in a recursive call could fail before settling its durable receipt.
    void resumeReservedOperation().catch(() => undefined);
    return {
      missionId: request.missionId,
      status: "accepted",
      operation: reserved.operation,
    };
  }
  return await resumeReservedOperation();

  async function rejectOperation(error: unknown): Promise<void> {
    if (operationCompleted) return;
    const parsedError = IntegrationErrorSchema.safeParse(error);
    const integrationError = parsedError.success
      ? parsedError.data
      : createIntegrationError({
          code: "COMMAND_REJECTED",
          category: "conflict",
          message: error instanceof Error ? error.message : "Mission resume failed.",
        });
    await input.missionControl
      .completeOperation({
        missionId: request.missionId,
        requestId,
        payloadHash,
        state: "rejected",
        error: integrationError,
        guard: acquiredGuard,
      })
      .catch(() => undefined);
  }

  async function resumeReservedOperation(): Promise<unknown> {
    try {
      const owner = await input.missionControl.startOwner(request.missionId);
      if (owner === "live") {
        const error = createIntegrationError({
          code: "MISSION_LEASE_HELD",
          category: "conflict",
          message: "Mission already has a live owner.",
          details: { missionId: request.missionId },
        });
        await input.missionControl.completeOperation({
          missionId: request.missionId,
          requestId,
          payloadHash,
          state: "rejected",
          error,
        });
        operationCompleted = true;
        throw error;
      }
      acquiredGuard = input.ownerScope.currentGuard(request.missionId);
      if (acquiredGuard === undefined)
        throw createIntegrationError({
          code: "MISSION_FENCING_REJECTED",
          category: "conflict",
          message: "Mission resume lost its acquired owner.",
        });
      acquired = true;
      await input.ownerScope.runWithGuard(
        request.missionId,
        acquiredGuard,
        async () => await input.coreControl.recoverMission(request.missionId),
      );
      await input.ownerScope.assertOwnership(request.missionId, acquiredGuard);
      recovered = true;
      const base = {
        missionId: request.missionId,
        status: "resumed",
      } as const;
      let result: Record<string, unknown> = base;
      const executionId = await input.coreControl.resolveExecutionTarget({
        missionId: request.missionId,
      });
      if (executionId !== undefined) {
        const execution = await waitForResumedExecution({
          missionId: request.missionId,
          executionId,
          control: input.missionControl,
          assertOwnership: () =>
            input.ownerScope.assertOwnership(request.missionId, acquiredGuard!),
          onHumanInteraction: request.detach ? undefined : request.onHumanInteraction,
        });
        if (execution.status === "failed") {
          throw (
            execution.error ??
            createIntegrationError({
              code: "EXECUTION_FAILED",
              category: "execution",
              retryable: false,
              message: "The resumed Mission execution failed.",
            })
          );
        }
        result = {
          ...base,
          ...(execution.status === "waiting" ? { status: "input_required" as const } : {}),
          execution,
        };
      }
      // Keep the reserved resume pending through native teardown. Automatic
      // settlement waits for pending operations and cannot release this claim
      // before its guarded completion is committed.
      const releaseLease =
        input.ownerLifetime === "request"
          ? await releaseRecoveredLowerOwner({
              missionId: request.missionId,
              coreControl: input.coreControl,
              ownerScope: input.ownerScope,
              guard: acquiredGuard,
            })
          : false;
      const operation = await input.missionControl.completeOperation({
        missionId: request.missionId,
        requestId,
        payloadHash,
        state: "applied",
        result,
        guard: acquiredGuard,
      });
      operationCompleted = true;
      const completed = { ...result, operation };
      if (releaseLease) await input.ownerScope.release(request.missionId, acquiredGuard);
      return completed;
    } catch (error) {
      await rejectOperation(error);
      if (acquired && recovered) {
        await releaseRecoveredOwner({
          missionId: request.missionId,
          coreControl: input.coreControl,
          ownerScope: input.ownerScope,
          guard: acquiredGuard!,
        }).catch(() => undefined);
      } else if (acquired) {
        await (async () => {
          await input.ownerScope.assertOwnership(request.missionId, acquiredGuard!);
          await input.ownerScope.runWithGuard(
            request.missionId,
            acquiredGuard!,
            async () => await input.coreControl.release(request.missionId),
          );
          await input.ownerScope.assertOwnership(request.missionId, acquiredGuard!);
          await input.ownerScope.release(request.missionId, acquiredGuard);
        })().catch(() => undefined);
      }
      throw error;
    }
  }
}

async function waitForResumedExecution(options: {
  readonly missionId: string;
  readonly executionId: string;
  readonly control: MissionControlApplication;
  readonly assertOwnership: () => Promise<void>;
  readonly onHumanInteraction?: LocalHostMissionResumeRequest["onHumanInteraction"];
}): Promise<MissionControlExecutionOutcome> {
  for (;;) {
    await options.assertOwnership();
    const execution = await options.control.waitExecution!({
      missionId: options.missionId,
      executionId: options.executionId,
    });
    await options.assertOwnership();
    if (execution.status !== "waiting" || execution.interaction === undefined) return execution;
    const interaction = HumanInteractionRequestEnvelopeSchema.parse(execution.interaction);
    if (options.onHumanInteraction === undefined) return execution;
    const decision = await options.onHumanInteraction(interaction);
    if (decision.kind === "checkpoint") return execution;
    await options.assertOwnership();
    const responseRequestId = globalThis.crypto.randomUUID();
    await options.control.submit({
      missionId: options.missionId,
      requestId: responseRequestId,
      kind: "respond",
      payload: { kind: "respond", response: decision.response },
      target: { interactionId: interaction.interactionId },
    });
    const responseOperation = await options.control.waitForTerminal({
      missionId: options.missionId,
      requestId: responseRequestId,
    });
    assertAppliedOperation(responseOperation, options.missionId);
  }
}

function assertAppliedOperation(
  operation: { readonly state: string; readonly error?: Record<string, unknown> },
  missionId: string,
): void {
  if (operation.state === "applied") return;
  throw resumeOperationError(operation.error, missionId);
}

async function releaseRecoveredOwner(options: {
  readonly missionId: string;
  readonly coreControl: LocalHostCoreMissionControlAdapter;
  readonly ownerScope: MissionOwnerScope;
  readonly guard: MissionControllerGuard;
}): Promise<void> {
  if (await releaseRecoveredLowerOwner(options))
    await options.ownerScope.release(options.missionId, options.guard);
}

async function releaseRecoveredLowerOwner(options: {
  readonly missionId: string;
  readonly coreControl: LocalHostCoreMissionControlAdapter;
  readonly ownerScope: MissionOwnerScope;
  readonly guard: MissionControllerGuard;
}): Promise<boolean> {
  const guard = options.guard;
  await options.ownerScope.assertOwnership(options.missionId, guard);
  try {
    await options.ownerScope.runWithGuard(
      options.missionId,
      guard,
      async () => await options.coreControl.releaseAfterHumanCheckpoint(options.missionId, guard),
    );
  } catch (error) {
    // A recovered owner may have started a subsequent queued execution while
    // the requested execution was being observed. Keep that owner alive and
    // let its poller continue while the resume operation is completed.
    if (!(error instanceof Error) || !error.message.includes("active execution")) throw error;
    return false;
  }
  await options.ownerScope.assertOwnership(options.missionId, guard);
  return true;
}

function resumeOperationError(error: Record<string, unknown> | undefined, missionId: string) {
  const parsed = IntegrationErrorSchema.safeParse(error);
  return parsed.success
    ? parsed.data
    : createIntegrationError({
        code: "COMMAND_REJECTED",
        category: "conflict",
        message: "Mission resume was rejected: " + missionId + ".",
      });
}
