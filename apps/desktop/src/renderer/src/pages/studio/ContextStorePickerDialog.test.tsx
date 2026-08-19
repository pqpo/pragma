import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import type { ContextStore } from "../../../../shared/contracts/index.ts";
import { i18n } from "../../i18n/index.ts";
import { ContextStorePickerDialog } from "../../components/ContextStorePickerDialog.tsx";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("ContextStorePickerDialog", () => {
  it("renders the shared searchable knowledge-base picker with selected state", () => {
    const store: ContextStore = {
      schemaVersion: "pragma.context-store/v4",
      id: "00000000-0000-4000-8000-000000000001",
      name: "Quality handbook",
      description: "Shared review guidance.",
      type: "file",
      status: "ready",
      source: { origin: "created" },
      contentRevision: 1,
      snapshotHash: "0".repeat(64),
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    };

    const html = renderToStaticMarkup(
      <ContextStorePickerDialog
        stores={[store]}
        selectedStoreIds={[store.id]}
        description="Choose knowledge."
        footerHint="Selections update the form."
        onSelectedStoreIdsChange={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('placeholder="Search context stores"');
    expect(html).toContain("Quality handbook");
    expect(html).toContain("Shared review guidance.");
    expect(html).toContain("expert-picker-row is-selected");
    expect(html).toContain("1 selected");
  });

  it("shows the first 20 knowledge bases before loading more", () => {
    const stores = Array.from({ length: 21 }, (_, index) => ({
      schemaVersion: "pragma.context-store/v4" as const,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `Knowledge ${index}`,
      description: "Shared guidance.",
      type: "file" as const,
      status: "ready" as const,
      source: { origin: "created" as const },
      contentRevision: 1,
      snapshotHash: "0".repeat(64),
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    })) satisfies readonly ContextStore[];

    const html = renderToStaticMarkup(
      <ContextStorePickerDialog
        stores={stores}
        selectedStoreIds={[]}
        description="Choose knowledge."
        footerHint="Selections update the form."
        onSelectedStoreIdsChange={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("Knowledge 19");
    expect(html).not.toContain("Knowledge 20");
    expect(html).toContain("expert-tool-load-more");
  });
});
