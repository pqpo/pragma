import type { RuntimeCanUseResult } from "@pragma/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  canUseRuntimeBinary: vi.fn(),
}));

vi.mock("@pragma/core/runtime/process-probe", () => ({
  canUseRuntimeBinary: mocks.canUseRuntimeBinary,
}));

import { canUseCodexRuntime } from "../src/availability.ts";

describe("Codex Runtime availability cache", () => {
  beforeEach(() => {
    mocks.canUseRuntimeBinary.mockReset();
  });

  it("shares a fresh availability result", async () => {
    mocks.canUseRuntimeBinary.mockResolvedValue(usable("codex 1"));
    const executablePath = `/codex/availability-${crypto.randomUUID()}`;

    await expect(canUseCodexRuntime({ executablePath })).resolves.toMatchObject({ usable: true });
    await expect(canUseCodexRuntime({ executablePath })).resolves.toMatchObject({ usable: true });

    expect(mocks.canUseRuntimeBinary).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent availability probes", async () => {
    let finishProbe: ((result: RuntimeCanUseResult) => void) | undefined;
    mocks.canUseRuntimeBinary.mockImplementationOnce(
      async () =>
        await new Promise<RuntimeCanUseResult>((resolve) => {
          finishProbe = resolve;
        }),
    );
    const executablePath = `/codex/availability-concurrent-${crypto.randomUUID()}`;
    const first = canUseCodexRuntime({ executablePath });
    const second = canUseCodexRuntime({ executablePath });

    expect(mocks.canUseRuntimeBinary).toHaveBeenCalledTimes(1);
    finishProbe?.(usable("codex shared"));

    await expect(first).resolves.toMatchObject({ usable: true });
    await expect(second).resolves.toMatchObject({ usable: true });
  });

  it("returns stale availability immediately while refreshing it", async () => {
    vi.useFakeTimers();
    try {
      let finishRefresh: ((result: RuntimeCanUseResult) => void) | undefined;
      mocks.canUseRuntimeBinary
        .mockResolvedValueOnce(usable("codex cached"))
        .mockImplementationOnce(
          async () =>
            await new Promise<RuntimeCanUseResult>((resolve) => {
              finishRefresh = resolve;
            }),
        );
      const options = {
        executablePath: `/codex/availability-stale-${crypto.randomUUID()}`,
      };

      await expect(canUseCodexRuntime(options)).resolves.toMatchObject({
        details: { version: "codex cached" },
      });
      await vi.advanceTimersByTimeAsync(60 * 1_000 + 1);

      await expect(canUseCodexRuntime(options)).resolves.toMatchObject({
        details: { version: "codex cached" },
      });
      expect(mocks.canUseRuntimeBinary).toHaveBeenCalledTimes(2);

      finishRefresh?.(usable("codex refreshed"));
      await Promise.resolve();
      await Promise.resolve();
      await expect(canUseCodexRuntime(options)).resolves.toMatchObject({
        details: { version: "codex refreshed" },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

function usable(version: string): RuntimeCanUseResult {
  return {
    usable: true,
    details: {
      executablePath: "/codex",
      version,
    },
  };
}
