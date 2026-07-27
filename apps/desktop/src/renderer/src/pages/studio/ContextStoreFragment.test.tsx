import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ContextStore } from "../../../../shared/desktop-api.ts";
import {
  canMoveEntryTo,
  ContextStoreCreatorDrawer,
  ContextStoreDetailFragment,
  ContextStoreDirectoryFragment,
  moveEntryTargetId,
  rebaseEntryId,
} from "./ContextStoreFragment.tsx";

const store: ContextStore = {
  schemaVersion: "pragma.context-store/v2",
  id: "00000000-0000-4000-8000-000000000001",
  name: "Product docs",
  description: "Managed product knowledge.",
  type: "file",
  status: "ready",
  source: { origin: "copied" },
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
};

describe("knowledge base UI", () => {
  it("presents a single managed Markdown knowledge-base model", () => {
    const html = renderToStaticMarkup(
      <ContextStoreDirectoryFragment
        stores={[store]}
        onCreate={async () => store}
        onInspectImport={async (sourcePath) => ({
          sourcePath,
          markdownFiles: 1,
          ignoredFiles: 0,
          totalBytes: 10,
        })}
        onPickFolder={async () => undefined}
        onOpen={() => undefined}
      />,
    );

    expect(html).toContain("Knowledge bases");
    expect(html).toContain("Markdown");
    expect(html).toContain("Copied into Pragma");
    expect(html).not.toContain("Context note");
    expect(html).not.toContain("/Users/");
  });

  it("explains managed storage before configuration", () => {
    const html = renderToStaticMarkup(
      <ContextStoreCreatorDrawer
        onClose={() => undefined}
        onCreate={async () => store}
        onInspectImport={async (sourcePath) => ({
          sourcePath,
          markdownFiles: 1,
          ignoredFiles: 0,
          totalBytes: 10,
        })}
        onCreated={() => undefined}
        onPickFolder={async () => undefined}
      />,
    );

    expect(html).toContain("Markdown knowledge base");
    expect(html).toContain("Pragma-managed storage");
    expect(html).not.toContain("Link");
    expect(html).not.toContain("destination");
  });

  it("renders the file manager, editor, and loading settings as one screen", () => {
    const html = renderToStaticMarkup(
      <ContextStoreDetailFragment
        store={store}
        onBack={() => undefined}
        onDelete={async () => undefined}
        onListEntries={async () => []}
        onGetContent={async () => {
          throw new Error("not selected");
        }}
        onCreateFile={async () => {
          throw new Error("not created");
        }}
        onCreateFolder={async () => undefined}
        onUpdateFile={async () => {
          throw new Error("not updated");
        }}
        onRenameEntry={async () => undefined}
        onDeleteEntry={async () => undefined}
        onSubscribe={() => () => undefined}
      />,
    );

    expect(html).toContain("Knowledge base files");
    expect(html).toContain("Loading settings");
    expect(html).toContain("Select a Markdown file");
  });

  it("moves entries only to valid directories and preserves descendant paths", () => {
    expect(moveEntryTargetId("guides/setup.md", "archive")).toBe("archive/setup.md");
    expect(canMoveEntryTo({ id: "guides", kind: "directory" }, "guides/drafts")).toBe(false);
    expect(canMoveEntryTo({ id: "guides/setup.md", kind: "file" }, "guides")).toBe(false);
    expect(canMoveEntryTo({ id: "guides/setup.md", kind: "file" }, "archive")).toBe(true);
    expect(rebaseEntryId("guides/setup.md", "guides", "archive/guides")).toBe(
      "archive/guides/setup.md",
    );
    expect(rebaseEntryId("reference/api.md", "guides", "archive/guides")).toBeUndefined();
  });
});
