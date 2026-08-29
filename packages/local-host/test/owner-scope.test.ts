import { describe, expect, it, vi } from "vitest";

import {
  createMissionOwnerScope,
  type MissionControllerStore,
  type MissionCommandConsumer,
} from "../src/index.ts";

describe("Mission owner scope", () => {
  it("stops the owner and notifies once when renewal and polling lose the fence together", async () => {
    const onLeaseLost = vi.fn(async () => undefined);
    const poller = { stop: vi.fn(async () => undefined) };
    const controller = {
      claim: vi.fn(async () => ({
        claimId: "11111111-1111-4111-8111-111111111111",
        fencingToken: "1",
        acquiredAt: "2026-08-27T00:00:00.000Z",
        renewedAt: "2026-08-27T00:00:00.000Z",
        expiresAt: "2026-08-27T00:01:00.000Z",
      })),
      renew: vi.fn(async () => {
        throw new Error("fence lost");
      }),
      startPolling: vi.fn(
        ({ onLeaseLost }: { readonly onLeaseLost: () => Promise<void> | void }) => {
          setTimeout(() => void onLeaseLost(), 12).unref();
          return poller;
        },
      ),
    } as unknown as MissionControllerStore;
    const scope = createMissionOwnerScope({ controller, leaseMs: 20, onLeaseLost });
    const consumer: MissionCommandConsumer = {
      apply: async () => ({ result: {} }),
    };

    try {
      await scope.acquire("22222222-2222-4222-8222-222222222222");
      await scope.startPolling({
        missionId: "22222222-2222-4222-8222-222222222222",
        consumer,
      });
      await vi.waitFor(() => expect(onLeaseLost).toHaveBeenCalledOnce(), {
        timeout: 200,
        interval: 5,
      });
      expect(scope.currentGuard("22222222-2222-4222-8222-222222222222")).toBeUndefined();
      expect(poller.stop).toHaveBeenCalledOnce();
    } finally {
      await scope.stop("22222222-2222-4222-8222-222222222222");
    }
  });

  it.each(["sync", "async"] as const)(
    "contains %s onLeaseLost failures and poller stop failures in background renewal",
    async (failureKind) => {
      const unhandled: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandledRejection);
      const onLeaseLost = vi.fn(() => {
        if (failureKind === "sync") throw new Error("secret callback failure");
        return Promise.reject(new Error("secret async callback failure"));
      });
      const poller = {
        stop: vi.fn(async () => {
          throw new Error("poller stop failure");
        }),
      };
      const controller = {
        claim: vi.fn(async () => ({
          claimId: "33333333-3333-4333-8333-333333333333",
          fencingToken: "1",
          acquiredAt: "2026-08-27T00:00:00.000Z",
          renewedAt: "2026-08-27T00:00:00.000Z",
          expiresAt: "2026-08-27T00:01:00.000Z",
        })),
        renew: vi.fn(async () => {
          throw new Error("fence lost");
        }),
        startPolling: vi.fn(() => poller),
      } as unknown as MissionControllerStore;
      const scope = createMissionOwnerScope({ controller, leaseMs: 20, onLeaseLost });
      const missionId = "44444444-4444-4444-8444-444444444444";

      try {
        await scope.acquire(missionId);
        await scope.startPolling({
          missionId,
          consumer: { apply: async () => ({ result: {} }) },
        });
        await vi.waitFor(() => expect(onLeaseLost).toHaveBeenCalledOnce(), {
          timeout: 200,
          interval: 5,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 30));

        expect(scope.currentGuard(missionId)).toBeUndefined();
        expect(poller.stop).toHaveBeenCalledOnce();
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
        await scope.stop(missionId);
      }
    },
  );
});
