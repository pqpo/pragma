import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { RuntimeCanUseResult } from "./runtime-adapter.ts";

export type RuntimeCommandSpawn = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  },
) => ChildProcessWithoutNullStreams;

export interface RuntimeBinaryProbeOptions {
  readonly runtimeName: string;
  readonly defaultExecutablePath: string;
  readonly executablePath?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
  readonly spawn?: RuntimeCommandSpawn | undefined;
}

export interface RuntimeCommandOptions {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly outputLimit?: number | undefined;
  readonly spawn?: RuntimeCommandSpawn | undefined;
}

export interface RuntimeCommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT = 8_192;

export async function canUseRuntimeBinary(
  options: RuntimeBinaryProbeOptions,
): Promise<RuntimeCanUseResult> {
  const executablePath = options.executablePath ?? options.defaultExecutablePath;

  try {
    const result = await runRuntimeCommand({
      executablePath,
      args: options.args ?? ["--version"],
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      spawn: options.spawn,
    });
    const version = readFirstOutputLine(result.stdout) ?? readFirstOutputLine(result.stderr);

    if (result.exitCode === 0) {
      return {
        usable: true,
        details: {
          executablePath,
          ...(version === undefined ? {} : { version }),
        },
      };
    }

    return {
      usable: false,
      reason: `${options.runtimeName} probe failed with exit code ${result.exitCode ?? "null"}${
        result.signal === null ? "" : ` and signal ${result.signal}`
      }.`,
      details: {
        executablePath,
        exitCode: result.exitCode,
        signal: result.signal,
        stderr: result.stderr,
      },
    };
  } catch (error) {
    return {
      usable: false,
      reason: `${options.runtimeName} is not available at "${executablePath}": ${toErrorMessage(
        error,
      )}`,
      details: {
        executablePath,
      },
    };
  }
}

export function runRuntimeCommand(options: RuntimeCommandOptions): Promise<RuntimeCommandResult> {
  const spawn = options.spawn ?? defaultSpawn;

  return new Promise<RuntimeCommandResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(options.executablePath, options.args, {
      cwd: options.cwd,
      env: options.env,
    });
    const timeout = setTimeout(() => {
      finish(() => {
        child.kill("SIGTERM");
        reject(new Error(`Probe timed out after ${options.timeoutMs}ms.`));
      });
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = appendLimited(stdout, chunk, options.outputLimit ?? OUTPUT_LIMIT);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendLimited(stderr, chunk, options.outputLimit ?? OUTPUT_LIMIT);
    });
    child.on("error", (error) => {
      finish(() => {
        reject(error);
      });
    });
    child.on("exit", (exitCode, signal) => {
      finish(() => {
        resolve({
          exitCode,
          signal,
          stdout,
          stderr,
        });
      });
    });

    function finish(callback: () => void): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      callback();
    }
  });
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): ChildProcessWithoutNullStreams {
  return nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
  });
}

function appendLimited(current: string, chunk: Buffer | string, outputLimit: number): string {
  if (current.length >= outputLimit) {
    return current;
  }

  return (current + String(chunk)).slice(0, outputLimit);
}

function readFirstOutputLine(output: string): string | undefined {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);

  return line;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
