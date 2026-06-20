export type AgentLifecycleState =
  | "prepared"
  | "running"
  | "completed"
  | "aborted"
  | "failed";

type MaybePromise<TValue> = TValue | Promise<TValue>;

export interface AgentLifecycleHooks {
  readonly abort?: (() => MaybePromise<void>) | undefined;
  readonly cleanup?: (() => MaybePromise<void>) | undefined;
}

export interface AgentLifecycle<TContext = unknown> {
  readonly state: AgentLifecycleState;
  readonly currentContext: TContext | undefined;
  readonly enqueue: <TResult>(work: () => Promise<TResult>) => Promise<TResult>;
  readonly abort: () => Promise<void>;
}

export function createQueuedAgentLifecycle<TContext = unknown>(
  context: TContext | undefined,
  hooks: AgentLifecycleHooks = {},
): AgentLifecycle<TContext> {
  let state: AgentLifecycleState = "prepared";
  let cleanupPromise: Promise<void> | undefined;
  let queue: Promise<void> = Promise.resolve();

  const getState = (): AgentLifecycleState => state;
  const cleanupOnce = async (): Promise<void> => {
    cleanupPromise ??= Promise.resolve(hooks.cleanup?.()).then(() => undefined);
    await cleanupPromise;
  };

  return {
    get state() {
      return state;
    },
    get currentContext() {
      return context;
    },
    async enqueue(work) {
      const execute = async (): Promise<Awaited<ReturnType<typeof work>>> => {
        if (getState() === "aborted") {
          throw new Error("Agent session was aborted.");
        }

        state = "running";

        try {
          const result = await work();

          if (getState() === "aborted") {
            throw new Error("Agent session was aborted.");
          }

          state = "prepared";
          return result;
        } catch (error) {
          if (getState() !== "aborted") {
            state = "prepared";
          }

          throw error;
        }
      };

      const result = queue.then(execute);
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return await result;
    },
    async abort() {
      if (state === "aborted") {
        await cleanupOnce();
        return;
      }

      state = "aborted";
      await hooks.abort?.();
      queue = Promise.resolve();
      await cleanupOnce();
    }
  };
}
