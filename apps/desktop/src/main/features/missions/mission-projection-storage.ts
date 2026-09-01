import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { MissionChatEntrySchema, type MissionChatEntry } from "../../../shared/contracts/index.ts";
import {
  readMissionExecutionProjection,
  readMissionExecutionProjectionPage,
  writeMissionExecutionProjection,
  type MissionExecutionProjectionPage,
} from "./mission-execution-projection.ts";

export class MissionProjectionStorageError extends Error {
  constructor(
    readonly code: "unsupported_schema",
    message: string,
  ) {
    super(message);
    this.name = "MissionProjectionStorageError";
  }
}

export interface MissionProjectionStorage {
  read(id: string, executionId: string): Promise<readonly MissionChatEntry[] | undefined>;
  readPage(
    id: string,
    executionId: string,
    input: { readonly beforeOffset?: number | undefined; readonly limit: number },
  ): Promise<MissionExecutionProjectionPage | undefined>;
  write(id: string, executionId: string, entries: readonly MissionChatEntry[]): Promise<void>;
}

export function createMissionProjectionStorage(
  missionPath: (id: string) => string,
): MissionProjectionStorage {
  const legacyPath = (id: string, executionId: string) =>
    join(missionPath(id), "execution-projections", `${executionId}.json`);
  const currentPath = (id: string, executionId: string) =>
    join(missionPath(id), "execution-projections", `${executionId}.jsonl`);

  const migrateLegacy = async (
    id: string,
    executionId: string,
  ): Promise<readonly MissionChatEntry[] | undefined> => {
    const legacy = await readLegacyProjection(legacyPath(id, executionId));
    if (legacy === undefined) return undefined;
    await writeMissionExecutionProjection(currentPath(id, executionId), executionId, legacy);
    await rm(legacyPath(id, executionId), { force: true });
    return legacy;
  };

  return {
    async read(id, executionId) {
      const current = await readMissionExecutionProjection(
        currentPath(id, executionId),
        executionId,
      );
      return current ?? (await migrateLegacy(id, executionId));
    },
    async readPage(id, executionId, input) {
      const current = await readMissionExecutionProjectionPage(
        currentPath(id, executionId),
        executionId,
        input,
      );
      if (current !== undefined) return current;
      const legacy = await migrateLegacy(id, executionId);
      if (legacy === undefined) return undefined;
      return await readMissionExecutionProjectionPage(
        currentPath(id, executionId),
        executionId,
        input,
      );
    },
    async write(id, executionId, entries) {
      await writeMissionExecutionProjection(currentPath(id, executionId), executionId, entries);
      await rm(legacyPath(id, executionId), { force: true });
    },
  };
}

async function readLegacyProjection(
  path: string,
): Promise<readonly MissionChatEntry[] | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== "pragma.mission-execution-projection/v1" ||
    !("entries" in value)
  ) {
    throw new MissionProjectionStorageError(
      "unsupported_schema",
      "Unsupported Mission projection schema.",
    );
  }
  return MissionChatEntrySchema.array().parse(value.entries);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
