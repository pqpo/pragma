import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createFileExecutionStore } from "../src/execution/execution-store.ts";
import { createFileExpertSessionStore } from "../src/execution/expert-session-store.ts";
import { PragmaPaths } from "../src/storage/pragma-paths.ts";
import { expertSessionTransactionMigrationChain } from "../src/storage/migrations/expert-session-transaction/index.ts";
import { expertSessionTransactionV9ToV10Step } from "../src/storage/migrations/expert-session-transaction/steps/v9-to-v10.ts";
import { expertSessionTransactionV10ToV11Step } from "../src/storage/migrations/expert-session-transaction/steps/v10-to-v11.ts";
import { expertSessionRecordMigrationChain } from "../src/storage/migrations/expert-session/index.ts";
import { expertSessionV5ToV6Step } from "../src/storage/migrations/expert-session/steps/v5-to-v6.ts";
import { expertSessionV6ToV7Step } from "../src/storage/migrations/expert-session/steps/v6-to-v7.ts";
import { migratePromptPurposes } from "../src/storage/migrations/expert-session/steps/prompt-purpose.ts";
import { migrateQueueSteerDeliveryAttempts } from "../src/storage/migrations/expert-session/steps/queue-steer-delivery.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("ExpertSession transaction migration", () => {
  it("classifies only detached human-wait checkpoint prompts as internal recovery", () => {
    const prompt = {
      requestId: "checkpoint-prompt",
      sessionId: "historical-session",
      content: "Resume after the human answer.",
      mode: "enqueue",
      executionId: "historical-execution",
      status: "queued",
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    } as const;
    expect(
      migratePromptPurposes(
        [prompt],
        [
          {
            type: "execution.detached",
            data: { executionId: prompt.executionId, status: "waiting" },
          },
        ],
      ),
    ).toMatchObject([{ purpose: "human_checkpoint_recovery" }]);
    expect(
      migratePromptPurposes(
        [prompt],
        [
          {
            type: "execution.detached",
            data: { executionId: prompt.executionId, status: "waiting" },
          },
          { type: "execution.attached", data: { executionId: prompt.executionId } },
        ],
      ),
    ).toMatchObject([{ purpose: "user" }]);
  });

  it("upgrades the historical v5 Session record and rejects future state", async () => {
    const fixture = (await readFixture("expert-session-transaction-v8.json")) as {
      readonly session: unknown;
    };
    const upgraded = expertSessionRecordMigrationChain.upgrade(fixture.session);

    expect(upgraded).toMatchObject({
      fromVersion: 5,
      toVersion: 7,
      migrated: true,
      value: { schemaVersion: "pragma.expert-session/v7" },
    });
    expect(expertSessionRecordMigrationChain.upgrade(upgraded.value)).toMatchObject({
      fromVersion: 7,
      toVersion: 7,
      migrated: false,
    });
    expect(() =>
      expertSessionRecordMigrationChain.upgrade({
        ...upgraded.value,
        schemaVersion: "pragma.expert-session/v8",
      }),
    ).toThrow("pragma.expert-session/v8 is newer than the supported pragma.expert-session/v7");
  });

  it("upgrades a historical v8 transaction fixture through v11", async () => {
    const fixture = await readFixture("expert-session-transaction-v8.json");

    const upgraded = expertSessionTransactionMigrationChain.upgrade(fixture);

    expect(upgraded).toMatchObject({ fromVersion: 8, toVersion: 11, migrated: true });
    expect(upgraded.value).toMatchObject({
      schemaVersion: "pragma.expert-session-transaction/v11",
      session: { schemaVersion: "pragma.expert-session/v7" },
      execution: { schemaVersion: "pragma.execution/v11" },
      rootInvocation: { pendingExpertMessages: [] },
    });
  });

  it("chains a historical v6 transaction through every supported migration", async () => {
    const fixture = await readFixture("expert-session-transaction-v6.json");

    expect(expertSessionTransactionMigrationChain.upgrade(fixture)).toMatchObject({
      fromVersion: 6,
      toVersion: 11,
      migrated: true,
      value: { schemaVersion: "pragma.expert-session-transaction/v11" },
    });
  });

  it("migrates the 4ddb0eba v9 queue marker through the formal migration chain", async () => {
    const fixture = await readFixture("expert-session-transaction-v9-queue-marker-4ddb0eba.json");
    const upgraded = expertSessionTransactionMigrationChain.upgrade(fixture);

    expect(upgraded).toMatchObject({ fromVersion: 9, toVersion: 11, migrated: true });
    expect(upgraded.value.prompts).toMatchObject([
      {
        requestId: "queued-request",
        deliveryAttempt: {
          attemptId: "legacy-queue-steer:queued-request",
          kind: "queue_steer",
          sourceExecutionId: "queued-execution",
          targetExecutionId: "active-execution",
          state: "dispatching",
        },
      },
    ]);
    expect(upgraded.value.prompts[0]).not.toHaveProperty("error");

    const v10 = expertSessionTransactionV9ToV10Step.migrate(fixture);
    expect(v10.schemaVersion).toBe("pragma.expert-session-transaction/v10");
    const confirmed = expertSessionTransactionV10ToV11Step.migrate({
      ...v10,
      prompts: [
        {
          ...v10.prompts[0],
          status: "succeeded",
          targetExecutionId: "explicit-target",
        },
      ],
    });
    expect(confirmed.prompts[0]?.deliveryAttempt).toMatchObject({
      targetExecutionId: "explicit-target",
      state: "confirmed",
    });
    expect(() =>
      expertSessionTransactionV10ToV11Step.migrate({
        ...v10,
        prompts: [{ ...v10.prompts[0], error: "__pragma_queue_steer_pending__:" }],
      }),
    ).toThrow("Queue-steer marker is missing its source Execution");
  });

  it("treats current v11 state as a no-op and rejects future state", async () => {
    const fixture = await readFixture("expert-session-transaction-v8.json");
    const current = expertSessionTransactionMigrationChain.upgrade(fixture).value;

    expect(expertSessionTransactionMigrationChain.upgrade(current)).toMatchObject({
      fromVersion: 11,
      toVersion: 11,
      migrated: false,
    });
    expect(() =>
      expertSessionTransactionMigrationChain.upgrade({
        ...current,
        schemaVersion: "pragma.expert-session-transaction/v12",
      }),
    ).toThrow(
      "pragma.expert-session-transaction/v12 is newer than the supported pragma.expert-session-transaction/v11",
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
      schemaVersion: "pragma.expert-session/v7",
      sessionId: "historical-session",
      activeExecutionId: "historical-execution",
    });
    await expect(executions.get("historical-execution")).resolves.toMatchObject({
      schemaVersion: "pragma.execution/v11",
    });
    await expect(
      executions.getInvocation("historical-execution", "historical-execution"),
    ).resolves.toMatchObject({ pendingExpertMessages: [] });
    await expect(readFile(transactionPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("upgrades and idempotently replays an unfinished queue-marker transaction", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-session-queue-marker-"));
    temporaryRoots.push(home);
    const paths = new PragmaPaths({ pragmaHome: home });
    const transactionPath = paths.expertSessionTransaction("queue-marker-session");
    await mkdir(dirname(transactionPath), { recursive: true });
    await writeFile(
      transactionPath,
      `${JSON.stringify(
        await readFixture("expert-session-transaction-v9-queue-marker-4ddb0eba.json"),
      )}\n`,
      "utf8",
    );
    const executions = createFileExecutionStore({ pragmaHome: home });
    const sessions = createFileExpertSessionStore({ executions, pragmaHome: home });

    await expect(sessions.get("queue-marker-session")).resolves.toMatchObject({
      sessionId: "queue-marker-session",
      activeExecutionId: "active-execution",
    });
    await expect(sessions.listPrompts("queue-marker-session")).resolves.toMatchObject([
      {
        requestId: "queued-request",
        deliveryAttempt: {
          attemptId: "legacy-queue-steer:queued-request",
          sourceExecutionId: "queued-execution",
          targetExecutionId: "active-execution",
          state: "dispatching",
        },
      },
    ]);
    await expect(readFile(transactionPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await expect(sessions.get("queue-marker-session")).resolves.toMatchObject({
      sessionId: "queue-marker-session",
    });
    await expect(sessions.listPrompts("queue-marker-session")).resolves.toHaveLength(1);
  });

  it("atomically migrates a committed v6 queue marker without a transaction journal", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-session-committed-queue-marker-"));
    temporaryRoots.push(home);
    const paths = new PragmaPaths({ pragmaHome: home });
    const fixture = (await readFixture(
      "expert-session-transaction-v9-queue-marker-4ddb0eba.json",
    )) as {
      readonly session: unknown;
      readonly prompts: readonly unknown[];
      readonly events: readonly { readonly type: string; readonly data: unknown }[];
    };
    const v6Session = expertSessionV5ToV6Step.migrate(fixture.session);
    const v6Prompts = migratePromptPurposes(fixture.prompts, fixture.events);
    await mkdir(paths.expertSessionRoot("queue-marker-session"), { recursive: true });
    await writeFile(
      paths.expertSessionState("queue-marker-session"),
      `${JSON.stringify(v6Session)}\n`,
      "utf8",
    );
    await writeFile(
      paths.expertSessionPrompts("queue-marker-session"),
      `${JSON.stringify(v6Prompts)}\n`,
      "utf8",
    );
    await writeFile(
      paths.expertSessionEvents("queue-marker-session"),
      `${JSON.stringify(fixture.events)}\n`,
      "utf8",
    );
    const executions = createFileExecutionStore({ pragmaHome: home });
    const sessions = createFileExpertSessionStore({ executions, pragmaHome: home });

    await expect(sessions.get("queue-marker-session")).resolves.toMatchObject({
      schemaVersion: "pragma.expert-session/v7",
    });
    await expect(sessions.listPrompts("queue-marker-session")).resolves.toMatchObject([
      {
        requestId: "queued-request",
        deliveryAttempt: {
          attemptId: "legacy-queue-steer:queued-request",
          sourceExecutionId: "queued-execution",
          targetExecutionId: "active-execution",
          state: "dispatching",
        },
      },
    ]);
    await expect(
      readFile(paths.expertSessionMigration("queue-marker-session"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replays an unfinished v6 to v7 ExpertSession state migration", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-session-marker-migration-replay-"));
    temporaryRoots.push(home);
    const paths = new PragmaPaths({ pragmaHome: home });
    const fixture = (await readFixture(
      "expert-session-transaction-v9-queue-marker-4ddb0eba.json",
    )) as {
      readonly session: unknown;
      readonly prompts: readonly unknown[];
      readonly events: readonly { readonly type: string; readonly data: unknown }[];
    };
    const sessionId = "queue-marker-session";
    const v6Session = expertSessionV5ToV6Step.migrate(fixture.session);
    const v6Prompts = migratePromptPurposes(fixture.prompts, fixture.events);
    const v7Session = expertSessionV6ToV7Step.migrate(v6Session);
    const v7Prompts = migrateQueueSteerDeliveryAttempts(v6Prompts);
    await mkdir(paths.expertSessionRoot(sessionId), { recursive: true });
    await writeFile(paths.expertSessionState(sessionId), `${JSON.stringify(v7Session)}\n`, "utf8");
    await writeFile(
      paths.expertSessionPrompts(sessionId),
      `${JSON.stringify(v6Prompts)}\n`,
      "utf8",
    );
    await writeFile(
      paths.expertSessionEvents(sessionId),
      `${JSON.stringify(fixture.events)}\n`,
      "utf8",
    );
    await writeFile(
      paths.expertSessionMigration(sessionId),
      `${JSON.stringify({
        schemaVersion: "pragma.state-migration/v1",
        resource: { family: "pragma.expert-session", id: sessionId },
        fromVersion: 6,
        toVersion: 7,
        documents: { "session.json": v7Session, "prompts.json": v7Prompts },
      })}\n`,
      "utf8",
    );
    const executions = createFileExecutionStore({ pragmaHome: home });
    const sessions = createFileExpertSessionStore({ executions, pragmaHome: home });

    await expect(sessions.get(sessionId)).resolves.toMatchObject({
      schemaVersion: "pragma.expert-session/v7",
    });
    await expect(sessions.listPrompts(sessionId)).resolves.toMatchObject([
      { deliveryAttempt: { sourceExecutionId: "queued-execution", state: "dispatching" } },
    ]);
    await expect(readFile(paths.expertSessionMigration(sessionId), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

async function readFixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"),
  ) as unknown;
}
