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

import { assertClaudeCodeModelSelection, createClaudeCodeModelDiscovery } from "../src/models.ts";

describe("Claude Code model selection", () => {
  const models = [
    {
      id: "claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6",
      provider: { kind: "runtime-managed" as const, id: "anthropic", displayName: "Anthropic" },
      thinking: { supportedLevels: [{ value: "high", label: "High" }] },
    },
    {
      id: "opus",
      displayName: "Opus → CC Switch local route",
      provider: {
        kind: "runtime-managed" as const,
        id: "anthropic-compatible",
        displayName: "Anthropic-compatible",
      },
      thinking: { supportedLevels: [{ value: "high", label: "High" }] },
    },
  ];

  it.each([
    ["Anthropic", "anthropic", "claude-sonnet-4-6"],
    ["CC Switch", "anthropic-compatible", "opus"],
  ])("accepts a model advertised for %s", (_name, providerId, modelId) => {
    expect(() => assertClaudeCodeModelSelection(models, modelId, "high", providerId)).not.toThrow();
  });

  it("rejects a provider and model pair that the Claude Code catalog did not advertise", () => {
    expect(() => assertClaudeCodeModelSelection(models, "opus", "high", "openai")).toThrow(
      'Unsupported Claude Code model "openai/opus".',
    );
  });
});

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
      expect.arrayContaining([
        expect.objectContaining({
          id: "claude-sonnet-4-6",
          inputModalities: ["text", "image"],
        }),
      ]),
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

  it("treats an unknown Anthropic-compatible model mapping as text-only", async () => {
    mocks.runRuntimeCommand.mockResolvedValue(commandResult(helpOutput("low, medium")));
    const discovery = createClaudeCodeModelDiscovery({
      executablePath: `/claude/mapped-${crypto.randomUUID()}`,
      env: {
        CLAUDE_CONFIG_DIR: `/missing/claude-config-${crypto.randomUUID()}`,
        ANTHROPIC_BASE_URL: "https://compatible.example.com",
        ANTHROPIC_MODEL: "third-party-model",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "third-party-model",
      },
    });

    await expect(discovery()).resolves.toEqual([
      expect.objectContaining({
        id: "sonnet",
        default: true,
        inputModalities: ["text"],
      }),
    ]);
  });

  it("keeps the model catalog usable with only the default thinking option when help fails", async () => {
    mocks.runRuntimeCommand.mockResolvedValue(commandResult("", 1));
    const discovery = createClaudeCodeModelDiscovery(
      discoveryOptions(`/claude/no-effort-${crypto.randomUUID()}`),
    );

    const models = await discovery();

    expect(models).toHaveLength(11);
    expect(models.every((model) => model.thinking === undefined)).toBe(true);
    expect(mocks.runRuntimeCommand).toHaveBeenCalledTimes(2);
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
      await vi.waitFor(() => expect(onModelCatalogUpdated).toHaveBeenCalledTimes(1));
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
        .mockResolvedValueOnce(commandResult("", 1))
        .mockResolvedValueOnce(commandResult(helpOutput("low, medium, high")));
      const onModelCatalogUpdated = vi.fn();
      const discovery = createClaudeCodeModelDiscovery(
        discoveryOptions(`/claude/retry-${crypto.randomUUID()}`, onModelCatalogUpdated),
      );

      const cached = await discovery();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000 + 1);
      await expect(discovery()).resolves.toBe(cached);
      await flushPromises();

      await expect(discovery()).resolves.toBe(cached);
      expect(mocks.runRuntimeCommand).toHaveBeenCalledTimes(3);
      expect(onModelCatalogUpdated).not.toHaveBeenCalled();
      await flushPromises();
      expect(mocks.runRuntimeCommand).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(30 * 1_000 + 1);
      await expect(discovery()).resolves.toBe(cached);
      expect(mocks.runRuntimeCommand).toHaveBeenCalledTimes(4);
      await flushPromises();
      await vi.waitFor(async () => {
        await expect(discovery()).resolves.not.toBe(cached);
      });
      await vi.waitFor(() => expect(onModelCatalogUpdated).toHaveBeenCalledTimes(1));
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
