import { randomUUID } from "node:crypto";

import { app } from "electron";
import {
  createCompositeLogHandler,
  createConsoleLogHandler,
  createLoggerProvider,
  type PragmaLogger,
  type PragmaLoggerProvider,
  type PragmaPaths,
} from "@pragma/core";

import { createDesktopLogHandler } from "./desktop-log-handler.ts";

const LOG_CLOSE_TIMEOUT_MS = 2_000;

export interface DesktopLogging {
  readonly loggerProvider: PragmaLoggerProvider;
  readonly mainLogger: PragmaLogger;
  readonly activate: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly isClosed: () => boolean;
  readonly reportShutdownFailure: (error: unknown) => void;
}

export function createDesktopLogging(paths: PragmaPaths): DesktopLogging {
  const bootId = randomUUID();
  const desktopLogHandler = createDesktopLogHandler({ paths, bootId });
  const diagnosticLogHandler = app.isPackaged
    ? desktopLogHandler
    : createCompositeLogHandler([desktopLogHandler, createConsoleLogHandler()]);
  const loggerProvider = createLoggerProvider({
    handler: diagnosticLogHandler,
    minimumLevel: readDesktopLogLevel(),
    host: {
      kind: "desktop",
      bootId,
      pid: process.pid,
      version: app.getVersion(),
    },
    baseScope: { processKind: "desktop-main" },
  });

  let closed = false;
  let closePromise: Promise<void> | undefined;
  let shutdownFailureReported = false;

  return {
    loggerProvider,
    mainLogger: loggerProvider.createLogger({ component: "desktop.main" }),
    activate: async () => await desktopLogHandler.activate(),
    isClosed: () => closed,
    close() {
      closePromise ??= withDeadline(
        diagnosticLogHandler.close?.() ?? Promise.resolve(),
        LOG_CLOSE_TIMEOUT_MS,
      ).finally(() => {
        closed = true;
      });
      return closePromise;
    },
    reportShutdownFailure(error) {
      if (shutdownFailureReported) return;
      shutdownFailureReported = true;
      try {
        console.error(
          JSON.stringify({
            level: "error",
            component: "desktop.logging",
            event: "log_shutdown_failed",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      } catch {
        // This is the final non-recursive fallback during process shutdown.
      }
    },
  };
}

function readDesktopLogLevel(): "debug" | "info" | "warn" | "error" | "fatal" | "silent" {
  const configured = process.env["PRAGMA_LOG_LEVEL"];
  return configured === "debug" ||
    configured === "info" ||
    configured === "warn" ||
    configured === "error" ||
    configured === "fatal" ||
    configured === "silent"
    ? configured
    : "info";
}

async function withDeadline(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Diagnostic log shutdown exceeded ${timeoutMs} ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
