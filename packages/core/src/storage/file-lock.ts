import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

export async function withFileLock<TValue>(
  lockDir: string,
  operation: () => Promise<TValue>,
  options: { readonly timeoutMs?: number; readonly staleMs?: number } = {},
): Promise<TValue> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 30_000;
  const startedAt = Date.now();
  await retryTransientFsOperation(
    () => mkdir(dirname(lockDir), { recursive: true }).then(() => undefined),
    startedAt,
    timeoutMs,
    `creating the Pragma lock parent: ${lockDir}`,
  );

  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if (!isRetryableLockContention(error)) throw error;
      if (isAlreadyExists(error) && (await isStaleLock(lockDir, staleMs))) {
        try {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        } catch (removeError) {
          if (!isRetryableLockContention(removeError)) throw removeError;
        }
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for Pragma file lock: ${lockDir}`, { cause: error });
      }
      await delay(10);
    }
  }

  try {
    return await operation();
  } finally {
    await retryTransientFsOperation(
      () => rm(lockDir, { recursive: true, force: true }),
      Date.now(),
      timeoutMs,
      `releasing the Pragma file lock: ${lockDir}`,
    );
  }
}

async function isStaleLock(lockDir: string, staleMs: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(lockDir)).mtimeMs > staleMs;
  } catch (error) {
    if (isNotFound(error)) return false;
    if (isRetryableLockContention(error)) return false;
    throw error;
  }
}

async function retryTransientFsOperation(
  operation: () => Promise<void>,
  startedAt: number,
  timeoutMs: number,
  description: string,
): Promise<void> {
  while (true) {
    try {
      await operation();
      return;
    } catch (error) {
      if (!isRetryableLockContention(error)) throw error;
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out ${description}`, { cause: error });
      }
      await delay(10);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlreadyExists(error: unknown): boolean {
  return readErrorCode(error) === "EEXIST";
}

function isRetryableLockContention(error: unknown): boolean {
  const code = readErrorCode(error);
  return code === "EEXIST" || code === "EPERM" || code === "EACCES" || code === "ENOTEMPTY";
}

function isNotFound(error: unknown): boolean {
  return readErrorCode(error) === "ENOENT";
}

function readErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}
