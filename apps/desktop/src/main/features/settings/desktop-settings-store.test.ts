import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveDesktopLocale } from "../../../shared/desktop-locale.ts";
import {
  createDesktopSettingsStore,
  DESKTOP_SETTINGS_MIGRATION_ERROR_CODES,
} from "./desktop-settings-store.ts";

const temporaryDirectories: string[] = [];
const desktopSettingsV1Fixture = new URL("./fixtures/desktop-settings-v1.json", import.meta.url);

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
      schemaVersion: 3,
      agentContextWindow: 258_000,
      localePreference: "system",
      defaultWorkspace: "/default/workspace",
      usesBuiltInDefaultWorkspace: true,
      resolvedLocale: "zh-Hant",
    });
  });

  it("persists an explicit locale atomically", async () => {
    const settingsPath = await temporarySettingsPath();
    const store = createStore(settingsPath);

    await expect(store.update({ localePreference: "zh-Hans" }, ["en-US"])).resolves.toEqual({
      schemaVersion: 3,
      localePreference: "zh-Hans",
      agentContextWindow: 258_000,
      defaultWorkspace: "/default/workspace",
      usesBuiltInDefaultWorkspace: true,
      resolvedLocale: "zh-Hans",
    });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      schemaVersion: 3,
      localePreference: "zh-Hans",
      agentContextWindow: 258_000,
    });
  });

  it("persists a custom default workspace without overwriting the locale", async () => {
    const settingsPath = await temporarySettingsPath();
    const store = createStore(settingsPath);
    await store.update({ localePreference: "zh-Hant" }, ["en-US"]);

    await expect(store.update({ defaultWorkspace: "/work/project" }, ["en-US"])).resolves.toEqual({
      schemaVersion: 3,
      localePreference: "zh-Hant",
      agentContextWindow: 258_000,
      defaultWorkspace: "/work/project",
      usesBuiltInDefaultWorkspace: false,
      resolvedLocale: "zh-Hant",
    });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      schemaVersion: 3,
      localePreference: "zh-Hant",
      agentContextWindow: 258_000,
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
      schemaVersion: 3,
      localePreference: "system",
      agentContextWindow: 258_000,
    });
  });

  it("stores settings without a global tool permission mode", async () => {
    const settingsPath = await temporarySettingsPath();
    const store = createStore(settingsPath);

    await expect(
      store.update({ agentContextWindow: 258_000 }, ["en-US"]),
    ).resolves.not.toHaveProperty("toolPermissionMode");
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).not.toHaveProperty(
      "toolPermissionMode",
    );
  });

  it("updates the global Pi Agent context window", async () => {
    const settingsPath = await temporarySettingsPath();
    const store = createStore(settingsPath);

    await expect(store.update({ agentContextWindow: 320_000 }, ["en-US"])).resolves.toMatchObject({
      schemaVersion: 3,
      agentContextWindow: 320_000,
    });
    await expect(store.update({ agentContextWindow: 0 }, ["en-US"])).rejects.toThrow();
  });

  it("migrates the persisted v1 settings with the Agent context default and a backup", async () => {
    const settingsPath = await temporarySettingsPath();
    await mkdir(dirname(settingsPath), { recursive: true });
    await copyFile(desktopSettingsV1Fixture, settingsPath);
    const source = JSON.parse(await readFile(settingsPath, "utf8"));
    const store = createStore(settingsPath);

    await expect(store.getSnapshot(["en-US"])).resolves.toMatchObject({
      schemaVersion: 3,
      localePreference: "zh-Hant",
      agentContextWindow: 258_000,
    });
    await expect(readFile(settingsPath, "utf8").then(JSON.parse)).resolves.toMatchObject({
      schemaVersion: 3,
      agentContextWindow: 258_000,
    });
    const backupDirectory = join(dirname(settingsPath), "migrations", "backups");
    await expect(readdir(backupDirectory)).resolves.toHaveLength(1);
    const [backupFile] = await readdir(backupDirectory);
    await expect(
      readFile(join(backupDirectory, backupFile!), "utf8").then(JSON.parse),
    ).resolves.toEqual(source);
  });

  it("replays an interrupted Desktop settings migration journal", async () => {
    const settingsPath = await temporarySettingsPath();
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ schemaVersion: 1, localePreference: "system" }));
    await writeFile(
      join(dirname(settingsPath), "desktop-settings.migration.json"),
      JSON.stringify({
        schemaVersion: "pragma.state-migration/v1",
        resource: { family: "pragma.desktop-settings", id: "desktop-settings" },
        fromVersion: 1,
        toVersion: 2,
        documents: {
          "desktop-settings.json": {
            schemaVersion: 2,
            localePreference: "system",
            agentContextWindow: 258_000,
          },
        },
      }),
    );
    const store = createStore(settingsPath);

    await expect(store.getSnapshot(["en-US"])).resolves.toMatchObject({
      schemaVersion: 3,
      agentContextWindow: 258_000,
    });
    await expect(readFile(settingsPath, "utf8").then(JSON.parse)).resolves.toMatchObject({
      schemaVersion: 3,
      agentContextWindow: 258_000,
    });
  });

  it("reads current v3 settings without rewriting them", async () => {
    const settingsPath = await temporarySettingsPath();
    const current = {
      schemaVersion: 3,
      localePreference: "en",
      agentContextWindow: 320_000,
    };
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(current));

    await expect(createStore(settingsPath).getSnapshot(["zh-CN"])).resolves.toMatchObject({
      ...current,
      resolvedLocale: "en",
    });
    await expect(readFile(settingsPath, "utf8").then(JSON.parse)).resolves.toEqual(current);
  });

  it("fails closed and preserves current-version settings that do not validate", async () => {
    const settingsPath = await temporarySettingsPath();
    const corruptCurrent = {
      schemaVersion: 3,
      localePreference: "zh-Hant",
      // Simulates a truncated write or a v2 document created before this required field existed.
      defaultWorkspace: "/work/project",
    };
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(corruptCurrent));
    const store = createStore(settingsPath);

    await expect(store.getSnapshot(["en-US"])).rejects.toMatchObject({
      name: "DesktopSettingsMigrationError",
      code: DESKTOP_SETTINGS_MIGRATION_ERROR_CODES.invalidSettings,
      message: DESKTOP_SETTINGS_MIGRATION_ERROR_CODES.invalidSettings,
    });
    await expect(store.update({ localePreference: "en" }, ["en-US"])).rejects.toMatchObject({
      code: DESKTOP_SETTINGS_MIGRATION_ERROR_CODES.invalidSettings,
    });
    await expect(readFile(settingsPath, "utf8").then(JSON.parse)).resolves.toEqual(corruptCurrent);
  });

  it("rejects settings written by a future version", async () => {
    const settingsPath = await temporarySettingsPath();
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        schemaVersion: 999,
        localePreference: "system",
        agentContextWindow: 258_000,
      }),
    );

    await expect(createStore(settingsPath).getSnapshot(["en-US"])).rejects.toMatchObject({
      name: "DesktopSettingsMigrationError",
      code: DESKTOP_SETTINGS_MIGRATION_ERROR_CODES.unsupportedVersion,
      message: DESKTOP_SETTINGS_MIGRATION_ERROR_CODES.unsupportedVersion,
    });
  });

  it("fails closed with a stable diagnostic when an interrupted migration cannot be recovered", async () => {
    const settingsPath = await temporarySettingsPath();
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(
      join(dirname(settingsPath), "desktop-settings.migration.json"),
      JSON.stringify({
        schemaVersion: "pragma.state-migration/v1",
        resource: { family: "other-family", id: "other-settings" },
        fromVersion: 1,
        toVersion: 2,
        documents: {
          "desktop-settings.json": {
            schemaVersion: 3,
            localePreference: "system",
            agentContextWindow: 258_000,
          },
        },
      }),
    );

    await expect(createStore(settingsPath).getSnapshot(["en-US"])).rejects.toMatchObject({
      name: "DesktopSettingsMigrationError",
      code: DESKTOP_SETTINGS_MIGRATION_ERROR_CODES.recoveryFailed,
      message: DESKTOP_SETTINGS_MIGRATION_ERROR_CODES.recoveryFailed,
    });
  });

  it("fails closed when the stored file is malformed", async () => {
    const settingsPath = await temporarySettingsPath();
    await mkdir(join(settingsPath, ".."), { recursive: true });
    await writeFile(settingsPath, "not json");
    const warn = vi.fn();
    const store = createStore(settingsPath, warn);

    await expect(store.getSnapshot(["zh-CN"])).rejects.toMatchObject({
      name: "DesktopSettingsMigrationError",
      code: DESKTOP_SETTINGS_MIGRATION_ERROR_CODES.invalidSettings,
      message: DESKTOP_SETTINGS_MIGRATION_ERROR_CODES.invalidSettings,
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

it("migrates settings from the real v2 writer while preserving its backup", async () => {
  const settingsPath = await temporarySettingsPath();
  await mkdir(dirname(settingsPath), { recursive: true });
  const fixture = new URL(
    "../../../../../../packages/local-host/test/fixtures/expert-permissions/settings-v2.json",
    import.meta.url,
  );
  const source = await readFile(fixture, "utf8");
  await writeFile(settingsPath, source);
  const store = createStore(settingsPath);
  const current = await store.getSnapshot(["en-US"]);
  expect(current.schemaVersion).toBe(3);
  expect(current.localePreference).toBe("zh-Hans");
  expect(current).not.toHaveProperty("toolPermissionMode");
  const backupRoot = join(dirname(settingsPath), "migrations/backups");
  const files = await readdir(backupRoot);
  expect(files).toHaveLength(1);
  expect(JSON.parse(await readFile(join(backupRoot, files[0]!), "utf8"))).toEqual(
    JSON.parse(source),
  );
  await expect(store.getSnapshot(["en-US"])).resolves.toEqual(current);
});

it("preserves future settings and a pending older migration journal", async () => {
  const settingsPath = await temporarySettingsPath();
  await mkdir(dirname(settingsPath), { recursive: true });
  const future = JSON.stringify({
    schemaVersion: 999,
    localePreference: "en",
    agentContextWindow: 320_000,
  });
  const journalPath = join(dirname(settingsPath), "desktop-settings.migration.json");
  const journal = JSON.stringify({
    schemaVersion: "pragma.state-migration/v1",
    resource: { family: "pragma.desktop-settings", id: "desktop-settings" },
    fromVersion: 2,
    toVersion: 3,
    documents: {
      "desktop-settings.json": {
        schemaVersion: 3,
        localePreference: "zh-Hans",
        agentContextWindow: 258_000,
      },
    },
  });
  await writeFile(settingsPath, future);
  await writeFile(journalPath, journal);
  const store = createStore(settingsPath);
  await expect(store.getSnapshot(["en-US"])).rejects.toMatchObject({
    code: DESKTOP_SETTINGS_MIGRATION_ERROR_CODES.unsupportedVersion,
  });
  await expect(store.update({ localePreference: "zh-Hant" }, ["en-US"])).rejects.toMatchObject({
    code: DESKTOP_SETTINGS_MIGRATION_ERROR_CODES.unsupportedVersion,
  });
  expect(await readFile(settingsPath, "utf8")).toBe(future);
  expect(await readFile(journalPath, "utf8")).toBe(journal);
});
