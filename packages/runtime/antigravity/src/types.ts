import type {
  McpToolRegistryPool,
  RuntimeAdapterDescriptor,
  RuntimeCanUseResult,
  RuntimeCommandSpawn,
  RuntimeModel,
  RuntimeSessionRestoreHandler,
  RuntimeSessionSyncCallback,
  RuntimeTokenCounter,
} from "@pragma/core";

export type AntigravityRuntimePermissionMode = "request-approval" | "auto-approve" | "full-access";

export type AntigravityAuthenticationMode = "auto" | "isolated-environment" | "host-keyring";

export type AntigravityRuntimeSpawn = RuntimeCommandSpawn;

export interface AntigravityRuntimeAdapterOptions {
  readonly descriptor?: Partial<RuntimeAdapterDescriptor> | undefined;
  readonly executablePath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly defaultModelName?: string | undefined;
  readonly defaultThinkingLevel?: string | undefined;
  readonly listModels?: (() => Promise<readonly RuntimeModel[]>) | undefined;
  readonly onModelCatalogUpdated?: (() => void) | undefined;
  readonly permissionMode?: AntigravityRuntimePermissionMode | undefined;
  /**
   * `host-keyring` preserves the real user HOME so agy can reuse its OS-keyring
   * OAuth profile. `isolated-environment` keeps a private HOME and therefore
   * requires an explicit supported authentication environment such as ADC.
   */
  readonly authenticationMode?: AntigravityAuthenticationMode | undefined;
  readonly spawn?: AntigravityRuntimeSpawn | undefined;
  readonly canUse?: (() => Promise<RuntimeCanUseResult> | RuntimeCanUseResult) | undefined;
  readonly outputRetryLimit?: number | undefined;
  readonly sessionRestoreHandler?: RuntimeSessionRestoreHandler | undefined;
  readonly sessionSyncCallback?: RuntimeSessionSyncCallback | undefined;
  readonly tokenCounter?: RuntimeTokenCounter | undefined;
  readonly mcpToolRegistryPool?: McpToolRegistryPool | undefined;
  /** Internal test seam. Production uses the Electron/Node executable. */
  readonly hookNodeExecutablePath?: string | undefined;
}
