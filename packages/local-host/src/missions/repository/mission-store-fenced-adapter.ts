import type { MissionControllerStore } from "../controller/mission-controller-store.ts";
import type { MissionOwnerScope } from "../controller/owner-scope.ts";
import type { MissionSemanticOperation } from "../controller/schemas.ts";

import type { Mission } from "@pragma/shared";
import type { MissionStore } from "./mission-store.ts";

/**
 * Adds the Local Host ownership fence to the Mission persistence
 * boundary.  The repository and controller share the complete semantic transaction
 * boundary, including replay of the persisted operation.
 *
 * Runtime and Core work must stay outside these callbacks.  The adapter is
 * intentionally limited to MissionStore writes so a lost lease cannot let a
 * stale Host process mutate product state.
 */
export function createFencedMissionStore(
  store: MissionStore,
  options: {
    readonly controller: MissionControllerStore;
    readonly ownerScope: MissionOwnerScope;
    readonly setSemanticWriteReplay: (
      replay: (operation: MissionSemanticOperation) => Promise<void>,
    ) => void;
    readonly onExecutionChanged?:
      | ((input: {
          readonly missionId: string;
          readonly execution: {
            readonly id: string;
            readonly status: NonNullable<Mission["execution"]>["status"];
          };
        }) => void)
      | undefined;
  },
): MissionStore {
  const named = (name: string, input: Record<string, unknown>): MissionSemanticOperation => ({
    name,
    input,
  });

  const replay = async (operation: MissionSemanticOperation): Promise<void> => {
    switch (operation.name) {
      case "mission.managed-revision-draft.mount":
        await store.mountManagedRevisionDraft(
          operation.input.input as Parameters<MissionStore["mountManagedRevisionDraft"]>[0],
        );
        return;
      case "mission.skill-revision-draft.mount":
        await store.mountSkillRevisionDraft(
          operation.input.input as Parameters<MissionStore["mountSkillRevisionDraft"]>[0],
        );
        return;
      case "mission.managed-revision-store.restore":
        await store.restoreManagedRevisionStore(
          operation.input.input as Parameters<MissionStore["restoreManagedRevisionStore"]>[0],
        );
        return;
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
        await store.updateContextMounts(
          String(operation.input.id),
          operation.input.contextMounts as Parameters<MissionStore["updateContextMounts"]>[1],
        );
        return;
      case "mission.context-store-mount.remove": {
        // Complete pending transactions written by earlier Desktop versions
        // through the current guarded Mission mutation primitive.
        const id = String(operation.input.id);
        const storeId = String(operation.input.storeId);
        const mission = await store.get(id);
        await store.updateContextMounts(
          id,
          mission.contextMounts.filter(
            (mount) => mount.kind !== "context-store" || mount.storeId !== storeId,
          ),
        );
        return;
      }
      case "mission.skill-revision-draft.unmount":
        await store.unmountSkillRevisionDraft(
          operation.input.input as Parameters<MissionStore["unmountSkillRevisionDraft"]>[0],
        );
        return;
      case "mission.skill-revision-workspace.rebind":
        await store.rebindLegacySkillRevisionWorkspace(
          operation.input.input as Parameters<
            MissionStore["rebindLegacySkillRevisionWorkspace"]
          >[0],
        );
        return;
      case "mission.execution.update": {
        const mission = await store.updateExecution(
          String(operation.input.id),
          operation.input.execution as Parameters<MissionStore["updateExecution"]>[1],
          operation.input.guard as Parameters<MissionStore["updateExecution"]>[2],
        );
        if (mission.execution !== undefined) {
          options.onExecutionChanged?.({
            missionId: String(operation.input.id),
            execution: { id: mission.execution.id, status: mission.execution.status },
          });
        }
        return;
      }
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
          operation.input.sourceUpdatedAt as string | undefined,
        );
        return;
      default:
        throw new Error(`Unknown durable Mission semantic operation: ${operation.name}`);
    }
  };

  options.setSemanticWriteReplay(replay);

  const sameOperation = (
    left: MissionSemanticOperation,
    right: MissionSemanticOperation,
  ): boolean => JSON.stringify(left) === JSON.stringify(right);

  const write = async <T>(
    missionId: string,
    eventType: string,
    operation: MissionSemanticOperation,
    apply: () => Promise<T>,
  ): Promise<T> => {
    const guard = await options.ownerScope.acquire(missionId);
    let recoveredResult: { readonly value: T } | undefined;
    const recovered = await options.controller.recoverSemanticWrite({
      missionId,
      guard,
      replay: async (pending) => {
        if (sameOperation(pending, operation)) {
          // Capture the original method result while the controller still owns
          // the recovery journal and lock. Never repeat the mutation after it
          // commits: the lease may be revoked as soon as recovery returns.
          recoveredResult = { value: await apply() };
        } else {
          await replay(pending);
        }
      },
    });
    if (recovered !== undefined && sameOperation(recovered, operation)) {
      if (recoveredResult === undefined) {
        throw new Error("Mission semantic recovery did not return its mutation result.");
      }
      return recoveredResult.value;
    }
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
    mountManagedRevisionDraft: async (input) =>
      await write(
        input.id,
        "mission.managed-revision-draft.mounted",
        named("mission.managed-revision-draft.mount", { input }),
        async () => await store.mountManagedRevisionDraft(input),
      ),
    mountSkillRevisionDraft: async (input) =>
      await write(
        input.id,
        "mission.skill-revision-draft.mounted",
        named("mission.skill-revision-draft.mount", { input }),
        async () => await store.mountSkillRevisionDraft(input),
      ),
    restoreManagedRevisionStore: async (input) =>
      await write(
        input.id,
        "mission.managed-revision-store.restored",
        named("mission.managed-revision-store.restore", { input }),
        async () => await store.restoreManagedRevisionStore(input),
      ),
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
    updateContextMounts: async (id, contextMounts) =>
      await write(
        id,
        "mission.context-stores.updated",
        named("mission.context-stores.update", { id, contextMounts: [...contextMounts] }),
        async () => await store.updateContextMounts(id, contextMounts),
      ),
    unmountSkillRevisionDraft: async (input) =>
      await write(
        input.id,
        "mission.skill-revision-draft.unmounted",
        named("mission.skill-revision-draft.unmount", { input }),
        async () => await store.unmountSkillRevisionDraft(input),
      ),
    rebindLegacySkillRevisionWorkspace: async (input) =>
      await write(
        input.id,
        "mission.skill-revision-workspace.rebound",
        named("mission.skill-revision-workspace.rebind", { input }),
        async () => await store.rebindLegacySkillRevisionWorkspace(input),
      ),
    updateExecution: async (id, execution, guard) => {
      const mission = await write(
        id,
        "mission.execution.updated",
        named("mission.execution.update", {
          id,
          execution,
          ...(guard === undefined ? {} : { guard }),
        }),
        async () => await store.updateExecution(id, execution, guard),
      );
      if (mission.execution !== undefined) {
        options.onExecutionChanged?.({
          missionId: id,
          execution: { id: mission.execution.id, status: mission.execution.status },
        });
      }
      return mission;
    },
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
    writeExecutionProjection: async (id, executionId, entries, sourceUpdatedAt) =>
      await write(
        id,
        "mission.execution-projection.written",
        named("mission.execution-projection.write", { id, executionId, entries, sourceUpdatedAt }),
        async () => await store.writeExecutionProjection(id, executionId, entries, sourceUpdatedAt),
      ),
  };
}
