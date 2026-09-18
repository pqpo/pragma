import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  formatExpertMentionDisplayText,
  MissionUserMessageContent,
} from "../pages/missions/mission-chat-presentation.tsx";
import { expertAvatarSource } from "./ExpertAvatar.tsx";
import {
  findExpertMentionQuery,
  refreshMentionEditorChips,
  resolveMentionCompositionEnd,
  resolveTeamMentionEnterAction,
  serializeMentionNodes,
} from "./TeamMentionComposer.tsx";

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

  it("keeps an authoritative external reset that arrives during IME composition", () => {
    expect(resolveMentionCompositionEnd("", "拼写中")).toEqual({
      kind: "external",
      value: "",
      currentValue: "拼写中",
    });
  });

  it("commits the final IME value only when no external value is pending", () => {
    expect(resolveMentionCompositionEnd(undefined, "你好")).toEqual({
      kind: "commit",
      value: "你好",
    });
  });

  it("serializes long text and multiple mention chips without losing canonical refs", () => {
    const longText = "性能测试".repeat(5_000);
    const nodes = [
      textNode(longText),
      mentionNode("expert:1xddvess309a6gme"),
      textNode(" then "),
      mentionNode("expert:v2vt1v01vzz6j24q"),
    ];

    expect(serializeMentionNodes(nodes)).toBe(
      `${longText}<@expert:1xddvess309a6gme> then <@expert:v2vt1v01vzz6j24q>`,
    );
  });

  it("removes a mention as an atomic node", () => {
    const nodes = [
      textNode("Ask "),
      mentionNode("expert:1xddvess309a6gme"),
      textNode(" then continue"),
    ];
    nodes.splice(1, 1);

    expect(serializeMentionNodes(nodes)).toBe("Ask  then continue");
  });

  it("uses Shift+Enter for newline, Enter for submit, and ignores IME Enter", () => {
    expect(resolveTeamMentionEnterAction({ shiftKey: true, isComposing: false, keyCode: 13 })).toBe(
      "newline",
    );
    expect(
      resolveTeamMentionEnterAction({ shiftKey: false, isComposing: false, keyCode: 13 }),
    ).toBe("submit");
    expect(
      resolveTeamMentionEnterAction({ shiftKey: false, isComposing: true, keyCode: 229 }),
    ).toBe("ignore");
  });
});

function textNode(text: string): Node {
  return { nodeType: 3, textContent: text } as Node;
}

function mentionNode(ref: string): Node {
  return {
    nodeType: 1,
    dataset: { expertMention: ref },
    tagName: "SPAN",
    childNodes: [],
  } as unknown as Node;
}
