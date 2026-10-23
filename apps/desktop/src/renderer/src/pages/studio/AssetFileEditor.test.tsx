import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssetFileEditor } from "./AssetFileEditor.tsx";
import { visibleAssetFileEntries } from "./AssetFileTree.tsx";
import { skillFileTreeEntries, skillPreviewBody } from "./SkillFileWorkspace.tsx";

const callbacks = { onPreviewChange: () => undefined, onChange: () => undefined };

describe("shared asset file browser and editor", () => {
  it("builds a nested Skill tree and keeps only the collapsed directory row visible", () => {
    const entries = skillFileTreeEntries([
      { path: "references/guides/start.md", size: 10 },
      { path: "references/checklist.md", size: 20 },
      { path: "SKILL.md", size: 30 },
    ]);
    expect(entries.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
      "directory:references",
      "file:references/checklist.md",
      "directory:references/guides",
      "file:references/guides/start.md",
      "file:SKILL.md",
    ]);
    expect(
      visibleAssetFileEntries(entries, new Set(["references"])).map((entry) => entry.id),
    ).toEqual(["references", "SKILL.md"]);
  });

  it("keeps frontmatter in the editable document and removes it only from the Skill entry preview", () => {
    const value = "---\r\nname: review\r\ndescription: Review code.\r\n---\r\n\r\n# Review";
    expect(skillPreviewBody("SKILL.md", value)).toBe("# Review");
    expect(skillPreviewBody("references/example.md", value)).toBe(value);
    const html = renderToStaticMarkup(
      <AssetFileEditor {...callbacks} path="SKILL.md" value={value} preview={false} />,
    );
    expect(html).toContain('aria-label="Markdown content"');
    expect(html).toContain("name: review");
  });

  it("previews scripts as plain text and suppresses editing for read-only assets", () => {
    const html = renderToStaticMarkup(
      <AssetFileEditor
        {...callbacks}
        path="scripts/check.mjs"
        value={'const markup = "<p>example</p>";'}
        preview={false}
        readOnly
      />,
    );
    expect(html).toContain('class="asset-file-text-preview"');
    expect(html).toContain("&lt;p&gt;example&lt;/p&gt;");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain('aria-label="Edit"');
  });

  it("uses the shared document preview and code controls for knowledge and Skill Markdown", () => {
    for (const path of ["SKILL.md", "guides/overview.md"]) {
      const html = renderToStaticMarkup(
        <AssetFileEditor
          {...callbacks}
          path={path}
          value="---\nprivate: metadata\n---\n# Original"
          previewSource={"# Preview\n\n```yaml\npriority: normal\n```"}
          preview
        />,
      );
      expect(html).toContain('<article class="markdown-document">');
      expect(html).toContain("<h1>Preview</h1>");
      expect(html).toContain('class="language-yaml"');
      expect(html).toContain('aria-label="Copy"');
      expect(html).not.toContain("private: metadata");
    }
  });

  it("does not offer text editing or a text preview for binary files", () => {
    const html = renderToStaticMarkup(
      <AssetFileEditor {...callbacks} path="image.bin" value={null} preview={false} />,
    );
    expect(html).toContain("This binary file cannot be previewed as text.");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain('aria-label="Edit"');
  });
});
