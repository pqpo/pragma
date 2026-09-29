import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAssetGitState } from "./asset-git-state.ts";
import { assetGitV1ToV2Step } from "./migrations/index.ts";
import { createAssetGitService } from "./asset-git-service.ts";
import { createContextStoreStore } from "../context-stores/context-store-store.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";

const fixtureRoot = join(import.meta.dirname, "fixtures/v1");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pragma-git-state-"));
  roots.push(root);
  const recordText = await readFile(join(fixtureRoot, "record.json"), "utf8");
  const journalText = await readFile(join(fixtureRoot, "journal.json"), "utf8");
  const record = JSON.parse(recordText),
    journal = JSON.parse(journalText);
  const path = join(root, "knowledge", `${record.target.id}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, recordText);
  await writeFile(`${path}.journal`, journalText);
  return { root, path, record, journal, recordText, journalText, state: createAssetGitState(root) };
}

describe("asset Git state upgrade", () => {
  it("upgrades actual v1 record and embedded transaction journal together with backups; v2 is a no-op", async () => {
    const { root, path, record, journal, recordText, journalText, state } = await fixture();
    expect((await state.identity(record.target))?.source).toEqual(record.source);
    expect(await readFile(path, "utf8")).toBe(recordText);
    const upgraded = await state.read(record.target);
    expect(upgraded.record).toEqual(assetGitV1ToV2Step.record(record));
    expect(upgraded.journal).toEqual(assetGitV1ToV2Step.journal(journal));
    const backups = join(root, "knowledge/migrations/backups");
    const contents = await Promise.all(
      (await readdir(backups)).map((file) => readFile(join(backups, file), "utf8")),
    );
    expect(contents).toContain(recordText);
    expect(contents).toContain(journalText);
    const serialized = await readFile(path, "utf8");
    await state.read(record.target);
    expect(await readFile(path, "utf8")).toBe(serialized);
    expect(await readdir(backups)).toHaveLength(2);
  });
  it.each(["record", "journal"] as const)(
    "replays a migration interrupted after replacing the %s",
    async (replaced) => {
      const { path, record, journal, state } = await fixture();
      const documents = {
        [`${record.target.id}.json`]: assetGitV1ToV2Step.record(record),
        [`${record.target.id}.json.journal`]: assetGitV1ToV2Step.journal(journal),
      };
      await writeFile(
        `${path}.migration`,
        JSON.stringify({
          schemaVersion: "pragma.state-migration/v1",
          resource: { family: "pragma.asset-git", id: `knowledge/${record.target.id}` },
          fromVersion: 1,
          toVersion: 2,
          documents,
        }),
      );
      const name = `${record.target.id}.json${replaced === "journal" ? ".journal" : ""}`;
      await writeFile(
        join(dirname(path), name),
        JSON.stringify(documents[name as keyof typeof documents]),
      );
      expect((await state.read(record.target)).record).toEqual(assetGitV1ToV2Step.record(record));
      expect((await state.read(record.target)).journal).toEqual(
        assetGitV1ToV2Step.journal(journal),
      );
      await expect(readFile(`${path}.migration`)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it.each(["record", "journal"] as const)(
    "rejects a future %s and preserves both source files",
    async (future) => {
      const { path, record, journal, state } = await fixture();
      const futurePath = `${path}${future === "journal" ? ".journal" : ""}`;
      await writeFile(
        futurePath,
        JSON.stringify({
          ...(future === "journal" ? journal : record),
          schemaVersion: `pragma.asset-git${future === "journal" ? "-journal" : ""}/v99`,
        }),
      );
      const before = await Promise.all([
        readFile(path, "utf8"),
        readFile(`${path}.journal`, "utf8"),
      ]);
      await expect(state.read(record.target)).rejects.toMatchObject({
        code: "asset_git_state_upgrade_failed",
      });
      expect(
        await Promise.all([readFile(path, "utf8"), readFile(`${path}.journal`, "utf8")]),
      ).toEqual(before);
    },
  );
  it("restores an actual interrupted v1 push, then synchronizes metadata", async () => {
    const { root, record, path } = await fixture();
    const execute = promisify(execFile);
    const run = async (directory: string, args: string[]) =>
      (await execute("git", ["-C", directory, ...args])).stdout;
    const bare = join(root, "asset.git");
    await run(root, ["init", "--bare", bare]);
    const child = execFile("git", ["-C", bare, "fast-import"]);
    child.stdin!.end(await readFile(join(fixtureRoot, "repository.fast-export")));
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`fast-import exited ${code}`)),
      );
    });
    await run(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    const config = join(root, "gitconfig"),
      oldConfig = process.env.GIT_CONFIG_GLOBAL,
      oldProtocol = process.env.GIT_ALLOW_PROTOCOL;
    await writeFile(
      config,
      `[url "file://${root}/"]\n  insteadOf = https://example.test/\n[user]\n  name = Test\n  email = test@example.test\n`,
    );
    process.env.GIT_CONFIG_GLOBAL = config;
    process.env.GIT_ALLOW_PROTOCOL = "file";
    try {
      const stores = createContextStoreStore({ storesPath: join(root, "stores") });
      await stores.createFromSnapshot({
        id: record.target.id,
        name: "Historical",
        description: "",
        author: "import",
        summary: "Historical fixture",
        files: [
          {
            id: "guide.md",
            content: "# Guide\nFirst line\nSecond line\n",
            metadata: { trigger: "manual", priority: "normal" },
          },
        ],
      });
      const file = await stores.getContent(record.target.id, "guide.md");
      await stores.updateFile(
        record.target.id,
        "guide.md",
        "# Historical change\n",
        file.metadata,
        file.revision!,
      );
      const service = createAssetGitService({
        stateRoot: root,
        stores,
        capabilities: {} as CapabilityStore,
      });
      expect((await service.sync(record.target)).status).toBe("synced");
      expect((await stores.getContent(record.target.id, "guide.md")).content).toBe(
        "# Historical change\n",
      );
      expect(await run(bare, ["show", "main:.pragma/metadata/guide.md.yaml"])).toContain(
        "priority: normal",
      );
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        schemaVersion: "pragma.asset-git/v2",
        knowledgeMetadataVersion: 1,
      });
      await expect(readFile(`${path}.journal`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (oldConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = oldConfig;
      if (oldProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
      else process.env.GIT_ALLOW_PROTOCOL = oldProtocol;
    }
  }, 30000);
});
