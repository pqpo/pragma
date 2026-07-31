import { describe, expect, it, vi } from "vitest";

import { startDesktopWindowWithServices } from "./startup-sequence.ts";

describe("startDesktopWindowWithServices", () => {
  it("starts background work only after the window has loaded", async () => {
    const events: string[] = [];
    const container = {
      startBackgroundTasks: vi.fn(() => events.push("background")),
    };

    await expect(
      startDesktopWindowWithServices({
        createContainer: async () => {
          events.push("container");
          return container;
        },
        createWindow: async () => {
          events.push("window");
        },
        onContainerReady: () => events.push("ready"),
        onContainerError: vi.fn(),
      }),
    ).resolves.toBe(container);

    expect(events).toEqual(["container", "ready", "window", "background"]);
    expect(container.startBackgroundTasks).toHaveBeenCalledOnce();
  });

  it("opens the diagnostic window when service initialization fails", async () => {
    const failure = new Error("storage unavailable");
    const events: string[] = [];
    const onContainerError = vi.fn(() => events.push("error"));

    await expect(
      startDesktopWindowWithServices({
        createContainer: async () => {
          events.push("container");
          throw failure;
        },
        createWindow: async () => {
          events.push("window");
        },
        onContainerError,
      }),
    ).resolves.toBeUndefined();

    expect(events).toEqual(["container", "error", "window"]);
    expect(onContainerError).toHaveBeenCalledWith(failure);
  });

  it("keeps window creation failure fatal", async () => {
    const failure = new Error("renderer missing");
    const startBackgroundTasks = vi.fn();

    await expect(
      startDesktopWindowWithServices({
        createContainer: async () => ({ startBackgroundTasks }),
        createWindow: async () => {
          throw failure;
        },
        onContainerError: vi.fn(),
      }),
    ).rejects.toBe(failure);

    expect(startBackgroundTasks).not.toHaveBeenCalled();
  });
});
