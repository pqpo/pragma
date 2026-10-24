import { readFile, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  applyAtomicStateMigration,
  recoverAtomicStateMigration,
  withFileLock,
  writeStateMigrationBackup,
} from "@pragma/core";
import {
  formatPragmaYaml,
  parsePragmaYaml,
  migratePragmaDslProjectToCurrent,
  migratePragmaV5AuthoringResourceToV6,
} from "@pragma/interpreter";
import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { managementCommandError } from "@pragma/shared/integration";
import { historicalAuthoringSchemas } from "./v5.ts";

type Kind = keyof typeof historicalAuthoringSchemas;
const record = z.record(z.string(), z.unknown());

/** Raw authoring files/submissions stay byte-identical for approval/hash verification. */
export function migrateAuthoringSourceToCurrent(source: string): unknown {
  const value = record.parse(parsePragmaYaml(source));
  if (value.apiVersion !== "pragma/v5") return value;
  return migratePragmaDslProjectToCurrent({
    projectId: "authoring",
    files: new Map([["pragma.yaml", source]]),
  }).resources[0];
}
function assertVersion(version: unknown): void {
  if (version !== "pragma/v5" && version !== PRAGMA_DSL_WRITE_API_VERSION)
    throw managementCommandError(
      "STORAGE_VERSION_UNSUPPORTED",
      "The embedded authoring DSL version is not supported; original data was preserved.",
    );
}
function embedded(value: Record<string, unknown>, kind: Kind): unknown[] {
  if (kind === "candidate") {
    const resources = z.array(z.unknown()).parse(value.resources);
    const changes = z
      .array(z.object({ source: z.string() }))
      .parse(record.parse(value.changeSet).changes);
    return [...resources, ...changes.map((change) => parsePragmaYaml(change.source))];
  }
  return [kind.endsWith("-mutation") ? record.parse(value.draft).resource : value.resource];
}
function identity(value: Record<string, unknown>, kind: Kind): unknown {
  if (kind === "candidate")
    return [record.parse(value.changeSet).changeSetId, value.dslDraftId, value.dslDraftMissionId];
  if (kind.endsWith("-mutation"))
    return [record.parse(value.draft).draftId, value.expectedDraftRevision];
  return value.draftId;
}
function upgradeResource(value: unknown): unknown {
  const resource = record.parse(value);
  return resource.apiVersion === "pragma/v5"
    ? migratePragmaV5AuthoringResourceToV6(resource)
    : resource;
}
function transform(value: Record<string, unknown>, kind: Kind): Record<string, unknown> {
  historicalAuthoringSchemas[kind].parse(value);
  if (kind === "candidate") {
    const changeSet = record.parse(value.changeSet);
    return {
      ...value,
      resources: z
        .array(z.unknown())
        .parse(value.resources)
        .map((resource) => migrateAuthoringSourceToCurrent(formatPragmaYaml(resource))),
      changeSet: {
        ...changeSet,
        changes: z
          .array(record)
          .parse(changeSet.changes)
          .map((change) => ({
            ...change,
            source: formatPragmaYaml(
              migrateAuthoringSourceToCurrent(z.string().parse(change.source)),
            ),
          })),
      },
    };
  }
  if (kind.endsWith("-mutation")) {
    const draft = record.parse(value.draft);
    return { ...value, draft: { ...draft, resource: upgradeResource(draft.resource) } };
  }
  return { ...value, resource: upgradeResource(value.resource) };
}
async function optionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Owner-local adjacent DSL v5→v6 upgrade; transport/envelope fields retain their existing versions. */
export async function readAuthoringRecord<T>(
  path: string,
  kind: Kind,
  schema: z.ZodType<T>,
  expectedId?: string,
  expectedRevision?: number,
  expectedMissionId?: string | null,
): Promise<T | undefined> {
  const journalFile = `${path}.dsl-migration.json`;
  if ((await optionalText(path)) === undefined && (await optionalText(journalFile)) === undefined)
    return undefined;
  return await withFileLock(`${path}.dsl-migration.lock`, async () => {
    const source = await optionalText(path);
    const pending = await optionalText(journalFile);
    if (source === undefined && pending === undefined) return undefined;
    const originalText = source ?? (await readFile(`${path}.dsl-v5.backup.json`, "utf8"));
    const original = record.parse(JSON.parse(originalText));
    const expectedHeader = kind.endsWith("-mutation")
      ? `pragma.${kind === "flow-mutation" ? "flow" : "evaluation"}-command-mutation/v1`
      : undefined;
    if (original.schemaVersion !== expectedHeader)
      throw managementCommandError(
        "STORAGE_VERSION_UNSUPPORTED",
        "The authoring record version is not supported.",
      );
    const versions = embedded(original, kind).map((value) => record.parse(value).apiVersion);
    versions.forEach(assertVersion);
    const legacy = versions.includes("pragma/v5");
    const migrated = legacy ? transform(original, kind) : original;
    const parsed = schema.parse(migrated);
    if (
      kind === "candidate" &&
      expectedMissionId !== undefined &&
      migrated.dslDraftMissionId !== undefined &&
      migrated.dslDraftMissionId !== expectedMissionId
    )
      throw new Error("DSL draft is owned by another Mission.");
    const owner = identity(migrated, kind);
    const id = Array.isArray(owner) ? owner[0] : owner;
    if (
      (expectedId !== undefined && id !== expectedId) ||
      (expectedRevision !== undefined && (!Array.isArray(owner) || owner[1] !== expectedRevision))
    )
      throw managementCommandError(
        "STORAGE_CORRUPTED",
        "Authoring record identity mismatch; original data was preserved.",
      );
    const document = basename(path);
    const expected = { ...original, ...record.parse(parsed) };
    const validateDocuments = (documents: Readonly<Record<string, unknown>>) => {
      if (Object.keys(documents).length !== 1 || !(document in documents))
        throw new Error("Invalid authoring migration target.");
      schema.parse(documents[document]);
      if (!isDeepStrictEqual(documents[document], expected))
        throw new Error("Authoring migration conflicts with the owner data.");
    };
    if (pending !== undefined)
      z.object({ fromVersion: z.literal(5), toVersion: z.literal(6) }).parse(JSON.parse(pending));
    const resource = { family: `pragma.authoring-${kind}`, id: document };
    await recoverAtomicStateMigration({
      aggregateRoot: dirname(path),
      journalFile,
      resource,
      validateDocuments,
    });
    if (legacy) {
      await writeStateMigrationBackup(`${path}.dsl-v5.backup.json`, originalText);
      await applyAtomicStateMigration({
        aggregateRoot: dirname(path),
        journalFile,
        resource,
        fromVersion: 5,
        toVersion: 6,
        documents: { [document]: expected },
        validateDocuments,
      });
    }
    return parsed;
  });
}

/** Discard cannot leave a replayable upgrade that recreates the deleted draft. */
export async function discardAuthoringRecord(path: string): Promise<void> {
  await withFileLock(`${path}.dsl-migration.lock`, async () => {
    await rm(`${path}.dsl-migration.json`, { force: true });
    await rm(path, { force: true });
    // Retained originals are offline recovery evidence; reads never restore from a backup alone.
  });
}
