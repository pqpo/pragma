import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileExecutionStore, ExecutionWorkHistoryReader, PragmaPaths } from "../src/index.ts";

const temporaryRoots: string[] = [];
const occurredAt = "2026-07-23T08:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("Execution state migration", () => {
  it("lazily migrates a cancelled v5 team run and preserves Work subagent details", async () => {
    const home = await temporaryRoot("pragma-execution-v5-");
    const paths = new PragmaPaths({ pragmaHome: home });
    await writeLegacyExecution(paths, "team-run");

    const store = createFileExecutionStore({ pragmaHome: home });
    const reader = new ExecutionWorkHistoryReader(store);
    const records = await reader.listRecords({
      executionIds: ["team-run"],
      rootSessionId: "team-session",
    });

    expect(records).toMatchObject([
      {
        kind: "root",
        sessionId: "team-session",
        status: "cancelled",
        tasks: [{ invocationId: "root", output: { type: "inline", value: "team result" } }],
      },
      {
        kind: "agent",
        sessionId: "child",
        parentRecordId: "root:team-session",
        status: "cancelled",
        tasks: [
          {
            invocationId: "child",
            output: { type: "inline", value: { finding: "subagent detail" } },
          },
        ],
      },
      {
        kind: "task",
        sessionId: "task",
        parentRecordId: "invocation:team-run:child",
        status: "succeeded",
        tasks: [{ invocationId: "task", output: "task output remains raw" }],
      },
    ]);
    await expect(readJson(paths.executionState("team-run"))).resolves.toMatchObject({
      schemaVersion: "pragma.execution/v6",
      output: { type: "inline", value: { summary: "cancelled team" } },
    });
    await expect(readJson(paths.executionInvocations("team-run"))).resolves.toMatchObject([
      { output: { type: "inline", value: "team result" } },
      { output: { type: "inline", value: { finding: "subagent detail" } } },
      { output: "task output remains raw" },
    ]);
    await expect(readFile(paths.executionMigration("team-run"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not rewrite current Execution state on read", async () => {
    const home = await temporaryRoot("pragma-execution-current-");
    const paths = new PragmaPaths({ pragmaHome: home });
    const store = createFileExecutionStore({ pragmaHome: home });
    await store.create(
      {
        schemaVersion: "pragma.execution/v6",
        executionId: "current",
        version: 0,
        kind: "expert-turn",
        definition: { id: "expert", version: "1.0.0", kind: "expert" },
        rootInvocationId: "root",
        status: "running",
        input: "hello",
        state: {},
        lastAppliedSequence: 0,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
      {
        invocationId: "root",
        rootInvocationId: "root",
        definition: { id: "expert", version: "1.0.0", kind: "expert" },
        executorId: "expert",
        contextId: "context",
        status: "running",
        input: "hello",
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
    );
    const before = await readFile(paths.executionState("current"), "utf8");

    await expect(store.get("current")).resolves.toMatchObject({
      schemaVersion: "pragma.execution/v6",
    });

    expect(await readFile(paths.executionState("current"), "utf8")).toBe(before);
  });

  it("rejects a future Execution schema without mutating it", async () => {
    const home = await temporaryRoot("pragma-execution-future-");
    const paths = new PragmaPaths({ pragmaHome: home });
    const file = paths.executionState("future");
    const future = { schemaVersion: "pragma.execution/v7", executionId: "future" };
    await writeJson(file, future);
    const before = await readFile(file, "utf8");

    await expect(createFileExecutionStore({ pragmaHome: home }).get("future")).rejects.toThrow(
      "unsupported-state-version",
    );

    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("upgrades and replays an old pending transaction journal", async () => {
    const home = await temporaryRoot("pragma-execution-transaction-v6-");
    const paths = new PragmaPaths({ pragmaHome: home });
    await writeLegacyExecution(paths, "journal-run", { status: "running" });
    const transactionFile = paths.executionTransaction("journal-run");
    await writeJson(transactionFile, {
      schemaVersion: "pragma.execution-transaction/v6",
      commitId: "legacy-commit",
      signature: "a".repeat(64),
      execution: legacyExecution("journal-run", {
        version: 1,
        status: "succeeded",
        output: "journal result",
      }),
      invocations: [
        {
          ...legacyInvocations()[0],
          status: "succeeded",
          output: "journal invocation result",
        },
      ],
      agents: [],
      contexts: [],
      events: [],
      eventIds: [],
    });

    const store = createFileExecutionStore({ pragmaHome: home });
    await expect(store.get("journal-run")).resolves.toMatchObject({
      schemaVersion: "pragma.execution/v6",
      version: 1,
      status: "succeeded",
      output: { type: "inline", value: "journal result" },
    });
    await expect(store.listInvocations("journal-run")).resolves.toMatchObject([
      { output: { type: "inline", value: "journal invocation result" } },
    ]);
    await expect(readFile(transactionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function writeLegacyExecution(
  paths: PragmaPaths,
  executionId: string,
  override: { readonly status?: "running" | "cancelled" } = {},
): Promise<void> {
  await writeJson(
    paths.executionState(executionId),
    legacyExecution(executionId, { status: override.status ?? "cancelled" }),
  );
  await writeJson(paths.executionInvocations(executionId), legacyInvocations());
  await writeJson(paths.executionAgents(executionId), []);
  await writeJson(paths.executionContexts(executionId), []);
  await writeJson(paths.executionCommits(executionId), []);
  await mkdir(dirname(paths.executionEvents(executionId)), { recursive: true });
  await writeFile(paths.executionEvents(executionId), "", "utf8");
}

function legacyExecution(
  executionId: string,
  override: {
    readonly version?: number;
    readonly status?: "running" | "succeeded" | "cancelled";
    readonly output?: unknown;
  } = {},
): Record<string, unknown> {
  return {
    schemaVersion: "pragma.execution/v5",
    executionId,
    version: override.version ?? 0,
    kind: "expert-turn",
    definition: { id: "team", version: "1.0.0", kind: "expert-team" },
    rootInvocationId: "root",
    status: override.status ?? "cancelled",
    input: "investigate",
    state: {},
    output: "output" in override ? override.output : { summary: "cancelled team" },
    lastAppliedSequence: 0,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

function legacyInvocations(): Array<Record<string, unknown>> {
  return [
    {
      invocationId: "root",
      rootInvocationId: "root",
      definition: { id: "team", version: "1.0.0", kind: "expert-team" },
      executorId: "team",
      contextId: "root-context",
      status: "cancelled",
      input: "investigate",
      output: "team result",
      createdAt: occurredAt,
      updatedAt: occurredAt,
    },
    {
      invocationId: "child",
      rootInvocationId: "root",
      parentInvocationId: "root",
      definition: { id: "reviewer", version: "1.0.0", kind: "expert" },
      executorId: "reviewer",
      contextId: "child-context",
      status: "cancelled",
      input: "review",
      output: { finding: "subagent detail" },
      createdAt: occurredAt,
      updatedAt: occurredAt,
    },
    {
      invocationId: "task",
      rootInvocationId: "root",
      parentInvocationId: "child",
      definition: { id: "inspect", version: "1.0.0", kind: "task" },
      contextId: "child-context",
      status: "succeeded",
      input: "inspect files",
      output: "task output remains raw",
      createdAt: occurredAt,
      updatedAt: occurredAt,
    },
  ];
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}
