import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface RuntimeProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface RuntimeProcessTerminationOptions {
  readonly process: ChildProcessWithoutNullStreams;
  readonly exit: Promise<RuntimeProcessExit>;
  readonly hasExited: () => boolean;
  readonly graceMs?: number | undefined;
  readonly closeStdin?: boolean | undefined;
  readonly onForceKill?: (() => void) | undefined;
  readonly onStuck?: (() => void) | undefined;
}

const DEFAULT_TERMINATION_GRACE_MS = 1_000;

/** Supervises one provider process without imposing a transport abstraction. */
export class RuntimeProcessSupervisor {
  readonly exit: Promise<RuntimeProcessExit>;
  private exited = false;
  private termination: Promise<void> | undefined;

  constructor(readonly process: ChildProcessWithoutNullStreams) {
    this.exit = new Promise<RuntimeProcessExit>((resolve, reject) => {
      process.once("error", reject);
      process.once("exit", (code, signal) => {
        this.exited = true;
        resolve({ code, signal });
      });
    });
  }

  hasExited = (): boolean => this.exited;

  terminate(
    options: Omit<RuntimeProcessTerminationOptions, "process" | "exit" | "hasExited"> = {},
  ): Promise<void> {
    this.termination ??= terminateRuntimeProcess({
      ...options,
      process: this.process,
      exit: this.exit,
      hasExited: this.hasExited,
    });
    return this.termination;
  }
}

export async function terminateRuntimeProcess(
  options: RuntimeProcessTerminationOptions,
): Promise<void> {
  if (options.hasExited()) return;
  if (options.closeStdin ?? true) closeRuntimeProcessInput(options.process);
  signalRuntimeProcess(options.process, "SIGTERM");
  if (await waitForRuntimeProcessExit(options.exit, options.graceMs)) return;
  if (options.hasExited()) return;
  options.onForceKill?.();
  signalRuntimeProcess(options.process, "SIGKILL");
  if (!(await waitForRuntimeProcessExit(options.exit, options.graceMs)) && !options.hasExited()) {
    options.onStuck?.();
  }
}

export async function waitForRuntimeProcessExit(
  exit: Promise<RuntimeProcessExit>,
  timeoutMs = DEFAULT_TERMINATION_GRACE_MS,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  return await Promise.race([
    exit.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export class BoundedRuntimeOutputBuffer {
  private bytes = Buffer.alloc(0);

  constructor(
    readonly limit: number,
    readonly mode: "head" | "tail" = "tail",
  ) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("Runtime output buffer limit must be a positive safe integer.");
    }
  }

  append(chunk: Buffer | string): void {
    if (this.mode === "head" && this.bytes.length >= this.limit) return;
    const next = Buffer.concat([this.bytes, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    this.bytes = this.mode === "head" ? next.subarray(0, this.limit) : next.subarray(-this.limit);
  }

  text(): string {
    return this.bytes.toString("utf8");
  }

  get byteLength(): number {
    return this.bytes.length;
  }
}

function closeRuntimeProcessInput(process: ChildProcessWithoutNullStreams): void {
  if (process.stdin.destroyed || process.stdin.writableEnded) return;
  try {
    process.stdin.end();
  } catch {
    process.stdin.destroy();
  }
}

function signalRuntimeProcess(
  process: ChildProcessWithoutNullStreams,
  signal: "SIGTERM" | "SIGKILL",
): void {
  try {
    process.kill(signal);
  } catch {
    // Exit observation remains authoritative; signaling races are expected.
  }
}
