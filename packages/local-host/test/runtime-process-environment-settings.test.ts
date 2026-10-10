import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeProcessEnvironmentSettingsStore } from "../src/runtime-process-environment-settings.ts";

describe("Runtime process environment settings store", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map(async (root) => await rm(root, { recursive: true, force: true })),
    );
  });

  it("defaults to filtered mode and persists policies without environment values", async () => {
    const root = await createTemporaryRoot(temporaryRoots);
    const store = createRuntimeProcessEnvironmentSettingsStore({ pragmaHome: root });

    expect(await store.get()).toEqual({
      schemaVersion: "pragma.runtime-process-environment-settings/v1",
      revision: 0,
      policy: { mode: "filtered", allowlist: [], blocklist: [] },
    });
    expect(store.getSync().revision).toBe(0);
    await expect(store.getPolicy()).resolves.toEqual({
      mode: "filtered",
      allowlist: [],
      blocklist: [],
    });

    const saved = await store.updatePolicy({
      expectedRevision: 0,
      policy: {
        mode: "inherit-all",
        allowlist: ["CUSTOM_TOOL_HOME"],
        blocklist: ["CUSTOM_TOKEN"],
      },
    });

    expect(saved.revision).toBe(1);
    expect(await store.getPolicy()).toEqual({
      mode: "inherit-all",
      allowlist: ["CUSTOM_TOOL_HOME"],
      blocklist: ["CUSTOM_TOKEN"],
    });
    expect(store.getSync()).toEqual(saved);

    const persisted = await readFile(
      join(root, "state", "runtime-process-environment-settings.json"),
      "utf8",
    );
    expect(JSON.parse(persisted)).toEqual(saved);
  });

  it("rejects stale updates and serializes competing writes", async () => {
    const root = await createTemporaryRoot(temporaryRoots);
    const store = createRuntimeProcessEnvironmentSettingsStore({ pragmaHome: root });
    const first = {
      expectedRevision: 0,
      policy: { mode: "inherit-all" as const, allowlist: [], blocklist: [] },
    };
    const second = {
      expectedRevision: 0,
      policy: { mode: "filtered" as const, allowlist: ["CUSTOM_HOME"], blocklist: [] },
    };

    const results = await Promise.allSettled([
      store.updatePolicy(first),
      store.updatePolicy(second),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(store.updatePolicy({ ...first, expectedRevision: 0 })).rejects.toThrow(
      "runtime_process_environment_settings_conflict",
    );
    expect(store.getSync().revision).toBe(1);
  });
});

async function createTemporaryRoot(roots: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-runtime-environment-settings-"));
  roots.push(root);
  return root;
}
