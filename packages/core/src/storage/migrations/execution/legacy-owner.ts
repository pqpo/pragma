import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import {
  ExecutionEventSchema,
  ExecutionRecordSchema,
  InvocationSchema,
  isTerminalExecutionStatus,
  type ExecutionEvent,
  type Invocation,
} from "@pragma/shared";
import { z } from "zod";
import {
  readStorageFile as readFile,
  writeStorageFile as writeFile,
  replaceStorageFile as rename,
  parseStorageJson,
  stringifyStorageJson,
  measureStoragePhase,
} from "../../storage-diagnostics.ts";
import { withFileLock } from "../../file-lock.ts";
import { upgradeCanonicalEventHandoff } from "../canonical-event-handoff/index.ts";
import {
  executionCommitJournalMigrationChain,
  type ExecutionCommitJournal,
} from "../execution-transaction/index.ts";
import {
  executionRecordMigrationChain,
  migrateExecutionInvocationsV5ToV6,
  migrateExecutionInvocationsV9ToV10,
  migrateExecutionInvocationsV10ToV11,
  migrateInvocationUsageV7ToV8,
} from "./index.ts";
import { encodePragmaPathSegment, PragmaPaths } from "../../pragma-paths.ts";
import { applyAtomicStateMigration, recoverAtomicStateMigration } from "../../state-migration.ts";
import { type CanonicalEventHandoff } from "../../../execution/canonical-event-handoff.ts";
import { ExecutionHistoryUnavailableError } from "../../../execution/execution-store.ts";
import { executionTransactionRules as rules } from "../../../execution/execution-transaction-rules.ts";
const { assertExpertTurnRootPrompt } = rules;
const ExecutionCommitRecordSchema = z.object({
  commitId: z.string().min(1),
  signature: z.string().length(64),
  eventIds: z.array(z.string().min(1)),
  committedVersion: z.number().int().nonnegative(),
});
type ExecutionCommitRecord = z.infer<typeof ExecutionCommitRecordSchema>;
async function recoverTransaction(paths: PragmaPaths, executionId: string): Promise<void> {
  const value = await readJsonIfExists(paths.executionTransaction(executionId));
  if (value === undefined) return;
  let journal: ReturnType<typeof executionCommitJournalMigrationChain.upgrade>;
  try {
    journal = executionCommitJournalMigrationChain.upgrade(value);
  } catch (error) {
    throw unsupportedState(executionId, error);
  }
  if (journal.migrated) {
    await writeJsonAtomic(paths.executionTransaction(executionId), journal.value);
  }
  await applyTransaction(paths, executionId, journal.value);
}

export async function recoverLegacyExecutionOwner(
  paths: PragmaPaths,
  executionId: string,
): Promise<void> {
  await withFileLock(
    paths.executionLock(executionId),
    async () => {
      if ((await readJsonIfExists(paths.executionStorageAuthority(executionId))) !== undefined)
        return;
      await prepareExecution(paths, executionId, true);
    },
    { operation: "execution.storage-conversion-recovery" },
  );
}

/** Upgrades and reads a historical JSON owner already moved to Trash. */
export async function readLegacyExecutionUsageSource(
  paths: PragmaPaths,
  executionId: string,
): Promise<
  | { readonly events: readonly ExecutionEvent[]; readonly invocations: readonly Invocation[] }
  | undefined
> {
  // An expired/missing Trash source must not create a new owner lock directory.
  try {
    await stat(paths.executionState(executionId));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  return await withFileLock(
    paths.executionLock(executionId),
    async () => {
      if ((await readJsonIfExists(paths.executionState(executionId))) === undefined)
        return undefined;
      await prepareExecution(paths, executionId, true);
      return {
        events: (await readExecutionEvents(paths, executionId)).filter(
          (event) => event.type === "runtime.usage.observed",
        ),
        invocations: InvocationSchema.array().parse(
          (await readJsonIfExists(paths.executionInvocations(executionId))) ?? [],
        ),
      };
    },
    { operation: "execution.legacy-trash-usage" },
  );
}

async function prepareExecution(
  paths: PragmaPaths,
  executionId: string,
  recoverCanonicalEvents = false,
): Promise<void> {
  await measureStoragePhase("prepare_recovery_migration", () =>
    prepareExecutionUnmeasured(paths, executionId, recoverCanonicalEvents),
  );
}

async function prepareExecutionUnmeasured(
  paths: PragmaPaths,
  executionId: string,
  recoverCanonicalEvents = false,
): Promise<void> {
  if ((await readJsonIfExists(paths.executionStorageAuthority(executionId))) !== undefined) {
    throw new Error(`Execution ${executionId} requires the Host SQLite storage adapter.`);
  }
  try {
    await recoverAtomicStateMigration({
      aggregateRoot: paths.executionRoot(executionId),
      journalFile: paths.executionMigration(executionId),
      resource: { family: "pragma.execution", id: executionId },
      validateDocuments: validateExecutionMigrationDocuments,
    });
    await recoverTransaction(paths, executionId);
    if (recoverCanonicalEvents) {
      await assertNoQuarantinedCanonicalHandoffs(paths, executionId);
      await recoverCanonicalHandoffStateForExecution(paths, executionId);
    }
    await migrateExecutionState(paths, executionId);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("unsupported-state-version:")) {
      throw error;
    }
    throw unsupportedState(executionId, error);
  }
}

