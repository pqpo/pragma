export type SessionState = "active" | "closing" | "closed";
export type RunState =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";
export type TaskState = "pending" | "leased" | "retrying" | "dead_letter";

type MaybePromise<TValue> = TValue | Promise<TValue>;

export interface AgentLifecycleHooks {
  readonly abort?: ((signal: AbortSignal) => MaybePromise<void>) | undefined;
  readonly cleanup?: (() => MaybePromise<void>) | undefined;
  readonly forceCleanupTimeoutMs?: number | undefined;
}

export interface AgentRunExecutionContext {
  readonly signal: AbortSignal;
}

export interface AgentLifecycle<TContext = unknown> {
  readonly sessionState: SessionState;
  readonly runState: RunState | undefined;
  readonly currentContext: TContext | undefined;
  readonly currentSignal: AbortSignal | undefined;
  readonly enqueue: <TResult>(
    work: (context: AgentRunExecutionContext) => Promise<TResult>,
  ) => AgentLifecycleTask<TResult>;
  readonly close: () => Promise<void>;
}

export interface AgentLifecycleTask<TResult> {
  readonly result: Promise<TResult>;
  readonly cancel: () => Promise<void>;
}

export function createQueuedAgentLifecycle<TContext = unknown>(
  context: TContext | undefined,
  hooks: AgentLifecycleHooks = {},
): AgentLifecycle<TContext> {
  const sessionAbortController = new AbortController();
  const cleanupTimeoutMs = hooks.forceCleanupTimeoutMs ?? 5_000;
  let sessionState: SessionState = "active";
  let runState: RunState | undefined;
  let currentRunController: AbortController | undefined;
  const pendingRunControllers = new Set<AbortController>();
  let cleanupPromise: Promise<void> | undefined;
  let queue: Promise<void> = Promise.resolve();

  const cleanupOnce = async (): Promise<void> => {
    cleanupPromise ??= Promise.resolve(hooks.cleanup?.()).then(() => undefined);
    await cleanupPromise;
  };

  const waitForQueueOrTimeout = async (): Promise<void> => {
    await Promise.race([
      queue,
      new Promise<void>((resolve) => {
        setTimeout(resolve, cleanupTimeoutMs);
      }),
    ]);
  };

  const abortCurrentRun = (reason: unknown): void => {
    if (currentRunController !== undefined && !currentRunController.signal.aborted) {
      currentRunController.abort(reason);
    }
  };

  return {
    get sessionState() {
      return sessionState;
    },
    get runState() {
      return runState;
    },
    get currentContext() {
      return context;
    },
    get currentSignal() {
      return currentRunController?.signal;
    },
    enqueue(work) {
      const runController = new AbortController();
      pendingRunControllers.add(runController);
      const execute = async (): Promise<Awaited<ReturnType<typeof work>>> => {
        try {
          if (sessionState !== "active" || sessionAbortController.signal.aborted) {
            runState = "cancelled";
            throw new Error("Agent session is closing.");
          }
          if (runController.signal.aborted) {
            runState = "cancelled";
            throw new Error("Agent run was cancelled before it started.");
          }
          currentRunController = runController;
          const propagateAbort = (): void => {
            if (!runController.signal.aborted) {
              runController.abort(sessionAbortController.signal.reason);
            }
          };
          sessionAbortController.signal.addEventListener("abort", propagateAbort, { once: true });
          runState = "running";

          try {
            const result = await work({ signal: runController.signal });

            if (runController.signal.aborted || sessionAbortController.signal.aborted) {
              runState = "cancelled";
              throw new Error("Agent run was cancelled.");
            }

            runState = "succeeded";
            return result;
          } catch (error) {
            runState =
              runController.signal.aborted || sessionAbortController.signal.aborted
                ? "cancelled"
                : "failed";
            throw error;
          } finally {
            sessionAbortController.signal.removeEventListener("abort", propagateAbort);

            if (currentRunController === runController) {
              currentRunController = undefined;
            }
          }
        } finally {
          pendingRunControllers.delete(runController);
        }
      };

      runState = "queued";
      const result = queue.then(execute);
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return {
        result,
        cancel: async () => {
          if (runController.signal.aborted) return;
          const reason = new Error("Agent submission was cancelled.");
          runController.abort(reason);
        },
      };
    },
    async close() {
      if (sessionState === "closed") {
        await cleanupOnce();
        return;
      }

      if (sessionState === "active") {
        sessionState = "closing";
        sessionAbortController.abort(new Error("Agent session was aborted."));
        for (const controller of pendingRunControllers) {
          if (!controller.signal.aborted) controller.abort(sessionAbortController.signal.reason);
        }
        abortCurrentRun(sessionAbortController.signal.reason);
        await hooks.abort?.(sessionAbortController.signal);
      }

      await waitForQueueOrTimeout();
      await cleanupOnce();
      sessionState = "closed";
    },
  };
}
