import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EXPERT_AVATAR_OPTIONS, ExpertAvatar, expertAvatarSource } from "./ExpertAvatar.tsx";
import {
  EXPERT_AVATAR_PROFILE_HOVER_DELAY_MS,
  positionAvatarProfileCard,
  ProfiledExpertAvatar,
} from "./ProfiledExpertAvatar.tsx";

describe("ExpertAvatar", () => {
  it("exposes all 27 unique built-in assets", () => {
    expect(EXPERT_AVATAR_OPTIONS).toHaveLength(27);
    expect(new Set(EXPERT_AVATAR_OPTIONS.map(({ source }) => source)).size).toBe(27);
    expect(EXPERT_AVATAR_OPTIONS[0]).toMatchObject({
      id: "pragma.avatar.expert.01",
      name: "Zara",
      gender: "woman",
      personality: ["analytical", "calm", "perceptive"],
    });
  });

  it("uses avatar 11 for compatibility aliases and unknown IDs", () => {
    const fallback = expertAvatarSource("pragma.avatar.expert.11");
    expect(expertAvatarSource("pragma.avatar.expert.default")).toBe(fallback);
    expect(expertAvatarSource("pragma.avatar.expert.missing")).toBe(fallback);
  });

  it("renders the lowercase team badge as a UI overlay", () => {
    const html = renderToStaticMarkup(
      <ExpertAvatar avatarId="pragma.avatar.expert.03" team size="md" />,
    );
    expect(html).toContain("pragma-avatar-team-badge");
    expect(html).toContain(">team</span>");
  });

  it("delays persona cards by 500ms and keeps their trigger metadata stable", () => {
    const html = renderToStaticMarkup(
      <ProfiledExpertAvatar avatarId="pragma.avatar.expert.01" size="md" />,
    );
    expect(EXPERT_AVATAR_PROFILE_HOVER_DELAY_MS).toBe(500);
    expect(html).toContain('data-avatar-profile="pragma.avatar.expert.01"');
  });

  it("positions persona cards in available viewport space and clamps their edges", () => {
    expect(
      positionAvatarProfileCard({
        anchor: { top: 20, right: 68, bottom: 68, left: 20, width: 48, height: 48 },
        card: { width: 240, height: 110 },
        viewport: { width: 1_000, height: 700 },
      }),
    ).toEqual({ placement: "bottom", left: 12, top: 78 });
    expect(
      positionAvatarProfileCard({
        anchor: { top: 630, right: 448, bottom: 678, left: 400, width: 48, height: 48 },
        card: { width: 240, height: 110 },
        viewport: { width: 1_000, height: 700 },
      }),
    ).toEqual({ placement: "top", left: 304, top: 510 });
    expect(
      positionAvatarProfileCard({
        anchor: { top: 126, right: 148, bottom: 174, left: 100, width: 48, height: 48 },
        card: { width: 240, height: 260 },
        viewport: { width: 800, height: 300 },
      }),
    ).toEqual({ placement: "right", left: 158, top: 20 });
  });
});
