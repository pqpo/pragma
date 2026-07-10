import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  assertCodexModelSelection,
  assertCodexProviderConfig,
  createCodexModelDiscovery,
  parseCodexModels,
} from "../src/models.ts";

describe("Codex model discovery", () => {
  const models = parseCodexModels(
    JSON.stringify({
      models: [
        {
          slug: "gpt-next",
          display_name: "GPT Next",
          default_reasoning_level: "low",
          priority: 1,
          visibility: "list",
          supported_reasoning_levels: [
            { effort: "low", description: "Fast" },
            { effort: "ultra", description: "Delegates automatically" },
          ],
        },
        {
          slug: "gpt-hidden",
          display_name: "Hidden",
          priority: 0,
          visibility: "hide",
          supported_reasoning_levels: [{ effort: "high" }],
        },
      ],
    }),
  );

  it("uses the dynamic catalog and preserves future thinking values", () => {
    expect(models).toEqual([
      {
        id: "gpt-next",
        displayName: "GPT Next",
        provider: "openai",
        default: true,
        thinking: {
          defaultLevel: "low",
          supportedLevels: [
            { value: "low", label: "Low", description: "Fast" },
            {
              value: "ultra",
              label: "Ultra",
              description: "Delegates automatically",
            },
          ],
        },
      },
    ]);
  });

  it("omits an inconsistent default thinking level from runtime discovery", () => {
    const [model] = parseCodexModels(
      JSON.stringify({
        models: [
          {
            slug: "gpt-next",
            default_reasoning_level: "medium",
            supported_reasoning_levels: [{ effort: "high" }],
          },
        ],
      }),
    );

    expect(model?.thinking).toEqual({
      supportedLevels: [{ value: "high", label: "High" }],
    });
  });

  it("rejects unknown models and model-specific thinking levels", () => {
    expect(() => assertCodexModelSelection(models, "missing", undefined)).toThrow(
      'Unsupported Codex model "missing".',
    );
    expect(() => assertCodexModelSelection(models, "gpt-next", "high")).toThrow(
      'Unsupported Codex thinking level "high" for model "gpt-next".',
    );
    expect(() => assertCodexModelSelection(models, undefined, "ultra")).not.toThrow();
  });

  it("rejects Pragma custom provider definitions", () => {
    expect(() =>
      assertCodexProviderConfig({
        agent: {
          models: {
            defaultModelName: "custom/model",
            providers: [
              {
                provider: "custom",
                modelNames: ["model"],
                baseApi: "https://example.test",
                key: "secret",
              },
            ],
          },
        },
      } as never),
    ).toThrow("Codex runtime does not accept custom model providers");
  });

  it("runs the bundled discovery command and caches by CLI version", async () => {
    const spawn = createCommandSpawn([
      { stdout: "codex-cli test-version\n" },
      {
        stdout: JSON.stringify({
          models: [
            {
              slug: "gpt-test",
              display_name: "GPT Test",
              priority: 1,
              visibility: "list",
              supported_reasoning_levels: [{ effort: "high" }],
            },
          ],
        }),
      },
      { stdout: "codex-cli test-version\n" },
    ]);
    const listModels = createCodexModelDiscovery({
      executablePath: "codex-test-cache",
      spawn,
    });

    await expect(listModels()).resolves.toHaveLength(1);
    await expect(listModels()).resolves.toHaveLength(1);
    expect(spawn.mock.calls.map((call) => call[1])).toEqual([
      ["--version"],
      ["debug", "models", "--bundled"],
      ["--version"],
    ]);
  });
});

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
