import { createHash, randomUUID } from "node:crypto";
import { copyFile, link, mkdir, open, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const TREE_SCHEMA = "pragma.cas-tree/v1" as const;

export type ContentObjectKind = "blob" | "tree";

export interface ContentObjectRef {
  readonly kind: ContentObjectKind;
  readonly hash: string;
}

export interface ContentTreeEntry {
  readonly name: string;
  readonly kind: ContentObjectKind;
  readonly hash: string;
  readonly size: number;
  readonly mode: 0o644 | 0o755;
}

export interface ContentTree {
  readonly schemaVersion: typeof TREE_SCHEMA;
  readonly entries: readonly ContentTreeEntry[];
}

export interface ContentSnapshot {
  readonly root: ContentObjectRef & { readonly kind: "tree" };
  readonly fileCount: number;
  readonly logicalBytes: number;
}

export interface ContentGarbageCollectionResult {
  readonly reachableObjects: number;
  readonly deletedObjects: number;
  readonly reclaimedBytes: number;
}

interface MutableDirectory {
  readonly files: Map<string, { readonly bytes: Uint8Array; readonly mode: 0o644 | 0o755 }>;
  readonly directories: Map<string, MutableDirectory>;
}

export class ContentAddressedStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async putBlob(bytes: Uint8Array): Promise<ContentObjectRef & { readonly kind: "blob" }> {
    const hash = objectHash("blob", bytes);
    await this.writeObject({ kind: "blob", hash }, bytes);
    return { kind: "blob", hash };
  }

  async putTree(
    entries: readonly ContentTreeEntry[],
  ): Promise<ContentObjectRef & { readonly kind: "tree" }> {
    const normalized = entries
      .map(validateTreeEntry)
      .toSorted((left, right) => left.name.localeCompare(right.name));
    for (let index = 1; index < normalized.length; index += 1) {
      if (normalized[index - 1]?.name === normalized[index]?.name) {
        throw new Error(`Duplicate content tree entry: ${normalized[index]?.name}`);
      }
    }
    const bytes = Buffer.from(
      `${JSON.stringify({ schemaVersion: TREE_SCHEMA, entries: normalized })}\n`,
      "utf8",
    );
    const hash = objectHash("tree", bytes);
    await this.writeObject({ kind: "tree", hash }, bytes);
    return { kind: "tree", hash };
  }

  async putSnapshot(
    files: ReadonlyMap<
      string,
      Uint8Array | { readonly bytes: Uint8Array; readonly executable?: boolean | undefined }
    >,
  ): Promise<ContentSnapshot> {
    const root: MutableDirectory = { files: new Map(), directories: new Map() };
    let logicalBytes = 0;
    for (const [path, value] of files) {
      const segments = validateRelativeFilePath(path);
      const bytes = value instanceof Uint8Array ? value : value.bytes;
      const mode = value instanceof Uint8Array || value.executable !== true ? 0o644 : 0o755;
      logicalBytes += bytes.byteLength;
      let directory = root;
      for (const segment of segments.slice(0, -1)) {
        const existing = directory.directories.get(segment);
        if (existing !== undefined) {
          directory = existing;
          continue;
        }
        const created: MutableDirectory = { files: new Map(), directories: new Map() };
        directory.directories.set(segment, created);
        directory = created;
      }
      const name = segments.at(-1)!;
      if (directory.files.has(name) || directory.directories.has(name)) {
        throw new Error(`Duplicate content snapshot path: ${path}`);
      }
      directory.files.set(name, { bytes, mode });
    }
    const tree = await this.putDirectory(root);
    return { root: tree, fileCount: files.size, logicalBytes };
  }

  async readBlob(hash: string): Promise<Uint8Array> {
    const bytes = await readFile(this.objectPath({ kind: "blob", hash: validateHash(hash) }));
    assertObjectHash("blob", hash, bytes);
    return bytes;
  }

  async readTree(hash: string): Promise<ContentTree> {
    const bytes = await readFile(this.objectPath({ kind: "tree", hash: validateHash(hash) }));
    assertObjectHash("tree", hash, bytes);
    const parsed = JSON.parse(bytes.toString("utf8")) as Partial<ContentTree>;
    if (parsed.schemaVersion !== TREE_SCHEMA || !Array.isArray(parsed.entries)) {
      throw new Error(`Invalid content tree object: ${hash}`);
    }
    return {
      schemaVersion: TREE_SCHEMA,
      entries: parsed.entries.map(validateTreeEntry),
    };
  }

  async materializeTree(
    hash: string,
    targetRoot: string,
    options: { readonly touchObjects?: boolean | undefined } = {},
  ): Promise<void> {
    await mkdir(targetRoot, { recursive: true, mode: 0o700 });
    await this.materializeDirectory(validateHash(hash), resolve(targetRoot), options.touchObjects);
  }

  async collectGarbage(input: {
    readonly roots: readonly (ContentObjectRef & { readonly kind: "tree" })[];
    readonly graceMs: number;
    readonly now?: number | undefined;
  }): Promise<ContentGarbageCollectionResult> {
    const reachable = new Set<string>();
    const visit = async (reference: ContentObjectRef): Promise<void> => {
      const key = objectKey(reference);
      if (reachable.has(key)) return;
      reachable.add(key);
      if (reference.kind !== "tree") return;
      const tree = await this.readTree(reference.hash);
      for (const entry of tree.entries) {
        await visit({ kind: entry.kind, hash: entry.hash });
      }
    };
    for (const root of input.roots) await visit(root);

    const now = input.now ?? Date.now();
    let deletedObjects = 0;
    let reclaimedBytes = 0;
    for (const path of await this.listObjectPaths()) {
      const name = path.split(sep).at(-1)!;
      const match = /^([a-f0-9]{64})\.(blob|tree)$/.exec(name);
      if (match === null) continue;
      const reference = { hash: match[1]!, kind: match[2]! as ContentObjectKind };
      if (reachable.has(objectKey(reference))) continue;
      const metadata = await stat(path);
      if (now - metadata.mtimeMs < input.graceMs) continue;
      await rm(path, { force: true });
      deletedObjects += 1;
      reclaimedBytes += metadata.size;
    }
    return { reachableObjects: reachable.size, deletedObjects, reclaimedBytes };
  }

  objectPath(reference: ContentObjectRef): string {
    const hash = validateHash(reference.hash);
    return join(this.root, hash.slice(0, 2), `${hash}.${reference.kind}`);
  }

  private async putDirectory(
    directory: MutableDirectory,
  ): Promise<ContentObjectRef & { readonly kind: "tree" }> {
    const entries: ContentTreeEntry[] = [];
    for (const [name, file] of directory.files) {
      const blob = await this.putBlob(file.bytes);
      entries.push({ name, ...blob, size: file.bytes.byteLength, mode: file.mode });
    }
    for (const [name, child] of directory.directories) {
      const tree = await this.putDirectory(child);
      const bytes = await stat(this.objectPath(tree));
      entries.push({ name, ...tree, size: bytes.size, mode: 0o755 });
    }
    return await this.putTree(entries);
  }

  private async writeObject(reference: ContentObjectRef, bytes: Uint8Array): Promise<void> {
    const path = this.objectPath(reference);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.chmod(0o400);
      await handle.close();
      handle = undefined;
      try {
        await link(temporary, path);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const existing = await readFile(path);
        assertObjectHash(reference.kind, reference.hash, existing);
      }
    } finally {
      try {
        await handle?.close();
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }

  private async materializeDirectory(
    treeHash: string,
    targetRoot: string,
    touchObjects: boolean | undefined,
  ): Promise<void> {
    const tree = await this.readTree(treeHash);
    for (const entry of tree.entries) {
      const target = join(targetRoot, entry.name);
      if (entry.kind === "tree") {
        await mkdir(target, { recursive: true, mode: 0o700 });
        await this.materializeDirectory(entry.hash, target, touchObjects);
        continue;
      }
      const source = this.objectPath(entry);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      if (entry.mode === 0o755) {
        await copyFile(source, target);
        const handle = await open(target, "r+");
        try {
          await handle.chmod(0o755);
        } finally {
          await handle.close();
        }
      } else {
        try {
          await link(source, target);
        } catch (error) {
          if (!isCrossDeviceOrUnsupported(error)) throw error;
          await copyFile(source, target);
        }
      }
      if (touchObjects === true) {
        const now = new Date();
        await utimes(source, now, now);
      }
    }
  }

  private async listObjectPaths(): Promise<string[]> {
    const paths: string[] = [];
    let prefixes;
    try {
      prefixes = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    for (const prefix of prefixes) {
      if (!prefix.isDirectory()) continue;
      const directory = join(this.root, prefix.name);
      for (const object of await readdir(directory, { withFileTypes: true })) {
        if (object.isFile()) paths.push(join(directory, object.name));
      }
    }
    return paths;
  }
}

function objectHash(kind: ContentObjectKind, bytes: Uint8Array): string {
  return createHash("sha256").update(`pragma.cas/v1\0${kind}\0`).update(bytes).digest("hex");
}

function assertObjectHash(kind: ContentObjectKind, expected: string, bytes: Uint8Array): void {
  const actual = objectHash(kind, bytes);
  if (actual !== expected) {
    throw new Error(`Content object hash mismatch: expected ${expected}, got ${actual}.`);
  }
}

function objectKey(reference: ContentObjectRef): string {
  return `${reference.kind}:${validateHash(reference.hash)}`;
}

function validateHash(hash: string): string {
  if (!HASH_PATTERN.test(hash)) throw new Error(`Invalid SHA-256 content hash: ${hash}.`);
  return hash;
}

function validateTreeEntry(entry: ContentTreeEntry): ContentTreeEntry {
  if (
    typeof entry !== "object" ||
    entry === null ||
    typeof entry.name !== "string" ||
    entry.name.length === 0 ||
    entry.name.includes("/") ||
    entry.name === "." ||
    entry.name === ".." ||
    (entry.kind !== "blob" && entry.kind !== "tree") ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    (entry.mode !== 0o644 && entry.mode !== 0o755)
  ) {
    throw new Error("Invalid content tree entry.");
  }
  return { ...entry, hash: validateHash(entry.hash) };
}

function validateRelativeFilePath(path: string): string[] {
  if (path.trim() === "" || path.includes("\\") || posix.isAbsolute(path)) {
    throw new Error(`Invalid content snapshot path: ${path}`);
  }
  const normalized = posix.normalize(path);
  if (normalized !== path || normalized.startsWith("../") || normalized === "..") {
    throw new Error(`Content snapshot path escapes its root: ${path}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Invalid content snapshot path: ${path}`);
  }
  return segments;
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isCrossDeviceOrUnsupported(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EXDEV" || code === "EPERM" || code === "EACCES" || code === "ENOTSUP";
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}
