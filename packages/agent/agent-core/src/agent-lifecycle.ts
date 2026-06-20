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
  readonly runOnce: <TResult>(
    context: TContext | undefined,
    work: () => Promise<TResult>
  ) => Promise<TResult>;
  readonly abort: () => Promise<void>;
}

export function createSingleRunAgentLifecycle<TContext = unknown>(
  hooks: AgentLifecycleHooks = {}
): AgentLifecycle<TContext> {
  let state: AgentLifecycleState = "prepared";
  let currentContext: TContext | undefined;
  let cleanupPromise: Promise<void> | undefined;

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
      return currentContext;
    },
    async runOnce(context, work) {
      if (state !== "prepared") {
        throw new Error(`Prepared agent session can only run once. Current state: ${state}.`);
      }

      state = "running";
      currentContext = context;

      try {
        const result = await work();

        if (getState() === "aborted") {
          throw new Error("Prepared agent session was aborted.");
        }

        state = "completed";
        return result;
      } catch (error) {
        if (getState() !== "aborted") {
          state = "failed";
        }

        throw error;
      } finally {
        currentContext = undefined;
        await cleanupOnce();
      }
    },
    async abort() {
      if (
        state === "completed" ||
        state === "failed" ||
        state === "aborted"
      ) {
        await cleanupOnce();
        return;
      }

      state = "aborted";
      await hooks.abort?.();
      await cleanupOnce();
    }
  };
}
