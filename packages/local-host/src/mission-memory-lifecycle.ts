export type LocalHostMissionMemoryBindingInput = {
  missionId: string;
  goal: string;
  projectId?: string;
  bindingId?: string;
};

export type LocalHostMissionMemoryRegistration = {
  missionId: string;
  executionId: string;
  projectId?: string;
};

export type LocalHostMissionMemoryPorts<TBinding> = {
  bindings(input: LocalHostMissionMemoryBindingInput): Promise<TBinding[]>;
  register(input: LocalHostMissionMemoryRegistration): Promise<void>;
  setConversationState(input: {
    missionId: string;
    state: "running" | "active" | "completed";
  }): Promise<void>;
  /** Detach Attention synchronously before awaiting its native resource drain. */
  stopMission(missionId: string): Promise<void>;
  flushDelivery?(): Promise<void>;
  pause?(): Promise<void>;
  /** Settle independent consumers outside the Memory state lock before closing their durable source. */
  beforeClose?: (() => Promise<void>) | undefined;
  close?(): Promise<void>;
};

export type LocalHostMissionMemoryLifecycle<TBinding> = {
  bindings(input: LocalHostMissionMemoryBindingInput): Promise<TBinding[]>;
  register(input: LocalHostMissionMemoryRegistration): Promise<void>;
  resume(missionId: string, executionId: string): Promise<void>;
  beginPrompt(missionId: string, requestId: string): Promise<() => Promise<void>>;
  complete(missionId: string, executionId: string, waiting?: boolean): Promise<void>;
  /** Reconcile a checked durable terminal without installing an active owner. */
  reconcile(missionId: string, executionId: string, waiting?: boolean): Promise<void>;
  pause(): Promise<void>;
  close(): Promise<void>;
};

