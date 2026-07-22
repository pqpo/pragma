import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineRuntimeDriver } from "@pragma/core";
import { describe, expect, it } from "vitest";

import {
  codexRuntimePermissionsForMode,
  createRuntimeEnvironmentService,
  type RuntimeEnvironmentAdapterFactory,
} from "./runtime-environment-service.ts";
import { createRuntimeEnvironmentStore } from "./runtime-environment-store.ts";

describe("RuntimeEnvironmentService", () => {
  it("binds latest revisions without restart and resolves historical bindings", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-runtime-service-"));
    const store = createRuntimeEnvironmentStore({
      pragmaHome,
      builtIns: [definition("runtime", "Runtime v1")],
      defaultRuntimeId: "runtime",
    });
    const service = createRuntimeEnvironmentService({ store, factories: [factory()] });

    const first = await service.bind();
    const original = (await store.getRevision("runtime"))!;
    await store.update({
      expectedRevision: original.revision,
      definition: { ...original.definition, displayName: "Runtime v2" },
    });
    const second = await service.bind();

    expect(first).toMatchObject({ binding: { revision: 1 } });
    expect(first.adapter.descriptor.displayName).toBe("Runtime v1");
    expect(second).toMatchObject({ binding: { revision: 2 } });
    expect(second.adapter.descriptor.displayName).toBe("Runtime v2");
    await expect(service.resolve({ binding: first.binding })).resolves.toMatchObject({
      adapter: { descriptor: { displayName: "Runtime v1" } },
    });
  });

  it("isolates a bad factory and validates composite model selections", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-runtime-isolation-"));
    const store = createRuntimeEnvironmentStore({
      pragmaHome,
      builtIns: [definition("healthy", "Healthy"), definition("bad", "Bad", "bad.runtime")],
      defaultRuntimeId: "healthy",
    });
    const service = createRuntimeEnvironmentService({ store, factories: [factory()] });
    const inspections = await service.list();
    expect(
      inspections.find((item) => item.head.entry.runtimeId === "healthy")?.adapter,
    ).toBeDefined();
    expect(inspections.find((item) => item.head.entry.runtimeId === "bad")?.error).toContain(
      "not registered",
    );
    await expect(
      service.bind({
        modelSelection: { model: { providerId: "other", modelId: "model" } },
      }),
    ).rejects.toThrow("Runtime model is unavailable");
    await expect(
      service.bind({
        modelSelection: {
          model: { providerId: "provider", modelId: "model" },
          thinkingLevel: "extreme",
        },
      }),
    ).rejects.toThrow("thinking level is unavailable");
  });
});

describe("Codex tool permission mapping", () => {
  it.each([
    ["request-approval", "workspace-write", "on-request"],
    ["auto-approve", "workspace-write", "on-request"],
    ["full-access", "danger-full-access", "never"],
  ] as const)("maps %s to sandbox=%s and approval=%s", (mode, sandboxMode, approvalPolicy) => {
    expect(codexRuntimePermissionsForMode(mode)).toEqual({ sandboxMode, approvalPolicy });
  });
});

function factory(): RuntimeEnvironmentAdapterFactory {
  return {
    id: "test.runtime",
    version: "v1",
    create: (environment) =>
      defineRuntimeDriver({
        descriptor: { id: environment.id, kind: "test", displayName: environment.displayName },
        canUse: () => ({ usable: true }),
        listModels: async () => [
          {
            id: "model",
            displayName: "Model",
            provider: { kind: "registered", id: "provider", displayName: "Provider" },
            thinking: { supportedLevels: [{ value: "high", label: "High" }] },
          },
        ],
        createSession: () => ({}),
        startTurn: () => ({ outputText: "" }),
        mapEvent: () => ({ events: [] }),
      }),
  };
}

function definition(id: string, displayName: string, adapterId = "test.runtime") {
  return {
    schemaVersion: "pragma.runtime-environment/v1" as const,
    id,
    adapter: { id: adapterId, version: "v1" },
    displayName,
    origin: "built-in" as const,
    config: {},
  };
}
