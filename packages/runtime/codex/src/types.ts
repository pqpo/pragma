import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { ExpertAgentLoggerProvider } from "@pragma/core";
import type {
  RuntimeAdapterDescriptor,
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

export type CodexRuntimeSpawn = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  },
) => ChildProcessWithoutNullStreams;

export interface CodexRuntimeAdapterOptions {
  readonly descriptor?: Partial<RuntimeAdapterDescriptor> | undefined;
  readonly executablePath?: string | undefined;
  readonly appServerArgs?: readonly string[] | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly clientInfo?: CodexRuntimeClientInfo | undefined;
  readonly loggerProvider?: ExpertAgentLoggerProvider | undefined;
  readonly defaultModelName?: string | undefined;
  readonly sandboxMode?: CodexRuntimeSandboxMode | undefined;
  readonly approvalPolicy?: CodexRuntimeApprovalPolicy | undefined;
  readonly spawn?: CodexRuntimeSpawn | undefined;
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
