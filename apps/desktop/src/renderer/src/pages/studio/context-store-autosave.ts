import type {
  ContextStoreContent,
  ContextStoreContentMetadata,
} from "../../../../shared/contracts/index.ts";

export interface ContextStoreSaveSnapshot {
  readonly entryId: string;
  readonly revision: string;
  readonly draft: string;
  readonly metadata: ContextStoreContentMetadata;
  readonly editVersion: number;
  readonly documentVersion: number;
}

export interface ContextStoreSaveCoordinator {
  inFlight: Promise<boolean> | null;
}

export async function flushContextStoreSaves(
  coordinator: ContextStoreSaveCoordinator,
  callbacks: {
    readonly read: () => ContextStoreSaveSnapshot | undefined;
    readonly persist: (snapshot: ContextStoreSaveSnapshot) => Promise<ContextStoreContent>;
    readonly onSaved: (snapshot: ContextStoreSaveSnapshot, saved: ContextStoreContent) => void;
    readonly onFailed: (snapshot: ContextStoreSaveSnapshot, cause: unknown) => void;
  },
): Promise<boolean> {
  for (;;) {
    if (coordinator.inFlight !== null) {
      const completed = await coordinator.inFlight;
      if (!completed) return false;
      continue;
    }

    const snapshot = callbacks.read();
    if (snapshot === undefined) return true;

    const operation = (async (): Promise<boolean> => {
      try {
        callbacks.onSaved(snapshot, await callbacks.persist(snapshot));
        return true;
      } catch (cause) {
        callbacks.onFailed(snapshot, cause);
        return false;
      }
    })();
    coordinator.inFlight = operation;
    const completed = await operation;
    if (coordinator.inFlight === operation) coordinator.inFlight = null;
    if (!completed) return false;
  }
}
