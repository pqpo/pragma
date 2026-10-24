export {
  createRuntimeEnvironmentService,
  type RuntimeEnvironmentAdapterFactory,
  type RuntimeEnvironmentAdapterPreparation,
  type RuntimeEnvironmentInspection,
  type RuntimeEnvironmentService,
} from "@pragma/local-host/deployment";
import type { RuntimeEnvironmentAdapterFactory } from "@pragma/local-host/deployment";
import type { McpToolRegistryPool, RuntimeAdapter, RuntimeTokenCounter } from "@pragma/core";
import { resolveLocalHostRuntimeProcessEnvironment } from "@pragma/local-host";
import {
  createAntigravityRuntime,
  type AntigravityRuntimePermissionMode,
} from "@pragma/runtime-antigravity";
import { createClaudeCodeRuntime } from "@pragma/runtime-claude-code";
import {
  createCodexRuntime,
  type CodexRuntimeApprovalPolicy,
  type CodexRuntimeSandboxMode,
} from "@pragma/runtime-codex";
import { createOpenCodeRuntime } from "@pragma/runtime-opencode";
import { createPiRuntime } from "@pragma/runtime-pi";
import type { QoderCliRuntimePermissionMode } from "@pragma/runtime-qodercli";
import { createQoderCliRuntime } from "@pragma/runtime-qodercli";

import type { RuntimeEnvironmentDefinition } from "../../../shared/contracts/index.ts";
import type { ModelProviderStore } from "@pragma/local-host/deployment";
import {
  assertEmptyBuiltInRuntimeConfig,
  BUILT_IN_RUNTIME_DISPLAY_NAME,
} from "@pragma/local-host/deployment";

export interface CreateBuiltInRuntimeFactoriesOptions {
  readonly modelProviders: ModelProviderStore;
  readonly modelCatalogCacheRoot?: string | undefined;
  readonly getAgentContextWindow?: (() => number | Promise<number>) | undefined;
  readonly getRuntimeProcessEnvironment?:
    ((runtimeAdapterId: string) => Promise<NodeJS.ProcessEnv>) | undefined;
  readonly onModelCatalogUpdated?: ((runtimeId: string) => void) | undefined;
  readonly tokenCounter?: RuntimeTokenCounter | undefined;
  readonly mcpToolRegistryPool?: McpToolRegistryPool | undefined;
}

