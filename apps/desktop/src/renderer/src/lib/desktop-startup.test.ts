import { describe, expect, it } from "vitest";

import { resolveDesktopStartup } from "./desktop-startup.ts";

describe("resolveDesktopStartup", () => {
  it("reports a missing preload bridge using the system locale", async () => {
    await expect(resolveDesktopStartup(undefined, ["zh-TW"])).resolves.toEqual({
      locale: "zh-Hant",
      errorCode: "DESKTOP_BRIDGE_UNAVAILABLE",
    });
  });

  it("uses the locale stored by Desktop settings", async () => {
    await expect(
      resolveDesktopStartup(
        {
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
});
