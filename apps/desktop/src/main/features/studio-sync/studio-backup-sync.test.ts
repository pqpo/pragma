import { describe, expect, it } from "vitest";

import { backupSourceKey, canonicalBackupRemote } from "./studio-backup-sync.ts";

describe("Studio backup source identity", () => {
  it("normalizes whitespace and trailing slashes only", () => {
    expect(canonicalBackupRemote("  ssh://host/team/repository///  ")).toBe(
      "ssh://host/team/repository",
    );
  });

  it("keeps remotes with and without a .git suffix distinct", () => {
    expect(backupSourceKey({ remote: "ssh://host/team/repository", branch: "main" })).not.toBe(
      backupSourceKey({ remote: "ssh://host/team/repository.git", branch: "main" }),
    );
  });
});
