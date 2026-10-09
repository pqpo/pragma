import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import { encodePragmaPathSegment, withFileLock } from "@pragma/core";
import {
  type PragmaAgentMission,
  type PragmaAgentMissionPort,
  type PragmaAgentMissionSummary,
  type PragmaAgentMissionWorkItem,
} from "@pragma/built-in-agents";

import { z } from "zod";
import { readCommandState } from "./management-command-ownership.ts";
import type { Mission, MissionContextMount } from "@pragma/shared";

import type { LocalHostMissionApplication } from "./missions/application.ts";
import { MissionStoreError, type MissionStore } from "./missions/repository/mission-store.ts";
import { paginateManagementItems } from "./management-pagination.ts";

export function createLocalHostPragmaMissionPort(options: {
  readonly missions: MissionStore;
  readonly application: LocalHostMissionApplication;
  readonly creator: {
    create(input: {
      readonly id?: string | undefined;
      readonly workspace: string;
      readonly missionInput: { readonly kind: "auto"; readonly value: string };
      readonly executorRef: string;
      readonly contextMounts: readonly MissionContextMount[];
    }): Promise<Mission>;
  };
  readonly stateRoot: string;
}): PragmaAgentMissionPort {
  const operationPath = (id: string) =>
    join(options.stateRoot, "operations", `${encodePragmaPathSegment(id)}.task.json`);
  return {
    async list(input) {
      const query = input.query?.trim().toLocaleLowerCase();
      const statuses = input.statuses === undefined ? undefined : new Set(input.statuses);
      const all = (await options.missions.list())
        .map((summary): PragmaAgentMissionSummary => ({
          missionId: summary.id,
          title: summary.title,
          status: summary.execution?.status ?? summary.lifecycleStatus,
          executorRef: summary.executor.ref ?? `${summary.executor.kind}:unknown`,
          workspaceLabel: summary.workspace.basename,
          updatedAt: summary.updatedAt,
        }))
        .filter(
          (mission) =>
            (statuses === undefined || statuses.has(mission.status)) &&
            (input.executorRef === undefined || mission.executorRef === input.executorRef) &&
            (input.updatedAfter === undefined || mission.updatedAt > input.updatedAfter) &&
            (query === undefined ||
              [mission.missionId, mission.title, mission.executorRef, mission.workspaceLabel].some(
                (value) => value.toLocaleLowerCase().includes(query),
              )),
        );
      return paginateManagementItems({
        items: all,
        scope: "list_missions",
        fingerprintValue: all.map(({ missionId, updatedAt }) => [missionId, updatedAt]),
        filters: {
          statuses: input.statuses,
          executorRef: input.executorRef,
          updatedAfter: input.updatedAfter,
          query,
        },
        cursor: input.cursor,
        limit: input.limit,
      });
    },
    async get(id) {
      return toMission(await options.missions.get(id));
    },
    async submit(input) {
      if (!isAbsolute(input.workspaceId)) {
        throw new Error(
          "Invalid workspaceId: provide the absolute path of an accessible, writable directory. Use the current Mission's workspace path, not a label such as default or workspace.",
        );
      }
      const path = operationPath(input.operationId);
      return await withFileLock(`${path}.lock`, async () => {
        const storedId = await readOperation(path);
        if (storedId !== undefined) {
          const stored = await options.missions.get(storedId);
          return toMission(
            stored.execution === undefined ? await options.application.startRun(stored.id) : stored,
          );
        }
        // Reserve the business target before creation; a crash before the operation receipt must
        // find the same Mission instead of creating another owner.
        const missionId = deterministicUuid(`pragma-management-mission:${input.operationId}`);
        let recovered: Mission | undefined;
        try {
          recovered = await options.missions.get(missionId);
        } catch (error) {
          if (!(error instanceof MissionStoreError) || error.code !== "mission_not_found")
            throw error;
        }
        if (recovered !== undefined) {
          await writeOperation(path, missionId);
          return toMission(
            recovered.execution === undefined
              ? await options.application.startRun(missionId)
              : recovered,
          );
        }
        const contextStoreIds = input.contextStoreIds ?? [];
        const mission = await options.creator.create({
          id: missionId,
          workspace: input.workspaceId,
          missionInput: { kind: "auto", value: input.goal },
          executorRef: input.executorRef,
          contextMounts: contextStoreIds.map((storeId) => ({
            kind: "context-store" as const,
            storeId,
          })),
        });
        await writeOperation(path, mission.id);
        return toMission(await options.application.startRun(mission.id));
      });
    },
    async sendMessage(input) {
      return toMission(
        (
          await options.application.sendMessage({
            id: input.missionId,
            content: input.content,
            requestId: deterministicUuid(input.operationId),
          })
        ).mission,
      );
    },
    async listWorkItems(input) {
      const query = input.query?.trim().toLocaleLowerCase();
      const kinds = input.kinds === undefined ? undefined : new Set(input.kinds);
      const statuses = input.statuses === undefined ? undefined : new Set(input.statuses);
      const all = (await options.application.getWork(input.missionId)).records
        .map((record): PragmaAgentMissionWorkItem => ({
          workItemId: record.recordId,
          kind: record.kind,
          status: record.status,
          label: record.title,
          summary: record.summary,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        }))
        .filter(
          (item) =>
            (kinds === undefined || kinds.has(item.kind)) &&
            (statuses === undefined || statuses.has(item.status)) &&
            (query === undefined ||
              [item.workItemId, item.label, item.summary].some((value) =>
                value.toLocaleLowerCase().includes(query),
              )),
        )
        .toSorted(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) ||
            left.workItemId.localeCompare(right.workItemId),
        );
      return paginateManagementItems({
        items: all,
        scope: `list_mission_work_items:${input.missionId}`,
        fingerprintValue: all.map(({ workItemId, updatedAt }) => [workItemId, updatedAt]),
        filters: { kinds: input.kinds, statuses: input.statuses, query },
        cursor: input.cursor,
        limit: input.limit,
      });
    },
    async getWorkItem(missionId, workItemId) {
      const record = (await options.application.getWork(missionId)).records.find(
        (candidate) => candidate.recordId === workItemId,
      );
      if (record === undefined) throw new Error(`Mission work item not found: ${workItemId}`);
      return {
        workItemId: record.recordId,
        kind: record.kind,
        status: record.status,
        label: record.title,
        summary: record.summary,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        ...(record.parentRecordId === undefined ? {} : { parentWorkItemId: record.parentRecordId }),
        tasks: record.tasks,
      };
    },
    async interrupt(id, operationId) {
      if (operationId === undefined) return toMission(await options.application.interrupt(id));
      const path = join(
        options.stateRoot,
        "interrupt-operations",
        `${encodePragmaPathSegment(operationId)}.json`,
      );
      return await withFileLock(`${path}.lock`, async () => {
        const schema = z
          .object({
            schemaVersion: z.literal("pragma.mission-command-interrupt/v1"),
            missionId: z.string().uuid(),
            executionId: z.string().nullable(),
          })
          .strict();
        let target = await readCommandState(path, schema, "pragma.mission-command-interrupt/v1");
        const mission = await options.missions.get(id);
        if (target === undefined) {
          target = schema.parse({
            schemaVersion: "pragma.mission-command-interrupt/v1",
            missionId: id,
            executionId: mission.execution?.id ?? null,
          });
          await writeOperationValue(path, target);
        }
        if (target.missionId !== id) throw new Error("Interrupt operation target conflict.");
        if (
          target.executionId === null ||
          mission.execution?.id !== target.executionId ||
          ["succeeded", "failed", "cancelled"].includes(mission.execution.status)
        )
          return toMission(mission);
        return toMission(await options.application.interrupt(id, target.executionId));
      });
    },
  };
}

function toMission(mission: Mission): PragmaAgentMission {
  return {
    missionId: mission.id,
    title: mission.title,
    goal: mission.goal,
    status: mission.execution?.status ?? mission.lifecycleStatus,
    executorRef: mission.executor.ref,
    workspaceId: mission.workspace.path,
    workspaceLabel: mission.workspace.basename,
    contextStoreIds: mission.contextMounts.flatMap((mount) =>
      mount.kind === "context-store" ? [mount.storeId] : [],
    ),
    updatedAt: mission.updatedAt,
    ...(mission.execution === undefined ? {} : { executionId: mission.execution.id }),
  };
}

function deterministicUuid(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function readOperation(path: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { missionId?: unknown };
    return typeof value.missionId === "string" ? value.missionId : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeOperation(path: string, missionId: string): Promise<void> {
  await writeOperationValue(path, { missionId });
}
async function writeOperationValue(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
