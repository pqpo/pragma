import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCapabilityCredentialStore } from "./capability-credential-store.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("capability credential store", () => {
  it("encrypts, rotates, and removes capability credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-capability-secrets-"));
    directories.push(directory);
    const configPath = join(directory, "credentials.json");
    const store = createCapabilityCredentialStore({
      configPath,
      encryption: {
        isAvailable: () => true,
        encrypt: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
        decrypt: (value) => value.toString("utf8").replace(/^encrypted:/, ""),
      },
    });

    await store.setMany("capability-1", { token: "first-secret" });
    expect(await store.get("capability-1", "token")).toBe("first-secret");
    expect(await readFile(configPath, "utf8")).not.toContain("first-secret");

    await store.setMany("capability-1", { token: "rotated-secret" });
    expect(await store.get("capability-1", "token")).toBe("rotated-secret");

    await store.removeCapability("capability-1");
    expect(await store.get("capability-1", "token")).toBeUndefined();
  });
});
