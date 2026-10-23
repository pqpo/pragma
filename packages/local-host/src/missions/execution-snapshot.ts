import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { RuntimeModelSelectionSchema } from "@pragma/shared";
import { PragmaResourceSchema } from "@pragma/interpreter/ast";

const ModelOverrideSchema = z.object({
  runtimeId: z.string().min(1),
  modelSelection: RuntimeModelSelectionSchema.optional(),
});

/** Declarative inputs only: native Sessions, callbacks and credentials stay with their owners. */
export const MissionExecutionSnapshotSchema = z.object({
  schemaVersion: z.literal("pragma.mission-execution-snapshot/v1"),
  missionId: z.string().min(1),
  project: z.object({ id: z.string().min(1), revision: z.number().int().positive() }),
  executorRef: z.string().min(1),
  resources: z.array(PragmaResourceSchema),
  fingerprints: z.array(z.tuple([z.string(), z.string()])),
  capabilities: z.array(
    z.object({
      capabilityId: z.string().min(1),
      resolvedRevision: z.number().int().positive(),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
  pluginRefs: z.array(z.string().min(1)),
  sources: z.record(
    z.string(),
    z.object({
      expertResource: PragmaResourceSchema.optional(),
      additionalResources: z.array(PragmaResourceSchema),
      rootExecutionOverride: ModelOverrideSchema.optional(),
      rootModelSelectionOverride: RuntimeModelSelectionSchema.optional(),
      defaultModelSelection: RuntimeModelSelectionSchema.optional(),
    }),
  ),
});

export type MissionExecutionSnapshot = z.infer<typeof MissionExecutionSnapshotSchema>;

export async function readMissionExecutionSnapshot(
  path: string,
): Promise<MissionExecutionSnapshot | undefined> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  // A damaged/future snapshot must never fall back to today's configuration.
  return MissionExecutionSnapshotSchema.parse(JSON.parse(source));
}

/** Caller holds the snapshot lock; rename is the only commit point. */
export async function writeMissionExecutionSnapshot(
  path: string,
  snapshot: MissionExecutionSnapshot,
): Promise<void> {
  const value = MissionExecutionSnapshotSchema.parse(snapshot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Deletion-time query only; snapshots are strong references for their Mission's lifetime. */
export async function missionExecutionSnapshotsReference(
  missionsPath: string,
  target: { readonly capabilityId: string } | { readonly pluginRef: string },
): Promise<boolean> {
  const entries = await readdir(missionsPath, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const snapshot = await readMissionExecutionSnapshot(
      join(missionsPath, entry.name, "execution-snapshot.json"),
    );
    if (snapshot === undefined) continue;
    if ("capabilityId" in target) {
      if (snapshot.capabilities.some((pin) => pin.capabilityId === target.capabilityId))
        return true;
    } else {
      if (snapshot.pluginRefs.includes(target.pluginRef)) return true;
      const resources = [
        ...snapshot.resources,
        ...Object.values(snapshot.sources).flatMap((source) => [
          ...source.additionalResources,
          ...(source.expertResource === undefined ? [] : [source.expertResource]),
        ]),
      ];
      if (
        resources.some(
          (resource) =>
            resource.kind === "Expert" &&
            resource.spec.plugins.some((plugin) => plugin.ref === target.pluginRef),
        )
      )
        return true;
    }
  }
  return false;
}
