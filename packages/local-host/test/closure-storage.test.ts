import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createSqliteExecutionStore } from "../src/execution/sqlite-execution-store.ts";
import { mkdtemp, readFile, writeFile, rm, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { describe, expect, it } from "vitest";
import { executionStorageConversionMigrationChain, PragmaPaths } from "@pragma/core";
import { executeUsageLedger } from "../src/usage-ledger-database.ts";
import { createMissionDeliveryReceiptStore } from "../src/mission-delivery-receipt-store.ts";

const journalFixture = new URL("./fixtures/execution-storage-conversion-v1.json", import.meta.url);
describe("Closure storage recovery", () => {
  it("upgrades an actual v1 conversion journal and preserves current progress", async () => {
    const historical = JSON.parse(await readFile(journalFixture, "utf8"));
    const upgraded = executionStorageConversionMigrationChain.upgrade(historical);
    expect(upgraded).toMatchObject({
      migrated: true,
      fromVersion: 1,
      toVersion: 2,
      value: { executionId: "current", phase: "backup", importedEvents: 0 },
    });
    expect(executionStorageConversionMigrationChain.upgrade(upgraded.value)).toMatchObject({
      migrated: false,
      value: upgraded.value,
    });
    expect(() =>
      executionStorageConversionMigrationChain.upgrade({
        schemaVersion: "pragma.execution-storage-conversion/v3",
        executionId: "current",
      }),
    ).toThrow();
  });
  it.each(["empty-import", "publish-temporary", "publish-renamed"] as const)(
    "replays v2 conversion at %s",
    async (boundary) => {
      const home = await mkdtemp(join(tmpdir(), "pragma-conversion-v2-"));
      const paths = new PragmaPaths({ pragmaHome: home });
      const store = createSqliteExecutionStore({ pragmaHome: home });
      try {
        const historical = JSON.parse(
          await readFile(new URL("./fixtures/execution-file-v12.json", import.meta.url), "utf8"),
        );
        const files = [
          paths.executionState("current"),
          paths.executionInvocations("current"),
          paths.executionAgents("current"),
          paths.executionContexts("current"),
          paths.executionCommits("current"),
          paths.executionEvents("current"),
        ];
        await mkdir(paths.executionRoot("current"), { recursive: true });
        for (const [key, file] of [
          ["execution", files[0]],
          ["invocations", files[1]],
          ["agents", files[2]],
          ["contexts", files[3]],
          ["commits", files[4]],
        ] as const)
          await writeFile(file!, JSON.stringify(historical[key]));
        await writeFile(
          files[5]!,
          historical.events.map((event: unknown) => JSON.stringify(event)).join("\n") + "\n",
        );
        await store.prepareOwner("current");
        const fingerprint = createHash("sha256");
        for (const file of files) {
          fingerprint.update(basename(file));
          fingerprint.update(await readFile(file));
        }
        const temporary = `${paths.executionDatabase("current")}.converting`;
        if (boundary !== "publish-renamed") {
          await copyFile(paths.executionDatabase("current"), temporary);
          await rm(paths.executionDatabase("current"));
        }
        if (boundary === "empty-import") {
          const db = new DatabaseSync(temporary);
          try {
            db.exec(
              "DELETE FROM execution;DELETE FROM invocations;DELETE FROM agents;DELETE FROM contexts;DELETE FROM events;DELETE FROM receipts;DELETE FROM outbox;",
            );
          } finally {
            db.close();
          }
        }
        await rm(paths.executionStorageAuthority("current"));
        await writeFile(
          paths.executionStorageConversion("current"),
          JSON.stringify({
            schemaVersion: "pragma.execution-storage-conversion/v2",
            executionId: "current",
            phase: boundary === "empty-import" ? "import" : "publish",
            sourceFingerprint: fingerprint.digest("hex"),
            importedEvents: boundary === "empty-import" ? 0 : 1,
            handoffNames: [],
          }),
        );
        expect(await store.get("current")).toMatchObject({
          executionId: "current",
          version: 1,
          lastAppliedSequence: 1,
        });
        expect(await store.listInvocations("current")).toHaveLength(1);
        expect(await store.readEvents("current")).toHaveLength(1);
        expect(
          (
            await store.commit({
              executionId: "current",
              commitId: "old",
              events: [{ eventId: "one", invocationId: "root", type: "progress", data: 1 }],
            })
          ).execution.version,
        ).toBe(1);
        await expect(readFile(paths.executionStorageConversion("current"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await store.delete("current");
        expect(await store.get("current")).toBeUndefined();
      } finally {
        await store.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );
  it.each([undefined, "import", "publish"])(
    "imports historical Usage across interruption %s without dual writes",
    async (stage) => {
      const root = await mkdtemp(join(tmpdir(), "pragma-usage-migration-"));
      try {
        const path = join(root, "observations.json");
        const original = await readFile(
          new URL("./fixtures/local-host-usage-v1.json", import.meta.url),
          "utf8",
        );
        await writeFile(path, original);
        if (stage !== undefined)
          await writeFile(
            `${path}.conversion.json`,
            JSON.stringify({ schemaVersion: "pragma.local-host-usage-conversion/v1", stage }),
          );
        const expected = Object.values(JSON.parse(original).observations);
        expect(await executeUsageLedger(path, "list")).toEqual(expected);
        expect(await readFile(`${path}.backup`, "utf8")).toBe(original);
        await executeUsageLedger(path, "record", expected[0]);
        expect(await executeUsageLedger(path, "list")).toEqual(expected);
        expect(await readFile(path, "utf8")).toBe(original);
        await rm(`${path}.sqlite`);
        await expect(executeUsageLedger(path, "list")).rejects.toMatchObject({
          code: "USAGE_LEDGER_AUTHORITY_MISSING",
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it("does not wake immediately for a Mission whose earlier task is held or needs attention", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-receipt-wake-"));
    const store = await createMissionDeliveryReceiptStore({
      path: join(root, "receipt.sqlite"),
      onNotice: () => undefined,
    });
    try {
      await store.registerLink(
        "first",
        "mission",
        JSON.stringify({ mission: { id: "mission" }, requestId: "one" }),
      );
      await store.registerLink(
        "second",
        "mission",
        JSON.stringify({ mission: { id: "mission" }, requestId: "two" }),
      );
      const items = ["first", "second"].map((executionId, index) => ({
        kind: "event" as const,
        cursor: { sequence: index + 1 },
        event: {
          schemaVersion: "pragma.canonical-event/v1" as const,
          eventId: executionId,
          topic: "pragma.execution.event.committed",
          schemaRef: "pragma.execution-event/v5",
          sourceRef: {
            type: "pragma.execution-event",
            id: executionId,
            ownerRef: { type: "pragma.execution", id: executionId },
            cursor: "1",
          },
          relatedRefs: [],
          correlationId: executionId,
          occurredAt: new Date().toISOString(),
          payload: {
            schemaVersion: "pragma.execution-event/v5",
            eventId: executionId,
            cursor: { executionId, sequence: 1 },
            executionId,
            invocationId: "root",
            type: "execution.succeeded",
            data: { output: "OK" },
            occurredAt: new Date().toISOString(),
          },
        },
      }));
      await store.stagePage({ items, nextCursor: { sequence: 2 }, hasMore: false });
      const held = await store.claim();
      expect(held).toBeDefined();
      expect(await store.claim()).toBeUndefined();
      expect((await store.inspect()).nextWakeAt).toBeGreaterThan(Date.now() + 50_000);
      await store.fail(held!.row.id, held!.claim, true, 0);
      const next = await store.claim();
      // Other terminal steps remain independent; static blockers never force a due=0 wake after they settle.
      while (next !== undefined) {
        await store.acknowledge(next.row.id, next.claim, next.row.mission_id);
        const following = await store.claim();
        if (following === undefined) break;
        Object.assign(next, following);
      }
      expect((await store.inspect()).nextWakeAt).toBeUndefined();
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
