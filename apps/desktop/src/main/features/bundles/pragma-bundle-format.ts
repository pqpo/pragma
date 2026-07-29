import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

import { loadPragmaProject } from "@pragma/interpreter";
import {
  PragmaInvocableResourceSchema,
  canonicalPragmaResourceRef,
  type PragmaResource,
  type PragmaResourceRef,
} from "@pragma/interpreter/ast";
import { strFromU8, unzip, zip, type AsyncUnzipOptions } from "fflate";
import { z } from "zod";

import {
  CapabilityDefinitionSchema,
  DesktopPluginManifestSchema,
} from "../../../shared/contracts/index.ts";
import { collectProjectArtifactPaths } from "./pragma-bundle-resources.ts";

export const MAX_BUNDLE_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const MAX_BUNDLE_UNPACKED_BYTES = 1024 * 1024 * 1024;
export const MAX_BUNDLE_FILES = 20_000;

const BundleFileSchema = z
  .object({
    path: z.string().trim().min(1).max(2_000),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const BundleCapabilityDependencySchema = z
  .object({
    resourceRef: z.string().min(1),
    name: z.string().min(1).max(200),
    kind: z.enum(["skill", "mcp_server", "http_service", "code_service"]).optional(),
    definitionFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    definition: CapabilityDefinitionSchema.optional(),
    included: z.boolean(),
    payloadRoot: z.string().optional(),
  })
  .strict();

export const BundleContextDependencySchema = z
  .object({
    resourceRef: z.string().min(1),
    name: z.string().min(1).max(200),
    description: z.string().max(2_000),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    included: z.boolean(),
    payloadRoot: z.string().optional(),
  })
  .strict();

export const BundlePluginDependencySchema = z
  .object({
    ref: z.string().min(1),
    name: z.string().min(1).max(200),
    origin: z.enum(["built_in", "user", "missing"]),
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    manifest: DesktopPluginManifestSchema.optional(),
    included: z.boolean(),
    payloadRoot: z.string().optional(),
  })
  .strict();

export const BundleRuntimeDependencySchema = z
  .object({
    resourceRef: z.string().min(1),
    name: z.string().min(1).max(200),
    runtimeId: z.string().min(1).optional(),
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    thinkingLevel: z.string().min(1).optional(),
  })
  .strict();

export const PragmaBundleManifestSchema = z
  .object({
    schemaVersion: z.literal("pragma.desktop-bundle/v1"),
    createdAt: z.string().datetime(),
    bundleFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    source: z
      .object({
        projectId: z.string().min(1),
        revision: z.number().int().positive(),
        projectFingerprint: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict(),
    root: z
      .object({
        ref: z.string().min(1),
        kind: z.enum(["Expert", "ExpertTeam", "Flow"]),
        name: z.string().min(1).max(200),
      })
      .strict(),
    modules: z
      .object({
        capabilities: z.boolean(),
        plugins: z.boolean(),
        knowledgeBases: z.boolean(),
        flowLayouts: z.boolean(),
      })
      .strict(),
    resourceCount: z.number().int().positive(),
    projectArtifacts: z.array(z.string().min(1)),
    dependencies: z
      .object({
        capabilities: z.array(BundleCapabilityDependencySchema),
        contextStores: z.array(BundleContextDependencySchema),
        plugins: z.array(BundlePluginDependencySchema),
        runtimes: z.array(BundleRuntimeDependencySchema),
      })
      .strict(),
    files: z.array(BundleFileSchema),
  })
  .strict();

export type BundleManifest = z.infer<typeof PragmaBundleManifestSchema>;
export type BundleArchive = {
  readonly manifest: BundleManifest;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly resources: readonly PragmaResource[];
  readonly archiveBytes: number;
};

export async function readPragmaBundle(
  sourcePath: string,
  externalResourceRefs?: ReadonlySet<string>,
): Promise<BundleArchive> {
  if (!sourcePath.toLowerCase().endsWith(".pragma.bundle")) {
    throw new Error("Select a .pragma.bundle file.");
  }
  const details = await stat(sourcePath);
  if (!details.isFile() || details.size <= 0 || details.size > MAX_BUNDLE_ARCHIVE_BYTES) {
    throw new Error("The bundle is missing or exceeds 512 MiB.");
  }
  const raw = new Uint8Array(await readFile(sourcePath));
  const seenPaths = new Set<string>();
  let indexedFiles = 0;
  let indexedBytes = 0;
  const filter: NonNullable<AsyncUnzipOptions["filter"]> = (file) => {
    const path = normalizeArchivePath(file.name);
    const collisionKey = path.replace(/\/$/, "").normalize("NFC").toLocaleLowerCase("en-US");
    if (seenPaths.has(collisionKey)) {
      throw new Error(`Duplicate or non-portable bundle path: ${file.name}`);
    }
    seenPaths.add(collisionKey);
    indexedFiles += 1;
    indexedBytes += file.originalSize;
    if (indexedFiles > MAX_BUNDLE_FILES || indexedBytes > MAX_BUNDLE_UNPACKED_BYTES) {
      throw new Error("The unpacked bundle exceeds 1 GiB or 20,000 files.");
    }
    return true;
  };
  let unpacked: Record<string, Uint8Array>;
  try {
    unpacked = await unzipArchive(raw, { filter });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith("The unpacked bundle") ||
        error.message.startsWith("Unsafe bundle path") ||
        error.message.startsWith("Duplicate or non-portable bundle path"))
    ) {
      throw error;
    }
    throw new Error("The selected file is not a readable ZIP archive.", { cause: error });
  }

  const files = new Map<string, Uint8Array>();
  let unpackedBytes = 0;
  for (const [rawPath, contents] of Object.entries(unpacked)) {
    const path = normalizeArchivePath(rawPath);
    if (path.endsWith("/")) continue;
    unpackedBytes += contents.byteLength;
    if (files.size >= MAX_BUNDLE_FILES || unpackedBytes > MAX_BUNDLE_UNPACKED_BYTES) {
      throw new Error("The unpacked bundle exceeds 1 GiB or 20,000 files.");
    }
    files.set(path, contents);
  }
  const manifestSource = files.get("bundle.json");
  if (manifestSource === undefined) throw new Error("The bundle is missing bundle.json.");
  const manifest = PragmaBundleManifestSchema.parse(JSON.parse(strFromU8(manifestSource)));
  if (new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length) {
    throw new Error("The bundle file index contains duplicate paths.");
  }
  const expectedFiles = new Set(manifest.files.map((file) => file.path));
  const actualFiles = new Set([...files.keys()].filter((path) => path !== "bundle.json"));
  if (
    expectedFiles.size !== actualFiles.size ||
    [...expectedFiles].some((path) => !actualFiles.has(path))
  ) {
    throw new Error("The bundle file index does not match the archive.");
  }
  for (const indexed of manifest.files) {
    const contents = files.get(indexed.path);
    if (
      contents === undefined ||
      contents.byteLength !== indexed.size ||
      sha256(contents) !== indexed.sha256
    ) {
      throw new Error(`Bundle file verification failed: ${indexed.path}`);
    }
  }
  if (createBundleFingerprint(manifest) !== manifest.bundleFingerprint) {
    throw new Error("The bundle manifest fingerprint is invalid.");
  }

  const temporary = await mkdtemp(join(tmpdir(), "pragma-bundle-inspect-"));
  try {
    for (const [path, contents] of files) {
      if (path === "bundle.json" || path.startsWith("payloads/") || path.startsWith("layouts/")) {
        continue;
      }
      const destination = join(temporary, path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, contents, { mode: 0o600 });
    }
    const project = await loadPragmaProject(join(temporary, "pragma.yaml"), {
      rootDir: temporary,
      requireLock: true,
      externalResourceRefs: externalResourceRefs as ReadonlySet<PragmaResourceRef> | undefined,
    });
    const diagnostics = await project.validate();
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length > 0) throw new Error(errors.map((error) => error.message).join("\n"));
    const resources = project.listResources();
    assertManifestSemantics(manifest, files, resources);
    return { manifest, files, resources, archiveBytes: raw.byteLength };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function createPragmaBundleZip(
  files: ReadonlyMap<string, Uint8Array>,
): Promise<Uint8Array> {
  return await new Promise<Uint8Array>((resolvePromise, reject) => {
    zip(Object.fromEntries(files), { level: 6 }, (error, result) => {
      if (error !== null) reject(error);
      else resolvePromise(result);
    });
  });
}

export async function writeBundleAtomically(path: string, contents: Uint8Array): Promise<void> {
  if (!isAbsolute(path)) throw new Error("Bundle destination must be an absolute path.");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createBundleFingerprint(
  manifest: Omit<BundleManifest, "bundleFingerprint"> | BundleManifest,
): string {
  return sha256(
    stableStringify({
      schemaVersion: manifest.schemaVersion,
      root: manifest.root,
      modules: manifest.modules,
      resourceCount: manifest.resourceCount,
      projectArtifacts: manifest.projectArtifacts,
      dependencies: manifest.dependencies,
      files: manifest.files,
    }),
  );
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function isPortableValue(value: unknown): boolean {
  if (typeof value === "string") {
    return !isAbsolute(value) && !/^[a-z]:[\\/]/i.test(value) && !value.startsWith("~/");
  }
  if (Array.isArray(value)) return value.every(isPortableValue);
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).every(isPortableValue);
  }
  return true;
}

function assertManifestSemantics(
  manifest: BundleManifest,
  files: ReadonlyMap<string, Uint8Array>,
  resources: readonly PragmaResource[],
): void {
  if (resources.length !== manifest.resourceCount) {
    throw new Error("The bundle resource count does not match its manifest.");
  }
  const root = resources.find(
    (resource) => canonicalPragmaResourceRef(resource) === manifest.root.ref,
  );
  if (
    root === undefined ||
    root.kind !== manifest.root.kind ||
    root.metadata.name !== manifest.root.name ||
    !PragmaInvocableResourceSchema.safeParse(root).success
  ) {
    throw new Error("The bundle root does not match its manifest.");
  }

  const actualArtifacts = collectProjectArtifactPaths(resources);
  if (
    actualArtifacts.length !== manifest.projectArtifacts.length ||
    actualArtifacts.some((path, index) => path !== manifest.projectArtifacts.toSorted()[index])
  ) {
    throw new Error("The bundle project artifact index does not match its resources.");
  }
  for (const path of actualArtifacts) {
    if (path === "bundle.json" || path.startsWith("payloads/") || path.startsWith("layouts/")) {
      throw new Error(`Project artifact uses a reserved bundle path: ${path}`);
    }
  }

  const resourceRefs = new Set(resources.map(canonicalPragmaResourceRef));
  assertUnique(
    manifest.dependencies.capabilities.map((dependency) => dependency.resourceRef),
    "capability dependency",
  );
  assertUnique(
    manifest.dependencies.contextStores.map((dependency) => dependency.resourceRef),
    "context-store dependency",
  );
  assertUnique(
    manifest.dependencies.runtimes.map((dependency) => dependency.resourceRef),
    "runtime dependency",
  );
  assertUnique(
    manifest.dependencies.plugins.map((dependency) => dependency.ref),
    "plugin dependency",
  );
  assertExactSet(
    resources.filter((resource) => resource.kind === "Capability").map(canonicalPragmaResourceRef),
    manifest.dependencies.capabilities.map((dependency) => dependency.resourceRef),
    "capability dependencies",
  );
  assertExactSet(
    resources
      .filter((resource) => resource.kind === "ContextStore")
      .map(canonicalPragmaResourceRef),
    manifest.dependencies.contextStores.map((dependency) => dependency.resourceRef),
    "context-store dependencies",
  );
  assertExactSet(
    resources
      .filter((resource) => resource.kind === "RuntimeProfile")
      .map(canonicalPragmaResourceRef),
    manifest.dependencies.runtimes.map((dependency) => dependency.resourceRef),
    "runtime dependencies",
  );
  assertExactSet(
    resources.flatMap((resource) =>
      resource.kind === "Expert" ? resource.spec.plugins.map((plugin) => plugin.ref) : [],
    ),
    manifest.dependencies.plugins.map((dependency) => dependency.ref),
    "plugin dependencies",
  );
  for (const dependency of manifest.dependencies.capabilities) {
    if (
      !resourceRefs.has(dependency.resourceRef) ||
      !dependency.resourceRef.startsWith("capability:")
    ) {
      throw new Error(`Capability dependency has no matching resource: ${dependency.resourceRef}`);
    }
    const id = dependency.resourceRef.slice("capability:".length);
    const expectedRoot = `payloads/capabilities/${id}`;
    if (
      dependency.included !== (dependency.definition !== undefined) ||
      (dependency.definition !== undefined &&
        (dependency.kind !== dependency.definition.kind ||
          dependency.definitionFingerprint !== sha256(stableStringify(dependency.definition)))) ||
      (dependency.payloadRoot !== undefined && dependency.payloadRoot !== expectedRoot) ||
      (dependency.kind === "skill" &&
        dependency.included &&
        dependency.payloadRoot !== expectedRoot) ||
      (dependency.kind !== "skill" && dependency.payloadRoot !== undefined)
    ) {
      throw new Error(`Capability dependency metadata is inconsistent: ${dependency.resourceRef}`);
    }
    if (dependency.payloadRoot !== undefined && !hasFilesBelow(files, dependency.payloadRoot)) {
      throw new Error(`Capability payload is empty: ${dependency.resourceRef}`);
    }
  }
  for (const dependency of manifest.dependencies.contextStores) {
    if (
      !resourceRefs.has(dependency.resourceRef) ||
      !dependency.resourceRef.startsWith("context-store:")
    ) {
      throw new Error(`Context dependency has no matching resource: ${dependency.resourceRef}`);
    }
    const id = dependency.resourceRef.slice("context-store:".length);
    const expectedRoot = `payloads/context-stores/${id}`;
    if (
      dependency.included !== (dependency.payloadRoot === expectedRoot) ||
      (dependency.included && dependency.fingerprint === undefined)
    ) {
      throw new Error(`Context dependency metadata is inconsistent: ${dependency.resourceRef}`);
    }
    if (dependency.included && !hasFilesBelow(files, expectedRoot)) {
      throw new Error(`Context payload is empty: ${dependency.resourceRef}`);
    }
  }
  for (const dependency of manifest.dependencies.plugins) {
    const expectedRoot = `payloads/plugins/${sha256(dependency.ref)}`;
    if (
      dependency.included !== (dependency.payloadRoot === expectedRoot) ||
      (dependency.included &&
        (dependency.origin !== "user" ||
          dependency.contentHash === undefined ||
          dependency.manifest === undefined)) ||
      (dependency.manifest !== undefined &&
        `plugin:${dependency.manifest.id}@${dependency.manifest.version}` !== dependency.ref)
    ) {
      throw new Error(`Plugin dependency metadata is inconsistent: ${dependency.ref}`);
    }
    if (dependency.included && !hasFilesBelow(files, expectedRoot)) {
      throw new Error(`Plugin payload is empty: ${dependency.ref}`);
    }
  }

  const declaredPayloadRoots = [
    ...manifest.dependencies.capabilities.flatMap((item) =>
      item.payloadRoot === undefined ? [] : [item.payloadRoot],
    ),
    ...manifest.dependencies.contextStores.flatMap((item) =>
      item.payloadRoot === undefined ? [] : [item.payloadRoot],
    ),
    ...manifest.dependencies.plugins.flatMap((item) =>
      item.payloadRoot === undefined ? [] : [item.payloadRoot],
    ),
  ];
  for (const path of files.keys()) {
    if (
      path.startsWith("payloads/") &&
      !declaredPayloadRoots.some((rootPath) => path.startsWith(`${rootPath}/`))
    ) {
      throw new Error(`Bundle payload is not declared by the manifest: ${path}`);
    }
    if (path.startsWith("layouts/flows/")) {
      const match = /^layouts\/flows\/([0-9a-hjkmnp-tv-z]{16})\.json$/.exec(path);
      if (
        match === null ||
        !resources.some((resource) => resource.kind === "Flow" && resource.metadata.id === match[1])
      ) {
        throw new Error(`Bundle Flow layout has no matching Flow: ${path}`);
      }
    }
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`The bundle contains a duplicate ${label}.`);
  }
}

function assertExactSet(
  actual: readonly string[],
  declared: readonly string[],
  label: string,
): void {
  const actualSet = new Set(actual);
  const declaredSet = new Set(declared);
  if (
    actualSet.size !== declaredSet.size ||
    [...actualSet].some((value) => !declaredSet.has(value))
  ) {
    throw new Error(`The bundle ${label} do not match its resources.`);
  }
}

function hasFilesBelow(files: ReadonlyMap<string, Uint8Array>, root: string): boolean {
  return [...files.keys()].some((path) => path.startsWith(`${root}/`));
}

function normalizeArchivePath(path: string): string {
  const portable = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const isDirectory = portable.endsWith("/");
  const segments = portable.split("/");
  if (isDirectory) segments.pop();
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    portable.includes("\0") ||
    portable.startsWith("/") ||
    /^[a-z]:/i.test(portable)
  ) {
    throw new Error(`Unsafe bundle path: ${path}`);
  }
  return `${segments.join("/")}${isDirectory ? "/" : ""}`;
}

async function unzipArchive(
  raw: Uint8Array,
  options: AsyncUnzipOptions,
): Promise<Record<string, Uint8Array>> {
  return await new Promise((resolvePromise, reject) => {
    unzip(raw, options, (error, result) => {
      if (error !== null) reject(error);
      else resolvePromise(result);
    });
  });
}
