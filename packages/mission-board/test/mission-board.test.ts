import { describe, expect, it } from "vitest";
import { ContextSystem, InMemoryContextStore, withExecutionRunScope } from "@pragma/core";

import {
  MISSION_BOARD_GUIDE,
  MISSION_BOARD_GUIDE_ID,
  MISSION_BOARD_PRIVATE_NAMESPACE,
  MISSION_BOARD_SHARED_NAMESPACE,
  createMissionBoard,
  type MissionBoardMutationEvent,
} from "../src/index.ts";

describe("Mission Board", () => {
  it("exposes a guide, a shared board, and context-isolated private boards", async () => {
    const privateStores = new Map<string, InMemoryContextStore>();
    const mutations: MissionBoardMutationEvent[] = [];
    const board = await createMissionBoard({
      ownerId: "mission-1",
      openSharedStore: () => new InMemoryContextStore(),
      openPrivateStore: (_ownerId, contextId) => {
        const store = new InMemoryContextStore();
        privateStores.set(contextId, store);
        return store;
      },
      observeMutation: (event) => {
        mutations.push(event);
      },
    });
    expect(
      board.bindings.map(({ namespace, mutationApproval }) => ({ namespace, mutationApproval })),
    ).toEqual([
      {
        namespace: MISSION_BOARD_SHARED_NAMESPACE,
        mutationApproval: "always_on_required",
      },
      {
        namespace: MISSION_BOARD_PRIVATE_NAMESPACE,
        mutationApproval: "always_on_required",
      },
    ]);
    const system = new ContextSystem();
    for (const binding of board.bindings) expect(system.register(binding).ok).toBe(true);

    const guide = await system.read({
      namespace: MISSION_BOARD_SHARED_NAMESPACE,
      id: MISSION_BOARD_GUIDE_ID,
    });
    expect(guide.ok && guide.value.metadata.trigger).toBe("always_on");
    expect(MISSION_BOARD_GUIDE).toContain("promotion requires explicit human approval");
    const guideEdit = await system.edit({
      namespace: MISSION_BOARD_SHARED_NAMESPACE,
      id: MISSION_BOARD_GUIDE_ID,
      mode: "replace",
      content: "changed",
    });
    expect(guideEdit.ok ? undefined : guideEdit.error.code).toBe("permission_denied");
    const shared = await system.add({
      namespace: MISSION_BOARD_SHARED_NAMESPACE,
      id: "plan.md",
      content: "shared",
    });
    expect(shared.ok).toBe(true);
    expect(shared.ok && shared.value.metadata.trigger).toBe("manual");
    const context = withExecutionRunScope(undefined, { contextId: "context-a" });
    const added = await system.add({
      namespace: MISSION_BOARD_PRIVATE_NAMESPACE,
      id: "todos.md",
      content: "private",
      context,
    });
    expect(added.ok).toBe(true);
    expect(privateStores.has("context-a")).toBe(true);
    const denied = await system.read({
      namespace: MISSION_BOARD_PRIVATE_NAMESPACE,
      id: "todos.md",
    });
    expect(denied.ok ? undefined : denied.error.code).toBe("permission_denied");
    const otherContext = withExecutionRunScope(undefined, { contextId: "context-b" });
    const isolated = await system.read({
      namespace: MISSION_BOARD_PRIVATE_NAMESPACE,
      id: "todos.md",
      context: otherContext,
    });
    expect(isolated.ok ? undefined : isolated.error.code).toBe("context_not_found");
    expect(mutations).toMatchObject([
      { ownerId: "mission-1", scope: "shared", operation: "add", id: "plan.md" },
      {
        ownerId: "mission-1",
        scope: "private",
        contextId: "context-a",
        operation: "add",
        id: "todos.md",
      },
    ]);
  });
});
