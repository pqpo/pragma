import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface ClaudeCodeExecutableResolutionOptions {
  readonly executablePath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly homeDirectory?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly isExecutable?: ((path: string) => boolean) | undefined;
  readonly readTextFile?: ((path: string) => string) | undefined;
  readonly nodeExecutablePath?: string | undefined;
}

export interface ClaudeCodeCommandResolution {
  readonly executablePath: string;
  readonly launcherArgs: readonly string[];
  readonly sourcePath: string;
}

/**
 * Resolves the native Claude Code CLI without relying exclusively on PATH.
 *
 * The native installer places Claude Code in ~/.local/bin. On Windows the
 * executable is claude.exe, so spawning the extensionless `claude` command can
 * fail even when a shell or launcher can find the installation.
 */
export function resolveClaudeCodeExecutablePath(
  options: ClaudeCodeExecutableResolutionOptions = {},
): string {
  if (options.executablePath !== undefined) {
    return options.executablePath;
  }

  const canExecute = options.isExecutable ?? isExecutable;
  const platform = options.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  const pathExt = readEnvironmentValue(options, "PATHEXT", platform);
  const executableNames = createExecutableNames("claude", platform, pathExt);
  const fromPath = findExecutableInPath(
    executableNames,
    readEnvironmentValue(options, "PATH", platform),
    path.delimiter,
    path.join,
    canExecute,
  );

  if (fromPath !== undefined) {
    debugResolution(options, `resolved from PATH: ${fromPath}`);
    return fromPath;
  }

  if (platform === "win32") {
    const nodeDirectory = path.dirname(options.nodeExecutablePath ?? process.execPath);
    const besideNode = findExecutableInDirectory(
      nodeDirectory,
      executableNames,
      path.join,
      canExecute,
    );
    if (besideNode !== undefined) {
      debugResolution(options, `resolved beside node.exe: ${besideNode}`);
      return besideNode;
    }
  }

  const standaloneDirectory = path.join(
    options.homeDirectory ??
      readEnvironmentValue(options, "HOME", platform) ??
      readEnvironmentValue(options, "USERPROFILE", platform) ??
      homedir(),
    ".local",
    "bin",
  );
  const standalonePath = findExecutableInDirectory(
    standaloneDirectory,
    executableNames,
    path.join,
    canExecute,
  );

  const result = standalonePath ?? "claude";
  debugResolution(
    options,
    standalonePath === undefined
      ? "no executable candidate found; falling back to bare command"
      : `resolved native installation: ${standalonePath}`,
  );
  return result;
}

/** Resolves a directly spawnable command, including npm/pnpm Windows shims. */
export function resolveClaudeCodeCommand(
  options: ClaudeCodeExecutableResolutionOptions = {},
): ClaudeCodeCommandResolution {
  const sourcePath = resolveClaudeCodeExecutablePath(options);
  const platform = options.platform ?? process.platform;

  if (platform !== "win32" || !sourcePath.toLowerCase().endsWith(".cmd")) {
    return { executablePath: sourcePath, launcherArgs: [], sourcePath };
  }

  const shim = (options.readTextFile ?? readTextFile)(sourcePath);
  const target = parseWindowsCommandShimTarget(sourcePath, shim);
  if (target === undefined) {
    throw new Error(
      `Claude Code command shim could not be resolved safely: "${sourcePath}". ` +
        "Install the native Claude Code CLI or configure executablePath to claude.exe.",
    );
  }

  const resolution = target.kind === "native"
    ? { executablePath: target.path, launcherArgs: [], sourcePath }
    : {
        executablePath: options.nodeExecutablePath ?? process.execPath,
        launcherArgs: [target.path],
        sourcePath,
      };
  debugResolution(
    options,
    `resolved command shim ${sourcePath} -> ${resolution.executablePath}${
      resolution.launcherArgs.length === 0 ? "" : ` ${resolution.launcherArgs.join(" ")}`
    }`,
  );
  return resolution;
}

function findExecutableInPath(
  executableNames: readonly string[],
  pathValue: string | undefined,
  pathDelimiter: string,
  joinPath: (...paths: string[]) => string,
  canExecute: (path: string) => boolean,
): string | undefined {
  if (pathValue === undefined || pathValue === "") {
    return undefined;
  }

  for (const directory of pathValue.split(pathDelimiter)) {
    if (directory === "") {
      continue;
    }

    const executable = findExecutableInDirectory(
      directory,
      executableNames,
      joinPath,
      canExecute,
    );
    if (executable !== undefined) {
      return executable;
    }
  }

  return undefined;
}

function findExecutableInDirectory(
  directory: string,
  executableNames: readonly string[],
  joinPath: (...paths: string[]) => string,
  canExecute: (path: string) => boolean,
): string | undefined {
  for (const executableName of executableNames) {
    const candidate = joinPath(directory, executableName);
    if (canExecute(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function createExecutableNames(
  command: string,
  platform: NodeJS.Platform,
  pathExt: string | undefined,
): readonly string[] {
  if (platform !== "win32") {
    return [command];
  }

  const binaryExtensions = (pathExt ?? ".COM;.EXE;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(
      (extension) =>
        extension === ".com" || extension === ".exe" || extension === ".cmd",
    );

  // Windows command resolution may expose an extensionless POSIX shell shim next
  // to claude.cmd (notably with nvm-windows). That file is not directly spawnable
  // by Node on Windows, so only consider native binaries and the safely parsed CMD shim.
  return [...new Set(binaryExtensions.map((extension) => `${command}${extension}`))];
}

function parseWindowsCommandShimTarget(
  shimPath: string,
  content: string,
): { readonly kind: "native" | "node"; readonly path: string } | undefined {
  const matches = content.matchAll(/"([^"]+\.(?:exe|com|cjs|mjs|js))"\s+%\*/gi);

  for (const match of matches) {
    const value = match[1];
    if (value === undefined) {
      continue;
    }

    const shimDirectory = win32.dirname(shimPath);
    const expanded = value
      .replaceAll(/%~dp0/gi, `${shimDirectory}\\`)
      .replaceAll(/%dp0%/gi, `${shimDirectory}\\`);
    const path = win32.resolve(shimDirectory, expanded);
    return {
      kind: /\.(?:exe|com)$/i.test(path) ? "native" : "node",
      path,
    };
  }

  return undefined;
}

function readEnvironmentValue(
  options: ClaudeCodeExecutableResolutionOptions,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  return (
    findEnvironmentValue(options.env, key, platform) ??
    findEnvironmentValue(process.env, key, platform)
  );
}

function findEnvironmentValue(
  env: NodeJS.ProcessEnv | undefined,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (env === undefined) {
    return undefined;
  }
  if (platform !== "win32") {
    return env[key];
  }

  const actualKey = Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return actualKey === undefined ? undefined : env[actualKey];
}

function debugResolution(
  options: ClaudeCodeExecutableResolutionOptions,
  message: string,
): void {
  const platform = options.platform ?? process.platform;
  if (readEnvironmentValue(options, "PRAGMA_RUNTIME_DEBUG", platform) === "1") {
    console.error(`[pragma:claude-code:executable] ${message}`);
  }
}

function readTextFile(path: string): string {
  return readFileSync(path, "utf8");
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
