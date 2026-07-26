import { mkdir, stat } from "node:fs/promises";
import { watch } from "node:fs";

import type { PragmaLogger } from "../logging/logger.ts";
import type { ExpertAgentRunContext } from "./run-context.ts";
import type {
  RuntimeAdapterDescriptor,
  RuntimeSessionRef,
  RuntimeSessionRestoreHandler,
  RuntimeSessionStorageContext,
  RuntimeSessionSyncCallback,
  RuntimeSessionOwner,
} from "./runtime-adapter.ts";

export type RuntimeCheckpointTrigger =
  | "session.created"
  | "runtimeSessionId.changed"
  | "turn.completed"
  | "turn.failed"
  | "context.compacted"
  | "session.destroyed"
  | "files.changed";

export interface RuntimeSessionPersistenceSpec {
  readonly mode: "none" | "checkpoint";
  readonly sessionDir?: string | undefined;
  readonly watch?: boolean | undefined;
  readonly checkpointOn?: readonly RuntimeCheckpointTrigger[] | undefined;
  readonly debounceMs?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface RuntimeSessionRestoreRequest {
  readonly owner: RuntimeSessionOwner;
  readonly agentId: string;
  readonly runtime: RuntimeAdapterDescriptor;
  readonly requestedRuntimeSession?: RuntimeSessionRef | undefined;
  readonly targetSessionDir?: string | undefined;
  readonly workspace: string;
  readonly systemSessionId: string;
  readonly context?: ExpertAgentRunContext | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface RuntimeSessionRestoreResult {
  readonly restoredRuntimeSessionId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface RuntimeSessionCheckpoint {
  readonly owner: RuntimeSessionOwner;
  readonly agentId: string;
  readonly runtime: RuntimeAdapterDescriptor;
  readonly systemSessionId: string;
  readonly runtimeSession: RuntimeSessionRef;
  readonly workspace: string;
  readonly context?: ExpertAgentRunContext | undefined;
  readonly local?:
    | {
        readonly sessionDir?: string | undefined;
      }
    | undefined;
  readonly trigger: RuntimeCheckpointTrigger;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface RuntimeSessionPersistenceProvider {
  readonly restore: (
    request: RuntimeSessionRestoreRequest,
  ) => Promise<RuntimeSessionRestoreResult> | RuntimeSessionRestoreResult;
  readonly checkpoint: (checkpoint: RuntimeSessionCheckpoint) => Promise<void> | void;
}

export interface RuntimeSessionWatcher {
  readonly close: () => void;
}

const DEFAULT_CHECKPOINT_DEBOUNCE_MS = 250;

export function createNoopRuntimeSessionPersistenceProvider(): RuntimeSessionPersistenceProvider {
  return {
    restore: () => ({}),
    checkpoint: () => undefined,
  };
}

export function createCallbackRuntimeSessionPersistenceProvider(options: {
  readonly restoreHandler?: RuntimeSessionRestoreHandler | undefined;
  readonly syncCallback?: RuntimeSessionSyncCallback | undefined;
}): RuntimeSessionPersistenceProvider {
  return {
    async restore(request) {
      if (
        request.requestedRuntimeSession !== undefined &&
        request.requestedRuntimeSession.type !== request.runtime.kind
      ) {
        throw new Error(
          `Runtime session type mismatch: cannot restore ${request.requestedRuntimeSession.type}:${request.requestedRuntimeSession.id} for runtime ${request.runtime.kind}.`,
        );
      }

      if (
        options.restoreHandler === undefined ||
        request.requestedRuntimeSession === undefined ||
        request.targetSessionDir === undefined ||
        request.requestedRuntimeSession.id === ""
      ) {
        return {};
      }

      await options.restoreHandler(
        createRuntimeSessionStorageContext({
          agentId: request.agentId,
          owner: request.owner,
          context: request.context,
          runtime: request.runtime,
          runtimeSessionId: request.requestedRuntimeSession.id,
          sessionDir: request.targetSessionDir,
          systemSessionId: request.systemSessionId,
          workspace: request.workspace,
        }),
      );

      return { restoredRuntimeSessionId: request.requestedRuntimeSession.id };
    },
    async checkpoint(checkpoint) {
      if (options.syncCallback === undefined || checkpoint.local?.sessionDir === undefined) {
        return;
      }

      await options.syncCallback(
        createRuntimeSessionStorageContext({
          agentId: checkpoint.agentId,
          owner: checkpoint.owner,
          context: checkpoint.context,
          runtime: checkpoint.runtime,
          runtimeSessionId: checkpoint.runtimeSession.id,
          sessionDir: checkpoint.local.sessionDir,
          systemSessionId: checkpoint.systemSessionId,
          workspace: checkpoint.workspace,
        }),
      );
    },
  };
}

export function createRuntimeSessionStorageContext(options: {
  readonly owner: RuntimeSessionOwner;
  readonly agentId: string;
  readonly runtime: RuntimeAdapterDescriptor;
  readonly runtimeSessionId: string;
  readonly workspace: string;
  readonly sessionDir: string;
  readonly systemSessionId: string;
  readonly context?: ExpertAgentRunContext | undefined;
}): RuntimeSessionStorageContext {
  return {
    owner: options.owner,
    agentId: options.agentId,
    runtime: options.runtime,
    runtimeSession: {
      type: options.runtime.kind,
      id: options.runtimeSessionId,
    },
    workspace: options.workspace,
    sessionDir: options.sessionDir,
    systemSessionId: options.systemSessionId,
    ...(options.context === undefined ? {} : { context: options.context }),
  };
}

export async function ensureRuntimeSessionDir(sessionDir: string): Promise<void> {
  await mkdir(sessionDir, { recursive: true });
}

export async function runtimeSessionDirExists(sessionDir: string): Promise<boolean> {
  try {
    return (await stat(sessionDir)).isDirectory();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function shouldCheckpoint(
  spec: RuntimeSessionPersistenceSpec | undefined,
  trigger: RuntimeCheckpointTrigger,
): boolean {
  if (spec === undefined || spec.mode === "none") {
    return false;
  }

  return (spec.checkpointOn ?? ["session.created", "turn.completed", "session.destroyed"]).includes(
    trigger,
  );
}

export async function checkpointRuntimeSession(options: {
  readonly provider: RuntimeSessionPersistenceProvider;
  readonly spec: RuntimeSessionPersistenceSpec | undefined;
  readonly trigger: RuntimeCheckpointTrigger;
  readonly agentId: string;
  readonly owner: RuntimeSessionOwner;
  readonly runtime: RuntimeAdapterDescriptor;
  readonly systemSessionId: string;
  readonly runtimeSessionId: string;
  readonly workspace: string;
  readonly context?: ExpertAgentRunContext | undefined;
  readonly logger?: PragmaLogger | undefined;
}): Promise<void> {
  if (!shouldCheckpoint(options.spec, options.trigger)) {
    return;
  }

  try {
    await options.provider.checkpoint({
      agentId: options.agentId,
      owner: options.owner,
      runtime: options.runtime,
      systemSessionId: options.systemSessionId,
      runtimeSession: {
        type: options.runtime.kind,
        id: options.runtimeSessionId,
      },
      workspace: options.workspace,
      ...(options.context === undefined ? {} : { context: options.context }),
      local:
        options.spec?.sessionDir === undefined
          ? undefined
          : {
              sessionDir: options.spec.sessionDir,
            },
      trigger: options.trigger,
      metadata: {
        ...options.spec?.metadata,
        trigger: options.trigger,
      },
    });
  } catch (error) {
    options.logger?.error(
      "runtime.session_checkpoint_failed",
      "Runtime session checkpoint failed",
      error,
      {
        agentId: options.agentId,
        runtimeSessionId: options.runtimeSessionId,
        trigger: options.trigger,
      },
    );
  }
}

export function watchRuntimeSessionCheckpoint(options: {
  readonly spec: RuntimeSessionPersistenceSpec;
  readonly checkpoint: (trigger: RuntimeCheckpointTrigger) => void | Promise<void>;
  readonly logger?: PragmaLogger | undefined;
}): RuntimeSessionWatcher | undefined {
  if (options.spec.watch !== true || options.spec.sessionDir === undefined) {
    return undefined;
  }

  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let pending = false;
  const watcher = watch(options.spec.sessionDir, { persistent: false, recursive: true }, () => {
    scheduleCheckpoint();
  });

  watcher.on("error", (error) => {
    options.logger?.error(
      "runtime.session_watcher_failed",
      "Runtime session watcher failed",
      error,
      { sessionDir: options.spec.sessionDir },
    );
  });

  const flush = async (): Promise<void> => {
    if (closed) {
      return;
    }
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      await options.checkpoint("files.changed");
    } finally {
      running = false;
      if (pending && !closed) {
        pending = false;
        scheduleCheckpoint();
      }
    }
  };

  const scheduleCheckpoint = (): void => {
    if (closed) {
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, options.spec.debounceMs ?? DEFAULT_CHECKPOINT_DEBOUNCE_MS);
  };

  return {
    close() {
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
