import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PragmaPaths } from "../src/storage/pragma-paths.ts";
import { upgradeCanonicalEventHandoff } from "../src/storage/migrations/canonical-event-handoff/index.ts";
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "pragma-handoff-migration-"));
  homes.push(home);
  const source = JSON.parse(
    await readFile(new URL("./fixtures/execution-handoff-v10.json", import.meta.url), "utf8"),
  ) as { files: Record<string, string> };
  const entry = Object.entries(source.files).find(([file]) => file.includes("/handoffs/"))!;
  const file = join(home, entry[0]);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, entry[1]);
  return { file, source: entry[1], paths: new PragmaPaths({ pragmaHome: home }) };
}
it("upgrades the historical embedded transaction through registered adjacent steps and current reads are no-op", async () => {
  const { file, source, paths } = await fixture();
  const migrated = await upgradeCanonicalEventHandoff(paths, file, "historical-handoff");
  expect(migrated.transaction.schemaVersion).toBe("pragma.execution-transaction/v13");
  expect(migrated.transaction.execution.schemaVersion).toBe("pragma.execution/v12");
  expect(migrated.events).toEqual(JSON.parse(source).events);
  const contents = await readFile(file, "utf8");
  expect(await upgradeCanonicalEventHandoff(paths, file, "historical-handoff")).toEqual(migrated);
  expect(await readFile(file, "utf8")).toBe(contents);
});
it("replays an interrupted handoff conversion before parsing domain state", async () => {
  const { file, source, paths } = await fixture();
  const migrated = await upgradeCanonicalEventHandoff(paths, file, "historical-handoff");
  await writeFile(file, source);
  const name = file.split("/").at(-1)!;
  await writeFile(
    `${file}.migration`,
    JSON.stringify({
      schemaVersion: "pragma.state-migration/v1",
      resource: { family: "pragma.execution-transaction", id: name },
      fromVersion: 10,
      toVersion: 13,
      documents: { [name]: migrated },
    }),
  );
  expect(await upgradeCanonicalEventHandoff(paths, file, "historical-handoff")).toEqual(migrated);
  await expect(readFile(`${file}.migration`)).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses future embedded transactions and preserves the source", async () => {
  const { file, source, paths } = await fixture();
  const future = JSON.parse(source);
  future.transaction.schemaVersion = "pragma.execution-transaction/v999";
  const contents = JSON.stringify(future);
  await writeFile(file, contents);
  await expect(upgradeCanonicalEventHandoff(paths, file, "historical-handoff")).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(contents);
});
