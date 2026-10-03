import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

const MissionDeletionIntentSchema = z
  .object({
    schemaVersion: z.literal("pragma.desktop-mission-deletion-intent/v1"),
    deletionId: z.string().uuid(),
    missionId: z.string().uuid(),
    requestedAt: z.string().datetime(),
  })
  .strict();

const MISSION_DELETION_INTENT_FILE = "deletion-intent.json";

export async function hasMissionDeletionIntent(
  storagePath: string | undefined,
  missionId?: string,
): Promise<boolean> {
  if (storagePath === undefined) return false;
  try {
    const intent = MissionDeletionIntentSchema.parse(
      JSON.parse(await readFile(join(storagePath, MISSION_DELETION_INTENT_FILE), "utf8")),
    );
    if (missionId !== undefined && intent.missionId !== missionId) {
      throw new Error("Mission deletion intent owner does not match its storage directory.");
    }
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function persistMissionDeletionIntent(
  storagePath: string | undefined,
  missionId: string,
): Promise<void> {
  if (storagePath === undefined) return;
  await mkdir(storagePath, { recursive: true, mode: 0o700 });
  const target = join(storagePath, MISSION_DELETION_INTENT_FILE);
  if (await hasMissionDeletionIntent(storagePath, missionId)) return;
  const temporary = `${target}.${randomUUID()}.tmp`;
  const intent = MissionDeletionIntentSchema.parse({
    schemaVersion: "pragma.desktop-mission-deletion-intent/v1",
    deletionId: randomUUID(),
    missionId,
    requestedAt: new Date().toISOString(),
  });
  await writeFile(temporary, `${JSON.stringify(intent, undefined, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}
