import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { ExpertAgentLoggerProvider } from "@pragma/core";
import type {
  RuntimeAdapterDescriptor,
  RuntimeSessionRestoreHandler,
  RuntimeSessionSyncCallback,
} from "@pragma/core";

export type ClaudeCodeRuntimeIsolationMode = "strict" | "inherit";

export type ClaudeCodeRuntimePermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "auto"
  | "dontAsk"
  | "bypassPermissions";

export type ClaudeCodeRuntimeSpawn = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  },
) => ChildProcessWithoutNullStreams;

export interface ClaudeCodeRuntimeAdapterOptions {
  readonly descriptor?: Partial<RuntimeAdapterDescriptor> | undefined;
  readonly executablePath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly loggerProvider?: ExpertAgentLoggerProvider | undefined;
  readonly defaultModelName?: string | undefined;
  readonly isolationMode?: ClaudeCodeRuntimeIsolationMode | undefined;
  readonly permissionMode?: ClaudeCodeRuntimePermissionMode | undefined;
  readonly additionalArgs?: readonly string[] | undefined;
  readonly spawn?: ClaudeCodeRuntimeSpawn | undefined;
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
