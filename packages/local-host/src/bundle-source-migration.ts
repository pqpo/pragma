import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  BundleSourceItemSchema,
  BundleSourceManifestSchema,
  BundleSourceSlugSchema,
  bundleSourceItemDirectory,
  type BundleSourceCategory,
  type BundleSourceKind,
} from "@pragma/shared";
import { parse, stringify } from "yaml";
import { z } from "zod";

const LEGACY_MANIFEST = "pragma-registry.yaml";
const SOURCE_MANIFEST = "pragma-source.yaml";
const JOURNAL = ".pragma-source-migration-v1.json";
const STAGING = ".pragma-source-migration-staging";
const BACKUP = ".pragma-registry-v1-backup";
const REPORT = "bundle-source-migration-report.json";

const LegacyLocalizedSchema = z
  .object({
    default: z.string().trim().min(1),
    translations: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

const LegacyManifestSchema = z
  .object({
    schemaVersion: z.literal("pragma.bundle-registry/v1"),
    id: BundleSourceSlugSchema,
    name: LegacyLocalizedSchema,
    description: LegacyLocalizedSchema.optional(),
    maxBundleBytes: z.number().int().positive(),
    categories: z.array(
      z
        .object({
          id: z.string().trim().min(1),
          name: LegacyLocalizedSchema,
          description: LegacyLocalizedSchema.optional(),
          order: z.number().int().nonnegative().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const LegacyPackageSchema = z
  .object({
    schemaVersion: z.literal("pragma.bundle-registry-package/v1"),
    id: BundleSourceSlugSchema,
    name: LegacyLocalizedSchema,
    summary: LegacyLocalizedSchema,
    publisher: z.object({ name: z.string().trim().min(1), url: z.string().url().optional() }),
    license: z.string().trim().min(1),
    homepage: z.string().url().optional(),
    primaryCategory: z.string().trim().min(1),
    tags: z.array(BundleSourceSlugSchema).default([]),
    readme: z.string().trim().min(1),
    media: z
      .object({ icon: z.string().optional(), screenshots: z.array(z.unknown()).default([]) })
      .passthrough()
      .optional(),
    channels: z.object({ stable: z.string().trim().min(1) }).passthrough(),
    versions: z.array(
      z
        .object({
          version: z.string().trim().min(1),
          releasedAt: z.string().datetime({ offset: true }),
          bundle: z
            .object({
              path: z.string().trim().min(1),
              root: z.object({
                ref: z.string().trim().min(1),
                kind: z.enum(["Expert", "ExpertTeam", "Flow"]),
              }),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const MigrationJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.bundle-source-migration-journal/v1"),
    operationId: z.string().uuid(),
    phase: z.enum(["prepared", "backed-up", "installed"]),
  })
  .strict();

export interface BundleSourceMigrationReport {
  readonly status: "migrated" | "already-current";
  readonly sourceId: string;
  readonly itemCount: number;
  readonly versionCount: number;
  readonly warnings?: readonly string[] | undefined;
  readonly backupPath?: string | undefined;
  readonly reportPath?: string | undefined;
}

export async function migrateBundleRegistryV1(
  directoryInput: string,
): Promise<BundleSourceMigrationReport> {
  const directory = resolve(directoryInput);
  const sourceExists = await exists(join(directory, SOURCE_MANIFEST));
  const legacyExists = await exists(join(directory, LEGACY_MANIFEST));
  const journalPath = join(directory, JOURNAL);
  const journal = await readOptionalJournal(journalPath);
  if (sourceExists && !legacyExists && journal === undefined) {
    const source = BundleSourceManifestSchema.parse(
      parse(await readFile(join(directory, SOURCE_MANIFEST), "utf8")),
    );
    return { status: "already-current", sourceId: source.id, itemCount: 0, versionCount: 0 };
  }
  if (!legacyExists && journal === undefined) {
    throw new Error("No pragma.bundle-registry/v1 repository was found.");
  }
  if (sourceExists && journal === undefined) {
    throw new Error(
      "Both legacy Registry and Bundle Source manifests exist; migration is ambiguous.",
    );
  }

  let active = journal;
  if (active === undefined) {
    await rm(join(directory, STAGING), { recursive: true, force: true });
    const prepared = await prepareMigration(directory);
    active = MigrationJournalSchema.parse({
      schemaVersion: "pragma.bundle-source-migration-journal/v1",
      operationId: randomUUID(),
      phase: "prepared",
    });
    await writeJsonAtomically(journalPath, active);
    await writeJsonAtomically(join(directory, STAGING, REPORT), prepared);
  }

  if (active.phase === "prepared") {
    await backupLegacyRegistry(directory);
    active = { ...active, phase: "backed-up" };
    await writeJsonAtomically(journalPath, active);
  }
  if (active.phase === "backed-up") {
    await installStagedSource(directory);
    active = { ...active, phase: "installed" };
    await writeJsonAtomically(journalPath, active);
  }

  const stagedReportPath = join(directory, REPORT);
  const report = z
    .object({
      sourceId: z.string(),
      itemCount: z.number(),
      versionCount: z.number(),
      warnings: z.array(z.string()).optional(),
    })
    .parse(JSON.parse(await readFile(stagedReportPath, "utf8")));
  await rm(join(directory, STAGING), { recursive: true, force: true });
  await rm(journalPath, { force: true });
  return {
    status: "migrated",
    ...report,
    backupPath: join(directory, BACKUP),
    reportPath: stagedReportPath,
  };
}

async function prepareMigration(directory: string): Promise<{
  readonly sourceId: string;
  readonly itemCount: number;
  readonly versionCount: number;
  readonly warnings: readonly string[];
}> {
  const legacy = LegacyManifestSchema.parse(
    parse(await readFile(join(directory, LEGACY_MANIFEST), "utf8")),
  );
  const categories = migrateCategories(legacy.categories);
  const manifest = BundleSourceManifestSchema.parse({
    schemaVersion: "pragma.bundle-source/v1",
    id: legacy.id,
    name: legacy.name,
    ...(legacy.description === undefined ? {} : { description: legacy.description }),
    maxBundleBytes: legacy.maxBundleBytes,
    sections: {
      expert: { categories },
      "expert-team": { categories },
      flow: { categories },
    },
  });
  const staging = join(directory, STAGING);
  await mkdir(staging, { recursive: true });
  await writeYamlAtomically(join(staging, SOURCE_MANIFEST), manifest);

  const packageConfigs = await findNamedFiles(join(directory, "packages"), "package.yaml");
  const ids = new Set<string>();
  let versionCount = 0;
  for (const packageConfig of packageConfigs) {
    const legacyItem = LegacyPackageSchema.parse(parse(await readFile(packageConfig, "utf8")));
    if (legacyItem.media?.icon !== undefined || (legacyItem.media?.screenshots.length ?? 0) > 0) {
      throw new Error(
        `Legacy item ${legacyItem.id} contains screenshots that cannot be mapped losslessly.`,
      );
    }
    const stable = legacyItem.versions.find(
      (version) => version.version === legacyItem.channels.stable,
    );
    if (stable === undefined) throw new Error(`Legacy stable version is missing: ${legacyItem.id}`);
    const kind = sourceKind(stable.bundle.root.kind);
    const identity = `${kind}:${legacyItem.id}`;
    if (ids.has(identity)) throw new Error(`Duplicate legacy item identity: ${identity}`);
    ids.add(identity);
    const categoryId = migrateCategoryId(legacyItem.primaryCategory);
    if (!categories.some((category) => category.id === categoryId)) {
      throw new Error(`Legacy item uses an unknown category: ${legacyItem.primaryCategory}`);
    }
    const itemDirectory = join(
      staging,
      ...bundleSourceItemDirectory({ kind, categoryId, itemId: legacyItem.id }).split("/"),
    );
    const released = legacyItem.versions.map((version) => version.releasedAt).toSorted();
    const description = await readFile(resolveRepositoryPath(directory, legacyItem.readme), "utf8");
    const item = BundleSourceItemSchema.parse({
      schemaVersion: "pragma.bundle-source-item/v1",
      id: legacyItem.id,
      rootRef: stable.bundle.root.ref,
      name: legacyItem.name,
      summary: legacyItem.summary,
      description: { default: description },
      author: legacyItem.publisher,
      license: legacyItem.license,
      ...(legacyItem.homepage === undefined ? {} : { homepage: legacyItem.homepage }),
      tags: legacyItem.tags,
      latestVersion: stable.version,
      createdAt: released[0],
      updatedAt: released.at(-1),
    });
    await writeYamlAtomically(join(itemDirectory, "config.yaml"), item);
    for (const version of legacyItem.versions) {
      const source = resolveRepositoryPath(directory, version.bundle.path);
      const destination = join(itemDirectory, "versions", version.version, "bundle.pragma");
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      versionCount += 1;
    }
  }
  return {
    sourceId: manifest.id,
    itemCount: packageConfigs.length,
    versionCount,
    warnings: ["Legacy channels were collapsed to latestVersion; every version was retained."],
  };
}

function migrateCategories(
  legacy: readonly z.infer<typeof LegacyManifestSchema>["categories"][number][],
): BundleSourceCategory[] {
  const categories = legacy.map((category, index) => ({
    id: migrateCategoryId(category.id),
    name: category.name,
    ...(category.description === undefined ? {} : { description: category.description }),
    order: category.order ?? index * 10,
  }));
  const seen = new Set<string>();
  for (const category of categories) {
    if (seen.has(category.id)) {
      throw new Error(`Legacy categories collide after flattening: ${category.id}`);
    }
    seen.add(category.id);
  }
  return categories;
}

function migrateCategoryId(id: string): string {
  return BundleSourceSlugSchema.parse(id.replaceAll("/", "-"));
}

function sourceKind(kind: "Expert" | "ExpertTeam" | "Flow"): BundleSourceKind {
  return kind === "Expert" ? "expert" : kind === "ExpertTeam" ? "expert-team" : "flow";
}

async function backupLegacyRegistry(directory: string): Promise<void> {
  const backup = join(directory, BACKUP);
  await mkdir(backup, { recursive: true });
  for (const name of [LEGACY_MANIFEST, "catalog", "objects", "packages"] as const) {
    const source = join(directory, name);
    if (!(await exists(source))) continue;
    const destination = join(backup, name);
    if (await exists(destination)) continue;
    await rename(source, destination);
  }
}

async function installStagedSource(directory: string): Promise<void> {
  const staging = join(directory, STAGING);
  for (const name of [SOURCE_MANIFEST, "experts", "expert-teams", "flows", REPORT] as const) {
    const source = join(staging, name);
    if (!(await exists(source))) continue;
    const destination = join(directory, name);
    if (await exists(destination)) continue;
    await rename(source, destination);
  }
}

async function findNamedFiles(root: string, name: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Legacy Registry symlink is not allowed: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === name) output.push(path);
    }
  };
  try {
    await visit(root);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  return output.toSorted();
}

function resolveRepositoryPath(root: string, path: string): string {
  const resolved = resolve(root, ...path.split("/"));
  const repositoryPath = relative(root, resolved).split(sep).join("/");
  if (repositoryPath.startsWith("../") || repositoryPath === "..") {
    throw new Error(`Legacy Registry path escapes the repository: ${path}`);
  }
  return resolved;
}

async function readOptionalJournal(
  path: string,
): Promise<z.infer<typeof MigrationJournalSchema> | undefined> {
  try {
    return MigrationJournalSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function writeYamlAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, stringify(value, { lineWidth: 100 }), "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
