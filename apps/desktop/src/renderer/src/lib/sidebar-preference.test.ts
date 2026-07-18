import { describe, expect, it, vi } from "vitest";

import { readSidebarCollapsed, writeSidebarCollapsed } from "./sidebar-preference.ts";

describe("sidebar preference", () => {
  it("restores a persisted collapsed state", () => {
    expect(readSidebarCollapsed({ getItem: () => "true" })).toBe(true);
    expect(readSidebarCollapsed({ getItem: () => "false" })).toBe(false);
    expect(readSidebarCollapsed({ getItem: () => null })).toBe(false);
  });

  it("persists the current collapsed state", () => {
    const setItem = vi.fn();

    writeSidebarCollapsed({ setItem }, true);
    writeSidebarCollapsed({ setItem }, false);

    expect(setItem).toHaveBeenNthCalledWith(1, "pragma.desktop.sidebar.collapsed", "true");
    expect(setItem).toHaveBeenNthCalledWith(2, "pragma.desktop.sidebar.collapsed", "false");
  });

  it("falls back safely when storage is unavailable", () => {
    expect(
      readSidebarCollapsed({
        getItem: () => {
          throw new Error("storage unavailable");
        },
      }),
    ).toBe(false);

    expect(() =>
      writeSidebarCollapsed(
        {
          setItem: () => {
            throw new Error("storage unavailable");
          },
        },
        true,
      ),
    ).not.toThrow();
  });
});
