import { describe, expect, it } from "vitest";

import { resolveDesktopStartup } from "./desktop-startup.ts";

const currentBridgeSnapshot = {
  interpreter: {
    writeVersion: "pragma.dsl/v3",
    readVersions: ["pragma.dsl/v2", "pragma.dsl/v3"],
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
            interpreter: {
              writeVersion: "pragma.dsl/v2",
              readVersions: ["pragma.dsl/v2"],
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
            interpreter: {
              writeVersion: "pragma.dsl/v3",
              readVersions: ["pragma.dsl/v2\u0000pragma.dsl/v3"],
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
});
