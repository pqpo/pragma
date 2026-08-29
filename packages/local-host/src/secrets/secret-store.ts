import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes as cryptoRandomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { encodePragmaPathSegment, withFileLock } from "@pragma/core";
import {
  IsoDateTimeSchema,
  SecretRefSchema,
  type SecretRef as SharedSecretRef,
} from "@pragma/shared/integration";

export const SECRET_STORE_SERVICE = "com.pqpo.pragma.secret-store";
const MASTER_KEY_SCHEMA = "pragma.secret-master-key/v1";
const ENVELOPE_SCHEMA = "pragma.secret-envelope/v1";
const REF_SCHEMA = "pragma.secret-ref/v1";
const STORE_SCHEMA = "pragma.secret-store/v1";
const TombstoneSchema = SecretRefSchema.extend({ deletedAt: IsoDateTimeSchema }).strict();

export type SecretOwner = SharedSecretRef["owner"];
export type SecretRef = SharedSecretRef;

interface Envelope {
  readonly schemaVersion: typeof ENVELOPE_SCHEMA;
  readonly secretId: string;
  readonly owner: SecretOwner;
  readonly revision: string;
  readonly algorithm: "AES-256-GCM";
  readonly keyVersion: 1;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authTag: string;
  readonly aadHash: string;
  readonly createdAt: string;
}

export interface OsKeychainHealth {
  readonly status: "ready" | "locked" | "unavailable";
  readonly backend: "macos-keychain" | "windows-credential-manager" | "unsupported";
  readonly reasonCode?: string | undefined;
}

