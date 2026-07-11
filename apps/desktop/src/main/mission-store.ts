import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  ExpertDefinitionSchema,
  MissionIdSchema,
  MissionSchema,
  type ExpertDefinition,
  type Mission,
} from "../shared/desktop-api.ts";

export interface MissionStore {
  list(): Promise<Mission[]>;
  get(id: string): Promise<Mission>;
  getExecutor(id: string): Promise<ExpertDefinition>;
  create(input: {
    readonly workspace: { readonly path: string; readonly basename: string };
    readonly goal: string;
    readonly expert: ExpertDefinition;
  }): Promise<Mission>;
  markComplete(id: string): Promise<Mission>;
  reopen(id: string): Promise<Mission>;
}

export class MissionStoreError extends Error {
  constructor(
    readonly code: "mission_not_found" | "config_invalid",
    message: string,
  ) {
    super(message);
    this.name = "MissionStoreError";
  }
}

export function createMissionStore(options: { readonly missionsPath: string }): MissionStore {
  const missionPath = (id: string) => join(options.missionsPath, id);
  const manifestPath = (id: string) => join(missionPath(id), "mission.json");
  const executorPath = (id: string) => join(missionPath(id), "executor.json");

  const readMission = async (id: string): Promise<Mission> => {
    try {
      return MissionSchema.parse(JSON.parse(await readFile(manifestPath(id), "utf8")));
    } catch (error) {
      throw normalizeReadError(error, id);
    }
  };

  const updateMission = async (
    id: string,
    update: (current: Mission, timestamp: string) => Mission,
  ): Promise<Mission> => {
    const current = await readMission(id);
    const timestamp = new Date().toISOString();
    const updated = MissionSchema.parse(update(current, timestamp));
    await writeJsonAtomically(manifestPath(id), updated);
    return updated;
  };

  return {
    async list() {
      try {
        const directories = (await readdir(options.missionsPath, { withFileTypes: true })).filter(
          (entry) => entry.isDirectory() && !entry.name.startsWith("."),
        );
        const missions = await Promise.all(directories.map((entry) => readMission(entry.name)));
        return missions.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return [];
        throw error;
      }
    },

    async get(id) {
      return await readMission(MissionIdSchema.parse(id));
    },

    async getExecutor(id) {
      const parsedId = MissionIdSchema.parse(id);
      try {
        return ExpertDefinitionSchema.parse(
          JSON.parse(await readFile(executorPath(parsedId), "utf8")),
        );
      } catch (error) {
        throw normalizeReadError(error, parsedId);
      }
    },

    async create(input) {
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      const goal = input.goal.trim();
      const mission = MissionSchema.parse({
        schemaVersion: "pragma.mission/v1",
        id,
        title: titleFromGoal(goal),
        goal,
        workspace: input.workspace,
        executor: {
          kind: "expert",
          id: input.expert.id,
          name: input.expert.name,
          version: input.expert.version,
          revision: input.expert.revision,
        },
        lifecycleStatus: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const targetPath = missionPath(id);
      const temporaryPath = join(options.missionsPath, `.${id}.${randomUUID()}.tmp`);
      await mkdir(temporaryPath, { recursive: true, mode: 0o700 });
      try {
        await Promise.all([
          writeFile(join(temporaryPath, "mission.json"), `${JSON.stringify(mission, null, 2)}\n`, {
            mode: 0o600,
          }),
          writeFile(
            join(temporaryPath, "executor.json"),
            `${JSON.stringify(input.expert, null, 2)}\n`,
            { mode: 0o600 },
          ),
        ]);
        await mkdir(options.missionsPath, { recursive: true, mode: 0o700 });
        await rename(temporaryPath, targetPath);
      } catch (error) {
        await rm(temporaryPath, { recursive: true, force: true });
        throw error;
      }
      return mission;
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
        return {
          ...mission,
          lifecycleStatus: "active",
          updatedAt: timestamp,
        };
      });
    },
  };
}

function titleFromGoal(goal: string): string {
  const firstLine = goal.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() || "Untitled mission";
  return firstLine.length <= 120 ? firstLine : `${firstLine.slice(0, 117).trimEnd()}…`;
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

function normalizeReadError(error: unknown, id: string): Error {
  if (isNodeError(error, "ENOENT")) {
    return new MissionStoreError("mission_not_found", "The mission no longer exists.");
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return new MissionStoreError("config_invalid", `Mission ${id} has invalid stored data.`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
