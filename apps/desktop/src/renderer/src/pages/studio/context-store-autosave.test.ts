import { describe, expect, it } from "vitest";

import type { ContextStoreContent } from "../../../../shared/desktop-api.ts";
import {
  flushContextStoreSaves,
  type ContextStoreSaveCoordinator,
  type ContextStoreSaveSnapshot,
} from "./context-store-autosave.ts";

function savedContent(snapshot: ContextStoreSaveSnapshot, revision: string): ContextStoreContent {
  return {
    id: snapshot.entryId,
    content: snapshot.draft,
    metadata: snapshot.metadata,
    revision,
    truncated: false,
  };
}

describe("context store autosave", () => {
  it("serializes an edit made while an earlier save is in flight", async () => {
    const coordinator: ContextStoreSaveCoordinator = { inFlight: null };
    let current: ContextStoreSaveSnapshot | undefined = {
      entryId: "guide.md",
      revision: "r1",
      draft: "First",
      metadata: { trigger: "manual", priority: "normal" },
      editVersion: 1,
      documentVersion: 1,
    };
    let releaseFirst: ((value: ContextStoreContent) => void) | undefined;
    const persisted: ContextStoreSaveSnapshot[] = [];
    const callbacks = {
      read: () => current,
      persist: async (snapshot: ContextStoreSaveSnapshot) => {
        persisted.push(snapshot);
        if (persisted.length === 1) {
          return await new Promise<ContextStoreContent>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return savedContent(snapshot, "r3");
      },
      onSaved: (snapshot: ContextStoreSaveSnapshot, saved: ContextStoreContent) => {
        if (current?.documentVersion !== snapshot.documentVersion) return;
        current =
          current.editVersion === snapshot.editVersion
            ? undefined
            : { ...current, revision: saved.revision! };
      },
      onFailed: () => undefined,
    };

    const firstFlush = flushContextStoreSaves(coordinator, callbacks);
    current = { ...current, draft: "First and second", editVersion: 2 };
    const joinedFlush = flushContextStoreSaves(coordinator, callbacks);
    releaseFirst?.(savedContent(persisted[0]!, "r2"));

    await expect(Promise.all([firstFlush, joinedFlush])).resolves.toEqual([true, true]);
    expect(persisted.map(({ draft, revision }) => ({ draft, revision }))).toEqual([
      { draft: "First", revision: "r1" },
      { draft: "First and second", revision: "r2" },
    ]);
    expect(current).toBeUndefined();
  });

  it("keeps the pending edit dirty when persistence fails", async () => {
    const coordinator: ContextStoreSaveCoordinator = { inFlight: null };
    const current: ContextStoreSaveSnapshot = {
      entryId: "guide.md",
      revision: "r1",
      draft: "Pending",
      metadata: { trigger: "manual", priority: "normal" },
      editVersion: 1,
      documentVersion: 1,
    };
    let failure: unknown;

    await expect(
      flushContextStoreSaves(coordinator, {
        read: () => current,
        persist: async () => {
          throw new Error("revision conflict");
        },
        onSaved: () => undefined,
        onFailed: (_snapshot, cause) => {
          failure = cause;
        },
      }),
    ).resolves.toBe(false);
    expect(failure).toMatchObject({ message: "revision conflict" });
    expect(coordinator.inFlight).toBeNull();
  });
});
