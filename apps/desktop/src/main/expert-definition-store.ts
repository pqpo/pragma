import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CreateExpertDefinitionSchema,
  ExpertDefinitionSchema,
  ExpertModelConfigSchema,
  ExpertSummarySchema,
  UpdateExpertDefinitionSchema,
  type CreateExpertDefinition,
  type ExpertDefinition,
  type ExpertSummary,
  type UpdateExpertDefinition,
} from "../shared/desktop-api.ts";

const EXPERT_SCHEMA_VERSION_V1 = "pragma.expert/v1";
const EXPERT_SCHEMA_VERSION_V2 = "pragma.expert/v2";
const CURRENT_EXPERT_SCHEMA_VERSION = EXPERT_SCHEMA_VERSION_V2;
const MODULE_SCHEMA_VERSION = 1;

export interface ExpertDefinitionStore {
  list(): Promise<ExpertSummary[]>;
  get(id: string): Promise<ExpertDefinition>;
  create(input: CreateExpertDefinition): Promise<ExpertDefinition>;
  update(id: string, input: UpdateExpertDefinition): Promise<ExpertDefinition>;
  remove(id: string): Promise<void>;
}

export class ExpertDefinitionStoreError extends Error {
  constructor(
    readonly code: "config_invalid" | "expert_exists" | "expert_not_found",
    message: string,
  ) {
    super(message);
    this.name = "ExpertDefinitionStoreError";
  }
}

function revisionDirectory(revision: number): string {
  return revision.toString().padStart(6, "0");
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ExpertDefinitionStoreError("config_invalid", `${label} is not valid JSON.`);
  }
}

