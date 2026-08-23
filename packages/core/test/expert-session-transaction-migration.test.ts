import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createFileExecutionStore } from "../src/execution/execution-store.ts";
import { createFileExpertSessionStore } from "../src/execution/expert-session-store.ts";
import { PragmaPaths } from "../src/storage/pragma-paths.ts";
import { expertSessionTransactionMigrationChain } from "../src/storage/migrations/expert-session-transaction/index.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("ExpertSession transaction migration", () => {
  it("upgrades a historical v8 transaction fixture to v9", async () => {
    const fixture = await readFixture("expert-session-transaction-v8.json");

    const upgraded = expertSessionTransactionMigrationChain.upgrade(fixture);

    expect(upgraded).toMatchObject({ fromVersion: 8, toVersion: 9, migrated: true });
    expect(upgraded.value).toMatchObject({
      schemaVersion: "pragma.expert-session-transaction/v9",
      execution: { schemaVersion: "pragma.execution/v10" },
      rootInvocation: { pendingExpertMessages: [] },
    });
  });

  it("chains a historical v6 transaction through every supported migration", async () => {
    const fixture = await readFixture("expert-session-transaction-v6.json");

    expect(expertSessionTransactionMigrationChain.upgrade(fixture)).toMatchObject({
      fromVersion: 6,
      toVersion: 9,
      migrated: true,
      value: { schemaVersion: "pragma.expert-session-transaction/v9" },
    });
  });

  it("treats current v9 state as a no-op and rejects future state", async () => {
    const fixture = await readFixture("expert-session-transaction-v8.json");
    const current = expertSessionTransactionMigrationChain.upgrade(fixture).value;

    expect(expertSessionTransactionMigrationChain.upgrade(current)).toMatchObject({
      fromVersion: 9,
      toVersion: 9,
      migrated: false,
    });
    expect(() =>
      expertSessionTransactionMigrationChain.upgrade({
        ...current,
        schemaVersion: "pragma.expert-session-transaction/v10",
      }),
    ).toThrow(
      "pragma.expert-session-transaction/v10 is newer than the supported pragma.expert-session-transaction/v9",
    );
  });

  it("upgrades and replays an unfinished historical v8 transaction journal", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-session-transaction-v8-"));
    temporaryRoots.push(home);
    const paths = new PragmaPaths({ pragmaHome: home });
    const transactionPath = paths.expertSessionTransaction("historical-session");
    await mkdir(dirname(transactionPath), { recursive: true });
    await writeFile(
      transactionPath,
      `${JSON.stringify(await readFixture("expert-session-transaction-v8.json"))}\n`,
      "utf8",
    );
    const executions = createFileExecutionStore({ pragmaHome: home });
    const sessions = createFileExpertSessionStore({ executions, pragmaHome: home });

    await expect(sessions.get("historical-session")).resolves.toMatchObject({
      sessionId: "historical-session",
      activeExecutionId: "historical-execution",
    });
    await expect(executions.get("historical-execution")).resolves.toMatchObject({
      schemaVersion: "pragma.execution/v10",
    });
    await expect(
      executions.getInvocation("historical-execution", "historical-execution"),
    ).resolves.toMatchObject({ pendingExpertMessages: [] });
    await expect(readFile(transactionPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function readFixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"),
  ) as unknown;
}
