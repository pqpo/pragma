import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";

import { z } from "zod";

import { MissionChatEntrySchema, type MissionChatEntry } from "../../../shared/contracts/index.ts";

export const MISSION_EXECUTION_PROJECTION_MAX_ENTRIES = 1_000;
export const MISSION_EXECUTION_PROJECTION_MAX_BYTES = 4 * 1024 * 1024;
export const MISSION_EXECUTION_PROJECTION_MAX_CONTENT_LENGTH = 32_000;
export const MISSION_EXECUTION_PROJECTION_MAX_ERROR_LENGTH = 4_000;

const DEFAULT_SYNCHRONOUS_BUILD_BUDGET_MS = 4;
const PROJECTION_WRITE_BATCH_BYTES = 256 * 1024;

const ProjectionSchemaVersion = "pragma.mission-execution-projection/v2";
export const MISSION_EXECUTION_PROJECTION_ORDERING_VERSION = 3 as const;

const ProjectionOrderingVersionSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(MISSION_EXECUTION_PROJECTION_ORDERING_VERSION),
]);
type ProjectionOrderingVersion = z.infer<typeof ProjectionOrderingVersionSchema>;

const ProjectionTruncatedFieldSchema = z.object({
  field: z.enum(["content", "inputPreview", "outputPreview", "error", "label"]),
  originalLength: z.number().int().positive(),
});

const ProjectionHeaderSchema = z.object({
  schemaVersion: z.literal(ProjectionSchemaVersion),
  recordType: z.literal("header"),
  orderingVersion: ProjectionOrderingVersionSchema.optional(),
  executionId: z.string().min(1),
  createdAt: z.string().datetime(),
  sourceUpdatedAt: z.string().datetime().optional(),
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

export interface MissionExecutionProjectionWriteMetrics {
  readonly inputEntries: number;
  readonly candidateEntries: number;
  readonly retainedEntries: number;
  readonly encodedBytes: number;
  readonly queueWaitMs: number;
  readonly validationMs: number;
  readonly boundingAndEncodingMs: number;
  readonly buildWallMs: number;
  readonly synchronousBuildMs: number;
  readonly maximumSynchronousSliceMs: number;
  readonly yieldCount: number;
  readonly yieldWaitMs: number;
  readonly fileWriteMs: number;
  readonly totalMs: number;
}

export interface MissionExecutionProjectionWriteOptions {
  readonly synchronousBuildBudgetMs?: number | undefined;
  readonly onMetrics?: ((metrics: MissionExecutionProjectionWriteMetrics) => void) | undefined;
}

interface EncodedProjection {
  readonly lines: readonly EncodedProjectionLine[];
  readonly encodedBytes: number;
  readonly validatedEntries?: readonly MissionChatEntry[] | undefined;
  readonly metrics: Pick<
    MissionExecutionProjectionWriteMetrics,
    | "inputEntries"
    | "candidateEntries"
    | "retainedEntries"
    | "validationMs"
    | "boundingAndEncodingMs"
    | "buildWallMs"
    | "synchronousBuildMs"
    | "maximumSynchronousSliceMs"
    | "yieldCount"
    | "yieldWaitMs"
  >;
}

interface EncodedProjectionLine {
  readonly value: string;
  readonly bytes: number;
}

const projectionWrites = new Map<string, Promise<readonly MissionChatEntry[] | undefined>>();

export class MissionExecutionProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionExecutionProjectionError";
  }
}

export interface MissionExecutionProjectionPage {
  readonly entries: readonly MissionChatEntry[];
  readonly createdAt: string;
  readonly sourceUpdatedAt?: string | undefined;
  readonly orderingVersion: ProjectionOrderingVersion;
  readonly omittedEntries: number;
  readonly truncatedFields: number;
  readonly nextBeforeOffset?: number | undefined;
}

