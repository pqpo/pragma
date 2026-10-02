import { mkdir, open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

import { CanonicalEventEnvelopeSchema } from "@pragma/shared";

import { CanonicalEventHandoffSchema } from "../../../execution/canonical-event-handoff.ts";
import type { PragmaPaths } from "../../pragma-paths.ts";
import { readStorageFile, parseStorageJson } from "../../storage-diagnostics.ts";
import { applyAtomicStateMigration, recoverAtomicStateMigration } from "../../state-migration.ts";
import { executionCommitJournalMigrationChain } from "../execution-transaction/index.ts";

// The handoff envelope stays v1; its independently versioned transaction uses
// the same historical schemas and adjacent migrations as transaction.json.
const envelopeSchema = z.object({
  schemaVersion: z.literal("pragma.canonical-event-handoff/v1"),
  executionId: z.string().min(1),
  commitId: z.string().min(1),
  signature: z.string().length(64),
  createdAt: z.string().datetime(),
  transaction: z.unknown(),
  events: z.array(CanonicalEventEnvelopeSchema),
});

/** Caller holds the Execution owner lock. */
export async function upgradeCanonicalEventHandoff(
  paths: PragmaPaths,
  file: string,
  executionId: string,
) {
  const aggregateRoot = dirname(file);
  const documentName = basename(file);
  const journalFile = `${file}.migration`;
  const resource = { family: "pragma.execution-transaction", id: documentName };
  const validateDocuments = (documents: Readonly<Record<string, unknown>>): void => {
    if (Object.keys(documents).length !== 1)
      throw new Error("Invalid handoff migration documents.");
    const handoff = CanonicalEventHandoffSchema.parse(documents[documentName]);
    if (
      handoff.executionId !== executionId ||
      handoff.transaction.execution.executionId !== executionId ||
      handoff.commitId !== handoff.transaction.commitId ||
      handoff.signature !== handoff.transaction.signature
    )
      throw new Error("Canonical handoff migration identity mismatch.");
  };
  await recoverAtomicStateMigration({ aggregateRoot, journalFile, resource, validateDocuments });
  const contents = await readStorageFile(file, "utf8");
  const envelope = envelopeSchema.parse(parseStorageJson(contents));
  if (envelope.executionId !== executionId) throw new Error("Canonical handoff owner mismatch.");
  const upgraded = executionCommitJournalMigrationChain.upgrade(envelope.transaction);
  const handoff = CanonicalEventHandoffSchema.parse({ ...envelope, transaction: upgraded.value });
  validateDocuments({ [documentName]: handoff });
  if (!upgraded.migrated) return handoff;
  const backupRoot = join(paths.executionStorageBackup(envelope.executionId), "handoffs");
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  try {
    const backup = await open(join(backupRoot, documentName), "wx", 0o600);
    try {
      await backup.writeFile(contents);
      await backup.sync();
    } finally {
      await backup.close();
    }
    const directory = await open(backupRoot, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await applyAtomicStateMigration({
    aggregateRoot,
    journalFile,
    resource,
    fromVersion: upgraded.fromVersion,
    toVersion: upgraded.toVersion,
    documents: { [documentName]: handoff },
    validateDocuments,
  });
  return handoff;
}
