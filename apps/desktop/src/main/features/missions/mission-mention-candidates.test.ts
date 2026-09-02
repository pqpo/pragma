import {
  PRAGMA_DSL_WRITE_API_VERSION,
  type PragmaExpertTeamResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import { describe, expect, it } from "vitest";

import { expertTeamMentionCandidates } from "./mission-executor-catalog.ts";

describe("Mission mention candidates", () => {
  it("projects members with presentation metadata and excludes the coordinator", () => {
    const resources = [
      expert("1xddvess309a6gme", "Coordinator", "pragma.avatar.expert.01"),
      expert("3sfd30h5017wd17d", "Reviewer", "pragma.avatar.expert.02"),
      {
        apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
        kind: "ExpertTeam",
        metadata: {
          id: "vyv9pwwzaksth2dd",
          name: "Review team",
          description: "Reviews",
          tags: [],
        },
        spec: {
          coordinator: { ref: "expert:1xddvess309a6gme" },
          members: [{ ref: "expert:3sfd30h5017wd17d" }],
        },
      },
    ] as PragmaResource[];

    expect(
      expertTeamMentionCandidates(resources[2]! as PragmaExpertTeamResource, resources),
    ).toEqual([
      {
        ref: "expert:3sfd30h5017wd17d",
        name: "Reviewer",
        description: "Reviewer description",
        avatarId: "pragma.avatar.expert.02",
      },
    ]);
  });
});

function expert(id: string, name: string, avatarId: string): PragmaResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Expert",
    metadata: {
      id,
      name,
      description: `${name} description`,
      tags: [],
      avatarId,
    },
    spec: {},
  } as unknown as PragmaResource;
}
