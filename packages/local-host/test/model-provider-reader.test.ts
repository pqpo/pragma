import { copyFile, writeFile, readFile, mkdtemp, rm, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  readStoredModelProviderConfig,
  ModelProvidersV6Schema,
  modelProvidersV6ToV7Step,
} from "../src/index.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function config() {
  const root = await mkdtemp(join(tmpdir(), "pragma-model-reader-"));
  roots.push(root);
  return join(root, "model-providers.json");
}
const fixture = (version: number) =>
  new URL(`../../memory/test/fixtures/retrieval/model-providers-v${version}.json`, import.meta.url);
describe("shared model provider reader", () => {
  it.each([5, 6])(
    "upgrades the actual v%s writer output through registered adjacent steps with backups",
    async (version) => {
      const path = await config();
      await copyFile(fixture(version), path);
      const result = await readStoredModelProviderConfig(path);
      expect(result.schemaVersion).toBe(7);
      expect(result.providers[0]?.models[0]).toMatchObject({
        kind: "generation",
        id: "historical-generation",
        contextWindow: 128000,
        maxTokens: 16384,
      });
      const files = await readdir(join(path, "..", "migrations", "backups"));
      expect(files).toHaveLength(7 - version);
      const text = await readFile(path, "utf8");
      await readStoredModelProviderConfig(path);
      expect(await readFile(path, "utf8")).toBe(text);
      expect(await readdir(join(path, "..", "migrations", "backups"))).toEqual(files);
    },
  );
  it("replays a prepared v6 to v7 journal and refuses unknown future or corrupt versions", async () => {
    const path = await config();
    const historical = ModelProvidersV6Schema.parse(JSON.parse(await readFile(fixture(6), "utf8")));
    await copyFile(fixture(6), path);
    await writeFile(
      `${path}.state-migration.json`,
      JSON.stringify({
        schemaVersion: "pragma.state-migration/v1",
        resource: { family: "pragma.model-providers", id: "model-providers.json" },
        fromVersion: 6,
        toVersion: 7,
        documents: { "model-providers.json": modelProvidersV6ToV7Step.migrate(historical) },
      }),
    );
    expect((await readStoredModelProviderConfig(path)).schemaVersion).toBe(7);
    await expect(access(`${path}.state-migration.json`)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path, JSON.stringify({ schemaVersion: 8, providers: [] }));
    await expect(readStoredModelProviderConfig(path)).rejects.toThrow();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ schemaVersion: 8, providers: [] });
    await writeFile(path, JSON.stringify({ schemaVersion: 7, providers: [{ id: "corrupt" }] }));
    await expect(readStoredModelProviderConfig(path)).rejects.toThrow();
  });
});
