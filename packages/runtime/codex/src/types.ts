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

export type CodexRuntimeSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type CodexRuntimeApprovalPolicy = "untrusted" | "on-request" | "never";

export interface CodexRuntimeClientInfo {
  readonly name: string;
  readonly title: string;
  readonly version: string;
}

export type CodexRuntimeSpawn = RuntimeCommandSpawn;

export interface CodexRuntimeAdapterOptions {
  readonly descriptor?: RuntimeDriverDescriptorOverride | undefined;
  readonly executablePath?: string | undefined;
  readonly appServerArgs?: readonly string[] | undefined;
  /**
   * Extra environment for Codex. CODEX_HOME is only an import source for auth,
   * config and rebuildable cache data. The spawned process receives an isolated
   * Runtime Context overlay plus a separate CODEX_SQLITE_HOME.
   */
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly clientInfo?: CodexRuntimeClientInfo | undefined;
  readonly defaultModelName?: string | undefined;
  readonly defaultThinkingLevel?: string | undefined;
  readonly modelCatalogCacheRoot?: string | undefined;
  readonly listModels?:
    ((options?: RuntimeModelDiscoveryOptions) => Promise<readonly RuntimeModel[]>) | undefined;
  readonly onModelCatalogUpdated?: (() => void) | undefined;
  readonly sandboxMode?: CodexRuntimeSandboxMode | undefined;
  readonly approvalPolicy?: CodexRuntimeApprovalPolicy | undefined;
  readonly spawn?: CodexRuntimeSpawn | undefined;
  readonly canUse?: (() => Promise<RuntimeCanUseResult> | RuntimeCanUseResult) | undefined;
  readonly outputRetryLimit?: number | undefined;
  readonly sessionRestoreHandler?: RuntimeSessionRestoreHandler | undefined;
  readonly sessionSyncCallback?: RuntimeSessionSyncCallback | undefined;
  readonly tokenCounter?: RuntimeTokenCounter | undefined;
  readonly mcpToolRegistryPool?: McpToolRegistryPool | undefined;
}

export interface CodexRuntimeMessage {
  readonly role: "user" | "assistant" | "runtime";
  readonly content: string;
  readonly timestamp: number;
  readonly details?: unknown;
}

export type CodexUserInput =
  | {
      readonly type: "text";
      readonly text: string;
      readonly text_elements: readonly [];
    }
  | {
      readonly type: "localImage";
      readonly path: string;
    };

export interface CodexTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
}
