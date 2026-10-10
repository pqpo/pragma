import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MissionWorkspaceStatus } from "./mission-workspace-status.tsx";

describe("Mission workspace status", () => {
  it("provides a keyboard-accessible tooltip across the unavailable workspace region", () => {
    const html = renderToStaticMarkup(
      <MissionWorkspaceStatus name="workspace" available={false} />,
    );
    expect(html).toContain('role="tooltip"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("aria-describedby=");
    expect(html).toContain("is-unavailable");
    expect(html).not.toContain(" title=");
  });
  it("keeps available and unchecked workspaces free of an error indicator", () => {
    for (const available of [true, null, undefined]) {
      const html = renderToStaticMarkup(
        <MissionWorkspaceStatus name="workspace" available={available} />,
      );
      expect(html).not.toContain('role="tooltip"');
      expect(html).not.toContain("is-unavailable");
      expect(html).not.toContain('tabindex="0"');
    }
  });
});
