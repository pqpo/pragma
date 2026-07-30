import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

import { z } from "zod";

import { MissionChatEntrySchema, type MissionChatEntry } from "../../../shared/contracts/index.ts";

export const MISSION_EXECUTION_PROJECTION_MAX_ENTRIES = 1_000;
export const MISSION_EXECUTION_PROJECTION_MAX_BYTES = 4 * 1024 * 1024;
export const MISSION_EXECUTION_PROJECTION_MAX_CONTENT_LENGTH = 32_000;
export const MISSION_EXECUTION_PROJECTION_MAX_ERROR_LENGTH = 4_000;

const ProjectionSchemaVersion = "pragma.mission-execution-projection/v2";

const ProjectionTruncatedFieldSchema = z.object({
  field: z.enum(["content", "inputPreview", "outputPreview", "error", "label"]),
  originalLength: z.number().int().positive(),
});

const ProjectionHeaderSchema = z.object({
  schemaVersion: z.literal(ProjectionSchemaVersion),
  recordType: z.literal("header"),
  executionId: z.string().min(1),
  createdAt: z.string().datetime(),
  limits: z.object({
    maxEntries: z.literal(MISSION_EXECUTION_PROJECTION_MAX_ENTRIES),
    maxBytes: z.literal(MISSION_EXECUTION_PROJECTION_MAX_BYTES),
    maxContentLength: z.literal(MISSION_EXECUTION_PROJECTION_MAX_CONTENT_LENGTH),
  }),
  omittedEntries: z.number().int().nonnegative(),
  truncatedFields: z.number().int().nonnegative(),
});

const ProjectionEntrySchema = z.object({
  schemaVersion: z.literal(ProjectionSchemaVersion),
  recordType: z.literal("entry"),
  executionId: z.string().min(1),
  entry: MissionChatEntrySchema,
  truncation: z
    .object({
      truncated: z.literal(true),
      fields: z.array(ProjectionTruncatedFieldSchema).min(1),
    })
    .optional(),
});

type ProjectionHeader = z.infer<typeof ProjectionHeaderSchema>;
type ProjectionEntry = z.infer<typeof ProjectionEntrySchema>;

export class MissionExecutionProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionExecutionProjectionError";
  }
}

export async function readMissionExecutionProjection(
  path: string,
  executionId: string,
): Promise<readonly MissionChatEntry[] | undefined> {
  const metadata = await stat(path).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (metadata === undefined) return undefined;
  if (metadata.size > MISSION_EXECUTION_PROJECTION_MAX_BYTES) {
    throw new MissionExecutionProjectionError(
      `Mission execution projection exceeds ${MISSION_EXECUTION_PROJECTION_MAX_BYTES} bytes.`,
    );
  }

  const endsWithNewline = await fileEndsWithNewline(path, metadata.size);
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let header: ProjectionHeader | undefined;
  const entries: MissionChatEntry[] = [];
  let lineNumber = 0;
  const parseLine = (line: string, finalLine: boolean): void => {
    lineNumber += 1;
    if (line === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      if (finalLine && !endsWithNewline && lineNumber > 1) return;
      throw invalidProjectionRecord(lineNumber, error);
    }
    try {
      if (header === undefined) {
        header = ProjectionHeaderSchema.parse(value);
        if (header.executionId !== executionId) {
          throw new Error(`expected Execution ${executionId}, received ${header.executionId}`);
        }
        return;
      }
      const record = ProjectionEntrySchema.parse(value);
      if (record.executionId !== executionId) {
        throw new Error(`expected Execution ${executionId}, received ${record.executionId}`);
      }
      entries.push(record.entry);
      if (entries.length > MISSION_EXECUTION_PROJECTION_MAX_ENTRIES) {
        throw new Error(`entry count exceeds ${MISSION_EXECUTION_PROJECTION_MAX_ENTRIES}`);
      }
    } catch (error) {
      throw invalidProjectionRecord(lineNumber, error);
    }
  };
  let pendingLine: string | undefined;
  try {
    for await (const line of lines) {
      if (pendingLine !== undefined) parseLine(pendingLine, false);
      pendingLine = line;
    }
    if (pendingLine !== undefined) parseLine(pendingLine, true);
  } finally {
    lines.close();
  }
  if (header === undefined) {
    throw new MissionExecutionProjectionError("Mission execution projection header is missing.");
  }
  return entries;
}

