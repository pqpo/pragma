import { describe, expect, it } from "vitest";

import {
  skillDiagnosticPath,
  skillSyncRepositoryErrorMessageKey,
} from "./SkillSyncSettingsFragment.tsx";

describe("skill sync repository error hints", () => {
  it("maps stable errors to short actionable messages", () => {
    expect(skillSyncRepositoryErrorMessageKey("git_identity_missing", undefined)).toBe(
      "skillSync.diagnostics.gitIdentityMissing",
    );
    expect(skillSyncRepositoryErrorMessageKey("skill_sync_manifest_invalid", undefined)).toBe(
      "skillSync.diagnostics.repositoryFormat",
    );
  });

  it("classifies Git authentication and branch errors without showing raw output", () => {
    expect(
      skillSyncRepositoryErrorMessageKey(
        "skill_sync_failed",
        "fatal: Authentication failed for 'https://example.test/repo.git'",
      ),
    ).toBe("skillSync.diagnostics.repositoryAccess");
    expect(
      skillSyncRepositoryErrorMessageKey(
        "skill_sync_failed",
        "fatal: couldn't find remote ref refs/heads/unknown",
      ),
    ).toBe("skillSync.diagnostics.branchUnavailable");
  });

  it("uses a concise fallback for unclassified repository failures", () => {
    expect(skillSyncRepositoryErrorMessageKey("skill_sync_failed", "Unknown Git error")).toBe(
      "skillSync.diagnostics.repositorySyncFailed",
    );
  });

  it("shows the local relative path for a non-UTF-8 Skill file without exposing cache paths", () => {
    expect(
      skillDiagnosticPath(
        "skill_sync_binary_file",
        "Skill file is not UTF-8 text: assets/data.bin",
      ),
    ).toBe("assets/data.bin");
    expect(
      skillDiagnosticPath(
        "skill_sync_binary_file",
        "Skill sync file is not UTF-8: /Users/example/.pragma/cache/skills/assets/data.bin",
      ),
    ).toBeUndefined();
  });
});
