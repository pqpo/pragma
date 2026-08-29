import { randomUUID } from "node:crypto";

import { createIntegrationError } from "@pragma/shared/integration";

import type {
  MissionCommandConsumer,
  MissionControllerGuard,
  MissionControllerGuardSource,
  MissionControllerStore,
} from "./mission-controller-store.ts";

export interface MissionOwnerScope {
  acquire(missionId: string, claimId?: string): Promise<MissionControllerGuard>;
  currentGuard(missionId: string): MissionControllerGuard | undefined;
  startPolling(input: {
    readonly missionId: string;
    readonly consumer: MissionCommandConsumer;
    readonly initialDelayMs?: number | undefined;
    readonly maxDelayMs?: number | undefined;
    readonly jitter?: (() => number) | undefined;
  }): Promise<{ stop(): Promise<void> }>;
  release(missionId: string): Promise<void>;
  releaseAfterLowerLevel(missionId: string, releaseLowerLevel: () => Promise<void>): Promise<void>;
  /**
   * Deletes an owned aggregate after its owner graph has been journaled.
   * The persistent claim is intentionally not released: the aggregate is
   * moved out of the live tree by the callback, so releasing it afterwards
   * would turn a successful terminal delete into a fencing failure.
   */
  terminalDelete(missionId: string, deleteOwner: () => Promise<void>): Promise<void>;
  stop(missionId: string): Promise<void>;
}

/**
 * Host-side owner lifecycle shared by CLI and other Local Host compositions.
 * The timer and Inbox poller only operate on a claimed aggregate; all lower
 * level work remains in the injected consumer or release callback, outside the
 * aggregate lock.
 */
