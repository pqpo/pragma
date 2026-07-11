import { canUseRuntimeBinary } from "@pragma/core/runtime/process-probe";
import type { RuntimeCanUseResult } from "@pragma/core/runtime/runtime-adapter";
import { resolveCodexExecutablePath } from "./executable.ts";
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
  // A custom spawn is normally a test double or host-specific launcher. Preserve the
  // historical bare-command contract unless its caller explicitly selects a path.
  const executablePath =
    options.executablePath ??
    (options.spawn === undefined ? resolveCodexExecutablePath(options) : "codex");

  return await canUseRuntimeBinary({
    runtimeName: "Codex CLI",
    defaultExecutablePath: "codex",
    executablePath,
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    spawn: options.spawn,
  });
}
