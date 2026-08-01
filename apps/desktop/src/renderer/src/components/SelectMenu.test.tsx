import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SelectMenu } from "./SelectMenu.tsx";

describe("SelectMenu", () => {
  it("keeps the selected value and complete option semantics in the closed state", () => {
    const html = renderToStaticMarkup(
      <SelectMenu
        ariaLabel="Runtime"
        value="codex"
        options={[
          { value: "codex", label: "Codex", description: "Ready" },
          { value: "missing", label: "Unavailable", disabled: true },
        ]}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("Ready");
    expect(html).toContain('disabled=""');
  });

  it("renders the shared searchable menu shell", () => {
    const html = renderToStaticMarkup(
      <SelectMenu
        ariaLabel="Model"
        searchable
        searchPlaceholder="Search models"
        emptyLabel="No models"
        value=""
        options={[{ value: "", label: "Default" }]}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('type="search"');
    expect(html).toContain('placeholder="Search models"');
  });

  it("marks a portaled listbox with its owning overlay", () => {
    const html = renderToStaticMarkup(
      <SelectMenu
        ariaLabel="Type"
        overlayOwnerId="executor-picker"
        value="all"
        options={[{ value: "all", label: "All types" }]}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('data-ui-overlay-owner="executor-picker"');
  });
});
