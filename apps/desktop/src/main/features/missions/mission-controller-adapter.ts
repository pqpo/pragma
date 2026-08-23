import { randomUUID } from "node:crypto";

import {
  type MissionControllerGuard,
  type MissionCommandConsumer,
  type MissionControllerStore,
  type MissionSemanticOperation,
} from "@pragma/local-host";
import type { HumanInteractionResponse } from "@pragma/shared";
import { createIntegrationError, type MissionCommand } from "@pragma/shared/integration";

import type { MissionStore } from "./mission-store.ts";

/**
 * Desktop Main composition for the Local Host Mission controller.
 *
 * It deliberately owns only Host lifecycle and fencing.  Mission, execution,
 * Runtime and Electron DTO schemas remain where they already belong.  The
 * guarded callback is limited to a single MissionStore persistence operation;
 * callers must do Runtime/session work before entering it.
 */
export interface DesktopMissionController {
  acquire(missionId: string): Promise<MissionControllerGuard>;
  setCommandConsumer(consumer: MissionCommandConsumer): void;
  setSemanticWriteReplay(replay: (operation: MissionSemanticOperation) => Promise<void>): void;
  startPolling(input: {
    readonly missionId: string;
    readonly consumer: MissionCommandConsumer;
    readonly initialDelayMs?: number | undefined;
    readonly maxDelayMs?: number | undefined;
    readonly jitter?: (() => number) | undefined;
  }): Promise<{ stop(): Promise<void> }>;
  guardedWrite<T>(input: {
    readonly missionId: string;
    readonly eventType: string;
    readonly operation: MissionSemanticOperation;
    readonly apply: () => Promise<T>;
  }): Promise<T>;
  releaseAfterLowerLevel(missionId: string, releaseLowerLevel: () => Promise<void>): Promise<void>;
  terminalDelete(missionId: string, deleteOwner: () => Promise<void>): Promise<void>;
  stop(missionId: string): Promise<void>;
}