export async function writeMissionExecutionProjection(
  path: string,
  executionId: string,
  entries: readonly MissionChatEntry[],
): Promise<void> {
  const records = createBoundedProjection(executionId, entries);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    for (const record of records) {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    }
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function createBoundedProjection(
  executionId: string,
  entries: readonly MissionChatEntry[],
): readonly [ProjectionHeader, ...ProjectionEntry[]] {
  const parsed = MissionChatEntrySchema.array().parse(entries);
  const bounded = parsed.map((entry) => boundEntry(executionId, entry));
  const maximumRetained = Math.min(bounded.length, MISSION_EXECUTION_PROJECTION_MAX_ENTRIES);
  const firstCandidateIndex = bounded.length - maximumRetained;
  const headerFor = (omittedEntries: number, truncatedFields: number): ProjectionHeader =>
    ProjectionHeaderSchema.parse({
      schemaVersion: ProjectionSchemaVersion,
      recordType: "header",
      executionId,
      createdAt: new Date().toISOString(),
      limits: {
        maxEntries: MISSION_EXECUTION_PROJECTION_MAX_ENTRIES,
        maxBytes: MISSION_EXECUTION_PROJECTION_MAX_BYTES,
        maxContentLength: MISSION_EXECUTION_PROJECTION_MAX_CONTENT_LENGTH,
      },
      omittedEntries,
      truncatedFields,
    });

  const retainedNewestFirst: ProjectionEntry[] = [];
  let retainedBytes = 0;
  let retainedTruncatedFields = 0;
  for (let index = bounded.length - 1; index >= firstCandidateIndex; index -= 1) {
    const candidate = bounded[index]!;
    const candidateBytes = encodedSize([candidate]);
    const candidateTruncatedFields = candidate.truncation?.fields.length ?? 0;
    const nextCount = retainedNewestFirst.length + 1;
    const nextTruncatedFields = retainedTruncatedFields + candidateTruncatedFields;
    const nextHeader = headerFor(bounded.length - nextCount, nextTruncatedFields);
    if (
      encodedSize([nextHeader]) + retainedBytes + candidateBytes >
      MISSION_EXECUTION_PROJECTION_MAX_BYTES
    ) {
      break;
    }
    retainedNewestFirst.push(candidate);
    retainedBytes += candidateBytes;
    retainedTruncatedFields = nextTruncatedFields;
  }
  const retained = retainedNewestFirst.reverse();
  const header = headerFor(bounded.length - retained.length, retainedTruncatedFields);
  if (encodedSize([header]) > MISSION_EXECUTION_PROJECTION_MAX_BYTES) {
    throw new MissionExecutionProjectionError("Mission execution projection header is too large.");
  }
  return [header, ...retained];
}

function boundEntry(executionId: string, entry: MissionChatEntry): ProjectionEntry {
  const fields: Array<z.infer<typeof ProjectionTruncatedFieldSchema>> = [];
  const bounded = { ...entry };
  if (bounded.kind === "user" || bounded.kind === "assistant" || bounded.kind === "thinking") {
    bounded.content = truncateField(
      bounded.content,
      MISSION_EXECUTION_PROJECTION_MAX_CONTENT_LENGTH,
      "content",
      fields,
    );
  } else if (bounded.kind === "tool") {
    if (bounded.inputPreview !== undefined) {
      bounded.inputPreview = truncateField(bounded.inputPreview, 800, "inputPreview", fields);
    }
    if (bounded.outputPreview !== undefined) {
      bounded.outputPreview = truncateField(bounded.outputPreview, 800, "outputPreview", fields);
    }
    if (bounded.error !== undefined) {
      bounded.error = truncateField(
        bounded.error,
        MISSION_EXECUTION_PROJECTION_MAX_ERROR_LENGTH,
        "error",
        fields,
      );
    }
  } else if (bounded.kind === "agent_activity") {
    if (bounded.label !== undefined) {
      bounded.label = truncateField(bounded.label, 500, "label", fields);
    }
    if (bounded.error !== undefined) {
      bounded.error = truncateField(
        bounded.error,
        MISSION_EXECUTION_PROJECTION_MAX_ERROR_LENGTH,
        "error",
        fields,
      );
    }
  } else if (bounded.kind === "context_operation") {
    if (bounded.error !== undefined) {
      bounded.error = truncateField(
        bounded.error,
        MISSION_EXECUTION_PROJECTION_MAX_ERROR_LENGTH,
        "error",
        fields,
      );
    }
  }
  return ProjectionEntrySchema.parse({
    schemaVersion: ProjectionSchemaVersion,
    recordType: "entry",
    executionId,
    entry: bounded,
    ...(fields.length === 0 ? {} : { truncation: { truncated: true, fields } }),
  });
}

function truncateField(
  value: string,
  maximumLength: number,
  field: z.infer<typeof ProjectionTruncatedFieldSchema>["field"],
  truncation: Array<z.infer<typeof ProjectionTruncatedFieldSchema>>,
): string {
  const characters = Array.from(value);
  if (characters.length <= maximumLength) return value;
  truncation.push({ field, originalLength: characters.length });
  return characters.slice(0, maximumLength).join("");
}

function encodedSize(records: readonly (ProjectionHeader | ProjectionEntry)[]): number {
  return records.reduce(
    (size, record) => size + Buffer.byteLength(`${JSON.stringify(record)}\n`),
    0,
  );
}

async function fileEndsWithNewline(path: string, size: number): Promise<boolean> {
  if (size === 0) return false;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, size - 1);
    return buffer[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

function invalidProjectionRecord(lineNumber: number, error: unknown): Error {
  return new MissionExecutionProjectionError(
    `Mission execution projection record ${lineNumber} is invalid: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
