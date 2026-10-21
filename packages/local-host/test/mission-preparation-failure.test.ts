import { expect, it } from "vitest";
import {
  consumeUnstartedMissionPreparationFailure,
  withMissionPreparationFailure,
} from "../src/missions/preparation-failure.ts";
import type { Mission } from "@pragma/shared";

it("provides process-local non-execution proof only at first-run preparation", async () => {
  const error = new Error("compilation failed");
  expect(consumeUnstartedMissionPreparationFailure(error, "mission-a")).toBe(false);
  await expect(
    withMissionPreparationFailure({ id: "mission-a", execution: undefined }, async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(consumeUnstartedMissionPreparationFailure(error, "mission-b")).toBe(false);
  expect(consumeUnstartedMissionPreparationFailure(error, "mission-a")).toBe(true);
  expect(consumeUnstartedMissionPreparationFailure(error, "mission-a")).toBe(false);
  const historical = new Error("compilation failed");
  await expect(
    withMissionPreparationFailure(
      { id: "mission-a", execution: { id: "prior" } as Mission["execution"] },
      async () => {
        throw historical;
      },
    ),
  ).rejects.toBe(historical);
  expect(consumeUnstartedMissionPreparationFailure(historical, "mission-a")).toBe(false);
  expect(
    consumeUnstartedMissionPreparationFailure(
      { message: error.message, preAdmission: true },
      "mission-a",
    ),
  ).toBe(false);
});