export async function readMissionExecutionProjectionOrderingVersion(
  path: string,
  executionId: string,
): Promise<ProjectionOrderingVersion | undefined> {
  const handle = await open(path, "r").catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (handle === undefined) return undefined;
  try {
    const metadata = await handle.stat();
    return (await readProjectionHeader(handle, metadata.size, executionId)).orderingVersion;
  } finally {
    await handle.close();
  }
}

export async function readMissionExecutionProjectionPage(
  path: string,
  executionId: string,
  input: { readonly beforeOffset?: number | undefined; readonly limit: number },
): Promise<MissionExecutionProjectionPage | undefined> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
    throw new MissionExecutionProjectionError(
      "Mission execution projection page limit is invalid.",
    );
  }
  const handle = await open(path, "r").catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (handle === undefined) return undefined;
  try {
    const metadata = await handle.stat();
    if (metadata.size > MISSION_EXECUTION_PROJECTION_MAX_BYTES) {
      throw new MissionExecutionProjectionError(
        `Mission execution projection exceeds ${MISSION_EXECUTION_PROJECTION_MAX_BYTES} bytes.`,
      );
    }
    const header = await readProjectionHeader(handle, metadata.size, executionId);
    const requestedEnd = input.beforeOffset ?? metadata.size;
    if (
      !Number.isInteger(requestedEnd) ||
      requestedEnd < header.entriesOffset ||
      requestedEnd > metadata.size
    ) {
      throw new MissionExecutionProjectionError(
        "Mission execution projection page cursor is invalid.",
      );
    }
    if (requestedEnd !== metadata.size && requestedEnd > header.entriesOffset) {
      const preceding = Buffer.allocUnsafe(1);
      await handle.read(preceding, 0, 1, requestedEnd - 1);
      if (preceding[0] !== 0x0a) {
        throw new MissionExecutionProjectionError(
          "Mission execution projection page cursor is not on a record boundary.",
        );
      }
    }
    const page = await readProjectionRecordsBackward(
      handle,
      header.entriesOffset,
      requestedEnd,
      input.limit,
      executionId,
    );
    return {
      entries: page.entries,
      createdAt: header.createdAt,
      ...(header.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: header.sourceUpdatedAt }),
      orderingVersion: header.orderingVersion,
      omittedEntries: header.omittedEntries,
      truncatedFields: header.truncatedFields,
      ...(page.nextBeforeOffset === undefined ? {} : { nextBeforeOffset: page.nextBeforeOffset }),
    };
  } finally {
    await handle.close();
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
  orderingVersion: ProjectionOrderingVersion = MISSION_EXECUTION_PROJECTION_ORDERING_VERSION,
  sourceUpdatedAt?: string,
  options: MissionExecutionProjectionWriteOptions = {},
): Promise<void> {
  await enqueueMissionExecutionProjectionWrite(
    path,
    executionId,
    entries,
    orderingVersion,
    sourceUpdatedAt,
    options,
    false,
  );
}

export async function migrateLegacyMissionExecutionProjection(
  path: string,
  executionId: string,
  entries: unknown,
  options: MissionExecutionProjectionWriteOptions = {},
): Promise<readonly MissionChatEntry[]> {
  if (!Array.isArray(entries)) {
    MissionChatEntrySchema.array().parse(entries);
    throw new MissionExecutionProjectionError("Legacy Mission projection entries are invalid.");
  }
  const validated = await enqueueMissionExecutionProjectionWrite(
    path,
    executionId,
    entries,
    1,
    undefined,
    options,
    true,
  );
  if (validated === undefined) {
    throw new MissionExecutionProjectionError(
      "Legacy Mission execution projection validation did not return entries.",
    );
  }
  return validated;
}

