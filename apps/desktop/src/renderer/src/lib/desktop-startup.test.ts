import { describe, expect, it, vi } from "vitest";

import { resolveDesktopStartup } from "./desktop-startup.ts";

const currentBridgeSnapshot = {
  startup: { status: "ready" },
  interpreter: {
    writeVersion: "pragma.dsl/v5",
    directReadVersions: ["pragma.dsl/v5"],
    upgradeFromVersions: ["pragma.dsl/v2", "pragma.dsl/v3", "pragma.dsl/v4"],
  },
} as const;

describe("resolveDesktopStartup", () => {
  it("reports a missing preload bridge using the system locale", async () => {
    await expect(resolveDesktopStartup(undefined, ["zh-TW"])).resolves.toEqual({
      locale: "zh-Hant",
      errorCode: "DESKTOP_BRIDGE_UNAVAILABLE",
    });
  });

  it("reports an older preload bridge as a component version mismatch", async () => {
    await expect(
      resolveDesktopStartup(
        {
          getDesktopSettings: async () => ({ resolvedLocale: "en" }),
        },
        ["zh-CN"],
      ),
    ).resolves.toEqual({
      locale: "zh-Hans",
      errorCode: "DESKTOP_COMPONENT_VERSION_MISMATCH",
    });
  });

  it("uses the locale stored by Desktop settings", async () => {
    await expect(
      resolveDesktopStartup(
        {
          getBridgeSnapshot: async () => currentBridgeSnapshot,
          getDesktopSettings: async () => ({ resolvedLocale: "zh-Hans" }),
        },
        ["en-US"],
      ),
    ).resolves.toEqual({ locale: "zh-Hans" });
  });

  it("keeps starting with the system locale when settings cannot be read", async () => {
    const settingsError = new Error("settings unavailable");

    await expect(
      resolveDesktopStartup(
        {
          getBridgeSnapshot: async () => currentBridgeSnapshot,
          getDesktopSettings: async () => {
            throw settingsError;
          },
        },
        ["zh-HK"],
      ),
    ).resolves.toEqual({
      locale: "zh-Hant",
      settingsError,
    });
  });

  it("blocks startup when the main and preload Interpreter capabilities differ", async () => {
    await expect(
      resolveDesktopStartup(
        {
          getBridgeSnapshot: async () => ({
            startup: { status: "ready" },
            interpreter: {
              writeVersion: "pragma.dsl/v2",
              directReadVersions: ["pragma.dsl/v2"],
              upgradeFromVersions: [],
            },
          }),
          getDesktopSettings: async () => ({ resolvedLocale: "en" }),
        },
        ["zh-CN"],
      ),
    ).resolves.toEqual({
      locale: "zh-Hans",
      errorCode: "DESKTOP_COMPONENT_VERSION_MISMATCH",
    });
  });

  it("compares Interpreter readable versions without delimiter collisions", async () => {
    await expect(
      resolveDesktopStartup(
        {
          getBridgeSnapshot: async () => ({
            startup: { status: "ready" },
            interpreter: {
              writeVersion: "pragma.dsl/v5",
              directReadVersions: ["pragma.dsl/v3\u0000pragma.dsl/v5"],
              upgradeFromVersions: ["pragma.dsl/v2", "pragma.dsl/v3", "pragma.dsl/v4"],
            },
          }),
          getDesktopSettings: async () => ({ resolvedLocale: "en" }),
        },
        ["en-US"],
      ),
    ).resolves.toEqual({
      locale: "en",
      errorCode: "DESKTOP_COMPONENT_VERSION_MISMATCH",
    });
  });

  it("reports bridge snapshot failures as unavailable instead of a version mismatch", async () => {
    await expect(
      resolveDesktopStartup(
        {
          getBridgeSnapshot: async () => {
            throw new Error("IPC unavailable");
          },
          getDesktopSettings: async () => ({ resolvedLocale: "en" }),
        },
        ["zh-HK"],
      ),
    ).resolves.toEqual({
      locale: "zh-Hant",
      errorCode: "DESKTOP_BRIDGE_UNAVAILABLE",
    });
  });

  it("reports main-process initialization failure before loading settings", async () => {
    const getDesktopSettings = vi.fn(async () => ({ resolvedLocale: "en" as const }));

    await expect(
      resolveDesktopStartup(
        {
          getBridgeSnapshot: async () => ({
            startup: {
              status: "failed",
              code: "DESKTOP_MAIN_INITIALIZATION_FAILED",
            },
            interpreter: currentBridgeSnapshot.interpreter,
          }),
          getDesktopSettings,
        },
        ["zh-CN"],
      ),
    ).resolves.toEqual({
      locale: "zh-Hans",
      errorCode: "DESKTOP_MAIN_INITIALIZATION_FAILED",
    });
    expect(getDesktopSettings).not.toHaveBeenCalled();
  });
});
