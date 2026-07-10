import type { ExpertAgentLoggerProvider } from "@pragma/core";
import type {
  RuntimeCanUseResult,
  RuntimeAdapterDescriptor,
  RuntimeCommandSpawn,
  RuntimeModel,
  RuntimeSessionRestoreHandler,
  RuntimeSessionSyncCallback,
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
  readonly descriptor?: Partial<RuntimeAdapterDescriptor> | undefined;
  readonly executablePath?: string | undefined;
  readonly appServerArgs?: readonly string[] | undefined;
  /**
   * Extra environment for Codex. CODEX_HOME is treated as the shared source home
   * for auth/config/session state; the spawned Codex process receives a managed
   * per-session CODEX_HOME instead.
   */
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly clientInfo?: CodexRuntimeClientInfo | undefined;
  readonly loggerProvider?: ExpertAgentLoggerProvider | undefined;
  readonly defaultModelName?: string | undefined;
  readonly defaultThinkingLevel?: string | undefined;
  readonly listModels?: (() => Promise<readonly RuntimeModel[]>) | undefined;
  readonly sandboxMode?: CodexRuntimeSandboxMode | undefined;
  readonly approvalPolicy?: CodexRuntimeApprovalPolicy | undefined;
  readonly spawn?: CodexRuntimeSpawn | undefined;
  readonly canUse?: (() => Promise<RuntimeCanUseResult> | RuntimeCanUseResult) | undefined;
  readonly outputRetryLimit?: number | undefined;
  readonly sessionRestoreHandler?: RuntimeSessionRestoreHandler | undefined;
  readonly sessionSyncCallback?: RuntimeSessionSyncCallback | undefined;
}

export interface CodexRuntimeMessage {
  readonly role: "user" | "assistant" | "runtime";
  readonly content: string;
  readonly timestamp: number;
  readonly details?: unknown;
}

export type CodexUserInput = {
  readonly type: "text";
  readonly text: string;
  readonly text_elements: readonly [];
};

export interface CodexTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
}