async function enqueueMissionExecutionProjectionWrite(
  path: string,
  executionId: string,
  entries: readonly unknown[],
  orderingVersion: ProjectionOrderingVersion,
  sourceUpdatedAt: string | undefined,
  options: MissionExecutionProjectionWriteOptions,
  collectValidatedEntries: boolean,
): Promise<readonly MissionChatEntry[] | undefined> {
  const requestedAt = performance.now();
  const previousWrite = projectionWrites.get(path) ?? Promise.resolve();
  const write = previousWrite
    .catch(() => undefined)
    .then(
      async () =>
        await performMissionExecutionProjectionWrite(
          path,
          executionId,
          entries,
          orderingVersion,
          sourceUpdatedAt,
          options,
          requestedAt,
          collectValidatedEntries,
        ),
    );
  projectionWrites.set(path, write);
  try {
    return await write;
  } finally {
    if (projectionWrites.get(path) === write) projectionWrites.delete(path);
  }
}

async function performMissionExecutionProjectionWrite(
  path: string,
  executionId: string,
  entries: readonly unknown[],
  orderingVersion: ProjectionOrderingVersion,
  sourceUpdatedAt: string | undefined,
  options: MissionExecutionProjectionWriteOptions,
  requestedAt: number,
  collectValidatedEntries: boolean,
): Promise<readonly MissionChatEntry[] | undefined> {
  const startedAt = performance.now();
  const budgetMs = options.synchronousBuildBudgetMs ?? DEFAULT_SYNCHRONOUS_BUILD_BUDGET_MS;
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new MissionExecutionProjectionError(
      "Mission execution projection synchronous build budget is invalid.",
    );
  }
  const projection = await createBoundedProjection(
    executionId,
    entries,
    orderingVersion,
    sourceUpdatedAt,
    budgetMs,
    collectValidatedEntries,
  );
  const fileWriteStartedAt = performance.now();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  let completedAt: number;
  try {
    let batch: string[] = [];
    let batchBytes = 0;
    for (const line of projection.lines) {
      if (batch.length > 0 && batchBytes + line.bytes > PROJECTION_WRITE_BATCH_BYTES) {
        await handle.writeFile(batch.join(""), "utf8");
        batch = [];
        batchBytes = 0;
      }
      batch.push(line.value);
      batchBytes += line.bytes;
    }
    if (batch.length > 0) await handle.writeFile(batch.join(""), "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, path);
    completedAt = performance.now();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true });
    throw error;
  }
  try {
    options.onMetrics?.({
      ...projection.metrics,
      encodedBytes: projection.encodedBytes,
      queueWaitMs: startedAt - requestedAt,
      fileWriteMs: completedAt - fileWriteStartedAt,
      totalMs: completedAt - requestedAt,
    });
  } catch {
    // Diagnostics must not turn a durable successful rename into a failed write.
  }
  return projection.validatedEntries;
}

async function readProjectionHeader(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  executionId: string,
): Promise<{
  readonly entriesOffset: number;
  readonly createdAt: string;
  readonly sourceUpdatedAt?: string | undefined;
  readonly orderingVersion: ProjectionOrderingVersion;
  readonly omittedEntries: number;
  readonly truncatedFields: number;
}> {
  const maximumHeaderBytes = Math.min(size, 64 * 1024);
  const bytes = Buffer.allocUnsafe(maximumHeaderBytes);
  const { bytesRead } = await handle.read(bytes, 0, maximumHeaderBytes, 0);
  const newline = bytes.subarray(0, bytesRead).indexOf(0x0a);
  if (newline < 0) {
    throw new MissionExecutionProjectionError("Mission execution projection header is missing.");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.subarray(0, newline).toString("utf8")) as unknown;
  } catch (error) {
    throw invalidProjectionRecord(1, error);
  }
  let header: ProjectionHeader;
  try {
    header = ProjectionHeaderSchema.parse(value);
    if (header.executionId !== executionId) {
      throw new Error(`expected Execution ${executionId}, received ${header.executionId}`);
    }
  } catch (error) {
    throw invalidProjectionRecord(1, error);
  }
  return {
    entriesOffset: newline + 1,
    createdAt: header.createdAt,
    ...(header.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: header.sourceUpdatedAt }),
    orderingVersion: header.orderingVersion ?? 1,
    omittedEntries: header.omittedEntries,
    truncatedFields: header.truncatedFields,
  };
}