export function createDesktopMissionController(options: {
  readonly controller: MissionControllerStore;
  readonly leaseMs?: number | undefined;
  readonly onLeaseLost?: ((missionId: string) => Promise<void> | void) | undefined;
}): DesktopMissionController {
  const leaseMs = options.leaseMs ?? 10_000;
  const active = new Map<
    string,
    {
      guard: MissionControllerGuard;
      timer?: ReturnType<typeof setTimeout> | undefined;
      stopped: boolean;
    }
  >();
  const pollers = new Map<string, { stop(): Promise<void> }>();
  const acquiring = new Map<string, Promise<MissionControllerGuard>>();
  let commandConsumer: MissionCommandConsumer | undefined;
  let semanticWriteReplay: ((operation: MissionSemanticOperation) => Promise<void>) | undefined;

  const stop = async (missionId: string): Promise<void> => {
    const current = active.get(missionId);
    if (current !== undefined) {
      current.stopped = true;
      if (current.timer !== undefined) clearTimeout(current.timer);
      active.delete(missionId);
    }
    await pollers.get(missionId)?.stop();
    pollers.delete(missionId);
  };

  const scheduleRenewal = (missionId: string): void => {
    const current = active.get(missionId);
    if (current === undefined || current.stopped) return;
    current.timer = setTimeout(() => void renew(missionId), Math.max(1, Math.floor(leaseMs / 2)));
    current.timer.unref();
  };

  const renew = async (missionId: string): Promise<void> => {
    const current = active.get(missionId);
    if (current === undefined || current.stopped) return;
    try {
      const renewed = await options.controller.renew({ missionId, guard: current.guard, leaseMs });
      if (active.get(missionId) !== current || current.stopped) return;
      current.guard = { claimId: renewed.claimId, fencingToken: renewed.fencingToken };
      scheduleRenewal(missionId);
    } catch {
      await stop(missionId);
      await options.onLeaseLost?.(missionId);
    }
  };

  const startPolling = async (input: {
    readonly missionId: string;
    readonly consumer: MissionCommandConsumer;
    readonly initialDelayMs?: number | undefined;
    readonly maxDelayMs?: number | undefined;
    readonly jitter?: (() => number) | undefined;
  }): Promise<{ stop(): Promise<void> }> => {
    const existing = pollers.get(input.missionId);
    if (existing !== undefined) return existing;
    const guard = active.get(input.missionId)?.guard;
    if (guard === undefined)
      throw new Error(`Mission ${input.missionId} must be claimed before Inbox polling starts.`);
    const poller = options.controller.startPolling({
      missionId: input.missionId,
      guard,
      consumer: input.consumer,
      ...(input.initialDelayMs === undefined ? {} : { initialDelayMs: input.initialDelayMs }),
      ...(input.maxDelayMs === undefined ? {} : { maxDelayMs: input.maxDelayMs }),
      ...(input.jitter === undefined ? {} : { jitter: input.jitter }),
      onLeaseLost: async () => {
        await stop(input.missionId);
        await options.onLeaseLost?.(input.missionId);
      },
    });
    pollers.set(input.missionId, poller);
    return poller;
  };

  return {
    async acquire(missionId) {
      const existing = active.get(missionId);
      if (existing !== undefined && !existing.stopped) return existing.guard;
      const inFlight = acquiring.get(missionId);
      if (inFlight !== undefined) return await inFlight;
      const acquisition = (async (): Promise<MissionControllerGuard> => {
        const grant = await options.controller.claim({
          missionId,
          claimId: randomUUID(),
          leaseMs,
        });
        const guard = { claimId: grant.claimId, fencingToken: grant.fencingToken };
        if (semanticWriteReplay !== undefined) {
          try {
            await options.controller.recoverSemanticWrite({
              missionId,
              guard,
              replay: semanticWriteReplay,
            });
          } catch (error) {
            await options.controller.release({ missionId, guard }).catch(() => undefined);
            throw error;
          }
        }
        const current = {
          guard,
          timer: undefined,
          stopped: false,
        };
        active.set(missionId, current);
        scheduleRenewal(missionId);
        if (commandConsumer !== undefined)
          await startPolling({ missionId, consumer: commandConsumer });
        return current.guard;
      })();
      acquiring.set(missionId, acquisition);
      try {
        return await acquisition;
      } finally {
        acquiring.delete(missionId);
      }
    },
    setCommandConsumer(consumer) {
      commandConsumer = consumer;
    },
    setSemanticWriteReplay(replay) {
      semanticWriteReplay = replay;
    },
    async startPolling(input) {
      return await startPolling(input);
    },
    async guardedWrite(input) {
      const guard = await this.acquire(input.missionId);
      return await options.controller.coordinateSemanticWrite({
        missionId: input.missionId,
        guard,
        operation: input.operation,
        eventType: input.eventType,
        eventData: {},
        apply: input.apply,
      });
    },
    async releaseAfterLowerLevel(missionId, releaseLowerLevel) {
      const current = active.get(missionId);
      if (current === undefined) {
        await releaseLowerLevel();
        return;
      }
      current.stopped = true;
      if (current.timer !== undefined) clearTimeout(current.timer);
      await pollers.get(missionId)?.stop();
      pollers.delete(missionId);
      try {
        await options.controller.releaseAfterLowerLevel({
          missionId,
          guard: current.guard,
          releaseLowerLevel,
        });
      } finally {
        active.delete(missionId);
      }
    },
    async terminalDelete(missionId, deleteOwner) {
      const current = active.get(missionId);
      if (current === undefined) {
        await deleteOwner();
        return;
      }
      // The owner graph deletion is itself journaled by MissionStore. Keep the
      // Mission lease live until that terminal transaction has committed, then
      // drop only local controller state: reading/releasing a moved aggregate
      // would turn a successful deletion into a false fencing failure.
      await pollers.get(missionId)?.stop();
      pollers.delete(missionId);
      let deleted = false;
      try {
        await deleteOwner();
        deleted = true;
      } finally {
        if (deleted && active.get(missionId) === current) {
          if (current.timer !== undefined) clearTimeout(current.timer);
          current.stopped = true;
          active.delete(missionId);
        }
      }
    },
    stop,
  };
}

