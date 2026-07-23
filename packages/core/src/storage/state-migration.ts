import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { z } from "zod";

const StateMigrationJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.state-migration/v1"),
    resource: z.object({
      family: z.string().min(1),
      id: z.string().min(1),
    }),
    fromVersion: z.number().int().positive(),
    toVersion: z.number().int().positive(),
    documents: z.record(z.string().min(1), z.unknown()),
  })
  .refine((journal) => journal.toVersion > journal.fromVersion, {
    path: ["toVersion"],
    message: "State migration target version must be newer than its source version.",
  });

type StateMigrationJournal = z.infer<typeof StateMigrationJournalSchema>;

export interface StateMigrationStep {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly inputSchema: z.ZodType;
  migrate(value: unknown): unknown;
}

export interface StateMigrationChain<T> {
  readonly family: string;
  readonly currentVersion: number;
  upgrade(value: unknown): StateUpgradeResult<T>;
}

export interface StateUpgradeResult<T> {
  readonly value: T;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly migrated: boolean;
}

export class StateVersionTooNewError extends Error {
  constructor(
    readonly family: string,
    readonly receivedVersion: number,
    readonly currentVersion: number,
  ) {
    super(
      `${family}/v${receivedVersion} is newer than the supported ${family}/v${currentVersion}.`,
    );
    this.name = "StateVersionTooNewError";
  }
}

export class StateMigrationUnavailableError extends Error {
  constructor(
    readonly family: string,
    readonly fromVersion: number,
    readonly currentVersion: number,
  ) {
    super(`No ${family} migration is available from v${fromVersion} to v${currentVersion}.`);
    this.name = "StateMigrationUnavailableError";
  }
}

export class StateMigrationFailedError extends Error {
  constructor(
    readonly family: string,
    readonly fromVersion: number,
    readonly toVersion: number,
    cause: unknown,
  ) {
    super(`Failed to migrate ${family} from v${fromVersion} to v${toVersion}.`, { cause });
    this.name = "StateMigrationFailedError";
  }
}

export function defineStateMigrationChain<T>(input: {
  readonly family: string;
  readonly currentVersion: number;
  readonly currentSchema: z.ZodType<T>;
  readonly steps?: readonly StateMigrationStep[] | undefined;
}): StateMigrationChain<T> {
  if (input.family.trim() === "" || input.family.includes("/v")) {
    throw new Error("State migration family must be a non-empty schema prefix without /v.");
  }
  if (!Number.isSafeInteger(input.currentVersion) || input.currentVersion <= 0) {
    throw new Error("State migration currentVersion must be a positive integer.");
  }
  const steps = new Map<number, StateMigrationStep>();
  for (const step of input.steps ?? []) {
    if (
      !Number.isSafeInteger(step.fromVersion) ||
      step.fromVersion <= 0 ||
      step.toVersion > input.currentVersion
    ) {
      throw new Error(`${input.family} migration step is outside the supported version range.`);
    }
    if (step.toVersion !== step.fromVersion + 1) {
      throw new Error(
        `${input.family} migration steps must be adjacent: v${step.fromVersion} -> v${step.toVersion}.`,
      );
    }
    if (steps.has(step.fromVersion)) {
      throw new Error(`Duplicate ${input.family}/v${step.fromVersion} migration step.`);
    }
    steps.set(step.fromVersion, step);
  }

  return {
    family: input.family,
    currentVersion: input.currentVersion,
    upgrade(value) {
      const fromVersion = readStateVersion(value, input.family);
      if (fromVersion > input.currentVersion) {
        throw new StateVersionTooNewError(input.family, fromVersion, input.currentVersion);
      }
      let current: unknown = value;
      let version = fromVersion;
      while (version < input.currentVersion) {
        const step = steps.get(version);
        if (step === undefined) {
          throw new StateMigrationUnavailableError(input.family, version, input.currentVersion);
        }
        try {
          current = step.migrate(step.inputSchema.parse(current));
          const migratedVersion = readStateVersion(current, input.family);
          if (migratedVersion !== step.toVersion) {
            throw new Error(
              `Migration returned ${input.family}/v${migratedVersion}; expected v${step.toVersion}.`,
            );
          }
        } catch (error) {
          throw new StateMigrationFailedError(
            input.family,
            step.fromVersion,
            step.toVersion,
            error,
          );
        }
        version = step.toVersion;
      }
      try {
        return {
          value: input.currentSchema.parse(current),
          fromVersion,
          toVersion: input.currentVersion,
          migrated: fromVersion !== input.currentVersion,
        };
      } catch (error) {
        throw new StateMigrationFailedError(input.family, fromVersion, input.currentVersion, error);
      }
    },
  };
}