async function readProjectionRecordsBackward(
  handle: Awaited<ReturnType<typeof open>>,
  entriesOffset: number,
  end: number,
  limit: number,
  executionId: string,
): Promise<{
  readonly entries: readonly MissionChatEntry[];
  readonly nextBeforeOffset?: number | undefined;
}> {
  const chunkSize = 64 * 1024;
  let position = end;
  let buffered = Buffer.alloc(0);
  let ranges: Array<{ readonly start: number; readonly end: number }> = [];

  while (position > entriesOffset) {
    const start = Math.max(entriesOffset, position - chunkSize);
    const chunk = Buffer.allocUnsafe(position - start);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
    buffered = Buffer.concat([chunk.subarray(0, bytesRead), buffered]);
    position = start;
    ranges = completeLineRanges(buffered, position, position === entriesOffset);
    if (ranges.length >= limit || position === entriesOffset) break;
  }

  const selected = ranges.slice(-limit);
  const entries = selected.map((range, index) => {
    const relativeStart = range.start - position;
    const relativeEnd = range.end - position;
    try {
      const record = ProjectionEntrySchema.parse(
        JSON.parse(buffered.subarray(relativeStart, relativeEnd).toString("utf8")) as unknown,
      );
      if (record.executionId !== executionId) {
        throw new Error(`expected Execution ${executionId}, received ${record.executionId}`);
      }
      return record.entry;
    } catch (error) {
      throw invalidProjectionRecord(index + 2, error);
    }
  });
  const selectedStart = selected[0]?.start;
  return {
    entries,
    ...(selectedStart !== undefined && selectedStart > entriesOffset
      ? { nextBeforeOffset: selectedStart }
      : {}),
  };
}

function completeLineRanges(
  buffer: Buffer,
  absoluteStart: number,
  startsOnBoundary: boolean,
): Array<{ readonly start: number; readonly end: number }> {
  const ranges: Array<{ readonly start: number; readonly end: number }> = [];
  let lineStart = 0;
  let firstCompleteLine = startsOnBoundary;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    if (firstCompleteLine && index > lineStart) {
      ranges.push({ start: absoluteStart + lineStart, end: absoluteStart + index });
    }
    firstCompleteLine = true;
    lineStart = index + 1;
  }
  return ranges;
}