/**
 * Maps the seven durable Inbox command kinds to the existing Desktop Mission
 * use cases. Strict target validation is intentionally an injected Host
 * concern: it must inspect the live Runtime turn before any command handler
 * can perform a send or queue mutation.
 */
export function createDesktopMissionCommandConsumer(options: {
  readonly commands: {
    readonly send: (input: {
      readonly missionId: string;
      readonly requestId: string;
      readonly prompt: string;
      readonly mode: "enqueue" | "steer";
    }) => Promise<Record<string, unknown>>;
    readonly respond: (input: {
      readonly missionId: string;
      readonly interactionId: string;
      readonly requestId: string;
      readonly response: HumanInteractionResponse;
    }) => Promise<Record<string, unknown>>;
    readonly interrupt: (input: {
      readonly missionId: string;
      readonly reason?: string | undefined;
    }) => Promise<Record<string, unknown>>;
    readonly removeQueued: (input: {
      readonly missionId: string;
      readonly requestId: string;
    }) => Promise<Record<string, unknown>>;
    readonly resumeQueue: (input: {
      readonly missionId: string;
    }) => Promise<Record<string, unknown>>;
    readonly steerQueued: (input: {
      readonly missionId: string;
      readonly requestId: string;
    }) => Promise<Record<string, unknown>>;
  };
  readonly validateStrictTarget: (input: {
    readonly missionId: string;
    readonly executionId: string;
    readonly turnId: string;
  }) => Promise<void>;
}): MissionCommandConsumer {
  return {
    async validateStrictTarget({ command }) {
      if (command.kind !== "steer" && command.kind !== "queue.steer") return;
      const target = command.target;
      if (target?.executionId === undefined || target.turnId === undefined) {
        throw createIntegrationError({
          code: "STEER_TARGET_NOT_ACTIVE",
          category: "conflict",
          message: "Strict Mission command requires an active execution and canonical turn.",
        });
      }
      await options.validateStrictTarget({
        missionId: command.missionId,
        executionId: target.executionId,
        turnId: target.turnId,
      });
    },
    async apply({ command }) {
      return { result: await applyDesktopMissionCommand(options, command) };
    },
  };
}

async function applyDesktopMissionCommand(
  options: Parameters<typeof createDesktopMissionCommandConsumer>[0],
  command: MissionCommand,
): Promise<Record<string, unknown>> {
  switch (command.payload.kind) {
    case "send":
      return await options.commands.send({
        missionId: command.missionId,
        requestId: command.request.requestId,
        prompt: command.payload.input.prompt,
        mode: "enqueue",
      });
    case "steer":
      return await options.commands.send({
        missionId: command.missionId,
        requestId: command.request.requestId,
        prompt: command.payload.input.prompt,
        mode: "steer",
      });
    case "respond": {
      const interactionId = command.target?.interactionId;
      if (interactionId === undefined)
        throw new Error("Respond command requires an interaction target.");
      return await options.commands.respond({
        missionId: command.missionId,
        interactionId,
        requestId: command.request.requestId,
        response: command.payload.response,
      });
    }
    case "interrupt":
      return await options.commands.interrupt({
        missionId: command.missionId,
        reason: command.payload.reason,
      });
    case "queue.remove":
      return await options.commands.removeQueued({
        missionId: command.missionId,
        requestId: command.payload.requestId,
      });
    case "queue.resume":
      return await options.commands.resumeQueue({ missionId: command.missionId });
    case "queue.steer":
      return await options.commands.steerQueued({
        missionId: command.missionId,
        requestId: command.payload.requestId,
      });
  }
}

