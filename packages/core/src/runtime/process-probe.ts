import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { RuntimeCanUseResult } from "./runtime-adapter.ts";
import { BoundedRuntimeOutputBuffer, RuntimeProcessSupervisor } from "./process-supervisor.ts";

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
    const stdout = new BoundedRuntimeOutputBuffer(options.outputLimit ?? OUTPUT_LIMIT, "head");
    const stderr = new BoundedRuntimeOutputBuffer(options.outputLimit ?? OUTPUT_LIMIT, "head");
    let settled = false;
    let timedOut = false;
    const child = spawn(options.executablePath, options.args, {
      cwd: options.cwd,
      env: options.env,
    });
    const supervisor = new RuntimeProcessSupervisor(child);
    // Runtime probes are non-interactive. Closing stdin is materially
    // different from leaving Node's default pipe open: some CLIs wait for EOF
    // before running a subcommand when they are launched without a TTY.
    child.stdin.on("error", () => undefined);
    child.stdin.end();
    const timeout = setTimeout(() => {
      timedOut = true;
      void supervisor.terminate().finally(() => {
        finish(() => reject(new Error(`Probe timed out after ${options.timeoutMs}ms.`)));
      });
    }, options.timeoutMs);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout.append(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr.append(chunk);
    });
    void supervisor.exit.then(
      ({ code, signal }) => {
        if (timedOut) return;
        finish(() => {
          resolve({
            exitCode: code,
            signal,
            stdout: stdout.text(),
            stderr: stderr.text(),
          });
        });
      },
      (error: unknown) => {
        finish(() => reject(error));
      },
    );

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
