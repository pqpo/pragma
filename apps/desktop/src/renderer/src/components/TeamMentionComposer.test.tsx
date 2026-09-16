import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  formatExpertMentionDisplayText,
  MissionUserMessageContent,
} from "../pages/missions/mission-chat-presentation.tsx";
import { expertAvatarSource } from "./ExpertAvatar.tsx";
import { findExpertMentionQuery, refreshMentionEditorChips } from "./TeamMentionComposer.tsx";

describe("TeamMentionComposer", () => {
  it("opens only at the beginning or after whitespace", () => {
    expect(findExpertMentionQuery("@rev")).toEqual({ start: 0, query: "rev" });
    expect(findExpertMentionQuery("ask @rev")).toEqual({ start: 4, query: "rev" });
    expect(findExpertMentionQuery("ask\n@rev")).toEqual({ start: 4, query: "rev" });
    expect(findExpertMentionQuery("ask@rev")).toBeUndefined();
  });

  it("refreshes restored mention chips when their candidates load", () => {
    const candidate = {
      ref: "expert:1xddvess309a6gme",
      name: "Reviewer",
      description: "Reviews changes",
      avatarId: "pragma.avatar.expert.01",
    };
    const imageAttributes = new Map<string, string>([["src", "stale-avatar"]]);
    let ariaLabel = "@Unavailable member";
    const labelNode = { textContent: ariaLabel };
    const image = {
      getAttribute: (name: string) => imageAttributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => imageAttributes.set(name, value),
    };
    const chip = {
      dataset: { expertMention: candidate.ref },
      getAttribute: (name: string) => (name === "aria-label" ? ariaLabel : null),
      setAttribute: (name: string, value: string) => {
        if (name === "aria-label") ariaLabel = value;
      },
      querySelector: (selector: string) => {
        if (selector === ".pragma-avatar img") return image;
        if (selector === "span:last-child") return labelNode;
        return null;
      },
    };
    const editor = { querySelectorAll: () => [chip] } as unknown as HTMLElement;

    refreshMentionEditorChips(editor, new Map([[candidate.ref, candidate]]), "Unavailable member");

    expect(labelNode.textContent).toBe("@Reviewer");
    expect(ariaLabel).toBe("@Reviewer");
    expect(imageAttributes.get("src")).toBe(expertAvatarSource(candidate.avatarId));
  });

  it("renders persisted mentions with an avatar and name without exposing the ref", () => {
    const html = renderToStaticMarkup(
      <MissionUserMessageContent
        source="Ask <@expert:1xddvess309a6gme> to review"
        mentionCandidates={[
          {
            ref: "expert:1xddvess309a6gme",
            name: "Reviewer",
            description: "Reviews changes",
            avatarId: "pragma.avatar.expert.01",
          },
        ]}
      />,
    );
    expect(html).toContain("mission-inline-mention");
    expect(html).toContain("@Reviewer");
    expect(html).toContain("pragma-avatar-xs");
    expect(html).not.toContain("1xddvess309a6gme");
  });

  it("removes canonical refs from plain-text work previews", () => {
    const rendered = formatExpertMentionDisplayText(
      "Delegate <@expert:1xddvess309a6gme> this task",
      [
        {
          ref: "expert:1xddvess309a6gme",
          name: "Reviewer",
          description: "Reviews changes",
          avatarId: "pragma.avatar.expert.01",
        },
      ],
      "Unavailable member",
    );
    expect(rendered).toBe("Delegate @Reviewer this task");
    expect(rendered).not.toContain("1xddvess309a6gme");
  });
});
