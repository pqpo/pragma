import { describe, expect, it, vi } from "vitest";

import { publishMissionUpdate } from "./mission-update-publisher.ts";

const missionId = "00000000-0000-4000-8000-000000000000";

describe("publishMissionUpdate", () => {
  it("publishes a validated update to the renderer", () => {
    const send = vi.fn();

    publishMissionUpdate(() => ({ send }), { kind: "remove", missionId });

    expect(send).toHaveBeenCalledWith("missions:updated", {
      kind: "remove",
      missionId,
    });
  });

  it("does not let validation or renderer delivery failures escape into a completed mutation", () => {
    const reportFailure = vi.fn();

    expect(() =>
      publishMissionUpdate(
        () => ({ send: () => undefined }),
        { kind: "remove", missionId: "" },
        reportFailure,
      ),
    ).not.toThrow();
    expect(() =>
      publishMissionUpdate(
        () => ({
          send: () => {
            throw new Error("Object has been destroyed");
          },
        }),
        { kind: "remove", missionId },
        reportFailure,
      ),
    ).not.toThrow();

    expect(reportFailure).toHaveBeenCalledTimes(2);
  });
});
