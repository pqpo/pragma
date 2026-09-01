import { open, readFile, truncate } from "node:fs/promises";

import {
  MissionTimelineRecordSchema,
  type MissionTimelineRecord,
  type MissionUserMessage,
} from "../../../shared/contracts/index.ts";
import { MissionStoreError } from "./mission-store-error.ts";

export interface MissionTimelineTurn {
  readonly sequence: number;
  readonly message: MissionUserMessage;
  readonly executionId?: string | undefined;
}

export interface MissionTimelinePage {
  readonly turns: readonly MissionTimelineTurn[];
  readonly oldestSequence?: number | undefined;
  readonly newestSequence?: number | undefined;
  readonly nextBeforeSequence?: number | undefined;
}

export function foldTimeline(records: readonly MissionTimelineRecord[]): MissionTimelineTurn[] {
  const turns: Array<{
    sequence: number;
    message: MissionUserMessage;
    executionId?: string;
  }> = [];
  const byMessageId = new Map<string, (typeof turns)[number]>();
  for (const record of records) {
    if (record.kind === "user") {
      const turn = {
        sequence: record.sequence,
        message: {
          id: record.id,
          content: record.content,
          ...(record.attachments === undefined ? {} : { attachments: record.attachments }),
          createdAt: record.createdAt,
        },
      };
      turns.push(turn);
      byMessageId.set(record.id, turn);
      continue;
    }
    const turn = byMessageId.get(record.inputMessageId);
    if (turn === undefined) {
      throw new MissionStoreError(
        "timeline_invalid",
        `Mission timeline execution ${record.executionId} has no input message.`,
      );
    }
    turn.executionId = record.executionId;
  }
  return turns;
}

export function timelinePageFromTurns(
  turns: readonly MissionTimelineTurn[],
  options: { readonly beforeSequence?: number | undefined; readonly limit: number },
): MissionTimelinePage {
  const eligible =
    options.beforeSequence === undefined
      ? turns
      : turns.filter((turn) => turn.sequence < options.beforeSequence!);
  const start = Math.max(0, eligible.length - options.limit);
  const pageTurns = eligible.slice(start);
  const oldestSequence = pageTurns[0]?.sequence;
  const newestSequence = pageTurns.at(-1)?.sequence;
  return {
    turns: pageTurns,
    ...(oldestSequence === undefined ? {} : { oldestSequence }),
    ...(newestSequence === undefined ? {} : { newestSequence }),
    ...(start > 0 && oldestSequence !== undefined ? { nextBeforeSequence: oldestSequence } : {}),
  };
}

export async function readTimelinePageFromTail(
  file: string,
  options: { readonly beforeSequence?: number | undefined; readonly limit: number },
  cacheCompleteRead: (
    records: readonly MissionTimelineRecord[],
    metadata: { readonly size: number; readonly mtimeMs: number },
  ) => void,
): Promise<MissionTimelinePage> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { turns: [] };
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (metadata.size === 0) {
      cacheCompleteRead([], metadata);
      return { turns: [] };
    }
    const finalByte = Buffer.allocUnsafe(1);
    await handle.read(finalByte, 0, 1, metadata.size - 1);
    if (finalByte[0] !== 0x0a) {
      throw new MissionStoreError(
        "timeline_invalid",
        `Mission timeline has a torn final record: ${file}`,
      );
    }

    const records: MissionTimelineRecord[] = [];
    let remainder = Buffer.alloc(0);
    let position = metadata.size;
    const chunkSize = 64 * 1024;
    while (position > 0) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      await handle.read(chunk, 0, length, position);
      const combined = Buffer.concat([chunk, remainder]);
      let complete = combined;
      if (position > 0) {
        const firstNewline = combined.indexOf(0x0a);
        if (firstNewline === -1) {
          remainder = combined;
          continue;
        }
        remainder = combined.subarray(0, firstNewline);
        complete = combined.subarray(firstNewline + 1);
      } else {
        remainder = Buffer.alloc(0);
      }
      const parsed = complete
        .toString("utf8")
        .split(/\r?\n/u)
        .filter((line) => line.length > 0)
        .map((line) => parseTimelineRecord(line, file));
      records.unshift(...parsed);
      validateTimelineRecordSequence(records, position === 0);
      const userMessageIds = new Set(
        records.flatMap((record) => (record.kind === "user" ? [record.id] : [])),
      );
      const hasMissingExecutionInput = records.some(
        (record) => record.kind === "execution" && !userMessageIds.has(record.inputMessageId),
      );
      if (hasMissingExecutionInput && position > 0) continue;
      const turns = foldTimeline(records);
      if (position === 0) cacheCompleteRead([...records], metadata);
      const eligible =
        options.beforeSequence === undefined
          ? turns
          : turns.filter((turn) => turn.sequence < options.beforeSequence!);
      if (eligible.length > options.limit || position === 0) {
        return timelinePageFromTurns(turns, options);
      }
    }
    return { turns: [] };
  } finally {
    await handle.close();
  }
}

export async function readTimelineRecords(
  file: string,
  repairTornTail: boolean,
): Promise<MissionTimelineRecord[]> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  if (content !== "" && !content.endsWith("\n")) {
    if (!repairTornTail) {
      throw new MissionStoreError(
        "timeline_invalid",
        `Mission timeline has a torn final record: ${file}`,
      );
    }
    const lastNewline = content.lastIndexOf("\n");
    const complete = lastNewline === -1 ? "" : content.slice(0, lastNewline + 1);
    await truncate(file, Buffer.byteLength(complete));
    content = complete;
  }
  const records = content
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => parseTimelineRecord(line, file));
  records.forEach((record, index) => {
    if (record.sequence !== index + 1) {
      throw new MissionStoreError(
        "timeline_invalid",
        `Mission timeline sequence conflict: expected ${index + 1}, received ${record.sequence}.`,
      );
    }
  });
  return records;
}

function parseTimelineRecord(line: string, file: string): MissionTimelineRecord {
  try {
    return MissionTimelineRecordSchema.parse(JSON.parse(line) as unknown);
  } catch (error) {
    throw new MissionStoreError(
      "timeline_invalid",
      `Mission timeline record is invalid in ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateTimelineRecordSequence(
  records: readonly MissionTimelineRecord[],
  includesFileStart: boolean,
): void {
  for (let index = 0; index < records.length; index += 1) {
    const previous = records[index - 1];
    const received = records[index]!.sequence;
    const expected =
      previous === undefined ? (includesFileStart ? 1 : received) : previous.sequence + 1;
    if (received !== expected) {
      throw new MissionStoreError(
        "timeline_invalid",
        `Mission timeline sequence conflict: expected ${expected}, received ${received}.`,
      );
    }
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
