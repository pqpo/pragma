import { describe, expect, it } from "vitest";

import { runDesktopMutation } from "./desktop-mutation-result.ts";
import { BundleSetupRequiredError } from "../../features/bundles/pragma-bundle-errors.ts";
import { MissionStoreError } from "../../features/missions/mission-store.ts";
import {
  PragmaProjectRevisionUnavailableError,
  PragmaProjectStoreError,
} from "../../features/projects/pragma-project-store.ts";

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
          conflictingRefs: ["expert:1xddvess309a6gme"],
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
          conflictingRefs: ["expert:1xddvess309a6gme"],
          retryable: false,
        },
      },
    });
  });

  it("preserves referenced resource details across the IPC boundary", async () => {
    const result = await runDesktopMutation(async () => {
      throw new PragmaProjectStoreError(
        "resource_referenced",
        "The resource is referenced.",
        [],
        undefined,
        [
          { ref: "expert:1xddvess309a6gme", name: "Code reviewer" },
          { ref: "flow:ceq0qxcgdv75wg6b", name: "Issue reporter" },
        ],
      );
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "resource_referenced",
        message: "The resource is referenced.",
        diagnostics: [],
        referencedBy: [
          { ref: "expert:1xddvess309a6gme", name: "Code reviewer" },
          { ref: "flow:ceq0qxcgdv75wg6b", name: "Issue reporter" },
        ],
      },
    });
  });

  it("preserves Mission storage error codes for user-facing localization", async () => {
    const result = await runDesktopMutation(async () => {
      throw new MissionStoreError(
        "message_conflict",
        "Mission timeline idempotency conflict for an-internal-id.",
      );
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "message_conflict",
        message: "Mission timeline idempotency conflict for an-internal-id.",
        diagnostics: [],
      },
    });
  });

  it("returns typed Bundle setup guidance without leaking runtime diagnostics", async () => {
    const result = await runDesktopMutation(async () => {
      throw new BundleSetupRequiredError("expert:1xddvess309a6gme", "create_mission", [
        {
          id: "capability:capability:1xddvess309a6gme",
          kind: "capability",
          resourceRef: "capability:1xddvess309a6gme",
          name: "Search MCP",
          status: "action_required",
          code: "credential_missing",
          action: "configure_capability",
          message: "Complete capability setup before using this Bundle.",
        },
      ]);
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "bundle_setup_required",
        bundleSetup: {
          rootRef: "expert:1xddvess309a6gme",
          operation: "create_mission",
          dependencies: [expect.objectContaining({ action: "configure_capability" })],
        },
      },
    });
  });

  it("preserves scoped Project Revision failures and diagnostics", async () => {
    const result = await runDesktopMutation(async () => {
      throw new PragmaProjectRevisionUnavailableError(
        "studio",
        41,
        "compiler-migration",
        "Project revision studio@41 cannot be upgraded.",
        "pragma.dsl/v2",
        "pragma.dsl/v3",
        [
          {
            severity: "error",
            code: "flow.contract.source_unavailable",
            message: "A Flow result is unavailable.",
            path: [],
          },
        ],
        false,
      );
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "project_revision_unavailable",
        message: "Project revision studio@41 cannot be upgraded.",
        diagnostics: [expect.objectContaining({ code: "flow.contract.source_unavailable" })],
        revisionFailure: {
          projectId: "studio",
          revision: 41,
          stage: "compiler-migration",
          sourceCompilerVersion: "pragma.dsl/v2",
          targetCompilerVersion: "pragma.dsl/v3",
          retryable: false,
        },
      },
    });
  });
});
