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

import type {
  DesktopToolPermissionMode,
  RuntimeEnvironmentDefinition,
} from "../../../shared/contracts/index.ts";
import type { ModelProviderStore } from "@pragma/local-host/deployment";
import {
  assertEmptyBuiltInRuntimeConfig,
  BUILT_IN_RUNTIME_DISPLAY_NAME,
} from "@pragma/local-host/deployment";

export interface CreateBuiltInRuntimeFactoriesOptions {
  readonly modelProviders: ModelProviderStore;
  readonly modelCatalogCacheRoot?: string | undefined;
  readonly getAgentContextWindow?: (() => number | Promise<number>) | undefined;
  readonly getToolPermissionMode?:
    (() => DesktopToolPermissionMode | Promise<DesktopToolPermissionMode>) | undefined;
  readonly getRuntimeProcessEnvironment?:
    ((runtimeAdapterId: string) => Promise<NodeJS.ProcessEnv>) | undefined;
  readonly onModelCatalogUpdated?: ((runtimeId: string) => void) | undefined;
  readonly tokenCounter?: RuntimeTokenCounter | undefined;
  readonly mcpToolRegistryPool?: McpToolRegistryPool | undefined;
}

export function createBuiltInRuntimeFactories(
  options: CreateBuiltInRuntimeFactoriesOptions,
): readonly RuntimeEnvironmentAdapterFactory[] {
  const getToolPermissionMode = options.getToolPermissionMode ?? (() => "request-approval");
  const getRuntimeProcessEnvironment =
    options.getRuntimeProcessEnvironment ??
    (async (runtimeAdapterId: string) =>
      resolveLocalHostRuntimeProcessEnvironment(process.env, runtimeAdapterId));
  const onModelCatalogUpdated = options.onModelCatalogUpdated;

  async function createPiAdapter(
    environment: RuntimeEnvironmentDefinition,
    agentContextWindow: number | undefined,
    permissionMode: DesktopToolPermissionMode,
  ): Promise<RuntimeAdapter> {
    assertEmptyBuiltInRuntimeConfig(environment);
    return createPiRuntime({
      permissionMode,
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
          context?.toolPermissionMode ?? getToolPermissionMode(),
          getRuntimeProcessEnvironment("pragma.runtime.opencode"),
        ]);
        return createOpenCodeRuntime({
          descriptor: { id: environment.id, displayName: environment.displayName },
          ...(onModelCatalogUpdated === undefined
            ? {}
            : { onModelCatalogUpdated: () => onModelCatalogUpdated(environment.id) }),
          permissionMode,
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
          context?.toolPermissionMode ?? getToolPermissionMode(),
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
        const [permissionMode, env] = await Promise.all([
          context?.toolPermissionMode ?? getToolPermissionMode(),
          getRuntimeProcessEnvironment("pragma.runtime.claude-code"),
        ]);
        return createClaudeCodeRuntime({
          descriptor: { id: environment.id, displayName: environment.displayName },
          ...(onModelCatalogUpdated === undefined
            ? {}
            : { onModelCatalogUpdated: () => onModelCatalogUpdated(environment.id) }),
          permissionMode:
            permissionMode === "request-approval"
              ? "default"
              : permissionMode === "auto-approve"
                ? "auto"
                : "bypassPermissions",
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
          context?.toolPermissionMode ?? getToolPermissionMode(),
          getRuntimeProcessEnvironment("pragma.runtime.antigravity"),
        ]);
        return createAntigravityRuntime({
          descriptor: { id: environment.id, displayName: environment.displayName },
          ...(onModelCatalogUpdated === undefined
            ? {}
            : { onModelCatalogUpdated: () => onModelCatalogUpdated(environment.id) }),
          permissionMode: antigravityRuntimePermissionForMode(permissionMode),
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
        const [permissionMode, env] = await Promise.all([
          context?.toolPermissionMode ?? getToolPermissionMode(),
          getRuntimeProcessEnvironment("pragma.runtime.qodercli"),
        ]);
        return createQoderCliRuntime({
          descriptor: { id: environment.id, displayName: environment.displayName },
          ...(onModelCatalogUpdated === undefined
            ? {}
            : { onModelCatalogUpdated: () => onModelCatalogUpdated(environment.id) }),
          permissionMode: qoderRuntimePermissionForMode(permissionMode),
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
      create: async (environment, context) =>
        await createPiAdapter(
          environment,
          await options.getAgentContextWindow?.(),
          context?.toolPermissionMode ?? (await getToolPermissionMode()),
        ),
      prepare: async (environment, context) => {
        assertEmptyBuiltInRuntimeConfig(environment);
        const agentContextWindow = await options.getAgentContextWindow?.();
        const permissionMode = context?.toolPermissionMode ?? (await getToolPermissionMode());
        return {
          cacheKey: `agent-context-window=${agentContextWindow ?? "default"};permission-mode=${permissionMode}`,
          create: async () =>
            await createPiAdapter(environment, agentContextWindow, permissionMode),
        };
      },
    },
  ];
}

export function codexRuntimePermissionsForMode(mode: DesktopToolPermissionMode): {
  readonly sandboxMode: CodexRuntimeSandboxMode;
  readonly approvalPolicy: CodexRuntimeApprovalPolicy;
} {
  return mode === "full-access"
    ? { sandboxMode: "danger-full-access", approvalPolicy: "never" }
    : { sandboxMode: "workspace-write", approvalPolicy: "on-request" };
}

export function qoderRuntimePermissionForMode(
  mode: DesktopToolPermissionMode,
): QoderCliRuntimePermissionMode {
  return mode === "request-approval"
    ? "default"
    : mode === "auto-approve"
      ? "auto"
      : "bypassPermissions";
}

export function antigravityRuntimePermissionForMode(
  mode: DesktopToolPermissionMode,
): AntigravityRuntimePermissionMode {
  return mode;
}