/** Port failures must expose a health status so Host callers never depend on native adapter errors. */
export interface OsKeychain {
  inspect(): Promise<OsKeychainHealth>;
  get(service: string, account: string): Promise<Uint8Array | null>;
  set(service: string, account: string, value: Uint8Array): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

export interface LegacyCredentialDecryptor {
  readonly kind: "electron-safe-storage";
  isAvailable(): boolean;
  decrypt(ciphertext: Uint8Array): Uint8Array;
}

export interface SecretValueHandle {
  readonly bytes: () => Uint8Array;
  readonly utf8: () => string;
  dispose(): void;
}

export interface SecretStoreHealth {
  readonly status: "ready" | "locked" | "unavailable" | "migration_required";
  readonly backend: OsKeychainHealth["backend"];
  readonly reasonCode?: string | undefined;
}

export interface SecretStore {
  inspect(): Promise<SecretStoreHealth>;
  get(ref: SecretRef): Promise<SecretValueHandle>;
  put(input: {
    readonly owner: SecretOwner;
    readonly value: Uint8Array;
    readonly expectedRevision?: string;
  }): Promise<SecretRef>;
  delete(ref: SecretRef, expectedRevision: string): Promise<void>;
  listMetadata(filter?: Partial<SecretOwner>): Promise<readonly SecretRef[]>;
}

export class SecretStoreError extends Error {
  constructor(
    readonly code:
      | "KEYCHAIN_UNAVAILABLE"
      | "SECRET_STORE_LOCKED"
      | "SECRET_MASTER_KEY_MISSING"
      | "SECRET_NOT_FOUND"
      | "SECRET_REVISION_CONFLICT"
      | "SECRET_STORE_CORRUPTED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SecretStoreError";
  }
}

export function createSecretStore(options: {
  readonly root: string;
  /** Canonical Pragma data root. Both Desktop and CLI must provide the same value. */
  readonly dataRoot?: string | undefined;
  readonly keychain: OsKeychain;
  readonly installNamespace?: string | undefined;
  /** Test seam for nonce uniqueness assertions; production uses the Node CSPRNG. */
  readonly randomBytes?: ((size: number) => Uint8Array) | undefined;
}): SecretStore {
  const root = resolve(options.root);
  const dataRoot = resolve(options.dataRoot ?? dirname(dirname(root)));
  const homeId = sha256(`${dataRoot}\u0000${options.installNamespace ?? "default"}`);
  const account = `home:${homeId}:master-key:v1`;
  const refsRoot = join(root, "refs");
  const objectsRoot = join(root, "objects");
  // `.lock` is a durable, permission-hardened parent. Each acquisition gets a
  // child directory managed exclusively by withFileLock; never remove it outside
  // that protocol, otherwise another process can lose a just-created generation.
  const lockRoot = join(root, ".lock");
  const lock = join(lockRoot, "secret-store-write");
  const random = options.randomBytes ?? cryptoRandomBytes;

  const health = async (): Promise<SecretStoreHealth> => {
    try {
      const inspected = await options.keychain.inspect();
      return inspected.status === "ready"
        ? { status: "ready", backend: inspected.backend }
        : {
            status: inspected.status,
            backend: inspected.backend,
            reasonCode: inspected.reasonCode,
          };
    } catch {
      return {
        status: "unavailable",
        backend: "unsupported",
        reasonCode: "KEYCHAIN_BACKEND_UNAVAILABLE",
      };
    }
  };

  const requireMasterKey = async (create: boolean): Promise<Uint8Array> => {
    const inspected = await health();
    throwForHealth(inspected);
    const existing = await keychainCall(() => options.keychain.get(SECRET_STORE_SERVICE, account));
    if (existing !== null) return decodeMasterKey(existing);
    if (!create || (await hasPersistentEvidence())) {
      throw new SecretStoreError(
        "SECRET_MASTER_KEY_MISSING",
        "The OS keychain master key is missing; existing secret envelopes were preserved.",
      );
    }
    const key = requireRandom(random(32), 32);
    const encoded = Buffer.from(
      JSON.stringify({
        schemaVersion: MASTER_KEY_SCHEMA,
        keyVersion: 1,
        algorithm: "AES-256-GCM",
        createdAt: new Date().toISOString(),
        key: Buffer.from(key).toString("base64"),
      }),
      "utf8",
    );
    await keychainCall(
      async () => await options.keychain.set(SECRET_STORE_SERVICE, account, encoded),
    );
    return key;
  };

  return {
    inspect: health,
    async get(ref) {
      assertRef(ref);
      await validateManifest();
      const key = await requireMasterKey(false);
      const current = await readRef(ref.secretId);
      if (current === undefined)
        throw new SecretStoreError(
          "SECRET_NOT_FOUND",
          "The requested secret metadata does not exist.",
        );
      if (!sameOwner(current.owner, ref.owner) || current.revision !== ref.revision) {
        throw new SecretStoreError(
          "SECRET_REVISION_CONFLICT",
          "The requested secret reference is stale.",
        );
      }
      const envelope = await readEnvelope(ref.secretId, ref.revision);
      return createSecretValueHandle(decryptEnvelope(envelope, key, homeId));
    },
    async put(input) {
      assertOwner(input.owner);
      if (input.value.length === 0)
        throw new SecretStoreError("SECRET_STORE_CORRUPTED", "An empty secret cannot be stored.");
      await hardenDirectory(root);
      await hardenDirectory(lockRoot);
      return await withFileLock(
        lock,
        async () => {
          await hardenLock(lock);
          await validateManifest();
          const key = await requireMasterKey(true);
          const current = await findByOwner(input.owner);
          if (
            input.expectedRevision !== undefined &&
            current?.revision !== input.expectedRevision
          ) {
            throw new SecretStoreError(
              "SECRET_REVISION_CONFLICT",
              "The secret changed before the requested update.",
            );
          }
          if (input.expectedRevision === undefined && current !== undefined) {
            throw new SecretStoreError(
              "SECRET_REVISION_CONFLICT",
              "Updating an existing secret requires expectedRevision.",
            );
          }
          const secretId = current?.secretId ?? randomUUID();
          const revision = randomUUID();
          const envelope = encryptEnvelope({
            secretId,
            owner: input.owner,
            revision,
            value: input.value,
            key,
            homeId,
            random,
          });
          await writeAtomic(
            join(objectsRoot, encodePragmaPathSegment(secretId), `${revision}.json`),
            envelope,
          );
          const nextRef: SecretRef = SecretRefSchema.parse({
            schemaVersion: REF_SCHEMA,
            secretId,
            owner: input.owner,
            revision,
          });
          await writeAtomic(join(refsRoot, `${encodePragmaPathSegment(secretId)}.json`), nextRef);
          await writeAtomic(join(root, "manifest.json"), {
            schemaVersion: STORE_SCHEMA,
            algorithm: "AES-256-GCM",
            currentKeyVersion: 1,
            createdAt: new Date().toISOString(),
          });
          return nextRef;
        },
        { operation: "secret-store.put" },
      );
    },
    async delete(ref, expectedRevision) {
      assertRef(ref);
      await hardenDirectory(root);
      await hardenDirectory(lockRoot);
      await withFileLock(
        lock,
        async () => {
          await hardenLock(lock);
          await validateManifest();
          const current = await readRef(ref.secretId);
          if (current === undefined)
            throw new SecretStoreError(
              "SECRET_NOT_FOUND",
              "The requested secret metadata does not exist.",
            );
          if (current.revision !== expectedRevision || expectedRevision !== ref.revision) {
            throw new SecretStoreError(
              "SECRET_REVISION_CONFLICT",
              "The secret changed before deletion.",
            );
          }
          await writeAtomic(join(refsRoot, `${encodePragmaPathSegment(ref.secretId)}.json`), {
            ...current,
            deletedAt: new Date().toISOString(),
          });
        },
        { operation: "secret-store.delete" },
      );
    },
    async listMetadata(filter = {}) {
      await validateManifest();
      try {
        const result = await Promise.all(
          (await readdir(refsRoot))
            .filter((name) => name.endsWith(".json"))
            .map(async (name) => await readRefFile(join(refsRoot, name))),
        );
        return result.filter(
          (ref): ref is SecretRef => ref !== undefined && ownerMatches(ref.owner, filter),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
  };

  async function validateManifest(): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new SecretStoreError("SECRET_STORE_CORRUPTED", "Secret store manifest is invalid.", {
        cause: error,
      });
    }
    assertManifest(value);
  }
  async function hasPersistentEvidence(): Promise<boolean> {
    return (
      (await hasFiles(refsRoot)) ||
      (await hasFiles(objectsRoot)) ||
      (await pathExists(join(root, "manifest.json")))
    );
  }
  async function readRef(secretId: string): Promise<SecretRef | undefined> {
    return await readRefFile(join(refsRoot, `${encodePragmaPathSegment(secretId)}.json`));
  }
  async function readRefFile(path: string): Promise<SecretRef | undefined> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (isTombstone(parsed)) {
        assertTombstone(parsed);
        return undefined;
      }
      return SecretRefSchema.parse(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new SecretStoreError("SECRET_STORE_CORRUPTED", "Secret metadata is invalid.", {
        cause: error,
      });
    }
  }
  async function findByOwner(owner: SecretOwner): Promise<SecretRef | undefined> {
    try {
      const refs = await Promise.all(
        (await readdir(refsRoot))
          .filter((entry) => entry.endsWith(".json"))
          .map(async (entry) => await readRefFile(join(refsRoot, entry))),
      );
      return refs.find((ref): ref is SecretRef => ref !== undefined && sameOwner(ref.owner, owner));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async function readEnvelope(secretId: string, revision: string): Promise<Envelope> {
    try {
      const parsed = JSON.parse(
        await readFile(
          join(objectsRoot, encodePragmaPathSegment(secretId), `${revision}.json`),
          "utf8",
        ),
      ) as unknown;
      assertEnvelope(parsed);
      return parsed;
    } catch (error) {
      throw new SecretStoreError("SECRET_STORE_CORRUPTED", "Secret envelope is invalid.", {
        cause: error,
      });
    }
  }
}

function encryptEnvelope(input: {
  readonly secretId: string;
  readonly owner: SecretOwner;
  readonly revision: string;
  readonly value: Uint8Array;
  readonly key: Uint8Array;
  readonly homeId: string;
  readonly random: (size: number) => Uint8Array;
}): Envelope {
  const nonce = requireRandom(input.random(12), 12);
  const aad = canonicalAad(input.secretId, input.owner, input.homeId, input.revision);
  const cipher = createCipheriv("aes-256-gcm", input.key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(input.value), cipher.final()]);
  return {
    schemaVersion: ENVELOPE_SCHEMA,
    secretId: input.secretId,
    owner: input.owner,
    revision: input.revision,
    algorithm: "AES-256-GCM",
    keyVersion: 1,
    nonce: Buffer.from(nonce).toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    aadHash: `sha256:${sha256(aad)}`,
    createdAt: new Date().toISOString(),
  };
}

function decryptEnvelope(envelope: Envelope, key: Uint8Array, homeId: string): Uint8Array {
  const aad = canonicalAad(envelope.secretId, envelope.owner, homeId, envelope.revision);
  const expected = Buffer.from(sha256(aad), "hex");
  const actual = Buffer.from(envelope.aadHash.replace("sha256:", ""), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new SecretStoreError(
      "SECRET_STORE_CORRUPTED",
      "Secret envelope AAD verification failed.",
    );
  try {
    const nonce = Buffer.from(envelope.nonce, "base64");
    const tag = Buffer.from(envelope.authTag, "base64");
    if (nonce.length !== 12 || tag.length !== 16) throw new Error("Invalid AES-GCM parameters.");
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Uint8Array.from(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]),
    );
  } catch (error) {
    throw new SecretStoreError("SECRET_STORE_CORRUPTED", "Secret envelope authentication failed.", {
      cause: error,
    });
  }
}

export function canonicalAad(
  secretId: string,
  owner: SecretOwner,
  homeId: string,
  revision: string,
): Buffer {
  return Buffer.from(
    [ENVELOPE_SCHEMA, secretId, canonicalOwner(owner), homeId, "1", revision, "AES-256-GCM"]
      .map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`)
      .join("|"),
    "utf8",
  );
}
export function canonicalOwner(owner: SecretOwner): string {
  assertOwner(owner);
  return owner.kind === "model-provider"
    ? `model-provider:${owner.providerId}`
    : owner.kind === "capability"
      ? `capability:${owner.capabilityId}:${owner.name}`
      : `plugin-binding:${owner.bindingRef}`;
}
export function sameOwner(left: SecretOwner, right: SecretOwner): boolean {
  return canonicalOwner(left) === canonicalOwner(right);
}
function ownerMatches(owner: SecretOwner, filter: Partial<SecretOwner>): boolean {
  return Object.entries(filter).every(([key, value]) => owner[key as keyof SecretOwner] === value);
}
function assertOwner(owner: unknown): asserts owner is SecretOwner {
  try {
    SecretRefSchema.shape.owner.parse(owner);
  } catch (error) {
    throw new SecretStoreError("SECRET_STORE_CORRUPTED", "Secret owner is invalid.", {
      cause: error,
    });
  }
}
function assertRef(ref: unknown): asserts ref is SecretRef {
  try {
    SecretRefSchema.parse(ref);
  } catch (error) {
    throw new SecretStoreError("SECRET_STORE_CORRUPTED", "Secret reference is invalid.", {
      cause: error,
    });
  }
}
function isTombstone(value: unknown): value is { readonly deletedAt: unknown } {
  return typeof value === "object" && value !== null && "deletedAt" in value;
}
function assertTombstone(value: unknown): void {
  try {
    TombstoneSchema.parse(value);
  } catch (error) {
    throw new SecretStoreError("SECRET_STORE_CORRUPTED", "Secret tombstone is invalid.", {
      cause: error,
    });
  }
}
function assertManifest(value: unknown): void {
  if (typeof value !== "object" || value === null)
    throw new SecretStoreError("SECRET_STORE_CORRUPTED", "Secret store manifest is invalid.");
  const manifest = value as Record<string, unknown>;
  if (
    manifest.schemaVersion !== STORE_SCHEMA ||
    manifest.algorithm !== "AES-256-GCM" ||
    manifest.currentKeyVersion !== 1 ||
    typeof manifest.createdAt !== "string" ||
    Number.isNaN(Date.parse(manifest.createdAt)) ||
    Object.keys(manifest).length !== 4
  )
    throw new SecretStoreError("SECRET_STORE_CORRUPTED", "Secret store manifest is invalid.");
}
function assertEnvelope(value: unknown): asserts value is Envelope {
  if (typeof value !== "object" || value === null)
    throw new SecretStoreError("SECRET_STORE_CORRUPTED", "Secret envelope is invalid.");
  const envelope = value as Record<string, unknown>;
  if (
    envelope.schemaVersion !== ENVELOPE_SCHEMA ||
    envelope.algorithm !== "AES-256-GCM" ||
    envelope.keyVersion !== 1 ||
    typeof envelope.secretId !== "string" ||
    typeof envelope.revision !== "string" ||
    typeof envelope.nonce !== "string" ||
    typeof envelope.ciphertext !== "string" ||
    typeof envelope.authTag !== "string" ||
    typeof envelope.aadHash !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(envelope.aadHash) ||
    typeof envelope.createdAt !== "string" ||
    Object.keys(envelope).length !== 11
  )
    throw new SecretStoreError("SECRET_STORE_CORRUPTED", "Secret envelope is invalid.");
  assertRef({
    schemaVersion: REF_SCHEMA,
    secretId: envelope.secretId,
    owner: envelope.owner,
    revision: envelope.revision,
  });
  if (
    Buffer.from(envelope.nonce, "base64").length !== 12 ||
    Buffer.from(envelope.authTag, "base64").length !== 16
  )
    throw new SecretStoreError("SECRET_STORE_CORRUPTED", "Secret envelope is invalid.");
}
function decodeMasterKey(value: Uint8Array): Uint8Array {
  try {
    const parsed = JSON.parse(Buffer.from(value).toString("utf8")) as {
      schemaVersion?: unknown;
      key?: unknown;
      keyVersion?: unknown;
      algorithm?: unknown;
    };
    const key = typeof parsed.key === "string" ? Buffer.from(parsed.key, "base64") : undefined;
    if (
      parsed.schemaVersion !== MASTER_KEY_SCHEMA ||
      parsed.keyVersion !== 1 ||
      parsed.algorithm !== "AES-256-GCM" ||
      key?.length !== 32
    )
      throw new Error();
    return Uint8Array.from(key);
  } catch {
    throw new SecretStoreError(
      "SECRET_STORE_CORRUPTED",
      "The OS keychain master key record is invalid.",
    );
  }
}
function createSecretValueHandle(value: Uint8Array): SecretValueHandle {
  let current: Uint8Array | undefined = value;
  const require = () => {
    if (current === undefined)
      throw new SecretStoreError("SECRET_STORE_CORRUPTED", "The secret value handle was disposed.");
    return current;
  };
  return {
    bytes: () => Uint8Array.from(require()),
    utf8: () => Buffer.from(require()).toString("utf8"),
    dispose: () => {
      current?.fill(0);
      current = undefined;
    },
  };
}
function throwForHealth(health: SecretStoreHealth): void {
  if (health.status === "locked")
    throw new SecretStoreError(
      "SECRET_STORE_LOCKED",
      "The OS keychain is locked or access was denied.",
    );
  if (health.status !== "ready")
    throw new SecretStoreError("KEYCHAIN_UNAVAILABLE", "The OS keychain is unavailable.");
}
async function keychainCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SecretStoreError) throw error;
    const health = (error as { health?: OsKeychainHealth }).health;
    if (health?.status === "locked")
      throw new SecretStoreError(
        "SECRET_STORE_LOCKED",
        "The OS keychain is locked or access was denied.",
        { cause: error },
      );
    throw new SecretStoreError("KEYCHAIN_UNAVAILABLE", "The OS keychain is unavailable.", {
      cause: error,
    });
  }
}
function requireRandom(value: Uint8Array, size: number): Uint8Array {
  if (value.length !== size)
    throw new SecretStoreError(
      "SECRET_STORE_CORRUPTED",
      "Secure random source returned an invalid length.",
    );
  return Uint8Array.from(value);
}
async function writeAtomic(path: string, value: unknown): Promise<void> {
  await hardenDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
    await hardenFile(path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await file?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
async function hardenDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  try {
    await chmod(path, 0o700);
    const metadata = await stat(path);
    if ((metadata.mode & 0o777) !== 0o700) throw new Error("directory permissions are not private");
  } catch (error) {
    throw new SecretStoreError(
      "SECRET_STORE_CORRUPTED",
      "Secret store directory permissions could not be hardened.",
      { cause: error },
    );
  }
}
async function hardenFile(path: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(path, 0o600);
    const metadata = await stat(path);
    if ((metadata.mode & 0o777) !== 0o600) throw new Error("file permissions are not private");
  } catch (error) {
    throw new SecretStoreError(
      "SECRET_STORE_CORRUPTED",
      "Secret store file permissions could not be hardened.",
      { cause: error },
    );
  }
}
async function hardenLock(path: string): Promise<void> {
  await hardenDirectory(path);
  await hardenFile(join(path, "owner.json"));
}
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function hasFiles(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
