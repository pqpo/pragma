import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

import { unzipSync } from "fflate";
import { z } from "zod";
import { SkillPackageSchema, type SkillPackage } from "@pragma/shared";
import {
  createCodeServiceMcpServer,
  createHttpServiceMcpServer,
  createMcpToolRegistryPool,
  withFileLock,
  type HttpServiceAuth,
  type McpToolRegistryPool,
} from "@pragma/core";

import {
  CapabilityDefinitionSchema,
  CapabilityIdSchema,
  CapabilityHealthSchema,
  CapabilityManifestSchema,
  CapabilitySchema,
  SkillDocumentSchema,
  CreateCapabilitySchema,
  ImportSkillCapabilitySchema,
  SkillFileContentSchema,
  SkillFileEntrySchema,
  UpdateCapabilitySchema,
  UpdateSkillCapabilitySchema,
  type Capability,
  type CapabilityDefinition,
  type CapabilityHealth,
  type CapabilityManifest,
  type CapabilityTestRequest,
  type CapabilityTestResult,
  type CreateCapability,
  type ImportSkillCapability,
  type GetSkillFile,
  type GetSkillDocument,
  type ListSkillFiles,
  type SkillDocument,
  type SkillFileContent,
  type SkillFileEntry,
  type PreviewCodeServiceRequest,
  type PreviewCodeServiceResult,
  type UpdateCapability,
  type UpdateSkillCapability,
} from "../../../shared/contracts/index.ts";
import type { CapabilityCredentialStore } from "./capability-credential-store.ts";
import { classifyMcpError, toCoreMcpServer } from "./capability-verifier.ts";
import type { CapabilityVerifier } from "./capability-verification.ts";

const MAX_SKILL_BYTES = 25 * 1024 * 1024;
const MAX_SKILL_FILES = 1000;

