import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock } from "@pragma/core";
import { z } from "zod";

import {
  MemorySkillCandidateSchema,
  type MemorySkillCandidate,
} from "../../../../shared/contracts/skill-learning.ts";
import { MemorySkillCandidateV1Schema, type MemorySkillCandidateV1 } from "./candidate-v1.ts";

const JournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-skill-candidate-migration/v1"),
    candidateId: z.string().uuid(),
    sourceVersion: z.literal("pragma.memory-skill-candidate/v1"),
    targetVersion: z.literal("pragma.memory-skill-candidate/v2"),
    recordPath: z.string().min(1),
    backupPath: z.string().min(1),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export async function readMemorySkillCandidateWithMigration(input: {
  readonly statePath: string;
  readonly recordPath: string;
  readonly id: string;
}): Promise<MemorySkillCandidate> {
  const raw = JSON.parse(await readFile(input.recordPath, "utf8")) as unknown;
  const current = MemorySkillCandidateSchema.safeParse(raw);
  if (current.success) {
    await finishMigrationIfPresent(input.statePath, input.id, input.recordPath);
    return current.data;
  }
  return await withFileLock(`${input.recordPath}.migration.lock`, async () => {
    const latest = JSON.parse(await readFile(input.recordPath, "utf8")) as unknown;
    const latestCurrent = MemorySkillCandidateSchema.safeParse(latest);
    if (latestCurrent.success) {
      await finishMigrationIfPresent(input.statePath, input.id, input.recordPath);
      return latestCurrent.data;
    }
    const source = MemorySkillCandidateV1Schema.parse(latest);
    const migrated = migrateV1ToV2(source);
    const backupPath = join(input.statePath, "migration-backups", `${input.id}.v1.json`);
    const journalPath = join(input.statePath, "migration-journals", `${input.id}.v1-to-v2.json`);
    const sourceHash = hash(source);
    let journal: z.infer<typeof JournalSchema>;
    try {
      journal = JournalSchema.parse(JSON.parse(await readFile(journalPath, "utf8")));
      if (journal.sourceHash !== sourceHash || journal.recordPath !== input.recordPath)
        throw new Error("memory_skill_candidate_migration_journal_invalid");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeJsonAtomic(backupPath, source);
      journal = JournalSchema.parse({
        schemaVersion: "pragma.memory-skill-candidate-migration/v1",
        candidateId: input.id,
        sourceVersion: "pragma.memory-skill-candidate/v1",
        targetVersion: "pragma.memory-skill-candidate/v2",
        recordPath: input.recordPath,
        backupPath,
        sourceHash,
      });
      await writeJsonAtomic(journalPath, journal);
    }
    const backup = MemorySkillCandidateV1Schema.parse(
      JSON.parse(await readFile(journal.backupPath, "utf8")),
    );
    if (hash(backup) !== journal.sourceHash)
      throw new Error("memory_skill_candidate_migration_backup_mismatch");
    await writeJsonAtomic(input.recordPath, migrated);
    await rm(journalPath, { force: true });
    return migrated;
  });
}

async function finishMigrationIfPresent(
  statePath: string,
  id: string,
  recordPath: string,
): Promise<void> {
  const journalPath = join(statePath, "migration-journals", `${id}.v1-to-v2.json`);
  let journal: z.infer<typeof JournalSchema>;
  try {
    journal = JournalSchema.parse(JSON.parse(await readFile(journalPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (journal.recordPath !== recordPath)
    throw new Error("memory_skill_candidate_migration_journal_invalid");
  const backup = MemorySkillCandidateV1Schema.parse(
    JSON.parse(await readFile(journal.backupPath, "utf8")),
  );
  if (hash(backup) !== journal.sourceHash)
    throw new Error("memory_skill_candidate_migration_backup_mismatch");
  await rm(journalPath, { force: true });
}

export function migrateV1ToV2(source: MemorySkillCandidateV1): MemorySkillCandidate {
  const requiresResubmission =
    source.state === "evaluating" || source.lastErrorCode === "skill_evaluation_failed";
  const candidate: Record<string, unknown> = { ...source };
  delete candidate["replayCases"];
  delete candidate["boundaryCase"];
  delete candidate["evaluation"];
  return MemorySkillCandidateSchema.parse({
    ...candidate,
    schemaVersion: "pragma.memory-skill-candidate/v2",
    revision: source.revision + 1,
    state: requiresResubmission ? "needs_attention" : source.state,
    ...(requiresResubmission ? { lastErrorCode: "skill_candidate_validation_required" } : {}),
    updatedAt: source.updatedAt,
  });
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
