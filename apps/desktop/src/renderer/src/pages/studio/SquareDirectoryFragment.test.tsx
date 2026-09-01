import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SquareDirectoryFragment } from "./SquareDirectoryFragment.tsx";

describe("SquareDirectoryFragment", () => {
  it("renders the three fixed source kinds and honest sorting options", () => {
    const html = renderToStaticMarkup(<SquareDirectoryFragment onInstall={() => undefined} />);

    expect(html).toContain('role="tablist"');
    expect(html).toContain("Experts");
    expect(html).toContain("Expert teams");
    expect(html).toContain("Flows");
    expect(html).toContain("Latest");
    expect(html).toContain("Name");
    expect(html).not.toContain("Hottest");
  });
});
