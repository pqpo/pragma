import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestSecretStore } from "./test-secret-store.ts";
import { migrateLegacyCredentialAggregate } from "./legacy-credential-migration.ts";

const roots: string[] = [];
afterEach(
  async () =>
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

const decryptor = {
  kind: "electron-safe-storage" as const,
  isAvailable: () => true,
  decrypt: (ciphertext: Uint8Array) => {
    const value = Buffer.from(ciphertext).toString("utf8");
    if (!value.startsWith("safe:")) throw new Error("legacy ciphertext is corrupted");
    return Buffer.from(value.slice("safe:".length));
  },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pragma-credential-migration-"));
  roots.push(root);
  const configPath = join(root, "credentials.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      credentials: { "owner/token": Buffer.from("safe:actual-secret").toString("base64") },
    }),
  );
  return { root, configPath, ...createTestSecretStore(join(root, "secret-store")) };
}

function migrate(input: Awaited<ReturnType<typeof fixture>>, onStage?: (stage: string) => void) {
  return migrateLegacyCredentialAggregate({
    configPath: input.configPath,
    family: "pragma.test-credentials",
    sourceVersion: 1,
    targetVersion: 2,
    secretStore: input.secretStore,
    decryptor,
    onStage,
    parseLegacy: (value) => value as { schemaVersion: 1; credentials: Record<string, string> },
    collect: (legacy) => [
      {
        key: "owner/token",
        ciphertext: legacy.credentials["owner/token"]!,
        owner: { kind: "capability" as const, capabilityId: "owner", name: "token" },
      },
    ],
    target: (_legacy, refs) => ({
      schemaVersion: 2,
      credentials: { "owner/token": refs.get("owner/token")! },
    }),
    parseCurrent: (value) =>
      value as {
        schemaVersion: 2;
        credentials: { "owner/token": import("@pragma/local-host").SecretRef };
      },
  });
}

describe("legacy credential migration", () => {
  it("replays every durable stage without plaintext in metadata, journal, or backup", async () => {
    for (const stage of [
      "prepared",
      "targets_written",
      "target_metadata_written",
      "verified",
      "committed",
    ] as const) {
      const input = await fixture();
      await expect(
        migrate(input, (seen) => {
          if (seen === stage) throw new Error("simulated crash");
        }),
      ).rejects.toThrow("simulated crash");
      await expect(migrate(input)).resolves.toMatchObject({ migrated: true });
      const current = await readFile(input.configPath, "utf8");
      const journal = await readFile(`${input.configPath}.migration-journal.json`, "utf8");
      const backup = await readFile(
        (JSON.parse(journal) as { backupPath: string }).backupPath,
        "utf8",
      );
      expect(current).not.toContain("actual-secret");
      expect(journal).not.toContain("actual-secret");
      expect(backup).not.toContain("actual-secret");
      expect(JSON.parse(current)).toMatchObject({ schemaVersion: 2 });
    }
  });

  it("keeps legacy data authoritative when keychain or decrypt fails", async () => {
    const unavailable = await fixture();
    unavailable.keychain.health = { status: "locked", backend: "macos-keychain" };
    await expect(migrate(unavailable)).rejects.toMatchObject({ code: "SECRET_STORE_LOCKED" });
    expect(JSON.parse(await readFile(unavailable.configPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
    });
    const corrupt = await fixture();
    await writeFile(
      corrupt.configPath,
      JSON.stringify({
        schemaVersion: 1,
        credentials: { "owner/token": "not-a-safe-storage-value" },
      }),
    );
    await expect(migrate(corrupt)).rejects.toThrow("corrupted");
    expect(JSON.parse(await readFile(corrupt.configPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
    });
  });

  it("rejects future schema and does not alter current format", async () => {
    const input = await fixture();
    await writeFile(input.configPath, JSON.stringify({ schemaVersion: 3, credentials: {} }));
    await expect(migrate(input)).rejects.toMatchObject({ code: "SECRET_MIGRATION_FUTURE_VERSION" });
    expect(JSON.parse(await readFile(input.configPath, "utf8"))).toMatchObject({
      schemaVersion: 3,
    });
  });

  it("keeps a malformed or future journal and legacy source fail-closed", async () => {
    const input = await fixture();
    const journalPath = `${input.configPath}.migration-journal.json`;
    await writeFile(journalPath, "{not-json");
    await expect(migrate(input)).rejects.toMatchObject({ code: "SECRET_MIGRATION_REQUIRED" });
    expect(JSON.parse(await readFile(input.configPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
    });
    expect(await readFile(journalPath, "utf8")).toBe("{not-json");

    await writeFile(
      journalPath,
      JSON.stringify({ schemaVersion: "pragma.legacy-credential-migration/v2" }),
    );
    await expect(migrate(input)).rejects.toMatchObject({ code: "SECRET_MIGRATION_REQUIRED" });
    expect(JSON.parse(await readFile(input.configPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
    });
  });

  it("replays journals when an equivalent owner was serialized in another property order", async () => {
    const input = await fixture();
    await expect(
      migrate(input, (stage) => {
        if (stage === "targets_written") throw new Error("crash-after-targets");
      }),
    ).rejects.toThrow("crash-after-targets");
    const journalPath = `${input.configPath}.migration-journal.json`;
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      refs: [{ ref: { owner: { kind: "capability"; capabilityId: string; name: string } } }];
    };
    const owner = journal.refs[0]!.ref.owner;
    journal.refs[0]!.ref.owner = {
      name: owner.name,
      kind: owner.kind,
      capabilityId: owner.capabilityId,
    };
    await writeFile(journalPath, JSON.stringify(journal));
    await expect(migrate(input)).resolves.toMatchObject({ migrated: true });
  });
});
