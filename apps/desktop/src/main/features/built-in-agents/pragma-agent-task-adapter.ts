import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import { encodePragmaPathSegment, withFileLock } from "@pragma/core";
import {
  type PragmaAgentMission,
  type PragmaAgentMissionPort,
  type PragmaAgentMissionSummary,
  type PragmaAgentMissionWorkItem,
} from "@pragma/built-in-agents";

import type { Mission } from "../../../shared/contracts/index.ts";
import type { MissionCreator } from "../missions/mission-creator.ts";
import type { MissionRunner } from "../missions/mission-runner.ts";
import type { MissionStore } from "../missions/mission-store.ts";
import { paginateManagementItems } from "./management-pagination.ts";

export function createDesktopPragmaAgentMissionPort(options: {
  readonly missions: MissionStore;
  readonly runner: MissionRunner;
  readonly creator: MissionCreator;
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
      const path = operationPath(input.operationId);
      return await withFileLock(`${path}.lock`, async () => {
        const storedId = await readOperation(path);
        if (storedId !== undefined) {
          const stored = await options.missions.get(storedId);
          return toMission(
            stored.execution === undefined ? await options.runner.run(stored.id) : stored,
          );
        }
        const mission = await options.creator.create({
          workspace: input.workspaceId,
          missionInput: { kind: "auto", value: input.goal },
          executorRef: input.executorRef,
        });
        await writeOperation(path, mission.id);
        return toMission(await options.runner.run(mission.id));
      });
    },
    async sendMessage(input) {
      return toMission(
        (
          await options.runner.sendMessage({
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
      const all = (await options.runner.getWork(input.missionId)).records
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
      const record = (await options.runner.getWork(missionId)).records.find(
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
    async interrupt(id) {
      return toMission(await options.runner.interrupt(id));
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
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ missionId })}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
