import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { encodePragmaPathSegment } from "@pragma/core";
import { createHash } from "node:crypto";
import { SecretRefSchema } from "@pragma/shared/integration";

import { createCapabilityCredentialStore } from "./capability-credential-store.ts";
import { createTestSecretStore } from "../credentials/test-secret-store.ts";
import { capabilityCredentialsV2ToV3Step } from "./migrations/index.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Capability Credential Store", () => {
  it("migrates the static aggregate written by the historical v2 writer", async () => {
    const fixture = JSON.parse(
      await readFile(new URL("./fixtures/capability-credentials-v2.json", import.meta.url), "utf8"),
    ) as unknown;

    expect(capabilityCredentialsV2ToV3Step.migrate(fixture)).toMatchObject({
      schemaVersion: 3,
      credentials: {
        "capability-1/token": {
          generation: "00000000-0000-4000-8000-000000000302",
        },
      },
    });
  });

  it("encrypts, rotates, and removes capability credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-capability-secrets-"));
    directories.push(directory);
    const configPath = join(directory, "credentials.json");
    const { secretStore } = createTestSecretStore(join(directory, "secret-store"));
    const store = createCapabilityCredentialStore({
      configPath,
      secretStore,
    });

    await store.setMany("capability-1", { token: "first-secret" });
    expect(await store.get("capability-1", "token")).toBe("first-secret");
    expect(await readFile(configPath, "utf8")).not.toContain("first-secret");

    await store.setMany("capability-1", { token: "rotated-secret" });
    expect(await store.get("capability-1", "token")).toBe("rotated-secret");

    await store.removeCapability("capability-1");
    expect(await store.get("capability-1", "token")).toBeUndefined();
  });

  it("replays an interrupted credential deletion without leaving an active secret", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-capability-secrets-delete-"));
    directories.push(directory);
    const configPath = join(directory, "credentials.json");
    const { secretStore } = createTestSecretStore(join(directory, "secret-store"));
    const store = createCapabilityCredentialStore({ configPath, secretStore });
    await store.setMany("capability-1", { token: "secret-to-delete" });
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      credentials: Record<string, { ref: unknown }>;
    };
    const ref = SecretRefSchema.parse(config.credentials["capability-1/token"]!.ref);
    const deletionPath = `${configPath}.deletions/${encodePragmaPathSegment("capability-1")}.json`;
    await mkdir(`${configPath}.deletions`, { recursive: true });
    await writeFile(
      deletionPath,
      `${JSON.stringify({
        schemaVersion: "pragma.capability-credential-deletion/v1",
        capabilityId: "capability-1",
        refs: [ref],
      })}\n`,
    );

    await expect(store.get("capability-1", "token")).resolves.toBeUndefined();
    await expect(secretStore.get(ref)).rejects.toMatchObject({ code: "SECRET_NOT_FOUND" });
    await expect(readFile(deletionPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates the v2 aggregate to generation bindings while retaining a backup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-capability-secrets-v2-"));
    directories.push(directory);
    const configPath = join(directory, "credentials.json");
    const { secretStore } = createTestSecretStore(join(directory, "secret-store"));
    const ref = await secretStore.put({
      owner: { kind: "capability", capabilityId: "capability-1", name: "token" },
      value: Buffer.from("historical-secret"),
    });
    await writeFile(
      configPath,
      `${JSON.stringify({ schemaVersion: 2, credentials: { "capability-1/token": ref } })}\n`,
    );

    const store = createCapabilityCredentialStore({ configPath, secretStore });
    await expect(store.get("capability-1", "token")).resolves.toBe("historical-secret");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      schemaVersion: 3,
      credentials: { "capability-1/token": { generation: ref.revision, ref } },
    });
    expect(JSON.parse(await readFile(`${configPath}.v2.backup.json`, "utf8"))).toMatchObject({
      schemaVersion: 2,
    });
  });

  it("replays an interrupted v2 to v3 migration journal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-capability-secrets-v2-recovery-"));
    directories.push(directory);
    const configPath = join(directory, "credentials.json");
    const { secretStore } = createTestSecretStore(join(directory, "secret-store"));
    const ref = await secretStore.put({
      owner: { kind: "capability", capabilityId: "capability-1", name: "token" },
      value: Buffer.from("historical-secret"),
    });
    await writeFile(
      configPath,
      `${JSON.stringify({ schemaVersion: 2, credentials: { "capability-1/token": ref } })}\n`,
    );
    await writeFile(
      `${configPath}.v2-to-v3.json`,
      `${JSON.stringify({
        schemaVersion: "pragma.capability-credentials-v2-to-v3/v1",
        sourceHash: `sha256:${createHash("sha256")
          .update(JSON.stringify({ schemaVersion: 2, credentials: { "capability-1/token": ref } }))
          .digest("hex")}`,
        target: {
          schemaVersion: 3,
          credentials: { "capability-1/token": { generation: ref.revision, ref } },
        },
      })}\n`,
    );

    const store = createCapabilityCredentialStore({ configPath, secretStore });

    await expect(store.get("capability-1", "token")).resolves.toBe("historical-secret");
    await expect(readFile(`${configPath}.v2-to-v3.json`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed with a stable error for a future credential schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-capability-secrets-future-"));
    directories.push(directory);
    const configPath = join(directory, "credentials.json");
    const { secretStore } = createTestSecretStore(join(directory, "secret-store"));
    await writeFile(configPath, `${JSON.stringify({ schemaVersion: 99, credentials: {} })}\n`);
    const store = createCapabilityCredentialStore({ configPath, secretStore });

    await expect(store.get("capability-1", "token")).rejects.toMatchObject({
      code: "unsupported_version",
    });
  });

  it("keeps the active generation unchanged when a credential mutation is rejected", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-capability-secrets-rollback-"));
    directories.push(directory);
    const configPath = join(directory, "credentials.json");
    const { secretStore } = createTestSecretStore(join(directory, "secret-store"));
    const initial = createCapabilityCredentialStore({ configPath, secretStore });
    await initial.setMany("capability-1", { token: "first-secret" });
    const before = await readFile(configPath, "utf8");
    let persistedJournal = "";
    const journalPath = `${configPath}.mutations/${encodePragmaPathSegment("capability-1")}.json`;
    const rejecting = createCapabilityCredentialStore({
      configPath,
      secretStore,
      onMutationStage: async (stage) => {
        if (stage !== "secrets-written") return;
        persistedJournal = await readFile(journalPath, "utf8");
        throw new Error("injected failure");
      },
    });

    await expect(
      rejecting.setMany("capability-1", { token: "never-activated-secret" }),
    ).rejects.toThrow("injected failure");
    expect(persistedJournal).not.toContain("never-activated-secret");
    expect(await readFile(configPath, "utf8")).toBe(before);
    await expect(initial.get("capability-1", "token")).resolves.toBe("first-secret");
  });

  it("recovers a prepared credential journal by retaining the old generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-capability-secrets-prepared-"));
    directories.push(directory);
    const configPath = join(directory, "credentials.json");
    const { secretStore } = createTestSecretStore(join(directory, "secret-store"));
    const initial = createCapabilityCredentialStore({ configPath, secretStore });
    await initial.setMany("capability-1", { token: "first-secret" });
    const interrupted = createCapabilityCredentialStore({
      configPath,
      secretStore,
      onMutationStage: async (stage) => {
        if (stage === "prepared") throw new Error("simulated crash");
      },
    });

    await expect(interrupted.setMany("capability-1", { token: "second-secret" })).rejects.toThrow(
      "simulated crash",
    );
    await expect(initial.get("capability-1", "token")).resolves.toBe("first-secret");
  });

  it("finishes a committed credential mapping after interruption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-capability-secrets-committed-"));
    directories.push(directory);
    const configPath = join(directory, "credentials.json");
    const { secretStore } = createTestSecretStore(join(directory, "secret-store"));
    const initial = createCapabilityCredentialStore({ configPath, secretStore });
    await initial.setMany("capability-1", { token: "first-secret" });
    const interrupted = createCapabilityCredentialStore({
      configPath,
      secretStore,
      onMutationStage: async (stage) => {
        if (stage === "mapping-committed") throw new Error("simulated crash");
      },
    });

    await expect(interrupted.setMany("capability-1", { token: "second-secret" })).rejects.toThrow(
      "simulated crash",
    );
    await expect(initial.get("capability-1", "token")).resolves.toBe("second-secret");
  });
});
