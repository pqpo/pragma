import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import "../../i18n/index.ts";
import { SIDEBAR_WIDTH_PREFERENCES } from "../../lib/sidebar-width-preference.ts";
import { AssetFileWorkspace, type AssetFileOperations } from "./AssetFileWorkspace.tsx";
import { skillDirectoryEntries, skillDirectoryOrigin } from "./SkillFileWorkspace.tsx";

const entries = [
  { id: "SKILL.md", kind: "file" as const },
  { id: "references", kind: "directory" as const },
  { id: "references/checklist.md", kind: "file" as const },
];
const operations: AssetFileOperations = {
  createFile: async () => undefined,
  createFolder: async () => undefined,
  renameEntry: async () => undefined,
  deleteEntry: async () => undefined,
  canModifyEntry: (entry) => entry.id !== "SKILL.md",
};
const props = {
  filesLabel: "Skill files",
  resizeLabel: "Resize files",
  widthPreference: SIDEBAR_WIDTH_PREFERENCES.skillFiles,
  entries,
  selectedEntry: entries[0]!,
  collapsedDirectoryIds: new Set<string>(),
  onOpenEntry: () => undefined,
  loading: false,
  onRefresh: async () => undefined,
  editor: {
    path: "SKILL.md",
    value: "# Review",
    preview: true,
    onPreviewChange: () => undefined,
    onChange: () => undefined,
  },
};

describe("shared asset file workspace", () => {
  it("loads an unopened moved Skill folder from its original revision path", () => {
    const operations = [
      { kind: "move" as const, path: "references", nextPath: "notes" },
      { kind: "move" as const, path: "notes", nextPath: "docs/notes" },
    ];
    expect(skillDirectoryOrigin("docs/notes/nested", operations)).toBe("references/nested");
    const staged = skillDirectoryEntries(
      "docs/notes",
      [
        { path: "references/guide.md", size: 20 },
        { path: "references/nested", kind: "directory", size: 0 },
      ],
      operations,
      [{ id: "docs/notes/local.md", kind: "file" }],
    );
    expect(staged.entries).toEqual([
      { id: "docs/notes/guide.md", kind: "file" },
      { id: "docs/notes/nested", kind: "directory" },
      { id: "docs/notes/local.md", kind: "file" },
    ]);
    expect(staged.origins.get("docs/notes/guide.md")).toBe("references/guide.md");
    expect(
      skillDirectoryOrigin("notes", [
        { kind: "create-directory", path: "draft" },
        { kind: "move", path: "draft", nextPath: "notes" },
      ]),
    ).toBeUndefined();
    expect(
      skillDirectoryEntries(
        "references",
        [{ path: "references/deleted.md", size: 1 }],
        [{ kind: "delete", path: "references/deleted.md" }],
        [],
      ).entries,
    ).toEqual([]);
  });

  it("moves knowledge frontmatter out of preview and places metadata after rename", () => {
    const value = "---\ntitle: Metadata-only title\ntags: [CDN]\n---\n# Reading body";
    const editor = { ...props.editor, value };
    const html = renderToStaticMarkup(
      <AssetFileWorkspace
        {...props}
        editor={editor}
        extractFrontmatter
        operations={{ ...operations, canModifyEntry: () => true }}
      />,
    );
    expect(html).toContain("Reading body");
    expect(html).not.toContain("Metadata-only title");
    expect(html).toContain('aria-label="Metadata"');
    expect(html.indexOf('aria-label="Rename"')).toBeLessThan(html.indexOf('aria-label="Metadata"'));
    expect(html.indexOf('aria-label="Metadata"')).toBeLessThan(html.indexOf('aria-label="Delete"'));
    const editing = renderToStaticMarkup(
      <AssetFileWorkspace {...props} editor={{ ...editor, preview: false }} extractFrontmatter />,
    );
    expect(editing).toContain("title: Metadata-only title");
    expect(editing).toContain("<textarea");
  });

  it("omits the metadata action when there are no fields and leaves other asset previews intact", () => {
    const html = renderToStaticMarkup(<AssetFileWorkspace {...props} extractFrontmatter />);
    expect(html).not.toContain('aria-label="Metadata"');
    const value = "---\ntitle: Visible Skill example\n---\n# Body";
    const skill = renderToStaticMarkup(
      <AssetFileWorkspace {...props} editor={{ ...props.editor, value }} />,
    );
    expect(skill).toContain("Visible Skill example");
    expect(skill).not.toContain('aria-label="Metadata"');
  });

  it("exposes complete file operations while protecting the Skill entry document", () => {
    const html = renderToStaticMarkup(<AssetFileWorkspace {...props} operations={operations} />);
    expect(html).toContain('aria-label="New file"');
    expect(html).toContain('aria-label="New folder"');
    expect(html).toContain('aria-label="Refresh"');
    expect(html).toContain('aria-label="Rename “checklist.md”"');
    expect(html).not.toContain('aria-label="Rename “SKILL.md”"');
    expect(html).not.toContain('aria-label="Delete"');
    expect(html).toContain('draggable="false"');
    expect(html).toContain('draggable="true"');
  });

  it("offers the same rename and delete actions for selected files and folders", () => {
    for (const selectedEntry of entries.slice(1)) {
      const html = renderToStaticMarkup(
        <AssetFileWorkspace
          {...props}
          operations={operations}
          selectedEntry={selectedEntry}
          editor={
            selectedEntry.kind === "directory" ? null : { ...props.editor, path: selectedEntry.id }
          }
        />,
      );
      expect(html.includes(">Rename</button>") || html.includes('aria-label="Rename"')).toBe(true);
      expect(html.includes(">Delete</button>") || html.includes('aria-label="Delete"')).toBe(true);
    }
  });

  it("keeps built-in browsing read-only and includes empty Skill directories", () => {
    const html = renderToStaticMarkup(
      <AssetFileWorkspace {...props} editor={{ ...props.editor, readOnly: true }} />,
    );
    for (const action of ["New file", "New folder", "Rename", "Delete", "Edit"])
      expect(html).not.toContain(`aria-label="${action}"`);
    expect(html).toContain('aria-label="Refresh"');
    expect(
      skillDirectoryEntries(
        "",
        [
          { path: "empty", kind: "directory", size: 0 },
          { path: "references", kind: "directory", size: 0 },
        ],
        [],
        [],
      ).entries,
    ).toEqual([
      { id: "empty", kind: "directory" },
      { id: "references", kind: "directory" },
    ]);
  });

  it("blocks file selection, dragging and rename while an adapter is saving", () => {
    const html = renderToStaticMarkup(
      <AssetFileWorkspace {...props} operations={operations} disabled />,
    );
    expect(html).not.toContain('draggable="true"');
    expect(html).toMatch(/role="treeitem"[^>]*disabled=""/u);
    expect(html).toMatch(/aria-label="Rename “checklist.md”"[^>]*disabled=""/u);
  });
});
