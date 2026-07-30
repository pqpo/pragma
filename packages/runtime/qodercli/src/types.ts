import type {
  RuntimeAdapterDescriptor,
  RuntimeCanUseResult,
  RuntimeModel,
  RuntimeSessionRestoreHandler,
  RuntimeSessionSyncCallback,
  RuntimeTokenCounter,
  McpToolRegistryPool,
} from "@pragma/core";

export type QoderCliRuntimePermissionMode = "default" | "auto" | "bypassPermissions";

export type QoderCliRuntimeAuth =
  | { readonly type: "qodercli" }
  | { readonly type: "access-token"; readonly token: string }
  | { readonly type: "access-token-env"; readonly envVar?: string | undefined };

export interface QoderCliRuntimeAdapterOptions {
  readonly descriptor?: Partial<RuntimeAdapterDescriptor> | undefined;
  readonly executablePath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly auth?: QoderCliRuntimeAuth | undefined;
  readonly defaultModelName?: string | undefined;
  readonly defaultThinkingLevel?: string | undefined;
  readonly contextWindowTokens?: number | undefined;
  readonly compactModelName?: string | undefined;
  readonly listModels?: (() => Promise<readonly RuntimeModel[]>) | undefined;
  readonly onModelCatalogUpdated?: (() => void) | undefined;
  readonly permissionMode?: QoderCliRuntimePermissionMode | undefined;
  readonly canUse?: (() => Promise<RuntimeCanUseResult> | RuntimeCanUseResult) | undefined;
  readonly outputRetryLimit?: number | undefined;
  readonly sessionRestoreHandler?: RuntimeSessionRestoreHandler | undefined;
  readonly sessionSyncCallback?: RuntimeSessionSyncCallback | undefined;
  readonly tokenCounter?: RuntimeTokenCounter | undefined;
  readonly mcpToolRegistryPool?: McpToolRegistryPool | undefined;
}
