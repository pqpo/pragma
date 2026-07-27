import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveDesktopLocale } from "../../../shared/desktop-locale.ts";
import { createDesktopSettingsStore } from "./desktop-settings-store.ts";

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
    const store = createStore(settingsPath);

    await expect(store.getSnapshot(["zh-TW"])).resolves.toEqual({
      schemaVersion: 1,
      localePreference: "system",
      toolPermissionMode: "request-approval",
      defaultWorkspace: "/default/workspace",
      usesBuiltInDefaultWorkspace: true,
      resolvedLocale: "zh-Hant",
    });
  });

  it("persists an explicit locale atomically", async () => {
    const settingsPath = await temporarySettingsPath();
    const store = createStore(settingsPath);

    await expect(store.update({ localePreference: "zh-Hans" }, ["en-US"])).resolves.toEqual({
      schemaVersion: 1,
      localePreference: "zh-Hans",
      toolPermissionMode: "request-approval",
      defaultWorkspace: "/default/workspace",
      usesBuiltInDefaultWorkspace: true,
      resolvedLocale: "zh-Hans",
    });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      schemaVersion: 1,
      localePreference: "zh-Hans",
      toolPermissionMode: "request-approval",
    });
  });

  it("persists a custom default workspace without overwriting the locale", async () => {
    const settingsPath = await temporarySettingsPath();
    const store = createStore(settingsPath);
    await store.update({ localePreference: "zh-Hant" }, ["en-US"]);

    await expect(store.update({ defaultWorkspace: "/work/project" }, ["en-US"])).resolves.toEqual({
      schemaVersion: 1,
      localePreference: "zh-Hant",
      toolPermissionMode: "request-approval",
      defaultWorkspace: "/work/project",
      usesBuiltInDefaultWorkspace: false,
      resolvedLocale: "zh-Hant",
    });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      schemaVersion: 1,
      localePreference: "zh-Hant",
      toolPermissionMode: "request-approval",
      defaultWorkspace: "/work/project",
    });
  });

  it("restores the built-in default workspace", async () => {
    const settingsPath = await temporarySettingsPath();
    const store = createStore(settingsPath);
    await store.update({ defaultWorkspace: "/work/project" }, ["en-US"]);

    await expect(store.update({ defaultWorkspace: null }, ["en-US"])).resolves.toMatchObject({
      defaultWorkspace: "/default/workspace",
      usesBuiltInDefaultWorkspace: true,
    });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      schemaVersion: 1,
      localePreference: "system",
      toolPermissionMode: "request-approval",
    });
  });

  it("persists the Desktop tool permission mode", async () => {
    const settingsPath = await temporarySettingsPath();
    const store = createStore(settingsPath);

    await expect(
      store.update({ toolPermissionMode: "auto-approve" }, ["en-US"]),
    ).resolves.toMatchObject({
      toolPermissionMode: "auto-approve",
    });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
      toolPermissionMode: "auto-approve",
    });
  });

  it("warns and follows the system when the stored file is invalid", async () => {
    const settingsPath = await temporarySettingsPath();
    await mkdir(join(settingsPath, ".."), { recursive: true });
    await writeFile(settingsPath, "not json");
    const warn = vi.fn();
    const store = createStore(settingsPath, warn);

    await expect(store.getSnapshot(["zh-CN"])).resolves.toMatchObject({
      localePreference: "system",
      resolvedLocale: "zh-Hans",
    });
    expect(warn).toHaveBeenCalledOnce();
  });
});

function createStore(settingsPath: string, warn?: (message: string, error: unknown) => void) {
  return createDesktopSettingsStore({
    settingsPath,
    builtInDefaultWorkspace: "/default/workspace",
    ...(warn === undefined ? {} : { warn }),
  });
}

async function temporarySettingsPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pragma-desktop-settings-"));
  temporaryDirectories.push(directory);
  return join(directory, "state", "desktop-settings.json");
}