export function createMissionOwnerScope(options: {
  readonly controller: MissionControllerStore;
  readonly leaseMs?: number | undefined;
  readonly onLeaseLost?: ((missionId: string) => Promise<void> | void) | undefined;
  readonly recoverSemanticWrite?:
    | ((input: {
        readonly missionId: string;
        readonly guard: MissionControllerGuard;
      }) => Promise<void>)
    | undefined;
}): MissionOwnerScope {
  const leaseMs = options.leaseMs ?? 30_000;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw createIntegrationError({
      code: "INVALID_ARGUMENT",
      category: "usage",
      message: "Mission owner leaseMs must be a finite positive number.",
    });
  }
  const active = new Map<
    string,
    {
      guard: MissionControllerGuard;
      timer?: ReturnType<typeof setTimeout> | undefined;
      stopped: boolean;
      leaseLossNotified: boolean;
    }
  >();
  const pollers = new Map<string, { stop(): Promise<void> }>();
  const acquiring = new Map<string, Promise<MissionControllerGuard>>();

  const stopPolling = async (missionId: string): Promise<void> => {
    const poller = pollers.get(missionId);
    if (poller === undefined) return;
    pollers.delete(missionId);
    await poller.stop();
  };

  const stopWithoutCallback = async (
    missionId: string,
    suppressPollerStopError = false,
  ): Promise<void> => {
    const current = active.get(missionId);
    if (current !== undefined) {
      current.stopped = true;
      if (current.timer !== undefined) clearTimeout(current.timer);
      active.delete(missionId);
    }
    try {
      await stopPolling(missionId);
    } catch (error) {
      if (!suppressPollerStopError) throw error;
    }
  };

  const notifyLeaseLost = async (
    missionId: string,
    current: { leaseLossNotified: boolean },
  ): Promise<void> => {
    if (current.leaseLossNotified) return;
    current.leaseLossNotified = true;
    try {
      await options.onLeaseLost?.(missionId);
    } catch {
      // Lease loss is already fenced locally. A host callback is an
      // observability/cleanup hook and must not escape a background task.
    }
  };

  const scheduleRenewal = (missionId: string): void => {
    const current = active.get(missionId);
    if (current === undefined || current.stopped) return;
    current.timer = setTimeout(
      () => {
        // The timer has no caller to observe its Promise. Keep the final
        // rejection boundary here even though the normal lease-loss path is
        // defensive, so a host/poller failure can never become unhandled.
        void renew(missionId).catch(() => undefined);
      },
      Math.max(1, Math.floor(leaseMs / 2)),
    );
    current.timer.unref();
  };

  const renew = async (missionId: string): Promise<void> => {
    const current = active.get(missionId);
    if (current === undefined || current.stopped) return;
    try {
      const renewed = await options.controller.renew({
        missionId,
        guard: current.guard,
        leaseMs,
      });
      if (active.get(missionId) !== current || current.stopped) return;
      current.guard = { claimId: renewed.claimId, fencingToken: renewed.fencingToken };
      scheduleRenewal(missionId);
    } catch {
      await stopWithoutCallback(missionId, true);
      await notifyLeaseLost(missionId, current);
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
    const current = active.get(input.missionId);
    if (current === undefined || current.stopped) {
      throw createIntegrationError({
        code: "MISSION_FENCING_REJECTED",
        category: "conflict",
        message: `Mission ${input.missionId} must be claimed before Inbox polling starts.`,
        details: { missionId: input.missionId },
      });
    }
    const poller = options.controller.startPolling({
      missionId: input.missionId,
      guard: (() => {
        const owner = active.get(input.missionId);
        if (owner === undefined || owner.stopped) {
          throw createIntegrationError({
            code: "MISSION_FENCING_REJECTED",
            category: "conflict",
            message: `Mission ${input.missionId} no longer has an active owner.`,
            details: { missionId: input.missionId },
          });
        }
        return owner.guard;
      }) satisfies MissionControllerGuardSource,
      consumer: input.consumer,
      ...(input.initialDelayMs === undefined ? {} : { initialDelayMs: input.initialDelayMs }),
      ...(input.maxDelayMs === undefined ? {} : { maxDelayMs: input.maxDelayMs }),
      ...(input.jitter === undefined ? {} : { jitter: input.jitter }),
      onLeaseLost: async () => {
        try {
          await stopWithoutCallback(input.missionId, true);
          await notifyLeaseLost(input.missionId, current);
        } catch {
          // The controller poller awaits this hook. Keep its fencing-loss
          // callback contained even if an unexpected host-side cleanup path
          // fails before notifyLeaseLost can run.
        }
      },
    });
    pollers.set(input.missionId, poller);
    return poller;
  };

  return {
    currentGuard(missionId) {
      const current = active.get(missionId);
      return current === undefined || current.stopped ? undefined : current.guard;
    },
    async acquire(missionId, claimId) {
      const existing = active.get(missionId);
      if (existing !== undefined && !existing.stopped) return existing.guard;
      const inFlight = acquiring.get(missionId);
      if (inFlight !== undefined) return await inFlight;
      const acquisition = (async (): Promise<MissionControllerGuard> => {
        const grant = await options.controller.claim({
          missionId,
          claimId: claimId ?? randomUUID(),
          leaseMs,
        });
        const guard = { claimId: grant.claimId, fencingToken: grant.fencingToken };
        try {
          await options.recoverSemanticWrite?.({ missionId, guard });
        } catch (error) {
          await options.controller.release({ missionId, guard }).catch(() => undefined);
          throw error;
        }
        const current = { guard, stopped: false, leaseLossNotified: false };
        active.set(missionId, current);
        scheduleRenewal(missionId);
        return current.guard;
      })();
      acquiring.set(missionId, acquisition);
      try {
        return await acquisition;
      } finally {
        acquiring.delete(missionId);
      }
    },
    async startPolling(input) {
      return await startPolling(input);
    },
    async release(missionId) {
      const current = active.get(missionId);
      if (current === undefined) return;
      current.stopped = true;
      if (current.timer !== undefined) clearTimeout(current.timer);
      await stopPolling(missionId);
      try {
        await options.controller.release({ missionId, guard: current.guard });
      } finally {
        if (active.get(missionId) === current) active.delete(missionId);
      }
    },
    async releaseAfterLowerLevel(missionId, releaseLowerLevel) {
      const current = active.get(missionId);
      if (current === undefined) {
        await releaseLowerLevel();
        return;
      }
      current.stopped = true;
      if (current.timer !== undefined) clearTimeout(current.timer);
      await stopPolling(missionId);
      try {
        await options.controller.releaseAfterLowerLevel({
          missionId,
          guard: current.guard,
          releaseLowerLevel,
        });
      } finally {
        if (active.get(missionId) === current) active.delete(missionId);
      }
    },
    async terminalDelete(missionId, deleteOwner) {
      const current = active.get(missionId);
      if (current === undefined) {
        await deleteOwner();
        return;
      }

      // Stop consuming commands while the owner graph is moved by the
      // terminal transaction, but keep the lease and renewal state until the
      // callback commits. The moved aggregate must not be released through
      // its old path after deletion.
      await stopPolling(missionId);
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
    async stop(missionId) {
      await stopWithoutCallback(missionId);
    },
  };
}
