import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { decodePragmaPathSegment, PragmaPaths } from "@pragma/core";
import { managementCommandError } from "@pragma/shared/integration";

export const CommandOwnerSchema = z
  .object({
    schemaVersion: z.literal("pragma.management-command-owner/v1"),
    missionId: z.string().uuid(),
    contextId: z.string().min(1),
  })
  .strict();
export type CommandOwner = z.infer<typeof CommandOwnerSchema>;
export function commandOwnerPath(root: string, id: string): string {
  return join(root, "owners", `${createHash("sha256").update(id).digest("hex")}.json`);
}
export async function readCommandState<T>(
  path: string,
  schema: z.ZodType<T>,
  version: string,
): Promise<T | undefined> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw managementCommandError(
      "STORAGE_CORRUPTED",
      "The management command state is not valid JSON.",
    );
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    typeof value.schemaVersion === "string" &&
    value.schemaVersion !== version
  )
    throw managementCommandError(
      "STORAGE_VERSION_UNSUPPORTED",
      "This management command state version is not supported.",
    );
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw managementCommandError("STORAGE_CORRUPTED", "The management command state is invalid.");
  return parsed.data;
}
export async function readCommandOwner(root: string, id: string) {
  return await readCommandState(
    commandOwnerPath(root, id),
    CommandOwnerSchema,
    "pragma.management-command-owner/v1",
  );
}

/** Targeted compatibility lookup in Pragma-owned metadata, not native SDK Session trees or startup maintenance. */
export function createManagementCommandOwnerLookup(pragmaHome: string) {
  const paths = new PragmaPaths({ pragmaHome });
  return async (id: string, signal: AbortSignal): Promise<CommandOwner | undefined> => {
    let found: CommandOwner | undefined;
    for (const ownerId of await directoryIds(paths.runtimeSessionsRoot())) {
      for (const sessionId of await directoryIds(paths.runtimeOwnerRoot(ownerId))) {
        signal.throwIfAborted();
        const root = join(
          paths.ownedSystemSessionRoot(ownerId, sessionId),
          "management-commands",
          "v1",
        );
        const owner = await readCommandOwner(root, id);
        if (owner === undefined) continue;
        if (
          found !== undefined &&
          (found.missionId !== owner.missionId || found.contextId !== owner.contextId)
        )
          throw managementCommandError(
            "STORAGE_CORRUPTED",
            "The command target has conflicting ownership records.",
          );
        found = owner;
      }
    }
    return found;
  };
}
async function directoryIds(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) return [];
    try {
      return [decodePragmaPathSegment(entry.name)];
    } catch {
      return [];
    }
  });
}
