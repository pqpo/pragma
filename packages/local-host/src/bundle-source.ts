import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { decodePragmaBundle, loadPragmaProject } from "@pragma/interpreter";
import { canonicalPragmaResourceRef, type PragmaResource } from "@pragma/interpreter/ast";
import {
  BUNDLE_SOURCE_KIND_DIRECTORIES,
  BundleSourceItemSchema,
  BundleSourceManifestSchema,
  BundleSourceV1ManifestSchema,
  BundleSourceSemverSchema,
  BundleSourceSlugSchema,
  bundleSourceItemDirectory,
  bundleSourceRootPrefix,
  parseBundleSourceItem,
  parseBundleSourceManifest,
  parseBundleSourceRepositoryEntry,
  type BundleSourceItem,
  type BundleSourceKind,
  type BundleSourceManifest,
} from "@pragma/shared";
import { parse, stringify } from "yaml";

const execFileAsync = promisify(execFile);
const SOURCE_MANIFEST = "pragma-source.yaml";
const ITEM_CONFIG = "config.yaml";

const DEFAULT_CATEGORIES = [
  ["general", "General", "通用", "一般"],
  ["software-development", "Software Development", "软件开发", "軟體開發"],
  ["research", "Research", "研究", "研究"],
  ["product-design", "Product Design", "产品设计", "產品設計"],
  ["content-creation", "Content Creation", "内容创作", "內容創作"],
  ["productivity", "Productivity", "效率工具", "生產力"],
  ["education", "Education", "教育学习", "教育學習"],
] as const;

export interface BundleSourceInitializationResult {
  readonly sourceId: string;
  readonly manifestPath: string;
  readonly directories: readonly string[];
}

export interface BundleSourceUpgradeResult {
  readonly directory: string;
  readonly upgraded: boolean;
  readonly itemCount: number;
  readonly backupDirectory?: string | undefined;
}

export interface InspectedBundleSourceRoot {
  readonly ref: string;
  readonly kind: BundleSourceKind;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly avatarId?: string | undefined;
}

export interface InspectedBundleSourceBundle {
  readonly path: string;
  readonly roots: readonly InspectedBundleSourceRoot[];
}

