import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { withFileLock } from "@pragma/core";
import { z } from "zod";

const RECENT_WORKSPACE_LIMIT = 5;

const WorkspaceHistorySchema = z.object({
  schemaVersion: z.literal(1),
  recentWorkspaces: z.array(z.string().trim().min(1).max(2_000)).max(RECENT_WORKSPACE_LIMIT),
});

type WorkspaceHistory = z.infer<typeof WorkspaceHistorySchema>;

export interface WorkspaceHistoryStore {
  list(): Promise<readonly string[]>;
  record(path: string): Promise<void>;
}

export async function availableRecentWorkspaces(
  paths: readonly string[],
  excludedPath: string,
  validate: (path: string) => boolean | Promise<boolean>,
): Promise<readonly string[]> {
  const candidates = paths.filter((path) => path !== excludedPath).slice(0, RECENT_WORKSPACE_LIMIT);
  const availability = await Promise.all(candidates.map(async (path) => await validate(path)));
  return candidates.filter((_path, index) => availability[index]);
}

export function createWorkspaceHistoryStore(options: {
  readonly historyPath: string;
  readonly warn?: ((message: string, error: unknown) => void) | undefined;
}): WorkspaceHistoryStore {
  const lockPath = `${options.historyPath}.lock`;
  const emptyHistory: WorkspaceHistory = { schemaVersion: 1, recentWorkspaces: [] };

  const readHistory = async (): Promise<WorkspaceHistory> => {
    try {
      return WorkspaceHistorySchema.parse(JSON.parse(await readFile(options.historyPath, "utf8")));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return emptyHistory;
      options.warn?.("Workspace history could not be read; using an empty history.", error);
      return emptyHistory;
    }
  };

  return {
    async list() {
      return (await readHistory()).recentWorkspaces;
    },
    async record(path) {
      await withFileLock(lockPath, async () => {
        const current = await readHistory();
        const history = WorkspaceHistorySchema.parse({
          schemaVersion: 1,
          recentWorkspaces: [
            path,
            ...current.recentWorkspaces.filter((workspace) => workspace !== path),
          ].slice(0, RECENT_WORKSPACE_LIMIT),
        });
        const directory = dirname(options.historyPath);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700).catch(() => undefined);
        const temporaryPath = `${options.historyPath}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600 });
        await rename(temporaryPath, options.historyPath);
        await chmod(options.historyPath, 0o600).catch(() => undefined);
      });
    },
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
