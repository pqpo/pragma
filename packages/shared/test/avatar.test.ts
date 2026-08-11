import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRAGMA_EXPERT_AVATAR_ID,
  DEFAULT_PRAGMA_EXPERT_TEAM_AVATAR_ID,
  PragmaAvatarIdSchema,
  resolvePragmaAvatarId,
} from "../src/index.ts";

describe("Pragma avatar IDs", () => {
  const catalog = {
    expert: [DEFAULT_PRAGMA_EXPERT_AVATAR_ID, "pragma.avatar.expert.reviewer"],
    team: [DEFAULT_PRAGMA_EXPERT_TEAM_AVATAR_ID, "pragma.avatar.team.research"],
  } as const;

  it("accepts portable system avatar IDs", () => {
    expect(PragmaAvatarIdSchema.parse("pragma.avatar.expert.reviewer-2")).toBe(
      "pragma.avatar.expert.reviewer-2",
    );
    expect(PragmaAvatarIdSchema.safeParse("https://example.com/avatar.png").success).toBe(false);
    expect(PragmaAvatarIdSchema.safeParse("../avatar.png").success).toBe(false);
    expect(PragmaAvatarIdSchema.safeParse("Avatar.Expert").success).toBe(false);
  });

  it("returns a matching system avatar for the requested owner kind", () => {
    expect(resolvePragmaAvatarId("expert", "pragma.avatar.expert.reviewer", catalog)).toBe(
      "pragma.avatar.expert.reviewer",
    );
    expect(resolvePragmaAvatarId("team", "pragma.avatar.team.research", catalog)).toBe(
      "pragma.avatar.team.research",
    );
  });

  it("falls back by owner kind without rewriting the requested ID", () => {
    const requestedId = "pragma.avatar.future.shared";
    expect(resolvePragmaAvatarId("expert", requestedId, catalog)).toBe(
      DEFAULT_PRAGMA_EXPERT_AVATAR_ID,
    );
    expect(resolvePragmaAvatarId("team", requestedId, catalog)).toBe(
      DEFAULT_PRAGMA_EXPERT_TEAM_AVATAR_ID,
    );
    expect(resolvePragmaAvatarId("expert", "pragma.avatar.team.research", catalog)).toBe(
      DEFAULT_PRAGMA_EXPERT_AVATAR_ID,
    );
  });
});
