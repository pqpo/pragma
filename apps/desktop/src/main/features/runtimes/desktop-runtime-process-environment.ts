import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";

import type { PragmaLogger } from "@pragma/core";
import {
  resolveLocalHostRuntimeProcessEnvironment,
  type RuntimeProcessEnvironmentSettingsStore,
} from "@pragma/local-host";
import { DEFAULT_RUNTIME_PROCESS_ENVIRONMENT_POLICY } from "@pragma/shared";

const SUPPORTED_LOGIN_SHELLS = new Set(["bash", "dash", "ksh", "sh", "zsh"]);
const DEFAULT_SHELL_TIMEOUT_MS = 10_000;
const DEFAULT_FORCE_KILL_DELAY_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;

type RuntimeEnvironmentLogger = Pick<PragmaLogger, "info" | "warn">;

export interface DesktopRuntimeProcessEnvironment {
  readonly getSnapshot: () => Promise<ShellEnvironmentSnapshot>;
  readonly get: (runtimeAdapterId?: string) => Promise<NodeJS.ProcessEnv>;
  readonly getCacheKey: () => Promise<string>;
  readonly refresh: () => Promise<ShellEnvironmentSnapshot>;
  readonly warmUp: () => void;
}

/**
 * Public summary only. The complete captured environment stays private to the
 * main process and is projected through the selected Runtime policy on demand.
 */
export interface ShellEnvironmentSnapshot {
  readonly shell?: string | undefined;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly capturedAt: number;
  readonly generation: number;
  readonly source: RuntimeEnvironmentResolution["source"];
  readonly failureKind?: ShellPathFailureKind | "unexpected-error" | undefined;
}

export interface CreateDesktopRuntimeProcessEnvironmentOptions {
  readonly logger: RuntimeEnvironmentLogger;
  readonly settings?: RuntimeProcessEnvironmentSettingsStore | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly homeDirectory?: string | undefined;
  readonly shellTimeoutMs?: number | undefined;
  readonly forceKillDelayMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly retryDelaysMs?: readonly number[] | undefined;
}

type ResolvedShellEnvironmentSnapshot = Omit<ShellEnvironmentSnapshot, "env" | "generation"> & {
  readonly capturedEnvironment: NodeJS.ProcessEnv;
};

interface CapturedShellEnvironment {
  readonly snapshot: ShellEnvironmentSnapshot;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}

interface RuntimeEnvironmentResolution {
  readonly environment: NodeJS.ProcessEnv;
  readonly source: "login-shell" | "fallback" | "original";
  readonly failureKind?: ShellPathFailureKind | undefined;
}

interface ResolvedDesktopRuntimeProcessEnvironmentOptions extends CreateDesktopRuntimeProcessEnvironmentOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
}

type ShellPathFailureKind =
  "invalid-output" | "output-limit" | "spawn-failed" | "timeout" | "unsupported-shell";

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
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let snapshotPromise: Promise<CapturedShellEnvironment> | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let retryIndex = 0;
  let captureSequence = 0;
  let generation = 0;

  const clearScheduledRetry = (): void => {
    if (retryTimer === undefined) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
  };
  const startCapture = (resetRetrySchedule: boolean): Promise<CapturedShellEnvironment> => {
    clearScheduledRetry();
    if (resetRetrySchedule) retryIndex = 0;
    const sequence = ++captureSequence;
    const nextPromise = (async (): Promise<CapturedShellEnvironment> => {
      const resolved = await resolveRuntimeProcessEnvironmentWithFallback({
        ...options,
        env: sourceEnvironment,
        platform,
        homeDirectory,
      });
      if (sequence !== captureSequence) return await snapshotPromise!;

      const safeEnvironment = Object.freeze(
        resolveLocalHostRuntimeProcessEnvironment(
          resolved.capturedEnvironment,
          "",
          DEFAULT_RUNTIME_PROCESS_ENVIRONMENT_POLICY,
          platform,
        ),
      );
      const snapshot = Object.freeze({
        shell: resolved.shell,
        env: safeEnvironment,
        capturedAt: resolved.capturedAt,
        source: resolved.source,
        ...(resolved.failureKind === undefined ? {} : { failureKind: resolved.failureKind }),
        generation: ++generation,
      });
      const captured = Object.freeze({
        snapshot,
        environment: Object.freeze(resolved.capturedEnvironment),
      });
      if (snapshot.failureKind === undefined) {
        retryIndex = 0;
      } else {
        const delayMs = retryDelaysMs[retryIndex];
        if (delayMs !== undefined) {
          retryIndex += 1;
          writeEnvironmentLog(options.logger, "info", {
            event: "desktop.runtime_process_environment_retry_scheduled",
            message: "Desktop Runtime process environment recovery will be retried.",
            attributes: {
              generation: snapshot.generation,
              failureKind: snapshot.failureKind,
              retryAttempt: retryIndex,
              delayMs,
            },
          });
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            void startCapture(false);
          }, delayMs);
          retryTimer.unref();
        }
      }
      return captured;
    })();
    snapshotPromise = nextPromise;
    return nextPromise;
  };
  const getCaptured = (): Promise<CapturedShellEnvironment> => {
    snapshotPromise ??= startCapture(false);
    return snapshotPromise;
  };
  const getSnapshot = async (): Promise<ShellEnvironmentSnapshot> => (await getCaptured()).snapshot;
  const get = async (runtimeAdapterId = ""): Promise<NodeJS.ProcessEnv> => {
    const captured = await getCaptured();
    if (runtimeAdapterId === "") return captured.snapshot.env as NodeJS.ProcessEnv;
    const policy =
      (await options.settings?.getPolicy()) ??
      DEFAULT_RUNTIME_PROCESS_ENVIRONMENT_POLICY;
    return Object.freeze(
      resolveLocalHostRuntimeProcessEnvironment(
        captured.environment as NodeJS.ProcessEnv,
        runtimeAdapterId,
        policy,
        platform,
      ),
    );
  };

  return {
    getSnapshot,
    get,
    getCacheKey: async () => {
      const [snapshot, settings] = await Promise.all([
        getSnapshot(),
        options.settings?.get() ?? Promise.resolve(undefined),
      ]);
      return `desktop-runtime-process-environment:${snapshot.generation}:${settings?.revision ?? 0}`;
    },
    refresh: async () => (await startCapture(true)).snapshot,
    warmUp: () => {
      void getSnapshot();
    },
  };
}

