import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";

import type { PragmaLogger } from "@pragma/core";

const SUPPORTED_LOGIN_SHELLS = new Set(["bash", "dash", "ksh", "sh", "zsh"]);
const DEFAULT_SHELL_TIMEOUT_MS = 3_000;
const DEFAULT_FORCE_KILL_DELAY_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

type RuntimeEnvironmentLogger = Pick<PragmaLogger, "info" | "warn">;

export interface DesktopRuntimeProcessEnvironment {
  readonly get: () => Promise<NodeJS.ProcessEnv>;
  readonly warmUp: () => void;
}

export interface CreateDesktopRuntimeProcessEnvironmentOptions {
  readonly logger: RuntimeEnvironmentLogger;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly homeDirectory?: string | undefined;
  readonly shellTimeoutMs?: number | undefined;
  readonly forceKillDelayMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
}

interface RuntimePathResolution {
  readonly path: string | undefined;
  readonly source: "login-shell" | "fallback" | "original";
  readonly failureKind?: ShellPathFailureKind | undefined;
}

interface ResolvedDesktopRuntimeProcessEnvironmentOptions extends CreateDesktopRuntimeProcessEnvironmentOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
}

type ShellPathFailureKind =
  | "invalid-output"
  | "output-limit"
  | "spawn-failed"
  | "timeout"
  | "unsupported-shell";

class ShellPathError extends Error {
  constructor(readonly kind: ShellPathFailureKind) {
    super(`Login shell PATH recovery failed: ${kind}.`);
  }
}

export function createDesktopRuntimeProcessEnvironment(
  options: CreateDesktopRuntimeProcessEnvironmentOptions,
): DesktopRuntimeProcessEnvironment {
  const sourceEnvironment = { ...(options.env ?? process.env) };
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? sourceEnvironment["HOME"] ?? homedir();
  let environmentPromise: Promise<NodeJS.ProcessEnv> | undefined;

  const get = (): Promise<NodeJS.ProcessEnv> => {
    environmentPromise ??= resolveRuntimeProcessEnvironmentWithFallback({
      ...options,
      env: sourceEnvironment,
      platform,
      homeDirectory,
    });
    return environmentPromise;
  };

  return {
    get,
    warmUp: () => {
      void get();
    },
  };
}

async function resolveRuntimeProcessEnvironmentWithFallback(
  options: ResolvedDesktopRuntimeProcessEnvironmentOptions,
): Promise<NodeJS.ProcessEnv> {
  const startedAt = performance.now();
  try {
    return await resolveRuntimeProcessEnvironment(options);
  } catch {
    const environment = Object.freeze({ ...options.env });
    writeEnvironmentLog(options.logger, "warn", {
      event: "desktop.runtime_process_environment_emergency_fallback",
      message:
        "Desktop Runtime environment recovery failed unexpectedly; the original process environment will be used.",
      attributes: {
        source: "original",
        durationMs: elapsedMs(startedAt),
        pathDirectoryCount: options.env["PATH"]?.split(delimiter).filter(Boolean).length ?? 0,
        failureKind: "unexpected-error",
      },
    });
    return environment;
  }
}

async function resolveRuntimeProcessEnvironment(
  options: ResolvedDesktopRuntimeProcessEnvironmentOptions,
): Promise<NodeJS.ProcessEnv> {
  const startedAt = performance.now();
  const originalEnvironment = options.env;
  let resolution: RuntimePathResolution;

  if (options.platform === "win32") {
    resolution = { path: originalEnvironment["PATH"], source: "original" };
  } else {
    resolution = await resolvePosixRuntimePath(options);
  }

  const environment: NodeJS.ProcessEnv = { ...originalEnvironment };
  if (resolution.path !== undefined) environment["PATH"] = resolution.path;
  Object.freeze(environment);

  const attributes = {
    source: resolution.source,
    durationMs: elapsedMs(startedAt),
    pathDirectoryCount: resolution.path?.split(delimiter).filter(Boolean).length ?? 0,
  };
  if (resolution.failureKind === undefined) {
    writeEnvironmentLog(options.logger, "info", {
      event: "desktop.runtime_process_environment_ready",
      message: "Desktop Runtime process environment is ready.",
      attributes,
    });
  } else {
    writeEnvironmentLog(options.logger, "warn", {
      event: "desktop.runtime_process_environment_fallback",
      message: "Desktop Runtime PATH recovery failed; safe fallback directories will be used.",
      attributes: { ...attributes, failureKind: resolution.failureKind },
    });
  }

  return environment;
}

