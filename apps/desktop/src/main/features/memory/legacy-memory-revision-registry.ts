import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { PragmaPaths, withFileLock } from "@pragma/core";
import { MissionStoreError, type MissionStore } from "@pragma/local-host";
import type { LegacyLearningTaskIdentity } from "@pragma/memory";
import { isMemoryRevisionPlanningRun } from "./memory-revision-planning-resource.ts";

const IdentitySchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-legacy-planner-identity/v1"),
    missionId: z.string().uuid(),
    kind: z.enum(["knowledge", "skill"]),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
type Identity = z.infer<typeof IdentitySchema>;
const missingOwner = () =>
  Object.assign(new Error("memory_legacy_revision_owner_missing"), {
    code: "memory_legacy_revision_owner_missing",
    retryable: false,
  });

/** Supplement historical empty markers without rewriting or discarding them. */
export function createLegacyMemoryRevisionRegistry(options: {
  readonly pragmaHome: string;
  readonly missions: MissionStore;
}) {
  const state = new PragmaPaths(options).stateRoot();
  const registry = join(state, "memory-revision-planning");
  const identities = join(state, "memory-legacy-planner-identities-v1");
  const identityPath = (id: string) => join(identities, `${id}.json`);
  const readIdentity = async (id: string): Promise<Identity | undefined> => {
    let raw: string;
    try {
      raw = await readFile(identityPath(id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (cause) {
      throw new Error("memory_legacy_revision_identity_invalid", { cause });
    }
    const parsed = IdentitySchema.safeParse(value);
    if (!parsed.success || parsed.data.missionId !== id)
      throw new Error("memory_legacy_revision_identity_invalid");
    return parsed.data;
  };
  const remember = async (identity: Identity) => {
    await mkdir(identities, { recursive: true, mode: 0o700 });
    await withFileLock(`${identityPath(identity.missionId)}.lock`, async () => {
      const previous = await readIdentity(identity.missionId);
      if (previous !== undefined) {
        if (JSON.stringify(previous) !== JSON.stringify(identity))
          throw new Error("memory_legacy_revision_identity_mismatch");
        return;
      }
      const path = identityPath(identity.missionId);
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(identity), { mode: 0o600 });
      await rename(temporary, path);
    });
  };
  return {
    async find(
      kind: Identity["kind"],
      digest: string,
      task?: LegacyLearningTaskIdentity,
      requireKnownOwner = false,
    ) {
      if (task !== undefined && !Number.isFinite(Date.parse(task.taskCreatedAt)))
        throw new Error("memory_legacy_revision_identity_invalid");
      let ids: string[];
      try {
        ids = await readdir(registry);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      let ambiguous = false;
      for (const id of ids.filter((id) => /^[0-9a-f-]{36}$/u.test(id))) {
        try {
          const settled = JSON.parse(await readFile(join(registry, `${id}.settled`), "utf8")) as {
            schemaVersion?: string;
            missionId?: string;
          };
          if (
            settled.schemaVersion !== "pragma.memory-legacy-plan-settlement/v1" ||
            settled.missionId !== id
          )
            throw new Error("memory_legacy_revision_settlement_invalid");
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const recorded = await readIdentity(id);
        if (recorded !== undefined && (recorded.kind !== kind || recorded.sourceDigest !== digest))
          continue;
        let mission;
        try {
          mission = await options.missions.get(id);
        } catch (error) {
          if (!(error instanceof MissionStoreError) || error.code !== "mission_not_found")
            throw error;
          if (recorded !== undefined) throw missingOwner();
          // Empty legacy markers cannot identify their deleted Mission. A task
          // created after the marker, or proven never attempted, cannot own it.
          let marker;
          try {
            marker = await stat(join(registry, id));
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw cause;
          }
          ambiguous ||=
            requireKnownOwner ||
            (task?.mayHaveRun === true && Date.parse(task.taskCreatedAt) <= marker.mtimeMs);
          continue;
        }
        if (
          !isMemoryRevisionPlanningRun(mission.origin, mission.executor.ref) ||
          mission.origin.type !== "system-memory"
        )
          continue;
        const match = /^(knowledge|skill)-plan:([a-f0-9]{64})$/u.exec(mission.origin.jobId);
        if (match === null || mission.id !== id)
          throw new Error("memory_legacy_revision_identity_invalid");
        const identity = IdentitySchema.parse({
          schemaVersion: "pragma.memory-legacy-planner-identity/v1",
          missionId: id,
          kind: match[1],
          sourceDigest: match[2],
        });
        await remember(identity);
        if (identity.kind === kind && identity.sourceDigest === digest) return mission;
      }
      if (ambiguous) throw missingOwner();
      return undefined;
    },
  };
}