/** The shared optional Memory lifecycle for every Mission projection and Host. */
export function createLocalHostMissionMemoryLifecycle<TBinding>(options: {
  ports: LocalHostMissionMemoryPorts<TBinding>;
  onError?: (error: unknown) => void;
}): LocalHostMissionMemoryLifecycle<TBinding> {
  type Terminal = { executionId: string; waiting: boolean; reconcile: boolean };
  type Owner = {
    kind: "binding" | "execution" | "intent";
    bindingId: string;
    executionId: string;
    bindingCreated?: boolean;
    terminal?: Terminal;
  };
  const owners = new Map<string, Owner>();
  const bindings = new Map<string, string>();
  const intents = new Map<
    string,
    { owner: Owner; previous: Owner | undefined; deferred: Terminal | undefined }
  >();
  const pendingCompletions = new Set<Promise<void>>();
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };
  const degraded = (error: unknown) => options.onError?.(error);
  const ownerFor = (
    missionId: string,
    executionId: string,
    kind: "execution" | "intent" = "execution",
  ): Owner => ({
    kind,
    bindingId: owners.get(missionId)?.bindingId ?? bindings.get(missionId) ?? missionId,
    executionId,
  });
  const releaseBinding = (missionId: string): void => {
    const completion = (async () => {
      try {
        await options.ports.stopMission(missionId);
        await options.ports.flushDelivery?.();
      } catch (error) {
        degraded(error);
      }
    })();
    pendingCompletions.add(completion);
    void completion.finally(() => pendingCompletions.delete(completion)).catch(degraded);
  };
  const idle = async (operation: (() => Promise<void>) | undefined): Promise<void> => {
    await serialize(async () => {
      if (owners.size > 0 || pendingCompletions.size > 0) return;
      try {
        await operation?.();
      } catch (error) {
        degraded(error);
      } finally {
        bindings.clear();
      }
    });
  };
  const settle = async (
    missionId: string,
    executionId: string,
    waiting: boolean,
    reconcile: boolean,
  ): Promise<void> => {
    const capturedOwner = owners.get(missionId);
    // Retain this generation's terminal even when teardown spans a rejected
    // prompt intent. Its rollback launches the terminal again in the background.
    if (capturedOwner?.executionId === executionId)
      capturedOwner.terminal = { executionId, waiting, reconcile };
    const completion = (async () => {
      try {
        const stopped = await serialize(async () => {
          const intent = intents.get(missionId);
          if (
            intent !== undefined &&
            owners.get(missionId) === intent.owner &&
            (intent.previous?.executionId === executionId ||
              (reconcile && intent.previous === undefined))
          ) {
            intent.deferred = { executionId, waiting, reconcile };
            return undefined;
          }
          if (
            owners.get(missionId) !== capturedOwner ||
            (capturedOwner?.executionId !== executionId &&
              !(reconcile && capturedOwner === undefined))
          )
            return undefined;
          const task = options.ports.stopMission(missionId);
          void task.catch(() => undefined);
          // Wrap the promise so this short queue does not await native stop.
          return { task };
        });
        if (stopped === undefined) return;
        await stopped.task;
        await serialize(async () => {
          if (owners.get(missionId) !== capturedOwner) {
            const intent = intents.get(missionId);
            if (reconcile && intent !== undefined && intent.previous === capturedOwner)
              intent.deferred = { executionId, waiting, reconcile };
            return;
          }
          await options.ports.setConversationState({
            missionId,
            state: waiting ? "active" : "completed",
          });
          owners.delete(missionId);
          intents.delete(missionId);
        });
        await options.ports.flushDelivery?.();
      } catch (error) {
        await serialize(async () => {
          if (owners.get(missionId) === capturedOwner) {
            owners.delete(missionId);
            intents.delete(missionId);
          }
        });
        degraded(error);
      }
    })();
    pendingCompletions.add(completion);
    try {
      await completion;
    } finally {
      pendingCompletions.delete(completion);
    }
  };
  const api: LocalHostMissionMemoryLifecycle<TBinding> = {
    bindings: async (input) =>
      await serialize(async () => {
        const bindingId = input.bindingId ?? input.missionId;
        bindings.set(input.missionId, bindingId);
        const owner = owners.get(input.missionId);
        if (owner === undefined)
          owners.set(input.missionId, {
            kind: "binding",
            bindingId,
            executionId: bindingId,
            bindingCreated: true,
          });
        else {
          owner.bindingId = bindingId;
          owner.bindingCreated = true;
        }
        try {
          return await options.ports.bindings(input);
        } catch (error) {
          degraded(error);
          return [];
        }
      }),
    register: async (input) => {
      await serialize(async () => {
        owners.set(input.missionId, ownerFor(input.missionId, input.executionId));
        intents.delete(input.missionId);
        try {
          await options.ports.register(input);
          await options.ports.setConversationState({
            missionId: input.missionId,
            state: "running",
          });
        } catch (error) {
          degraded(error);
        }
      });
    },
    resume: async (missionId, executionId) => {
      await serialize(async () => {
        owners.set(missionId, ownerFor(missionId, executionId));
        intents.delete(missionId);
        try {
          await options.ports.setConversationState({ missionId, state: "running" });
        } catch (error) {
          degraded(error);
        }
      });
    },
    beginPrompt: async (missionId, requestId) =>
      await serialize(async () => {
        const previous = owners.get(missionId);
        const owner = ownerFor(missionId, requestId, "intent");
        const intent = { owner, previous, deferred: previous?.terminal };
        owners.set(missionId, owner);
        intents.set(missionId, intent);
        // Admission is provisional: no Memory I/O or conversation state write.
        return async () => {
          const deferred = await serialize(async () => {
            if (owners.get(missionId) !== owner) return undefined;
            if (previous === undefined || previous.kind === "binding") {
              owners.delete(missionId);
              if (previous?.kind === "binding" || owner.bindingCreated) releaseBinding(missionId);
            } else owners.set(missionId, previous);
            intents.delete(missionId);
            return intent.deferred;
          });
          if (deferred !== undefined)
            void settle(
              missionId,
              deferred.executionId,
              deferred.waiting,
              deferred.reconcile,
            ).catch(degraded);
        };
      }),
    complete: async (missionId, executionId, waiting = false) =>
      await settle(missionId, executionId, waiting, false),
    reconcile: async (missionId, executionId, waiting = false) =>
      await settle(missionId, executionId, waiting, true),
    pause: async () => await idle(options.ports.pause),
    close: async () => {
      const eligible = await serialize(
        async () => owners.size === 0 && pendingCompletions.size === 0,
      );
      if (!eligible) return;
      await options.ports.beforeClose?.();
      // A new binding admitted during settlement keeps its source open.
      await idle(options.ports.close);
    },
  };
  return api;
}
