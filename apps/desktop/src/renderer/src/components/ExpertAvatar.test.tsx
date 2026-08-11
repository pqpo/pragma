import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EXPERT_AVATAR_OPTIONS, ExpertAvatar, expertAvatarSource } from "./ExpertAvatar.tsx";

describe("ExpertAvatar", () => {
  it("exposes all 27 unique built-in assets", () => {
    expect(EXPERT_AVATAR_OPTIONS).toHaveLength(27);
    expect(new Set(EXPERT_AVATAR_OPTIONS.map(({ source }) => source)).size).toBe(27);
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
});