async function recoverCanonicalHandoffStateForExecution(
  paths: PragmaPaths,
  executionId: string,
): Promise<readonly { readonly file: string; readonly handoff: CanonicalEventHandoff }[]> {
  await assertNoQuarantinedCanonicalHandoffs(paths, executionId);
  const files = await listCanonicalHandoffFilesForExecution(paths, executionId);
  const handoffs: { readonly file: string; readonly handoff: CanonicalEventHandoff }[] = [];
  for (const file of files) {
    try {
      const handoff = await upgradeCanonicalEventHandoff(paths, file, executionId);
      if (handoff.executionId !== executionId) {
        throw new Error(`Canonical event handoff owner mismatch: ${handoff.executionId}`);
      }
      assertCanonicalHandoffFileOwner(file, executionId);
      handoffs.push({ file, handoff });
    } catch (error) {
      if (isNotFound(error)) continue;
      const quarantinedPath = await quarantineCanonicalHandoff(paths, file);
      throw new Error(
        `unsupported-state-version:pragma.canonical-event-handoff-quarantined:${executionId}:${quarantinedPath}`,
        { cause: error },
      );
    }
  }
  const ordered = handoffs.toSorted(
    (left, right) =>
      left.handoff.transaction.execution.version - right.handoff.transaction.execution.version,
  );
  for (const { handoff } of ordered) {
    const commits = await readCommitRecords(paths, executionId);
    const committed = commits.find((candidate) => candidate.commitId === handoff.commitId);
    if (committed === undefined) {
      await applyTransaction(paths, executionId, handoff.transaction);
    } else if (committed.signature !== handoff.signature) {
      throw new Error(`Canonical event handoff signature conflict: ${handoff.commitId}`);
    }
  }
  return ordered;
}

async function listCanonicalHandoffFilesForExecution(
  paths: PragmaPaths,
  executionId: string,
): Promise<string[]> {
  const prefix = `${encodePragmaPathSegment(executionId)}.`;
  return (await listCanonicalHandoffFiles(paths)).filter((file) =>
    basename(file).startsWith(prefix),
  );
}

function assertCanonicalHandoffFileOwner(file: string, executionId: string): void {
  const prefix = `${encodePragmaPathSegment(executionId)}.`;
  if (!basename(file).startsWith(prefix)) {
    throw new Error(`Canonical event handoff filename owner mismatch: ${executionId}`);
  }
}

async function listQuarantinedCanonicalHandoffFilesForExecution(
  paths: PragmaPaths,
  executionId: string,
): Promise<string[]> {
  const prefix = `${encodePragmaPathSegment(executionId)}.`;
  return (await listQuarantinedCanonicalHandoffFiles(paths)).filter((file) =>
    basename(file).startsWith(prefix),
  );
}

async function assertNoQuarantinedCanonicalHandoffs(
  paths: PragmaPaths,
  executionId: string,
): Promise<void> {
  const files = await listQuarantinedCanonicalHandoffFilesForExecution(paths, executionId);
  if (files.length === 0) return;
  throw new Error(
    `unsupported-state-version:pragma.canonical-event-handoff-quarantined:${executionId}:${files[0]}`,
  );
}

