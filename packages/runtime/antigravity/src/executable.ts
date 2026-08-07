import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface AntigravityExecutableResolutionOptions {
  readonly executablePath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly homeDirectory?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly isExecutable?: ((path: string) => boolean) | undefined;
}

export function resolveAntigravityExecutablePath(
  options: AntigravityExecutableResolutionOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  if (options.executablePath !== undefined) {
    return assertDirectlySpawnable(options.executablePath, platform);
  }

  const env = options.env ?? process.env;
  const explicit = environmentValue(env, "AGY_PATH", platform);
  if (explicit !== undefined && explicit.trim() !== "") {
    return assertDirectlySpawnable(explicit, platform);
  }

  const path = platform === "win32" ? win32 : posix;
  const names = platform === "win32" ? ["agy.exe", "antigravity.exe"] : ["agy", "antigravity"];
  const canExecute = options.isExecutable ?? isExecutable;

  for (const directory of (environmentValue(env, "PATH", platform) ?? "").split(path.delimiter)) {
    if (directory === "") continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (canExecute(candidate)) return candidate;
    }
  }

  const home =
    options.homeDirectory ??
    environmentValue(env, "HOME", platform) ??
    environmentValue(env, "USERPROFILE", platform) ??
    homedir();
  const installDirectories =
    platform === "win32"
      ? [
          path.join(
            environmentValue(env, "LOCALAPPDATA", platform) ?? path.join(home, "AppData", "Local"),
            "agy",
            "bin",
          ),
        ]
      : [path.join(home, ".local", "bin")];
  for (const directory of installDirectories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (canExecute(candidate)) return candidate;
    }
  }

  return platform === "win32" ? "agy.exe" : "agy";
}

function assertDirectlySpawnable(path: string, platform: NodeJS.Platform): string {
  if (platform === "win32" && path.toLowerCase().endsWith(".cmd")) {
    throw new Error(
      `Antigravity CLI command shim is not directly spawnable: "${path}". ` +
        "Configure AGY_PATH to the native agy.exe installation.",
    );
  }
  return path;
}

function environmentValue(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return env[key];
  const actual = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return actual === undefined ? undefined : env[actual];
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