async function resolvePosixRuntimePath(
  options: ResolvedDesktopRuntimeProcessEnvironmentOptions,
): Promise<RuntimePathResolution> {
  let loginShellPath: string | undefined;
  let failureKind: ShellPathFailureKind | undefined;
  try {
    loginShellPath = await readLoginShellPath({
      shell: options.env["SHELL"],
      env: options.env,
      timeoutMs: options.shellTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
      forceKillDelayMs: options.forceKillDelayMs ?? DEFAULT_FORCE_KILL_DELAY_MS,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    });
  } catch (error) {
    failureKind = error instanceof ShellPathError ? error.kind : "spawn-failed";
  }

  const candidates = [
    ...splitPath(loginShellPath),
    ...commonExecutableDirectories(options.platform, options.homeDirectory),
    ...splitPath(options.env["PATH"]),
  ];
  const directories = await normalizeExistingDirectories(candidates);
  return {
    path: directories.length === 0 ? options.env["PATH"] : directories.join(delimiter),
    source: failureKind === undefined ? "login-shell" : "fallback",
    ...(failureKind === undefined ? {} : { failureKind }),
  };
}

async function readLoginShellPath(options: {
  readonly shell: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly forceKillDelayMs: number;
  readonly maxOutputBytes: number;
}): Promise<string> {
  const shell = options.shell;
  if (shell === undefined || !isAbsolute(shell) || !SUPPORTED_LOGIN_SHELLS.has(basename(shell))) {
    throw new ShellPathError("unsupported-shell");
  }

  const marker = randomBytes(16).toString("hex");
  const startMarker = `__PRAGMA_PATH_START_${marker}__`;
  const endMarker = `__PRAGMA_PATH_END_${marker}__`;
  const command = `printf '%s\\n%s\\n%s\\n' '${startMarker}' "$PATH" '${endMarker}'`;

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(shell, ["-ilc", command], {
      detached: true,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let outputBytes = 0;
    let failureKind: ShellPathFailureKind | undefined;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const finish = (result: { readonly path?: string; readonly error?: ShellPathError }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (result.error !== undefined) reject(result.error);
      else resolve(result.path ?? "");
    };
    const terminate = (kind: ShellPathFailureKind): void => {
      if (failureKind !== undefined) return;
      failureKind = kind;
      killProcessGroup(child.pid, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        killProcessGroup(child.pid, "SIGKILL");
        finish({ error: new ShellPathError(kind) });
      }, options.forceKillDelayMs);
      forceKillTimer.unref();
    };
    const collect = (chunk: Buffer, capture: boolean): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > options.maxOutputBytes) {
        terminate("output-limit");
        return;
      }
      if (capture) stdout += chunk.toString("utf8");
    };

    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    child.once("error", () => finish({ error: new ShellPathError("spawn-failed") }));
    child.once("close", () => {
      if (failureKind !== undefined) {
        finish({ error: new ShellPathError(failureKind) });
        return;
      }
      const path = parseMarkedPath(stdout, startMarker, endMarker);
      finish(path === undefined ? { error: new ShellPathError("invalid-output") } : { path });
    });

    const timeoutTimer = setTimeout(() => terminate("timeout"), options.timeoutMs);
    timeoutTimer.unref();
  });
}

function parseMarkedPath(
  output: string,
  startMarker: string,
  endMarker: string,
): string | undefined {
  const start = output.lastIndexOf(`${startMarker}\n`);
  if (start < 0) return undefined;
  const valueStart = start + startMarker.length + 1;
  const end = output.indexOf(`\n${endMarker}`, valueStart);
  if (end < 0) return undefined;
  const value = output.slice(valueStart, end);
  return value === "" || value.includes("\0") || value.includes("\n") ? undefined : value;
}

async function normalizeExistingDirectories(candidates: readonly string[]): Promise<string[]> {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      const canonical = await realpath(candidate);
      if (seen.has(canonical) || !(await stat(canonical)).isDirectory()) continue;
      seen.add(canonical);
      result.push(canonical);
    } catch {
      // PATH entries can disappear between shell initialization and validation.
    }
  }
  return result;
}

function splitPath(value: string | undefined): readonly string[] {
  return value?.split(delimiter).filter(Boolean) ?? [];
}

function commonExecutableDirectories(
  platform: NodeJS.Platform,
  homeDirectory: string,
): readonly string[] {
  return platform === "darwin"
    ? ["/opt/homebrew/bin", "/usr/local/bin", join(homeDirectory, ".local", "bin")]
    : ["/usr/local/bin", join(homeDirectory, ".local", "bin")];
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The shell may have already exited.
    }
  }
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function writeEnvironmentLog(
  logger: RuntimeEnvironmentLogger,
  level: keyof RuntimeEnvironmentLogger,
  record: {
    readonly event: string;
    readonly message: string;
    readonly attributes: Readonly<Record<string, unknown>>;
  },
): void {
  try {
    logger[level](record.event, record.message, record.attributes);
  } catch {
    // Diagnostic logging must never make local Runtime execution unavailable.
  }
}
