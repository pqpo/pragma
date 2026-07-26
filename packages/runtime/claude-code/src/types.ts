import type {
  RuntimeCanUseResult,
  RuntimeAdapterDescriptor,
  RuntimeCommandSpawn,
  RuntimeModel,
  RuntimeSessionRestoreHandler,
  RuntimeSessionSyncCallback,
} from "@pragma/core";

export type ClaudeCodeRuntimePermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "auto"
  | "dontAsk"
  | "bypassPermissions";

export type ClaudeCodeRuntimeSpawn = RuntimeCommandSpawn;

export interface ClaudeCodeRuntimeAdapterOptions {
  readonly descriptor?: Partial<RuntimeAdapterDescriptor> | undefined;
  readonly executablePath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly defaultModelName?: string | undefined;
  readonly defaultThinkingLevel?: string | undefined;
  readonly listModels?: (() => Promise<readonly RuntimeModel[]>) | undefined;
  readonly onModelCatalogUpdated?: (() => void) | undefined;
  readonly permissionMode?: ClaudeCodeRuntimePermissionMode | undefined;
  readonly additionalArgs?: readonly string[] | undefined;
  readonly spawn?: ClaudeCodeRuntimeSpawn | undefined;
  readonly canUse?: (() => Promise<RuntimeCanUseResult> | RuntimeCanUseResult) | undefined;
  readonly outputRetryLimit?: number | undefined;
  readonly sessionRestoreHandler?: RuntimeSessionRestoreHandler | undefined;
  readonly sessionSyncCallback?: RuntimeSessionSyncCallback | undefined;
}

export interface ClaudeCodeRuntimeMessage {
  readonly role: "user" | "assistant" | "runtime";
  readonly content: string;
  readonly timestamp: number;
  readonly details?: unknown;
}

export interface ClaudeCodeRuntimeSessionState {
  sessionId: string;
}

export interface ClaudeCodeTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}
