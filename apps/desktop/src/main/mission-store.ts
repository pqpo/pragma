import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock } from "@pragma/core";
import { formatPragmaYaml, parsePragmaYaml } from "@pragma/interpreter";
import { z } from "zod";

import {
  MissionIdSchema,
  MissionSchema,
  MissionTimelineRecordSchema,
  MissionChatEntrySchema,
  MissionUserMessageSchema,
  type Mission,
  type MissionExecutor,
  type MissionModelOverride,
  type MissionSummary,
  type MissionTimelineRecord,
  type MissionChatEntry,
  type MissionUserMessage,
  type DesktopToolPermissionMode,
} from "../shared/desktop-api.ts";

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

export interface MissionStore {
  readonly storagePath?: ((id: string) => string) | undefined;
  readonly forget?: ((id: string) => void) | undefined;
  list(): Promise<MissionSummary[]>;
  get(id: string): Promise<Mission>;
  create(input: {
    readonly workspace: { readonly path: string; readonly basename: string };
    readonly goal: string;
    readonly project: { readonly id: string; readonly revision: number };
    readonly executor: MissionExecutor;
    readonly toolPermissionMode?: DesktopToolPermissionMode | undefined;
    readonly modelOverride?: MissionModelOverride | undefined;
  }): Promise<Mission>;
  updateOptions(
    id: string,
    input: {
      readonly toolPermissionMode: DesktopToolPermissionMode;
      readonly modelOverride?: MissionModelOverride | undefined;
    },
  ): Promise<Mission>;
  updateTitle(
    id: string,
    title: string,
    guard?: { readonly expectedTitle?: string | undefined },
  ): Promise<Mission>;
  updateExecution(
    id: string,
    execution: NonNullable<Mission["execution"]>,
    guard?: {
      readonly executionId?: string | undefined;
      readonly statuses?: readonly NonNullable<Mission["execution"]>["status"][] | undefined;
    },
  ): Promise<Mission>;
  appendUserMessage(id: string, message: MissionUserMessage): Promise<MissionTimelineRecord>;
  appendExecutionReference(input: {
    readonly missionId: string;
    readonly inputMessageId: string;
    readonly executionId: string;
    readonly createdAt: string;
  }): Promise<MissionTimelineRecord>;
  readTimelinePage(
    id: string,
    options: { readonly beforeSequence?: number | undefined; readonly limit: number },
  ): Promise<MissionTimelinePage>;
  markComplete(id: string): Promise<Mission>;
  reopen(id: string): Promise<Mission>;
  remove(id: string): Promise<void>;
  readExecutionProjection(
    id: string,
    executionId: string,
  ): Promise<readonly MissionChatEntry[] | undefined>;
  writeExecutionProjection(
    id: string,
    executionId: string,
    entries: readonly MissionChatEntry[],
  ): Promise<void>;
}

export class MissionStoreError extends Error {
  constructor(
    readonly code:
      | "mission_not_found"
      | "mission_active"
      | "unsupported_schema"
      | "timeline_invalid"
      | "message_conflict"
      | "config_invalid",
    message: string,
  ) {
    super(message);
    this.name = "MissionStoreError";
  }
}

const MessageTransactionSchema = z.object({
  schemaVersion: z.literal("pragma.mission-message-transaction/v1"),
  record: MissionTimelineRecordSchema,
  updatedAt: z.string().datetime(),
});

type MessageTransaction = z.infer<typeof MessageTransactionSchema>;

