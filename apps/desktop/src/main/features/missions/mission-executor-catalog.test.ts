import type { RuntimeModel, RuntimeResolver } from "@pragma/core";
import { createRuntimeTestFeatures } from "@pragma/core/testing";
import type { PragmaResource } from "@pragma/interpreter/ast";
import { describe, expect, it } from "vitest";

import { createMissionExecutorCatalog } from "./mission-executor-catalog.ts";
import { ModelProviderStoreError } from "../model-providers/model-provider-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { DesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";

describe("Mission executor model options", () => {
  it("returns a reset-required state for an unsupported provider config", async () => {
    const catalog = createCatalog(async () => {
      throw new ModelProviderStoreError(
        "config_invalid",
        "This model provider configuration uses an older format.",
      );
    });

    await expect(catalog.getModelOptions("expert:2qgbztga4kz2qz51")).resolves.toEqual({
      status: "reset_required",
      runtime: { id: "pi", displayName: "PI" },
      models: [],
    });
  });

  it("keeps normal runtime model catalogs ready", async () => {
    const catalog = createCatalog(async () => [
      {
        id: "model",
        displayName: "Model",
        default: true,
        provider: {
          kind: "runtime-managed" as const,
          id: "provider",
          displayName: "Provider",
        },
        thinking: {
          supportedLevels: [{ value: "high", label: "High" }],
          defaultLevel: "high",
        },
      },
    ]);

    await expect(catalog.getModelOptions("expert:2qgbztga4kz2qz51")).resolves.toMatchObject({
      status: "ready",
      runtime: { id: "pi", displayName: "PI" },
      models: [{ id: "model" }],
      defaultSelection: { providerId: "provider", modelId: "model", thinkingLevel: "high" },
    });
  });

  it("reports a pinned executor model instead of the Runtime default", async () => {
    const catalog = createCatalog(
      async () => [
        {
          id: "runtime-default",
          displayName: "Runtime default",
          default: true,
          provider: {
            kind: "runtime-managed" as const,
            id: "runtime",
            displayName: "Runtime",
          },
        },
        {
          id: "pinned",
          displayName: "Pinned",
          provider: {
            kind: "runtime-managed" as const,
            id: "provider",
            displayName: "Provider",
          },
          thinking: {
            supportedLevels: [{ value: "medium", label: "Medium" }],
            defaultLevel: "medium",
          },
        },
      ],
      {
        mode: "pinned",
        model: { runtimeId: "pi", providerId: "provider", modelId: "pinned" },
      },
    );

    await expect(catalog.getModelOptions("expert:2qgbztga4kz2qz51")).resolves.toMatchObject({
      defaultSelection: { providerId: "provider", modelId: "pinned", thinkingLevel: "medium" },
    });
  });

  it("uses the persisted Mission Session Runtime instead of the current default Runtime", async () => {
    const piModels: readonly RuntimeModel[] = [
      {
        id: "pi-model",
        displayName: "PI Model",
        provider: {
          kind: "registered",
          id: "pi-provider",
          displayName: "PI Provider",
        },
      },
    ];
    const codexModels: readonly RuntimeModel[] = [
      {
        id: "codex-model",
        displayName: "Codex Model",
        provider: {
          kind: "runtime-managed",
          id: "openai",
          displayName: "OpenAI",
        },
      },
    ];
    const runtime = (id: string, models: readonly RuntimeModel[]) => ({
      features: createRuntimeTestFeatures({ enabled: ["availability", "modelDiscovery"] }),
      descriptor: { id, kind: "test", displayName: id },
      canUse: async () => ({ usable: true }),
      listModels: async () => models,
      createSession: async () => {
        throw new Error("unused");
      },
    });
    const runtimes: RuntimeResolver = {
      getDefaultRuntimeId: async () => "codex",
      bind: async () => ({
        binding: { runtimeId: "codex", revision: 2, fingerprint: "b".repeat(64) },
        adapter: runtime("codex", codexModels),
      }),
      resolve: async ({ binding }) => ({ binding, adapter: runtime("pi", piModels) }),
    };
    const systemExperts = {
      get: () => ({ executionProfile: { mode: "system-default" } }),
      getExecutor: () => undefined,
      listExecutors: () => [],
    } as unknown as DesktopSystemExpertRegistry;
    const project = {
      get: async () => {
        throw new Error("unused");
      },
    } as unknown as PragmaProjectStore;
    const catalog = createMissionExecutorCatalog({ project, systemExperts, runtimes });

    await expect(
      catalog.getModelOptions("expert:2qgbztga4kz2qz51", {
        runtimeId: "pi",
        revision: 1,
        fingerprint: "a".repeat(64),
      }),
    ).resolves.toMatchObject({
      status: "ready",
      runtime: { id: "pi", displayName: "pi" },
      models: [{ id: "pi-model", provider: { id: "pi-provider" } }],
      defaultSelection: { providerId: "pi-provider", modelId: "pi-model" },
    });
  });

  it("resolves model defaults from the Mission's pinned project resources", async () => {
    const boundRuntimeIds: string[] = [];
    const runtime = {
      features: createRuntimeTestFeatures({ enabled: ["availability", "modelDiscovery"] }),
      descriptor: { id: "pinned-runtime", kind: "test", displayName: "Pinned Runtime" },
      canUse: async () => ({ usable: true }),
      listModels: async () => [],
    };
    const runtimes: RuntimeResolver = {
      getDefaultRuntimeId: async () => "current-runtime",
      bind: async (request) => {
        const runtimeId = request?.runtimeId;
        if (runtimeId === undefined) throw new Error("Expected an explicit Runtime ID.");
        boundRuntimeIds.push(runtimeId);
        return {
          binding: { runtimeId, revision: 1, fingerprint: "a".repeat(64) },
          adapter: runtime,
        };
      },
      resolve: async () => {
        throw new Error("unused");
      },
    };
    const project = {
      get: async () => ({ resources: [] }),
    } as unknown as PragmaProjectStore;
    const systemExperts = {
      get: () => undefined,
      getExecutor: () => undefined,
      listExecutors: () => [],
    } as unknown as DesktopSystemExpertRegistry;
    const catalog = createMissionExecutorCatalog({ project, systemExperts, runtimes });
    const resources = [
      {
        apiVersion: "pragma/v4",
        kind: "RuntimeProfile",
        metadata: { id: "2v60qnte9072fwk7", name: "Pinned" },
        spec: { config: { runtimeId: "pinned-runtime" } },
      },
      {
        apiVersion: "pragma/v4",
        kind: "Expert",
        metadata: { id: "kgtpajmnv08n7zah", name: "Worker" },
        spec: { runtime: { ref: "runtime-profile:2v60qnte9072fwk7" } },
      },
    ] as unknown as readonly PragmaResource[];

    await expect(
      catalog.getModelOptions("expert:kgtpajmnv08n7zah", undefined, resources),
    ).resolves.toMatchObject({ runtime: { id: "pinned-runtime" } });
    expect(boundRuntimeIds).toEqual(["pinned-runtime"]);
  });
});

