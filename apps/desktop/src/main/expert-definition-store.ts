import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CreateExpertDefinitionSchema,
  ExpertDefinitionSchema,
  ExpertSummarySchema,
  UpdateExpertDefinitionSchema,
  type CreateExpertDefinition,
  type ExpertDefinition,
  type ExpertSummary,
  type UpdateExpertDefinition,
} from "../shared/desktop-api.ts";

const EXPERT_SCHEMA_VERSION = "pragma.expert/v1";
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

export function createExpertDefinitionStore(options: {
  readonly expertsPath: string;
}): ExpertDefinitionStore {
  const expertPath = (id: string) => join(options.expertsPath, id);
  const manifestPath = (id: string) => join(expertPath(id), "expert.json");

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
      const [instructions, model, skills, mcpServers, tools, plugins, context] = await Promise.all([
        readFile(join(revisionPath, "instructions.md"), "utf8"),
        readFile(join(revisionPath, "model.json"), "utf8"),
        readFile(join(revisionPath, "skills.json"), "utf8"),
        readFile(join(revisionPath, "mcp.json"), "utf8"),
        readFile(join(revisionPath, "tools.json"), "utf8"),
        readFile(join(revisionPath, "plugins.json"), "utf8"),
        readFile(join(revisionPath, "context.json"), "utf8"),
      ]);
      return ExpertDefinitionSchema.parse({
        ...summary,
        instructions: instructions || undefined,
        model: parseModule<ExpertDefinition["model"]>(model, "model.json", "model"),
        skills: parseModule<ExpertDefinition["skills"]>(skills, "skills.json", "skills"),
        mcpServers: parseModule<ExpertDefinition["mcpServers"]>(mcpServers, "mcp.json", "servers"),
        toolIds: parseModule<ExpertDefinition["toolIds"]>(tools, "tools.json", "toolIds"),
        toolApprovals: parseModule<ExpertDefinition["toolApprovals"]>(
          tools,
          "tools.json",
          "approvals",
        ),
        plugins: parseModule<ExpertDefinition["plugins"]>(plugins, "plugins.json", "plugins"),
        contextSources: parseModule<ExpertDefinition["contextSources"]>(
          context,
          "context.json",
          "sources",
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
        writeJson(join(temporaryPath, "skills.json"), {
          schemaVersion: MODULE_SCHEMA_VERSION,
          skills: expert.skills,
        }),
        writeJson(join(temporaryPath, "mcp.json"), {
          schemaVersion: MODULE_SCHEMA_VERSION,
          servers: expert.mcpServers,
        }),
        writeJson(join(temporaryPath, "tools.json"), {
          schemaVersion: MODULE_SCHEMA_VERSION,
          toolIds: expert.toolIds,
          approvals: expert.toolApprovals,
        }),
        writeJson(join(temporaryPath, "plugins.json"), {
          schemaVersion: MODULE_SCHEMA_VERSION,
          plugins: expert.plugins,
        }),
        writeJson(join(temporaryPath, "context.json"), {
          schemaVersion: MODULE_SCHEMA_VERSION,
          sources: expert.contextSources,
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
      return await readDefinition(id);
    },

    async create(input: CreateExpertDefinition): Promise<ExpertDefinition> {
      const parsed = CreateExpertDefinitionSchema.parse(input);
      try {
        await readSummary(parsed.id);
        throw new ExpertDefinitionStoreError(
          "expert_exists",
          "An expert with this ID already exists.",
        );
      } catch (error) {
        if (!(error instanceof ExpertDefinitionStoreError) || error.code !== "expert_not_found")
          throw error;
      }
      const timestamp = new Date().toISOString();
      const expert = ExpertDefinitionSchema.parse({
        schemaVersion: EXPERT_SCHEMA_VERSION,
        ...parsed,
        instructions: parsed.instructions ?? undefined,
        model: parsed.model ?? null,
        skills: parsed.skills ?? [],
        mcpServers: parsed.mcpServers ?? [],
        toolIds: parsed.toolIds ?? [],
        toolApprovals: parsed.toolApprovals ?? {},
        plugins: parsed.plugins ?? [],
        contextSources: parsed.contextSources ?? [],
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await writeDefinition(expert);
      return expert;
    },

    async update(id: string, input: UpdateExpertDefinition): Promise<ExpertDefinition> {
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
      await readSummary(id);
      await rm(expertPath(id), { recursive: true, force: true });
    },
  };
}
