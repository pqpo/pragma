import { describe, expect, it } from "vitest";

import { MissionStoreError } from "../features/missions/mission-store-error.ts";
import { toContextStoreMissionDeletionError } from "./context-store-mission-deletion-error.ts";

describe("Context Store Mission deletion errors", () => {
  it("maps active Mission executions to a stable blocking code", () => {
    expect(
      toContextStoreMissionDeletionError(
        new MissionStoreError("mission_active", "Internal Mission wording."),
      ),
    ).toMatchObject({ code: "active_mission_referenced" });
  });

  it("maps queued Mission messages to an actionable stable blocking code", () => {
    expect(
      toContextStoreMissionDeletionError(
        new MissionStoreError("message_conflict", "Internal queue wording."),
      ),
    ).toMatchObject({
      code: "mission_message_queue_referenced",
      message:
        "A Mission using this knowledge base has queued messages. Remove or finish them before deleting.",
    });
  });

  it("leaves unrelated Mission errors unchanged", () => {
    expect(
      toContextStoreMissionDeletionError(
        new MissionStoreError("mission_not_found", "Mission no longer exists."),
      ),
    ).toBeUndefined();
  });
});
