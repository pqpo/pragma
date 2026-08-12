import { randomUUID } from "node:crypto";
import {
  mkdir,
  copyFile,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";

import { withFileLock } from "@pragma/core";
import type { ExpertPromptAttachment } from "@pragma/shared";
import {
  formatPragmaYaml,
  migrateLegacyPragmaResourceRef,
  parsePragmaYaml,
} from "@pragma/interpreter";
import { z } from "zod";

import {
  MissionIdSchema,
  MissionSchema,
  MissionV3Schema,
  MissionV4Schema,
  MissionV5Schema,
  MissionV6Schema,
  MissionTimelineRecordSchema,
  MissionAttachmentsManifestSchema,
  MissionChatEntrySchema,
  MissionUserMessageSchema,
  type Mission,
  type MissionExecutor,
  type MissionModelOverride,
  type MissionSummary,
  type MissionTimelineRecord,
  type MissionChatEntry,
  type MissionUserMessage,
  type MissionAttachmentsManifest,
  type DesktopToolPermissionMode,
} from "../../../shared/contracts/index.ts";
import {
  MissionExecutionProjectionError,
  readMissionExecutionProjection,
  writeMissionExecutionProjection,
} from "./mission-execution-projection.ts";

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
  resolveExecutionTitles(executionIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  get(id: string): Promise<Mission>;
  getAttachments(id: string): Promise<readonly ExpertPromptAttachment[]>;
  create(input: {
    readonly id?: string | undefined;
    readonly workspace: { readonly path: string; readonly basename: string };
    readonly goal: string;
    readonly title?: string | undefined;
    readonly flowInput?: Readonly<Record<string, unknown>> | undefined;
    readonly project: { readonly id: string; readonly revision: number };
    readonly executor: MissionExecutor;
    readonly attachments?: readonly ExpertPromptAttachment[] | undefined;
    readonly toolPermissionMode?: DesktopToolPermissionMode | undefined;
    readonly modelOverride?: MissionModelOverride | undefined;
    readonly origin?: Mission["origin"] | undefined;
  }): Promise<Mission>;
  updateOptions(
    id: string,
    input: {
      readonly toolPermissionMode: DesktopToolPermissionMode;
      readonly modelOverride?: MissionModelOverride | undefined;
    },
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
      | "projection_invalid"
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

const UserMessageAttachmentsTransactionSchema = z.object({
  schemaVersion: z.literal("pragma.mission-user-message-attachments-transaction/v1"),
  baseAttachments: MissionAttachmentsManifestSchema,
  targetAttachments: MissionAttachmentsManifestSchema,
  record: MissionTimelineRecordSchema,
  updatedAt: z.string().datetime(),
});

type UserMessageAttachmentsTransaction = z.infer<typeof UserMessageAttachmentsTransactionSchema>;

const MissionV7MigrationTransactionSchema = z.object({
  schemaVersion: z.literal("pragma.mission-v7-migration/v1"),
  missionId: MissionIdSchema,
  target: MissionSchema,
});

export function createMissionStore(options: { readonly missionsPath: string }): MissionStore {
  const missionPath = (id: string) => join(options.missionsPath, id);
  const manifestPath = (id: string) => join(missionPath(id), "mission.yaml");
  const messagesPath = (id: string) => join(missionPath(id), "messages.jsonl");
  const attachmentsPath = (id: string) => join(missionPath(id), "attachments.json");
  const transactionPath = (id: string) => join(missionPath(id), ".messages.transaction.json");
  const userMessageAttachmentsTransactionPath = (id: string) =>
    join(missionPath(id), ".user-message-attachments.transaction.json");
  const userMessageAttachmentsStagingPath = (id: string, messageId: string) =>
    join(missionPath(id), `.user-message-${messageId}.attachments.tmp`);
  const v7MigrationTransactionPath = (id: string) =>
    join(missionPath(id), ".v6-to-v7.transaction.json");
  const v6BackupPath = (id: string) =>
    join(missionPath(id), "migration-backups", "mission.v6.yaml");
  const legacyProjectionPath = (id: string, executionId: string) =>
    join(missionPath(id), "execution-projections", `${executionId}.json`);
  const projectionPath = (id: string, executionId: string) =>
    join(missionPath(id), "execution-projections", `${executionId}.jsonl`);
  const lockPath = (id: string) => join(options.missionsPath, ".locks", `${id}.lock`);
  const timelineCache = new Map<
    string,
    { readonly size: number; readonly mtimeMs: number; readonly records: MissionTimelineRecord[] }
  >();
  const executionTitleIndex = new Map<
    string,
    { readonly missionId: string; readonly title: string }
  >();
  let executionTitleIndexInitialized = false;

  const withMissionLock = async <T>(id: string, operation: () => Promise<T>): Promise<T> =>
    await withFileLock(lockPath(id), operation);

  const recoverV7Migration = async (id: string): Promise<Mission | undefined> => {
    const value = await readJsonIfExists(v7MigrationTransactionPath(id));
    if (value === undefined) return undefined;
    const transaction = MissionV7MigrationTransactionSchema.parse(value);
    if (transaction.missionId !== id || transaction.target.id !== id) {
      throw new MissionStoreError(
        "config_invalid",
        `Mission ${id} has a migration journal for a different Mission.`,
      );
    }
    const persisted = parsePragmaYaml(await readFile(manifestPath(id), "utf8"));
    const persistedVersion = readSchemaVersion(persisted);
    if (persistedVersion !== "pragma.mission/v6" && persistedVersion !== "pragma.mission/v7") {
      throw new MissionStoreError(
        "unsupported_schema",
        `Mission ${id} cannot replay its v6-to-v7 migration from ${String(persistedVersion)}.`,
      );
    }
    await writeYamlAtomically(manifestPath(id), transaction.target);
    await rm(v7MigrationTransactionPath(id), { force: true });
    return transaction.target;
  };

  const migrateV6ToV7 = async (
    id: string,
    legacy: z.infer<typeof MissionV6Schema>,
  ): Promise<Mission> => {
    const target = MissionSchema.parse({ ...legacy, schemaVersion: "pragma.mission/v7" });
    await writeTextIfAbsent(v6BackupPath(id), formatPragmaYaml(legacy));
    await writeJsonAtomically(
      v7MigrationTransactionPath(id),
      MissionV7MigrationTransactionSchema.parse({
        schemaVersion: "pragma.mission-v7-migration/v1",
        missionId: id,
        target,
      }),
    );
    await writeYamlAtomically(manifestPath(id), target);
    await rm(v7MigrationTransactionPath(id), { force: true });
    return target;
  };

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
      const recovered = await recoverV7Migration(id);
      const value = recovered ?? parsePragmaYaml(await readFile(manifestPath(id), "utf8"));
      const schemaVersion = readSchemaVersion(value);
      let current = value;
      if (schemaVersion === "pragma.mission/v3") {
        const legacy = MissionV3Schema.parse(value);
        current = MissionV4Schema.parse({
          ...legacy,
          schemaVersion: "pragma.mission/v4",
          ...(legacy.executor.kind === "flow"
            ? {
                flowInput: {
                  goal: legacy.goal,
                  workspace: legacy.workspace.path,
                },
              }
            : {}),
        });
        await writeYamlAtomically(manifestPath(id), current);
      }
      const currentVersion = readSchemaVersion(current);
      if (currentVersion === "pragma.mission/v4") {
        const legacy = MissionV4Schema.parse(current);
        const { version: _version, ...executor } = legacy.executor;
        void _version;
        const migratedExecutor = {
          ...executor,
          ref: migrateLegacyPragmaResourceRef(executor.ref, legacy.project.id),
        };
        const migrated = MissionV5Schema.parse({
          ...legacy,
          schemaVersion: "pragma.mission/v5",
          executor: migratedExecutor,
        });
        await writeYamlAtomically(manifestPath(id), migrated);
        current = migrated;
      }
      const versionAfterRefMigration = readSchemaVersion(current);
      if (versionAfterRefMigration === "pragma.mission/v5") {
        const legacy = MissionV5Schema.parse(current);
        const migrated = MissionV6Schema.parse({
          ...legacy,
          schemaVersion: "pragma.mission/v6",
          origin: { type: "user" },
        });
        await writeYamlAtomically(manifestPath(id), migrated);
        return await migrateV6ToV7(id, migrated);
      }
      if (versionAfterRefMigration === "pragma.mission/v6") {
        const legacy = MissionV6Schema.parse(current);
        return await migrateV6ToV7(id, legacy);
      }
      if (versionAfterRefMigration !== "pragma.mission/v7") {
        throw new MissionStoreError(
          "unsupported_schema",
          `Mission ${id} uses an unsupported schema. Remove the old Mission directory and create a new Mission.`,
        );
      }
      return MissionSchema.parse(current);
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

  const readAttachmentsManifest = async (id: string): Promise<MissionAttachmentsManifest> =>
    MissionAttachmentsManifestSchema.parse(
      (await readJsonIfExists(attachmentsPath(id))) ?? {
        schemaVersion: "pragma.mission-attachments/v1",
        attachments: [],
      },
    );

  const applyUserMessageAttachmentsTransaction = async (
    id: string,
    mission: Mission,
    transaction: UserMessageAttachmentsTransaction,
  ): Promise<void> => {
    if (transaction.record.kind !== "user") {
      throw new MissionStoreError(
        "config_invalid",
        `Mission ${id} has an attachment transaction without a user message.`,
      );
    }
    const currentAttachments = await readAttachmentsManifest(id);
    const manifestAlreadyApplied = sameValue(currentAttachments, transaction.targetAttachments);
    if (!manifestAlreadyApplied && !sameValue(currentAttachments, transaction.baseAttachments)) {
      throw new MissionStoreError(
        "config_invalid",
        `Mission ${id} attachment transaction conflicts with its attachment manifest.`,
      );
    }
    await moveStagedAttachmentImages({
      attachments: transaction.record.attachments ?? [],
      stagingPath: userMessageAttachmentsStagingPath(id, transaction.record.id),
      targetMissionPath: missionPath(id),
    });
    if (!manifestAlreadyApplied) {
      await writeJsonAtomically(attachmentsPath(id), transaction.targetAttachments);
    }
    const records = await readRecords(id, true);
    const existing = findSameIdentity(records, transaction.record);
    if (existing === undefined) {
      await appendJsonLine(messagesPath(id), transaction.record);
      timelineCache.delete(id);
    } else if (!sameRecord(existing, transaction.record)) {
      throw messageConflict(transaction.record);
    }
    if (mission.updatedAt < transaction.updatedAt) {
      await writeYamlAtomically(manifestPath(id), { ...mission, updatedAt: transaction.updatedAt });
    }
    await rm(userMessageAttachmentsStagingPath(id, transaction.record.id), {
      recursive: true,
      force: true,
    });
    await rm(userMessageAttachmentsTransactionPath(id), { force: true });
  };

  const recoverUserMessageAttachmentsTransaction = async (id: string): Promise<void> => {
    const value = await readJsonIfExists(userMessageAttachmentsTransactionPath(id));
    if (value === undefined) return;
    const transaction = UserMessageAttachmentsTransactionSchema.parse(value);
    const mission = await readMissionUnlocked(id);
    await applyUserMessageAttachmentsTransaction(id, mission, transaction);
  };

  const recoverPendingTransactions = async (id: string): Promise<void> => {
    await recoverUserMessageAttachmentsTransaction(id);
    await recoverMessageTransaction(id);
  };

  const readMission = async (id: string): Promise<Mission> =>
    await withMissionLock(id, async () => {
      await recoverPendingTransactions(id);
      return await readMissionUnlocked(id);
    });

  const updateMission = async (
    id: string,
    update: (current: Mission, timestamp: string) => Mission,
  ): Promise<Mission> =>
    await withMissionLock(id, async () => {
      await recoverPendingTransactions(id);
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
      await recoverPendingTransactions(id);
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
      const parsedId = MissionIdSchema.parse(id);
      return await withMissionLock(parsedId, async () => {
        await recoverPendingTransactions(parsedId);
        await readMissionUnlocked(parsedId);
        try {
          const current = await readMissionExecutionProjection(
            projectionPath(parsedId, executionId),
            executionId,
          );
          if (current !== undefined) return current;
          const legacy = await readLegacyExecutionProjection(
            legacyProjectionPath(parsedId, executionId),
          );
          if (legacy === undefined) return undefined;
          await writeMissionExecutionProjection(
            projectionPath(parsedId, executionId),
            executionId,
            legacy,
          );
          await rm(legacyProjectionPath(parsedId, executionId), { force: true });
          return await readMissionExecutionProjection(
            projectionPath(parsedId, executionId),
            executionId,
          );
        } catch (error) {
          if (error instanceof MissionStoreError) throw error;
          throw new MissionStoreError(
            "projection_invalid",
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    },
    async writeExecutionProjection(id, executionId, entries) {
      const parsedId = MissionIdSchema.parse(id);
      await withMissionLock(parsedId, async () => {
        await recoverPendingTransactions(parsedId);
        await readMissionUnlocked(parsedId);
        try {
          await writeMissionExecutionProjection(
            projectionPath(id, executionId),
            executionId,
            entries,
          );
          await rm(legacyProjectionPath(id, executionId), { force: true });
        } catch (error) {
          if (error instanceof MissionExecutionProjectionError) {
            throw new MissionStoreError("projection_invalid", error.message);
          }
          throw error;
        }
      });
    },
    async list() {
      try {
        const directories = (await readdir(options.missionsPath, { withFileTypes: true })).filter(
          (entry) => entry.isDirectory() && !entry.name.startsWith("."),
        );
        const missions = await Promise.all(directories.map((entry) => readMission(entry.name)));
        return missions
          .filter((mission) => mission.origin.type === "user")
          .map(toMissionSummary)
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return [];
        throw error;
      }
    },
    async resolveExecutionTitles(executionIds) {
      const unresolved = new Set(executionIds);
      const resolved = new Map<string, string>();
      if (unresolved.size === 0) return resolved;
      for (const executionId of unresolved) {
        const cached = executionTitleIndex.get(executionId);
        if (cached === undefined) continue;
        resolved.set(executionId, cached.title);
        unresolved.delete(executionId);
      }
      if (unresolved.size === 0 || executionTitleIndexInitialized) return resolved;
      let directories;
      try {
        directories = (await readdir(options.missionsPath, { withFileTypes: true })).filter(
          (entry) => entry.isDirectory() && !entry.name.startsWith("."),
        );
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return resolved;
        throw error;
      }
      for (const entry of directories) {
        const records = await readRecords(entry.name, false);
        const executions = records.filter((record) => record.kind === "execution");
        if (executions.length === 0) continue;
        const mission = await readMission(entry.name);
        for (const record of executions) {
          if (record.kind !== "execution") continue;
          executionTitleIndex.set(record.executionId, {
            missionId: mission.id,
            title: mission.title,
          });
        }
      }
      executionTitleIndexInitialized = true;
      for (const executionId of unresolved) {
        const indexed = executionTitleIndex.get(executionId);
        if (indexed !== undefined) resolved.set(executionId, indexed.title);
      }
      return resolved;
    },
    async get(id) {
      return await readMission(MissionIdSchema.parse(id));
    },
    async getAttachments(id) {
      const parsedId = MissionIdSchema.parse(id);
      return await withMissionLock(parsedId, async () => {
        await recoverPendingTransactions(parsedId);
        await readMissionUnlocked(parsedId);
        try {
          return (await readAttachmentsManifest(parsedId)).attachments;
        } catch (error) {
          throw new MissionStoreError(
            "config_invalid",
            `Mission ${parsedId} has an invalid attachment manifest: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    },
    async create(input) {
      const id = MissionIdSchema.parse(input.id ?? randomUUID());
      const initialMessageId = randomUUID();
      const timestamp = new Date().toISOString();
      const goal = input.goal.trim();
      const mission = MissionSchema.parse({
        schemaVersion: "pragma.mission/v7",
        id,
        title: input.title === undefined ? titleFromGoal(goal) : normalizeMissionTitle(input.title),
        goal,
        initialMessageId,
        toolPermissionMode: input.toolPermissionMode ?? "request-approval",
        workspace: input.workspace,
        project: input.project,
        executor: input.executor,
        ...(input.flowInput === undefined ? {} : { flowInput: input.flowInput }),
        ...(input.modelOverride === undefined ? {} : { modelOverride: input.modelOverride }),
        origin: input.origin ?? { type: "user" },
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
        const attachments = await materializeMissionAttachments({
          attachments: input.attachments ?? [],
          temporaryMissionPath: temporaryPath,
          targetMissionPath: targetPath,
        });
        const firstMessageWithAttachments = MissionTimelineRecordSchema.parse({
          ...firstMessage,
          ...(attachments.attachments.length === 0 ? {} : { attachments: attachments.attachments }),
        });
        await writeFile(join(temporaryPath, "mission.yaml"), formatPragmaYaml(mission), {
          mode: 0o600,
        });
        await writeFile(
          join(temporaryPath, "attachments.json"),
          `${JSON.stringify(attachments, null, 2)}\n`,
          { mode: 0o600 },
        );
        await writeFile(
          join(temporaryPath, "messages.jsonl"),
          `${JSON.stringify(firstMessageWithAttachments)}\n`,
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
      if ((parsedMessage.attachments?.length ?? 0) > 0) {
        return await withMissionLock(parsedId, async () => {
          await recoverPendingTransactions(parsedId);
          const mission = await readMissionUnlocked(parsedId);
          const records = await readRecords(parsedId, false);
          const existing = records.find(
            (record) => record.kind === "user" && record.id === parsedMessage.id,
          );
          if (existing !== undefined) {
            if (existing.kind !== "user") throw messageConflict(existing);
            if (!sameUserMessageInput(existing, parsedMessage)) throw messageConflict(existing);
            return existing;
          }
          const baseAttachments = await readAttachmentsManifest(parsedId);
          const inputAttachments = parsedMessage.attachments ?? [];
          const inputIds = new Set(inputAttachments.map((attachment) => attachment.id));
          if (inputIds.size !== inputAttachments.length) {
            throw new Error("Mission attachment ids must be unique.");
          }
          if (baseAttachments.attachments.some((attachment) => inputIds.has(attachment.id))) {
            throw new Error("Mission attachment ids must be unique.");
          }
          if (baseAttachments.attachments.length + inputAttachments.length > 20) {
            throw new Error("A mission can include up to 20 attachments.");
          }
          const stagingPath = userMessageAttachmentsStagingPath(parsedId, parsedMessage.id);
          await rm(stagingPath, { recursive: true, force: true });
          await mkdir(stagingPath, { recursive: true, mode: 0o700 });
          let journalWritten = false;
          try {
            const added = await materializeMissionAttachments({
              attachments: inputAttachments,
              temporaryMissionPath: stagingPath,
              targetMissionPath: missionPath(parsedId),
            });
            const record = MissionTimelineRecordSchema.parse({
              schemaVersion: "pragma.mission-message/v1",
              sequence: (records.at(-1)?.sequence ?? 0) + 1,
              kind: "user",
              ...parsedMessage,
              attachments: added.attachments,
            });
            const transaction = UserMessageAttachmentsTransactionSchema.parse({
              schemaVersion: "pragma.mission-user-message-attachments-transaction/v1",
              baseAttachments,
              targetAttachments: {
                schemaVersion: "pragma.mission-attachments/v1",
                attachments: [...baseAttachments.attachments, ...added.attachments],
              },
              record,
              updatedAt: new Date().toISOString(),
            });
            await writeJsonAtomically(userMessageAttachmentsTransactionPath(parsedId), transaction);
            journalWritten = true;
            await applyUserMessageAttachmentsTransaction(parsedId, mission, transaction);
            return record;
          } catch (error) {
            if (!journalWritten) {
              await rm(stagingPath, { recursive: true, force: true });
            }
            throw error;
          }
        });
      }
      return await appendRecord(parsedId, (sequence) => ({
        schemaVersion: "pragma.mission-message/v1",
        sequence,
        kind: "user",
        ...parsedMessage,
      }));
    },
    async appendExecutionReference(input) {
      const missionId = MissionIdSchema.parse(input.missionId);
      const executionId = MissionIdSchema.parse(input.executionId);
      const mission = await readMission(missionId);
      const record = await appendRecord(missionId, (sequence) => ({
        schemaVersion: "pragma.mission-message/v1",
        sequence,
        kind: "execution",
        inputMessageId: MissionIdSchema.parse(input.inputMessageId),
        executionId,
        createdAt: z.string().datetime().parse(input.createdAt),
      }));
      executionTitleIndex.set(executionId, { missionId, title: mission.title });
      return record;
    },
    async readTimelinePage(id, pageOptions) {
      const parsedId = MissionIdSchema.parse(id);
      return await withMissionLock(parsedId, async () => {
        await recoverPendingTransactions(parsedId);
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
        await recoverPendingTransactions(parsedId);
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
        for (const [executionId, entry] of executionTitleIndex) {
          if (entry.missionId === parsedId) executionTitleIndex.delete(executionId);
        }
      });
    },
  };
}

const MAX_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;

async function materializeMissionAttachments(options: {
  readonly attachments: readonly ExpertPromptAttachment[];
  readonly temporaryMissionPath: string;
  readonly targetMissionPath: string;
}): Promise<MissionAttachmentsManifest> {
  const input = MissionAttachmentsManifestSchema.parse({
    schemaVersion: "pragma.mission-attachments/v1",
    attachments: options.attachments,
  });
  const attachments = await Promise.all(
    input.attachments.map(async (attachment): Promise<ExpertPromptAttachment> => {
      const sourcePath = await realpath(attachment.path);
      const metadata = await stat(sourcePath);
      if (attachment.kind === "directory") {
        if (!metadata.isDirectory()) {
          throw new Error(`Mission attachment is not a directory: ${sourcePath}`);
        }
        return {
          id: attachment.id,
          kind: attachment.kind,
          name: basename(sourcePath),
          path: sourcePath,
        };
      }
      if (!metadata.isFile()) {
        throw new Error(`Mission attachment is not a file: ${sourcePath}`);
      }
      if (attachment.kind === "file") {
        return {
          id: attachment.id,
          kind: attachment.kind,
          name: attachment.name,
          path: sourcePath,
          size: metadata.size,
        };
      }
      if (metadata.size === 0 || metadata.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        throw new Error(`Image attachments must be 20 MiB or smaller: ${basename(sourcePath)}`);
      }
      const mimeType = missionImageMimeType(sourcePath);
      if (mimeType !== attachment.mimeType) {
        throw new Error(`Image attachment type does not match its path: ${basename(sourcePath)}`);
      }
      const originalRelativePath = join(
        "attachments",
        "images",
        `${attachment.id}${imageExtension(mimeType)}`,
      );
      const temporaryPath = join(options.temporaryMissionPath, originalRelativePath);
      await mkdir(dirname(temporaryPath), { recursive: true, mode: 0o700 });
      await copyFile(sourcePath, temporaryPath);
      const optimized =
        attachment.optimized === undefined
          ? undefined
          : await materializeOptimizedImage({
              attachment,
              temporaryMissionPath: options.temporaryMissionPath,
              targetMissionPath: options.targetMissionPath,
            });
      return {
        id: attachment.id,
        kind: attachment.kind,
        name: attachment.name,
        path: join(options.targetMissionPath, originalRelativePath),
        mimeType,
        size: metadata.size,
        ...(optimized === undefined ? {} : { optimized }),
      };
    }),
  );
  return MissionAttachmentsManifestSchema.parse({
    schemaVersion: "pragma.mission-attachments/v1",
    attachments,
  });
}

async function moveStagedAttachmentImages(options: {
  readonly attachments: readonly ExpertPromptAttachment[];
  readonly stagingPath: string;
  readonly targetMissionPath: string;
}): Promise<void> {
  for (const attachment of options.attachments) {
    if (attachment.kind !== "image") continue;
    const imagesRoot = join(options.targetMissionPath, "attachments", "images");
    for (const image of [
      { path: attachment.path, mimeType: attachment.mimeType, size: attachment.size },
      attachment.optimized,
    ]) {
      if (image === undefined) continue;
      const target = image.path;
      const relativeImagePath = relative(imagesRoot, target);
      if (
        relativeImagePath === "" ||
        relativeImagePath === ".." ||
        relativeImagePath.startsWith("../") ||
        relativeImagePath.startsWith("..\\") ||
        isAbsolute(relativeImagePath)
      ) {
        throw new MissionStoreError(
          "config_invalid",
          "Mission attachment transaction escaped its Mission image directory.",
        );
      }
      if (image.mimeType === undefined || missionImageMimeType(target) !== image.mimeType) {
        throw new MissionStoreError(
          "config_invalid",
          `Mission attachment transaction has an invalid image type: ${basename(target)}`,
        );
      }
      const relativeTarget = relative(options.targetMissionPath, target);
      const source = join(options.stagingPath, relativeTarget);
      const sourceMetadata = await statIfExists(source);
      const targetMetadata = await statIfExists(target);
      if (sourceMetadata !== undefined && targetMetadata !== undefined) {
        throw new MissionStoreError(
          "config_invalid",
          `Mission attachment transaction found duplicate image files: ${basename(target)}`,
        );
      }
      if (sourceMetadata !== undefined) {
        if (!sourceMetadata.isFile()) {
          throw new MissionStoreError(
            "config_invalid",
            `Mission attachment staging path is not a file: ${basename(target)}`,
          );
        }
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await rename(source, target);
      }
      const persisted = await statIfExists(target);
      if (
        persisted === undefined ||
        !persisted.isFile() ||
        (image.size !== undefined && persisted.size !== image.size)
      ) {
        throw new MissionStoreError(
          "config_invalid",
          `Mission attachment transaction has an invalid image: ${basename(target)}`,
        );
      }
    }
  }
}

async function materializeOptimizedImage(options: {
  readonly attachment: ExpertPromptAttachment;
  readonly temporaryMissionPath: string;
  readonly targetMissionPath: string;
}): Promise<NonNullable<ExpertPromptAttachment["optimized"]>> {
  const optimized = options.attachment.optimized;
  if (optimized === undefined) throw new Error("Optimized image metadata is missing.");
  const sourcePath = await realpath(optimized.path);
  const metadata = await stat(sourcePath);
  if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_IMAGE_ATTACHMENT_BYTES) {
    throw new Error(`Optimized image attachment is unavailable: ${basename(sourcePath)}`);
  }
  const mimeType = missionImageMimeType(sourcePath);
  if (mimeType !== optimized.mimeType) {
    throw new Error(`Optimized image type does not match its path: ${basename(sourcePath)}`);
  }
  const relativePath = join(
    "attachments",
    "images",
    "optimized",
    `${options.attachment.id}${imageExtension(mimeType)}`,
  );
  const temporaryPath = join(options.temporaryMissionPath, relativePath);
  await mkdir(dirname(temporaryPath), { recursive: true, mode: 0o700 });
  await copyFile(sourcePath, temporaryPath);
  return {
    path: join(options.targetMissionPath, relativePath),
    mimeType,
    size: metadata.size,
  };
}

function missionImageMimeType(
  path: string,
): "image/gif" | "image/jpeg" | "image/png" | "image/webp" {
  switch (extname(path).toLowerCase()) {
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      throw new Error(`Unsupported image attachment type: ${basename(path)}`);
  }
}

function imageExtension(mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp") {
  switch (mimeType) {
    case "image/gif":
      return ".gif";
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
  }
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

async function writeTextIfAbsent(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  } finally {
    await handle?.close();
  }
}

async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function statIfExists(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function readLegacyExecutionProjection(
  path: string,
): Promise<readonly MissionChatEntry[] | undefined> {
  const value = await readJsonIfExists(path);
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== "pragma.mission-execution-projection/v1" ||
    !("entries" in value)
  ) {
    throw new MissionStoreError("unsupported_schema", "Unsupported Mission projection schema.");
  }
  return MissionChatEntrySchema.array().parse(value.entries);
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

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameUserMessageInput(
  existing: Extract<MissionTimelineRecord, { readonly kind: "user" }>,
  input: MissionUserMessage,
): boolean {
  return (
    existing.id === input.id &&
    existing.content === input.content &&
    existing.createdAt === input.createdAt &&
    sameValue(
      (existing.attachments ?? []).map(attachmentRequestIdentity),
      (input.attachments ?? []).map(attachmentRequestIdentity),
    )
  );
}

function attachmentRequestIdentity(attachment: ExpertPromptAttachment): unknown {
  return {
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
    ...(attachment.optimized === undefined
      ? {}
      : {
          optimized: {
            mimeType: attachment.optimized.mimeType,
            size: attachment.optimized.size,
          },
        }),
  };
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
