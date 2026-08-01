import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConfirmationDialog, Dialog } from "./Dialog.tsx";

describe("Dialog", () => {
  it("associates its title and description with the modal surface", () => {
    const html = renderToStaticMarkup(
      <Dialog
        title="Configure"
        description="Update the current configuration."
        onCancel={() => undefined}
      >
        <input aria-label="Name" />
      </Dialog>,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/aria-labelledby="([^"]+)"/);
    expect(html).toContain("Update the current configuration.");
  });

  it("uses a restrained alert dialog for destructive confirmation", () => {
    const html = renderToStaticMarkup(
      <ConfirmationDialog
        title="Delete provider"
        description="This provider will be removed."
        cancelLabel="Cancel"
        confirmLabel="Delete"
        busyLabel="Deleting…"
        busy={false}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );

    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('class="danger-button"');
    expect(html).toContain("Delete provider");
  });
});
