import { describe, expect, it } from "vitest";

import { gitFailureKey } from "./git-feedback.ts";

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
    [new Error("Unexpected provider stderr"), "unknown"],
  ])("classifies %s as %s", (error, expected) => {
    expect(gitFailureKey(error)).toBe(expected);
  });
});
