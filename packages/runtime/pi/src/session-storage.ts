import { mkdir, stat } from "node:fs/promises";
import { watch } from "node:fs";

import type {
  PragmaLogger,
  RuntimeSessionStorageContext,
  RuntimeSessionSyncCallback,
} from "@pragma/core";

const DEFAULT_SESSION_SYNC_DEBOUNCE_MS = 250;

export interface RuntimeSessionWatcher {
  readonly close: () => void;
}

export async function ensureSessionDir(sessionDir: string): Promise<void> {
  await mkdir(sessionDir, { recursive: true });
}

export async function sessionDirExists(sessionDir: string): Promise<boolean> {
  try {
    return (await stat(sessionDir)).isDirectory();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function watchRuntimeSessionDir({
  context,
  callback,
  debounceMs = DEFAULT_SESSION_SYNC_DEBOUNCE_MS,
  logger,
}: {
  readonly context: RuntimeSessionStorageContext;
  readonly callback: RuntimeSessionSyncCallback;
  readonly debounceMs?: number | undefined;
  readonly logger?: PragmaLogger | undefined;
}): RuntimeSessionWatcher {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let pending = false;
  const watcher = watch(context.sessionDir, { persistent: false, recursive: true }, () => {
    scheduleSync();
  });

  watcher.on("error", (error) => {
    logger?.error("runtime.pi_session_watcher_failed", "Runtime session watcher failed", error, {
      agentId: context.agentId,
      runtimeSessionId: context.runtimeSession.id,
      sessionDir: context.sessionDir,
    });
  });

  const flushSync = async (): Promise<void> => {
    if (closed) {
      return;
    }
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      await callback(context);
    } catch (error) {
      logger?.error(
        "runtime.pi_session_sync_failed",
        "Runtime session sync callback failed",
        error,
        {
          agentId: context.agentId,
          runtimeSessionId: context.runtimeSession.id,
          sessionDir: context.sessionDir,
        },
      );
    } finally {
      running = false;
      if (pending && !closed) {
        pending = false;
        scheduleSync();
      }
    }
  };

  const scheduleSync = (): void => {
    if (closed) {
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      void flushSync();
    }, debounceMs);
  };

  return {
    close: () => {
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      watcher.close();
    },
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
