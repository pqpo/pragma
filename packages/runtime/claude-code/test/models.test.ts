import type { RuntimeCommandResult } from "@pragma/core/runtime/process-probe";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runRuntimeCommand: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("@pragma/core/runtime/process-probe", () => ({
  runRuntimeCommand: mocks.runRuntimeCommand,
}));

vi.mock("node:fs/promises", () => ({
  readFile: mocks.readFile,
}));

import { createClaudeCodeModelDiscovery } from "../src/models.ts";

describe("Claude Code model discovery cache", () => {
  beforeEach(() => {
    mocks.runRuntimeCommand.mockReset();
    mocks.readFile.mockReset();
    mocks.readFile.mockRejectedValue(new Error("missing test settings"));
  });

  it("shares a fresh catalog across adapter instances without probing the version", async () => {
    mocks.runRuntimeCommand.mockResolvedValue(commandResult(helpOutput("low, medium, high")));
    const executablePath = `/claude/cache-${crypto.randomUUID()}`;

    const first = createClaudeCodeModelDiscovery(discoveryOptions(executablePath));
    const second = createClaudeCodeModelDiscovery(discoveryOptions(executablePath));

    await expect(first()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "claude-sonnet-4-6" })]),
    );
    await expect(second()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "claude-sonnet-4-6" })]),
    );
    expect(mocks.runRuntimeCommand).toHaveBeenCalledTimes(1);
    expect(mocks.runRuntimeCommand).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["--help"] }),
    );
  });

  it("coalesces concurrent catalog loads", async () => {
    let finishDiscovery: ((result: RuntimeCommandResult) => void) | undefined;
    mocks.runRuntimeCommand.mockImplementationOnce(
      async () =>
        await new Promise<RuntimeCommandResult>((resolve) => {
          finishDiscovery = resolve;
        }),
    );
    const executablePath = `/claude/concurrent-${crypto.randomUUID()}`;
    const first = createClaudeCodeModelDiscovery(discoveryOptions(executablePath))();
    const second = createClaudeCodeModelDiscovery(discoveryOptions(executablePath))();

    await flushPromises();
    expect(mocks.runRuntimeCommand).toHaveBeenCalledTimes(1);
    finishDiscovery?.(commandResult(helpOutput("low, medium")));

    await expect(first).resolves.toHaveLength(11);
    await expect(second).resolves.toHaveLength(11);
  });

  it("returns stale models immediately, refreshes them, and notifies the host", async () => {
    vi.useFakeTimers();
    try {
      let finishRefresh: ((result: RuntimeCommandResult) => void) | undefined;
      mocks.runRuntimeCommand
        .mockResolvedValueOnce(commandResult(helpOutput("low, medium")))
        .mockImplementationOnce(
          async () =>
            await new Promise<RuntimeCommandResult>((resolve) => {
              finishRefresh = resolve;
            }),
        );
      const onModelCatalogUpdated = vi.fn();
      const discovery = createClaudeCodeModelDiscovery(
        discoveryOptions(`/claude/stale-${crypto.randomUUID()}`, onModelCatalogUpdated),
      );

      const cached = await discovery();
      expect(cached[0]?.thinking?.supportedLevels.map((level) => level.value)).toEqual([
        "low",
        "medium",
      ]);
      expect(onModelCatalogUpdated).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000 + 1);

      await expect(discovery()).resolves.toBe(cached);
      expect(mocks.runRuntimeCommand).toHaveBeenCalledTimes(2);

      finishRefresh?.(commandResult(helpOutput("low, medium, high")));
      await flushPromises();
      expect(onModelCatalogUpdated).toHaveBeenCalledTimes(1);
      const refreshed = await discovery();
      expect(refreshed[0]?.thinking?.supportedLevels.map((level) => level.value)).toEqual([
        "low",
        "medium",
        "high",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps stale models and backs off after a refresh fails", async () => {
    vi.useFakeTimers();
    try {
      mocks.runRuntimeCommand
        .mockResolvedValueOnce(commandResult(helpOutput("low, medium")))
        .mockResolvedValueOnce(commandResult("", 1))
        .mockResolvedValueOnce(commandResult(helpOutput("low, medium, high")));
      const discovery = createClaudeCodeModelDiscovery(
        discoveryOptions(`/claude/retry-${crypto.randomUUID()}`),
      );

      const cached = await discovery();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000 + 1);
      await expect(discovery()).resolves.toBe(cached);
      await flushPromises();

      await expect(discovery()).resolves.toBe(cached);
      expect(mocks.runRuntimeCommand).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(30 * 1_000 + 1);
      await expect(discovery()).resolves.toBe(cached);
      expect(mocks.runRuntimeCommand).toHaveBeenCalledTimes(3);
      await flushPromises();
      await expect(discovery()).resolves.not.toBe(cached);
    } finally {
      vi.useRealTimers();
    }
  });
});

function discoveryOptions(executablePath: string, onModelCatalogUpdated?: () => void) {
  return {
    executablePath,
    env: {
      CLAUDE_CONFIG_DIR: `/missing/claude-config-${crypto.randomUUID()}`,
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      ANTHROPIC_MODEL: "claude-sonnet-4-6",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5-20251001",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable-5",
    },
    ...(onModelCatalogUpdated === undefined ? {} : { onModelCatalogUpdated }),
  };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function helpOutput(levels: string): string {
  return `--effort <level> Effort level (${levels})`;
}

function commandResult(stdout: string, exitCode = 0): RuntimeCommandResult {
  return {
    exitCode,
    signal: null,
    stdout,
    stderr: "",
  };
}