/** Applies fencing to the Desktop persistence boundary without changing its schema. */
export function createGuardedMissionStore(
  store: MissionStore,
  controller: DesktopMissionController,
): MissionStore {
  const named = (name: string, input: Record<string, unknown>): MissionSemanticOperation => ({
    name,
    input,
  });
  controller.setSemanticWriteReplay(async (operation) => {
    switch (operation.name) {
      case "mission.origin.backfill":
        await store.backfillAutomationOrigin(
          String(operation.input.id),
          operation.input.automationRef as Parameters<MissionStore["backfillAutomationOrigin"]>[1],
        );
        return;
      case "mission.options.update":
        await store.updateOptions(
          String(operation.input.id),
          operation.input.input as Parameters<MissionStore["updateOptions"]>[1],
        );
        return;
      case "mission.context-stores.update":
        await store.updateContextStores(
          String(operation.input.id),
          operation.input.contextStoreIds as Parameters<MissionStore["updateContextStores"]>[1],
        );
        return;
      case "mission.execution.update":
        await store.updateExecution(
          String(operation.input.id),
          operation.input.execution as Parameters<MissionStore["updateExecution"]>[1],
          operation.input.guard as Parameters<MissionStore["updateExecution"]>[2],
        );
        return;
      case "mission.timeline.user-message.append":
        await store.appendUserMessage(
          String(operation.input.id),
          operation.input.message as Parameters<MissionStore["appendUserMessage"]>[1],
        );
        return;
      case "mission.timeline.execution-reference.append":
        await store.appendExecutionReference(
          operation.input.input as Parameters<MissionStore["appendExecutionReference"]>[0],
        );
        return;
      case "mission.status.complete":
        await store.markComplete(String(operation.input.id));
        return;
      case "mission.status.reopen":
        await store.reopen(String(operation.input.id));
        return;
      case "mission.execution-projection.write":
        await store.writeExecutionProjection(
          String(operation.input.id),
          String(operation.input.executionId),
          operation.input.entries as Parameters<MissionStore["writeExecutionProjection"]>[2],
        );
        return;
      default:
        throw new Error(`Unknown durable Mission semantic operation: ${operation.name}`);
    }
  });
  const write = async <T>(
    missionId: string,
    eventType: string,
    operation: MissionSemanticOperation,
    apply: () => Promise<T>,
  ): Promise<T> => await controller.guardedWrite({ missionId, eventType, operation, apply });
  return {
    ...store,
    backfillAutomationOrigin: async (id, automationRef) =>
      await write(
        id,
        "mission.origin.updated",
        named("mission.origin.backfill", { id, automationRef }),
        async () => await store.backfillAutomationOrigin(id, automationRef),
      ),
    updateOptions: async (id, input) =>
      await write(
        id,
        "mission.options.updated",
        named("mission.options.update", { id, input }),
        async () => await store.updateOptions(id, input),
      ),
    updateContextStores: async (id, contextStoreIds) =>
      await write(
        id,
        "mission.context-stores.updated",
        named("mission.context-stores.update", { id, contextStoreIds: [...contextStoreIds] }),
        async () => await store.updateContextStores(id, contextStoreIds),
      ),
    updateExecution: async (id, execution, guard) =>
      await write(
        id,
        "mission.execution.updated",
        named("mission.execution.update", {
          id,
          execution,
          ...(guard === undefined ? {} : { guard }),
        }),
        async () => await store.updateExecution(id, execution, guard),
      ),
    appendUserMessage: async (id, message) =>
      await write(
        id,
        "mission.timeline.user-message.appended",
        named("mission.timeline.user-message.append", { id, message }),
        async () => await store.appendUserMessage(id, message),
      ),
    appendExecutionReference: async (input) =>
      await write(
        input.missionId,
        "mission.timeline.execution-linked",
        named("mission.timeline.execution-reference.append", { input }),
        async () => await store.appendExecutionReference(input),
      ),
    markComplete: async (id) =>
      await write(
        id,
        "mission.status.completed",
        named("mission.status.complete", { id }),
        async () => await store.markComplete(id),
      ),
    reopen: async (id) =>
      await write(
        id,
        "mission.status.reopened",
        named("mission.status.reopen", { id }),
        async () => await store.reopen(id),
      ),
    // Owner deletion has its own MissionStore transaction and is coordinated by
    // terminalDelete; it cannot share a journal stored inside the directory it
    // removes.
    remove: store.remove,
    writeExecutionProjection: async (id, executionId, entries) =>
      await write(
        id,
        "mission.execution-projection.written",
        named("mission.execution-projection.write", { id, executionId, entries }),
        async () => await store.writeExecutionProjection(id, executionId, entries),
      ),
  };
}