export function createBuiltInRuntimeFactories(
  options: CreateBuiltInRuntimeFactoriesOptions,
): readonly RuntimeEnvironmentAdapterFactory[] {
  const getRuntimeProcessEnvironment =
    options.getRuntimeProcessEnvironment ??
    (async (runtimeAdapterId: string) =>
      resolveLocalHostRuntimeProcessEnvironment(process.env, runtimeAdapterId));
  const onModelCatalogUpdated = options.onModelCatalogUpdated;

  async function createPiAdapter(
    environment: RuntimeEnvironmentDefinition,
    agentContextWindow: number | undefined,
  ): Promise<RuntimeAdapter> {
    assertEmptyBuiltInRuntimeConfig(environment);
    return createPiRuntime({
      descriptor: { id: environment.id, displayName: BUILT_IN_RUNTIME_DISPLAY_NAME },
      modelProviders: options.modelProviders,
      env: await getRuntimeProcessEnvironment("pragma.runtime.pi"),
      ...(agentContextWindow === undefined ? {} : { agentContextWindow }),
      tokenCounter: options.tokenCounter,
      ...(options.mcpToolRegistryPool === undefined
        ? {}
        : { mcpToolRegistryPool: options.mcpToolRegistryPool }),
    });
  }

  return [
    {
      id: "pragma.runtime.opencode",
      version: "v1",
      create: async (environment, context) => {
        assertEmptyBuiltInRuntimeConfig(environment);
        const [permissionMode, env] = await Promise.all([
          context?.permissionModeId ?? "full-access",
          getRuntimeProcessEnvironment("pragma.runtime.opencode"),
        ]);
        return createOpenCodeRuntime({
          descriptor: { id: environment.id, displayName: environment.displayName },
          ...(onModelCatalogUpdated === undefined
            ? {}
            : { onModelCatalogUpdated: () => onModelCatalogUpdated(environment.id) }),
          permissionMode: permissionMode as "request-approval" | "auto-approve" | "full-access",
          env,
          modelCatalogCacheRoot: options.modelCatalogCacheRoot,
          tokenCounter: options.tokenCounter,
          ...(options.mcpToolRegistryPool === undefined
            ? {}
            : { mcpToolRegistryPool: options.mcpToolRegistryPool }),
        });
      },
    },
    {
      id: "pragma.runtime.codex",
      version: "v1",
      create: async (environment, context) => {
        assertEmptyBuiltInRuntimeConfig(environment);
        const [permissionMode, env] = await Promise.all([
          context?.permissionModeId ?? "full-access",
          getRuntimeProcessEnvironment("pragma.runtime.codex"),
        ]);
        const permissions = codexRuntimePermissionsForMode(permissionMode);
        return createCodexRuntime({
          descriptor: { id: environment.id, displayName: environment.displayName },
          ...(onModelCatalogUpdated === undefined
            ? {}
            : { onModelCatalogUpdated: () => onModelCatalogUpdated(environment.id) }),
          ...permissions,
          env,
          modelCatalogCacheRoot: options.modelCatalogCacheRoot,
          tokenCounter: options.tokenCounter,
          ...(options.mcpToolRegistryPool === undefined
            ? {}
            : { mcpToolRegistryPool: options.mcpToolRegistryPool }),
        });
      },
    },
    {
      id: "pragma.runtime.claude-code",
      version: "v1",
      create: async (environment, context) => {
        assertEmptyBuiltInRuntimeConfig(environment);
        const env = await getRuntimeProcessEnvironment("pragma.runtime.claude-code");
        return createClaudeCodeRuntime({
          descriptor: { id: environment.id, displayName: environment.displayName },
          ...(onModelCatalogUpdated === undefined
            ? {}
            : { onModelCatalogUpdated: () => onModelCatalogUpdated(environment.id) }),
          permissionMode: (context?.permissionModeId ?? "bypassPermissions") as
            "default" | "auto" | "bypassPermissions",
          env,
          modelCatalogCacheRoot: options.modelCatalogCacheRoot,
          tokenCounter: options.tokenCounter,
          ...(options.mcpToolRegistryPool === undefined
            ? {}
            : { mcpToolRegistryPool: options.mcpToolRegistryPool }),
        });
      },
    },
    {
      id: "pragma.runtime.antigravity",
      version: "v1",
      create: async (environment, context) => {
        assertEmptyBuiltInRuntimeConfig(environment);
        const [permissionMode, env] = await Promise.all([
          context?.permissionModeId ?? "full-access",
          getRuntimeProcessEnvironment("pragma.runtime.antigravity"),
        ]);
        return createAntigravityRuntime({
          descriptor: { id: environment.id, displayName: environment.displayName },
          ...(onModelCatalogUpdated === undefined
            ? {}
            : { onModelCatalogUpdated: () => onModelCatalogUpdated(environment.id) }),
          permissionMode: permissionMode as AntigravityRuntimePermissionMode,
          authenticationMode: "auto",
          env,
          modelCatalogCacheRoot: options.modelCatalogCacheRoot,
          tokenCounter: options.tokenCounter,
          ...(options.mcpToolRegistryPool === undefined
            ? {}
            : { mcpToolRegistryPool: options.mcpToolRegistryPool }),
        });
      },
    },
    {
      id: "pragma.runtime.qodercli",
      version: "v1",
      create: async (environment, context) => {
        assertEmptyBuiltInRuntimeConfig(environment);
        const env = await getRuntimeProcessEnvironment("pragma.runtime.qodercli");
        return createQoderCliRuntime({
          descriptor: { id: environment.id, displayName: environment.displayName },
          ...(onModelCatalogUpdated === undefined
            ? {}
            : { onModelCatalogUpdated: () => onModelCatalogUpdated(environment.id) }),
          permissionMode: (context?.permissionModeId ??
            "bypassPermissions") as QoderCliRuntimePermissionMode,
          env,
          modelCatalogCacheRoot: options.modelCatalogCacheRoot,
          tokenCounter: options.tokenCounter,
          ...(options.mcpToolRegistryPool === undefined
            ? {}
            : { mcpToolRegistryPool: options.mcpToolRegistryPool }),
        });
      },
    },
    {
      id: "pragma.runtime.pi",
      version: "v1",
      create: async (environment) =>
        await createPiAdapter(environment, await options.getAgentContextWindow?.()),
      prepare: async (environment) => {
        assertEmptyBuiltInRuntimeConfig(environment);
        const agentContextWindow = await options.getAgentContextWindow?.();
        return {
          cacheKey: `agent-context-window=${agentContextWindow ?? "default"}`,
          create: async () => await createPiAdapter(environment, agentContextWindow),
        };
      },
    },
  ];
}

export function codexRuntimePermissionsForMode(mode: string): {
  readonly sandboxMode: CodexRuntimeSandboxMode;
  readonly approvalPolicy: CodexRuntimeApprovalPolicy;
} {
  return mode === "read-only"
    ? { sandboxMode: "read-only", approvalPolicy: "never" }
    : mode === "full-access"
      ? { sandboxMode: "danger-full-access", approvalPolicy: "never" }
      : mode === "request-approval"
        ? { sandboxMode: "workspace-write", approvalPolicy: "on-request" }
        : (() => {
            throw new Error(`Unsupported Codex permission mode: ${mode}`);
          })();
}
