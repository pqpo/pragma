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
  await mkdir(dirname(lockDir), { recursive: true });

  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (await isStaleLock(lockDir, staleMs)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
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
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function isStaleLock(lockDir: string, staleMs: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(lockDir)).mtimeMs > staleMs;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlreadyExists(error: unknown): boolean {
  return readErrorCode(error) === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return readErrorCode(error) === "ENOENT";
}

function readErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}
