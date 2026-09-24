import { ContextStoreStoreError } from "../features/context-stores/context-store-store.ts";
import { MissionStoreError } from "../features/missions/mission-store-error.ts";

export function toContextStoreMissionDeletionError(
  error: unknown,
): ContextStoreStoreError | undefined {
  if (!(error instanceof MissionStoreError)) return undefined;
  if (error.code === "mission_active") {
    return new ContextStoreStoreError(
      "active_mission_referenced",
      "A Mission using this knowledge base is active. Wait for it to finish before deleting.",
    );
  }
  if (error.code === "message_conflict") {
    return new ContextStoreStoreError(
      "mission_message_queue_referenced",
      "A Mission using this knowledge base has queued messages. Remove or finish them before deleting.",
    );
  }
  return undefined;
}
