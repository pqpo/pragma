import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { formatPragmaYaml, parsePragmaYaml } from "@pragma/interpreter";
import type { PragmaResource } from "@pragma/interpreter/ast";

import { MissionIdSchema, MissionSchema, type Mission } from "../shared/desktop-api.ts";

export interface MissionStore {
  list(): Promise<Mission[]>;
  get(id: string): Promise<Mission>;
  create(input: {
    readonly workspace: { readonly path: string; readonly basename: string };
    readonly goal: string;
    readonly project: { readonly id: string; readonly revision: number };
    readonly executor: PragmaResource;
  }): Promise<Mission>;
  updateExecution(
    id: string,
    execution: NonNullable<Mission["execution"]>,
    guard?: {
      readonly executionId?: string | undefined;
      readonly statuses?: readonly NonNullable<Mission["execution"]>["status"][] | undefined;
    },
  ): Promise<Mission>;
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
  const manifestPath = (id: string) => join(missionPath(id), "mission.yaml");
  let writeQueue = Promise.resolve();

  const serializeWrite = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = writeQueue;
    let release: () => void = () => undefined;
    writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const readMission = async (id: string): Promise<Mission> => {
    try {
      return MissionSchema.parse(parsePragmaYaml(await readFile(manifestPath(id), "utf8")));
    } catch (error) {
      throw normalizeReadError(error, id);
    }
  };

  const updateMission = async (
    id: string,
    update: (current: Mission, timestamp: string) => Mission,
  ): Promise<Mission> =>
    await serializeWrite(async () => {
      const current = await readMission(id);
      const timestamp = new Date().toISOString();
      const updated = MissionSchema.parse(update(current, timestamp));
      await writeYamlAtomically(manifestPath(id), updated);
      return updated;
    });

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
    async create(input) {
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      const goal = input.goal.trim();
      const kind = resourceKind(input.executor);
      const mission = MissionSchema.parse({
        schemaVersion: "pragma.mission/v2",
        id,
        title: titleFromGoal(goal),
        goal,
        workspace: input.workspace,
        project: input.project,
        executor: {
          kind,
          ref: `${kind}:${input.executor.metadata.id}@${input.executor.metadata.version}`,
          name: input.executor.metadata.name,
          version: input.executor.metadata.version,
        },
        lifecycleStatus: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const targetPath = missionPath(id);
      const temporaryPath = join(options.missionsPath, `.${id}.${randomUUID()}.tmp`);
      await mkdir(temporaryPath, { recursive: true, mode: 0o700 });
      try {
        await writeFile(join(temporaryPath, "mission.yaml"), formatPragmaYaml(mission), {
          mode: 0o600,
        });
        await mkdir(options.missionsPath, { recursive: true, mode: 0o700 });
        await rename(temporaryPath, targetPath);
      } catch (error) {
        await rm(temporaryPath, { recursive: true, force: true });
        throw error;
      }
      return mission;
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
  };
}

function resourceKind(resource: PragmaResource): "expert" | "team" | "flow" {
  return resource.kind === "Expert" ? "expert" : resource.kind === "ExpertTeam" ? "team" : "flow";
}

async function writeYamlAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, formatPragmaYaml(value), { mode: 0o600 });
  await rename(temporaryPath, path);
}

function titleFromGoal(goal: string): string {
  const firstLine = goal.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return firstLine.length <= 120 ? firstLine : `${firstLine.slice(0, 117).trimEnd()}…`;
}

function normalizeReadError(error: unknown, id: string): MissionStoreError {
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
