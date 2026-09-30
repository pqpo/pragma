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

  it.each([
    String.raw`remote: {\"password\":\"example-secret\"}`,
    String.raw`remote: {\"access_token\":\"example-secret\"}`,
    String.raw`remote: {\"client_secret\":\"example-secret\"}`,
    String.raw`remote: {\"authorization\":\"Bearer example-secret\"}`,
    String.raw`fatal: https:\/\/user:example-secret@example.test\/repo`,
    String.raw`remote: {\"password\":\"example-secret with spaces\"}`,
    String.raw`remote: {\"password\":\"first \\\"quoted\\\" example-secret\"}`,
    JSON.stringify(JSON.stringify({ password: 'first "quoted" example-secret' })),
  ])("redacts escaped diagnostics in %s", (message) => {
    const details = gitFailureDetails(message);
    expect(details).not.toContain("example-secret");
    expect(details).not.toContain("with spaces");
    expect(details).toContain("[redacted]");
  });

  it.each([0, 1, 2, 3])(
    "keeps the reason after redacting JSON encoded %i additional times",
    (layers) => {
      let diagnostic = JSON.stringify({
        password: 'first "quoted" example-secret\\',
        reason: "Signed commits required",
      });
      for (let layer = 0; layer < layers; layer += 1) diagnostic = JSON.stringify(diagnostic);
      const details = gitFailureDetails(`remote: ${diagnostic}`);
      expect(details).not.toContain("example-secret");
      expect(details).not.toContain("quoted");
      expect(details).toContain("Signed commits required");
    },
  );
});
