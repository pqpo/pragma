import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalAad,
  createSecretStore,
  type OsKeychain,
  type OsKeychainHealth,
} from "../src/index.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

class FakeKeychain implements OsKeychain {
  readonly values = new Map<string, Uint8Array>();
  setCalls = 0;
  health: OsKeychainHealth = { status: "ready", backend: "macos-keychain" };
  async inspect(): Promise<OsKeychainHealth> {
    return this.health;
  }
  async get(service: string, account: string): Promise<Uint8Array | null> {
    return this.values.get(`${service}/${account}`) ?? null;
  }
  async set(service: string, account: string, value: Uint8Array): Promise<void> {
    this.setCalls += 1;
    this.values.set(`${service}/${account}`, Uint8Array.from(value));
  }
  async delete(service: string, account: string): Promise<void> {
    this.values.delete(`${service}/${account}`);
  }
}

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "pragma-secret-store-"));
  directories.push(directory);
  const keychain = new FakeKeychain();
  return {
    directory,
    keychain,
    store: createSecretStore({ root: join(directory, "secret-store"), keychain }),
  };
}

describe("SecretStore", () => {
  it("uses AES-GCM envelopes and never persists plaintext or a master-key file", async () => {
    const { directory, store } = await createStore();
    const ref = await store.put({
      owner: { kind: "model-provider", providerId: "provider-1" },
      value: Buffer.from("top-secret"),
    });
    const value = await store.get(ref);
    expect(value.utf8()).toBe("top-secret");
    value.dispose();
    expect(() => value.utf8()).toThrow(/disposed/i);
    const tree = await readFile(
      join(
        directory,
        "secret-store",
        "refs",
        `${Buffer.from(ref.secretId).toString("base64url")}.json`,
      ),
      "utf8",
    );
    expect(tree).not.toContain("top-secret");
    expect(
      await readFile(
        join(
          directory,
          "secret-store",
          "objects",
          Buffer.from(ref.secretId).toString("base64url"),
          `${ref.revision}.json`,
        ),
        "utf8",
      ),
    ).not.toContain("top-secret");
  });

  it("enforces expectedRevision and detects AAD tampering without changing existing refs", async () => {
    const { directory, store } = await createStore();
    const ref = await store.put({
      owner: { kind: "plugin-binding", bindingRef: "binding:test" },
      value: Buffer.from("first"),
    });
    await expect(
      store.put({ owner: ref.owner, value: Buffer.from("second") }),
    ).rejects.toMatchObject({ code: "SECRET_REVISION_CONFLICT" });
    const objectPath = join(
      directory,
      "secret-store",
      "objects",
      Buffer.from(ref.secretId).toString("base64url"),
      `${ref.revision}.json`,
    );
    const object = JSON.parse(await readFile(objectPath, "utf8")) as Record<string, unknown>;
    await writeFile(objectPath, JSON.stringify({ ...object, aadHash: "sha256:00" }));
    await expectRedactedCorruption(
      () => store.get(ref),
      "never-in-error",
      object.ciphertext as string,
    );
    expect(
      await readFile(
        join(
          directory,
          "secret-store",
          "refs",
          `${Buffer.from(ref.secretId).toString("base64url")}.json`,
        ),
        "utf8",
      ),
    ).toContain(ref.revision);
  });

  it("maps locked and unavailable keychains without writing a fallback key", async () => {
    const { directory, keychain, store } = await createStore();
    keychain.health = {
      status: "locked",
      backend: "macos-keychain",
      reasonCode: "KEYCHAIN_ACCESS_DENIED",
    };
    await expect(
      store.put({
        owner: { kind: "capability", capabilityId: "cap", name: "token" },
        value: Buffer.from("secret"),
      }),
    ).rejects.toMatchObject({ code: "SECRET_STORE_LOCKED" });
    keychain.health = {
      status: "unavailable",
      backend: "macos-keychain",
      reasonCode: "KEYCHAIN_BACKEND_UNAVAILABLE",
    };
    await expect(
      store.put({
        owner: { kind: "capability", capabilityId: "cap", name: "token" },
        value: Buffer.from("secret"),
      }),
    ).rejects.toMatchObject({ code: "KEYCHAIN_UNAVAILABLE" });
    await expect(
      readFile(join(directory, "secret-store", "master-key"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses order-independent canonical AAD", () => {
    const owner = { kind: "capability" as const, capabilityId: "cap", name: "token" };
    expect(canonicalAad("id", owner, "home", "rev").toString("hex")).toBe(
      canonicalAad(
        "id",
        { name: "token", capabilityId: "cap", kind: "capability" },
        "home",
        "rev",
      ).toString("hex"),
    );
    expect(canonicalAad("id", owner, "home", "rev").toString("hex")).toBe(
      "32353a707261676d612e7365637265742d656e76656c6f70652f76317c323a69647c32303a6361706162696c6974793a6361703a746f6b656e7c343a686f6d657c313a317c333a7265767c31313a4145532d3235362d47434d",
    );
  });

  it("preserves existing evidence when the keychain master key is missing", async () => {
    const { directory, keychain, store } = await createStore();
    const ref = await store.put({
      owner: { kind: "plugin-binding", bindingRef: "binding:preserved" },
      value: Buffer.from("preserved-secret"),
    });
    const refPath = join(
      directory,
      "secret-store",
      "refs",
      `${Buffer.from(ref.secretId).toString("base64url")}.json`,
    );
    const objectPath = join(
      directory,
      "secret-store",
      "objects",
      Buffer.from(ref.secretId).toString("base64url"),
      `${ref.revision}.json`,
    );
    const before = await Promise.all([
      readFile(refPath, "utf8"),
      readFile(objectPath, "utf8"),
      readFile(join(directory, "secret-store", "manifest.json"), "utf8"),
    ]);
    keychain.values.clear();
    const setsBefore = keychain.setCalls;

    await expect(
      store.put({
        owner: { kind: "plugin-binding", bindingRef: "binding:new" },
        value: Buffer.from("new-secret"),
      }),
    ).rejects.toMatchObject({ code: "SECRET_MASTER_KEY_MISSING" });
    expect(keychain.setCalls).toBe(setsBefore);
    await expect(
      Promise.all([
        readFile(refPath, "utf8"),
        readFile(objectPath, "utf8"),
        readFile(join(directory, "secret-store", "manifest.json"), "utf8"),
      ]),
    ).resolves.toEqual(before);
  });

  it("allows first creation in a store that only contains the lock directory", async () => {
    const { directory, keychain } = await createStore();
    const root = join(directory, "secret-store");
    await mkdir(join(root, ".lock"), { recursive: true });
    const store = createSecretStore({ root, keychain });
    await expect(
      store.put({
        owner: { kind: "plugin-binding", bindingRef: "binding:first" },
        value: Buffer.from("first"),
      }),
    ).resolves.toMatchObject({ schemaVersion: "pragma.secret-ref/v1" });
  });

  it("rejects bad AES keys, auth tags, and future manifests without exposing plaintext", async () => {
    const { directory, keychain, store } = await createStore();
    const ref = await store.put({
      owner: { kind: "model-provider", providerId: "provider-auth" },
      value: Buffer.from("never-in-error"),
    });
    const objectPath = join(
      directory,
      "secret-store",
      "objects",
      Buffer.from(ref.secretId).toString("base64url"),
      `${ref.revision}.json`,
    );
    const object = JSON.parse(await readFile(objectPath, "utf8")) as Record<string, unknown>;
    keychain.values.forEach((_, key) =>
      keychain.values.set(
        key,
        Buffer.from(
          JSON.stringify({
            schemaVersion: "pragma.secret-master-key/v1",
            keyVersion: 1,
            algorithm: "AES-256-GCM",
            createdAt: new Date().toISOString(),
            key: Buffer.alloc(32, 8).toString("base64"),
          }),
        ),
      ),
    );
    await expectRedactedCorruption(
      () => store.get(ref),
      "never-in-error",
      object.ciphertext as string,
    );
    await writeFile(
      objectPath,
      JSON.stringify({ ...object, authTag: Buffer.alloc(16, 7).toString("base64") }),
    );
    await expect(store.get(ref)).rejects.toMatchObject({ code: "SECRET_STORE_CORRUPTED" });
    await writeFile(
      join(directory, "secret-store", "manifest.json"),
      JSON.stringify({
        schemaVersion: "pragma.secret-store/v2",
        algorithm: "AES-256-GCM",
        currentKeyVersion: 1,
        createdAt: new Date().toISOString(),
      }),
    );
    await expectRedactedCorruption(
      () => store.listMetadata(),
      "never-in-error",
      object.ciphertext as string,
    );
  });

  it("serializes concurrent writers and injects unique AES-GCM nonces", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-secret-store-"));
    directories.push(directory);
    const keychain = new FakeKeychain();
    let counter = 0;
    const store = createSecretStore({
      root: join(directory, "secret-store"),
      keychain,
      randomBytes: (size) => Buffer.alloc(size, counter++),
    });
    const writes = await Promise.allSettled([
      store.put({
        owner: { kind: "plugin-binding", bindingRef: "binding:race" },
        value: Buffer.from("one"),
      }),
      store.put({
        owner: { kind: "plugin-binding", bindingRef: "binding:race" },
        value: Buffer.from("two"),
      }),
    ]);
    expect(writes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(writes.filter((entry) => entry.status === "rejected")[0]).toMatchObject({
      reason: { code: "SECRET_REVISION_CONFLICT" },
    });
    const objectDirectory = join(directory, "secret-store", "objects");
    const secretId = writes.find(
      (entry): entry is PromiseFulfilledResult<{ secretId: string }> =>
        entry.status === "fulfilled",
    )!.value.secretId;
    const envelope = JSON.parse(
      await readFile(
        join(
          objectDirectory,
          Buffer.from(secretId).toString("base64url"),
          writes.find(
            (entry): entry is PromiseFulfilledResult<{ revision: string }> =>
              entry.status === "fulfilled",
          )!.value.revision + ".json",
        ),
        "utf8",
      ),
    ) as { nonce: string };
    expect(envelope.nonce).toBe(Buffer.alloc(12, 1).toString("base64"));
  });

  it("keeps two OS processes out of the SecretStore write critical section", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-secret-store-process-"));
    directories.push(root);
    const storeRoot = join(root, "secret-store");
    const timeline = join(root, "timeline.log");
    await mkdir(join(storeRoot, ".lock"), { recursive: true });
    const [first, second] = await Promise.all([
      invokeProcessWriter(storeRoot, timeline, "first"),
      invokeProcessWriter(storeRoot, timeline, "second"),
    ]);
    expect([first, second].filter((result) => result.status === "written")).toHaveLength(1);
    expect(
      [first, second].filter((result) => result.status === "SECRET_REVISION_CONFLICT"),
    ).toHaveLength(1);
    expect(await readFile(join(storeRoot, "manifest.json"), "utf8")).toContain(
      "pragma.secret-store/v1",
    );
    expect(await readFile(timeline, "utf8")).toMatch(
      /(?:first:start\nfirst:end\nsecond:start\nsecond:end|second:start\nsecond:end\nfirst:start\nfirst:end)\n?$/,
    );
    await expect(
      readFile(join(storeRoot, ".lock", "secret-store-write", "owner.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("rejects a future SecretRef schema before any decrypt attempt", async () => {
    const { directory, store } = await createStore();
    const ref = await store.put({
      owner: { kind: "plugin-binding", bindingRef: "binding:future-ref" },
      value: Buffer.from("not-exposed"),
    });
    await writeFile(
      join(
        directory,
        "secret-store",
        "refs",
        `${Buffer.from(ref.secretId).toString("base64url")}.json`,
      ),
      JSON.stringify({ ...ref, schemaVersion: "pragma.secret-ref/v2" }),
    );
    await expect(store.get(ref)).rejects.toMatchObject({ code: "SECRET_STORE_CORRUPTED" });
  });

  it("validates tombstones with the strict SecretRef-derived schema", async () => {
    const { directory, store } = await createStore();
    const ref = await store.put({
      owner: { kind: "plugin-binding", bindingRef: "binding:tombstone" },
      value: Buffer.from("tombstone-secret"),
    });
    await store.delete(ref, ref.revision);
    const path = join(
      directory,
      "secret-store",
      "refs",
      `${Buffer.from(ref.secretId).toString("base64url")}.json`,
    );
    const tombstone = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...tombstone, unexpected: true }));
    await expect(store.listMetadata()).rejects.toMatchObject({ code: "SECRET_STORE_CORRUPTED" });
    await writeFile(path, JSON.stringify({ ...tombstone, deletedAt: "not-an-iso-time" }));
    await expect(store.listMetadata()).rejects.toMatchObject({ code: "SECRET_STORE_CORRUPTED" });
  });
});

async function expectRedactedCorruption(
  operation: () => Promise<unknown>,
  plaintext: string,
  ciphertext: string,
): Promise<void> {
  try {
    await operation();
    throw new Error("Expected a corrupted SecretStore rejection.");
  } catch (error) {
    expect(error).toMatchObject({ code: "SECRET_STORE_CORRUPTED" });
    const serialized = `${(error as Error).message}${JSON.stringify(error)}`;
    expect(serialized).not.toContain(plaintext);
    expect(serialized).not.toContain(ciphertext);
    expect(serialized).not.toContain("home:");
  }
}

function invokeProcessWriter(
  root: string,
  timeline: string,
  id: string,
): Promise<{ readonly status: "written" | "SECRET_REVISION_CONFLICT" }> {
  const sourceUrl = new URL("../src/index.ts", import.meta.url).href;
  const program = `
    import { appendFile } from "node:fs/promises";
    const { createSecretStore } = await import(process.env.PRAGMA_TEST_LOCAL_HOST_URL);
    const master = Buffer.from(JSON.stringify({ schemaVersion: "pragma.secret-master-key/v1", keyVersion: 1, algorithm: "AES-256-GCM", createdAt: "2026-01-01T00:00:00.000Z", key: Buffer.alloc(32, 9).toString("base64") }));
    const keychain = {
      inspect: async () => ({ status: "ready", backend: "macos-keychain" }),
      get: async () => { await appendFile(process.env.PRAGMA_TEST_TIMELINE, process.env.PRAGMA_TEST_WRITER + ":start\\n"); await new Promise((resolve) => setTimeout(resolve, 100)); await appendFile(process.env.PRAGMA_TEST_TIMELINE, process.env.PRAGMA_TEST_WRITER + ":end\\n"); return master; },
      set: async () => undefined,
      delete: async () => undefined,
    };
    try {
      await createSecretStore({ root: process.env.PRAGMA_TEST_SECRET_ROOT, keychain }).put({ owner: { kind: "plugin-binding", bindingRef: "binding:process-race" }, value: Buffer.from(process.env.PRAGMA_TEST_WRITER) });
      process.stdout.write(JSON.stringify({ status: "written" }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ status: error.code }));
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-transform-types", "--input-type=module", "--eval", program],
      {
        cwd: new URL("../../..", import.meta.url).pathname,
        env: {
          ...process.env,
          PRAGMA_TEST_LOCAL_HOST_URL: sourceUrl,
          PRAGMA_TEST_SECRET_ROOT: root,
          PRAGMA_TEST_TIMELINE: timeline,
          PRAGMA_TEST_WRITER: id,
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`process writer failed: ${stderr}`));
      else
        resolve(JSON.parse(stdout) as { readonly status: "written" | "SECRET_REVISION_CONFLICT" });
    });
  });
}
