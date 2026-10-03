import { describe, expect, it } from "vitest";

import {
  MissionContextMountsSchema,
  MissionExecutionBindingSchema,
  MissionModelOverrideSchema,
  MissionWorkspaceSchema,
} from "../src/index.ts";

const id = "10000000-0000-4000-8000-000000000001";
const fingerprint = "a".repeat(64);

describe("neutral Mission values", () => {
  it("preserves model normalization, bounds and the closed override shape", () => {
    expect(
      MissionModelOverrideSchema.parse({
        providerId: " provider ",
        modelId: " model ",
        thinkingLevel: " high ",
      }),
    ).toEqual({ providerId: "provider", modelId: "model", thinkingLevel: "high" });
    for (const value of [
      { providerId: "provider", modelId: "model", runtimeId: "pi" },
      { providerId: "provider", modelId: " " },
      { providerId: "p".repeat(201), modelId: "model" },
      { providerId: "provider", modelId: "model", thinkingLevel: "x".repeat(101) },
    ]) {
      expect(MissionModelOverrideSchema.safeParse(value).success).toBe(false);
    }
    expect(
      MissionModelOverrideSchema.safeParse({
        providerId: "p".repeat(200),
        modelId: "m".repeat(200),
      }).success,
    ).toBe(true);
    expect(MissionWorkspaceSchema.parse({ path: " /workspace ", basename: " workspace " })).toEqual(
      {
        path: "/workspace",
        basename: "workspace",
      },
    );
  });

  it("keeps both historical UUID and current semantic Capability binding identities", () => {
    const execution = {
      id,
      inputMessageId: id,
      sessionId: id,
      status: "waiting",
      waitReason: "human_input",
      startedAt: "2026-08-20T04:05:06.000Z",
      contextMountsFingerprint: fingerprint,
      environmentFingerprint: fingerprint,
      resolvedCapabilities: [id, "7k2m9q4v8np6r3dt"].map((capabilityId) => ({
        capabilityId,
        resolvedRevision: 1,
        fingerprint,
      })),
    };
    expect(MissionExecutionBindingSchema.parse({ ...execution, extra: "stripped" })).toEqual(
      execution,
    );
    expect(
      MissionExecutionBindingSchema.safeParse({ ...execution, status: "interrupted" }).success,
    ).toBe(false);
    expect(
      MissionExecutionBindingSchema.safeParse({
        ...execution,
        resolvedCapabilities: [{ ...execution.resolvedCapabilities[0], extra: "rejected" }],
      }).success,
    ).toBe(false);
  });

  it("preserves Context mount kinds and uniqueness within each draft kind", () => {
    const mounts = [
      { kind: "context-store", storeId: id },
      { kind: "context-store-draft", draftId: id },
      { kind: "skill-revision-draft", draftId: id, revisionJobId: id, capabilityId: id },
    ];
    expect(MissionContextMountsSchema.parse(mounts)).toEqual(mounts);
    expect(MissionContextMountsSchema.safeParse([mounts[0], mounts[0]]).success).toBe(false);
    expect(MissionContextMountsSchema.safeParse([mounts[1], mounts[1]]).success).toBe(false);
    expect(MissionContextMountsSchema.safeParse([{ ...mounts[0], revision: 1 }]).success).toBe(
      false,
    );
    expect(
      MissionContextMountsSchema.safeParse([
        { kind: "skill-revision-draft", draftId: id, capabilityId: id },
      ]).success,
    ).toBe(false);
  });
});
