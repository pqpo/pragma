import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import { encodePragmaPathSegment, withFileLock } from "@pragma/core";
import {
  type DefaultAgentTask,
  type DefaultAgentTaskPort,
  type DefaultAgentTaskSummary,
  type DefaultAgentTaskWorkItem,
} from "@pragma/default-agent";

import type { Mission } from "../../../shared/contracts/index.ts";
import type { MissionCreator } from "../missions/mission-creator.ts";
import type { MissionRunner } from "../missions/mission-runner.ts";
import type { MissionStore } from "../missions/mission-store.ts";

export function createDesktopDefaultAgentTaskPort(options: {
  readonly missions: MissionStore;
  readonly runner: MissionRunner;
  readonly creator: MissionCreator;
  readonly stateRoot: string;
}): DefaultAgentTaskPort {
  const operationPath = (id: string) =>
    join(options.stateRoot, "operations", `${encodePragmaPathSegment(id)}.task.json`);
  return {
    async list() {
      return await Promise.all(
        (await options.missions.list()).map(async (summary): Promise<DefaultAgentTaskSummary> => {
          const mission = await options.missions.get(summary.id);
          return {
            id: mission.id,
            title: mission.title,
            status: mission.execution?.status ?? mission.lifecycleStatus,
            executorRef: mission.executor.ref,
            workspaceLabel: mission.workspace.basename,
            updatedAt: mission.updatedAt,
          };
        }),
      );
    },
    async get(id) {
      return toTask(await options.missions.get(id));
    },
    async submit(input) {
      const path = operationPath(input.operationId);
      return await withFileLock(`${path}.lock`, async () => {
        const storedId = await readOperation(path);
        if (storedId !== undefined) {
          const stored = await options.missions.get(storedId);
          return toTask(
            stored.execution === undefined ? await options.runner.run(stored.id) : stored,
          );
        }
        const mission = await options.creator.create({
          workspace: input.workspaceId,
          missionInput: { kind: "auto", value: input.goal },
          executorRef: input.executorRef,
        });
        await writeOperation(path, mission.id);
        return toTask(await options.runner.run(mission.id));
      });
    },
    async sendMessage(input) {
      return toTask(
        await options.runner.sendMessage({
          id: input.id,
          content: input.content,
          requestId: deterministicUuid(input.operationId),
        }),
      );
    },
    async listWorkItems(id) {
      return (await options.runner.getWork(id)).records.map(
        (record): DefaultAgentTaskWorkItem => ({
          id: record.recordId,
          kind: record.kind,
          status: record.status,
          label: record.title,
          details: record,
        }),
      );
    },
    async interrupt(id) {
      return toTask(await options.runner.interrupt(id));
    },
  };
}

function toTask(mission: Mission): DefaultAgentTask {
  return {
    id: mission.id,
    title: mission.title,
    goal: mission.goal,
    status: mission.execution?.status ?? mission.lifecycleStatus,
    executorRef: mission.executor.ref,
    workspaceId: mission.workspace.path,
    workspaceLabel: mission.workspace.basename,
    updatedAt: mission.updatedAt,
    details: mission,
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
