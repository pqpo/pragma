import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssetFileEditor } from "./AssetFileEditor.tsx";
import { visibleAssetFileEntries } from "./AssetFileTree.tsx";
import { skillPreviewBody } from "./SkillFileWorkspace.tsx";

const callbacks = { onPreviewChange: () => undefined, onChange: () => undefined };

describe("shared asset file browser and editor", () => {
  it("keeps nested cached files hidden beneath a collapsed directory", () => {
    const entries = [
      { id: "references", kind: "directory" as const },
      { id: "references/checklist.md", kind: "file" as const },
      { id: "references/guides", kind: "directory" as const },
      { id: "references/guides/start.md", kind: "file" as const },
      { id: "SKILL.md", kind: "file" as const },
    ];
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
