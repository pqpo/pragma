import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPluginCredentialStore } from "./plugin-credential-store.ts";
import { createTestSecretStore } from "../credentials/test-secret-store.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Plugin Credential Store", () => {
  it("preserves concurrent mutations from independent store instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-plugin-credentials-"));
    directories.push(directory);
    const configPath = join(directory, "plugin-credentials.json");
    const { secretStore } = createTestSecretStore(join(directory, "secret-store"));
    const first = createPluginCredentialStore({ configPath, secretStore });
    const second = createPluginCredentialStore({ configPath, secretStore });

    await Promise.all([
      first.applyChanges({ set: { "binding:first": "token-a" } }),
      second.applyChanges({ set: { "binding:second": "token-b" } }),
    ]);

    await expect(first.get("binding:first")).resolves.toBe("token-a");
    await expect(first.get("binding:second")).resolves.toBe("token-b");
    expect(await readFile(configPath, "utf8")).not.toContain("token-a");
    expect(await readFile(configPath, "utf8")).not.toContain("token-b");

    await first.applyChanges({
      set: { "binding:third": "token-c" },
      remove: ["binding:first"],
    });
    await expect(second.get("binding:first")).resolves.toBeUndefined();
    await expect(second.get("binding:second")).resolves.toBe("token-b");
    await expect(second.get("binding:third")).resolves.toBe("token-c");
  });
});
