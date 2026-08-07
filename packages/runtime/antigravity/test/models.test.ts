import { access } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runRuntimeCommand: vi.fn(),
}));

vi.mock("@pragma/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pragma/core")>()),
  runRuntimeCommand: mocks.runRuntimeCommand,
}));

import {
  assertAntigravityModelSelection,
  createAntigravityModelDiscovery,
  parseAntigravityModels,
} from "../src/models.ts";

const MODEL_OUTPUT = [
  "Fetching available models...",
  "Available models:",
  "Gemini 3.5 Flash (Medium)",
  "✓ Gemini 3.5 Flash (High)",
  "Gemini 3.5 Flash (Low)",
  "Gemini 3.1 Pro (Low)",
  "Gemini 3.1 Pro (High)",
  "Claude Sonnet 4.6 (Thinking)",
  "Claude Opus 4.6 (Thinking)",
  "GPT-OSS 120B (Medium)",
].join("\n");

describe("Antigravity model discovery", () => {
  beforeEach(() => {
    mocks.runRuntimeCommand.mockReset();
  });

  it("preserves the exact human-facing model values accepted by --model", () => {
    const models = parseAntigravityModels(MODEL_OUTPUT);

    expect(models.map((model) => model.id)).toEqual([
      "Gemini 3.5 Flash (Medium)",
      "Gemini 3.5 Flash (High)",
      "Gemini 3.5 Flash (Low)",
      "Gemini 3.1 Pro (Low)",
      "Gemini 3.1 Pro (High)",
      "Claude Sonnet 4.6 (Thinking)",
      "Claude Opus 4.6 (Thinking)",
      "GPT-OSS 120B (Medium)",
    ]);
    expect(models[1]).toMatchObject({
      id: "Gemini 3.5 Flash (High)",
      displayName: "Gemini 3.5 Flash (High)",
      default: true,
      inputModalities: ["text"],
      provider: { id: "antigravity", kind: "runtime-managed", displayName: "Antigravity" },
    });
    expect(models[1]?.thinking).toBeUndefined();
  });

  it("accepts columnar machine IDs and advertised effort without conflating effort and model defaults", () => {
    const models = parseAntigravityModels(
      "gemini-3.1-pro  Gemini 3.1 Pro  effort: low, medium (default), high\n",
    );

    expect(models).toEqual([
      expect.objectContaining({
        id: "gemini-3.1-pro",
        displayName: "Gemini 3.1 Pro",
        thinking: {
          defaultLevel: "medium",
          supportedLevels: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ],
        },
      }),
    ]);
    expect(models[0]?.default).toBeUndefined();
  });

  it("preserves a plain stable user-facing slug", () => {
    expect(parseAntigravityModels("gemini-3.1-pro-high\n")).toEqual([
      expect.objectContaining({
        id: "gemini-3.1-pro-high",
      }),
    ]);
  });

  it("discovers inside a disposable private HOME and removes it afterwards", async () => {
    let discoveryHome = "";
    mocks.runRuntimeCommand.mockImplementation(async (options) => {
      discoveryHome = options.cwd as string;
      expect(options.args).toEqual(["models"]);
      expect(options.env).toMatchObject({
        HOME: discoveryHome,
        USERPROFILE: discoveryHome,
        TMPDIR: `${discoveryHome}/tmp`,
        AGY_CLI_DISABLE_AUTO_UPDATE: "true",
        EXPLICIT_AUTH: "kept",
      });
      expect(options.env["AGY_APP_DATA_DIR"]).toBeUndefined();
      expect(options.env["GEMINI_CONFIG_DIR"]).toBeUndefined();
      return { exitCode: 0, signal: null, stdout: MODEL_OUTPUT, stderr: "" };
    });

    const models = await createAntigravityModelDiscovery({
      executablePath: `/opt/agy-${randomUUID()}`,
      env: {
        EXPLICIT_AUTH: "kept",
        AGY_APP_DATA_DIR: "/host/agy",
        GEMINI_CONFIG_DIR: "/host/gemini",
      },
    })();

    expect(models).toHaveLength(8);
    await expect(access(discoveryHome)).rejects.toThrow();
  });

  it("coalesces equivalent catalogs but isolates different spawn functions", async () => {
    mocks.runRuntimeCommand.mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: MODEL_OUTPUT,
      stderr: "",
    });
    const executablePath = `/opt/agy-${randomUUID()}`;
    const spawnA = vi.fn() as never;
    const spawnB = vi.fn() as never;
    const first = createAntigravityModelDiscovery({ executablePath, spawn: spawnA });
    const second = createAntigravityModelDiscovery({ executablePath, spawn: spawnA });

    await Promise.all([first(), second()]);
    await createAntigravityModelDiscovery({ executablePath, spawn: spawnB })();

    expect(mocks.runRuntimeCommand).toHaveBeenCalledTimes(2);
  });

  it("reports authentication failures without inventing a fallback catalog", async () => {
    mocks.runRuntimeCommand.mockResolvedValue({
      exitCode: 1,
      signal: null,
      stdout: "Fetching available models...",
      stderr: "Error: Please sign in to view available models.",
    });

    await expect(
      createAntigravityModelDiscovery({ executablePath: `/opt/agy-${randomUUID()}` })(),
    ).rejects.toThrow("not signed in");
  });

  it("validates model and effort selections against live capabilities", () => {
    const models = parseAntigravityModels(
      "gemini-3.1-pro  Gemini 3.1 Pro  effort: low, medium (default), high\n",
    );
    expect(() => assertAntigravityModelSelection(models, "gemini-3.1-pro", "high")).not.toThrow();
    expect(() => assertAntigravityModelSelection(models, "missing", undefined)).toThrow(
      "model is unavailable",
    );
    expect(() => assertAntigravityModelSelection(models, "gemini-3.1-pro", "max")).toThrow(
      "reasoning effort is unavailable",
    );
    expect(() => assertAntigravityModelSelection(models, undefined, "high")).not.toThrow();
    expect(() => assertAntigravityModelSelection(models, undefined, "max")).toThrow(
      "reasoning effort is unavailable",
    );
    expect(() =>
      assertAntigravityModelSelection(
        parseAntigravityModels("gemini-3.1-pro\n"),
        "gemini-3.1-pro",
        "medium",
      ),
    ).not.toThrow();
  });
});