async function createBoundedProjection(
  executionId: string,
  entries: readonly unknown[],
  orderingVersion: ProjectionOrderingVersion,
  sourceUpdatedAt?: string,
  synchronousBudgetMs = DEFAULT_SYNCHRONOUS_BUILD_BUDGET_MS,
  collectValidatedEntries = false,
): Promise<EncodedProjection> {
  const buildStartedAt = performance.now();
  // Even a small projection starts on a later event-loop turn. A Promise or async
  // declaration alone would still execute the validation synchronously here.
  await yieldToEventLoop();
  const budget = new SynchronousWorkBudget(synchronousBudgetMs);
  const maximumRetained = Math.min(entries.length, MISSION_EXECUTION_PROJECTION_MAX_ENTRIES);
  const firstCandidateIndex = entries.length - maximumRetained;
  const candidates: MissionChatEntry[] = [];
  const validatedEntries: MissionChatEntry[] | undefined = collectValidatedEntries ? [] : undefined;
  const validationIssues: z.core.$ZodIssue[] = [];
  const validationStartedAt = performance.now();
  for (let index = 0; index < entries.length; index += 1) {
    const parsed = MissionChatEntrySchema.safeParse(entries[index]);
    if (parsed.success) {
      validatedEntries?.push(parsed.data);
      if (index >= firstCandidateIndex) candidates.push(parsed.data);
    } else {
      validationIssues.push(
        ...parsed.error.issues.map((issue) => ({ ...issue, path: [index, ...issue.path] })),
      );
    }
    await budget.checkpoint();
  }
  if (validationIssues.length > 0) throw new z.ZodError(validationIssues);
  const validationMs = performance.now() - validationStartedAt;
  const boundingStartedAt = performance.now();
  const buildStartedAtIso = new Date().toISOString();
  const headerFor = (
    omittedEntries: number,
    truncatedFields: number,
    createdAt = buildStartedAtIso,
  ): ProjectionHeader =>
    ({
      schemaVersion: ProjectionSchemaVersion,
      recordType: "header",
      orderingVersion,
      executionId,
      createdAt,
      ...(sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt }),
      limits: {
        maxEntries: MISSION_EXECUTION_PROJECTION_MAX_ENTRIES,
        maxBytes: MISSION_EXECUTION_PROJECTION_MAX_BYTES,
        maxContentLength: MISSION_EXECUTION_PROJECTION_MAX_CONTENT_LENGTH,
      },
      omittedEntries,
      truncatedFields,
    }) satisfies ProjectionHeader;

  // Validate header-owned caller input once. Candidate records are constructed
  // exclusively from entries already accepted by MissionChatEntrySchema.
  ProjectionHeaderSchema.parse(headerFor(entries.length, 0));

  const retainedNewestFirst: EncodedProjectionLine[] = [];
  let retainedBytes = 0;
  let retainedTruncatedFields = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = await boundEntry(executionId, candidates[index]!, budget);
    const line = `${JSON.stringify(candidate)}\n`;
    const candidateBytes = Buffer.byteLength(line);
    const candidateTruncatedFields = candidate.truncation?.fields.length ?? 0;
    const nextCount = retainedNewestFirst.length + 1;
    const nextTruncatedFields = retainedTruncatedFields + candidateTruncatedFields;
    const nextHeader = `${JSON.stringify(
      headerFor(entries.length - nextCount, nextTruncatedFields),
    )}\n`;
    if (
      Buffer.byteLength(nextHeader) + retainedBytes + candidateBytes >
      MISSION_EXECUTION_PROJECTION_MAX_BYTES
    ) {
      break;
    }
    retainedNewestFirst.push({ value: line, bytes: candidateBytes });
    retainedBytes += candidateBytes;
    retainedTruncatedFields = nextTruncatedFields;
    await budget.checkpoint();
  }
  const retained = retainedNewestFirst.reverse();
  const headerLine = `${JSON.stringify(
    headerFor(entries.length - retained.length, retainedTruncatedFields, new Date().toISOString()),
  )}\n`;
  const headerBytes = Buffer.byteLength(headerLine);
  if (headerBytes > MISSION_EXECUTION_PROJECTION_MAX_BYTES) {
    throw new MissionExecutionProjectionError("Mission execution projection header is too large.");
  }
  budget.finish();
  const boundingAndEncodingMs = performance.now() - boundingStartedAt;
  return {
    lines: [{ value: headerLine, bytes: headerBytes }, ...retained],
    encodedBytes: headerBytes + retained.reduce((sum, candidate) => sum + candidate.bytes, 0),
    ...(validatedEntries === undefined ? {} : { validatedEntries }),
    metrics: {
      inputEntries: entries.length,
      candidateEntries: candidates.length,
      retainedEntries: retained.length,
      validationMs,
      boundingAndEncodingMs,
      buildWallMs: performance.now() - buildStartedAt,
      synchronousBuildMs: budget.synchronousMs,
      maximumSynchronousSliceMs: budget.maximumSliceMs,
      yieldCount: budget.yieldCount,
      yieldWaitMs: budget.yieldWaitMs,
    },
  };
}

