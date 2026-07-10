import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertClaudeCodeModelSelection,
  assertClaudeCodeProviderConfig,
  buildClaudeModels,
  createClaudeCodeModelDiscovery,
  parseClaudeEffortLevels,
} from "../src/models.ts";

describe("Claude Code model discovery", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses runtime-native effort values from CLI help", () => {
    expect(
      parseClaudeEffortLevels(
        "--effort <level> Effort level for the current session (low, medium, high, xhigh, max)",
      ),
    ).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(parseClaudeEffortLevels("--model <model> Select a model")).toEqual([]);
  });

  it("projects the detected superset through per-model restrictions", () => {
    const models = buildClaudeModels(["low", "medium", "high", "xhigh", "max"]);
    const sonnet = models.find((model) => model.id === "claude-sonnet-4-6");
    const opus = models.find((model) => model.id === "claude-opus-4-6");

    expect(sonnet?.thinking?.supportedLevels.map((level) => level.value)).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(opus?.thinking?.supportedLevels.map((level) => level.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("only exposes a default thinking level when the runtime reports it as supported", () => {
    const [model] = buildClaudeModels(["low", "high"]);

    expect(model?.thinking).toEqual({
      supportedLevels: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
    });
  });

  it("rejects unavailable model and thinking combinations", () => {
    const models = buildClaudeModels(["low", "medium", "high", "xhigh", "max"]);

    expect(() => assertClaudeCodeModelSelection(models, "claude-sonnet-4-6", "xhigh")).toThrow(
      'Unsupported Claude Code thinking level "xhigh" for model "claude-sonnet-4-6".',
    );
    expect(() => assertClaudeCodeModelSelection(models, "opus", "xhigh")).not.toThrow();
    expect(() => assertClaudeCodeModelSelection(models, "unknown", undefined)).toThrow(
      'Unsupported Claude Code model "unknown".',
    );
  });

  it("rejects Pragma custom provider definitions", () => {
    expect(() =>
      assertClaudeCodeProviderConfig({
        agent: {
          models: undefined,
        },
        models: [
          {
            provider: "custom",
            modelNames: ["model"],
            baseApi: "https://example.test",
            key: "secret",
          },
        ],
      } as never),
    ).toThrow("Claude Code runtime does not accept custom model providers");
  });

  it("discovers effort values once per CLI version cache entry", async () => {
    const configDir = await createClaudeConfigDir({});
    const spawn = createCommandSpawn([
      { stdout: "test-version\n" },
      { stdout: "--effort <level> Effort level (low, medium, high)\n" },
      { stdout: "test-version\n" },
    ]);
    const listModels = createClaudeCodeModelDiscovery({
      executablePath: "claude-test-cache",
      env: { CLAUDE_CONFIG_DIR: configDir },
      spawn,
    });

    await expect(listModels()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "claude-sonnet-4-6",
          thinking: expect.objectContaining({
            supportedLevels: expect.arrayContaining([expect.objectContaining({ value: "high" })]),
          }),
        }),
      ]),
    );
    await listModels();
    expect(spawn.mock.calls.map((call) => call[1])).toEqual([
      ["--version"],
      ["--help"],
      ["--version"],
    ]);
  });

  it("exposes only safe aliases for CC Switch model mappings and invalidates the cache", async () => {
    stubClaudeModelEnvironment();
    const configDir = await createClaudeConfigDir({
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_MODEL: "deepseek-v4-pro",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
    });
    const spawn = createCommandSpawn([
      { stdout: "cc-switch-test-version\n" },
      { stdout: "cc-switch-test-version\n" },
    ]);
    const listModels = createClaudeCodeModelDiscovery({
      executablePath: "claude-cc-switch-test",
      env: { CLAUDE_CONFIG_DIR: configDir },
      spawn,
    });

    await expect(listModels()).resolves.toEqual([
      {
        id: "sonnet",
        displayName: "Sonnet → deepseek-v4-pro",
        provider: "anthropic-compatible",
        default: true,
      },
      {
        id: "opus",
        displayName: "Opus → deepseek-v4-pro",
        provider: "anthropic-compatible",
      },
      {
        id: "haiku",
        displayName: "Haiku → deepseek-v4-flash",
        provider: "anthropic-compatible",
      },
    ]);

    await writeClaudeSettings(configDir, {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_MODEL: "deepseek-v4-flash",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-flash",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
    });

    const refreshed = await listModels();
    const refreshedSonnet = refreshed.find((model) => model.id === "sonnet");
    expect(refreshedSonnet).toMatchObject({
      displayName: "Sonnet → deepseek-v4-flash",
      default: true,
    });
    expect(refreshedSonnet?.thinking).toBeUndefined();
    expect(spawn.mock.calls.map((call) => call[1])).toEqual([["--version"], ["--version"]]);
  });
});

async function createClaudeConfigDir(env: Readonly<Record<string, string>>): Promise<string> {
  stubClaudeModelEnvironment();
  const configDir = await mkdtemp(join(tmpdir(), "pragma-claude-model-discovery-"));
  await writeClaudeSettings(configDir, env);
  return configDir;
}

async function writeClaudeSettings(
  configDir: string,
  env: Readonly<Record<string, string>>,
): Promise<void> {
  await writeFile(join(configDir, "settings.json"), JSON.stringify({ env }), "utf8");
}

function stubClaudeModelEnvironment(): void {
  for (const key of [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
  ]) {
    vi.stubEnv(key, "");
  }
}

function createCommandSpawn(responses: readonly { readonly stdout: string }[]) {
  let index = 0;
  return vi.fn(
    (
      command: string,
      args: readonly string[],
      options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
    ) => {
      void command;
      void args;
      void options;
      const response = responses[index++];
      if (response === undefined) {
        throw new Error("Unexpected command invocation.");
      }
      const process = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        stdin: Writable;
        kill: () => boolean;
      };
      process.stdout = new PassThrough();
      process.stderr = new PassThrough();
      process.stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
      process.kill = () => true;
      queueMicrotask(() => {
        process.stdout.end(response.stdout);
        process.stderr.end();
        process.emit("exit", 0, null);
      });
      return process as unknown as ChildProcessWithoutNullStreams;
    },
  );
}
