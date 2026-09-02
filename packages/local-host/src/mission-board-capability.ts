import {
  InMemoryContextStore,
  error,
  ok,
  readExecutionRunScope,
  type ExpertAgentContextItemListInput,
  type ExpertAgentContextItemSearchMatch,
  type ExpertAgentContextItemSummary,
  type ExpertAgentContextResult,
  type ExpertAgentContextStore,
  type ExpertAgentContextStoreRegistrationInput,
  type ExpertAgentStoredContextItem,
  type ExpertAgentStoredContextItemDeleteInput,
  type ExpertAgentStoredContextItemEditInput,
  type ExpertAgentStoredContextItemEditResult,
  type ExpertAgentStoredContextItemReadInput,
  type ExpertAgentStoredContextItemReadResult,
  type ExpertAgentStoredContextItemSearchInput,
  type ExpertAgentStoredContextRegisterInput,
} from "@pragma/core";

import { MISSION_BOARD_GUIDE, MISSION_BOARD_GUIDE_ID } from "./mission-board-guide.ts";

export { MISSION_BOARD_GUIDE, MISSION_BOARD_GUIDE_ID } from "./mission-board-guide.ts";

export const MISSION_BOARD_SHARED_NAMESPACE = "mission-board";
export const MISSION_BOARD_PRIVATE_NAMESPACE = "mission-board-private";

export type MissionBoardMutationOperation = "add" | "edit" | "delete";

export interface MissionBoardMutationEvent {
  readonly schemaVersion: "pragma.mission-board-mutation/v1";
  readonly ownerId: string;
  readonly namespace:
    typeof MISSION_BOARD_SHARED_NAMESPACE | typeof MISSION_BOARD_PRIVATE_NAMESPACE;
  readonly scope: "shared" | "private";
  readonly contextId?: string | undefined;
  readonly operation: MissionBoardMutationOperation;
  readonly id: string;
  readonly revision?: string | undefined;
  readonly occurredAt: string;
}

export interface CreateMissionBoardOptions {
  readonly ownerId: string;
  readonly openSharedStore: (
    ownerId: string,
  ) => ExpertAgentContextStore | Promise<ExpertAgentContextStore>;
  readonly openPrivateStore: (
    ownerId: string,
    contextId: string,
  ) => ExpertAgentContextStore | Promise<ExpertAgentContextStore>;
  readonly observeMutation?:
    ((event: MissionBoardMutationEvent) => void | Promise<void>) | undefined;
}

export interface MissionBoard {
  readonly bindings: readonly ExpertAgentContextStoreRegistrationInput[];
}

export async function createMissionBoard(
  options: CreateMissionBoardOptions,
): Promise<MissionBoard> {
  const ownerId = options.ownerId.trim();
  if (ownerId.length === 0) throw new TypeError("Mission Board ownerId must not be empty.");

  const shared = new ObservableContextStore({
    ownerId,
    namespace: MISSION_BOARD_SHARED_NAMESPACE,
    scope: "shared",
    store: new GuideContextStore(await options.openSharedStore(ownerId)),
    observe: options.observeMutation,
  });
  const privateStore = new PrivateContextRouter({
    ownerId,
    open: options.openPrivateStore,
    observe: options.observeMutation,
  });

  return {
    bindings: [
      {
        namespace: MISSION_BOARD_SHARED_NAMESPACE,
        store: shared,
        required: true,
        mutationApproval: "always_on_required",
        overflowTarget: true,
      },
      {
        namespace: MISSION_BOARD_PRIVATE_NAMESPACE,
        store: privateStore,
        required: true,
        mutationApproval: "always_on_required",
      },
    ],
  };
}

class PrivateContextRouter implements ExpertAgentContextStore {
  private readonly stores = new Map<string, Promise<ExpertAgentContextStore>>();

  constructor(
    private readonly options: {
      readonly ownerId: string;
      readonly open: CreateMissionBoardOptions["openPrivateStore"];
      readonly observe: CreateMissionBoardOptions["observeMutation"];
    },
  ) {}

  async listContext(input: ExpertAgentContextItemListInput) {
    const store = await this.resolve(input.context);
    return store.ok ? await store.value.listContext(input) : store;
  }
  async readContext(input: ExpertAgentStoredContextItemReadInput) {
    const store = await this.resolve(input.context);
    return store.ok ? await store.value.readContext(input) : store;
  }
  async searchContext(input: ExpertAgentStoredContextItemSearchInput) {
    const store = await this.resolve(input.context);
    return store.ok ? await store.value.searchContext(input) : store;
  }
  async addContext(input: ExpertAgentStoredContextRegisterInput) {
    const store = await this.resolve(input.context);
    return store.ok ? await store.value.addContext(input) : store;
  }
  async editContext(input: ExpertAgentStoredContextItemEditInput) {
    const store = await this.resolve(input.context);
    return store.ok ? await store.value.editContext(input) : store;
  }
  async deleteContext(input: ExpertAgentStoredContextItemDeleteInput) {
    const store = await this.resolve(input.context);
    return store.ok ? await store.value.deleteContext(input) : store;
  }

