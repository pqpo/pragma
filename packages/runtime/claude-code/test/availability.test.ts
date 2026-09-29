import type { RuntimeCanUseResult } from "@pragma/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  canUseRuntimeBinary: vi.fn(),
  resolveClaudeCodeCommand: vi.fn(),
}));

vi.mock("@pragma/core/runtime/process-probe", () => ({
  canUseRuntimeBinary: mocks.canUseRuntimeBinary,
}));

vi.mock("../src/executable.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/executable.ts")>();
  mocks.resolveClaudeCodeCommand.mockImplementation(actual.resolveClaudeCodeCommand);
  return { ...actual, resolveClaudeCodeCommand: mocks.resolveClaudeCodeCommand };
});

import { canUseClaudeCodeRuntime } from "../src/availability.ts";

describe("Claude Code Runtime availability cache", () => {
  beforeEach(() => {
    mocks.canUseRuntimeBinary.mockReset();
  });

  it.each([false, true])("rejects a missing explicit worker (custom spawn: %s)", async (custom) => {
    mocks.canUseRuntimeBinary.mockResolvedValue(usable("claude"));
    await expect(
      canUseClaudeCodeRuntime({
        acpWorkerPath: `/missing/worker-${crypto.randomUUID()}.js`,
        ...(custom ? { spawn: vi.fn() } : {}),
      }),
    ).resolves.toMatchObject({ usable: false, details: { code: "claude_acp_worker_missing" } });
    expect(mocks.canUseRuntimeBinary).not.toHaveBeenCalled();
  });
  it("skips the native probe for custom spawn only after finding the worker", async () => {
    await expect(canUseClaudeCodeRuntime({ spawn: vi.fn() })).resolves.toMatchObject({
      usable: true,
    });
    expect(mocks.canUseRuntimeBinary).not.toHaveBeenCalled();
  });

  it("isolates command shim resolution errors to Claude availability", async () => {
    mocks.resolveClaudeCodeCommand.mockImplementationOnce(() => {
      throw new Error("Claude Code command shim could not be resolved safely");
    });
    await expect(
      canUseClaudeCodeRuntime({ executablePath: "C:\\invalid\\claude.cmd" }),
    ).resolves.toMatchObject({
      usable: false,
      reason: expect.stringContaining("Install Claude Code yourself"),
      details: { code: "claude_cli_unavailable" },
    });
    expect(mocks.canUseRuntimeBinary).not.toHaveBeenCalled();
  });

  it("reports failed probes with installation guidance", async () => {
    mocks.canUseRuntimeBinary.mockResolvedValue({ usable: false, reason: "ENOENT" });
    await expect(
      canUseClaudeCodeRuntime({ executablePath: `/missing/${crypto.randomUUID()}` }),
    ).resolves.toMatchObject({
      usable: false,
      reason: expect.stringContaining("Install Claude Code yourself"),
      details: { code: "claude_cli_unavailable" },
    });
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
