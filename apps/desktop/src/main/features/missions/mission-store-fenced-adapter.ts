import {
  type MissionControllerStore,
  type MissionOwnerScope,
  type MissionSemanticOperation,
} from "@pragma/local-host";

import type { MissionStore } from "./mission-store.ts";

/**
 * Adds the Local Host ownership fence to the Desktop Mission persistence
 * boundary.  The MissionStore remains the authority for product identity and
 * UI projections; Local Host only supplies the owner/transaction fence.
 *
 * Runtime and Core work must stay outside these callbacks.  The adapter is
 * intentionally limited to MissionStore writes so a lost lease cannot let a
 * stale Desktop process mutate product state.
 */
export function createFencedMissionStore(
  store: MissionStore,
  options: {
    readonly controller: MissionControllerStore;
    readonly ownerScope: MissionOwnerScope;
    readonly setSemanticWriteReplay: (
      replay: (operation: MissionSemanticOperation) => Promise<void>,
    ) => void;
  },
): MissionStore {
  const named = (name: string, input: Record<string, unknown>): MissionSemanticOperation => ({
    name,
    input,
  });

  options.setSemanticWriteReplay(async (operation) => {
    switch (operation.name) {
      case "mission.origin.backfill":
        await store.backfillAutomationOrigin(
          String(operation.input.id),
          operation.input.automationRef as Parameters<MissionStore["backfillAutomationOrigin"]>[1],
        );
        return;
      case "mission.options.update":
        await store.updateOptions(
          String(operation.input.id),
          operation.input.input as Parameters<MissionStore["updateOptions"]>[1],
        );
        return;
      case "mission.context-stores.update":
        await store.updateContextStores(
          String(operation.input.id),
          operation.input.contextStoreIds as Parameters<MissionStore["updateContextStores"]>[1],
        );
        return;
      case "mission.execution.update":
        await store.updateExecution(
          String(operation.input.id),
          operation.input.execution as Parameters<MissionStore["updateExecution"]>[1],
          operation.input.guard as Parameters<MissionStore["updateExecution"]>[2],
        );
        return;
      case "mission.timeline.user-message.append":
        await store.appendUserMessage(
          String(operation.input.id),
          operation.input.message as Parameters<MissionStore["appendUserMessage"]>[1],
        );
        return;
      case "mission.timeline.execution-reference.append":
        await store.appendExecutionReference(
          operation.input.input as Parameters<MissionStore["appendExecutionReference"]>[0],
        );
        return;
      case "mission.status.complete":
        await store.markComplete(String(operation.input.id));
        return;
      case "mission.status.reopen":
        await store.reopen(String(operation.input.id));
        return;
      case "mission.execution-projection.write":
        await store.writeExecutionProjection(
          String(operation.input.id),
          String(operation.input.executionId),
          operation.input.entries as Parameters<MissionStore["writeExecutionProjection"]>[2],
        );
        return;
      default:
        throw new Error(`Unknown durable Mission semantic operation: ${operation.name}`);
    }
  });

  const write = async <T>(
    missionId: string,
    eventType: string,
    operation: MissionSemanticOperation,
    apply: () => Promise<T>,
  ): Promise<T> => {
    const guard = await options.ownerScope.acquire(missionId);
    return await options.controller.coordinateSemanticWrite({
      missionId,
      guard,
      operation,
      eventType,
      eventData: {},
      apply,
    });
  };

  return {
    ...store,
    backfillAutomationOrigin: async (id, automationRef) =>
      await write(
        id,
        "mission.origin.updated",
        named("mission.origin.backfill", { id, automationRef }),
        async () => await store.backfillAutomationOrigin(id, automationRef),
      ),
    updateOptions: async (id, input) =>
      await write(
        id,
        "mission.options.updated",
        named("mission.options.update", { id, input }),
        async () => await store.updateOptions(id, input),
      ),
    updateContextStores: async (id, contextStoreIds) =>
      await write(
        id,
        "mission.context-stores.updated",
        named("mission.context-stores.update", { id, contextStoreIds: [...contextStoreIds] }),
        async () => await store.updateContextStores(id, contextStoreIds),
      ),
    updateExecution: async (id, execution, guard) =>
      await write(
        id,
        "mission.execution.updated",
        named("mission.execution.update", {
          id,
          execution,
          ...(guard === undefined ? {} : { guard }),
        }),
        async () => await store.updateExecution(id, execution, guard),
      ),
    appendUserMessage: async (id, message) =>
      await write(
        id,
        "mission.timeline.user-message.appended",
        named("mission.timeline.user-message.append", { id, message }),
        async () => await store.appendUserMessage(id, message),
      ),
    appendExecutionReference: async (input) =>
      await write(
        input.missionId,
        "mission.timeline.execution-linked",
        named("mission.timeline.execution-reference.append", { input }),
        async () => await store.appendExecutionReference(input),
      ),
    markComplete: async (id) =>
      await write(
        id,
        "mission.status.completed",
        named("mission.status.complete", { id }),
        async () => await store.markComplete(id),
      ),
    reopen: async (id) =>
      await write(
        id,
        "mission.status.reopened",
        named("mission.status.reopen", { id }),
        async () => await store.reopen(id),
      ),
    // Owner deletion has its own transaction and is coordinated by the
    // composition root after lower-level state has been handled.
    remove: store.remove,
    writeExecutionProjection: async (id, executionId, entries) =>
      await write(
        id,
        "mission.execution-projection.written",
        named("mission.execution-projection.write", { id, executionId, entries }),
        async () => await store.writeExecutionProjection(id, executionId, entries),
      ),
  };
}