export async function initializeBundleSource(input: {
  readonly directory: string;
  readonly id: string;
  readonly name: string;
}): Promise<BundleSourceInitializationResult> {
  const directory = resolve(input.directory);
  const id = BundleSourceSlugSchema.parse(input.id);
  await mkdir(directory, { recursive: true });
  const manifestPath = join(directory, SOURCE_MANIFEST);
  try {
    await stat(manifestPath);
    throw new Error(`Bundle Source already exists: ${directory}`);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  const categories = DEFAULT_CATEGORIES.map(([categoryId, en, zhHans, zhHant], order) => ({
    id: categoryId,
    name: { default: en, translations: { en, "zh-Hans": zhHans, "zh-Hant": zhHant } },
    order: order * 10,
  }));
  const manifest = BundleSourceManifestSchema.parse({
    schemaVersion: "pragma.bundle-source/v2",
    id,
    name: { default: input.name },
    description: { default: `Community-maintained Pragma Bundles from ${input.name}.` },
    maxBundleBytes: 100 * 1024 * 1024,
    sections: {
      expert: { categories },
      "expert-team": { categories },
      flow: { categories },
      "knowledge-base": { categories },
    },
  });
  await writeYamlAtomically(manifestPath, manifest);
  const directories = Object.values(BUNDLE_SOURCE_KIND_DIRECTORIES).flatMap((kindDirectory) =>
    DEFAULT_CATEGORIES.map(([categoryId]) => join(directory, kindDirectory, categoryId)),
  );
  await Promise.all(directories.map(async (path) => await mkdir(path, { recursive: true })));
  return {
    sourceId: manifest.id,
    manifestPath,
    directories: directories.map((path) => repositoryPath(directory, path)),
  };
}

export async function inspectBundleSourceBundle(
  bundlePathInput: string,
): Promise<InspectedBundleSourceBundle> {
  const bundlePath = resolve(bundlePathInput);
  const decoded = await decodePragmaBundle({ kind: "file", path: bundlePath });
  const project = await loadPragmaProject({ kind: "decoded-bundle", bundle: decoded });
  try {
    const byRef = new Map(
      project.listResources().map((resource) => [canonicalPragmaResourceRef(resource), resource]),
    );
    const roots = decoded.manifest.roots.flatMap((ref) => {
      const resource = byRef.get(ref);
      if (resource === undefined) throw new Error(`Bundle root is missing: ${ref}`);
      if (
        resource.kind !== "Expert" &&
        resource.kind !== "ExpertTeam" &&
        resource.kind !== "Flow" &&
        resource.kind !== "ContextStore"
      ) {
        return [];
      }
      return [inspectedRoot(resource)];
    });
    if (roots.length === 0) throw new Error("Bundle does not contain a publishable callable root.");
    return { path: bundlePath, roots };
  } finally {
    await project.dispose();
  }
}

export async function addBundleSourceVersion(input: {
  readonly directory: string;
  readonly bundlePath: string;
  readonly kind: BundleSourceKind;
  readonly categoryId: string;
  readonly itemId: string;
  readonly rootRef: string;
  readonly version: string;
  readonly name: string;
  readonly summary: string;
  readonly description: string;
  readonly authorName: string;
  readonly authorUrl?: string | undefined;
  readonly license: string;
  readonly homepage?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly avatarId?: string | undefined;
  readonly now?: string | undefined;
}): Promise<{
  readonly configPath: string;
  readonly bundlePath: string;
  readonly created: boolean;
}> {
  const directory = resolve(input.directory);
  await assertGitWorkTree(directory);
  const rawManifest = parse(await readFile(join(directory, SOURCE_MANIFEST), "utf8")) as unknown;
  if (BundleSourceV1ManifestSchema.safeParse(rawManifest).success) {
    throw new Error(
      "Bundle Source v1 must be upgraded with `pragma source upgrade` before adding versions.",
    );
  }
  const manifest = await readBundleSourceManifest(directory);
  const categoryId = BundleSourceSlugSchema.parse(input.categoryId);
  const itemId = BundleSourceSlugSchema.parse(input.itemId);
  const version = BundleSourceSemverSchema.parse(input.version);
  if (!manifest.sections[input.kind].categories.some((category) => category.id === categoryId)) {
    throw new Error(`Unknown ${input.kind} Bundle Source category: ${categoryId}`);
  }
  const inspected = await inspectBundleSourceBundle(input.bundlePath);
  const selectedRoot = inspected.roots.find((root) => root.ref === input.rootRef);
  if (selectedRoot === undefined) throw new Error(`Bundle root was not found: ${input.rootRef}`);
  if (selectedRoot.kind !== input.kind) {
    throw new Error(`Bundle root ${input.rootRef} does not match Source kind ${input.kind}.`);
  }

  const conflictingConfig = (await listRepositoryFiles(directory)).find((path) => {
    const entry = parseBundleSourceRepositoryEntry(path);
    return (
      entry?.kind === "config" &&
      entry.sourceKind === input.kind &&
      entry.itemId === itemId &&
      entry.categoryId !== categoryId
    );
  });
  if (conflictingConfig !== undefined) {
    throw new Error(
      `Bundle Source item ${input.kind}:${itemId} already exists in another category.`,
    );
  }

  const itemDirectory = join(
    directory,
    ...bundleSourceItemDirectory({ kind: input.kind, categoryId, itemId }).split("/"),
  );
  const configPath = join(itemDirectory, ITEM_CONFIG);
  const destinationBundle = join(itemDirectory, "versions", version, "bundle.pragma");
  const existing = await readOptionalItem(configPath);
  if (existing !== undefined && existing.rootRef !== input.rootRef) {
    throw new Error(`Existing Bundle Source item uses a different root: ${existing.rootRef}`);
  }
  try {
    await stat(destinationBundle);
    throw new Error(`Bundle Source version already exists: ${itemId}@${version}`);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  const now = input.now ?? new Date().toISOString();
  const nextItem = BundleSourceItemSchema.parse(
    existing === undefined
      ? {
          schemaVersion: "pragma.bundle-source-item/v2",
          id: itemId,
          rootRef: input.rootRef,
          name: { default: input.name },
          summary: { default: input.summary },
          description: { default: input.description },
          author: {
            name: input.authorName,
            ...(input.authorUrl === undefined ? {} : { url: input.authorUrl }),
          },
          license: input.license,
          ...(input.homepage === undefined ? {} : { homepage: input.homepage }),
          tags: [...(input.tags ?? [])],
          ...(input.avatarId === undefined ? {} : { avatarId: input.avatarId }),
          latestVersion: version,
          createdAt: now,
          updatedAt: now,
        }
      : {
          ...existing,
          latestVersion:
            compareSemver(version, existing.latestVersion) >= 0 ? version : existing.latestVersion,
          updatedAt: now,
        },
  );

  if (existing === undefined) {
    const stagingItem = `${itemDirectory}.${randomUUID()}.tmp`;
    try {
      const stagingBundle = join(stagingItem, "versions", version, "bundle.pragma");
      await mkdir(dirname(stagingBundle), { recursive: true });
      await copyFile(inspected.path, stagingBundle);
      await writeYamlAtomically(join(stagingItem, ITEM_CONFIG), nextItem);
      await mkdir(dirname(itemDirectory), { recursive: true });
      await rename(stagingItem, itemDirectory);
    } finally {
      await rm(stagingItem, { recursive: true, force: true });
    }
  } else {
    const versionDirectory = dirname(destinationBundle);
    const stagingVersion = `${versionDirectory}.${randomUUID()}.tmp`;
    try {
      await mkdir(stagingVersion, { recursive: true });
      await copyFile(inspected.path, join(stagingVersion, "bundle.pragma"));
      await mkdir(dirname(versionDirectory), { recursive: true });
      await rename(stagingVersion, versionDirectory);
      try {
        await writeYamlAtomically(configPath, nextItem);
      } catch (error) {
        await rm(versionDirectory, { recursive: true, force: true });
        throw error;
      }
    } finally {
      await rm(stagingVersion, { recursive: true, force: true });
    }
  }
  return {
    configPath: repositoryPath(directory, configPath),
    bundlePath: repositoryPath(directory, destinationBundle),
    created: existing === undefined,
  };
}

export async function upgradeBundleSource(
  directoryInput: string,
): Promise<BundleSourceUpgradeResult> {
  const directory = resolve(directoryInput);
  await assertGitWorkTree(directory);
  const manifestPath = join(directory, SOURCE_MANIFEST);
  const journalPath = join(directory, ".pragma-source-upgrade.json");
  const raw = parse(await readFile(manifestPath, "utf8")) as unknown;
  const current = BundleSourceManifestSchema.safeParse(raw);
  const existingJournal = await readOptionalSourceUpgradeJournal(journalPath);
  if (current.success) {
    const configPaths = (await listRepositoryFiles(directory)).filter(
      (path) => parseBundleSourceRepositoryEntry(path)?.kind === "config",
    );
    if (existingJournal?.status !== "prepared") {
      for (const path of configPaths) {
        BundleSourceItemSchema.parse(
          parse(await readFile(join(directory, ...path.split("/")), "utf8")),
        );
      }
      return { directory, upgraded: false, itemCount: configPaths.length };
    }
    await finishBundleSourceUpgrade({
      directory,
      manifest: current.data,
      configPaths: existingJournal.files.filter((path) => path !== SOURCE_MANIFEST),
      journalPath,
      backupDirectory: join(directory, ...existingJournal.backupDirectory.split("/")),
    });
    return {
      directory,
      upgraded: true,
      itemCount: existingJournal.files.length - 1,
      backupDirectory: join(directory, ...existingJournal.backupDirectory.split("/")),
    };
  }
  const legacy = BundleSourceV1ManifestSchema.parse(raw);
  if (existingJournal?.status === "prepared") {
    await finishBundleSourceUpgrade({
      directory,
      manifest: parseBundleSourceManifest(legacy),
      configPaths: existingJournal.files.filter((path) => path !== SOURCE_MANIFEST),
      journalPath,
      backupDirectory: join(directory, ...existingJournal.backupDirectory.split("/")),
    });
    return {
      directory,
      upgraded: true,
      itemCount: existingJournal.files.length - 1,
      backupDirectory: join(directory, ...existingJournal.backupDirectory.split("/")),
    };
  }
  if (existingJournal?.status === "complete") {
    throw new Error("Bundle Source upgrade journal is complete but the manifest is still v1.");
  }
  const configPaths = (await listRepositoryFiles(directory)).filter(
    (path) => parseBundleSourceRepositoryEntry(path)?.kind === "config",
  );
  const backupDirectory = join(directory, ".pragma-source-v1-backup");
  try {
    await stat(backupDirectory);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    } else {
      throw error;
    }
  }
  await copyFileIfMissing(manifestPath, join(backupDirectory, SOURCE_MANIFEST));
  for (const path of configPaths) {
    const source = join(directory, ...path.split("/"));
    const target = join(backupDirectory, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFileIfMissing(source, target);
  }
  await writeJsonAtomically(journalPath, {
    schemaVersion: "pragma.bundle-source-upgrade/v1",
    sourceVersion: legacy.schemaVersion,
    targetVersion: "pragma.bundle-source/v2",
    backupDirectory: repositoryPath(directory, backupDirectory),
    files: [SOURCE_MANIFEST, ...configPaths],
    status: "prepared",
  });
  await finishBundleSourceUpgrade({
    directory,
    manifest: parseBundleSourceManifest(legacy),
    configPaths,
    journalPath,
    backupDirectory,
  });
  return {
    directory,
    upgraded: true,
    itemCount: configPaths.length,
    backupDirectory,
  };
}

interface BundleSourceUpgradeJournal {
  readonly schemaVersion: "pragma.bundle-source-upgrade/v1";
  readonly sourceVersion: "pragma.bundle-source/v1";
  readonly targetVersion: "pragma.bundle-source/v2";
  readonly backupDirectory: string;
  readonly files: readonly string[];
  readonly status: "prepared" | "complete";
}

async function finishBundleSourceUpgrade(input: {
  readonly directory: string;
  readonly manifest: BundleSourceManifest;
  readonly configPaths: readonly string[];
  readonly journalPath: string;
  readonly backupDirectory: string;
}): Promise<void> {
  for (const path of input.configPaths) {
    const target = join(input.directory, ...path.split("/"));
    const value = parseBundleSourceItem(parse(await readFile(target, "utf8")));
    await writeYamlAtomically(target, value);
  }
  await writeYamlAtomically(join(input.directory, SOURCE_MANIFEST), input.manifest);
  for (const category of input.manifest.sections["knowledge-base"].categories) {
    await mkdir(
      join(input.directory, BUNDLE_SOURCE_KIND_DIRECTORIES["knowledge-base"], category.id),
      { recursive: true },
    );
  }
  await writeJsonAtomically(input.journalPath, {
    schemaVersion: "pragma.bundle-source-upgrade/v1",
    sourceVersion: "pragma.bundle-source/v1",
    targetVersion: "pragma.bundle-source/v2",
    backupDirectory: repositoryPath(input.directory, input.backupDirectory),
    files: [SOURCE_MANIFEST, ...input.configPaths],
    status: "complete",
  } satisfies BundleSourceUpgradeJournal);
}

async function readOptionalSourceUpgradeJournal(
  path: string,
): Promise<BundleSourceUpgradeJournal | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<BundleSourceUpgradeJournal>;
    if (
      value.schemaVersion !== "pragma.bundle-source-upgrade/v1" ||
      value.sourceVersion !== "pragma.bundle-source/v1" ||
      value.targetVersion !== "pragma.bundle-source/v2" ||
      typeof value.backupDirectory !== "string" ||
      value.backupDirectory !== ".pragma-source-v1-backup" ||
      !Array.isArray(value.files) ||
      !value.files.every((item) => typeof item === "string") ||
      value.files[0] !== SOURCE_MANIFEST ||
      !value.files
        .slice(1)
        .every((item) => parseBundleSourceRepositoryEntry(item)?.kind === "config") ||
      (value.status !== "prepared" && value.status !== "complete")
    ) {
      throw new Error(`Invalid Bundle Source upgrade journal: ${path}`);
    }
    return value as BundleSourceUpgradeJournal;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function copyFileIfMissing(source: string, target: string): Promise<void> {
  try {
    await stat(target);
    const [sourceContents, targetContents] = await Promise.all([
      readFile(source),
      readFile(target),
    ]);
    if (!sourceContents.equals(targetContents)) {
      throw new Error(`Bundle Source upgrade backup does not match its source: ${target}`);
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    await copyFile(source, target);
  }
}

export async function validateBundleSourceDirectory(directoryInput: string): Promise<{
  readonly sourceId: string;
  readonly itemCount: number;
  readonly versionCount: number;
}> {
  const directory = resolve(directoryInput);
  const manifest = await readBundleSourceManifest(directory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === ".gitmodules") {
      throw new Error(`Bundle Source symlinks and submodules are not allowed: ${entry.name}`);
    }
  }
  const paths = await listRepositoryFiles(directory);
  const entries = paths
    .filter((path) =>
      Object.values(BUNDLE_SOURCE_KIND_DIRECTORIES).some((root) => path.startsWith(`${root}/`)),
    )
    .map((path) => ({ path, parsed: parseBundleSourceRepositoryEntry(path) }));
  const invalid = entries.find((entry) => entry.parsed === undefined);
  if (invalid !== undefined)
    throw new Error(`Unsupported Bundle Source item file: ${invalid.path}`);
  const configs = entries.filter(
    (
      entry,
    ): entry is typeof entry & {
      parsed: Extract<NonNullable<typeof entry.parsed>, { kind: "config" }>;
    } => entry.parsed?.kind === "config",
  );
  const bundles = entries.filter(
    (
      entry,
    ): entry is typeof entry & {
      parsed: Extract<NonNullable<typeof entry.parsed>, { kind: "bundle" }>;
    } => entry.parsed?.kind === "bundle",
  );
  const seen = new Set<string>();
  for (const configEntry of configs) {
    const key = `${configEntry.parsed.sourceKind}:${configEntry.parsed.itemId}`;
    if (seen.has(key)) throw new Error(`Duplicate Bundle Source item: ${key}`);
    seen.add(key);
    const item = parseBundleSourceItem(
      parse(await readFile(join(directory, ...configEntry.path.split("/")), "utf8")),
    );
    if (item.id !== configEntry.parsed.itemId) {
      throw new Error(`Bundle Source item id does not match its directory: ${item.id}`);
    }
    if (!item.rootRef.startsWith(`${bundleSourceRootPrefix(configEntry.parsed.sourceKind)}:`)) {
      throw new Error(`Bundle Source rootRef does not match item kind: ${item.rootRef}`);
    }
    if (
      !manifest.sections[configEntry.parsed.sourceKind].categories.some(
        (category) => category.id === configEntry.parsed.categoryId,
      )
    ) {
      throw new Error(
        `Bundle Source item uses an unknown category: ${configEntry.parsed.categoryId}`,
      );
    }
    const itemBundles = bundles.filter(
      (bundle) =>
        bundle.parsed.sourceKind === configEntry.parsed.sourceKind &&
        bundle.parsed.categoryId === configEntry.parsed.categoryId &&
        bundle.parsed.itemId === configEntry.parsed.itemId,
    );
    if (!itemBundles.some((bundle) => bundle.parsed.version === item.latestVersion)) {
      throw new Error(`Latest Bundle Source version is missing: ${item.id}@${item.latestVersion}`);
    }
    for (const bundle of itemBundles) {
      const bundlePath = join(directory, ...bundle.path.split("/"));
      const file = await stat(bundlePath);
      if (!file.isFile() || file.size > manifest.maxBundleBytes) {
        throw new Error(`Invalid Bundle Source Bundle: ${bundle.path}`);
      }
      const inspected = await inspectBundleSourceBundle(bundlePath);
      const configuredRoot = inspected.roots.find((root) => root.ref === item.rootRef);
      if (configuredRoot === undefined || configuredRoot.kind !== configEntry.parsed.sourceKind) {
        throw new Error(`Bundle Source Bundle root does not match config.yaml: ${bundle.path}`);
      }
    }
  }
  if (
    bundles.some(
      (bundle) =>
        !configs.some(
          (config) =>
            config.parsed.sourceKind === bundle.parsed.sourceKind &&
            config.parsed.categoryId === bundle.parsed.categoryId &&
            config.parsed.itemId === bundle.parsed.itemId,
        ),
    )
  ) {
    throw new Error("Bundle Source contains a version without config.yaml.");
  }
  return { sourceId: manifest.id, itemCount: configs.length, versionCount: bundles.length };
}

export async function readBundleSourceManifest(
  directoryInput: string,
): Promise<BundleSourceManifest> {
  const directory = resolve(directoryInput);
  return parseBundleSourceManifest(parse(await readFile(join(directory, SOURCE_MANIFEST), "utf8")));
}

function inspectedRoot(resource: PragmaResource): InspectedBundleSourceRoot {
  if (
    resource.kind !== "Expert" &&
    resource.kind !== "ExpertTeam" &&
    resource.kind !== "Flow" &&
    resource.kind !== "ContextStore"
  ) {
    throw new Error(`Bundle root is not publishable in a Bundle Source: ${resource.kind}`);
  }
  const kind: BundleSourceKind =
    resource.kind === "Expert"
      ? "expert"
      : resource.kind === "ExpertTeam"
        ? "expert-team"
        : resource.kind === "Flow"
          ? "flow"
          : "knowledge-base";
  const metadata = resource.metadata;
  return {
    ref: canonicalPragmaResourceRef(resource),
    kind,
    name: metadata.name,
    description: metadata.description,
    tags: metadata.tags,
    ...("avatarId" in metadata ? { avatarId: metadata.avatarId } : {}),
  };
}

async function readOptionalItem(path: string): Promise<BundleSourceItem | undefined> {
  try {
    return parseBundleSourceItem(parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function assertGitWorkTree(directory: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", directory, "rev-parse", "--is-inside-work-tree"],
      { timeout: 10_000 },
    );
    if (stdout.trim() !== "true") throw new Error("Not a Git work tree.");
  } catch (error) {
    throw new Error("Bundle Source additions require a local Git working tree.", { cause: error });
  }
}

async function listRepositoryFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Bundle Source symlinks are not allowed: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(repositoryPath(directory, path));
    }
  };
  for (const sourceRoot of Object.values(BUNDLE_SOURCE_KIND_DIRECTORIES)) {
    try {
      await visit(join(directory, sourceRoot));
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
  return output.toSorted();
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
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function repositoryPath(directory: string, path: string): string {
  return relative(directory, path).split(sep).join("/");
}

function compareSemver(left: string, right: string): number {
  const normalized = (value: string) => {
    const [withoutBuild] = value.split("+", 1);
    const [core, prerelease] = withoutBuild!.split("-", 2);
    return {
      core: core!.split(".").map(Number),
      prerelease: prerelease?.split("."),
    };
  };
  const leftValue = normalized(left);
  const rightValue = normalized(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftValue.core[index] ?? 0) - (rightValue.core[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (leftValue.prerelease === undefined) return rightValue.prerelease === undefined ? 0 : 1;
  if (rightValue.prerelease === undefined) return -1;
  const length = Math.max(leftValue.prerelease.length, rightValue.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftValue.prerelease[index];
    const rightPart = rightValue.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
