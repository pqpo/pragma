import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  applyAtomicStateMigration,
  recoverAtomicStateMigration,
  StateVersionTooNewError,
  StateMigrationUnavailableError,
} from "@pragma/core";
import { CoreAssetSyncConfigurationSchema } from "../../../shared/contracts/index.ts";
import { StateSchema, JournalSchema } from "./asset-sync-state.ts";
import {
  settingsMigrationChain,
  stateMigrationChain,
  journalMigrationChain,
} from "./migrations/index.ts";

// Atomic current-version files can be observed while the sync owner is doing network I/O.
// Only an actual upgrade/recovery needs the aggregate lock on the overview path.
export async function readCurrentAssetSyncOwner(
  configurationPath: string,
  statePath: string,
  options: { readonly executionActive: boolean },
) {
  const root = dirname(statePath);
  const [settings, state, restore, migration] = await Promise.all([
    readOptional(configurationPath),
    readOptional(statePath),
    // Active execution already validated its journal under the owner lock. It can
    // contain large asset payloads; overview must not load those on every refresh.
    options.executionActive
      ? Promise.resolve(undefined)
      : readOptional(join(root, "restore-journal.json")),
    readOptional(join(root, "asset-sync.migration.json")),
  ]);
  if (migration !== undefined) return undefined;
  try {
    const config =
      settings === undefined
        ? undefined
        : CoreAssetSyncConfigurationSchema.safeParse(JSON.parse(settings));
    const parsedState = state === undefined ? undefined : StateSchema.safeParse(JSON.parse(state));
    const journal =
      restore === undefined ? undefined : JournalSchema.safeParse(JSON.parse(restore));
    if (config?.success === false || parsedState?.success === false || journal?.success === false)
      return undefined;
    return { config: config?.data, state: parsedState?.data };
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

// Caller owns the sync aggregate lock. Upgrade only this owner on its first access.
export async function upgradeAssetSyncOwner(
  configurationPath: string,
  statePath: string,
): Promise<void> {
  try {
    await migrateOwner(configurationPath, statePath);
  } catch (cause) {
    const code =
      cause instanceof StateVersionTooNewError
        ? "asset_sync.upgrade_future_version"
        : cause instanceof StateMigrationUnavailableError
          ? "asset_sync.upgrade_unavailable"
          : "asset_sync.upgrade_failed";
    throw Object.assign(
      new Error(
        `${code}: ${cause instanceof Error ? cause.message : "Unable to upgrade sync state"}. Original data and recovery information were preserved.`,
        { cause },
      ),
      { code },
    );
  }
}

async function migrateOwner(configurationPath: string, statePath: string): Promise<void> {
  const root = dirname(statePath);
  const migrationJournal = join(root, "asset-sync.migration.json");
  const specs = [
    {
      path: configurationPath,
      schema: CoreAssetSyncConfigurationSchema,
      chain: settingsMigrationChain,
    },
    { path: statePath, schema: StateSchema, chain: stateMigrationChain },
    {
      path: join(root, "restore-journal.json"),
      schema: JournalSchema,
      chain: journalMigrationChain,
    },
  ];
  const validateDocuments = (documents: Readonly<Record<string, unknown>>) => {
    if (Object.keys(documents).length === 0) throw new Error("asset_sync.migration_empty");
    for (const [name, value] of Object.entries(documents)) {
      const spec = specs.find((entry) => relative(root, entry.path) === name);
      if (!spec) throw new Error("asset_sync.migration_invalid_document");
      spec.chain.upgrade(value);
    }
  };
  const pending = await readOptional(migrationJournal);
  if (pending !== undefined) {
    const journal = JSON.parse(pending) as {
      fromVersion?: unknown;
      toVersion?: unknown;
      documents?: Record<string, unknown>;
    };
    if (
      ![
        [1, 2],
        [1, 3],
        [2, 3],
      ].some(([from, to]) => journal.fromVersion === from && journal.toVersion === to)
    )
      throw new Error("asset_sync.migration_unsupported_version");
    // A stale recovery operation must never downgrade a newer owner document.
    for (const spec of specs) {
      const bytes = await readOptional(spec.path);
      if (bytes !== undefined) {
        const current = spec.chain.upgrade(JSON.parse(bytes));
        const target = journal.documents?.[relative(root, spec.path)];
        if (target !== undefined && current.fromVersion > spec.chain.upgrade(target).fromVersion)
          throw new Error("asset_sync.migration_stale");
      }
    }
  }
  await recoverAtomicStateMigration({
    aggregateRoot: root,
    journalFile: migrationJournal,
    resource: { family: "pragma.asset-sync-owner", id: "asset-sync" },
    validateDocuments,
  });
  const documents: Record<string, unknown> = {};
  const backups: { path: string; bytes: string; fromVersion: number; toVersion: number }[] = [];
  for (const spec of specs) {
    const bytes = await readOptional(spec.path);
    if (bytes === undefined) continue;
    const upgraded = spec.chain.upgrade(JSON.parse(bytes));
    if (!upgraded.migrated) continue;
    const name = relative(root, spec.path);
    if (name.startsWith("..")) throw new Error("asset_sync.migration_invalid_path");
    documents[name] = upgraded.value;
    backups.push({
      path: spec.path,
      bytes,
      fromVersion: upgraded.fromVersion,
      toVersion: upgraded.toVersion,
    });
  }
  if (backups.length === 0) return;
  const backupRoot = join(root, "migrations", "backups");
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  for (const backup of backups) {
    const hash = createHash("sha256").update(backup.bytes).digest("hex");
    await copyFile(backup.path, join(backupRoot, `${hash}.v${backup.fromVersion}.json`));
  }
  await applyAtomicStateMigration({
    aggregateRoot: root,
    journalFile: migrationJournal,
    resource: { family: "pragma.asset-sync-owner", id: "asset-sync" },
    fromVersion: Math.min(...backups.map((backup) => backup.fromVersion)),
    toVersion: Math.max(...backups.map((backup) => backup.toVersion)),
    documents,
    validateDocuments,
  });
}
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
