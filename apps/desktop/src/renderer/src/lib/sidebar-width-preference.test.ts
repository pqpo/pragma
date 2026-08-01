import { describe, expect, it, vi } from "vitest";

import {
  clampSidebarWidth,
  readSidebarWidth,
  SIDEBAR_WIDTH_PREFERENCES,
  writeSidebarWidth,
} from "./sidebar-width-preference.ts";

describe("sidebar width preference", () => {
  const preference = SIDEBAR_WIDTH_PREFERENCES.studio;

  it("clamps restored and requested widths to the supported range", () => {
    expect(clampSidebarWidth(199, preference)).toBe(200);
    expect(clampSidebarWidth(318.6, preference)).toBe(319);
    expect(clampSidebarWidth(421, preference)).toBe(420);
    expect(clampSidebarWidth(Number.NaN, preference)).toBe(242);
  });

  it("restores valid persisted widths and safely handles invalid storage", () => {
    expect(readSidebarWidth({ getItem: () => "318" }, preference)).toBe(318);
    expect(readSidebarWidth({ getItem: () => "999" }, preference)).toBe(420);
    expect(readSidebarWidth({ getItem: () => "invalid" }, preference)).toBe(242);
    expect(readSidebarWidth({ getItem: () => null }, preference)).toBe(242);
    expect(
      readSidebarWidth(
        {
          getItem: () => {
            throw new Error("storage unavailable");
          },
        },
        preference,
      ),
    ).toBe(242);
  });

  it("persists the clamped width under the page-specific key", () => {
    const setItem = vi.fn();

    writeSidebarWidth({ setItem }, 500, preference);

    expect(setItem).toHaveBeenCalledWith("pragma.desktop.sidebar.width.studio", "420");
  });

  it("keeps the knowledge-base file list within its compact editor bounds", () => {
    const fileList = SIDEBAR_WIDTH_PREFERENCES.knowledgeBaseFiles;
    const setItem = vi.fn();

    expect(clampSidebarWidth(120, fileList)).toBe(180);
    expect(clampSidebarWidth(280, fileList)).toBe(280);
    expect(clampSidebarWidth(500, fileList)).toBe(360);
    expect(readSidebarWidth({ getItem: () => "312" }, fileList)).toBe(312);
    writeSidebarWidth({ setItem }, 312, fileList);
    expect(setItem).toHaveBeenCalledWith(
      "pragma.desktop.sidebar.width.knowledge-base-files",
      "312",
    );
  });
});