const LegacyCapabilityManifestV1Schema = z.object({
  schemaVersion: z.literal("pragma.capability/v1"),
  id: z.string().uuid(),
  runtimeKey: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["skill", "mcp_server", "http_service", "code_service"]),
  latestRevision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const CapabilityManifestMigrationJournalSchema = z.object({
  schemaVersion: z.literal("pragma.capability-manifest-migration/v1"),
  sourceSchema: z.literal("pragma.capability/v1"),
  targetSchema: z.literal("pragma.capability/v2"),
  targetManifest: CapabilityManifestSchema,
});

export interface CapabilityStore {
  list(): Promise<Capability[]>;
  get(id: string, revision?: number): Promise<Capability>;
  getSkillDocument(input: GetSkillDocument): Promise<SkillDocument>;
  listSkillFiles(input: ListSkillFiles): Promise<SkillFileEntry[]>;
  getSkillFile(input: GetSkillFile): Promise<SkillFileContent>;
  skillFilesPath(id: string, revision: number): Promise<string>;
  importSkill(input: ImportSkillCapability): Promise<Capability>;
  updateSkill(input: UpdateSkillCapability): Promise<Capability>;
  createGeneratedSkill(input: { readonly package: SkillPackage; readonly id?: string }): Promise<Capability>;
  updateGeneratedSkill(input: { readonly id: string; readonly package: SkillPackage }): Promise<Capability>;
  create(input: CreateCapability): Promise<Capability>;
  update(input: UpdateCapability): Promise<Capability>;
  retry(id: string): Promise<Capability>;
  test(input: CapabilityTestRequest): Promise<CapabilityTestResult>;
  previewCode(input: PreviewCodeServiceRequest): Promise<PreviewCodeServiceResult>;
  remove(id: string): Promise<void>;
  setRevisionPublisher(publisher: CapabilityRevisionPublisher): void;
  discardUnpublishedRevision(
    id: string,
    revision: number,
    previousHealth: CapabilityHealth,
  ): Promise<boolean>;
}

export interface CapabilityRevisionPublishInput {
  readonly current: Capability;
  readonly candidate: Capability;
  readonly commit: () => Promise<Capability>;
}

export interface CapabilityRevisionPublisher {
  publish(input: CapabilityRevisionPublishInput): Promise<Capability>;
}

export class CapabilityStoreError extends Error {
  constructor(
    readonly code:
      | "capability_not_found"
      | "config_invalid"
      | "import_invalid"
      | "capability_referenced"
      | "capability_incompatible",
    message: string,
  ) {
    super(message);
    this.name = "CapabilityStoreError";
  }
}

export function createCapabilityStore(options: {
  readonly capabilitiesPath: string;
  readonly credentials: CapabilityCredentialStore;
  readonly mcpToolRegistryPool?: McpToolRegistryPool | undefined;
  readonly verify: CapabilityVerifier;
  readonly isReferenced: (capabilityId: string) => Promise<boolean>;
  readonly onRemoved?: ((capabilityId: string) => Promise<void>) | undefined;
}): CapabilityStore {
  let revisionPublisher: CapabilityRevisionPublisher | undefined;
  const capabilityPath = (id: string) => join(options.capabilitiesPath, id);
  const manifestPath = (id: string) => join(capabilityPath(id), "capability.json");
  const healthPath = (id: string) => join(capabilityPath(id), "health.json");
  const migrationJournalPath = (id: string) => join(capabilityPath(id), "v1-to-v2.json");
  const revisionPath = (id: string, revision: number) =>
    join(capabilityPath(id), "revisions", revisionDirectory(revision));

  const migrateManifest = async (id: string): Promise<CapabilityManifest> =>
    await withFileLock(join(capabilityPath(id), ".v2-migration.lock"), async () => {
      const raw = JSON.parse(await readFile(manifestPath(id), "utf8")) as unknown;
      const current = CapabilityManifestSchema.safeParse(raw);
      if (current.success) return current.data;
      const legacy = LegacyCapabilityManifestV1Schema.safeParse(raw);
      if (!legacy.success || legacy.data.id !== id) {
        throw new CapabilityStoreError(
          "config_invalid",
          `Capability ${id} has an invalid manifest.`,
        );
      }

      const pending = await readCapabilityMigrationJournal(migrationJournalPath(id));
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

      for (let revision = 1; revision <= legacy.data.latestRevision; revision += 1) {
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

      const targetManifest = CapabilityManifestSchema.parse({
        ...legacy.data,
        schemaVersion: "pragma.capability/v2",
      });
      const backupPath = join(capabilityPath(id), "migration-backups", "capability.v1.json");
      const journal = CapabilityManifestMigrationJournalSchema.parse({
        schemaVersion: "pragma.capability-manifest-migration/v1",
        sourceSchema: "pragma.capability/v1",
        targetSchema: "pragma.capability/v2",
        targetManifest,
      });
      await writeJson(backupPath, legacy.data);
      await writeJson(migrationJournalPath(id), journal);
      await writeJson(manifestPath(id), targetManifest);
      await rm(migrationJournalPath(id), { force: true });
      return targetManifest;
    });

  const readManifest = async (id: string): Promise<CapabilityManifest> => {
    try {
      const raw = JSON.parse(await readFile(manifestPath(id), "utf8")) as unknown;
      const current = CapabilityManifestSchema.safeParse(raw);
      if (current.success) {
        await rm(migrationJournalPath(id), { force: true });
        return current.data;
      }
      if (LegacyCapabilityManifestV1Schema.safeParse(raw).success) return await migrateManifest(id);
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

  const writeNewRevision = async (
    manifest: CapabilityManifest,
    definition: CapabilityDefinition,
    health: Omit<CapabilityHealth, "revision">,
  ): Promise<Capability> => {
    const revision = manifest.latestRevision;
    const revisionsPath = join(capabilityPath(manifest.id), "revisions");
    const temporaryPath = join(
      revisionsPath,
      `.${revisionDirectory(revision)}.${randomUUID()}.tmp`,
    );
    await mkdir(temporaryPath, { recursive: true, mode: 0o700 });
    try {
      await writeJson(join(temporaryPath, "definition.json"), definition);
      await mkdir(revisionsPath, { recursive: true, mode: 0o700 });
      await rename(temporaryPath, revisionPath(manifest.id, revision));
      await writeJson(healthPath(manifest.id), { ...health, revision });
      await writeJson(manifestPath(manifest.id), manifest);
    } catch (error) {
      await rm(temporaryPath, { recursive: true, force: true });
      throw error;
    }
    return await readCapability(manifest.id);
  };

  const publishRevision = async (input: CapabilityRevisionPublishInput): Promise<Capability> =>
    revisionPublisher === undefined ? await input.commit() : await revisionPublisher.publish(input);

  return {
    async list() {
      try {
        const entries = await readdir(options.capabilitiesPath, { withFileTypes: true });
        const capabilities = await Promise.all(
          entries
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
            .map(async (entry) => {
              try {
                return await readCapability(entry.name);
              } catch (error) {
                if (error instanceof CapabilityStoreError && error.code === "config_invalid") {
                  return undefined;
                }
                throw error;
              }
            }),
        );
        return capabilities
          .filter((capability): capability is Capability => capability !== undefined)
          .toSorted((left, right) =>
            right.manifest.updatedAt.localeCompare(left.manifest.updatedAt),
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    get: readCapability,
    async getSkillDocument(input) {
      const capability = await readCapability(input.id, input.revision);
      if (capability.definition.kind !== "skill") {
        throw new CapabilityStoreError(
          "config_invalid",
          "Only Skill capabilities expose a SKILL.md document.",
        );
      }
      try {
        const revision = capability.manifest.latestRevision;
        return SkillDocumentSchema.parse({
          capabilityId: capability.manifest.id,
          revision,
          entryPath: capability.definition.entryPath,
          content: await readFile(
            join(revisionPath(capability.manifest.id, revision), "payload", "SKILL.md"),
            "utf8",
          ),
        });
      } catch (error) {
        if (error instanceof CapabilityStoreError) throw error;
        throw new CapabilityStoreError(
          "config_invalid",
          `Skill ${capability.manifest.name} has an unreadable SKILL.md document.`,
        );
      }
    },

    async listSkillFiles(input) {
      const capability = await readCapability(input.id, input.revision);
      if (capability.definition.kind !== "skill") {
        throw new CapabilityStoreError(
          "config_invalid",
          "Only Skill capabilities expose package files.",
        );
      }
      try {
        const revision = capability.manifest.latestRevision;
        const payloadPath = join(revisionPath(capability.manifest.id, revision), "payload");
        return SkillFileEntrySchema.array().parse(await listSkillFileEntries(payloadPath));
      } catch (error) {
        if (error instanceof CapabilityStoreError) throw error;
        throw new CapabilityStoreError(
          "config_invalid",
          `Skill ${capability.manifest.name} has unreadable package files.`,
        );
      }
    },

    async getSkillFile(input) {
      const capability = await readCapability(input.id, input.revision);
      if (capability.definition.kind !== "skill") {
        throw new CapabilityStoreError(
          "config_invalid",
          "Only Skill capabilities expose package files.",
        );
      }
      const revision = capability.manifest.latestRevision;
      const payloadPath = join(revisionPath(capability.manifest.id, revision), "payload");
      const filePath = resolve(payloadPath, ...input.path.split("/"));
      if (!isPathInside(payloadPath, filePath)) {
        throw new CapabilityStoreError("config_invalid", "The Skill file path is invalid.");
      }
      try {
        const info = await lstat(filePath);
        if (!info.isFile()) {
          throw new CapabilityStoreError("config_invalid", "The Skill file is not readable.");
        }
        const bytes = await readFile(filePath);
        return SkillFileContentSchema.parse({
          capabilityId: capability.manifest.id,
          revision,
          path: input.path,
          size: info.size,
          content: decodeTextFile(bytes),
        });
      } catch (error) {
        if (error instanceof CapabilityStoreError) throw error;
        throw new CapabilityStoreError(
          "config_invalid",
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "The Skill file no longer exists."
            : "The Skill file is not readable.",
        );
      }
    },

    async skillFilesPath(id, revision) {
      const capability = await readCapability(id, revision);
      if (capability.definition.kind !== "skill") {
        throw new CapabilityStoreError(
          "config_invalid",
          "Only Skill capabilities have a portable file payload.",
        );
      }
      return join(revisionPath(id, revision), "payload");
    },
    async importSkill(rawInput) {
      const input = ImportSkillCapabilitySchema.parse(rawInput);
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      const targetPath = capabilityPath(id);
      const temporaryPath = join(options.capabilitiesPath, `.${id}.${randomUUID()}.tmp`);
      const payloadPath = join(temporaryPath, "revisions", "000001", "payload");
      await mkdir(payloadPath, { recursive: true, mode: 0o700 });
      try {
        await importSkillPayload(input.sourcePath, payloadPath);
        const skillFile = await readFile(join(payloadPath, "SKILL.md"), "utf8");
        const metadata = readSkillMetadata(skillFile);
        const name = input.name ?? metadata.name;
        const description = input.description ?? metadata.description;
        if (!name || !description) {
          throw new CapabilityStoreError(
            "import_invalid",
            "SKILL.md must define name and description, or they must be supplied during import.",
          );
        }
        const definition = CapabilityDefinitionSchema.parse({
          kind: "skill",
          name,
          description,
          entryPath: "SKILL.md",
          contentHash: await hashDirectory(payloadPath),
        });
        const manifest = CapabilityManifestSchema.parse({
          schemaVersion: "pragma.capability/v2",
          id,
          runtimeKey: createRuntimeKey(name, id),
          name,
          kind: "skill",
          latestRevision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await writeJson(join(temporaryPath, "revisions", "000001", "definition.json"), definition);
        await writeJson(join(temporaryPath, "capability.json"), manifest);
        await writeJson(join(temporaryPath, "health.json"), {
          revision: 1,
          status: "ready",
          checkedAt: timestamp,
        });
        await mkdir(options.capabilitiesPath, { recursive: true, mode: 0o700 });
        await rename(temporaryPath, targetPath);
        return await readCapability(id);
      } catch (error) {
        await rm(temporaryPath, { recursive: true, force: true });
        throw error;
      }
    },
    async createGeneratedSkill(rawInput) {
      const input = SkillPackageSchema.parse(rawInput.package);
      const id = rawInput.id === undefined ? randomUUID() : CapabilityIdSchema.parse(rawInput.id);
      const timestamp = new Date().toISOString();
      const targetPath = capabilityPath(id);
      const temporaryPath = join(options.capabilitiesPath, `.${id}.${randomUUID()}.tmp`);
      const payloadPath = join(temporaryPath, "revisions", "000001", "payload");
      await mkdir(payloadPath, { recursive: true, mode: 0o700 });
      try {
        await writeGeneratedSkillPayload(input, payloadPath);
        const definition = CapabilityDefinitionSchema.parse({
          kind: "skill",
          name: input.name,
          description: input.description,
          entryPath: "SKILL.md",
          contentHash: await hashDirectory(payloadPath),
        });
        const manifest = CapabilityManifestSchema.parse({
          schemaVersion: "pragma.capability/v2",
          id,
          runtimeKey: createRuntimeKey(input.name, id),
          name: input.name,
          kind: "skill",
          latestRevision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await writeJson(join(temporaryPath, "revisions", "000001", "definition.json"), definition);
        await writeJson(join(temporaryPath, "capability.json"), manifest);
        await writeJson(join(temporaryPath, "health.json"), {
          revision: 1,
          status: "ready",
          checkedAt: timestamp,
        });
        await mkdir(options.capabilitiesPath, { recursive: true, mode: 0o700 });
        await rename(temporaryPath, targetPath);
        return await readCapability(id);
      } catch (error) {
        await rm(temporaryPath, { recursive: true, force: true });
        throw error;
      }
    },
    async updateSkill(rawInput) {
      const input = UpdateSkillCapabilitySchema.parse(rawInput);
      const current = await readCapability(input.id);
      if (current.definition.kind !== "skill") {
        throw new CapabilityStoreError(
          "config_invalid",
          "Only Skill capabilities can be updated here.",
        );
      }
      const revision = current.manifest.latestRevision + 1;
      const revisionsPath = join(capabilityPath(input.id), "revisions");
      const temporaryPath = join(
        revisionsPath,
        `.${revisionDirectory(revision)}.${randomUUID()}.tmp`,
      );
      const payloadPath = join(temporaryPath, "payload");
      await mkdir(payloadPath, { recursive: true, mode: 0o700 });
      try {
        await importSkillPayload(input.sourcePath, payloadPath);
        await readFile(join(payloadPath, "SKILL.md"), "utf8");
        const definition = CapabilityDefinitionSchema.parse({
          ...current.definition,
          contentHash: await hashDirectory(payloadPath),
        });
        const timestamp = new Date().toISOString();
        const manifest = CapabilityManifestSchema.parse({
          ...current.manifest,
          latestRevision: revision,
          updatedAt: timestamp,
        });
        const health = CapabilityHealthSchema.parse({
          revision,
          status: "ready",
          checkedAt: timestamp,
        });
        const candidate = CapabilitySchema.parse({ manifest, definition, health });
        await writeJson(join(temporaryPath, "definition.json"), definition);
        return await publishRevision({
          current,
          candidate,
          commit: async () => {
            await rename(temporaryPath, revisionPath(input.id, revision));
            await writeJson(healthPath(input.id), health);
            await writeJson(manifestPath(input.id), manifest);
            return await readCapability(input.id);
          },
        });
      } catch (error) {
        await rm(temporaryPath, { recursive: true, force: true });
        throw error;
      }
    },
    async updateGeneratedSkill(rawInput) {
      const input = { id: CapabilityIdSchema.parse(rawInput.id), package: SkillPackageSchema.parse(rawInput.package) };
      const current = await readCapability(input.id);
      if (current.definition.kind !== "skill") {
        throw new CapabilityStoreError("config_invalid", "Only Skill capabilities can be updated here.");
      }
      const revision = current.manifest.latestRevision + 1;
      const revisionsPath = join(capabilityPath(input.id), "revisions");
      const temporaryPath = join(revisionsPath, `.${revisionDirectory(revision)}.${randomUUID()}.tmp`);
      const payloadPath = join(temporaryPath, "payload");
      await mkdir(payloadPath, { recursive: true, mode: 0o700 });
      try {
        await writeGeneratedSkillPayload(input.package, payloadPath);
        const definition = CapabilityDefinitionSchema.parse({
          ...current.definition,
          name: input.package.name,
          description: input.package.description,
          contentHash: await hashDirectory(payloadPath),
        });
        const timestamp = new Date().toISOString();
        const manifest = CapabilityManifestSchema.parse({
          ...current.manifest,
          name: input.package.name,
          latestRevision: revision,
          updatedAt: timestamp,
        });
        const health = CapabilityHealthSchema.parse({ revision, status: "ready", checkedAt: timestamp });
        const candidate = CapabilitySchema.parse({ manifest, definition, health });
        await writeJson(join(temporaryPath, "definition.json"), definition);
        return await publishRevision({
          current,
          candidate,
          commit: async () => {
            await rename(temporaryPath, revisionPath(input.id, revision));
            await writeJson(healthPath(input.id), health);
            await writeJson(manifestPath(input.id), manifest);
            return await readCapability(input.id);
          },
        });
      } catch (error) {
        await rm(temporaryPath, { recursive: true, force: true });
        throw error;
      }
    },
    async create(rawInput) {
      const input = CreateCapabilitySchema.parse(rawInput);
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      await options.credentials.setMany(id, input.credentials);
      const verified = await options.verify(validateDefinition(input.definition), id);
      assertCodeServiceReady(input.definition, verified.health);
      const manifest = CapabilityManifestSchema.parse({
        schemaVersion: "pragma.capability/v2",
        id,
        runtimeKey: createRuntimeKey(input.definition.name, id),
        name: input.definition.name,
        kind: input.definition.kind,
        latestRevision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await mkdir(join(capabilityPath(id), "revisions"), { recursive: true, mode: 0o700 });
      return await writeNewRevision(manifest, verified.definition, verified.health);
    },
    async update(rawInput) {
      const input = UpdateCapabilitySchema.parse(rawInput);
      const current = await readManifest(input.id);
      if (current.kind !== input.definition.kind) {
        throw new CapabilityStoreError("config_invalid", "Capability kind cannot be changed.");
      }
      await options.credentials.setMany(input.id, input.credentials);
      const verified = await options.verify(validateDefinition(input.definition), input.id);
      assertCodeServiceReady(input.definition, verified.health);
      const timestamp = new Date().toISOString();
      const manifest = CapabilityManifestSchema.parse({
        ...current,
        name: input.definition.name,
        latestRevision: current.latestRevision + 1,
        updatedAt: timestamp,
      });
      const existing = await readCapability(input.id);
      const candidate = CapabilitySchema.parse({
        manifest,
        definition: verified.definition,
        health: { ...verified.health, revision: manifest.latestRevision },
      });
      return await publishRevision({
        current: existing,
        candidate,
        commit: async () => await writeNewRevision(manifest, verified.definition, verified.health),
      });
    },
    async retry(id) {
      const current = await readCapability(id);
      if (current.definition.kind === "skill") return current;
      const verified = await options.verify(current.definition, id);
      if (JSON.stringify(verified.definition) !== JSON.stringify(current.definition)) {
        if (verified.definition.kind === "skill") return current;
        const manifest = CapabilityManifestSchema.parse({
          ...current.manifest,
          name: verified.definition.name,
          latestRevision: current.manifest.latestRevision + 1,
          updatedAt: new Date().toISOString(),
        });
        const candidate = CapabilitySchema.parse({
          manifest,
          definition: verified.definition,
          health: { ...verified.health, revision: manifest.latestRevision },
        });
        return await publishRevision({
          current,
          candidate,
          commit: async () =>
            await writeNewRevision(manifest, verified.definition, verified.health),
        });
      }
      const health = CapabilityHealthSchema.parse({
        ...verified.health,
        revision: current.manifest.latestRevision,
      });
      const commit = async (): Promise<Capability> => {
        await writeJson(healthPath(id), health);
        return await readCapability(id);
      };
      if (health.status !== "ready" || current.health.status === "ready") return await commit();
      return await publishRevision({
        current,
        candidate: CapabilitySchema.parse({ ...current, definition: verified.definition, health }),
        commit,
      });
    },
    async test(input) {
      const current = await readCapability(input.id);
      if (current.definition.kind === "skill") {
        return {
          ok: true,
          code: "ready",
          message: "The Skill package is valid.",
          capability: current,
        };
      }
      if (current.definition.kind === "mcp_server") {
        if (input.toolName === undefined) {
          throw new CapabilityStoreError("config_invalid", "Choose an MCP tool to test.");
        }
        if (!current.definition.tools.some((tool) => tool.name === input.toolName)) {
          throw new CapabilityStoreError(
            "config_invalid",
            `MCP tool ${input.toolName} does not exist in the current capability revision.`,
          );
        }

        try {
          const server = await toCoreMcpServer(
            current.definition,
            current.manifest.id,
            options.credentials,
            [input.toolName],
          );
          const ownsPool = options.mcpToolRegistryPool === undefined;
          const pool =
            options.mcpToolRegistryPool ??
            createMcpToolRegistryPool({
              idleTtlMs: 0,
              maxIdleEntries: 0,
            });
          try {
            const lease = await pool.acquire({ mcpServers: { capability: server } });
            try {
              const tool = lease.registry.tools.find(
                (candidate) => candidate.name === input.toolName,
              );
              if (tool === undefined) {
                throw new Error(`MCP tool ${input.toolName} is not currently available.`);
              }
              const result = await tool.call(input.input ?? {}, undefined);
              const failure = readToolFailure(result, "The MCP tool test failed.");
              const health = CapabilityHealthSchema.parse({
                revision: current.manifest.latestRevision,
                status: failure === undefined ? "ready" : "needs_attention",
                checkedAt: new Date().toISOString(),
                ...(failure === undefined
                  ? {}
                  : {
                      diagnostic: {
                        code: failure.code,
                        message: failure.message,
                        retryable: true,
                      },
                    }),
              });
              await writeJson(healthPath(input.id), health);
              const output = readToolOutput(result);
              return {
                ok: failure === undefined,
                code: failure?.code ?? "success",
                message: failure?.message ?? "The MCP tool test succeeded.",
                capability: await readCapability(input.id),
                ...(output === undefined ? {} : { output }),
              };
            } finally {
              await lease.release();
            }
          } finally {
            if (ownsPool) await pool.close();
          }
        } catch (error) {
          const diagnostic = classifyMcpError(error);
          await writeJson(healthPath(input.id), {
            revision: current.manifest.latestRevision,
            status: "needs_attention",
            checkedAt: new Date().toISOString(),
            diagnostic,
          });
          return {
            ok: false,
            code: diagnostic.code,
            message: diagnostic.message,
            capability: await readCapability(input.id),
          };
        }
      }
      if (current.definition.kind === "code_service") {
        const server = createCodeServiceMcpServer(toCoreCodeService(current.definition));
        const result = await server.callTool(current.definition.tool.name, input.input ?? {});
        const failure = readToolFailure(result, "The code tool test failed.");
        if (failure?.code === "invalid_input") {
          return {
            ok: false,
            code: failure.code,
            message: failure.message,
            capability: current,
          };
        }
        const health = CapabilityHealthSchema.parse({
          revision: current.manifest.latestRevision,
          status: failure === undefined ? "ready" : "needs_attention",
          checkedAt: new Date().toISOString(),
          ...(failure === undefined
            ? {}
            : {
                diagnostic: {
                  code: failure.code,
                  message: failure.message,
                  retryable: true,
                },
              }),
        });
        await writeJson(healthPath(input.id), health);
        return {
          ok: failure === undefined,
          code: failure?.code ?? "success",
          message: failure?.message ?? "The code tool test succeeded.",
          capability: await readCapability(input.id),
          ...(readStructuredOutput(result) === undefined
            ? {}
            : { output: readStructuredOutput(result) }),
        };
      }
      if (input.toolName === undefined) {
        throw new CapabilityStoreError("config_invalid", "Choose an HTTP tool to test.");
      }
      const tool = current.definition.tools.find((candidate) => candidate.name === input.toolName);
      if (tool === undefined) {
        throw new CapabilityStoreError(
          "config_invalid",
          `HTTP tool ${input.toolName} does not exist.`,
        );
      }
      try {
        const auth = await resolveHttpAuth(
          current.definition,
          current.manifest.id,
          options.credentials,
        );
        const server = createHttpServiceMcpServer({
          name: current.definition.name,
          baseUrl: current.definition.baseUrl,
          auth,
          timeoutMs: current.definition.timeoutMs,
          tools: [tool],
        });
        const result = await server.callTool(tool.name, input.input ?? {});
        const isError = isRecord(result) && result["isError"] === true;
        const details =
          isRecord(result) && isRecord(result["details"]) ? result["details"] : undefined;
        const message =
          readMcpResultText(result) ??
          (isError ? "The HTTP tool test failed." : "The HTTP tool test succeeded.");
        const health = CapabilityHealthSchema.parse({
          revision: current.manifest.latestRevision,
          status: isError ? "needs_attention" : "ready",
          checkedAt: new Date().toISOString(),
          ...(isError
            ? {
                diagnostic: {
                  code: typeof details?.["code"] === "string" ? details["code"] : "request_failed",
                  message,
                  retryable: true,
                },
              }
            : {}),
        });
        await writeJson(healthPath(input.id), health);
        const capability = await readCapability(input.id);
        const output = readToolOutput(result);
        return {
          ok: !isError,
          code: health.diagnostic?.code ?? "success",
          message: isError ? message : "The HTTP tool test succeeded.",
          capability,
          ...(output === undefined ? {} : { output }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "The HTTP tool test failed.";
        const health = CapabilityHealthSchema.parse({
          revision: current.manifest.latestRevision,
          status: "needs_attention",
          checkedAt: new Date().toISOString(),
          diagnostic: { code: "request_failed", message, retryable: true },
        });
        await writeJson(healthPath(input.id), health);
        return {
          ok: false,
          code: "request_failed",
          message,
          capability: await readCapability(input.id),
        };
      }
    },
    async previewCode(input) {
      const server = createCodeServiceMcpServer(toCoreCodeService(input.definition));
      const result = await server.callTool(input.definition.tool.name, input.input);
      const failure = readToolFailure(result, "The code tool test failed.");
      return {
        ok: failure === undefined,
        code: failure?.code ?? "success",
        message: failure?.message ?? "The code tool test succeeded.",
        ...(readStructuredOutput(result) === undefined
          ? {}
          : { output: readStructuredOutput(result) }),
      };
    },
    async remove(id) {
      await readManifest(id);
      if (await options.isReferenced(id)) {
        throw new CapabilityStoreError(
          "capability_referenced",
          "This capability is used by one or more Experts. Remove it from those Experts before deleting it.",
        );
      }
      await rm(capabilityPath(id), { recursive: true, force: true });
      await options.credentials.removeCapability(id);
      await options.onRemoved?.(id);
    },
    setRevisionPublisher(publisher) {
      revisionPublisher = publisher;
    },
    async discardUnpublishedRevision(id, revision, previousHealth) {
      const manifest = await readManifest(id);
      if (manifest.latestRevision >= revision) return false;
      await rm(revisionPath(id, revision), { recursive: true, force: true });
      await writeJson(
        healthPath(id),
        CapabilityHealthSchema.parse({
          ...previousHealth,
          revision: manifest.latestRevision,
        }),
      );
      return true;
    },
  };
}

function assertCodeServiceReady(
  definition: CapabilityDefinition,
  health: Omit<CapabilityHealth, "revision">,
): void {
  if (definition.kind !== "code_service" || health.status === "ready") return;
  throw new CapabilityStoreError(
    "config_invalid",
    health.diagnostic?.message ?? "The code service could not be compiled.",
  );
}

function toCoreCodeService(
  definition: Extract<CapabilityDefinition, { readonly kind: "code_service" }>,
) {
  return {
    name: definition.name,
    timeoutMs: definition.timeoutMs,
    tool: definition.tool,
  };
}

function revisionDirectory(revision: number): string {
  return revision.toString().padStart(6, "0");
}

function firstZodIssue(error: unknown): string {
  if (!(error instanceof z.ZodError)) return "definition";
  const issue = error.issues[0];
  return issue === undefined ? "definition" : issue.path.join(".") || "definition";
}

async function readCapabilityMigrationJournal(
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

function validateDefinition(definition: CapabilityDefinition): CapabilityDefinition {
  if (definition.kind !== "http_service") return definition;
  const url = new URL(definition.baseUrl);
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new CapabilityStoreError(
      "config_invalid",
      "HTTP service base URLs must use HTTPS, except for a local loopback server.",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CapabilityStoreError(
      "config_invalid",
      "HTTP service base URLs cannot contain credentials, queries, or fragments.",
    );
  }
  return definition;
}

async function importSkillPayload(sourcePath: string, targetPath: string): Promise<void> {
  if (extname(sourcePath).toLowerCase() === ".zip") {
    const archive = unzipSync(new Uint8Array(await readFile(sourcePath)));
    const files = Object.entries(archive)
      .filter(([name]) => !name.endsWith("/"))
      .map(([name, content]) => ({ path: validateArchivePath(name), content }));
    if (files.length > MAX_SKILL_FILES) throw importLimitError();
    let bytes = 0;
    for (const { content } of files) {
      bytes += content.byteLength;
      if (bytes > MAX_SKILL_BYTES) throw importLimitError();
    }

    const packageFiles = files.filter(({ path }) => !isMacOsArchiveMetadata(path));
    const packageRoot = skillArchiveRoot(packageFiles.map(({ path }) => path));
    const writtenPaths = new Set<string>();
    for (const { path, content } of packageFiles) {
      const relativePath = packageRoot.length === 0 ? path : path.slice(packageRoot.length + 1);
      if (writtenPaths.has(relativePath)) {
        throw new CapabilityStoreError(
          "import_invalid",
          "The Skill ZIP contains duplicate file paths.",
        );
      }
      writtenPaths.add(relativePath);
      const target = join(targetPath, ...relativePath.split("/"));
      await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { mode: 0o600 });
    }
    return;
  }

  const sourceInfo = await lstat(sourcePath);
  if (!sourceInfo.isDirectory()) {
    throw new CapabilityStoreError("import_invalid", "Select a Skill directory or ZIP archive.");
  }
  await copySkillDirectory(sourcePath, targetPath, { files: 0, bytes: 0 });
}

async function writeGeneratedSkillPayload(input: SkillPackage, targetPath: string): Promise<void> {
  const parsed = SkillPackageSchema.parse(input);
  for (const file of parsed.files) {
    const target = resolve(targetPath, ...file.path.split("/"));
    if (!isPathInside(targetPath, target)) {
      throw new CapabilityStoreError("import_invalid", "The generated Skill contains an unsafe path.");
    }
    await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
    await writeFile(target, file.content, { mode: 0o600 });
  }
}

async function copySkillDirectory(
  sourcePath: string,
  targetPath: string,
  state: { files: number; bytes: number },
): Promise<void> {
  for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
    const source = join(sourcePath, entry.name);
    const target = join(targetPath, entry.name);
    const info = await lstat(source);
    if (info.isSymbolicLink()) {
      throw new CapabilityStoreError(
        "import_invalid",
        "Skill packages cannot contain symbolic links.",
      );
    }
    if (info.isDirectory()) {
      await mkdir(target, { recursive: true, mode: 0o700 });
      await copySkillDirectory(source, target, state);
      continue;
    }
    if (!info.isFile()) continue;
    state.files += 1;
    state.bytes += info.size;
    if (state.files > MAX_SKILL_FILES || state.bytes > MAX_SKILL_BYTES) throw importLimitError();
    await writeFile(target, await readFile(source), { mode: 0o600 });
  }
}

function validateArchivePath(name: string): string {
  const normalized = name.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.includes("\0") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new CapabilityStoreError("import_invalid", "The Skill ZIP contains an unsafe path.");
  }
  return normalized;
}

function isMacOsArchiveMetadata(path: string): boolean {
  return path === ".DS_Store" || path.startsWith("__MACOSX/") || path.endsWith("/.DS_Store");
}

function skillArchiveRoot(paths: readonly string[]): string {
  if (paths.includes("SKILL.md")) return "";
  const candidates = paths
    .filter((path) => path.endsWith("/SKILL.md"))
    .map((path) => path.slice(0, -"/SKILL.md".length));
  const packageRoots = candidates.filter((root) =>
    paths.every((path) => path.startsWith(`${root}/`)),
  );
  if (packageRoots.length !== 1) {
    throw new CapabilityStoreError(
      "import_invalid",
      candidates.length === 0
        ? "The Skill ZIP must contain a SKILL.md file."
        : "The Skill ZIP must contain one Skill directory with a root SKILL.md file.",
    );
  }
  return packageRoots[0]!;
}

function importLimitError(): CapabilityStoreError {
  return new CapabilityStoreError(
    "import_invalid",
    "Skill packages are limited to 25 MiB and 1000 files.",
  );
}

function readSkillMetadata(content: string): {
  readonly name?: string;
  readonly description?: string;
} {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return {};
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return {};
  const values = Object.fromEntries(
    normalized
      .slice(4, end)
      .split("\n")
      .map((line) => {
        const index = line.indexOf(":");
        return index < 0
          ? [line, ""]
          : [line.slice(0, index).trim(), unquote(line.slice(index + 1).trim())];
      }),
  );
  return {
    ...(values["name"] ? { name: values["name"] } : {}),
    ...(values["description"] ? { description: values["description"] } : {}),
  };
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

async function hashDirectory(path: string): Promise<string> {
  const hash = createHash("sha256");
  const files = await listFiles(path);
  for (const file of files.toSorted()) {
    hash.update(relative(path, file).split(sep).join("/"));
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}

async function listFiles(path: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const target = join(path, entry.name);
    if (entry.isDirectory()) output.push(...(await listFiles(target)));
    else if (entry.isFile()) output.push(target);
  }
  return output;
}

async function listSkillFileEntries(path: string): Promise<SkillFileEntry[]> {
  const output: SkillFileEntry[] = [];
  for (const file of await listFiles(path)) {
    const info = await lstat(file);
    output.push({
      path: relative(path, file).split(sep).join("/"),
      size: info.size,
    });
  }
  return output.toSorted((left, right) => left.path.localeCompare(right.path));
}

function decodeTextFile(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function isPathInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(resolve(parent), candidate);
  return (
    pathFromParent.length > 0 && !pathFromParent.startsWith(`..${sep}`) && pathFromParent !== ".."
  );
}

function createRuntimeKey(name: string, id: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return `${slug || "capability"}_${id.replaceAll("-", "").slice(0, 8)}`;
}

async function resolveHttpAuth(
  definition: Extract<CapabilityDefinition, { readonly kind: "http_service" }>,
  capabilityId: string,
  credentials: CapabilityCredentialStore,
): Promise<HttpServiceAuth> {
  if (definition.auth.type === "none") return { type: "none" };
  const value = await credentials.get(capabilityId, definition.auth.credentialRef);
  if (value === undefined) {
    throw new CapabilityStoreError(
      "config_invalid",
      `Credential ${definition.auth.credentialRef} is not configured.`,
    );
  }
  return definition.auth.type === "bearer"
    ? { type: "bearer", token: value }
    : { type: "api_key_header", headerName: definition.auth.headerName, value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMcpResultText(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value["content"])) return undefined;
  return (
    value["content"]
      .map((item) =>
        isRecord(item) && typeof item["text"] === "string" ? item["text"] : undefined,
      )
      .filter((item): item is string => item !== undefined)
      .join("\n") || undefined
  );
}

function readToolFailure(
  value: unknown,
  fallbackMessage: string,
): { readonly code: string; readonly message: string } | undefined {
  if (!isRecord(value) || value["isError"] !== true) return undefined;
  const details = isRecord(value["details"]) ? value["details"] : undefined;
  return {
    code: typeof details?.["code"] === "string" ? details["code"] : "runtime_error",
    message: readMcpResultText(value) ?? fallbackMessage,
  };
}

function readToolOutput(value: unknown): unknown | undefined {
  if (!isRecord(value)) return value;
  if (value["structuredContent"] !== undefined) return value["structuredContent"];
  if (!Array.isArray(value["content"])) return value;
  const text = readMcpResultText(value);
  if (
    text !== undefined &&
    value["content"].every((item) => isRecord(item) && item["type"] === "text")
  ) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return value["content"];
}

function readStructuredOutput(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return isRecord(value["structuredContent"]) ? value["structuredContent"] : undefined;
}
