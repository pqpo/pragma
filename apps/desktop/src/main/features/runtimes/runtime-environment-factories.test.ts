import { defineRuntimeDriver } from "@pragma/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClaudeCodeRuntime: vi.fn(),
  createCodexRuntime: vi.fn(),
  createPiRuntime: vi.fn(),
  createQoderCliRuntime: vi.fn(),
}));

vi.mock("@pragma/runtime-claude-code", () => ({
  createClaudeCodeRuntime: mocks.createClaudeCodeRuntime,
}));
vi.mock("@pragma/runtime-codex", () => ({
  createCodexRuntime: mocks.createCodexRuntime,
}));
vi.mock("@pragma/runtime-pi", () => ({
  createPiRuntime: mocks.createPiRuntime,
}));
vi.mock("@pragma/runtime-qodercli", () => ({
  createQoderCliRuntime: mocks.createQoderCliRuntime,
}));

import type { ModelProviderStore } from "../model-providers/model-provider-store.ts";
import { createBuiltInRuntimeFactories } from "./runtime-environment-service.ts";

describe("built-in Runtime factory environment injection", () => {
  beforeEach(() => {
    mocks.createCodexRuntime.mockReset().mockReturnValue(runtimeAdapter("codex"));
    mocks.createClaudeCodeRuntime.mockReset().mockReturnValue(runtimeAdapter("claude-code"));
    mocks.createQoderCliRuntime.mockReset().mockReturnValue(runtimeAdapter("qodercli"));
    mocks.createPiRuntime.mockReset().mockReturnValue(runtimeAdapter("pi"));
  });

  it("passes the same recovered environment to every CLI Runtime and not to PI", async () => {
    const environment = Object.freeze({
      ...process.env,
      PATH: "/recovered/bin:/usr/bin:/bin",
    });
    const getRuntimeProcessEnvironment = vi.fn(async () => environment);
    const factories = createBuiltInRuntimeFactories({
      modelProviders: {} as ModelProviderStore,
      getRuntimeProcessEnvironment,
    });

    await Promise.all(
      [
        ["codex", "pragma.runtime.codex"],
        ["claude-code", "pragma.runtime.claude-code"],
        ["qodercli", "pragma.runtime.qodercli"],
        ["pi", "pragma.runtime.pi"],
      ].map(async ([runtimeId, adapterId]) => {
        const factory = factories.find((candidate) => candidate.id === adapterId)!;
        await factory.create(definition(runtimeId!, adapterId!));
      }),
    );

    expect(mocks.createCodexRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ env: environment }),
    );
    expect(mocks.createClaudeCodeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ env: environment }),
    );
    expect(mocks.createQoderCliRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ env: environment }),
    );
    expect(mocks.createPiRuntime).toHaveBeenCalledOnce();
    expect(mocks.createPiRuntime.mock.calls[0]?.[0]).not.toHaveProperty("env");
    expect(getRuntimeProcessEnvironment).toHaveBeenCalledTimes(3);
  });
});

function runtimeAdapter(id: string) {
  return defineRuntimeDriver({
    descriptor: { id, kind: "test", displayName: id },
    createSession: () => ({}),
    startTurn: () => ({ outputText: "" }),
    mapEvent: () => ({ events: [] }),
  });
}

function definition(id: string, adapterId: string) {
  return {
    schemaVersion: "pragma.runtime-environment/v1" as const,
    id,
    adapter: { id: adapterId, version: "v1" },
    displayName: id,
    origin: "built-in" as const,
    config: {},
  };
}
