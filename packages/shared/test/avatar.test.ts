import { describe, expect, it } from "vitest";

import {
  BUILT_IN_PRAGMA_EXPERT_AVATAR_IDS,
  DEFAULT_PRAGMA_EXPERT_AVATAR_ID,
  DEFAULT_PRAGMA_EXPERT_TEAM_AVATAR_ID,
  FALLBACK_PRAGMA_EXPERT_AVATAR_ID,
  PragmaAvatarIdSchema,
  randomPragmaExpertAvatarId,
  resolvePragmaAvatarId,
} from "../src/index.ts";

describe("Pragma avatar IDs", () => {
  const catalog = {
    expert: ["pragma.avatar.expert.01", "pragma.avatar.expert.reviewer"],
    team: ["pragma.avatar.expert.01", "pragma.avatar.expert.reviewer"],
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
    expect(resolvePragmaAvatarId("team", "pragma.avatar.expert.reviewer", catalog)).toBe(
      "pragma.avatar.expert.reviewer",
    );
  });

  it("resolves the compatibility alias and unknown IDs to the designed fallback", () => {
    const requestedId = "pragma.avatar.future.shared";
    expect(resolvePragmaAvatarId("expert", DEFAULT_PRAGMA_EXPERT_AVATAR_ID)).toBe(
      FALLBACK_PRAGMA_EXPERT_AVATAR_ID,
    );
    expect(resolvePragmaAvatarId("team", DEFAULT_PRAGMA_EXPERT_TEAM_AVATAR_ID)).toBe(
      FALLBACK_PRAGMA_EXPERT_AVATAR_ID,
    );
    expect(resolvePragmaAvatarId("expert", requestedId)).toBe(FALLBACK_PRAGMA_EXPERT_AVATAR_ID);
    expect(resolvePragmaAvatarId("team", requestedId)).toBe(FALLBACK_PRAGMA_EXPERT_AVATAR_ID);
    expect(resolvePragmaAvatarId("expert", "pragma.avatar.team.research", catalog)).toBe(
      FALLBACK_PRAGMA_EXPERT_AVATAR_ID,
    );
  });

  it("publishes all 27 IDs in row-major order and supports deterministic random selection", () => {
    expect(BUILT_IN_PRAGMA_EXPERT_AVATAR_IDS).toHaveLength(27);
    expect(BUILT_IN_PRAGMA_EXPERT_AVATAR_IDS[0]).toBe("pragma.avatar.expert.01");
    expect(BUILT_IN_PRAGMA_EXPERT_AVATAR_IDS[10]).toBe(FALLBACK_PRAGMA_EXPERT_AVATAR_ID);
    expect(BUILT_IN_PRAGMA_EXPERT_AVATAR_IDS[26]).toBe("pragma.avatar.expert.27");
    expect(randomPragmaExpertAvatarId(() => 0)).toBe("pragma.avatar.expert.01");
    expect(randomPragmaExpertAvatarId(() => 10 / 27)).toBe("pragma.avatar.expert.11");
    expect(randomPragmaExpertAvatarId(() => 0.999_999)).toBe("pragma.avatar.expert.27");
    expect(() => randomPragmaExpertAvatarId(() => 1)).toThrow(RangeError);
  });
});
