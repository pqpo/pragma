import type { CapabilityCredentialStore } from "./capability-credential-store.ts";
import {
  readStorageFile as readFile,
  writeStorageFile as writeFile,
  replaceStorageFile as rename,
} from "@pragma/core";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { withFileLock } from "@pragma/core";
import {
  CapabilityDefinitionSchema,
  CapabilityIdSchema,
  CapabilityHealthSchema,
  CapabilityManifestSchema,
  CapabilitySchema,
  type Capability,
  type CapabilityManifest,
} from "@pragma/shared";
export const LegacyCapabilityManifestV1Schema = z.object({
  schemaVersion: z.literal("pragma.capability/v1"),
  id: z.string().uuid(),
  runtimeKey: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["skill", "mcp_server", "http_service", "code_service"]),
  latestRevision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const LegacyCapabilityManifestV2Schema = z.object({
  schemaVersion: z.literal("pragma.capability/v2"),
  id: CapabilityIdSchema,
  runtimeKey: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["skill", "mcp_server", "http_service", "code_service"]),
  latestRevision: z.number().int().positive(),
  origin: z
    .object({
      kind: z.literal("pragma-bundle"),
      logicalId: CapabilityIdSchema,
    })
    .strict()
    .optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const LegacyCapabilityManifestV3Schema = z.object({
  schemaVersion: z.literal("pragma.capability/v3"),
  id: CapabilityIdSchema,
  runtimeKey: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["skill", "mcp_server", "http_service", "code_service"]),
  latestRevision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const LegacyCapabilityManifestMigrationJournalSchema = z.object({
  schemaVersion: z.literal("pragma.capability-manifest-migration/v1"),
  sourceSchema: z.literal("pragma.capability/v1"),
  targetSchema: z.literal("pragma.capability/v2"),
  targetManifest: LegacyCapabilityManifestV2Schema,
});

export const CapabilityManifestMigrationJournalSchema = z.object({
  schemaVersion: z.literal("pragma.capability-manifest-migration/v2"),
  sourceSchema: z.enum(["pragma.capability/v1", "pragma.capability/v2"]),
  targetSchema: z.literal("pragma.capability/v3"),
  targetManifest: LegacyCapabilityManifestV3Schema,
});

export const CapabilityManifestV4MigrationJournalSchema = z.object({
  schemaVersion: z.literal("pragma.capability-manifest-migration/v3"),
  sourceSchema: z.enum(["pragma.capability/v1", "pragma.capability/v2", "pragma.capability/v3"]),
  targetSchema: z.literal("pragma.capability/v4"),
  targetManifest: CapabilityManifestSchema,
});

export const CapabilityDeletionJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.capability-deletion/v1"),
    capabilityId: CapabilityIdSchema,
    expectedRevision: z.number().int().positive(),
  })
  .strict();

export const CapabilityCreationJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.capability-creation/v1"),
    capabilityId: CapabilityIdSchema,
  })
  .strict();

export class CapabilityStoreError extends Error {
  constructor(
    readonly code:
      | "capability_not_found"
      | "config_invalid"
      | "import_invalid"
      | "capability_referenced"
      | "capability_incompatible"
      | "revision_conflict",
    message: string,
  ) {
    super(message);
    this.name = "CapabilityStoreError";
  }
}

export function revisionDirectory(revision: number): string {
  return revision.toString().padStart(6, "0");
}

export function firstZodIssue(error: unknown): string {
  if (!(error instanceof z.ZodError)) return "definition";
  const issue = error.issues[0];
  return issue === undefined ? "definition" : issue.path.join(".") || "definition";
}

export async function readCapabilityMigrationJournal(
  path: string,
): Promise<z.infer<typeof CapabilityManifestMigrationJournalSchema> | undefined> {
  try {
    return CapabilityManifestMigrationJournalSchema.parse(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof z.ZodError) {
      throw new CapabilityStoreError("config_invalid", "Capability migration journal is invalid.");
    }
    throw error;
  }
}

