import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { createPiModelProviderConverter } from "@pragma/runtime-pi";
import { describe, expect, it, vi } from "vitest";

import type { DesktopToolPermissionMode } from "../../../shared/contracts/index.ts";
import type { ModelProviderStore } from "../model-providers/model-provider-store.ts";
import { createDesktopSettingsStore } from "../settings/desktop-settings-store.ts";
import {
  antigravityRuntimePermissionForMode,
  codexRuntimePermissionsForMode,
  createBuiltInRuntimeFactories,
  createRuntimeEnvironmentService,
  qoderRuntimePermissionForMode,
  type RuntimeEnvironmentAdapterFactory,
} from "./runtime-environment-service.ts";
import { createRuntimeEnvironmentStore } from "./runtime-environment-store.ts";

const desktopSettingsV1Fixture = new URL(
  "../settings/fixtures/desktop-settings-v1.json",
  import.meta.url,
);

describe("RuntimeEnvironmentService", () => {
  it("binds latest revisions without restart and resolves historical bindings", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-runtime-service-"));
    const store = createRuntimeEnvironmentStore({
      pragmaHome,
      builtIns: [definition("pi", "Runtime v1")],
    });
    const service = createRuntimeEnvironmentService({ store, factories: [factory()] });

    const first = await service.bind();
    const original = (await store.getRevision("pi"))!;
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
      builtIns: [definition("pi", "Healthy"), definition("bad", "Bad", "bad.runtime")],
    });
    const service = createRuntimeEnvironmentService({ store, factories: [factory()] });
    const inspections = await service.list();
    expect(inspections.find((item) => item.head.entry.runtimeId === "pi")?.adapter).toBeDefined();
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
      builtIns: [definition("pi", "Runtime")],
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
        return defineRuntimeTestDriver({
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

    const original = (await store.getRevision("pi"))!;
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
      builtIns: [definition("pi", "Runtime")],
    });
    let createCount = 0;
    const retryingFactory: RuntimeEnvironmentAdapterFactory = {
      id: "test.runtime",
      version: "v1",
      create: async (environment) => {
        createCount += 1;
        if (createCount === 1) throw new Error("transient adapter failure");
        return defineRuntimeTestDriver({
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
    await expect(service.bind()).resolves.toMatchObject({ binding: { runtimeId: "pi" } });
    expect(createCount).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      "runtime.environment_adapter_materialization_failed",
      expect.any(String),
      expect.objectContaining({ runtimeId: "pi", error: expect.any(Error) }),
    );
  });

  it("rematerializes adapters when the process environment generation changes", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-runtime-environment-generation-"));
    const store = createRuntimeEnvironmentStore({
      pragmaHome,
      builtIns: [definition("pi", "Runtime")],
    });
    let environmentGeneration = 1;
    const create = vi.fn(factory().create);
    const service = createRuntimeEnvironmentService({
      store,
      factories: [{ ...factory(), create }],
      getMaterializationCacheKey: () => `environment:${environmentGeneration}`,
    });

    const first = await service.bind();
    const second = await service.bind();
    environmentGeneration += 1;
    const refreshed = await service.bind();

    expect(second.adapter).toBe(first.adapter);
    expect(refreshed.adapter).not.toBe(first.adapter);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("uses one prepared dynamic snapshot for an adapter and its cache key", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-runtime-prepared-cache-"));
    const store = createRuntimeEnvironmentStore({
      pragmaHome,
      builtIns: [definition("pi", "Runtime")],
    });
    let agentContextWindow = 258_000;
    let markCreateStarted: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    let allowCreateToFinish: (() => void) | undefined;
    const createMayFinish = new Promise<void>((resolve) => {
      allowCreateToFinish = resolve;
    });
    const create = vi.fn((): never => {
      throw new Error("A prepared adapter must not call the fallback factory.");
    });
    const prepare = vi.fn(() => {
      const capturedAgentContextWindow = agentContextWindow;
      return {
        cacheKey: `agent-context-window=${capturedAgentContextWindow}`,
        create: async () => {
          markCreateStarted?.();
          await createMayFinish;
          return defineRuntimeTestDriver({
            descriptor: {
              id: "pi",
              kind: "test",
              displayName: `Window ${capturedAgentContextWindow}`,
            },
            createSession: () => ({}),
            startTurn: () => ({ outputText: "" }),
            mapEvent: () => ({ events: [] }),
          });
        },
      };
    });
    const service = createRuntimeEnvironmentService({
      store,
      factories: [
        {
          id: "test.runtime",
          version: "v1",
          prepare,
          create,
        },
      ],
    });

    const initialBinding = service.bind();
    await createStarted;
    // This change lands after preparation and cache-key creation but before the adapter has
    // finished materializing. The adapter must keep the prepared value rather than mixing it
    // with this newer setting.
    agentContextWindow = 320_000;
    allowCreateToFinish?.();
    const initial = await initialBinding;
    const updated = await service.bind();
    agentContextWindow = 258_000;
    const restored = await service.bind();

    expect(initial.adapter.descriptor.displayName).toBe("Window 258000");
    expect(updated.adapter.descriptor.displayName).toBe("Window 320000");
    expect(restored.adapter).toBe(initial.adapter);
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(create).not.toHaveBeenCalled();
  });

  it("carries a historical Desktop setting through Pi preparation and native model conversion", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-pi-v1-settings-startup-"));
    const settingsPath = join(root, "state", "desktop-settings.json");
    await mkdir(dirname(settingsPath), { recursive: true });
    await copyFile(desktopSettingsV1Fixture, settingsPath);
    const settings = createDesktopSettingsStore({
      settingsPath,
      builtInDefaultWorkspace: join(root, "workspace"),
    });
    const getAgentContextWindow = async () =>
      (await settings.getSnapshot(["en-US"])).agentContextWindow;
    const piFactory = createBuiltInRuntimeFactories({
      modelProviders: {} as ModelProviderStore,
      getAgentContextWindow,
      getRuntimeProcessEnvironment: async () => ({}),
    }).find((factory) => factory.id === "pragma.runtime.pi")!;

    const preparation = await piFactory.prepare?.(definition("pi", "Pi", "pragma.runtime.pi"));
    if (preparation === undefined) throw new Error("Pi factory must prepare its dynamic settings.");
    expect(preparation.cacheKey).toBe("agent-context-window=258000");
    await expect(preparation.create()).resolves.toMatchObject({
      descriptor: { id: "pi" },
    });

    const provider = createPiModelProviderConverter({
      agentContextWindow: await getAgentContextWindow(),
    }).convertProvider({
      id: "provider",
      catalogId: "qwen-token-plan-cn",
      displayName: "Provider",
      api: "openai-completions",
      baseUrl: "https://models.example.com/v1",
      apiKey: "secret",
      credentialFingerprint: "fingerprint",
      models: [
        {
          id: "qwen3.8-max",
          name: "Qwen 3.8 Max",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000_000,
          maxTokens: 131_072,
        },
      ],
    });

    expect(provider.models[0]?.contextWindow).toBe(258_000);
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

describe("Antigravity CLI tool permission mapping", () => {
  it.each(["request-approval", "auto-approve", "full-access"] as const)(
    "preserves the Desktop %s policy",
    (mode) => {
      expect(antigravityRuntimePermissionForMode(mode)).toBe(mode);
    },
  );
});

describe("built-in Runtime process environments", () => {
  it.runIf(process.platform !== "win32")(
    "injects one recovered environment into every built-in Runtime",
    async () => {
      const executableDirectory = await mkdtemp(join(tmpdir(), "pragma-runtime-probes-"));
      await Promise.all(
        ["codex", "claude", "qodercli", "agy"].map(async (name) => {
          await writeFile(
            join(executableDirectory, name),
            [
              "#!/bin/sh",
              '[ "$MOCK_ENV_TEST" = "true" ] || exit 42',
              'printf "1.1.11\\n"',
              "",
            ].join("\n"),
            { mode: 0o755 },
          );
        }),
      );

      const environment = Object.freeze({
        ...process.env,
        PATH: executableDirectory,
        MOCK_ENV_TEST: "true",
      });
      const getRuntimeProcessEnvironment = vi.fn(async () => environment);
      const factories = createBuiltInRuntimeFactories({
        modelProviders: {} as ModelProviderStore,
        getRuntimeProcessEnvironment,
      });

      const cliAdapters = await Promise.all(
        [
          ["codex", "pragma.runtime.codex"],
          ["claude-code", "pragma.runtime.claude-code"],
          ["qodercli", "pragma.runtime.qodercli"],
          ["antigravity", "pragma.runtime.antigravity"],
        ].map(async ([id, adapterId]) => {
          const factory = factories.find((candidate) => candidate.id === adapterId)!;
          return await factory.create(definition(id!, id!, adapterId));
        }),
      );

      await expect(
        Promise.all(cliAdapters.map(async (adapter) => await adapter.canUse())),
      ).resolves.toEqual([
        expect.objectContaining({ usable: true }),
        expect.objectContaining({ usable: true }),
        expect.objectContaining({ usable: true }),
        expect.objectContaining({ usable: true }),
      ]);
      expect(getRuntimeProcessEnvironment).toHaveBeenCalledTimes(4);

      const piFactory = factories.find((candidate) => candidate.id === "pragma.runtime.pi")!;
      await piFactory.create(definition("pi", "PI", "pragma.runtime.pi"));
      expect(getRuntimeProcessEnvironment).toHaveBeenCalledTimes(5);
    },
  );
});

function factory(): RuntimeEnvironmentAdapterFactory {
  return {
    id: "test.runtime",
    version: "v1",
    create: (environment) =>
      defineRuntimeTestDriver({
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
