import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { describe, expect, it } from "vitest";
import type { PragmaExpertResource, PragmaExpertTeamResource } from "@pragma/interpreter/ast";

import { expertTeamCoordinatorAvatarId } from "./avatars.ts";

const expert: PragmaExpertResource = {
  apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
  kind: "Expert",
  metadata: {
    id: "1xddvess309a6gme",
    avatarId: "pragma.avatar.expert.07",
    name: "Coordinator",
    description: "Coordinates.",
    tags: [],
  },
  spec: {
    scope: "Coordinate.",
    instructions: "Coordinate.",
    capabilities: [],
    toolApprovals: {},
    contextStores: [],
    plugins: [],
    tools: [],
  },
};

const team: PragmaExpertTeamResource = {
  apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
  kind: "ExpertTeam",
  metadata: {
    id: "p8cbn3cg2avyksn4",
    avatarId: "pragma.avatar.team.default",
    name: "Team",
    description: "A team.",
    tags: [],
  },
  spec: {
    coordinator: { ref: "expert:1xddvess309a6gme" },
    members: [],
    contextStores: [],
    delegation: {
      permissions: { interact: {} },
      maxConcurrency: 1,
      maxDepth: 1,
      context: "context-policy:pragma.fresh@v1",
      runtimes: {},
    },
  },
};

describe("expertTeamCoordinatorAvatarId", () => {
  it("dynamically reads the coordinator's current avatar ID", () => {
    expect(expertTeamCoordinatorAvatarId(team, [expert, team])).toBe("pragma.avatar.expert.07");
    expect(
      expertTeamCoordinatorAvatarId(team, [
        { ...expert, metadata: { ...expert.metadata, avatarId: "pragma.avatar.expert.19" } },
        team,
      ]),
    ).toBe("pragma.avatar.expert.19");
  });

  it("uses the compatibility default when the coordinator cannot be found", () => {
    expect(expertTeamCoordinatorAvatarId(team, [team])).toBe("pragma.avatar.expert.default");
  });
});
