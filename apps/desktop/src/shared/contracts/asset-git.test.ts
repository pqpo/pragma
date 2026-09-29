import { MAX_SKILL_PACKAGE_BYTES } from "@pragma/shared";
import { describe, expect, it } from "vitest";

import {
  assetGitManualContentSizeIssue,
  assetGitResolutionSizeIssue,
  ResolveAssetGitConflictsSchema,
  type AssetGitConflicts,
} from "./asset-git.ts";

const request = (kind: "knowledge" | "skill", content: string) => ({
  target: {
    kind,
    id: kind === "knowledge" ? "00000000-0000-4000-8000-000000000001" : "0123456789abcdef",
  },
  snapshot: "a".repeat(64),
  resolutions: [{ path: "guide.md", choice: "manual", content }],
});

describe("asset-specific Git resolution size validation", () => {
  it("enforces the metadata YAML budget independently of Markdown and Skill limits", () => {
    const path = ".pragma/metadata/guide.md.yaml";
    const valid = request("knowledge", "x".repeat(65_536));
    valid.resolutions[0]!.path = path;
    expect(ResolveAssetGitConflictsSchema.safeParse(valid).success).toBe(true);
    const oversized = request("knowledge", "x".repeat(65_537));
    oversized.resolutions[0]!.path = path;
    expect(ResolveAssetGitConflictsSchema.safeParse(oversized).success).toBe(false);
    expect(assetGitManualContentSizeIssue("knowledge", "知".repeat(21_846), path)).toBe(
      "metadataSize",
    );
    expect(assetGitManualContentSizeIssue("skill", "x".repeat(65_537), path)).toBeUndefined();
  });
  it("accepts the Knowledge boundary and rejects oversize content through the IPC contract", () => {
    expect(
      ResolveAssetGitConflictsSchema.safeParse(request("knowledge", "x".repeat(1_000_000))).success,
    ).toBe(true);
    expect(
      ResolveAssetGitConflictsSchema.safeParse(request("knowledge", "x".repeat(1_000_001))).success,
    ).toBe(false);
    expect(
      ResolveAssetGitConflictsSchema.safeParse(request("knowledge", "x".repeat(2_000_000))).success,
    ).toBe(false);
  });

  it("respects Knowledge UTF-8 storage bytes as well as character counts", () => {
    expect(assetGitManualContentSizeIssue("knowledge", "知".repeat(333_333))).toBeUndefined();
    expect(assetGitManualContentSizeIssue("knowledge", "知".repeat(333_334))).toBe("knowledgeSize");
    expect(
      ResolveAssetGitConflictsSchema.safeParse(request("knowledge", "知".repeat(400_000))).success,
    ).toBe(false);
  });

  it("preserves Skill support above 1 MB, including the 25 MiB boundary", () => {
    expect(
      ResolveAssetGitConflictsSchema.safeParse(request("skill", "x".repeat(2_000_000))).success,
    ).toBe(true);
    expect(
      assetGitManualContentSizeIssue("skill", "x".repeat(MAX_SKILL_PACKAGE_BYTES)),
    ).toBeUndefined();
    expect(
      ResolveAssetGitConflictsSchema.safeParse(request("skill", "知".repeat(9_000_000))).success,
    ).toBe(false);
  });

  it("rejects a collection of individually valid manual Skill files above the package budget", () => {
    const input = request("skill", "x".repeat(13 * 1024 * 1024));
    input.resolutions.push({ ...input.resolutions[0]!, path: "second.md" });
    expect(ResolveAssetGitConflictsSchema.safeParse(input).success).toBe(false);
  });

  it("includes unconflicted and binary files in the editor submission budget", () => {
    const preview: AssetGitConflicts = {
      target: { kind: "skill", id: "0123456789abcdef" },
      snapshot: "a".repeat(64),
      nonConflictingSizeBytes: MAX_SKILL_PACKAGE_BYTES - 10,
      files: [
        {
          path: "image.bin",
          kind: "binary",
          base: null,
          local: null,
          remote: null,
          mergeLocal: null,
          mergeRemote: null,
          localDeleted: false,
          remoteDeleted: false,
          modeConflict: false,
          localSizeBytes: 11,
          remoteSizeBytes: 10,
        },
      ],
    };
    expect(assetGitResolutionSizeIssue(preview, [{ path: "image.bin", choice: "local" }])).toEqual({
      key: "skillSize",
    });
    expect(
      assetGitResolutionSizeIssue(preview, [{ path: "image.bin", choice: "remote" }]),
    ).toBeUndefined();
    expect(
      assetGitResolutionSizeIssue(preview, [{ path: "image.bin", choice: "delete" }]),
    ).toBeUndefined();
    expect(
      assetGitResolutionSizeIssue(
        { ...preview, target: { kind: "knowledge", id: "00000000-0000-4000-8000-000000000001" } },
        [{ path: "guide.md", choice: "manual", content: "x".repeat(2_000_000) }],
      ),
    ).toEqual({ key: "knowledgeSize", path: "guide.md" });
  });
});
