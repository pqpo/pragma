import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import "../i18n/index.ts";
import { MarkdownContent } from "./MarkdownContent.tsx";

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
    expect(interactive).toContain('href="semantic/items/fact-a.md"');
  });
});
