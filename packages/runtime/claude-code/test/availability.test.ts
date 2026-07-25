import type { RuntimeCanUseResult } from "@pragma/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  canUseRuntimeBinary: vi.fn(),
}));

vi.mock("@pragma/core/runtime/process-probe", () => ({
  canUseRuntimeBinary: mocks.canUseRuntimeBinary,
}));

import { canUseClaudeCodeRuntime } from "../src/availability.ts";

describe("Claude Code Runtime availability cache", () => {
  beforeEach(() => {
    mocks.canUseRuntimeBinary.mockReset();
  });

  it("shares a fresh availability result", async () => {
    mocks.canUseRuntimeBinary.mockResolvedValue(usable("claude 1"));
    const executablePath = `/claude/availability-${crypto.randomUUID()}`;

    await expect(canUseClaudeCodeRuntime({ executablePath })).resolves.toMatchObject({
      usable: true,
    });
    await expect(canUseClaudeCodeRuntime({ executablePath })).resolves.toMatchObject({
      usable: true,
    });

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
    const executablePath = `/claude/availability-concurrent-${crypto.randomUUID()}`;
    const first = canUseClaudeCodeRuntime({ executablePath });
    const second = canUseClaudeCodeRuntime({ executablePath });

    expect(mocks.canUseRuntimeBinary).toHaveBeenCalledTimes(1);
    finishProbe?.(usable("claude shared"));

    await expect(first).resolves.toMatchObject({ usable: true });
    await expect(second).resolves.toMatchObject({ usable: true });
  });

  it("returns stale availability immediately while refreshing it", async () => {
    vi.useFakeTimers();
    try {
      let finishRefresh: ((result: RuntimeCanUseResult) => void) | undefined;
      mocks.canUseRuntimeBinary
        .mockResolvedValueOnce(usable("claude cached"))
        .mockImplementationOnce(
          async () =>
            await new Promise<RuntimeCanUseResult>((resolve) => {
              finishRefresh = resolve;
            }),
        );
      const options = {
        executablePath: `/claude/availability-stale-${crypto.randomUUID()}`,
      };

      await expect(canUseClaudeCodeRuntime(options)).resolves.toMatchObject({
        details: { version: "claude cached" },
      });
      await vi.advanceTimersByTimeAsync(60 * 1_000 + 1);

      await expect(canUseClaudeCodeRuntime(options)).resolves.toMatchObject({
        details: { version: "claude cached" },
      });
      expect(mocks.canUseRuntimeBinary).toHaveBeenCalledTimes(2);

      finishRefresh?.(usable("claude refreshed"));
      await Promise.resolve();
      await Promise.resolve();
      await expect(canUseClaudeCodeRuntime(options)).resolves.toMatchObject({
        details: { version: "claude refreshed" },
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
      executablePath: "/claude",
      version,
    },
  };
}
