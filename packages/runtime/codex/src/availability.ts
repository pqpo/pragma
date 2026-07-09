import { canUseRuntimeBinary, type RuntimeCanUseResult } from "@pragma/core";
import type { CodexRuntimeSpawn } from "./types.ts";

export interface CodexRuntimeAvailabilityOptions {
  readonly executablePath?: string | undefined;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
  readonly spawn?: CodexRuntimeSpawn | undefined;
}

export async function canUseCodexRuntime(
  options: CodexRuntimeAvailabilityOptions = {},
): Promise<RuntimeCanUseResult> {
  return await canUseRuntimeBinary({
    runtimeName: "Codex CLI",
    defaultExecutablePath: "codex",
    executablePath: options.executablePath,
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    spawn: options.spawn,
  });
}
