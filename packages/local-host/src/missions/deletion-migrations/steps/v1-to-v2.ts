import type { StateMigrationStep } from "@pragma/core";
import { MissionDeletionRecordV1Schema, type MissionDeletionRecordV1 } from "../schemas/v1.ts";
import { MissionDeletionRecordV2Schema } from "../schemas/v2.ts";

export const missionDeletionV1ToV2: StateMigrationStep = {
  fromVersion: 1,
  toVersion: 2,
  inputSchema: MissionDeletionRecordV1Schema,
  migrate(value) {
    const old = value as MissionDeletionRecordV1;
    const steps = Object.fromEntries(
      Object.entries(old.steps).map(([key, step]) => {
        const runs = step.attempts + (step.done && step.errorCode === undefined ? 1 : 0);
        return [key, { ...step, runs }];
      }),
    );
    const retryAttempts = Object.values(steps).reduce(
      (count, step) => count + Math.max(0, step.runs - 1),
      0,
    );
    return MissionDeletionRecordV2Schema.parse({
      ...old,
      schemaVersion: "pragma.mission-deletion/v2",
      retryAttempts,
      steps,
    });
  },
};
