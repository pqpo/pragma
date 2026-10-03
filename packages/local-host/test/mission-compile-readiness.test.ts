import type { RuntimeCanUseResult, RuntimeResolver } from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalHostRuntimeReadiness } from "../src/missions/runtime-readiness.ts";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const canUse = vi.fn<() => Promise<RuntimeCanUseResult>>(async () => ({ usable: true }));
  const models = vi.fn(async () => []);
  const unrelatedProbe = vi.fn(async () => {
    throw new Error("An unrelated Runtime must not be probed.");
  });
  const runtime = (id: string, probe = canUse) =>
    defineRuntimeTestDriver({
      descriptor: { id, kind: "test", displayName: id },
      canUse: probe,
      listModels: models,
      createSession: () => ({}),
      startTurn: () => ({ outputText: "" }),
      mapEvent: () => ({ events: [] }),
    });
  const adapters = new Map([
    ["target", runtime("target")],
    ["unrelated", runtime("unrelated", unrelatedProbe)],
  ]);
  const list = vi.fn(async () => [...adapters.values()]);
  const runtimes = {
    list,
    getDefaultRuntimeId: async () => "target",
    bind: async ({ runtimeId = "target" } = {}) => ({
      binding: { runtimeId, revision: 1, fingerprint: "a".repeat(64) },
      adapter: adapters.get(runtimeId)!,
    }),
    resolve: async () => {
      throw new Error("Not needed for readiness.");
    },
  } satisfies RuntimeResolver & { readonly list: typeof list };
  let environment = "environment-1";
  const invalidated = vi.fn();
  const readiness = createLocalHostRuntimeReadiness({
    runtimes,
    getEnvironmentKey: () => environment,
    onInvalidate: invalidated,
  });
  return {
    readiness,
    runtimes,
    canUse,
    models,
    list,
    unrelatedProbe,
    invalidated,
    setEnvironment: (value: string) => (environment = value),
  };
}

describe("Mission target Runtime readiness", () => {
  it("deduplicates targets and concurrent requests without listing Runtimes or models", async () => {
    const f = fixture();
    let finish!: (value: RuntimeCanUseResult) => void;
    f.canUse.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const pending = Array.from({ length: 10 }, () => f.readiness.get(["target", "target"]));
    await vi.waitFor(() => expect(f.canUse).toHaveBeenCalledOnce());
    finish({ usable: true, details: { version: "1" } });
    const results = await Promise.all(pending);
    expect(
      results.every((result) => result.length === 1 && result[0]?.runtimeId === "target"),
    ).toBe(true);
    await f.readiness.get(["target"]);
    expect(f.canUse).toHaveBeenCalledOnce();
    expect(f.list).not.toHaveBeenCalled();
    expect(f.models).not.toHaveBeenCalled();
    expect(f.unrelatedProbe).not.toHaveBeenCalled();
  });

  it("expires successful probes 30 seconds after settlement", async () => {
    const f = fixture();
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await f.readiness.get(["target"]);
    now += 29_999;
    await f.readiness.get(["target"]);
    expect(f.canUse).toHaveBeenCalledOnce();
    now += 1;
    await f.readiness.get(["target"]);
    expect(f.canUse).toHaveBeenCalledTimes(2);
  });

  it("does not cache unavailable responses or rejected probes", async () => {
    const f = fixture();
    f.canUse.mockResolvedValueOnce({ usable: false, reason: "not configured" });
    expect((await f.readiness.get(["target"]))[0]?.availability.usable).toBe(false);
    await f.readiness.get(["target"]);
    expect(f.canUse).toHaveBeenCalledTimes(2);
    f.readiness.invalidate();
    f.canUse.mockRejectedValueOnce(new Error("probe failed"));
    await expect(f.readiness.get(["target"])).rejects.toThrow("probe failed");
    await f.readiness.get(["target"]);
    expect(f.canUse).toHaveBeenCalledTimes(4);
  });

  it("invalidates when the environment or resolved binding changes", async () => {
    const f = fixture();
    await f.readiness.get(["target"]);
    f.setEnvironment("environment-2");
    await f.readiness.get(["target"]);
    expect(f.canUse).toHaveBeenCalledTimes(2);
    const bound = await f.runtimes.bind({ runtimeId: "target" });
    vi.spyOn(f.runtimes, "bind").mockResolvedValue({
      ...bound,
      binding: { ...bound.binding, revision: 2 },
    });
    await f.readiness.get(["target"]);
    expect(f.canUse).toHaveBeenCalledTimes(3);
    f.readiness.invalidate();
    await f.readiness.get(["target"]);
    expect(f.canUse).toHaveBeenCalledTimes(4);
    expect(f.invalidated).toHaveBeenCalledOnce();
  });

  it("does not restore an invalidated cache when an older pending probe settles", async () => {
    const f = fixture();
    let finishOld!: (value: RuntimeCanUseResult) => void;
    f.canUse.mockImplementationOnce(() => new Promise((resolve) => (finishOld = resolve)));
    const old = f.readiness.get(["target"]);
    await vi.waitFor(() => expect(f.canUse).toHaveBeenCalledOnce());
    f.readiness.invalidate();
    finishOld({ usable: true });
    await old;
    await f.readiness.get(["target"]);
    expect(f.canUse).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest entry after 64 distinct environment bindings", async () => {
    const f = fixture();
    for (let index = 0; index < 65; index++) {
      f.setEnvironment(`environment-${index}`);
      await f.readiness.get(["target"]);
    }
    f.setEnvironment("environment-0");
    await f.readiness.get(["target"]);
    expect(f.canUse).toHaveBeenCalledTimes(66);
  });
});
