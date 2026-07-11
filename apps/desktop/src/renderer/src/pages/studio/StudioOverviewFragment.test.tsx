import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ContextStore } from "../../../../shared/desktop-api.ts";
import { StudioOverviewFragment } from "./StudioOverviewFragment.tsx";

describe("StudioOverviewFragment", () => {
  it("includes context stores in the resource overview", () => {
    const contextStores: readonly ContextStore[] = [
      {
        schemaVersion: "pragma.context-store/v1",
        id: "product-context",
        name: "Product context",
        description: "Shared product decisions and terminology.",
        type: "note",
        status: "ready",
        entries: [],
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z",
      },
    ];

    const html = renderToStaticMarkup(
      <StudioOverviewFragment
        experts={[]}
        capabilities={[]}
        contextStores={contextStores}
        onNavigate={() => undefined}
      />,
    );

    expect(html).toContain("Context stores");
    expect(html).toContain("Reusable knowledge sources mounted by experts.");
    expect(html).toContain("Product context");
    expect(html).toContain("Shared product decisions and terminology.");
    expect(html).toContain('title="Shared product decisions and terminology."');
    expect(html.match(/>View all</g)?.length).toBe(4);
  });
});
