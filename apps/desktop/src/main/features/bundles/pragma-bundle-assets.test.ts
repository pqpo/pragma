import { PragmaResourceRefSchema } from "@pragma/interpreter/ast";
import { describe, expect, it } from "vitest";

import { findBundleAssetConflicts, nextBundleAssetCopyName } from "./pragma-bundle-assets.ts";

describe("Bundle asset conflicts", () => {
  it("matches every same-name local asset independently of Project membership", () => {
    const resourceRef = PragmaResourceRefSchema.parse("capability:0123456789abcdef");
    expect(
      findBundleAssetConflicts(
        [
          {
            resourceRef,
            assetKind: "skill",
            name: " Review Skill ",
            fingerprint: "a".repeat(64),
          },
        ],
        [
          {
            assetId: "11111111-1111-4111-8111-111111111111",
            assetKind: "skill",
            name: "review skill",
            revision: 3,
            fingerprint: "b".repeat(64),
          },
          {
            assetId: "22222222-2222-4222-8222-222222222222",
            assetKind: "skill",
            name: "Review Skill",
            revision: 1,
            fingerprint: "a".repeat(64),
            boundResourceRef: resourceRef,
          },
        ],
      ),
    ).toEqual([
      {
        resourceRef,
        assetKind: "skill",
        importedName: " Review Skill ",
        importedFingerprint: "a".repeat(64),
        candidates: [
          {
            assetId: "11111111-1111-4111-8111-111111111111",
            name: "review skill",
            revision: 3,
            fingerprint: "b".repeat(64),
          },
          {
            assetId: "22222222-2222-4222-8222-222222222222",
            name: "Review Skill",
            revision: 1,
            fingerprint: "a".repeat(64),
            boundResourceRef: resourceRef,
          },
        ],
      },
    ]);
  });

  it("does not use equal content as cross-name identity", () => {
    expect(
      findBundleAssetConflicts(
        [
          {
            resourceRef: PragmaResourceRefSchema.parse("context-store:0123456789abcdef"),
            assetKind: "knowledge_base",
            name: "Imported Handbook",
            fingerprint: "a".repeat(64),
          },
        ],
        [
          {
            assetId: "11111111-1111-4111-8111-111111111111",
            assetKind: "knowledge_base",
            name: "Local Handbook",
            revision: 2,
            fingerprint: "a".repeat(64),
          },
        ],
      ),
    ).toEqual([]);
  });

  it("allocates a normalized unique copy name across the complete asset library", () => {
    expect(
      nextBundleAssetCopyName("Review Skill", ["review skill", "Review Skill (copy)"], 120),
    ).toBe("Review Skill (copy 2)");
  });
});