export async function applyAtomicStateMigration(input: {
  readonly aggregateRoot: string;
  readonly journalFile: string;
  readonly resource: {
    readonly family: string;
    readonly id: string;
  };
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly documents: Readonly<Record<string, unknown>>;
  readonly validateDocuments: (documents: Readonly<Record<string, unknown>>) => void;
}): Promise<void> {
  if (input.toVersion <= input.fromVersion) {
    throw new Error("State migration target version must be newer than its source version.");
  }
  const journal = StateMigrationJournalSchema.parse(
    jsonRoundTrip({
      schemaVersion: "pragma.state-migration/v1",
      resource: input.resource,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      documents: input.documents,
    }),
  );
  validateDocumentPaths(input.aggregateRoot, journal.documents);
  input.validateDocuments(journal.documents);
  await writeJsonAtomic(input.journalFile, journal);
  await applyJournal(input.aggregateRoot, input.journalFile, journal);
}

export async function recoverAtomicStateMigration(input: {
  readonly aggregateRoot: string;
  readonly journalFile: string;
  readonly resource: {
    readonly family: string;
    readonly id: string;
  };
  readonly validateDocuments: (documents: Readonly<Record<string, unknown>>) => void;
}): Promise<boolean> {
  const value = await readJsonIfExists(input.journalFile);
  if (value === undefined) return false;
  const journal = StateMigrationJournalSchema.parse(value);
  if (
    journal.resource.family !== input.resource.family ||
    journal.resource.id !== input.resource.id
  ) {
    throw new Error(
      `State migration journal belongs to ${journal.resource.family} ${journal.resource.id}.`,
    );
  }
  validateDocumentPaths(input.aggregateRoot, journal.documents);
  input.validateDocuments(journal.documents);
  await applyJournal(input.aggregateRoot, input.journalFile, journal);
  return true;
}

function readStateVersion(value: unknown, family: string): number {
  if (typeof value !== "object" || value === null || !("schemaVersion" in value)) {
    throw new StateMigrationUnavailableError(family, 0, 0);
  }
  const schemaVersion = value.schemaVersion;
  if (typeof schemaVersion !== "string") {
    throw new StateMigrationUnavailableError(family, 0, 0);
  }
  const match = new RegExp(`^${escapeRegExp(family)}/v([1-9][0-9]*)$`, "u").exec(schemaVersion);
  if (match === null) throw new StateMigrationUnavailableError(family, 0, 0);
  return Number(match[1]);
}

function validateDocumentPaths(
  aggregateRoot: string,
  documents: Readonly<Record<string, unknown>>,
): void {
  const root = resolve(aggregateRoot);
  for (const path of Object.keys(documents)) {
    const target = resolve(root, path);
    const local = relative(root, target);
    if (local === "" || local.startsWith("..") || local.includes("\0")) {
      throw new Error(`State migration document escapes its aggregate root: ${path}`);
    }
  }
}

async function applyJournal(
  aggregateRoot: string,
  journalFile: string,
  journal: StateMigrationJournal,
): Promise<void> {
  for (const [path, value] of Object.entries(journal.documents)) {
    await writeJsonAtomic(join(aggregateRoot, path), value);
  }
  await rm(journalFile, { force: true });
}

async function readJsonIfExists(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(file), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await renameWithRetry(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function jsonRoundTrip(value: unknown): unknown {
  assertJsonSafe(value, new Set<object>());
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error("State migration documents must be JSON-safe.", { cause: error });
  }
  if (serialized === undefined) {
    throw new Error("State migration documents must be JSON-safe.");
  }
  return JSON.parse(serialized) as unknown;
}

function assertJsonSafe(value: unknown, ancestors: Set<object>): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object") {
    throw new Error("State migration documents must be JSON-safe.");
  }
  if (ancestors.has(value)) {
    throw new Error("State migration documents must not contain cycles.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const entry of value) assertJsonSafe(entry, ancestors);
      return;
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("State migration documents must contain only plain JSON objects.");
    }
    for (const entry of Object.values(value)) assertJsonSafe(entry, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
