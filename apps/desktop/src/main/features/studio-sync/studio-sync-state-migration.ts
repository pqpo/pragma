import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  applyAtomicStateMigration,
  recoverAtomicStateMigration,
  type StateMigrationChain,
} from "@pragma/core";

export async function readStudioSyncState<T>(input: {
  readonly statePath: string;
  readonly chain: StateMigrationChain<T>;
  readonly onMissing: () => T;
  readonly finalizeMigrated: (value: T) => T;
}): Promise<T> {
  const aggregateRoot = dirname(input.statePath);
  const stateFile = basename(input.statePath);
  const journalFile = `${input.statePath}.state-migration.json`;
  const resource = { family: input.chain.family, id: stateFile };
  const validateDocuments = (documents: Readonly<Record<string, unknown>>): void => {
    input.chain.upgrade(documents[stateFile]);
  };
  await recoverAtomicStateMigration({
    aggregateRoot,
    journalFile,
    resource,
    validateDocuments,
  });
  let sourceText: string;
  try {
    sourceText = await readFile(input.statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return input.onMissing();
    throw error;
  }
  const source: unknown = JSON.parse(sourceText);
  const upgraded = input.chain.upgrade(source);
  if (!upgraded.migrated) return upgraded.value;
  const target = input.chain.upgrade(input.finalizeMigrated(upgraded.value)).value;
  const backupRoot = join(aggregateRoot, "migrations", "backups");
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const sourceHash = createHash("sha256").update(sourceText).digest("hex");
  await copyFile(
    input.statePath,
    join(backupRoot, `${sourceHash}.${input.chain.family}.v${upgraded.fromVersion}.json`),
  );
  await applyAtomicStateMigration({
    aggregateRoot,
    journalFile,
    resource,
    fromVersion: upgraded.fromVersion,
    toVersion: upgraded.toVersion,
    documents: { [stateFile]: target },
    validateDocuments,
  });
  return target;
}
