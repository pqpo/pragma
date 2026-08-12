import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PragmaPaths } from "@pragma/core";

import {
  DesktopMemoryExtractionRunSchema,
  type DesktopMemoryExtractionRun,
} from "../../../shared/contracts/index.ts";

const RUN_ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60_000;
const RUN_ARCHIVE_MAX_RECORDS = 1_000;
const LEGACY_RUN_FILE_PATTERN = /^[0-9a-f-]{36}\.json$/u;
const RUN_FILE_PATTERN =
  /^(episodic|semantic|knowledge|skill)\.[a-f0-9]{64}\.[0-9a-f-]{36}\.json$/u;

export interface MemoryExtractionRunArchive {
  save(run: DesktopMemoryExtractionRun): Promise<void>;
  get(runId: string): Promise<DesktopMemoryExtractionRun | undefined>;
  listForJob(input: {
    readonly module: DesktopMemoryExtractionRun["module"];
    readonly jobId: string;
  }): Promise<readonly DesktopMemoryExtractionRun[]>;
}

export function createMemoryExtractionRunArchive(
  pragmaHome: string,
  options: { readonly onMaintenanceError?: ((error: unknown) => void) | undefined } = {},
): MemoryExtractionRunArchive {
  const root = join(new PragmaPaths({ pragmaHome }).archivesRoot(), "memory-extraction-runs");
  const reportMaintenanceError = (error: unknown): void => {
    try {
      options.onMaintenanceError?.(error);
    } catch {
      // Diagnostics callbacks must not change archive persistence semantics.
    }
  };
  const nameFor = (run: DesktopMemoryExtractionRun): string =>
    `${run.module}.${jobIdDigest(run.jobId)}.${run.runId}.json`;
  const readName = async (name: string): Promise<DesktopMemoryExtractionRun | undefined> => {
    try {
      return DesktopMemoryExtractionRunSchema.parse(
        JSON.parse(await readFile(join(root, name), "utf8")),
      );
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  };
  const read = async (runId: string): Promise<DesktopMemoryExtractionRun | undefined> => {
    let names: string[];
    try {
      names = await readdir(root);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    const name = names.find(
      (candidate) => candidate === `${runId}.json` || candidate.endsWith(`.${runId}.json`),
    );
    return name === undefined ? undefined : await readName(name);
  };

  return {
    async save(run) {
      const parsed = DesktopMemoryExtractionRunSchema.parse(run);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const target = join(root, nameFor(parsed));
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
      await pruneRunArchive(root, readName, reportMaintenanceError).catch(reportMaintenanceError);
    },
    get: read,
    async listForJob(input) {
      let names: string[];
      try {
        names = await readdir(root);
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
      const prefix = `${input.module}.${jobIdDigest(input.jobId)}.`;
      const records = await Promise.all(
        names
          .filter(
            (name) =>
              (RUN_FILE_PATTERN.test(name) && name.startsWith(prefix)) ||
              LEGACY_RUN_FILE_PATTERN.test(name),
          )
          .map(
            async (name) =>
              await readName(name).catch((error: unknown) => {
                reportMaintenanceError(error);
                return undefined;
              }),
          ),
      );
      return records
        .filter(
          (record): record is DesktopMemoryExtractionRun =>
            record !== undefined && record.module === input.module && record.jobId === input.jobId,
        )
        .toSorted((left, right) => right.startedAt.localeCompare(left.startedAt))
        .slice(0, 20);
    },
  };
}

async function pruneRunArchive(
  root: string,
  readName: (name: string) => Promise<DesktopMemoryExtractionRun | undefined>,
  onReadError: (error: unknown) => void,
): Promise<void> {
  const names = (await readdir(root)).filter(
    (name) => RUN_FILE_PATTERN.test(name) || LEGACY_RUN_FILE_PATTERN.test(name),
  );
  const records = (
    await Promise.all(
      names.map(async (name) => ({
        name,
        run: await readName(name).catch((error: unknown) => {
          onReadError(error);
          return undefined;
        }),
      })),
    )
  )
    .filter(
      (entry): entry is { readonly name: string; readonly run: DesktopMemoryExtractionRun } =>
        entry.run !== undefined,
    )
    .toSorted((left, right) => right.run.startedAt.localeCompare(left.run.startedAt));
  const cutoff = Date.now() - RUN_ARCHIVE_RETENTION_MS;
  await Promise.all(
    records
      .filter(
        (entry, index) =>
          index >= RUN_ARCHIVE_MAX_RECORDS || Date.parse(entry.run.startedAt) < cutoff,
      )
      .map(async (entry) => await rm(join(root, entry.name), { force: true })),
  );
}

function jobIdDigest(jobId: string): string {
  return createHash("sha256").update(jobId).digest("hex");
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
