export type SessionState = "active" | "closing" | "closed";
export type RunState =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";
export type TaskState = "pending" | "leased" | "retrying" | "dead_letter";

/** @deprecated Use SessionState and RunState instead. */
export type AgentLifecycleState =
  | "prepared"
  | "running"
  | "completed"
  | "aborted"
  | "failed"
  | SessionState
  | RunState;

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
  /** @deprecated Use sessionState and runState instead. */
  readonly state: AgentLifecycleState;
  readonly sessionState: SessionState;
  readonly runState: RunState | undefined;
  readonly currentContext: TContext | undefined;
  readonly currentSignal: AbortSignal | undefined;
  readonly enqueue: <TResult>(
    work: (context: AgentRunExecutionContext) => Promise<TResult>,
  ) => Promise<TResult>;
  readonly abort: () => Promise<void>;
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

  const abortCurrentRun = (): void => {
    if (currentRunController !== undefined && !currentRunController.signal.aborted) {
      currentRunController.abort(sessionAbortController.signal.reason);
    }
  };

  return {
    get state() {
      if (sessionState === "closed") {
        return "closed";
      }

      if (sessionState === "closing") {
        return "closing";
      }

      return runState ?? "prepared";
    },
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
    async enqueue(work) {
      const execute = async (): Promise<Awaited<ReturnType<typeof work>>> => {
        if (sessionState !== "active" || sessionAbortController.signal.aborted) {
          runState = "cancelled";
          throw new Error("Agent session is closing.");
        }

        const runController = new AbortController();
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
      };

      runState = "queued";
      const result = queue.then(execute);
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return await result;
    },
    async abort() {
      if (sessionState === "closed") {
        await cleanupOnce();
        return;
      }

      if (sessionState === "active") {
        sessionState = "closing";
        sessionAbortController.abort(new Error("Agent session was aborted."));
        abortCurrentRun();
        await hooks.abort?.(sessionAbortController.signal);
      }

      await waitForQueueOrTimeout();
      await cleanupOnce();
      sessionState = "closed";
    },
  };
}