async function writeFileAtomically(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

function summaryOf(expert: ExpertDefinition): ExpertSummary {
  return ExpertSummarySchema.parse(expert);
}

function parseModule<T>(raw: string, label: string, key: string): T {
  const value = parseJson(raw, label);
  if (
    !value ||
    typeof value !== "object" ||
    (value as { schemaVersion?: unknown }).schemaVersion !== MODULE_SCHEMA_VERSION
  ) {
    throw new ExpertDefinitionStoreError("config_invalid", `${label} has an unsupported format.`);
  }
  return (value as Record<string, unknown>)[key] as T;
}

const LegacyPiModelConfigSchema = ExpertModelConfigSchema.options[0].omit({ runtimeId: true });

function parseModelModule(raw: string): {
  readonly model: ExpertDefinition["model"];
  readonly migrated: boolean;
} {
  const stored = parseModule<unknown>(raw, "model.json", "model");
  if (stored === null) return { model: null, migrated: false };

  const current = ExpertModelConfigSchema.safeParse(stored);
  if (current.success) return { model: current.data, migrated: false };

  const legacyPi = LegacyPiModelConfigSchema.safeParse(stored);
  if (legacyPi.success) {
    return {
      model: { runtimeId: "pi", ...legacyPi.data },
      migrated: true,
    };
  }

  throw new ExpertDefinitionStoreError(
    "config_invalid",
    "model.json has an invalid model configuration.",
  );
}

export function createExpertDefinitionStore(options: {
  readonly expertsPath: string;
}): ExpertDefinitionStore {
  const expertPath = (id: string) => join(options.expertsPath, id);
  const manifestPath = (id: string) => join(expertPath(id), "expert.json");

  const migrateV1Revision = async (id: string, revision: string): Promise<void> => {
    const revisionPath = join(expertPath(id), "revisions", revision);
    const [skills, mcpServers, tools, migratedCapabilities] = await Promise.all([
      readFile(join(revisionPath, "skills.json"), "utf8"),
      readFile(join(revisionPath, "mcp.json"), "utf8"),
      readFile(join(revisionPath, "tools.json"), "utf8"),
      readFile(join(revisionPath, "capabilities.json"), "utf8").catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }),
    ]);
    const legacySkills = parseModule<unknown>(skills, "skills.json", "skills");
    const legacyMcpServers = parseModule<unknown>(mcpServers, "mcp.json", "servers");
    const storedLegacyToolIds = parseModule<unknown>(tools, "tools.json", "toolIds");
    const alreadyMigratedCapabilities = migratedCapabilities
      ? parseModule<unknown>(migratedCapabilities, "capabilities.json", "capabilities")
      : undefined;
    const legacyToolIds =
      storedLegacyToolIds === undefined &&
      Array.isArray(alreadyMigratedCapabilities) &&
      alreadyMigratedCapabilities.length === 0
        ? []
        : storedLegacyToolIds;
    const approvals = parseModule<unknown>(tools, "tools.json", "approvals");

    const unsupported = [
      ["skills", legacySkills],
      ["MCP servers", legacyMcpServers],
      ["tools", legacyToolIds],
    ].filter(
      (entry): entry is [string, unknown[]] => Array.isArray(entry[1]) && entry[1].length > 0,
    );
    if (unsupported.length > 0) {
      throw new ExpertDefinitionStoreError(
        "config_invalid",
        `Expert ${id} revision ${Number(revision)} cannot be migrated to ${EXPERT_SCHEMA_VERSION_V2} because it contains legacy ${unsupported.map(([label]) => label).join(", ")}. Import them into the capability library first.`,
      );
    }
    if (
      !Array.isArray(legacySkills) ||
      !Array.isArray(legacyMcpServers) ||
      !Array.isArray(legacyToolIds)
    ) {
      throw new ExpertDefinitionStoreError(
        "config_invalid",
        `Expert ${id} revision ${Number(revision)} has invalid legacy capability modules.`,
      );
    }

    await writeJson(join(revisionPath, "capabilities.json"), {
      schemaVersion: MODULE_SCHEMA_VERSION,
      capabilities: [],
    });
    await writeJson(join(revisionPath, "tools.json"), {
      schemaVersion: MODULE_SCHEMA_VERSION,
      approvals,
    });
  };

  const migrateV1Expert = async (
    id: string,
    manifest: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const migratedSummary = ExpertSummarySchema.safeParse({
      ...manifest,
      schemaVersion: EXPERT_SCHEMA_VERSION_V2,
    });
    if (!migratedSummary.success) {
      throw new ExpertDefinitionStoreError(
        "config_invalid",
        `Expert ${id} has an invalid ${EXPERT_SCHEMA_VERSION_V1} manifest.`,
      );
    }

    const revisionsPath = join(expertPath(id), "revisions");
    const revisions = (await readdir(revisionsPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d{6}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    if (revisions.length === 0) {
      throw new ExpertDefinitionStoreError(
        "config_invalid",
        `Expert ${id} has no revisions to migrate.`,
      );
    }

    for (const revision of revisions) {
      await migrateV1Revision(id, revision);
    }

    // The manifest is the commit marker. Keeping it on v1 until every revision is
    // converted makes an interrupted migration safe to retry.
    await writeJson(manifestPath(id), migratedSummary.data);
    return migratedSummary.data;
  };

  const migrateStoredExperts = async (): Promise<void> => {
    let entries;
    try {
      entries = await readdir(options.expertsPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
      const rawManifest = parseJson(
        await readFile(manifestPath(entry.name), "utf8"),
        "expert.json",
      );
      if (!rawManifest || typeof rawManifest !== "object") {
        throw new ExpertDefinitionStoreError(
          "config_invalid",
          `Expert ${entry.name} has an invalid manifest.`,
        );
      }
      let manifest = rawManifest as Record<string, unknown>;
      while (manifest.schemaVersion !== CURRENT_EXPERT_SCHEMA_VERSION) {
        if (manifest.schemaVersion === EXPERT_SCHEMA_VERSION_V1) {
          manifest = await migrateV1Expert(entry.name, manifest);
          continue;
        }
        throw new ExpertDefinitionStoreError(
          "config_invalid",
          `Expert ${entry.name} uses unsupported schema version ${String(manifest.schemaVersion)}.`,
        );
      }
    }
  };

  let migrationPromise: Promise<void> | undefined;
  const ensureMigrations = async (): Promise<void> => {
    migrationPromise ??= migrateStoredExperts();
    try {
      await migrationPromise;
    } catch (error) {
      migrationPromise = undefined;
      throw error;
    }
  };

  const readSummary = async (id: string): Promise<ExpertSummary> => {
    try {
      return ExpertSummarySchema.parse(
        parseJson(await readFile(manifestPath(id), "utf8"), "expert.json"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ExpertDefinitionStoreError("expert_not_found", "The expert no longer exists.");
      }
      if (error instanceof ExpertDefinitionStoreError) throw error;
      throw new ExpertDefinitionStoreError(
        "config_invalid",
        `Expert ${id} has an invalid manifest.`,
      );
    }
  };

  const readDefinition = async (id: string): Promise<ExpertDefinition> => {
    const summary = await readSummary(id);
    const revisionPath = join(expertPath(id), "revisions", revisionDirectory(summary.revision));
    try {
      const [instructions, model, capabilities, tools, plugins, context] = await Promise.all([
        readFile(join(revisionPath, "instructions.md"), "utf8"),
        readFile(join(revisionPath, "model.json"), "utf8"),
        readFile(join(revisionPath, "capabilities.json"), "utf8"),
        readFile(join(revisionPath, "tools.json"), "utf8"),
        readFile(join(revisionPath, "plugins.json"), "utf8"),
        readFile(join(revisionPath, "context.json"), "utf8"),
      ]);
      const parsedModel = parseModelModule(model);
      if (parsedModel.migrated) {
        await writeJson(join(revisionPath, "model.json"), {
          schemaVersion: MODULE_SCHEMA_VERSION,
          model: parsedModel.model,
        });
      }
      return ExpertDefinitionSchema.parse({
        ...summary,
        instructions: instructions || undefined,
        model: parsedModel.model,
        capabilities: parseModule<ExpertDefinition["capabilities"]>(
          capabilities,
          "capabilities.json",
          "capabilities",
        ),
        toolApprovals: parseModule<ExpertDefinition["toolApprovals"]>(
          tools,
          "tools.json",
          "approvals",
        ),
        plugins: parseModule<ExpertDefinition["plugins"]>(plugins, "plugins.json", "plugins"),
        contextStoreMounts: parseModule<ExpertDefinition["contextStoreMounts"]>(
          context,
          "context.json",
          "stores",
        ),
      });
    } catch (error) {
      if (error instanceof ExpertDefinitionStoreError) throw error;
      throw new ExpertDefinitionStoreError(
        "config_invalid",
        `Expert ${id} revision ${summary.revision} is incomplete or invalid.`,
      );
    }
  };

  const writeDefinition = async (expert: ExpertDefinition): Promise<void> => {
    const directory = expertPath(expert.id);
    const revisionsPath = join(directory, "revisions");
    const revision = revisionDirectory(expert.revision);
    const targetPath = join(revisionsPath, revision);
    const temporaryPath = join(revisionsPath, `.${revision}.${randomUUID()}.tmp`);
    await mkdir(temporaryPath, { recursive: true, mode: 0o700 });
    try {
      await Promise.all([
        writeFile(join(temporaryPath, "instructions.md"), expert.instructions ?? "", {
          mode: 0o600,
        }),
        writeJson(join(temporaryPath, "model.json"), {
          schemaVersion: MODULE_SCHEMA_VERSION,
          model: expert.model,
        }),
        writeJson(join(temporaryPath, "capabilities.json"), {
          schemaVersion: MODULE_SCHEMA_VERSION,
          capabilities: expert.capabilities,
        }),
        writeJson(join(temporaryPath, "tools.json"), {
          schemaVersion: MODULE_SCHEMA_VERSION,
          approvals: expert.toolApprovals,
        }),
        writeJson(join(temporaryPath, "plugins.json"), {
          schemaVersion: MODULE_SCHEMA_VERSION,
          plugins: expert.plugins,
        }),
        writeJson(join(temporaryPath, "context.json"), {
          schemaVersion: MODULE_SCHEMA_VERSION,
          stores: expert.contextStoreMounts,
        }),
      ]);
      await mkdir(revisionsPath, { recursive: true, mode: 0o700 });
      await rename(temporaryPath, targetPath);
      await writeJson(manifestPath(expert.id), summaryOf(expert));
    } catch (error) {
      await rm(temporaryPath, { recursive: true, force: true });
      throw error;
    }
  };

  return {
    async list(): Promise<ExpertSummary[]> {
      await ensureMigrations();
      try {
        const entries = await readdir(options.expertsPath, { withFileTypes: true });
        const summaries = await Promise.all(
          entries.filter((entry) => entry.isDirectory()).map((entry) => readSummary(entry.name)),
        );
        return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },

    async get(id: string): Promise<ExpertDefinition> {
      await ensureMigrations();
      return await readDefinition(id);
    },

    async create(input: CreateExpertDefinition): Promise<ExpertDefinition> {
      await ensureMigrations();
      const parsed = CreateExpertDefinitionSchema.parse(input);
      const existingIds = await readdir(options.expertsPath, { withFileTypes: true }).catch(
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        },
      );
      if (
        existingIds.some(
          (entry) => entry.isDirectory() && entry.name.toLowerCase() === parsed.id.toLowerCase(),
        )
      ) {
        throw new ExpertDefinitionStoreError(
          "expert_exists",
          "An expert with this ID already exists.",
        );
      }
      const timestamp = new Date().toISOString();
      const expert = ExpertDefinitionSchema.parse({
        schemaVersion: CURRENT_EXPERT_SCHEMA_VERSION,
        ...parsed,
        instructions: parsed.instructions ?? undefined,
        model: parsed.model ?? null,
        capabilities: parsed.capabilities ?? [],
        toolApprovals: parsed.toolApprovals ?? {},
        plugins: parsed.plugins ?? [],
        contextStoreMounts: parsed.contextStoreMounts ?? [],
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await writeDefinition(expert);
      return expert;
    },

    async update(id: string, input: UpdateExpertDefinition): Promise<ExpertDefinition> {
      await ensureMigrations();
      const current = await readDefinition(id);
      const parsed = UpdateExpertDefinitionSchema.parse(input);
      const expert = ExpertDefinitionSchema.parse({
        ...current,
        ...parsed,
        id,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      await writeDefinition(expert);
      return expert;
    },

    async remove(id: string): Promise<void> {
      await ensureMigrations();
      await readSummary(id);
      await rm(expertPath(id), { recursive: true, force: true });
    },
  };
}
