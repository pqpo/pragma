import { describe, expect, it } from "vitest";

import { localizedMissionError } from "./mission-errors.ts";

const translate = (key: string): string => `translated:${key}`;

describe("localizedMissionError", () => {
  it("hides Mission timeline implementation details and record ids", () => {
    const message = localizedMissionError(
      {
        code: "message_conflict",
        message: "Mission timeline idempotency conflict for fff293bf-0049-4830-9a6e-9b725307ce1c.",
        diagnostics: [],
      },
      translate,
    );

    expect(message).toBe("translated:errorMessageConflict");
    expect(message).not.toContain("fff293bf");
    expect(message).not.toContain("idempotency");
  });

  it("also hides untyped Core idempotency conflicts", () => {
    expect(
      localizedMissionError(
        {
          code: "internal_error",
          message: "Execution commit idempotency conflict: internal-commit-id",
          diagnostics: [],
        },
        translate,
      ),
    ).toBe("translated:errorInternalStateConflict");
  });

  it("keeps actionable runtime errors available to the Mission repair UI", () => {
    expect(
      localizedMissionError(
        {
          code: "internal_error",
          message: "MCP tool search_issues is not currently available.",
          diagnostics: [],
        },
        translate,
      ),
    ).toBe("MCP tool search_issues is not currently available.");
  });

  it("sanitizes internal Mission history errors from unwrapped read IPC calls", () => {
    expect(
      localizedMissionError(
        new Error(
          "Error invoking remote method 'missions:chat:get': Mission timeline sequence conflict: expected 3, received 4.",
        ),
        translate,
      ),
    ).toBe("translated:errorHistoryUnavailable");
  });
});
