import { canUseRuntimeBinary, type RuntimeCanUseResult } from "@pragma/core";
import type { ClaudeCodeRuntimeSpawn } from "./types.ts";

export interface ClaudeCodeRuntimeAvailabilityOptions {
  readonly executablePath?: string | undefined;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
  readonly spawn?: ClaudeCodeRuntimeSpawn | undefined;
}

export async function canUseClaudeCodeRuntime(
  options: ClaudeCodeRuntimeAvailabilityOptions = {},
): Promise<RuntimeCanUseResult> {
  return await canUseRuntimeBinary({
    runtimeName: "Claude Code CLI",
    defaultExecutablePath: "claude",
    executablePath: options.executablePath,
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    spawn: options.spawn,
  });
}
