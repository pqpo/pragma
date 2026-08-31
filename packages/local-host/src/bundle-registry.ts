import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { decodePragmaBundle, loadPragmaProject } from "@pragma/interpreter";
import {
  BundleRegistryCatalogIndexSchema,
  BundleRegistryCategoryCatalogSchema,
  BundleRegistryManifestSchema,
  BundleRegistryPackageDraftSchema,
  BundleRegistryPackageSchema,
  BundleRegistryPackageShardSchema,
  BundleRegistrySemverSchema,
  BundleRegistrySlugSchema,
  type BundleRegistryManifest,
  type BundleRegistryPackage,
  type BundleRegistryPackageSummary,
} from "@pragma/shared";
import { parse, stringify } from "yaml";

const execFileAsync = promisify(execFile);
const REGISTRY_MANIFEST = "pragma-registry.yaml";

export interface BundleRegistryBuildResult {
  readonly registryId: string;
  readonly packageCount: number;
  readonly files: readonly string[];
}

export async function initializeBundleRegistry(input: {
  readonly directory: string;
  readonly id: string;
  readonly name: string;
}): Promise<BundleRegistryBuildResult> {
  const directory = resolve(input.directory);
  const id = BundleRegistrySlugSchema.parse(input.id);
  await mkdir(directory, { recursive: true });
  try {
    await stat(join(directory, REGISTRY_MANIFEST));
    throw new Error(`Bundle Registry already exists: ${directory}`);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  const manifest: BundleRegistryManifest = BundleRegistryManifestSchema.parse({
    schemaVersion: "pragma.bundle-registry/v1",
    id,
    name: { default: input.name },
    maxBundleBytes: 100 * 1024 * 1024,
    categories: [
      { id: "general", name: { default: "General" }, order: 0 },
      { id: "development", name: { default: "Development" }, order: 10 },
      {
        id: "development/coding",
        name: { default: "Coding" },
        order: 0,
      },
      { id: "research", name: { default: "Research" }, order: 20 },
      { id: "productivity", name: { default: "Productivity" }, order: 30 },
      { id: "content", name: { default: "Content" }, order: 40 },
    ],
    catalog: "catalog/index.json",
  });
  await writeYaml(join(directory, REGISTRY_MANIFEST), manifest);
  await mkdir(join(directory, "packages"), { recursive: true });
  await mkdir(join(directory, "objects", "sha256"), { recursive: true });
  return await buildBundleRegistry(directory);
}

export async function initializeBundleRegistryPackage(input: {
  readonly directory: string;
  readonly packageId: string;
  readonly categoryId: string;
  readonly name?: string | undefined;
  readonly publisher?: string | undefined;
}): Promise<{ readonly packagePath: string }> {
  const directory = resolve(input.directory);
  const registry = await readRegistryManifest(directory);
  const packageId = BundleRegistrySlugSchema.parse(input.packageId);
  if (!registry.categories.some((category) => category.id === input.categoryId)) {
    throw new Error(`Unknown Registry category: ${input.categoryId}`);
  }
  const packageDirectory = join(directory, "packages", ...input.categoryId.split("/"), packageId);
  const packagePath = join(packageDirectory, "package.yaml");
  try {
    await stat(packagePath);
    throw new Error(`Registry package already exists: ${packageId}`);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  await mkdir(packageDirectory, { recursive: true });
  const readmePath = repositoryPath(directory, join(packageDirectory, "README.md"));
  await writeFile(
    join(packageDirectory, "README.md"),
    `# ${input.name ?? packageId}\n\nDescribe what this Pragma Bundle does and its known limitations.\n`,
    "utf8",
  );
  await writeYaml(packagePath, {
    schemaVersion: "pragma.bundle-registry-package/v1",
    id: packageId,
    name: { default: input.name ?? packageId },
    summary: { default: "Describe this Bundle before publishing." },
    publisher: { name: input.publisher ?? "TODO" },
    license: "NOASSERTION",
    primaryCategory: input.categoryId,
    categories: [input.categoryId],
    tags: [],
    readme: readmePath,
    media: { screenshots: [] },
    channels: {},
    versions: [],
  });
  return { packagePath };
}

export async function publishBundleRegistryVersion(input: {
  readonly directory: string;
  readonly packageId: string;
  readonly version: string;
  readonly bundlePath: string;
  readonly channel?: "stable" | "preview" | undefined;
  readonly releasedAt?: string | undefined;
}): Promise<{
  readonly packagePath: string;
  readonly objectPath: string;
  readonly sha256: string;
}> {
  const directory = resolve(input.directory);
  const packageId = BundleRegistrySlugSchema.parse(input.packageId);
  const version = BundleRegistrySemverSchema.parse(input.version);
  const registry = await readRegistryManifest(directory);
  const packagePath = await findPackagePath(directory, packageId);
  const draft = BundleRegistryPackageDraftSchema.parse(parse(await readFile(packagePath, "utf8")));
  if (draft.versions.some((candidate) => candidate.version === version)) {
    throw new Error(`Registry package ${packageId} already has version ${version}.`);
  }
  const bundleBytes = new Uint8Array(await readFile(resolve(input.bundlePath)));
  if (bundleBytes.byteLength > registry.maxBundleBytes) {
    throw new Error(
      `Bundle is ${bundleBytes.byteLength} bytes; Registry limit is ${registry.maxBundleBytes} bytes.`,
    );
  }
  const decoded = await decodePragmaBundle(
    { kind: "bytes", bytes: bundleBytes },
    {
      maxArchiveBytes: registry.maxBundleBytes,
    },
  );
  const sourceRootRef = decoded.manifest.roots[0];
  if (sourceRootRef === undefined) throw new Error("Bundle does not declare a root resource.");
  const project = await loadPragmaProject({ kind: "decoded-bundle", bundle: decoded });
  let root;
  try {
    root = project.listResources().find((resource) => {
      const prefix = resource.kind === "ExpertTeam" ? "team" : resource.kind.toLowerCase();
      return `${prefix}:${resource.metadata.id}` === sourceRootRef;
    });
  } finally {
    await project.dispose();
  }
  if (root === undefined || !["Expert", "ExpertTeam", "Flow"].includes(root.kind)) {
    throw new Error(`Bundle root is not a publishable resource: ${sourceRootRef}`);
  }
  const sha256 = hashBytes(bundleBytes);
  const objectPath = `objects/sha256/${sha256.slice(0, 2)}/${sha256}.pragma`;
  const absoluteObjectPath = join(directory, ...objectPath.split("/"));
  await mkdir(dirname(absoluteObjectPath), { recursive: true });
  try {
    const existing = new Uint8Array(await readFile(absoluteObjectPath));
    if (hashBytes(existing) !== sha256)
      throw new Error(`Registry object is corrupt: ${objectPath}`);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    await copyFile(resolve(input.bundlePath), absoluteObjectPath);
  }
  const requirements = decoded.manifest.requirements.map((requirement) => ({
    kind: requirement.kind,
    name: requirement.name,
    required: requirement.required,
  }));
  const nextVersion = {
    version,
    releasedAt: input.releasedAt ?? new Date().toISOString(),
    bundle: {
      path: objectPath,
      size: bundleBytes.byteLength,
      sha256,
      bundleFingerprint: decoded.manifest.bundleFingerprint,
      projectFingerprint: decoded.manifest.project.projectFingerprint,
      bundleSchemaVersion: decoded.manifest.schemaVersion,
      compilerVersion: decoded.manifest.project.compilerVersion,
      root: {
        ref: sourceRootRef,
        kind: root.kind as "Expert" | "ExpertTeam" | "Flow",
        name: root.metadata.name,
      },
      requirements,
    },
  };
  const channel = input.channel ?? (version.includes("-") ? "preview" : "stable");
  const nextPackage = BundleRegistryPackageSchema.parse({
    ...draft,
    channels: {
      ...draft.channels,
      [channel]: version,
      ...(draft.channels.stable === undefined && channel === "preview" ? { stable: version } : {}),
    },
    versions: [...draft.versions, nextVersion],
  });
  await writeYaml(packagePath, nextPackage);
  await buildBundleRegistry(directory);
  return { packagePath, objectPath, sha256 };
}

export async function buildBundleRegistry(
  directoryInput: string,
): Promise<BundleRegistryBuildResult> {
  const directory = resolve(directoryInput);
  const generated = await generateBundleRegistry(directory);
  const previous = await snapshotCatalog(directory);
  const files: string[] = [];
  for (const [path, contents] of generated.files) {
    await writeTextAtomically(join(directory, ...path.split("/")), contents);
    files.push(path);
  }
  for (const path of previous.keys()) {
    if (!generated.files.has(path)) {
      await rm(join(directory, ...path.split("/")), { force: true });
    }
  }
  return {
    registryId: generated.registryId,
    packageCount: generated.packageCount,
    files: files.toSorted(),
  };
}

async function generateBundleRegistry(directory: string): Promise<{
  readonly registryId: string;
  readonly packageCount: number;
  readonly files: ReadonlyMap<string, string>;
}> {
  const registry = await readRegistryManifest(directory);
  const packagePaths = (await findFiles(join(directory, "packages"), "package.yaml")).toSorted();
  const packages: { readonly value: BundleRegistryPackage; readonly path: string }[] = [];
  const seenIds = new Set<string>();
  for (const packagePath of packagePaths) {
    const value = BundleRegistryPackageSchema.parse(parse(await readFile(packagePath, "utf8")));
    if (seenIds.has(value.id)) throw new Error(`Duplicate Registry package id: ${value.id}`);
    seenIds.add(value.id);
    if (!registry.categories.some((category) => category.id === value.primaryCategory)) {
      throw new Error(`Package ${value.id} uses unknown category ${value.primaryCategory}.`);
    }
    for (const category of value.categories) {
      if (!registry.categories.some((candidate) => candidate.id === category)) {
        throw new Error(`Package ${value.id} uses unknown category ${category}.`);
      }
    }
    await validatePackageFiles(directory, registry, value);
    packages.push({ value, path: repositoryPath(directory, packagePath) });
  }

  const generated = new Map<string, string>();
  const summaries = packages.map(({ value, path }) => packageSummary(value, path));
  for (const [prefix, items] of groupBy(summaries, (item) => item.id[0]!)) {
    generated.set(
      `catalog/packages/${prefix}.json`,
      stableJson(
        BundleRegistryPackageShardSchema.parse({
          schemaVersion: "pragma.bundle-registry-package-shard/v1",
          packages: items.toSorted((left, right) => left.id.localeCompare(right.id)),
        }),
      ),
    );
  }
  for (const category of registry.categories) {
    generated.set(
      `catalog/categories/${category.id}.json`,
      stableJson(
        BundleRegistryCategoryCatalogSchema.parse({
          schemaVersion: "pragma.bundle-registry-category/v1",
          categoryId: category.id,
          packageIds: summaries
            .filter((item) => item.categories.includes(category.id))
            .map((item) => item.id)
            .toSorted(),
        }),
      ),
    );
  }
  const packageShards = [...generated]
    .filter(([path]) => path.startsWith("catalog/packages/"))
    .map(([path, contents]) => ({
      prefix: basename(path, ".json"),
      path,
      sha256: hashText(contents),
      count: JSON.parse(contents).packages.length as number,
    }));
  const categoryIndexes = [...generated]
    .filter(([path]) => path.startsWith("catalog/categories/"))
    .map(([path, contents]) => {
      const parsed = BundleRegistryCategoryCatalogSchema.parse(JSON.parse(contents));
      return {
        categoryId: parsed.categoryId,
        path,
        sha256: hashText(contents),
        count: parsed.packageIds.length,
      };
    });
  generated.set(
    registry.catalog,
    stableJson(
      BundleRegistryCatalogIndexSchema.parse({
        schemaVersion: "pragma.bundle-registry-catalog/v1",
        registryId: registry.id,
        packageCount: packages.length,
        packageShards: packageShards.toSorted((left, right) =>
          left.prefix.localeCompare(right.prefix),
        ),
        categoryIndexes: categoryIndexes.toSorted((left, right) =>
          left.categoryId.localeCompare(right.categoryId),
        ),
      }),
    ),
  );
  return { registryId: registry.id, packageCount: packages.length, files: generated };
}

export async function checkBundleRegistry(
  directoryInput: string,
): Promise<BundleRegistryBuildResult> {
  const directory = resolve(directoryInput);
  const actual = await snapshotCatalog(directory);
  const expected = await generateBundleRegistry(directory);
  if (
    actual.size !== expected.files.size ||
    [...expected.files].some(([path, value]) => actual.get(path) !== value)
  ) {
    throw new Error(
      "Generated Registry catalog is stale. Run `pragma registry build` and commit it.",
    );
  }
  return {
    registryId: expected.registryId,
    packageCount: expected.packageCount,
    files: [...expected.files.keys()].toSorted(),
  };
}

export async function prepareBundleRegistryPublishCommit(input: {
  readonly directory: string;
  readonly packageId: string;
  readonly version: string;
}): Promise<{ readonly branch: string; readonly commit: string }> {
  const directory = resolve(input.directory);
  const branch = `registry/${input.packageId}-${input.version}`;
  await execFileAsync("git", ["-C", directory, "switch", "-c", branch], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  await execFileAsync(
    "git",
    ["-C", directory, "add", "--", REGISTRY_MANIFEST, "catalog", "packages", "objects"],
    {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  await execFileAsync(
    "git",
    [
      "-C",
      directory,
      "commit",
      "--only",
      "-m",
      `registry: publish ${input.packageId}@${input.version}`,
      "--",
      REGISTRY_MANIFEST,
      "catalog",
      "packages",
      "objects",
    ],
    { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const { stdout } = await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"], {
    timeout: 10_000,
  });
  return { branch, commit: stdout.trim() };
}

async function readRegistryManifest(directory: string): Promise<BundleRegistryManifest> {
  return BundleRegistryManifestSchema.parse(
    parse(await readFile(join(directory, REGISTRY_MANIFEST), "utf8")),
  );
}

async function findPackagePath(directory: string, packageId: string): Promise<string> {
  const matches = (await findFiles(join(directory, "packages"), "package.yaml")).filter(
    (path) => basename(dirname(path)) === packageId,
  );
  if (matches.length !== 1) throw new Error(`Expected exactly one package named ${packageId}.`);
  return matches[0]!;
}

async function validatePackageFiles(
  directory: string,
  registry: BundleRegistryManifest,
  item: BundleRegistryPackage,
): Promise<void> {
  await assertRegularFile(directory, item.readme, 512 * 1024);
  for (const path of Object.values(item.localizedReadmes ?? {})) {
    if (path !== undefined) await assertRegularFile(directory, path, 512 * 1024);
  }
  if (item.media.icon !== undefined)
    await assertRegularFile(directory, item.media.icon, 1024 * 1024);
  for (const path of item.media.screenshots)
    await assertRegularFile(directory, path, 4 * 1024 * 1024);
  for (const version of item.versions) {
    const path = resolveRepositoryPath(directory, version.bundle.path);
    const file = await stat(path);
    if (
      !file.isFile() ||
      file.size !== version.bundle.size ||
      file.size > registry.maxBundleBytes
    ) {
      throw new Error(`Bundle size mismatch: ${version.bundle.path}`);
    }
    if (hashBytes(new Uint8Array(await readFile(path))) !== version.bundle.sha256) {
      throw new Error(`Bundle hash mismatch: ${version.bundle.path}`);
    }
  }
}

function packageSummary(item: BundleRegistryPackage, path: string): BundleRegistryPackageSummary {
  const stable = item.versions.find((version) => version.version === item.channels.stable)!;
  const preview = item.versions.find((version) => version.version === item.channels.preview);
  return {
    id: item.id,
    name: item.name,
    summary: item.summary,
    publisher: item.publisher,
    license: item.license,
    primaryCategory: item.primaryCategory,
    categories: item.categories,
    tags: item.tags,
    media: item.media,
    channels: item.channels,
    packagePath: path,
    stable,
    ...(preview === undefined ? {} : { preview }),
  };
}

async function assertRegularFile(directory: string, path: string, maxBytes: number): Promise<void> {
  const value = await stat(resolveRepositoryPath(directory, path));
  if (!value.isFile() || value.size > maxBytes) throw new Error(`Invalid Registry file: ${path}`);
}

function resolveRepositoryPath(directory: string, path: string): string {
  const resolved = resolve(directory, ...path.split("/"));
  if (resolved !== directory && !resolved.startsWith(`${directory}${sep}`)) {
    throw new Error(`Registry path escapes its repository: ${path}`);
  }
  return resolved;
}

function repositoryPath(directory: string, path: string): string {
  return relative(directory, path).split(sep).join("/");
}

async function findFiles(directory: string, name: string): Promise<string[]> {
  const output: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return output;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Registry symlinks are not allowed: ${path}`);
    if (entry.isDirectory()) output.push(...(await findFiles(path, name)));
    else if (entry.isFile() && entry.name === name) output.push(path);
  }
  return output;
}

async function snapshotCatalog(directory: string): Promise<Map<string, string>> {
  const files = await findJsonFiles(join(directory, "catalog"));
  return new Map(
    await Promise.all(
      files.map(
        async (path) => [repositoryPath(directory, path), await readFile(path, "utf8")] as const,
      ),
    ),
  );
}

async function findJsonFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return output;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await findJsonFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".json")) output.push(path);
  }
  return output;
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) groups.set(key(value), [...(groups.get(key(value)) ?? []), value]);
  return groups;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

async function writeYaml(path: string, value: unknown): Promise<void> {
  await writeTextAtomically(path, stringify(value, { lineWidth: 100 }));
}

async function writeTextAtomically(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
