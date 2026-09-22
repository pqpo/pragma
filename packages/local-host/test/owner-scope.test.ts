import { describe, expect, it, vi } from "vitest";
import { FileLockTimeoutError } from "@pragma/core";

import {
  createMissionOwnerScope,
  type MissionControllerStore,
  type MissionCommandConsumer,
} from "../src/index.ts";

describe("Mission owner scope", () => {
  it("starts the bound Inbox consumer as part of owner acquisition", async () => {
    const poller = { stop: vi.fn(async () => undefined) };
    const controller = {
      claim: vi.fn(async () => ({
        claimId: "11111111-1111-4111-8111-111111111111",
        fencingToken: "1",
        acquiredAt: "2026-08-27T00:00:00.000Z",
        renewedAt: "2026-08-27T00:00:00.000Z",
        expiresAt: "2026-08-27T00:01:00.000Z",
      })),
      renew: vi.fn(async () => ({
        claimId: "11111111-1111-4111-8111-111111111111",
        fencingToken: "1",
        acquiredAt: "2026-08-27T00:00:00.000Z",
        renewedAt: "2026-08-27T00:00:00.010Z",
        expiresAt: "2026-08-27T00:01:00.010Z",
      })),
      startPolling: vi.fn(() => poller),
      release: vi.fn(async () => undefined),
    } as unknown as MissionControllerStore;
    const scope = createMissionOwnerScope({ controller, leaseMs: 60_000 });
    const consumer: MissionCommandConsumer = { apply: async () => ({ result: {} }) };
    scope.bindConsumer(consumer);

    try {
      await scope.acquire("22222222-2222-4222-8222-222222222222");
      expect(controller.startPolling).toHaveBeenCalledWith(
        expect.objectContaining({
          missionId: "22222222-2222-4222-8222-222222222222",
          consumer,
        }),
      );
    } finally {
      await scope.release("22222222-2222-4222-8222-222222222222");
    }
  });

  it("rejects replacing the Inbox consumer for an owner scope", () => {
    const controller = {} as MissionControllerStore;
    const scope = createMissionOwnerScope({ controller });
    scope.bindConsumer({ apply: async () => ({ result: {} }) });

    expect(() => scope.bindConsumer({ apply: async () => ({ result: {} }) })).toThrow(
      "already has a different Inbox consumer",
    );
  });

  it("keeps a late operation bound to its original guard after force revocation", async () => {
    const originalGuard = {
      claimId: "11111111-1111-4111-8111-111111111111",
      fencingToken: "1",
    };
    const controller = {
      claim: vi.fn(async () => ({
        ...originalGuard,
        acquiredAt: "2026-08-27T00:00:00.000Z",
        renewedAt: "2026-08-27T00:00:00.000Z",
        expiresAt: "2026-08-27T00:01:00.000Z",
      })),
      revoke: vi.fn(async () => ({
        ...originalGuard,
        acquiredAt: "2026-08-27T00:00:00.000Z",
        renewedAt: "2026-08-27T00:00:00.000Z",
        expiresAt: "2026-08-27T00:01:00.000Z",
      })),
    } as unknown as MissionControllerStore;
    const scope = createMissionOwnerScope({ controller, leaseMs: 60_000 });
    const missionId = "22222222-2222-4222-8222-222222222222";
    const guard = await scope.acquire(missionId);

    await scope.runWithGuard(missionId, guard, async () => {
      await scope.forceRevoke(missionId);
      await expect(scope.acquire(missionId)).resolves.toEqual(originalGuard);
    });

    expect(controller.claim).toHaveBeenCalledOnce();
    expect(controller.revoke).toHaveBeenCalledOnce();
  });

  it("rejects attaching an Inbox consumer after an owner was acquired without command ingress", async () => {
    const controller = {
      claim: vi.fn(async () => ({
        claimId: "11111111-1111-4111-8111-111111111111",
        fencingToken: "1",
        acquiredAt: "2026-08-27T00:00:00.000Z",
        renewedAt: "2026-08-27T00:00:00.000Z",
        expiresAt: "2026-08-27T00:01:00.000Z",
      })),
      release: vi.fn(async () => undefined),
    } as unknown as MissionControllerStore;
    const scope = createMissionOwnerScope({ controller, leaseMs: 60_000 });
    const missionId = "22222222-2222-4222-8222-222222222222";
    await scope.acquire(missionId);

    try {
      expect(() => scope.bindConsumer({ apply: async () => ({ result: {} }) })).toThrow(
        "must bind its Inbox consumer before acquiring owners",
      );
    } finally {
      await scope.release(missionId);
    }
  });

  it("reacquires an expired owner when a durable operation still needs a consumer", async () => {
    let loseLease: (() => Promise<void> | void) | undefined;
    let claimCount = 0;
    let pollingCount = 0;
    const pollers = [
      { stop: vi.fn(async () => undefined) },
      { stop: vi.fn(async () => undefined) },
    ];
    const controller = {
      claim: vi.fn(async () => ({
        claimId: "11111111-1111-4111-8111-111111111111",
        fencingToken: String(++claimCount),
        acquiredAt: "2026-08-27T00:00:00.000Z",
        renewedAt: "2026-08-27T00:00:00.000Z",
        expiresAt: "2026-08-27T00:01:00.000Z",
      })),
      renew: vi.fn(async () => {
        throw new Error("renew should not run in this test");
      }),
      startPolling: vi.fn(
        ({ onLeaseLost }: { readonly onLeaseLost: () => Promise<void> | void }) => {
          loseLease = onLeaseLost;
          return pollers[Math.min(pollingCount++, 1)]!;
        },
      ),
      listOperations: vi.fn(async () => [
        {
          state: "queued",
        },
      ]),
      release: vi.fn(async () => undefined),
    } as unknown as MissionControllerStore;
    const scope = createMissionOwnerScope({ controller, leaseMs: 20 });
    scope.bindConsumer({ apply: async () => ({ result: {} }) });
    const missionId = "22222222-2222-4222-8222-222222222222";

    try {
      await scope.acquire(missionId);
      await loseLease?.();
      await vi.waitFor(() => expect(controller.claim).toHaveBeenCalledTimes(2), {
        timeout: 200,
        interval: 5,
      });
      expect(controller.startPolling).toHaveBeenCalledTimes(2);
      expect(scope.currentGuard(missionId)).toBeDefined();
    } finally {
      await scope.stop(missionId);
    }
  });

  it("retries initial owner acquisition while a durable operation remains queued", async () => {
    let claimCount = 0;
    const poller = { stop: vi.fn(async () => undefined) };
    const controller = {
      claim: vi.fn(async () => {
        claimCount += 1;
        if (claimCount === 1) throw new Error("temporary owner startup failure");
        return {
          claimId: "11111111-1111-4111-8111-111111111111",
          fencingToken: "1",
          acquiredAt: "2026-08-27T00:00:00.000Z",
          renewedAt: "2026-08-27T00:00:00.000Z",
          expiresAt: "2026-08-27T00:01:00.000Z",
        };
      }),
      renew: vi.fn(async () => {
        throw new Error("renew should not run in this test");
      }),
      startPolling: vi.fn(() => poller),
      listOperations: vi.fn(async () => [{ state: "queued" }]),
      release: vi.fn(async () => undefined),
    } as unknown as MissionControllerStore;
    const scope = createMissionOwnerScope({ controller, leaseMs: 20 });
    scope.bindConsumer({ apply: async () => ({ result: {} }) });
    const missionId = "22222222-2222-4222-8222-222222222222";

    try {
      await expect(scope.acquire(missionId)).rejects.toThrow("temporary owner startup failure");
      await vi.waitFor(() => expect(controller.claim).toHaveBeenCalledTimes(2), {
        timeout: 200,
        interval: 5,
      });
      expect(controller.startPolling).toHaveBeenCalledOnce();
      expect(scope.currentGuard(missionId)).toBeDefined();
    } finally {
      await scope.stop(missionId);
    }
  });

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
    scope.bindConsumer(consumer);

    try {
      await scope.acquire("22222222-2222-4222-8222-222222222222");
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

  it("retries transient file-lock contention before the lease deadline", async () => {
    const onLeaseLost = vi.fn(async () => undefined);
    const poller = { stop: vi.fn(async () => undefined) };
    const now = Date.now();
    let renewCount = 0;
    const controller = {
      claim: vi.fn(async () => ({
        claimId: "11111111-1111-4111-8111-111111111111",
        fencingToken: "1",
        acquiredAt: new Date(now).toISOString(),
        renewedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 1_200).toISOString(),
      })),
      renew: vi.fn(async () => {
        renewCount += 1;
        if (renewCount === 1) {
          throw new FileLockTimeoutError("busy", "/tmp/mission.lock", "active", 10, "renew");
        }
        const renewedAt = Date.now();
        return {
          claimId: "11111111-1111-4111-8111-111111111111",
          fencingToken: "1",
          acquiredAt: new Date(now).toISOString(),
          renewedAt: new Date(renewedAt).toISOString(),
          expiresAt: new Date(renewedAt + 1_200).toISOString(),
        };
      }),
      startPolling: vi.fn(() => poller),
      release: vi.fn(async () => undefined),
    } as unknown as MissionControllerStore;
    const scope = createMissionOwnerScope({ controller, leaseMs: 1_200, onLeaseLost });
    const missionId = "55555555-5555-4555-8555-555555555555";
    scope.bindConsumer({ apply: async () => ({ result: {} }) });

    try {
      await scope.acquire(missionId);
      await vi.waitFor(() => expect(controller.renew).toHaveBeenCalledTimes(2), {
        timeout: 2_000,
        interval: 20,
      });
      expect(scope.currentGuard(missionId)).toBeDefined();
      expect(onLeaseLost).not.toHaveBeenCalled();
    } finally {
      await scope.release(missionId);
    }
  });

  it("reports lease loss once when file-lock contention lasts through expiry", async () => {
    const onLeaseLost = vi.fn(async () => undefined);
    const poller = { stop: vi.fn(async () => undefined) };
    const now = Date.now();
    const controller = {
      claim: vi.fn(async () => ({
        claimId: "11111111-1111-4111-8111-111111111111",
        fencingToken: "1",
        acquiredAt: new Date(now).toISOString(),
        renewedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60).toISOString(),
      })),
      renew: vi.fn(async () => {
        throw new FileLockTimeoutError("busy", "/tmp/mission.lock", "active", 10, "renew");
      }),
      startPolling: vi.fn(() => poller),
    } as unknown as MissionControllerStore;
    const scope = createMissionOwnerScope({ controller, leaseMs: 60, onLeaseLost });
    const missionId = "66666666-6666-4666-8666-666666666666";
    scope.bindConsumer({ apply: async () => ({ result: {} }) });

    try {
      await scope.acquire(missionId);
      await vi.waitFor(() => expect(onLeaseLost).toHaveBeenCalledOnce(), {
        timeout: 500,
        interval: 10,
      });
      expect(scope.currentGuard(missionId)).toBeUndefined();
      expect(poller.stop).toHaveBeenCalledOnce();
    } finally {
      await scope.stop(missionId);
    }
  });

  it("does not renew or report lease loss after release during a lock retry", async () => {
    const onLeaseLost = vi.fn(async () => undefined);
    const poller = { stop: vi.fn(async () => undefined) };
    const now = Date.now();
    const controller = {
      claim: vi.fn(async () => ({
        claimId: "11111111-1111-4111-8111-111111111111",
        fencingToken: "1",
        acquiredAt: new Date(now).toISOString(),
        renewedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 200).toISOString(),
      })),
      renew: vi.fn(async () => {
        throw new FileLockTimeoutError("busy", "/tmp/mission.lock", "active", 10, "renew");
      }),
      startPolling: vi.fn(() => poller),
      release: vi.fn(async () => undefined),
    } as unknown as MissionControllerStore;
    const scope = createMissionOwnerScope({ controller, leaseMs: 200, onLeaseLost });
    const missionId = "77777777-7777-4777-8777-777777777777";
    scope.bindConsumer({ apply: async () => ({ result: {} }) });

    await scope.acquire(missionId);
    await vi.waitFor(() => expect(controller.renew).toHaveBeenCalledOnce(), {
      timeout: 300,
      interval: 5,
    });
    await scope.release(missionId);
    await new Promise<void>((resolve) => setTimeout(resolve, 150));

    expect(controller.renew).toHaveBeenCalledOnce();
    expect(onLeaseLost).not.toHaveBeenCalled();
    expect(poller.stop).toHaveBeenCalledOnce();
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
      scope.bindConsumer({ apply: async () => ({ result: {} }) });

      try {
        await scope.acquire(missionId);
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
