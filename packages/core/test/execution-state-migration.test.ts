import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
      schemaVersion: "pragma.execution/v10",
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
        schemaVersion: "pragma.execution/v10",
        executionId: "current",
        version: 0,
        kind: "expert-turn",
        definition: { id: "expert", kind: "expert" },
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
        definition: { id: "expert", kind: "expert" },
        executorId: "expert",
        contextId: "context",
        status: "running",
        pendingExpertMessages: [],
        input: "hello",
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
    );
    const before = await readFile(paths.executionState("current"), "utf8");

    await expect(store.get("current")).resolves.toMatchObject({
      schemaVersion: "pragma.execution/v10",
    });

    expect(await readFile(paths.executionState("current"), "utf8")).toBe(before);
  });

  it("migrates a v9 Invocation to an empty recoverable message Inbox", async () => {
    const home = await temporaryRoot("pragma-execution-v9-");
    const paths = new PragmaPaths({ pragmaHome: home });
    const fixture = (await readJson(
      fileURLToPath(new URL("./fixtures/execution-v9.json", import.meta.url)),
    )) as Record<string, unknown>;
    await writeJson(paths.executionState("v9-run"), fixture["execution"]);
    await writeJson(paths.executionInvocations("v9-run"), fixture["invocations"]);
    await writeJson(paths.executionAgents("v9-run"), fixture["agents"]);
    await writeJson(paths.executionContexts("v9-run"), fixture["contexts"]);
    await writeJson(paths.executionCommits("v9-run"), fixture["commits"]);
    await mkdir(dirname(paths.executionEvents("v9-run")), { recursive: true });
    await writeFile(paths.executionEvents("v9-run"), "", "utf8");

    const store = createFileExecutionStore({ pragmaHome: home });
    await expect(store.get("v9-run")).resolves.toMatchObject({
      schemaVersion: "pragma.execution/v10",
    });
    await expect(store.listInvocations("v9-run")).resolves.toMatchObject([
      { invocationId: "root", pendingExpertMessages: [] },
    ]);
  });

  it("migrates v6 definitions without wrapping Invocation handoffs a second time", async () => {
    const home = await temporaryRoot("pragma-execution-v6-");
    const paths = new PragmaPaths({ pragmaHome: home });
    await writeLegacyExecution(paths, "v6-run");
    await writeJson(paths.executionState("v6-run"), {
      ...legacyExecution("v6-run"),
      schemaVersion: "pragma.execution/v6",
      output: { type: "inline", value: { summary: "v6 result" } },
    });
    await writeJson(
      paths.executionInvocations("v6-run"),
      legacyInvocations().map((invocation) => ({
        ...invocation,
        ...((invocation.definition as { readonly kind: string }).kind === "task"
          ? {}
          : { output: { type: "inline", value: invocation.output } }),
      })),
    );

    const store = createFileExecutionStore({ pragmaHome: home });

    await expect(store.get("v6-run")).resolves.toMatchObject({
      schemaVersion: "pragma.execution/v10",
      definition: { id: "team", kind: "expert-team" },
      output: { type: "inline", value: { summary: "v6 result" } },
    });
    await expect(store.listInvocations("v6-run")).resolves.toMatchObject([
      {
        definition: { id: "team", kind: "expert-team" },
        output: { type: "inline", value: "team result" },
      },
      {
        definition: { id: "reviewer", kind: "expert" },
        output: { type: "inline", value: { finding: "subagent detail" } },
      },
      { definition: { id: "inspect", kind: "task" }, output: "task output remains raw" },
    ]);
  });

  it("marks migrated v7 usage precision as unknown", async () => {
    const home = await temporaryRoot("pragma-execution-v7-usage-");
    const paths = new PragmaPaths({ pragmaHome: home });
    await writeLegacyExecution(paths, "v7-usage");
    await writeJson(paths.executionState("v7-usage"), {
      ...legacyExecution("v7-usage"),
      schemaVersion: "pragma.execution/v7",
      definition: { id: "team", kind: "expert-team" },
      output: { type: "inline", value: "legacy output" },
      usage: {
        input: 100,
        output: 20,
        cacheRead: 10,
        cacheWrite: 5,
        totalTokens: 135,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
    });
    const invocations = legacyInvocations();
    await writeJson(paths.executionInvocations("v7-usage"), [
      {
        ...invocations[0],
        definition: { id: "team", kind: "expert-team" },
        output: { type: "inline", value: "legacy output" },
        usage: {
          input: 10,
          output: 2,
          cacheRead: 1,
          cacheWrite: 0,
          totalTokens: 13,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
      },
      ...invocations.slice(1).map((invocation) => ({
        ...invocation,
        definition: {
          id: (invocation.definition as { readonly id: string }).id,
          kind: (invocation.definition as { readonly kind: string }).kind,
        },
        ...((invocation.definition as { readonly kind: string }).kind === "task"
          ? {}
          : { output: { type: "inline", value: invocation.output } }),
      })),
    ]);

    await expect(
      createFileExecutionStore({ pragmaHome: home }).get("v7-usage"),
    ).resolves.toMatchObject({
      schemaVersion: "pragma.execution/v10",
      usage: {
        measurement: "unknown",
        input: 100,
        output: 20,
        cacheRead: 10,
        cacheWrite: 5,
        totalTokens: 135,
      },
    });
    const migratedInvocations = await createFileExecutionStore({
      pragmaHome: home,
    }).listInvocations("v7-usage");
    expect(migratedInvocations[0]).toMatchObject({
      usage: {
        measurement: "unknown",
        input: 10,
        output: 2,
        totalTokens: 13,
      },
    });
  });

  it("rejects a future Execution schema without mutating it", async () => {
    const home = await temporaryRoot("pragma-execution-future-");
    const paths = new PragmaPaths({ pragmaHome: home });
    const file = paths.executionState("future");
    const future = { schemaVersion: "pragma.execution/v11", executionId: "future" };
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
          usage: {
            input: 8,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 10,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        },
      ],
      agents: [],
      contexts: [],
      events: [],
      eventIds: [],
    });

    const store = createFileExecutionStore({ pragmaHome: home });
    await expect(store.get("journal-run")).resolves.toMatchObject({
      schemaVersion: "pragma.execution/v10",
      version: 1,
      status: "succeeded",
      output: { type: "inline", value: "journal result" },
    });
    await expect(store.listInvocations("journal-run")).resolves.toMatchObject([
      {
        output: { type: "inline", value: "journal invocation result" },
        usage: { measurement: "unknown", totalTokens: 10 },
      },
    ]);
    await expect(readFile(transactionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("upgrades and replays a real v10 pending transaction journal", async () => {
    const home = await temporaryRoot("pragma-execution-transaction-v10-");
    const paths = new PragmaPaths({ pragmaHome: home });
    await writeLegacyExecution(paths, "journal-v10-run", { status: "running" });
    const transactionFile = paths.executionTransaction("journal-v10-run");
    const fixture = await readJson(
      fileURLToPath(new URL("./fixtures/execution-transaction-v10.json", import.meta.url)),
    );
    await writeJson(transactionFile, fixture);

    const store = createFileExecutionStore({ pragmaHome: home });
    await expect(store.get("journal-v10-run")).resolves.toMatchObject({
      schemaVersion: "pragma.execution/v10",
      version: 1,
      status: "succeeded",
      output: { type: "inline", value: "journal-v10-result" },
    });
    await expect(store.listInvocations("journal-v10-run")).resolves.toMatchObject([
      {
        invocationId: "root",
        status: "succeeded",
        pendingExpertMessages: [],
      },
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
