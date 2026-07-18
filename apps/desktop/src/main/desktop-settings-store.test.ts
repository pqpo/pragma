import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDesktopSettingsStore, resolveDesktopLocale } from "./desktop-settings-store.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("resolveDesktopLocale", () => {
  it.each([
    [["en-US"], "en"],
    [["zh"], "zh-Hans"],
    [["zh-Hans-CN"], "zh-Hans"],
    [["zh-Hans-TW"], "zh-Hans"],
    [["zh-CN"], "zh-Hans"],
    [["zh-SG"], "zh-Hans"],
    [["zh-Hant"], "zh-Hant"],
    [["zh-Hant-CN"], "zh-Hant"],
    [["zh-TW"], "zh-Hant"],
    [["zh-HK"], "zh-Hant"],
    [["fr-FR", "zh-MO"], "zh-Hant"],
    [["fr-FR", "en-GB"], "en"],
    [["fr-FR"], "en"],
    [["not_a_locale_!"], "en"],
  ] as const)("maps %j to %s", (preferred, expected) => {
    expect(resolveDesktopLocale(preferred)).toBe(expected);
  });
});

describe("desktop settings store", () => {
  it("follows the system when no preference has been saved", async () => {
    const settingsPath = await temporarySettingsPath();
    const store = createDesktopSettingsStore({ settingsPath });

    await expect(store.getSnapshot(["zh-TW"])).resolves.toEqual({
      schemaVersion: 1,
      localePreference: "system",
      resolvedLocale: "zh-Hant",
    });
  });

  it("persists an explicit locale atomically", async () => {
    const settingsPath = await temporarySettingsPath();
    const store = createDesktopSettingsStore({ settingsPath });

    await expect(store.update({ localePreference: "zh-Hans" }, ["en-US"])).resolves.toEqual({
      schemaVersion: 1,
      localePreference: "zh-Hans",
      resolvedLocale: "zh-Hans",
    });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      schemaVersion: 1,
      localePreference: "zh-Hans",
    });
  });

  it("warns and follows the system when the stored file is invalid", async () => {
    const settingsPath = await temporarySettingsPath();
    await mkdir(join(settingsPath, ".."), { recursive: true });
    await writeFile(settingsPath, "not json");
    const warn = vi.fn();
    const store = createDesktopSettingsStore({ settingsPath, warn });

    await expect(store.getSnapshot(["zh-CN"])).resolves.toMatchObject({
      localePreference: "system",
      resolvedLocale: "zh-Hans",
    });
    expect(warn).toHaveBeenCalledOnce();
  });
});

async function temporarySettingsPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pragma-desktop-settings-"));
  temporaryDirectories.push(directory);
  return join(directory, "state", "desktop-settings.json");
}
