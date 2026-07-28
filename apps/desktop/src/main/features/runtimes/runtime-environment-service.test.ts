import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineRuntimeDriver } from "@pragma/core";
import { describe, expect, it, vi } from "vitest";

import type { DesktopToolPermissionMode } from "../../../shared/contracts/index.ts";
import {
  codexRuntimePermissionsForMode,
  createRuntimeEnvironmentService,
  qoderRuntimePermissionForMode,
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

  it("reuses one adapter for the same immutable revision and permission mode", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-runtime-cache-"));
    const store = createRuntimeEnvironmentStore({
      pragmaHome,
      builtIns: [definition("runtime", "Runtime")],
      defaultRuntimeId: "runtime",
    });
    let createCount = 0;
    let modelCatalogCallCount = 0;
    let liveDiscoveryCount = 0;
    let currentPermissionMode: DesktopToolPermissionMode = "request-approval";
    const cachedFactory: RuntimeEnvironmentAdapterFactory = {
      id: "test.runtime",
      version: "v1",
      create: (environment) => {
        createCount += 1;
        let cachedModels:
          | readonly {
              id: string;
              displayName: string;
              provider: {
                kind: "registered";
                id: string;
                displayName: string;
              };
            }[]
          | undefined;
        return defineRuntimeDriver({
          descriptor: {
            id: environment.id,
            kind: "test",
            displayName: environment.displayName,
          },
          listModels: async () => {
            modelCatalogCallCount += 1;
            if (cachedModels === undefined) {
              liveDiscoveryCount += 1;
              cachedModels = [
                {
                  id: "model",
                  displayName: "Model",
                  provider: { kind: "registered", id: "provider", displayName: "Provider" },
                },
              ];
            }
            return cachedModels;
          },
          createSession: () => ({}),
          startTurn: () => ({ outputText: "" }),
          mapEvent: () => ({ events: [] }),
        });
      },
    };
    const service = createRuntimeEnvironmentService({
      store,
      factories: [cachedFactory],
      getToolPermissionMode: () => currentPermissionMode,
    });
    const selection = { model: { providerId: "provider", modelId: "model" } };

    const [first, second] = await Promise.all([
      service.bind({ modelSelection: selection }),
      service.bind({ modelSelection: selection }),
    ]);
    await service.resolve({ binding: first.binding, modelSelection: selection });
    await service.list();

    expect(first.adapter).toBe(second.adapter);
    expect(createCount).toBe(1);
    // Model selection remains validated on every boundary. The long-lived adapter owns the
    // runtime-specific catalog cache, so external discovery is not reset by materialization.
    expect(modelCatalogCallCount).toBe(3);
    expect(liveDiscoveryCount).toBe(1);

    await service.forToolPermissionMode("full-access").bind();
    expect(createCount).toBe(2);

    currentPermissionMode = "full-access";
    await service.bind();
    expect(createCount).toBe(2);

    currentPermissionMode = "auto-approve";
    await service.bind();
    expect(createCount).toBe(3);

    const original = (await store.getRevision("runtime"))!;
    await store.update({
      expectedRevision: original.revision,
      definition: { ...original.definition, displayName: "Runtime v2" },
    });
    await service.bind();
    expect(createCount).toBe(4);
  });

  it("evicts a failed adapter materialization so a later bind can recover", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-runtime-cache-retry-"));
    const store = createRuntimeEnvironmentStore({
      pragmaHome,
      builtIns: [definition("runtime", "Runtime")],
      defaultRuntimeId: "runtime",
    });
    let createCount = 0;
    const retryingFactory: RuntimeEnvironmentAdapterFactory = {
      id: "test.runtime",
      version: "v1",
      create: async (environment) => {
        createCount += 1;
        if (createCount === 1) throw new Error("transient adapter failure");
        return defineRuntimeDriver({
          descriptor: {
            id: environment.id,
            kind: "test",
            displayName: environment.displayName,
          },
          createSession: () => ({}),
          startTurn: () => ({ outputText: "" }),
          mapEvent: () => ({ events: [] }),
        });
      },
    };
    const warn = vi.fn();
    const service = createRuntimeEnvironmentService({
      store,
      factories: [retryingFactory],
      logger: { info: vi.fn(), warn },
    });

    await expect(service.bind()).rejects.toThrow("transient adapter failure");
    await expect(service.bind()).resolves.toMatchObject({ binding: { runtimeId: "runtime" } });
    expect(createCount).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      "runtime.environment_adapter_materialization_failed",
      expect.any(String),
      expect.objectContaining({ runtimeId: "runtime", error: expect.any(Error) }),
    );
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

describe("Qoder CLI tool permission mapping", () => {
  it.each([
    ["request-approval", "default"],
    ["auto-approve", "auto"],
    ["full-access", "bypassPermissions"],
  ] as const)("maps %s to %s", (mode, permissionMode) => {
    expect(qoderRuntimePermissionForMode(mode)).toBe(permissionMode);
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
