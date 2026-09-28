import { beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  planes: [] as { closed: boolean; flush: ReturnType<typeof vi.fn> }[],
  stopMission: vi.fn<(missionId: string) => Promise<void>>(async () => undefined),
  stop: vi.fn(async () => undefined),
  policyFailure: false,
}));
vi.mock("../src/memory-data-plane.ts", () => ({
  createLocalHostMemoryDataPlane: async () => {
    const plane = {
      closed: false,
      flush: vi.fn(async () => {
        if (plane.closed) throw new Error("closed database");
      }),
    };
    fixtures.planes.push(plane);
    const close = () => {
      plane.closed = true;
    };
    return {
      policies: {
        getGlobal: async () => {
          if (fixtures.policyFailure) throw new Error("corrupt policy");
          return { policy: { enabled: "enabled" } };
        },
      },
      registerExecutionContext: async () => undefined,
      setConversationState: async () => undefined,
      flushDelivery: plane.flush,
      scheduler: { stop: async () => undefined },
      episodic: { close },
      semantic: { close },
      knowledge: { close },
      skill: { close },
    };
  },
}));
vi.mock("../src/memory-context.ts", () => ({
  createLocalHostMemoryContextService: () => ({
    createContextStore: () => ({}),
    stopMission: fixtures.stopMission,
    stop: fixtures.stop,
  }),
}));
import { createLocalHostRunMemory } from "../src/run-memory.ts";

beforeEach(() => {
  fixtures.planes.length = 0;
  fixtures.policyFailure = false;
  fixtures.stopMission.mockReset().mockResolvedValue(undefined);
  fixtures.stop.mockReset().mockResolvedValue(undefined);
});

describe("CLI Memory lifetime", () => {
  it("finishes pending delivery before closing and creates a fresh service for a concurrent new owner", async () => {
    const memory = createLocalHostRunMemory({ pragmaHome: "/unused-memory-lifetime-fixture" });
    await memory.bindings({ missionId: "first", goal: "first" });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fixtures.stopMission.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const completion = memory.complete("first");
    await started;
    const closing = memory.close();
    const newOwner = memory.bindings({ missionId: "second", goal: "second" });
    expect(fixtures.planes[0]?.closed).toBe(false);
    release();
    await Promise.all([completion, closing, newOwner]);
    expect(fixtures.planes[0]?.flush).toHaveBeenCalledOnce();
    expect(fixtures.planes).toHaveLength(2);
    expect(fixtures.planes[0]?.closed).toBe(true);
    expect(fixtures.planes[1]?.closed).toBe(false);
    await memory.close();
    expect(fixtures.planes[1]?.closed).toBe(false);
    await memory.complete("second");
    await memory.close();
    expect(fixtures.planes[1]?.closed).toBe(true);
  });
  it("isolates optional Memory initialization and delivery failures from execution", async () => {
    const memory = createLocalHostRunMemory({ pragmaHome: "/unused-memory-lifetime-fixture" });
    fixtures.policyFailure = true;
    await expect(memory.bindings({ missionId: "first", goal: "first" })).resolves.toEqual([]);
    fixtures.stopMission.mockRejectedValueOnce(new Error("unavailable observer"));
    await expect(memory.complete("first")).resolves.toBeUndefined();
    fixtures.stop.mockRejectedValueOnce(new Error("observer shutdown failed"));
    await expect(memory.close()).resolves.toBeUndefined();
    expect(fixtures.planes[0]?.closed).toBe(true);
  });
});