async function resolveRuntimeProcessEnvironmentWithFallback(
  options: ResolvedDesktopRuntimeProcessEnvironmentOptions,
): Promise<ResolvedShellEnvironmentSnapshot> {
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
    return {
      shell: options.env["SHELL"],
      capturedEnvironment: environment,
      capturedAt: Date.now(),
      source: "original",
      failureKind: "unexpected-error",
    };
  }
}

async function resolveRuntimeProcessEnvironment(
  options: ResolvedDesktopRuntimeProcessEnvironmentOptions,
): Promise<ResolvedShellEnvironmentSnapshot> {
  const startedAt = performance.now();
  const originalEnvironment = options.env;
  let resolution: RuntimeEnvironmentResolution;

  if (options.platform === "win32") {
    resolution = { environment: originalEnvironment, source: "original" };
  } else {
    resolution = await resolvePosixRuntimeEnvironment(options);
  }

  const environment = Object.freeze({ ...resolution.environment });
  const safeEnvironment = resolveLocalHostRuntimeProcessEnvironment(
    environment,
    "",
    DEFAULT_RUNTIME_PROCESS_ENVIRONMENT_POLICY,
    options.platform,
  );

  const attributes = {
    source: resolution.source,
    durationMs: elapsedMs(startedAt),
    pathDirectoryCount: safeEnvironment["PATH"]?.split(delimiter).filter(Boolean).length ?? 0,
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

  return {
    shell: options.env["SHELL"],
    capturedEnvironment: environment,
    capturedAt: Date.now(),
    source: resolution.source,
    ...(resolution.failureKind === undefined ? {} : { failureKind: resolution.failureKind }),
  };
}

async function resolvePosixRuntimeEnvironment(
  options: ResolvedDesktopRuntimeProcessEnvironmentOptions,
): Promise<RuntimeEnvironmentResolution> {
  let loginShellEnvironment: NodeJS.ProcessEnv | undefined;
  let failureKind: ShellPathFailureKind | undefined;
  try {
    loginShellEnvironment = await readLoginShellEnvironment({
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
    ...splitPath(loginShellEnvironment?.["PATH"]),
    ...commonExecutableDirectories(options.platform, options.homeDirectory),
    ...splitPath(options.env["PATH"]),
  ];
  const directories = await normalizeExistingDirectories(candidates);
  const environment = {
    ...(loginShellEnvironment ?? options.env),
    PATH: directories.length === 0 ? options.env["PATH"] : directories.join(delimiter),
  };
  return {
    environment,
    source: failureKind === undefined ? "login-shell" : "fallback",
    ...(failureKind === undefined ? {} : { failureKind }),
  };
}

async function readLoginShellEnvironment(options: {
  readonly shell: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly forceKillDelayMs: number;
  readonly maxOutputBytes: number;
}): Promise<NodeJS.ProcessEnv> {
  const shell = options.shell;
  if (shell === undefined || !isAbsolute(shell) || !SUPPORTED_LOGIN_SHELLS.has(basename(shell))) {
    throw new ShellPathError("unsupported-shell");
  }

  const marker = randomBytes(16).toString("hex");
  const startMarker = `__PRAGMA_ENV_START_${marker}__`;
  const endMarker = `__PRAGMA_ENV_END_${marker}__`;
  const command = `printf '%s\\0' '${startMarker}'; /usr/bin/env -0; printf '%s\\0' '${endMarker}'`;

  return await new Promise<NodeJS.ProcessEnv>((resolve, reject) => {
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

    const finish = (result: {
      readonly environment?: NodeJS.ProcessEnv;
      readonly error?: ShellPathError;
    }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (result.error !== undefined) reject(result.error);
      else resolve(result.environment ?? {});
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
      const environment = parseMarkedEnvironment(stdout, startMarker, endMarker);
      finish(
        environment === undefined
          ? { error: new ShellPathError("invalid-output") }
          : { environment },
      );
    });

    const timeoutTimer = setTimeout(() => terminate("timeout"), options.timeoutMs);
    timeoutTimer.unref();
  });
}

function parseMarkedEnvironment(
  output: string,
  startMarker: string,
  endMarker: string,
): NodeJS.ProcessEnv | undefined {
  const start = output.lastIndexOf(`${startMarker}\0`);
  if (start < 0) return undefined;
  const valueStart = start + startMarker.length + 1;
  const end = output.indexOf(`${endMarker}\0`, valueStart);
  if (end < 0) return undefined;
  const environment: NodeJS.ProcessEnv = {};
  for (const entry of output.slice(valueStart, end).split("\0")) {
    if (entry === "") continue;
    const separator = entry.indexOf("=");
    if (separator <= 0) return undefined;
    environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return environment;
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
