import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import "../i18n/index.ts";
import {
  MarkdownContent,
  splitStreamingMarkdown,
  StreamingMarkdownContent,
} from "./MarkdownContent.tsx";

describe("MarkdownContent", () => {
  it("renders GFM content and a controlled code block without injecting HTML", () => {
    const source = [
      "## Result",
      "",
      "Use **strict mode** and `pnpm test`.",
      "",
      "- First",
      "- Second",
      "",
      "```typescript",
      "const answer: number = 42;",
      "```",
      "",
      "<script>alert('unsafe')</script>",
    ].join("\n");

    const html = renderToStaticMarkup(<MarkdownContent source={source} codeBlockControls />);

    expect(html).toContain("<h2>Result</h2>");
    expect(html).toContain("<strong>strict mode</strong>");
    expect(html).toContain("<ul>");
    expect(html).toContain('class="markdown-code-block"');
    expect(html).toContain('class="language-typescript"');
    expect(html).toContain('aria-label="Copy"');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(&#x27;unsafe&#x27;)");
  });

  it("renders internal context links only when a navigation handler is provided", () => {
    const source = "[Fact](semantic/items/fact-a.md)";
    const plain = renderToStaticMarkup(<MarkdownContent source={source} />);
    const interactive = renderToStaticMarkup(
      <MarkdownContent source={source} onInternalLink={() => undefined} />,
    );

    expect(plain).toContain("<span>Fact</span>");
    expect(plain).not.toContain("href=");
    expect(interactive).toContain('class="markdown-content-link" href="semantic/items/fact-a.md"');
  });

  it("keeps the active Markdown tail lightweight while rendering stable blocks", () => {
    const source = "## Stable\n\nThe **active** tail";
    const parts = splitStreamingMarkdown(source);
    const html = renderToStaticMarkup(
      <StreamingMarkdownContent source={source} codeBlockControls />,
    );

    expect(parts).toEqual({
      stableBlocks: ["## Stable\n\n"],
      tail: "The **active** tail",
    });
    expect(html).toContain("<h2>Stable</h2>");
    expect(html).toContain('class="mission-streaming-markdown-tail"');
    expect(html).toContain("The **active** tail");
    expect(html).not.toContain("<strong>active</strong>");
  });

  it("does not split at blank lines inside an unfinished fenced code block", () => {
    const source = "```ts\nconst first = 1;\n\nconst second = 2;";

    expect(splitStreamingMarkdown(source)).toEqual({ stableBlocks: [], tail: source });
  });

  it("bounds stable React blocks for very long streaming output", () => {
    const source = Array.from(
      { length: 5_000 },
      (_, index) => `Paragraph ${index} with **formatting**.\n\n`,
    ).join("");
    const parts = splitStreamingMarkdown(source);

    expect(parts.stableBlocks.length).toBeLessThan(50);
    expect(parts.stableBlocks.join("") + parts.tail).toBe(source);
  });

  it("escapes HTML in the lightweight streaming tail", () => {
    const html = renderToStaticMarkup(
      <StreamingMarkdownContent source={'<script>alert("unsafe")</script>'} />,
    );

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
