import { describe, expect, it } from "vitest";

import { DesktopMutationError } from "../../../shared/contracts/index.ts";
import { runDesktopMutation } from "./desktop-mutation-result.ts";
import { MissionOperationError } from "../../features/missions/mission-operation-error.ts";
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
    if (result.ok) throw new Error("Expected a mutation failure.");
    expect(new DesktopMutationError(result.error)).toMatchObject({
      code: "revision_conflict",
      conflict: {
        conflictingRefs: ["expert:1xddvess309a6gme"],
        retryable: false,
      },
    });
  });

  it("preserves Mission operation conflicts without an Electron IPC error wrapper", async () => {
    const result = await runDesktopMutation(async () => {
      throw new MissionOperationError();
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "mission_operation_in_progress",
        message: "Wait for the current mission operation to finish.",
        diagnostics: [],
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
    if (result.ok) throw new Error("Expected a revision failure.");
    expect(new DesktopMutationError(result.error)).toMatchObject({
      code: "project_revision_unavailable",
      revisionFailure: {
        projectId: "studio",
        revision: 41,
      },
    });
  });
});
