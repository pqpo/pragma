import { describe, expect, it } from "vitest";

import type { ExpertTeam } from "../src/agent/expert-team.ts";
import { formatTeamMentionRoutingInstructions } from "../src/execution/expert-runner.ts";

describe("ExpertTeam mention routing instructions", () => {
  it("routes canonical mentions while preserving the user's original request", () => {
    const instructions = formatTeamMentionRoutingInstructions({
      members: [{ id: "1xddvess309a6gme", name: "Reviewer" }],
    } as unknown as ExpertTeam);

    expect(instructions).toContain("<@expert:1xddvess309a6gme>: Reviewer");
    expect(instructions).toContain("complete user message");
    expect(instructions).toContain("verbatim or as close to verbatim");
    expect(instructions).toContain("Do not reinterpret the goal");
    expect(instructions).toContain("forward the complete original user message");
    expect(instructions).toContain("spawn_expert");
    expect(instructions).toContain("continue_expert");
  });

  it("does not advertise non-canonical Core-only Expert ids", () => {
    expect(
      formatTeamMentionRoutingInstructions({
        members: [{ id: "reviewer", name: "Reviewer" }],
      } as unknown as ExpertTeam),
    ).toBeUndefined();
  });
});
