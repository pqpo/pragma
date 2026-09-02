import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  formatExpertMentionDisplayText,
  MissionUserMessageContent,
} from "../pages/missions/mission-chat-presentation.tsx";
import { findExpertMentionQuery } from "./TeamMentionComposer.tsx";

describe("TeamMentionComposer", () => {
  it("opens only at the beginning or after whitespace", () => {
    expect(findExpertMentionQuery("@rev")).toEqual({ start: 0, query: "rev" });
    expect(findExpertMentionQuery("ask @rev")).toEqual({ start: 4, query: "rev" });
    expect(findExpertMentionQuery("ask\n@rev")).toEqual({ start: 4, query: "rev" });
    expect(findExpertMentionQuery("ask@rev")).toBeUndefined();
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
