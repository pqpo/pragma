import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { withFileLock } from "@pragma/core";
import { z } from "zod";

import {
  HomeExecutorFavoriteScopeSchema,
  type HomeExecutorFavoriteScope,
  type UpdateHomeExecutorPreference,
} from "../../../shared/contracts/index.ts";

const HOME_EXECUTOR_PREFERENCE_LIMIT = 5_000;

const HomeExecutorPreferenceEntryInputSchema = z
  .object({
    ref: z.string().trim().min(1).max(500),
    favoriteScope: HomeExecutorFavoriteScopeSchema,
    hidden: z.boolean(),
    favoriteWorkspace: z.string().trim().min(1).max(2_000).optional(),
    lastWorkspace: z.string().trim().min(1).max(2_000).optional(),
    lastUsedAt: z.string().datetime().optional(),
  })
  .strict();

const HomeExecutorPreferenceEntrySchema = HomeExecutorPreferenceEntryInputSchema.superRefine(
  (entry, context) => {
    if (
      entry.favoriteScope === "workspace" &&
      entry.favoriteWorkspace === undefined &&
      entry.lastWorkspace === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["favoriteWorkspace"],
        message: "A workspace favorite requires a favorite workspace.",
      });
    }
    if (entry.favoriteWorkspace !== undefined && entry.favoriteScope !== "workspace") {
      context.addIssue({
        code: "custom",
        path: ["favoriteWorkspace"],
        message: "A favorite workspace requires a workspace-scoped favorite.",
      });
    }
  },
).transform((entry) =>
  entry.favoriteScope === "workspace" &&
  entry.favoriteWorkspace === undefined &&
  entry.lastWorkspace !== undefined
    ? { ...entry, favoriteWorkspace: entry.lastWorkspace }
    : entry,
);

const HomeExecutorPreferenceFileSchema = z
  .object({
    schemaVersion: z.literal("pragma.desktop-home-executor-preferences/v1"),
    entries: z.array(HomeExecutorPreferenceEntrySchema).max(HOME_EXECUTOR_PREFERENCE_LIMIT),
  })
  .strict();

export type HomeExecutorPreferenceEntry = z.infer<typeof HomeExecutorPreferenceEntrySchema>;

export interface HomeExecutorPreferenceStore {
  list(): Promise<readonly HomeExecutorPreferenceEntry[]>;
  prune(validRefs: ReadonlySet<string>): Promise<void>;
  recordUsage(input: {
    readonly ref: string;
    readonly workspace: string;
    readonly usedAt?: string | undefined;
  }): Promise<HomeExecutorPreferenceEntry>;
  update(input: UpdateHomeExecutorPreference): Promise<HomeExecutorPreferenceEntry>;
}

export function createHomeExecutorPreferenceStore(options: {
  readonly preferencesPath: string;
  readonly warn?: ((message: string, error: unknown) => void) | undefined;
}): HomeExecutorPreferenceStore {
  const lockPath = `${options.preferencesPath}.lock`;
  const emptyFile = {
    schemaVersion: "pragma.desktop-home-executor-preferences/v1" as const,
    entries: [],
  };

  const readPreferences = async (): Promise<z.infer<typeof HomeExecutorPreferenceFileSchema>> => {
    try {
      return HomeExecutorPreferenceFileSchema.parse(
        JSON.parse(await readFile(options.preferencesPath, "utf8")),
      );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return emptyFile;
      options.warn?.("Home executor preferences could not be read; using defaults.", error);
      return emptyFile;
    }
  };

  const writePreferences = async (
    file: z.infer<typeof HomeExecutorPreferenceFileSchema>,
  ): Promise<void> => {
    const parsed = HomeExecutorPreferenceFileSchema.parse(file);
    const directory = dirname(options.preferencesPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    const temporaryPath = `${options.preferencesPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, options.preferencesPath);
    await chmod(options.preferencesPath, 0o600).catch(() => undefined);
  };

  const mutate = async (
    ref: string,
    update: (current: HomeExecutorPreferenceEntry | undefined) => HomeExecutorPreferenceEntry,
  ): Promise<HomeExecutorPreferenceEntry> =>
    await withFileLock(lockPath, async () => {
      const file = await readPreferences();
      const current = file.entries.find((entry) => entry.ref === ref);
      const next = HomeExecutorPreferenceEntrySchema.parse(update(current));
      const entries = [next, ...file.entries.filter((entry) => entry.ref !== ref)].slice(
        0,
        HOME_EXECUTOR_PREFERENCE_LIMIT,
      );
      await writePreferences({
        schemaVersion: "pragma.desktop-home-executor-preferences/v1",
        entries,
      });
      return next;
    });

  return {
    async list() {
      return (await readPreferences()).entries;
    },
    async prune(validRefs) {
      await withFileLock(lockPath, async () => {
        const file = await readPreferences();
        const entries = file.entries.filter((entry) => validRefs.has(entry.ref));
        if (entries.length === file.entries.length) return;
        await writePreferences({
          schemaVersion: "pragma.desktop-home-executor-preferences/v1",
          entries,
        });
      });
    },
    async recordUsage(input) {
      return await mutate(input.ref, (current) => ({
        ref: input.ref,
        favoriteScope: current?.favoriteScope ?? "none",
        hidden: current?.hidden ?? false,
        ...(current?.favoriteWorkspace === undefined
          ? {}
          : { favoriteWorkspace: current.favoriteWorkspace }),
        lastWorkspace: normalizeWorkspace(input.workspace),
        lastUsedAt: input.usedAt ?? new Date().toISOString(),
      }));
    },
    async update(input) {
      return await mutate(input.ref, (current) => {
        if (
          input.hidden === true &&
          input.favoriteScope !== undefined &&
          input.favoriteScope !== "none"
        ) {
          throw new Error("A hidden Home executor cannot also be favorited.");
        }
        if (input.favoriteScope === "workspace" && input.favoriteWorkspace === undefined) {
          throw new Error("A workspace favorite requires a favorite workspace.");
        }
        if (input.favoriteWorkspace !== undefined && input.favoriteScope !== "workspace") {
          throw new Error("A favorite workspace can only be set for a workspace favorite.");
        }
        const requestedFavoriteScope: HomeExecutorFavoriteScope =
          input.hidden === true
            ? "none"
            : (input.favoriteScope ?? current?.favoriteScope ?? "none");
        const requestedFavoriteWorkspace =
          input.favoriteWorkspace === undefined
            ? undefined
            : normalizeWorkspace(input.favoriteWorkspace);
        const lastWorkspace =
          input.clearLastWorkspace === true ? undefined : current?.lastWorkspace;
        const favoriteWorkspace =
          requestedFavoriteScope === "workspace"
            ? (requestedFavoriteWorkspace ?? current?.favoriteWorkspace)
            : undefined;
        if (requestedFavoriteScope === "workspace" && favoriteWorkspace === undefined) {
          throw new Error("A workspace favorite requires a favorite workspace.");
        }
        return {
          ref: input.ref,
          favoriteScope: requestedFavoriteScope,
          hidden: input.hidden ?? current?.hidden ?? false,
          ...(favoriteWorkspace === undefined ? {} : { favoriteWorkspace }),
          ...(lastWorkspace === undefined ? {} : { lastWorkspace }),
          ...(current?.lastUsedAt === undefined ? {} : { lastUsedAt: current.lastUsedAt }),
        };
      });
    },
  };
}

function normalizeWorkspace(path: string): string {
  return resolve(path);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
