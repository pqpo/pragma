import { describe, expect, it } from "vitest";

import { gitFailureDetails, gitFailureKey } from "./git-feedback.ts";

describe("Git failure feedback", () => {
  it.each([
    [new Error("Git branch does not exist: missing"), "branch"],
    [
      new Error("This Git repository and branch are already associated with an asset."),
      "configuration",
    ],
    [new Error("fatal: couldn't find remote ref missing"), "branch"],
    [{ code: "asset_git_stale_conflict", message: "Snapshot changed." }, "stale"],
    [
      new Error(
        'Error invoking remote method: [{"code":"too_small","path":["metadata","description"]}]',
      ),
      "validation",
    ],
    [{ code: "asset_git_metadata_invalid", message: "YAML parse failed." }, "metadataValidation"],
    [
      new Error("Invalid knowledge metadata at .pragma/metadata/guide.md.yaml"),
      "metadataValidation",
    ],
    [
      new Error(
        "Invalid knowledge metadata: .pragma/metadata/ is reserved for Git synchronization.",
      ),
      "metadataReserved",
    ],
    [new Error("Unexpected provider stderr"), "unknown"],
    [new Error("Host key verification failed."), "hostKey"],
    [new Error("REMOTE HOST IDENTIFICATION HAS CHANGED!"), "hostKey"],
    [new Error("Git executable not found (ENOENT)."), "missingGit"],
    [new Error("spawn git ENOENT"), "missingGit"],
    [new Error("Repository not found."), "repository"],
    [new Error("remote: You are not allowed to push code to protected branches."), "pushRejected"],
    [new Error("[remote rejected] main -> main (pre-receive hook declined)"), "pushRejected"],
  ])("classifies %s as %s", (error, expected) => {
    expect(gitFailureKey(error)).toBe(expected);
  });

  it("keeps useful diagnostics while redacting credentials before truncation", () => {
    const details = gitFailureDetails(
      new Error(
        "fatal: unable to access https://user:secret@example.test/repo?access_token=private&token=hidden\nAuthorization: Bearer private-header\npassword=private-password\n" +
          "x".repeat(3_000),
      ),
    );
    expect(details).toContain("fatal: unable to access https://[redacted]@example.test/repo");
    expect(details).not.toMatch(/private|hidden|user:secret/);
    expect(details.length).toBe(2_000);
  });

  it.each([
    "https://example.test/repo?private_token=example-secret",
    '{"password":"example-secret with spaces"}',
    'Password="example-secret with spaces"',
    "https://example.test/repo?client_secret=example-secret",
  ])("redacts credentials in %s", (message) => {
    expect(gitFailureDetails(message)).not.toContain("example-secret");
    expect(gitFailureDetails(message)).not.toContain("with spaces");
  });
});
