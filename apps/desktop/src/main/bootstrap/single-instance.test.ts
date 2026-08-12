import { describe, expect, it, vi } from "vitest";

import { enforceDesktopSingleInstance } from "./single-instance.ts";

describe("Desktop single-instance ownership", () => {
  it("quits before startup when another Desktop instance owns the application", () => {
    const quit = vi.fn();
    const on = vi.fn();

    expect(
      enforceDesktopSingleInstance(
        { requestSingleInstanceLock: () => false, quit, on },
        () => null,
      ),
    ).toBe(false);
    expect(quit).toHaveBeenCalledOnce();
    expect(on).not.toHaveBeenCalled();
  });

  it("focuses the owning window when another launch is attempted", () => {
    let secondInstance: (() => void) | undefined;
    const window = {
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };

    expect(
      enforceDesktopSingleInstance(
        {
          requestSingleInstanceLock: () => true,
          quit: vi.fn(),
          on: (_event, listener) => {
            secondInstance = listener;
          },
        },
        () => window,
      ),
    ).toBe(true);

    secondInstance?.();
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });
});
