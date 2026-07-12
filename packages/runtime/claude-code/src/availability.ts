import { canUseRuntimeBinary } from "@pragma/core/runtime/process-probe";
import type { RuntimeCanUseResult } from "@pragma/core/runtime/runtime-adapter";
import { resolveClaudeCodeCommand } from "./executable.ts";
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
  const command =
    options.spawn === undefined
      ? resolveClaudeCodeCommand(options)
      : {
          executablePath: options.executablePath ?? "claude",
          launcherArgs: [] as readonly string[],
          sourcePath: options.executablePath ?? "claude",
        };

  const result = await canUseRuntimeBinary({
    runtimeName: "Claude Code CLI",
    defaultExecutablePath: "claude",
    executablePath: command.executablePath,
    args: [...command.launcherArgs, "--version"],
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    spawn: options.spawn,
  });

  return {
    ...result,
    details: {
      ...result.details,
      executablePath: command.sourcePath,
      ...(command.executablePath === command.sourcePath
        ? {}
        : { launcherExecutablePath: command.executablePath }),
    },
  };
}