async function listCanonicalHandoffFiles(paths: PragmaPaths): Promise<string[]> {
  try {
    return (await readdir(paths.canonicalEventHandoffsRoot(), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(paths.canonicalEventHandoffsRoot(), entry.name))
      .toSorted();
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function listQuarantinedCanonicalHandoffFiles(paths: PragmaPaths): Promise<string[]> {
  try {
    return (await readdir(paths.canonicalEventHandoffQuarantineRoot(), { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(paths.canonicalEventHandoffQuarantineRoot(), entry.name))
      .toSorted();
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function quarantineCanonicalHandoff(paths: PragmaPaths, file: string): Promise<string> {
  const root = paths.canonicalEventHandoffQuarantineRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, `${basename(file)}.${randomUUID()}.blocked`);
  await rename(file, target);
  return target;
}

async function migrateExecutionState(paths: PragmaPaths, executionId: string): Promise<void> {
  const value = await readJsonIfExists(paths.executionState(executionId));
  if (value === undefined) return;
  const upgraded = executionRecordMigrationChain.upgrade(value);
  if (!upgraded.migrated) return;
  const storedInvocations = (await readJsonIfExists(paths.executionInvocations(executionId))) ?? [];
  const usageMigratedInvocations = Array.isArray(storedInvocations)
    ? storedInvocations.map(migrateInvocationUsageV7ToV8)
    : storedInvocations;
  const handoffMigratedInvocations =
    upgraded.fromVersion === 5
      ? migrateExecutionInvocationsV5ToV6(usageMigratedInvocations)
      : usageMigratedInvocations;
  const handoffInvocations =
    upgraded.fromVersion <= 9
      ? migrateExecutionInvocationsV9ToV10(handoffMigratedInvocations)
      : InvocationSchema.array().parse(handoffMigratedInvocations);
  const invocations =
    upgraded.fromVersion <= 10
      ? migrateExecutionInvocationsV10ToV11(upgraded.value, handoffInvocations)
      : handoffInvocations;
  await applyAtomicStateMigration({
    aggregateRoot: paths.executionRoot(executionId),
    journalFile: paths.executionMigration(executionId),
    resource: { family: "pragma.execution", id: executionId },
    fromVersion: upgraded.fromVersion,
    toVersion: upgraded.toVersion,
    documents: {
      "execution.json": upgraded.value,
      "invocations.json": invocations,
    },
    validateDocuments: validateExecutionMigrationDocuments,
  });
}

function validateExecutionMigrationDocuments(documents: Readonly<Record<string, unknown>>): void {
  const keys = Object.keys(documents).toSorted();
  if (keys.length !== 2 || keys[0] !== "execution.json" || keys[1] !== "invocations.json") {
    throw new Error("Execution migration journal contains unexpected documents.");
  }
  const execution = ExecutionRecordSchema.parse(documents["execution.json"]);
  const invocations = InvocationSchema.array().parse(documents["invocations.json"]);
  assertExpertTurnRootPrompt(execution, invocations);
}

async function applyTransaction(
  paths: PragmaPaths,
  executionId: string,
  journal: ExecutionCommitJournal,
  lockedHistory?: {
    readonly events: readonly ExecutionEvent[];
    readonly commits: readonly z.infer<typeof ExecutionCommitRecordSchema>[];
  },
): Promise<void> {
  const existingEvents = lockedHistory?.events ?? (await readExecutionEvents(paths, executionId));
  const mergedEvents = mergeEvents(existingEvents, journal.events);
  const commits = lockedHistory?.commits ?? (await readCommitRecords(paths, executionId));
  const existingCommit = commits.find((commit) => commit.commitId === journal.commitId);
  if (existingCommit !== undefined && existingCommit.signature !== journal.signature) {
    throw new Error(`Execution commit idempotency conflict: ${journal.commitId}`);
  }
  const nextCommits =
    existingCommit === undefined
      ? [
          ...commits,
          ExecutionCommitRecordSchema.parse({
            commitId: journal.commitId,
            signature: journal.signature,
            eventIds: journal.eventIds,
            committedVersion: journal.execution.version,
          }),
        ]
      : commits;

  await writeJsonAtomic(paths.executionState(executionId), journal.execution);
  await writeJsonAtomic(paths.executionInvocations(executionId), journal.invocations);
  await writeJsonAtomic(paths.executionAgents(executionId), journal.agents);
  await writeJsonAtomic(paths.executionContexts(executionId), journal.contexts);
  await writeJsonLinesAtomic(paths.executionEvents(executionId), mergedEvents);
  await writeJsonAtomic(paths.executionCommits(executionId), nextCommits);
  await rm(paths.executionTransaction(executionId), { force: true });
}

function mergeEvents(
  existing: readonly ExecutionEvent[],
  added: readonly ExecutionEvent[],
): ExecutionEvent[] {
  const merged = [...existing];
  const byId = new Map(existing.map((event) => [event.eventId, event]));
  for (const event of added) {
    const duplicate = byId.get(event.eventId);
    if (duplicate !== undefined) {
      if (stableStringify(duplicate) !== stableStringify(event)) {
        throw new Error(`Execution event idempotency conflict: ${event.eventId}`);
      }
      continue;
    }
    const expectedSequence = (merged.at(-1)?.cursor.sequence ?? 0) + 1;
    if (event.cursor.sequence !== expectedSequence) {
      throw new Error(
        `Execution event sequence conflict: expected ${expectedSequence}, received ${event.cursor.sequence}.`,
      );
    }
    merged.push(parseExecutionEvent(event));
    byId.set(event.eventId, event);
  }
  return merged;
}

async function readExecutionEvents(
  paths: PragmaPaths,
  executionId: string,
): Promise<ExecutionEvent[]> {
  const [hasActive, hasArchive] = await Promise.all([
    stat(paths.executionEvents(executionId)).then(
      () => true,
      (error: unknown) => (isNotFound(error) ? false : Promise.reject(error)),
    ),
    stat(paths.executionArchive(executionId)).then(
      () => true,
      (error: unknown) => (isNotFound(error) ? false : Promise.reject(error)),
    ),
  ]);
  if (!hasActive && !hasArchive) {
    const execution = await readJsonIfExists(paths.executionState(executionId));
    const parsed = ExecutionRecordSchema.safeParse(execution);
    if (parsed.success && isTerminalExecutionStatus(parsed.data.status)) {
      throw new ExecutionHistoryUnavailableError(executionId);
    }
  }
  const archived = await readArchivedExecutionEvents(paths, executionId);
  const active = await readJsonLines(paths.executionEvents(executionId), {
    parse: parseExecutionEvent,
  });
  if (archived.length === 0) return active;
  const byId = new Map(archived.map((event) => [event.eventId, event] as const));
  for (const event of active) byId.set(event.eventId, event);
  return [...byId.values()].toSorted((left, right) => left.cursor.sequence - right.cursor.sequence);
}

async function readArchivedExecutionEvents(
  paths: PragmaPaths,
  executionId: string,
): Promise<ExecutionEvent[]> {
  try {
    const contents = await promisify(gunzip)(await readFile(paths.executionArchive(executionId)));
    return contents
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => parseExecutionEvent(parseStorageJson(line) as unknown));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function readCommitRecords(
  paths: PragmaPaths,
  executionId: string,
): Promise<ExecutionCommitRecord[]> {
  const value = await readJsonIfExists(paths.executionCommits(executionId));
  if (value === undefined) return [];
  return ExecutionCommitRecordSchema.array().parse(value);
}

function parseExecutionEvent(value: unknown): ExecutionEvent {
  return ExecutionEventSchema.parse(value);
}

async function readJsonIfExists(file: string): Promise<unknown | undefined> {
  try {
    return parseStorageJson(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeTextAtomic(file, `${stringifyStorageJson(value, 2)}\n`);
}

async function writeJsonLinesAtomic(file: string, values: readonly unknown[]): Promise<void> {
  const content =
    values.length === 0 ? "" : `${values.map((value) => stringifyStorageJson(value)).join("\n")}\n`;
  await writeTextAtomic(file, content);
}

async function writeTextAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, "utf8");
    await renameWithRetry(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readJsonLines<T>(file: string, schema: { parse(value: unknown): T }): Promise<T[]> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  return content
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => schema.parse(parseStorageJson(line) as unknown));
}

function stableStringify(value: unknown): string {
  return stringifyJsonValue(value, new Set<object>());
}

function stringifyJsonValue(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw unsupportedExecutionValue(value);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw unsupportedExecutionValue(value);
  if (ancestors.has(value)) throw new Error("Execution values must not contain cycles.");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => stringifyJsonValue(entry, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null)
      throw unsupportedExecutionValue(value);
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stringifyJsonValue(entry, ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function unsupportedExecutionValue(value: unknown): Error {
  const kind = value === null ? "null" : ((value as object)?.constructor?.name ?? typeof value);
  return new Error(`Execution values must be JSON-safe; received ${kind}.`);
}

function unsupportedState(executionId: string, cause: unknown): Error {
  return new Error(`unsupported-state-version: Execution ${executionId}`, { cause });
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (attempt >= 20 || !isRetryableRename(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
}

function isRetryableRename(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EPERM" || error.code === "EACCES")
  );
}
