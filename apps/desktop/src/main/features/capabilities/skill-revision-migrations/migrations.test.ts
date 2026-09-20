import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SkillRevisionDraftV2StoredSchema } from "./schemas/draft-v2.ts";
import { SkillRevisionJobV3StoredSchema } from "./schemas/job-v3.ts";
import { migrateSkillRevisionDraftV2ToV3 } from "./steps/draft-v2-to-v3.ts";
import { migrateSkillRevisionJobV3ToV4 } from "./steps/job-v3-to-v4.ts";

describe("Skill revision storage migrations", () => {
  it("turns an in-flight evaluation into an explicit resubmission requirement", async () => {
    const source = SkillRevisionJobV3StoredSchema.parse(
      await historicalFixture("skill-revision-job-v3.json"),
    );

    expect(migrateSkillRevisionJobV3ToV4(source)).toMatchObject({
      schemaVersion: "pragma.skill-revision-job/v4",
      revision: 3,
      state: "needs_attention",
      request: { schemaVersion: "pragma.skill-revision-request/v4" },
      error: { code: "skill_revision_validation_required" },
    });
    expect(migrateSkillRevisionJobV3ToV4(source)).not.toHaveProperty("evaluation");
    expect(migrateSkillRevisionJobV3ToV4(source).request).not.toHaveProperty("replayCases");
  });

  it("moves an evaluating draft to needs_attention without changing its business revision", async () => {
    const source = SkillRevisionDraftV2StoredSchema.parse(
      await historicalFixture("skill-revision-draft-v2.json"),
    );

    expect(migrateSkillRevisionDraftV2ToV3(source)).toMatchObject({
      schemaVersion: "pragma.skill-revision-draft/v3",
      revision: 5,
      state: "needs_attention",
      error: { code: "skill_revision_validation_required" },
    });
  });
});

async function historicalFixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(join(import.meta.dirname, "..", "fixtures", name), "utf8"),
  ) as unknown;
}
