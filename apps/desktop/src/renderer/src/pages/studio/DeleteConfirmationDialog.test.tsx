import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DeleteConfirmationDialog } from "./DeleteConfirmationDialog.tsx";

describe("DeleteConfirmationDialog", () => {
  it("requires a second explicit destructive action", () => {
    const html = renderToStaticMarkup(
      <DeleteConfirmationDialog
        title="Delete this Expert?"
        description="This cannot be undone."
        cancelLabel="Cancel"
        confirmLabel="Delete Expert"
        deletingLabel="Deleting…"
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
});
