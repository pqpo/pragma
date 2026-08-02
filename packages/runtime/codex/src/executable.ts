import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface CodexExecutableResolutionOptions {
  readonly executablePath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly homeDirectory?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly isExecutable?: ((path: string) => boolean) | undefined;
  readonly windowsAppPackageRoots?: (() => readonly string[]) | undefined;
  readonly macApplicationsDirectories?: readonly string[] | undefined;
}

const WINDOWS_APP_PACKAGE_REPOSITORY =
  "HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages";

/**
 * Resolves the local Codex CLI without relying exclusively on the host process PATH.
 *
 * Desktop apps launched by Finder, VS Code, or a login service can inherit a narrower
 * PATH than an interactive shell. The standalone Codex installer places its command in
 * ~/.local/bin, Codex Desktop on Windows keeps it inside the AppX package, and
 * ChatGPT/Codex apps on macOS bundle the executable in their application resources.
 * Check these known locations when PATH lookup cannot find it.
 */
export function resolveCodexExecutablePath(options: CodexExecutableResolutionOptions = {}): string {
  if (options.executablePath !== undefined) {
    return options.executablePath;
  }

  const env = { ...process.env, ...(options.env ?? {}) };
  const canExecute = options.isExecutable ?? isExecutable;
  const platform = options.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  const executableNames = createExecutableNames("codex", platform, env["PATHEXT"]);
  const fromPath = findExecutableInPath(
    executableNames,
    env["PATH"],
    path.delimiter,
    path.join,
    canExecute,
  );

  if (fromPath !== undefined) {
    return fromPath;
  }

  if (platform === "win32") {
    const packageRoots = options.windowsAppPackageRoots?.() ?? findWindowsCodexAppPackageRoots();
    for (const packageRoot of packageRoots) {
      const appExecutable = path.join(packageRoot, "app", "resources", "codex.exe");
      if (canExecute(appExecutable)) {
        return appExecutable;
      }
    }
  }

  if (platform === "darwin") {
    const applicationDirectories = options.macApplicationsDirectories ?? [
      "/Applications",
      path.join(options.homeDirectory ?? env["HOME"] ?? homedir(), "Applications"),
    ];
    for (const applicationDirectory of applicationDirectories) {
      for (const applicationName of ["ChatGPT.app", "Codex.app"] as const) {
        const appExecutable = path.join(
          applicationDirectory,
          applicationName,
          "Contents",
          "Resources",
          "codex",
        );
        if (canExecute(appExecutable)) return appExecutable;
      }
    }
  }

  const standaloneDirectory = path.join(
    options.homeDirectory ?? env["HOME"] ?? homedir(),
    ".local",
    "bin",
  );
  const standalonePath = findExecutableInDirectory(
    standaloneDirectory,
    executableNames,
    path.join,
    canExecute,
  );

  return standalonePath ?? "codex";
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
    const executable = findExecutableInDirectory(directory, executableNames, joinPath, canExecute);
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

  const binaryExtensions = (pathExt ?? ".COM;.EXE")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension === ".com" || extension === ".exe");

  return [command, ...new Set(binaryExtensions.map((extension) => `${command}${extension}`))];
}

function findWindowsCodexAppPackageRoots(): readonly string[] {
  try {
    const packageQuery = spawnSync(
      "reg.exe",
      ["query", WINDOWS_APP_PACKAGE_REPOSITORY, "/f", "OpenAI.Codex_", "/k"],
      {
        encoding: "utf8",
        timeout: 2_000,
        windowsHide: true,
      },
    );
    if (packageQuery.status !== 0 || packageQuery.error !== undefined) {
      return [];
    }

    const packageKeys = packageQuery.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("HKEY_") && /\\OpenAI\.Codex_[^\\]+$/i.test(line));

    return packageKeys.flatMap((packageKey) => {
      const rootQuery = spawnSync("reg.exe", ["query", packageKey, "/v", "PackageRootFolder"], {
        encoding: "utf8",
        timeout: 2_000,
        windowsHide: true,
      });
      if (rootQuery.status !== 0 || rootQuery.error !== undefined) {
        return [];
      }

      const match = /^\s*PackageRootFolder\s+REG_SZ\s+(.+)$/m.exec(rootQuery.stdout);
      const packageRoot = match?.[1]?.trim();
      return packageRoot === undefined || packageRoot === "" ? [] : [packageRoot];
    });
  } catch {
    return [];
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
