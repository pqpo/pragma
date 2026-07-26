import { describe, expect, it } from "vitest";

import { MissionExecutorSchema } from "../src/mission/mission-executor.schema.ts";

describe("MissionExecutorSchema", () => {
  it("accepts current Host-neutral Mission executor refs", () => {
    expect(
      MissionExecutorSchema.parse({
        kind: "expert",
        ref: "expert:7k2m9q4v8np6r3dt",
        name: "Writer",
      }),
    ).toMatchObject({ kind: "expert" });
  });

  it("rejects legacy versioned executor refs", () => {
    expect(
      MissionExecutorSchema.safeParse({
        kind: "expert",
        ref: "expert:writer@1.0.0",
        name: "Writer",
      }).success,
    ).toBe(false);
  });
});