export async function readCapabilityV4MigrationJournal(
  path: string,
): Promise<z.infer<typeof CapabilityManifestV4MigrationJournalSchema> | undefined> {
  try {
    return CapabilityManifestV4MigrationJournalSchema.parse(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof z.ZodError) {
      throw new CapabilityStoreError("config_invalid", "Capability migration journal is invalid.");
    }
    throw error;
  }
}

export async function readLegacyCapabilityMigrationJournal(
  path: string,
): Promise<z.infer<typeof LegacyCapabilityManifestMigrationJournalSchema> | undefined> {
  try {
    return LegacyCapabilityManifestMigrationJournalSchema.parse(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof z.ZodError) {
      throw new CapabilityStoreError(
        "config_invalid",
        "Legacy Capability migration journal is invalid.",
      );
    }
    throw error;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

export function createLocalHostCapabilityReader(options: {
  readonly capabilitiesPath: string;
  readonly credentials: CapabilityCredentialStore;
}) {
  const capabilityPath = (id: string) => join(options.capabilitiesPath, id);

  const manifestPath = (id: string) => join(capabilityPath(id), "capability.json");

  const healthPath = (id: string) => join(capabilityPath(id), "health.json");

  const legacyMigrationJournalPath = (id: string) => join(capabilityPath(id), "v1-to-v2.json");

  const migrationJournalPath = (id: string) => join(capabilityPath(id), "manifest-to-v4.json");

  const v3MigrationJournalPath = (id: string) => join(capabilityPath(id), "manifest-to-v3.json");

  const deletionJournalPath = (id: string) => join(capabilityPath(id), "deletion.json");

  const creationJournalPath = (id: string) => join(capabilityPath(id), "creation.json");

  const revisionPath = (id: string, revision: number) =>
    join(capabilityPath(id), "revisions", revisionDirectory(revision));

  const recoverRemoval = async (id: string): Promise<void> => {
    let journal;
    try {
      journal = CapabilityDeletionJournalSchema.parse(
        JSON.parse(await readFile(deletionJournalPath(id), "utf8")) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new CapabilityStoreError(
        "config_invalid",
        `Capability ${id} has an invalid deletion journal.`,
      );
    }
    if (journal.capabilityId !== id) {
      throw new CapabilityStoreError(
        "config_invalid",
        `Capability ${id} has a deletion journal for another capability.`,
      );
    }
    await options.credentials.removeCapability(id);
    await rm(capabilityPath(id), { recursive: true, force: true });
  };

  const recoverCreation = async (id: string): Promise<void> => {
    let journal;
    try {
      journal = CapabilityCreationJournalSchema.parse(
        JSON.parse(await readFile(creationJournalPath(id), "utf8")) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new CapabilityStoreError(
        "config_invalid",
        `Capability ${id} has an invalid creation journal.`,
      );
    }
    if (journal.capabilityId !== id) {
      throw new CapabilityStoreError(
        "config_invalid",
        `Capability ${id} has a creation journal for another capability.`,
      );
    }
    const manifest = await readFile(manifestPath(id), "utf8")
      .then((content) => CapabilityManifestSchema.safeParse(JSON.parse(content) as unknown))
      .catch(() => undefined);
    const prepared = await options.credentials.pending(id);
    if (manifest?.success === true && manifest.data.id === id) {
      if (prepared !== undefined) {
        await options.credentials.activate(prepared);
        await options.credentials.finalize(prepared);
      }
      const health = CapabilityHealthSchema.parse(
        JSON.parse(await readFile(healthPath(id), "utf8")) as unknown,
      );
      if (
        health.status === "ready" &&
        manifest.data.activeRevision !== manifest.data.latestRevision
      ) {
        await writeJson(
          manifestPath(id),
          CapabilityManifestSchema.parse({
            ...manifest.data,
            activeRevision: manifest.data.latestRevision,
          }),
        );
      }
      await rm(creationJournalPath(id), { force: true });
      return;
    }
    if (prepared !== undefined) await options.credentials.rollback(prepared);
    await rm(capabilityPath(id), { recursive: true, force: true });
  };

  const migrateManifest = async (id: string): Promise<CapabilityManifest> =>
    await withFileLock(join(capabilityPath(id), ".v4-migration.lock"), async () => {
      let raw = JSON.parse(await readFile(manifestPath(id), "utf8")) as unknown;
      const current = CapabilityManifestSchema.safeParse(raw);
      if (current.success) return current.data;
      const pending = await readCapabilityV4MigrationJournal(migrationJournalPath(id));
      if (pending !== undefined) {
        if (pending.targetManifest.id !== id) {
          throw new CapabilityStoreError(
            "config_invalid",
            `Capability ${id} has a migration journal for another capability.`,
          );
        }
        await writeJson(manifestPath(id), pending.targetManifest);
        await rm(migrationJournalPath(id), { force: true });
        return pending.targetManifest;
      }

      const v3Pending = await readCapabilityMigrationJournal(v3MigrationJournalPath(id));
      if (v3Pending !== undefined) {
        if (v3Pending.targetManifest.id !== id) {
          throw new CapabilityStoreError(
            "config_invalid",
            `Capability ${id} has a migration journal for another capability.`,
          );
        }
        await writeJson(manifestPath(id), v3Pending.targetManifest);
        await rm(v3MigrationJournalPath(id), { force: true });
        raw = v3Pending.targetManifest;
      }

      const legacyPending = await readLegacyCapabilityMigrationJournal(
        legacyMigrationJournalPath(id),
      );
      if (legacyPending !== undefined) {
        if (legacyPending.targetManifest.id !== id) {
          throw new CapabilityStoreError(
            "config_invalid",
            `Capability ${id} has a migration journal for another capability.`,
          );
        }
        await writeJson(manifestPath(id), legacyPending.targetManifest);
        await rm(legacyMigrationJournalPath(id), { force: true });
        raw = legacyPending.targetManifest;
      }

      const legacyV3 = LegacyCapabilityManifestV3Schema.safeParse(raw);
      const legacyV2 = LegacyCapabilityManifestV2Schema.safeParse(raw);
      const legacyV1 = LegacyCapabilityManifestV1Schema.safeParse(raw);
      const legacy = legacyV3.success
        ? legacyV3.data
        : legacyV2.success
          ? legacyV2.data
          : legacyV1.success
            ? legacyV1.data
            : undefined;
      if (legacy === undefined || legacy.id !== id) {
        throw new CapabilityStoreError(
          "config_invalid",
          `Capability ${id} has an invalid manifest.`,
        );
      }

      for (let revision = 1; revision <= legacy.latestRevision; revision += 1) {
        try {
          CapabilityDefinitionSchema.parse(
            JSON.parse(
              await readFile(join(revisionPath(id, revision), "definition.json"), "utf8"),
            ) as unknown,
          );
        } catch (error) {
          throw new CapabilityStoreError(
            "config_invalid",
            `Capability ${id} revision ${revision} exceeds the current text limits at ${firstZodIssue(error)}. The original data was not changed.`,
          );
        }
      }

      const latestHealth = await readFile(healthPath(id), "utf8")
        .then((value) => CapabilityHealthSchema.safeParse(JSON.parse(value) as unknown))
        .catch(() => undefined);
      // Legacy manifests did not persist the last activated revision. When the latest revision
      // needs attention, guessing `latest - 1` can activate another failed candidate after
      // consecutive unsuccessful updates. Leave the Capability inactive until a successful retry
      // establishes an explicit active revision.
      const activeRevision =
        latestHealth?.success === true && latestHealth.data.status === "ready"
          ? legacy.latestRevision
          : undefined;
      const targetManifest = CapabilityManifestSchema.parse({
        ...legacy,
        schemaVersion: "pragma.capability/v4",
        ...(activeRevision === undefined ? {} : { activeRevision }),
        origin: undefined,
      });
      const sourceVersion = legacy.schemaVersion.slice(-2);
      const backupPath = join(
        capabilityPath(id),
        "migration-backups",
        `capability.${sourceVersion}.json`,
      );
      const journal = CapabilityManifestV4MigrationJournalSchema.parse({
        schemaVersion: "pragma.capability-manifest-migration/v3",
        sourceSchema: legacy.schemaVersion,
        targetSchema: "pragma.capability/v4",
        targetManifest,
      });
      await writeJson(backupPath, legacy);
      await writeJson(migrationJournalPath(id), journal);
      await writeJson(manifestPath(id), targetManifest);
      await rm(migrationJournalPath(id), { force: true });
      return targetManifest;
    });

  const readManifest = async (id: string): Promise<CapabilityManifest> => {
    await recoverCreation(id);
    await recoverRemoval(id);
    try {
      const raw = JSON.parse(await readFile(manifestPath(id), "utf8")) as unknown;
      const current = CapabilityManifestSchema.safeParse(raw);
      if (current.success) {
        await rm(migrationJournalPath(id), { force: true });
        return current.data;
      }
      if (
        LegacyCapabilityManifestV1Schema.safeParse(raw).success ||
        LegacyCapabilityManifestV2Schema.safeParse(raw).success ||
        LegacyCapabilityManifestV3Schema.safeParse(raw).success
      )
        return await migrateManifest(id);
      throw new CapabilityStoreError("config_invalid", `Capability ${id} has an invalid manifest.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CapabilityStoreError("capability_not_found", "The capability no longer exists.");
      }
      if (error instanceof CapabilityStoreError) throw error;
      throw new CapabilityStoreError("config_invalid", `Capability ${id} has an invalid manifest.`);
    }
  };

  const readCapability = async (id: string, requestedRevision?: number): Promise<Capability> => {
    const manifest = await readManifest(id);
    const revision = requestedRevision ?? manifest.latestRevision;
    try {
      const definition = CapabilityDefinitionSchema.parse(
        JSON.parse(
          await readFile(join(revisionPath(id, revision), "definition.json"), "utf8"),
        ) as unknown,
      );
      const latestHealth = CapabilityHealthSchema.parse(
        JSON.parse(await readFile(healthPath(id), "utf8")) as unknown,
      );
      const health =
        latestHealth.revision === revision
          ? latestHealth
          : CapabilityHealthSchema.parse({
              revision,
              status: "ready",
              checkedAt: manifest.updatedAt,
            });
      return CapabilitySchema.parse({
        manifest: { ...manifest, latestRevision: revision },
        definition,
        health,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CapabilityStoreError(
          "capability_not_found",
          `Capability ${id} revision ${revision} no longer exists.`,
        );
      }
      if (error instanceof CapabilityStoreError) throw error;
      throw new CapabilityStoreError(
        "config_invalid",
        `Capability ${id} revision ${revision} is invalid.`,
      );
    }
  };
  const resolveActive = async (id: string) => {
    const manifest = await readManifest(id);
    if ((await options.credentials.pending(id)) !== undefined) {
      throw new CapabilityStoreError(
        "capability_incompatible",
        `Capability ${id} is completing an active environment change.`,
      );
    }
    if (manifest.activeRevision === undefined) {
      throw new CapabilityStoreError(
        "capability_not_found",
        `Capability ${id} has no active ready revision.`,
      );
    }
    return await readCapability(id, manifest.activeRevision);
  };
  return {
    capabilityPath,
    manifestPath,
    healthPath,
    deletionJournalPath,
    creationJournalPath,
    revisionPath,
    recoverRemoval,
    readManifest,
    readCapability,
    resolveActive,
  };
}
