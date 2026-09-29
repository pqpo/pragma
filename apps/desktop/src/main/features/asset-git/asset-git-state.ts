import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { applyAtomicStateMigration, recoverAtomicStateMigration, withFileLock } from "@pragma/core";

import { type AssetGitTarget } from "../../../shared/contracts/index.ts";
import {
  RecordSchema,
  JournalSchema,
  type AssetGitRecord,
  type AssetGitJournal,
} from "./asset-git-state-schema.ts";
import { assetGitV1ToV2Step, readAssetGitAssociationIdentity } from "./migrations/index.ts";

async function readOptional(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function createAssetGitState(stateRoot: string) {
  const pathFor = (target: AssetGitTarget) => join(stateRoot, target.kind, `${target.id}.json`);
  const locked = async <T>(target: AssetGitTarget, action: () => Promise<T>) => {
    const path = pathFor(target);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    return await withFileLock(`${path}.storage.lock`, action);
  };
  const read = async (target: AssetGitTarget) =>
    await locked(target, async () => {
      const path = pathFor(target),
        journalPath = `${path}.journal`;
      const recordName = basename(path),
        journalName = basename(journalPath);
      const resource = { family: "pragma.asset-git", id: `${target.kind}/${target.id}` };
      const validateDocuments = (documents: Readonly<Record<string, unknown>>) => {
        for (const [name, value] of Object.entries(documents)) {
          if (name !== recordName && name !== journalName)
            throw new Error("Invalid asset Git migration document.");
          const parsed =
            name === recordName ? RecordSchema.parse(value) : JournalSchema.parse(value);
          if (parsed.target.kind !== target.kind || parsed.target.id !== target.id)
            throw new Error("Asset Git migration owner mismatch.");
        }
      };
      const migration = {
        aggregateRoot: dirname(path),
        journalFile: `${path}.migration`,
        resource,
        validateDocuments,
      };
      try {
        await recoverAtomicStateMigration(migration);
        const sources = {
          [recordName]: await readOptional(path),
          [journalName]: await readOptional(journalPath),
        };
        const documents: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(sources)) {
          if (value === undefined) continue;
          const version = (value as { schemaVersion?: unknown }).schemaVersion;
          const legacy =
            name === recordName ? "pragma.asset-git/v1" : "pragma.asset-git-journal/v1";
          const current =
            name === recordName ? "pragma.asset-git/v2" : "pragma.asset-git-journal/v2";
          if (version === legacy)
            documents[name] =
              name === recordName
                ? assetGitV1ToV2Step.record(value)
                : assetGitV1ToV2Step.journal(value);
          else if (version !== current)
            throw new Error(`Unsupported asset Git state version: ${String(version)}`);
          else validateDocuments({ [name]: value });
        }
        if (Object.keys(documents).length) {
          validateDocuments(documents);
          const backupRoot = join(dirname(path), "migrations", "backups");
          await mkdir(backupRoot, { recursive: true, mode: 0o700 });
          for (const name of Object.keys(documents)) {
            const sourcePath = join(dirname(path), name);
            const hash = createHash("sha256")
              .update(await readFile(sourcePath))
              .digest("hex");
            await copyFile(sourcePath, join(backupRoot, `${hash}.${name}.v1`));
          }
          await applyAtomicStateMigration({
            ...migration,
            fromVersion: 1,
            toVersion: 2,
            documents,
          });
        }
        const rawRecord = await readOptional(path),
          rawJournal = await readOptional(journalPath);
        if (rawRecord !== undefined) validateDocuments({ [recordName]: rawRecord });
        if (rawJournal !== undefined) validateDocuments({ [journalName]: rawJournal });
        return {
          record: rawRecord === undefined ? undefined : RecordSchema.parse(rawRecord),
          journal: rawJournal === undefined ? undefined : JournalSchema.parse(rawJournal),
        };
      } catch (cause) {
        throw Object.assign(new Error(`asset_git_state_upgrade_failed: ${path}`, { cause }), {
          code: "asset_git_state_upgrade_failed",
        });
      }
    });
  const save = async (target: AssetGitTarget, suffix: string, value: unknown) =>
    await locked(target, async () => {
      const path = `${pathFor(target)}${suffix}`,
        temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    });
  return {
    read,
    identity: async (target: AssetGitTarget) =>
      await locked(target, async () => {
        const value = await readOptional(pathFor(target));
        if (value === undefined) return undefined;
        const identity = readAssetGitAssociationIdentity(value);
        if (identity.target.kind !== target.kind || identity.target.id !== target.id)
          throw new Error("Asset Git association owner mismatch.");
        return identity;
      }),
    saveRecord: async (record: AssetGitRecord) =>
      await save(record.target, "", RecordSchema.parse(record)),
    saveJournal: async (target: AssetGitTarget, journal: AssetGitJournal) =>
      await save(target, ".journal", JournalSchema.parse(journal)),
  };
}
