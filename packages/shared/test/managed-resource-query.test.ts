import { describe, expect, it } from "vitest";
import {
  ManagedSkillGetInputSchema,
  ManagedSkillReadInputSchema,
  ManagedKnowledgeSearchInputSchema,
  ManagedKnowledgeReadInputSchema,
  ManagedResourceContinuationSchema,
  ManagementCommandRequestSchema,
  MANAGEMENT_COMMAND_PROTOCOL,
} from "../src/integration/index.ts";

describe("managed resource query wire", () => {
  it("keeps formal reads explicit and bounded without requiring runtime mounting identities", () => {
    expect(ManagedSkillGetInputSchema.parse({ capabilityId: "0000000000000001" })).toMatchObject({
      view: "summary",
      offset: 0,
      limitChars: 20_000,
    });
    expect(
      ManagedKnowledgeSearchInputSchema.parse({
        storeId: "11111111-1111-4111-8111-111111111111",
        query: "routing",
      }),
    ).toMatchObject({ limit: 25, scope: "all" });
    expect(
      ManagedSkillReadInputSchema.safeParse({
        capabilityId: "0000000000000001",
        path: "/etc/passwd",
      }).success,
    ).toBe(false);
    expect(
      ManagedSkillReadInputSchema.safeParse({ capabilityId: "0000000000000001", path: "../secret" })
        .success,
    ).toBe(false);
    expect(
      ManagedSkillGetInputSchema.safeParse({
        capabilityId: "0000000000000001",
        limitChars: 100_001,
      }).success,
    ).toBe(false);
    expect(
      ManagedSkillGetInputSchema.safeParse({
        capabilityId: "0000000000000001",
        namespace: "forged",
      }).success,
    ).toBe(false);
  });
  it("preserves document identities accepted by the authoritative snapshot Schema", () => {
    expect(
      ManagedKnowledgeReadInputSchema.safeParse({
        storeId: "11111111-1111-4111-8111-111111111111",
        documentId: "Legacy\\Notes.md",
      }).success,
    ).toBe(true);
  });
  it("represents continuations as command inputs accepted by the existing management envelope", () => {
    const next = ManagedResourceContinuationSchema.parse({
      command: "skill.files.read",
      input: {
        capabilityId: "0000000000000001",
        revision: 2,
        contentHash: "a".repeat(64),
        path: "SKILL.md",
        offset: 20_000,
      },
    });
    expect(
      ManagementCommandRequestSchema.safeParse({
        protocol: MANAGEMENT_COMMAND_PROTOCOL,
        requestId: "11111111-1111-4111-8111-111111111111",
        ...next,
      }).success,
    ).toBe(true);
    expect(ManagedSkillReadInputSchema.parse(next.input).revision).toBe(2);
  });
});
