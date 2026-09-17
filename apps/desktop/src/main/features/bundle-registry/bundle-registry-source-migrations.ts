import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { withFileLock } from "@pragma/core";
import { z } from "zod";

import {
  DesktopBundleRegistryRemoteSchema,
  DesktopBundleRegistrySourcesSchema,
} from "../../../shared/contracts/index.ts";

const LegacySourceSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    remote: DesktopBundleRegistryRemoteSchema,
    ref: z.string().trim().min(1).max(300).optional(),
    enabled: z.boolean(),
    official: z.boolean(),
    order: z.number().int().nonnegative(),
  })
  .strict();

const LegacySourcesSchema = z
  .object({
    schemaVersion: z.literal("pragma.desktop-bundle-registry-sources/v1"),
    sources: z.array(LegacySourceSchema).max(100),
    dismissedOfficialSourceIds: z.array(z.string().uuid()).max(100).optional(),
  })
  .strict();

const SourcesMigrationJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.desktop-bundle-registry-sources-migration/v1"),
    sourceVersion: z.literal("pragma.desktop-bundle-registry-sources/v1"),
    targetVersion: z.literal("pragma.desktop-bundle-registry-sources/v2"),
    backupPath: z.string().trim().min(1),
  })
  .strict();

export async function readMigratedBundleRegistrySources(
  path: string,
  lockPath: string,
): Promise<ReturnType<typeof DesktopBundleRegistrySourcesSchema.parse>> {
  const initial = JSON.parse(await readFile(path, "utf8")) as unknown;
  const current = DesktopBundleRegistrySourcesSchema.safeParse(initial);
  if (current.success) {
    const journal = await readOptionalMigrationJournal(`${path}.migration.json`);
    if (journal !== undefined) {
      await assertMigrationJournal(journal, `${path}.v1.backup`);
      await rm(`${path}.migration.json`, { force: true });
    }
    return current.data;
  }

  const legacy = LegacySourcesSchema.safeParse(initial);
  if (!legacy.success) throw current.error;

  return await withFileLock(lockPath, async () => {
    const latest = JSON.parse(await readFile(path, "utf8")) as unknown;
    const alreadyMigrated = DesktopBundleRegistrySourcesSchema.safeParse(latest);
    if (alreadyMigrated.success) return alreadyMigrated.data;
    const parsed = LegacySourcesSchema.parse(latest);
    const migrated = DesktopBundleRegistrySourcesSchema.parse({
      schemaVersion: "pragma.desktop-bundle-registry-sources/v2",
      sources: parsed.sources.map(({ ref, ...source }) => ({
        ...source,
        ...(ref === undefined ? {} : { branch: ref }),
      })),
      dismissedOfficialSourceIds: parsed.dismissedOfficialSourceIds ?? [],
    });

    const backupPath = `${path}.v1.backup`;
    const journalPath = `${path}.migration.json`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const existingJournal = await readOptionalMigrationJournal(journalPath);
    if (existingJournal !== undefined) {
      await assertMigrationJournal(existingJournal, backupPath);
    }
    try {
      await copyFile(path, backupPath, constants.COPYFILE_EXCL);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    await writeFile(
      journalPath,
      `${JSON.stringify(
        SourcesMigrationJournalSchema.parse({
          schemaVersion: "pragma.desktop-bundle-registry-sources-migration/v1",
          sourceVersion: parsed.schemaVersion,
          targetVersion: migrated.schemaVersion,
          backupPath,
        }),
        undefined,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await writeJsonAtomically(path, migrated);
    await rm(journalPath, { force: true });
    return migrated;
  });
}

async function readOptionalMigrationJournal(
  path: string,
): Promise<ReturnType<typeof SourcesMigrationJournalSchema.parse> | undefined> {
  try {
    return SourcesMigrationJournalSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error("Bundle Source settings migration journal is unreadable.", { cause: error });
  }
}

async function assertMigrationJournal(
  journal: ReturnType<typeof SourcesMigrationJournalSchema.parse>,
  expectedBackupPath: string,
): Promise<void> {
  if (journal.backupPath !== expectedBackupPath) {
    throw new Error("Bundle Source settings migration journal targets an unexpected backup.");
  }
  try {
    await readFile(expectedBackupPath);
  } catch (error) {
    throw new Error("Bundle Source settings migration backup is unavailable.", { cause: error });
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