async function boundEntry(
  executionId: string,
  entry: MissionChatEntry,
  budget: SynchronousWorkBudget,
): Promise<ProjectionEntry> {
  const fields: Array<z.infer<typeof ProjectionTruncatedFieldSchema>> = [];
  const bounded = { ...entry };
  if (bounded.kind === "user" || bounded.kind === "assistant" || bounded.kind === "thinking") {
    bounded.content = await truncateField(
      bounded.content,
      MISSION_EXECUTION_PROJECTION_MAX_CONTENT_LENGTH,
      "content",
      fields,
      budget,
    );
  } else if (bounded.kind === "tool") {
    if (bounded.inputPreview !== undefined) {
      bounded.inputPreview = await truncateField(
        bounded.inputPreview,
        800,
        "inputPreview",
        fields,
        budget,
      );
    }
    if (bounded.outputPreview !== undefined) {
      bounded.outputPreview = await truncateField(
        bounded.outputPreview,
        800,
        "outputPreview",
        fields,
        budget,
      );
    }
    if (bounded.error !== undefined) {
      bounded.error = await truncateField(
        bounded.error,
        MISSION_EXECUTION_PROJECTION_MAX_ERROR_LENGTH,
        "error",
        fields,
        budget,
      );
    }
  } else if (bounded.kind === "agent_activity") {
    if (bounded.label !== undefined) {
      bounded.label = await truncateField(bounded.label, 500, "label", fields, budget);
    }
    if (bounded.error !== undefined) {
      bounded.error = await truncateField(
        bounded.error,
        MISSION_EXECUTION_PROJECTION_MAX_ERROR_LENGTH,
        "error",
        fields,
        budget,
      );
    }
  } else if (bounded.kind === "context_operation") {
    if (bounded.error !== undefined) {
      bounded.error = await truncateField(
        bounded.error,
        MISSION_EXECUTION_PROJECTION_MAX_ERROR_LENGTH,
        "error",
        fields,
        budget,
      );
    }
  }
  return {
    schemaVersion: ProjectionSchemaVersion,
    recordType: "entry",
    executionId,
    entry: bounded,
    ...(fields.length === 0 ? {} : { truncation: { truncated: true, fields } }),
  } satisfies ProjectionEntry;
}

async function truncateField(
  value: string,
  maximumLength: number,
  field: z.infer<typeof ProjectionTruncatedFieldSchema>["field"],
  truncation: Array<z.infer<typeof ProjectionTruncatedFieldSchema>>,
  budget: SynchronousWorkBudget,
): Promise<string> {
  if (value.length <= maximumLength) return value;
  let codePoints = 0;
  let end = value.length;
  let unitsSinceCheckpoint = 0;
  for (let offset = 0; offset < value.length;) {
    if (codePoints === maximumLength) end = offset;
    const width = value.codePointAt(offset)! > 0xffff ? 2 : 1;
    offset += width;
    unitsSinceCheckpoint += width;
    codePoints += 1;
    if (unitsSinceCheckpoint >= 4_096) {
      unitsSinceCheckpoint = 0;
      await budget.checkpoint();
    }
  }
  if (codePoints <= maximumLength) return value;
  truncation.push({ field, originalLength: codePoints });
  return value.slice(0, end);
}

class SynchronousWorkBudget {
  #sliceStartedAt = performance.now();
  #finished = false;
  synchronousMs = 0;
  maximumSliceMs = 0;
  yieldCount = 0;
  yieldWaitMs = 0;

  constructor(readonly maximumSliceBudgetMs: number) {}

  async checkpoint(): Promise<void> {
    const now = performance.now();
    const elapsed = now - this.#sliceStartedAt;
    if (elapsed < this.maximumSliceBudgetMs) return;
    this.#recordSlice(elapsed);
    this.yieldCount += 1;
    const yieldStartedAt = performance.now();
    await yieldToEventLoop();
    const resumedAt = performance.now();
    this.yieldWaitMs += resumedAt - yieldStartedAt;
    this.#sliceStartedAt = resumedAt;
  }

  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#recordSlice(performance.now() - this.#sliceStartedAt);
  }

  #recordSlice(elapsed: number): void {
    this.synchronousMs += elapsed;
    this.maximumSliceMs = Math.max(this.maximumSliceMs, elapsed);
  }
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
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
