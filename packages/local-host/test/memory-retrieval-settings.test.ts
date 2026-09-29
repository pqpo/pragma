import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { PragmaPaths } from "@pragma/core";
import { createMemoryRetrievalSettingsStore } from "../src/memory-retrieval-settings.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-retrieval-settings-"));
  roots.push(pragmaHome);
  const path = new PragmaPaths({ pragmaHome }).memoryRetrievalSettings();
  await mkdir(dirname(path), { recursive: true });
  return { path, store: createMemoryRetrievalSettingsStore({ pragmaHome }) };
}

describe("Memory retrieval settings", () => {
  it.each(["v1-provider-only", "v1-model-only"])(
    "reads and updates historical %s settings without rewriting them on read",
    async (name) => {
      const f = await fixture();
      const historical = new URL(
        `./fixtures/memory-retrieval-settings/${name}.json`,
        import.meta.url,
      );
      await copyFile(historical, f.path);
      const original = await readFile(f.path, "utf8");
      const current = await f.store.get();
      expect(current).toEqual(JSON.parse(original));
      expect(await readFile(f.path, "utf8")).toBe(original);
      const { schemaVersion, revision, ...value } = current;
      const next = await f.store.update({ expectedRevision: revision, ...value });
      expect(next).toEqual({ schemaVersion, revision: revision + 1, ...value });
      expect(await f.store.get()).toEqual(next);
    },
  );

  it("persists enabled settings awaiting model selection and refuses stale updates", async () => {
    const f = await fixture();
    expect(await f.store.get()).toMatchObject({ revision: 0, enabled: false });
    const current = await f.store.update({ expectedRevision: 0, enabled: true });
    expect(await f.store.get()).toEqual(current);
    await expect(f.store.update({ expectedRevision: 0, enabled: false })).rejects.toThrow(
      "embedding_settings_conflict",
    );
    expect(await f.store.get()).toEqual(current);
  });

  it("rejects future versions and malformed known fields without changing the file", async () => {
    const f = await fixture();
    for (const record of [
      { schemaVersion: "pragma.memory-retrieval/v99", revision: 1, enabled: false },
      {
        schemaVersion: "pragma.memory-retrieval/v1",
        revision: 1,
        enabled: true,
        modelId: "embedding",
      },
      {
        schemaVersion: "pragma.memory-retrieval/v1",
        revision: 1,
        enabled: false,
        providerId: "invalid",
      },
    ]) {
      const original = JSON.stringify(record);
      await writeFile(f.path, original);
      await expect(f.store.get()).rejects.toThrow("embedding_settings_unavailable");
      await expect(f.store.update({ expectedRevision: 1, enabled: false })).rejects.toThrow(
        "embedding_settings_unavailable",
      );
      expect(await readFile(f.path, "utf8")).toBe(original);
    }
  });
});
