import { describe, expect, it } from "vitest";
import { splitKnowledgeFrontmatter } from "./knowledge-frontmatter.ts";

describe("knowledge frontmatter presentation", () => {
  it("extracts YAML fields while preserving the Markdown body", () => {
    const body = "\r\n## 一句话摘要\r\n正文\r\n---\r\n后续内容";
    const source =
      "\uFEFF---\r\ntitle: 证书续期\r\nsource: https://example.com\r\ntags: [CDN, 域名证书]\r\nsummary: |\r\n  第一行\r\n  第二行\r\nsettings:\r\n  enabled: true\r\nempty: null\r\n---\r\n" +
      body;
    const result = splitKnowledgeFrontmatter(source);
    expect(result.body).toBe(body);
    expect(Object.fromEntries(result.entries)).toEqual({
      title: "证书续期",
      source: "https://example.com",
      tags: "- CDN\n- 域名证书",
      summary: "第一行\n第二行\n",
      settings: "enabled: true",
      empty: "null",
    });
  });

  it("preserves large integers and non-finite YAML values in the metadata display", () => {
    const result = splitKnowledgeFrontmatter(
      "---\nid: 9007199254740993\nlimit: .inf\nnested: { id: 9007199254740993, limit: .inf }\n---\nBody",
    );
    expect(result.body).toBe("Body");
    expect(Object.fromEntries(result.entries)).toEqual({
      id: "9007199254740993",
      limit: "Infinity",
      nested: "id: 9007199254740993\nlimit: .inf",
    });
  });

  it("keeps distinct YAML keys that would collide in a JavaScript object", () => {
    const result = splitKnowledgeFrontmatter(
      '---\n1: numeric key\n"1": string key\nnested: { 1: numeric value, "1": string value }\n---\nBody',
    );
    expect(result.body).toBe("Body");
    expect(result.entries).toEqual([
      ["1", "numeric key"],
      ['"1"', "string key"],
      ["nested", '1: numeric value\n"1": string value'],
    ]);
  });

  it.each([
    "# Normal Markdown\n---\n正文",
    "---\ntitle: Unclosed\n正文",
    "---\ntags: [broken\n---\n正文",
    "---\ntitle: first\ntitle: duplicate\n---\n正文",
    "---\n- list\n---\n正文",
    "---\njust text\n---\n正文",
  ])("keeps non-metadata or malformed input visible: %s", (source) => {
    expect(splitKnowledgeFrontmatter(source)).toEqual({ body: source, entries: [] });
  });

  it("handles an empty mapping and a YAML document end marker", () => {
    expect(splitKnowledgeFrontmatter("---\n{}\n---\nBody")).toEqual({
      body: "Body",
      entries: [],
    });
    expect(splitKnowledgeFrontmatter("---\ncount: 0\nactive: false\n...\nBody")).toEqual({
      body: "Body",
      entries: [
        ["count", "0"],
        ["active", "false"],
      ],
    });
  });
});
