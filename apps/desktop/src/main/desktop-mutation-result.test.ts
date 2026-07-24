import { describe, expect, it } from "vitest";

import { DesktopMutationError } from "../shared/desktop-api.ts";
import { runDesktopMutation } from "./desktop-mutation-result.ts";
import { PragmaProjectStoreError } from "./pragma-project-store.ts";

describe("runDesktopMutation", () => {
  it("returns successful values in a transport-safe envelope", async () => {
    await expect(runDesktopMutation(async () => ({ revision: 3 }))).resolves.toEqual({
      ok: true,
      value: { revision: 3 },
    });
  });

  it("preserves structured project conflict details across the IPC boundary", async () => {
    const result = await runDesktopMutation(async () => {
      throw new PragmaProjectStoreError(
        "revision_conflict",
        "The edited Expert changed in another window.",
        [],
        {
          baseRevision: 4,
          currentRevision: 6,
          conflictingRefs: ["expert:writer@1.0.0"],
          retryable: false,
        },
      );
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "revision_conflict",
        message: "The edited Expert changed in another window.",
        diagnostics: [],
        conflict: {
          baseRevision: 4,
          currentRevision: 6,
          conflictingRefs: ["expert:writer@1.0.0"],
          retryable: false,
        },
      },
    });
    if (result.ok) throw new Error("Expected a mutation failure.");
    expect(new DesktopMutationError(result.error)).toMatchObject({
      code: "revision_conflict",
      conflict: {
        conflictingRefs: ["expert:writer@1.0.0"],
        retryable: false,
      },
    });
  });
});