  private async resolve(
    context: ExpertAgentStoredContextItemReadInput["context"],
  ): Promise<ExpertAgentContextResult<ExpertAgentContextStore>> {
    const contextId = readExecutionRunScope(context).contextId;
    if (contextId === undefined) {
      return error<ExpertAgentContextStore>(
        "permission_denied",
        "Private Mission Board access requires a trusted Runtime Context id.",
      );
    }
    const existing = this.stores.get(contextId);
    const store =
      existing ??
      Promise.resolve(this.options.open(this.options.ownerId, contextId)).then(
        (opened) =>
          new ObservableContextStore({
            ownerId: this.options.ownerId,
            namespace: MISSION_BOARD_PRIVATE_NAMESPACE,
            scope: "private",
            contextId,
            store: opened,
            observe: this.options.observe,
          }),
      );
    if (existing === undefined) this.stores.set(contextId, store);
    return ok(await store);
  }
}

class ObservableContextStore implements ExpertAgentContextStore {
  constructor(
    private readonly options: {
      readonly ownerId: string;
      readonly namespace: MissionBoardMutationEvent["namespace"];
      readonly scope: MissionBoardMutationEvent["scope"];
      readonly contextId?: string | undefined;
      readonly store: ExpertAgentContextStore;
      readonly observe: CreateMissionBoardOptions["observeMutation"];
    },
  ) {}

  listContext(input: ExpertAgentContextItemListInput) {
    return this.options.store.listContext(input);
  }
  readContext(input: ExpertAgentStoredContextItemReadInput) {
    return this.options.store.readContext(input);
  }
  searchContext(input: ExpertAgentStoredContextItemSearchInput) {
    return this.options.store.searchContext(input);
  }
  async addContext(input: ExpertAgentStoredContextRegisterInput) {
    return await this.mutate("add", input.id, () => this.options.store.addContext(input));
  }
  async editContext(input: ExpertAgentStoredContextItemEditInput) {
    return await this.mutate("edit", input.id, () => this.options.store.editContext(input));
  }
  async deleteContext(input: ExpertAgentStoredContextItemDeleteInput) {
    const result = await this.options.store.deleteContext(input);
    if (result.ok) await this.observe("delete", input.id, undefined);
    return result;
  }

  private async mutate<TValue extends { readonly revision?: string | undefined }>(
    operation: MissionBoardMutationOperation,
    id: string,
    action: () => Promise<ExpertAgentContextResult<TValue>>,
  ): Promise<ExpertAgentContextResult<TValue>> {
    const result = await action();
    if (result.ok) await this.observe(operation, id, result.value.revision);
    return result;
  }

  private async observe(
    operation: MissionBoardMutationOperation,
    id: string,
    revision: string | undefined,
  ): Promise<void> {
    if (this.options.observe !== undefined) {
      await this.options.observe({
        schemaVersion: "pragma.mission-board-mutation/v1",
        ownerId: this.options.ownerId,
        namespace: this.options.namespace,
        scope: this.options.scope,
        ...(this.options.contextId === undefined ? {} : { contextId: this.options.contextId }),
        operation,
        id,
        ...(revision === undefined ? {} : { revision }),
        occurredAt: new Date().toISOString(),
      });
    }
  }
}

class GuideContextStore implements ExpertAgentContextStore {
  private readonly guide = new InMemoryContextStore({
    context: [
      {
        id: MISSION_BOARD_GUIDE_ID,
        content: MISSION_BOARD_GUIDE,
        metadata: {
          description: "Mission Board usage guide and whiteboard conventions.",
          trigger: "always_on",
          priority: "critical",
          trustLevel: "system",
          sensitivity: "internal",
        },
      },
    ],
  });

  constructor(private readonly store: ExpertAgentContextStore) {}

  async listContext(
    input: ExpertAgentContextItemListInput,
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSummary[]>> {
    const [guide, stored] = await Promise.all([
      this.guide.listContext(input),
      this.store.listContext(input),
    ]);
    if (!guide.ok) return guide;
    if (!stored.ok) return stored;
    return {
      ok: true,
      value: [...guide.value, ...stored.value.filter((item) => item.id !== MISSION_BOARD_GUIDE_ID)],
    };
  }
  readContext(
    input: ExpertAgentStoredContextItemReadInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemReadResult>> {
    return input.id === MISSION_BOARD_GUIDE_ID
      ? this.guide.readContext(input)
      : this.store.readContext(input);
  }
  async searchContext(
    input: ExpertAgentStoredContextItemSearchInput,
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSearchMatch[]>> {
    const [guide, stored] = await Promise.all([
      this.guide.searchContext(input),
      this.store.searchContext(input),
    ]);
    if (!guide.ok) return guide;
    if (!stored.ok) return stored;
    return {
      ok: true,
      value: [...guide.value, ...stored.value.filter((item) => item.id !== MISSION_BOARD_GUIDE_ID)],
    };
  }
  addContext(
    input: ExpertAgentStoredContextRegisterInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItem>> {
    return input.id === MISSION_BOARD_GUIDE_ID
      ? readonlyGuideError()
      : this.store.addContext(input);
  }
  editContext(
    input: ExpertAgentStoredContextItemEditInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemEditResult>> {
    return input.id === MISSION_BOARD_GUIDE_ID
      ? readonlyGuideError()
      : this.store.editContext(input);
  }
  deleteContext(
    input: ExpertAgentStoredContextItemDeleteInput,
  ): Promise<ExpertAgentContextResult<{ readonly id: string }>> {
    return input.id === MISSION_BOARD_GUIDE_ID
      ? readonlyGuideError()
      : this.store.deleteContext(input);
  }
}

function readonlyGuideError<TValue>(): Promise<ExpertAgentContextResult<TValue>> {
  return Promise.resolve(error("permission_denied", `${MISSION_BOARD_GUIDE_ID} is read-only.`));
}
