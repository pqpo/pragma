import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock } from "@pragma/core";

import {
  AgentEvaluationRunSchema,
  EvaluationQueueSettingsSchema,
  type AgentEvaluationRun,
  type EvaluationQueueSettings,
} from "../../../shared/contracts/index.ts";

export interface EvaluationStore {
  getSettings(): Promise<EvaluationQueueSettings>;
  updateSettings(
    update: (settings: EvaluationQueueSettings) => EvaluationQueueSettings,
  ): Promise<EvaluationQueueSettings>;
  listRuns(): Promise<AgentEvaluationRun[]>;
  getRun(id: string): Promise<AgentEvaluationRun>;
  saveRun(run: AgentEvaluationRun): Promise<AgentEvaluationRun>;
  updateRun(
    id: string,
    update: (run: AgentEvaluationRun) => AgentEvaluationRun,
  ): Promise<AgentEvaluationRun>;
}

export function createEvaluationStore(statePath: string): EvaluationStore {
  const runsPath = join(statePath, "runs");
  const settingsPath = join(statePath, "settings.json");
  const runPath = (id: string) => join(runsPath, `${id}.json`);
  const defaultSettings = (): EvaluationQueueSettings =>
    EvaluationQueueSettingsSchema.parse({
      schemaVersion: "pragma.evaluation-settings/v1",
      revision: 0,
      concurrency: 3,
      judge: { mode: "inherit-default" },
      updatedAt: new Date(0).toISOString(),
    });

  const readSettings = async (): Promise<EvaluationQueueSettings> => {
    try {
      return EvaluationQueueSettingsSchema.parse(JSON.parse(await readFile(settingsPath, "utf8")));
    } catch (error) {
      if (isNotFound(error)) return defaultSettings();
      throw error;
    }
  };
  const readRun = async (id: string): Promise<AgentEvaluationRun> => {
    try {
      return AgentEvaluationRunSchema.parse(JSON.parse(await readFile(runPath(id), "utf8")));
    } catch (error) {
      if (isNotFound(error)) throw new Error(`Evaluation run not found: ${id}.`, { cause: error });
      throw error;
    }
  };

  return {
    getSettings: readSettings,
    async updateSettings(update) {
      return await withFileLock(`${settingsPath}.lock`, async () => {
        const next = EvaluationQueueSettingsSchema.parse(update(await readSettings()));
        await writeJsonAtomic(settingsPath, next);
        return next;
      });
    },
    async listRuns() {
      const entries = await readdir(runsPath, { withFileTypes: true }).catch((error: unknown) => {
        if (isNotFound(error)) return [];
        throw error;
      });
      const runs = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map(async (entry) =>
            AgentEvaluationRunSchema.parse(
              JSON.parse(await readFile(join(runsPath, entry.name), "utf8")),
            ),
          ),
      );
      return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },
    getRun: readRun,
    async saveRun(run) {
      const parsed = AgentEvaluationRunSchema.parse(run);
      return await withFileLock(`${runPath(parsed.id)}.lock`, async () => {
        try {
          await readFile(runPath(parsed.id), "utf8");
          throw new Error(`Evaluation run already exists: ${parsed.id}.`);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        await writeJsonAtomic(runPath(parsed.id), parsed);
        return parsed;
      });
    },
    async updateRun(id, update) {
      return await withFileLock(`${runPath(id)}.lock`, async () => {
        const next = AgentEvaluationRunSchema.parse(update(await readRun(id)));
        await writeJsonAtomic(runPath(id), next);
        return next;
      });
    },
  };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
