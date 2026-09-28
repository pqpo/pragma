import type {
  RuntimeCanUseResult,
  RuntimeDriverDescriptorOverride,
  RuntimeCommandSpawn,
  RuntimeModel,
  RuntimeModelDiscoveryOptions,
  RuntimeSessionRestoreHandler,
  RuntimeSessionSyncCallback,
  RuntimeTokenCounter,
  McpToolRegistryPool,
} from "@pragma/core";

export type ClaudeCodeRuntimePermissionMode =
  "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions";

export type ClaudeCodeRuntimeSpawn = RuntimeCommandSpawn;

export interface ClaudeCodeRuntimeAdapterOptions {
  readonly descriptor?: RuntimeDriverDescriptorOverride | undefined;
  readonly acpWorkerPath?: string | undefined;
  readonly executablePath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly defaultModelName?: string | undefined;
  readonly defaultThinkingLevel?: string | undefined;
  readonly modelCatalogCacheRoot?: string | undefined;
  readonly listModels?:
    ((options?: RuntimeModelDiscoveryOptions) => Promise<readonly RuntimeModel[]>) | undefined;
  readonly onModelCatalogUpdated?: (() => void) | undefined;
  readonly permissionMode?: ClaudeCodeRuntimePermissionMode | undefined;
  readonly additionalArgs?: readonly string[] | undefined;
  readonly spawn?: ClaudeCodeRuntimeSpawn | undefined;
  readonly canUse?: (() => Promise<RuntimeCanUseResult> | RuntimeCanUseResult) | undefined;
  readonly outputRetryLimit?: number | undefined;
  readonly sessionRestoreHandler?: RuntimeSessionRestoreHandler | undefined;
  readonly sessionSyncCallback?: RuntimeSessionSyncCallback | undefined;
  readonly tokenCounter?: RuntimeTokenCounter | undefined;
  readonly mcpToolRegistryPool?: McpToolRegistryPool | undefined;
}
