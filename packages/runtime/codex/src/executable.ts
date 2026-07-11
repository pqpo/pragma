import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

interface CodexExecutableResolutionOptions {
  readonly executablePath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly homeDirectory?: string | undefined;
  readonly isExecutable?: ((path: string) => boolean) | undefined;
}

/**
 * Resolves the local Codex CLI without relying exclusively on the host process PATH.
 *
 * Desktop apps launched by Finder, VS Code, or a login service can inherit a narrower
 * PATH than an interactive shell. The standalone Codex installer places its command in
 * ~/.local/bin, so use that known location when PATH lookup cannot find it.
 */
export function resolveCodexExecutablePath(
  options: CodexExecutableResolutionOptions = {},
): string {
  if (options.executablePath !== undefined) {
    return options.executablePath;
  }

  const env = { ...process.env, ...(options.env ?? {}) };
  const canExecute = options.isExecutable ?? isExecutable;
  const fromPath = findExecutableInPath("codex", env["PATH"], canExecute);

  if (fromPath !== undefined) {
    return fromPath;
  }

  const standalonePath = join(
    options.homeDirectory ?? env["HOME"] ?? homedir(),
    ".local",
    "bin",
    "codex",
  );

  return canExecute(standalonePath) ? standalonePath : "codex";
}

function findExecutableInPath(
  command: string,
  pathValue: string | undefined,
  canExecute: (path: string) => boolean,
): string | undefined {
  if (pathValue === undefined || pathValue === "") {
    return undefined;
  }

  for (const directory of pathValue.split(delimiter)) {
    if (directory === "") {
      continue;
    }
    const candidate = join(directory, command);
    if (canExecute(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