function createCatalog(
  listModels: () => Promise<readonly RuntimeModel[]>,
  executionProfile:
    | { readonly mode: "system-default" }
    | {
        readonly mode: "pinned";
        readonly model: {
          readonly runtimeId: string;
          readonly providerId: string;
          readonly modelId: string;
        };
      } = { mode: "system-default" },
) {
  const runtimes: RuntimeResolver = {
    getDefaultRuntimeId: async () => "pi",
    bind: async () => ({
      binding: { runtimeId: "pi", revision: 1, fingerprint: "a".repeat(64) },
      adapter: {
        features: createRuntimeTestFeatures({ enabled: ["availability", "modelDiscovery"] }),
        descriptor: { id: "pi", kind: "cloud-pi-agent", displayName: "PI" },
        canUse: async () => ({ usable: true }),
        listModels,
        createSession: async () => {
          throw new Error("unused");
        },
      },
    }),
    resolve: async () => {
      throw new Error("unused");
    },
  };
  const systemExperts = {
    get: () => ({ executionProfile }),
    getExecutor: () => undefined,
    listExecutors: () => [],
  } as unknown as DesktopSystemExpertRegistry;
  const project = {
    get: async () => {
      throw new Error("unused");
    },
  } as unknown as PragmaProjectStore;
  return createMissionExecutorCatalog({ project, systemExperts, runtimes });
}