export function createMissionStore(options: { readonly missionsPath: string }): MissionStore {
  const missionPath = (id: string) => join(options.missionsPath, id);
  const manifestPath = (id: string) => join(missionPath(id), "mission.yaml");
  const messagesPath = (id: string) => join(missionPath(id), "messages.jsonl");
  const transactionPath = (id: string) => join(missionPath(id), ".messages.transaction.json");
  const projectionPath = (id: string, executionId: string) =>
    join(missionPath(id), "execution-projections", `${executionId}.json`);
  const lockPath = (id: string) => join(options.missionsPath, ".locks", `${id}.lock`);
  const timelineCache = new Map<
    string,
    { readonly size: number; readonly mtimeMs: number; readonly records: MissionTimelineRecord[] }
  >();

  const withMissionLock = async <T>(id: string, operation: () => Promise<T>): Promise<T> =>
    await withFileLock(lockPath(id), operation);

  const readRecords = async (
    id: string,
    repairTornTail: boolean,
  ): Promise<MissionTimelineRecord[]> => {
    if (!repairTornTail) {
      const metadata = await stat(messagesPath(id)).catch((error: unknown) => {
        if (isNodeError(error, "ENOENT")) return undefined;
        throw error;
      });
      const cached = timelineCache.get(id);
      if (
        metadata !== undefined &&
        cached?.size === metadata.size &&
        cached.mtimeMs === metadata.mtimeMs
      ) {
        return cached.records;
      }
    }
    const records = await readTimelineRecords(messagesPath(id), repairTornTail);
    const metadata = await stat(messagesPath(id)).catch(() => undefined);
    if (metadata === undefined) timelineCache.delete(id);
    else timelineCache.set(id, { size: metadata.size, mtimeMs: metadata.mtimeMs, records });
    return records;
  };

  const readMissionUnlocked = async (id: string): Promise<Mission> => {
    try {
      const value = parsePragmaYaml(await readFile(manifestPath(id), "utf8"));
      if (readSchemaVersion(value) !== "pragma.mission/v3") {
        throw new MissionStoreError(
          "unsupported_schema",
          `Mission ${id} uses an unsupported schema. Remove the old Mission directory and create a new Mission.`,
        );
      }
      return MissionSchema.parse(value);
    } catch (error) {
      throw normalizeReadError(error, id);
    }
  };

  const recoverMessageTransaction = async (id: string): Promise<void> => {
    const value = await readJsonIfExists(transactionPath(id));
    if (value === undefined) return;
    const transaction = MessageTransactionSchema.parse(value);
    const records = await readRecords(id, true);
    const existing = findSameIdentity(records, transaction.record);
    if (existing === undefined) {
      await appendJsonLine(messagesPath(id), transaction.record);
      timelineCache.delete(id);
    } else if (!sameRecord(existing, transaction.record)) {
      throw messageConflict(transaction.record);
    }
    const mission = await readMissionUnlocked(id);
    if (mission.updatedAt < transaction.updatedAt) {
      await writeYamlAtomically(manifestPath(id), { ...mission, updatedAt: transaction.updatedAt });
    }
    await rm(transactionPath(id), { force: true });
  };

  const readMission = async (id: string): Promise<Mission> =>
    await withMissionLock(id, async () => {
      await recoverMessageTransaction(id);
      return await readMissionUnlocked(id);
    });

  const updateMission = async (
    id: string,
    update: (current: Mission, timestamp: string) => Mission,
  ): Promise<Mission> =>
    await withMissionLock(id, async () => {
      await recoverMessageTransaction(id);
      const current = await readMissionUnlocked(id);
      const timestamp = new Date().toISOString();
      const updated = MissionSchema.parse(update(current, timestamp));
      await writeYamlAtomically(manifestPath(id), updated);
      return updated;
    });

  const appendRecord = async (
    id: string,
    create: (sequence: number, records: readonly MissionTimelineRecord[]) => MissionTimelineRecord,
  ): Promise<MissionTimelineRecord> =>
    await withMissionLock(id, async () => {
      await recoverMessageTransaction(id);
      const mission = await readMissionUnlocked(id);
      const records = await readRecords(id, false);
      const candidate = MissionTimelineRecordSchema.parse(
        create((records.at(-1)?.sequence ?? 0) + 1, records),
      );
      const existing = findSameIdentity(records, candidate);
      if (existing !== undefined) {
        if (!sameRecordIgnoringSequence(existing, candidate)) throw messageConflict(candidate);
        return existing;
      }
      if (
        candidate.kind === "execution" &&
        !records.some((record) => record.kind === "user" && record.id === candidate.inputMessageId)
      ) {
        throw new MissionStoreError(
          "timeline_invalid",
          `Mission execution ${candidate.executionId} references a missing input message.`,
        );
      }
      const updatedAt = new Date().toISOString();
      const transaction = MessageTransactionSchema.parse({
        schemaVersion: "pragma.mission-message-transaction/v1",
        record: candidate,
        updatedAt,
      });
      await writeJsonAtomically(transactionPath(id), transaction);
      await applyMessageTransaction(id, mission, transaction);
      return candidate;
    });

  const applyMessageTransaction = async (
    id: string,
    mission: Mission,
    transaction: MessageTransaction,
  ): Promise<void> => {
    await appendJsonLine(messagesPath(id), transaction.record);
    timelineCache.delete(id);
    await writeYamlAtomically(manifestPath(id), { ...mission, updatedAt: transaction.updatedAt });
    await rm(transactionPath(id), { force: true });
  };

  return {
    storagePath: missionPath,
    forget(id) {
      timelineCache.delete(id);
    },
    async readExecutionProjection(id, executionId) {
      try {
        const value = JSON.parse(await readFile(projectionPath(id, executionId), "utf8")) as {
          readonly schemaVersion?: unknown;
          readonly entries?: unknown;
        };
        if (value.schemaVersion !== "pragma.mission-execution-projection/v1") {
          throw new MissionStoreError(
            "unsupported_schema",
            "Unsupported Mission projection schema.",
          );
        }
        return MissionChatEntrySchema.array().parse(value.entries);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return undefined;
        throw error;
      }
    },
    async writeExecutionProjection(id, executionId, entries) {
      await withMissionLock(MissionIdSchema.parse(id), async () => {
        await readMissionUnlocked(id);
        await writeJsonAtomically(projectionPath(id, executionId), {
          schemaVersion: "pragma.mission-execution-projection/v1",
          executionId,
          entries: MissionChatEntrySchema.array().parse(entries),
          createdAt: new Date().toISOString(),
        });
      });
    },
    async list() {
      try {
        const directories = (await readdir(options.missionsPath, { withFileTypes: true })).filter(
          (entry) => entry.isDirectory() && !entry.name.startsWith("."),
        );
        const missions = await Promise.all(directories.map((entry) => readMission(entry.name)));
        return missions
          .map(toMissionSummary)
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return [];
        throw error;
      }
    },
    async get(id) {
      return await readMission(MissionIdSchema.parse(id));
    },
    async create(input) {
      const id = randomUUID();
      const initialMessageId = randomUUID();
      const timestamp = new Date().toISOString();
      const goal = input.goal.trim();
      const mission = MissionSchema.parse({
        schemaVersion: "pragma.mission/v3",
        id,
        title: titleFromGoal(goal),
        goal,
        initialMessageId,
        toolPermissionMode: input.toolPermissionMode ?? "request-approval",
        workspace: input.workspace,
        project: input.project,
        executor: input.executor,
        ...(input.modelOverride === undefined ? {} : { modelOverride: input.modelOverride }),
        lifecycleStatus: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const firstMessage = MissionTimelineRecordSchema.parse({
        schemaVersion: "pragma.mission-message/v1",
        sequence: 1,
        kind: "user",
        id: initialMessageId,
        content: goal,
        createdAt: timestamp,
      });
      const targetPath = missionPath(id);
      const temporaryPath = join(options.missionsPath, `.${id}.${randomUUID()}.tmp`);
      await mkdir(temporaryPath, { recursive: true, mode: 0o700 });
      try {
        await writeFile(join(temporaryPath, "mission.yaml"), formatPragmaYaml(mission), {
          mode: 0o600,
        });
        await writeFile(
          join(temporaryPath, "messages.jsonl"),
          `${JSON.stringify(firstMessage)}\n`,
          {
            mode: 0o600,
          },
        );
        await mkdir(options.missionsPath, { recursive: true, mode: 0o700 });
        await rename(temporaryPath, targetPath);
      } catch (error) {
        await rm(temporaryPath, { recursive: true, force: true });
        throw error;
      }
      return mission;
    },
    async updateOptions(id, input) {
      return await updateMission(MissionIdSchema.parse(id), (current, timestamp) => {
        if (
          current.execution !== undefined &&
          ["queued", "running", "waiting"].includes(current.execution.status)
        ) {
          throw new MissionStoreError(
            "mission_active",
            "Wait for the current execution before changing mission options.",
          );
        }
        const next = {
          ...current,
          toolPermissionMode: input.toolPermissionMode,
          updatedAt: timestamp,
        };
        if (input.modelOverride === undefined) delete next.modelOverride;
        else next.modelOverride = input.modelOverride;
        return next;
      });
    },
    async updateTitle(id, title, guard) {
      const normalizedTitle = normalizeMissionTitle(title);
      return await updateMission(MissionIdSchema.parse(id), (current, timestamp) => {
        if (guard?.expectedTitle !== undefined && current.title !== guard.expectedTitle) {
          return current;
        }
        return { ...current, title: normalizedTitle, updatedAt: timestamp };
      });
    },
    async updateExecution(id, execution, guard) {
      return await updateMission(MissionIdSchema.parse(id), (current, timestamp) => {
        if (guard?.executionId !== undefined && current.execution?.id !== guard.executionId) {
          return current;
        }
        if (
          guard?.statuses !== undefined &&
          (current.execution === undefined || !guard.statuses.includes(current.execution.status))
        ) {
          return current;
        }
        return { ...current, execution, updatedAt: timestamp };
      });
    },
    async appendUserMessage(id, message) {
      const parsedId = MissionIdSchema.parse(id);
      const parsedMessage = MissionUserMessageSchema.parse(message);
      return await appendRecord(parsedId, (sequence) => ({
        schemaVersion: "pragma.mission-message/v1",
        sequence,
        kind: "user",
        ...parsedMessage,
      }));
    },
    async appendExecutionReference(input) {
      const missionId = MissionIdSchema.parse(input.missionId);
      return await appendRecord(missionId, (sequence) => ({
        schemaVersion: "pragma.mission-message/v1",
        sequence,
        kind: "execution",
        inputMessageId: MissionIdSchema.parse(input.inputMessageId),
        executionId: MissionIdSchema.parse(input.executionId),
        createdAt: z.string().datetime().parse(input.createdAt),
      }));
    },
    async readTimelinePage(id, pageOptions) {
      const parsedId = MissionIdSchema.parse(id);
      return await withMissionLock(parsedId, async () => {
        await recoverMessageTransaction(parsedId);
        await readMissionUnlocked(parsedId);
        const records = await readRecords(parsedId, false);
        const turns = foldTimeline(records);
        const eligible =
          pageOptions.beforeSequence === undefined
            ? turns
            : turns.filter((turn) => turn.sequence < pageOptions.beforeSequence!);
        const start = Math.max(0, eligible.length - pageOptions.limit);
        const pageTurns = eligible.slice(start);
        const oldestSequence = pageTurns[0]?.sequence;
        const newestSequence = pageTurns.at(-1)?.sequence;
        return {
          turns: pageTurns,
          ...(oldestSequence === undefined ? {} : { oldestSequence }),
          ...(newestSequence === undefined ? {} : { newestSequence }),
          ...(start > 0 && oldestSequence !== undefined
            ? { nextBeforeSequence: oldestSequence }
            : {}),
        };
      });
    },
    async markComplete(id) {
      return await updateMission(MissionIdSchema.parse(id), (current, timestamp) => ({
        ...current,
        lifecycleStatus: "completed",
        completedAt: timestamp,
        updatedAt: timestamp,
      }));
    },
    async reopen(id) {
      return await updateMission(MissionIdSchema.parse(id), (current, timestamp) => {
        const mission = { ...current };
        delete mission.completedAt;
        return { ...mission, lifecycleStatus: "active", updatedAt: timestamp };
      });
    },
    async remove(id) {
      const parsedId = MissionIdSchema.parse(id);
      await withMissionLock(parsedId, async () => {
        await recoverMessageTransaction(parsedId);
        const current = await readMissionUnlocked(parsedId);
        if (
          current.execution !== undefined &&
          ["queued", "running", "waiting"].includes(current.execution.status)
        ) {
          throw new MissionStoreError(
            "mission_active",
            "Stop the active execution before deleting this mission.",
          );
        }
        await rm(missionPath(parsedId), { recursive: true, force: true });
        timelineCache.delete(parsedId);
      });
    },
  };
}

function toMissionSummary(mission: Mission): MissionSummary {
  return {
    id: mission.id,
    title: mission.title,
    workspace: { basename: mission.workspace.basename },
    executor: { kind: mission.executor.kind, name: mission.executor.name },
    ...(mission.execution === undefined ? {} : { execution: { status: mission.execution.status } }),
    lifecycleStatus: mission.lifecycleStatus,
    updatedAt: mission.updatedAt,
  };
}

function foldTimeline(records: readonly MissionTimelineRecord[]): MissionTimelineTurn[] {
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
    // Recovery may replace an interrupted execution while keeping the same visible user turn.
    turn.executionId = record.executionId;
  }
  return turns;
}

async function readTimelineRecords(
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
    .map((line, index) => {
      try {
        return MissionTimelineRecordSchema.parse(JSON.parse(line) as unknown);
      } catch (error) {
        throw new MissionStoreError(
          "timeline_invalid",
          `Mission timeline record ${index + 1} is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
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

async function appendJsonLine(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeYamlAtomically(path: string, value: unknown): Promise<void> {
  await writeTextAtomically(path, formatPragmaYaml(value));
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await writeTextAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function findSameIdentity(
  records: readonly MissionTimelineRecord[],
  candidate: MissionTimelineRecord,
): MissionTimelineRecord | undefined {
  return records.find((record) =>
    candidate.kind === "user"
      ? record.kind === "user" && record.id === candidate.id
      : record.kind === "execution" && record.executionId === candidate.executionId,
  );
}

function sameRecord(left: MissionTimelineRecord, right: MissionTimelineRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameRecordIgnoringSequence(
  left: MissionTimelineRecord,
  right: MissionTimelineRecord,
): boolean {
  return JSON.stringify(withoutSequence(left)) === JSON.stringify(withoutSequence(right));
}

function withoutSequence(record: MissionTimelineRecord): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== "sequence"));
}

function messageConflict(record: MissionTimelineRecord): MissionStoreError {
  const id = record.kind === "user" ? record.id : record.executionId;
  return new MissionStoreError(
    "message_conflict",
    `Mission timeline idempotency conflict for ${id}.`,
  );
}

function titleFromGoal(goal: string): string {
  const firstLine = goal.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return normalizeMissionTitle(firstLine);
}

export const MISSION_TITLE_MAX_LENGTH = 48;

export function normalizeMissionTitle(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  const characters = Array.from(compact);
  if (characters.length === 0) throw new Error("Mission title cannot be empty.");
  if (characters.length <= MISSION_TITLE_MAX_LENGTH) return compact;
  return `${characters
    .slice(0, MISSION_TITLE_MAX_LENGTH - 1)
    .join("")
    .trimEnd()}…`;
}

function readSchemaVersion(value: unknown): unknown {
  return typeof value === "object" && value !== null && "schemaVersion" in value
    ? value.schemaVersion
    : undefined;
}

function normalizeReadError(error: unknown, id: string): MissionStoreError {
  if (error instanceof MissionStoreError) return error;
  if (isNodeError(error, "ENOENT")) {
    return new MissionStoreError("mission_not_found", `Mission ${id} was not found.`);
  }
  return new MissionStoreError(
    "config_invalid",
    error instanceof Error ? error.message : `Mission ${id} is invalid.`,
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
