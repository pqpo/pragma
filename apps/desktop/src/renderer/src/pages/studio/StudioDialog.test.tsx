import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StudioConfirmationDialog, StudioTextInputDialog } from "./StudioDialog.tsx";

describe("Studio dialogs", () => {
  it("requires a second explicit destructive action", () => {
    const html = renderToStaticMarkup(
      <StudioConfirmationDialog
        title="Delete this Expert?"
        description="This cannot be undone."
        cancelLabel="Cancel"
        confirmLabel="Delete Expert"
        busyLabel="Deleting…"
        busy={false}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Cancel");
    expect(html).toContain("Delete Expert");
  });

  it("renders a keyboard-submittable platform text input", () => {
    const html = renderToStaticMarkup(
      <StudioTextInputDialog
        title="Create file"
        description="Choose a Markdown file name."
        label="File name"
        value="notes.md"
        cancelLabel="Cancel"
        confirmLabel="Create"
        busyLabel="Creating…"
        busy={false}
        onChange={() => undefined}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('value="notes.md"');
    expect(html).toContain('type="submit"');
  });
});
