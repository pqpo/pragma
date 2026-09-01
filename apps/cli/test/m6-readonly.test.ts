import { describe, expect, it, vi } from "vitest";

import { CliEventV2StreamSchema, createIntegrationError } from "@pragma/shared/integration";

import { runCli, type CliIo, type CliLocalHost } from "../src/index.ts";
import { parseCliArgv } from "../src/parser/argv.ts";

const MISSION_ID = "11111111-1111-4111-8111-111111111111";
const EXECUTOR_ID = "aaaaaaaaaaaaaaaa";
const EXECUTOR_REF = `expert:${EXECUTOR_ID}`;

function createIo(): CliIo & {
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    writeStdout: (value) => stdout.push(value),
    writeStderr: (value) => stderr.push(value),
  };
}

function createHost(
  options: {
    readonly executorKind?: "team" | "expert" | "flow";
    readonly executorStatus?: "ready" | "needs_attention" | "unavailable";
  } = {},
): CliLocalHost & {
  readonly calls: { readonly boardRead: unknown[]; readonly boardSearch: unknown[] };
} {
  const calls = { boardRead: [] as unknown[], boardSearch: [] as unknown[] };
  const executorKind = options.executorKind ?? ("expert" as const);
  const executor = {
    schemaVersion: "pragma.integration-executor/v1" as const,
    ref: { kind: executorKind, id: EXECUTOR_ID },
    name: "Research Expert",
    description: "Fixture executor",
    source: "built_in" as const,
    availability: { status: options.executorStatus ?? ("ready" as const), blockingCodes: [] },
    workspace: { required: true, allowNonGitDirectory: true },
    capabilities: {
      interactive: true,
      resumable: true,
      steerable: true,
      supportsQueue: true,
    },
  };
  return {
    calls,
    integrationCapability: async () => ({
      schemaVersion: "pragma.integration-capability/v1",
      protocol: "pragma.integration/v1",
      readableVersions: ["pragma.integration/v1"],
      migratableFromVersions: [],
      features: ["catalog.query", "mission.query", "board.shared.read", "mission.queue.read"],
    }),
    listExecutors: async () => [executor],
    getMission: async () => ({
      snapshot: { missionId: MISSION_ID, eventSequence: 0 },
      cursor: "fixture-cursor",
      events: [],
    }),
    queryMission: async ({ missionId, view }) => {
      if (view === "summary") {
        return {
          schemaVersion: "pragma.mission-summary/v1",
          missionId,
          status: "succeeded",
          lifecycleStatus: "completed",
          executor: { kind: executorKind, id: EXECUTOR_ID },
          createdAt: "2026-08-27T00:00:00.000Z",
          updatedAt: "2026-08-27T00:00:01.000Z",
          eventSequence: 1,
          cursor: "fixture-cursor",
        };
      }
      if (view === "result") {
        return {
          schemaVersion: "pragma.mission-result/v1",
          missionId,
          status: "succeeded",
          available: true,
          result: { status: "succeeded" },
        };
      }
      return {
        schemaVersion: "pragma.mission-events/v1",
        missionId,
        items: [],
      };
    },
    listMissions: async () => [
      { id: MISSION_ID, title: "Fixture Mission", lifecycleStatus: "succeeded" },
      {
        id: "22222222-2222-4222-8222-222222222222",
        title: "Second Mission",
        lifecycleStatus: "queued",
      },
    ],
    listSharedBoard: async () => [
      {
        id: "plan.md",
        metadata: { trigger: "model_decision", priority: "high", description: "Plan" },
        etag: "rev-1",
        sizeBytes: 12,
      },
    ],
    readSharedBoard: async (...args) => {
      calls.boardRead.push(args);
      return {
        id: "plan.md",
        metadata: { trigger: "manual", priority: "normal" },
        etag: "rev-1",
        content: "line one\nline two\n",
        contentRange: {
          requestedStartOffset: args[2],
          startOffset: args[2],
          endOffset: args[2] + 9,
          nextStartOffset: args[2] + 9,
          truncated: true,
          sizeBytes: 20,
        },
      };
    },
    searchSharedBoard: async (...args) => {
      calls.boardSearch.push(args);
      return [{ id: "plan.md", lineNumber: 2, line: "line two" }];
    },
    listMissionQueue: async () => [{ requestId: "queue-1", state: "queued" }],
  };
}

function jsonOutput(io: ReturnType<typeof createIo>): Record<string, unknown> {
  expect(io.stderr).toEqual([]);
  expect(io.stdout).toHaveLength(1);
  return JSON.parse(io.stdout[0]!);
}

function completionContextLine(script: string, marker: string): string {
  const line = script.split("\n").find((candidate) => candidate.includes(marker));
  if (line === undefined) throw new Error(`Missing completion context: ${marker}`);
  return line;
}

function completionLineHasOption(line: string, option: string): boolean {
  return line.split(/[\s,'"]+/u).includes(option);
}

describe("M6 parser and read-only command surface", () => {
  it("keeps the frozen parser shape for Unicode, Windows-like quoting, ranges, and aliases", () => {
    expect(
      parseCliArgv([
        "mission",
        "board",
        "read",
        "任务 目录/计划.md",
        "context with spaces",
        "--start=12",
        "--offset",
        "64",
        "--format=json",
      ]),
    ).toMatchInlineSnapshot(`
      {
        "command": {
          "contextId": "context with spaces",
          "kind": "board-read",
          "maxBytes": 64,
          "missionId": "任务 目录/计划.md",
          "start": 12,
        },
        "options": {
          "color": "auto",
          "format": "json",
          "interactive": "auto",
        },
      }
    `);
    expect(parseCliArgv(["mission", "list", "--stream-json"]).options.format).toBe("jsonl");
  });

  it("supports POSIX option termination and inline values that begin with --", () => {
    expect(parseCliArgv(["mission", "board", "search", MISSION_ID, "--", "--test"])).toMatchObject({
      command: { kind: "board-search", missionId: MISSION_ID, query: "--test" },
    });
    expect(parseCliArgv(["expert", "discover", "--query=--test"]).command).toMatchObject({
      kind: "executor-discover",
      query: "--test",
    });
    expect(
      parseCliArgv(["mission", "board", "search", MISSION_ID, "--", "--format=json"]),
    ).toMatchObject({
      options: { format: "text" },
      command: { kind: "board-search", query: "--format=json" },
    });
    expect(() => parseCliArgv(["expert", "discover", "--query", "--test"])).toThrow(
      "Option --query requires a value.",
    );
  });

  it("accepts only an exact project/revision pair for Mission pinned backfill", () => {
    const parsed = parseCliArgv([
      "mission",
      "resume",
      MISSION_ID,
      "--project",
      "studio",
      "--revision",
      "7",
      "--expected-fingerprint",
      "a".repeat(64),
    ]);
    expect(parsed.command).toEqual({
      kind: "mission-resume",
      missionId: MISSION_ID,
      project: "studio",
      revision: 7,
      expectedFingerprint: "a".repeat(64),
    });
    expect(() => parseCliArgv(["mission", "resume", MISSION_ID, "--project", "studio"])).toThrow(
      "provided together",
    );
    expect(() =>
      parseCliArgv(["mission", "resume", MISSION_ID, "--expected-fingerprint", "a".repeat(64)]),
    ).toThrow("requires --project and --revision");
  });

  it("keeps Mission resume help options aligned with the parser", async () => {
    const helpIo = createIo();
    await expect(
      runCli(["mission", "resume", "--help", "--format=json"], helpIo, {
        localHost: createHost(),
      }),
    ).resolves.toBe(0);
    const help = jsonOutput(helpIo).result as { readonly help: string };
    expect(help.help).not.toContain("--wait");
    for (const option of [
      "--project",
      "--revision",
      "--expected-fingerprint",
      "--request-id",
      "--detach",
    ]) {
      expect(help.help).toContain(option);
    }

    const parsed = parseCliArgv([
      "mission",
      "resume",
      MISSION_ID,
      "--project",
      "studio",
      "--revision",
      "7",
      "--expected-fingerprint",
      "a".repeat(64),
      "--request-id",
      MISSION_ID,
      "--detach",
      "--format=json",
    ]);
    expect(parsed.options.format).toBe("json");
    expect(parsed.command).toMatchObject({
      kind: "mission-resume",
      missionId: MISSION_ID,
      project: "studio",
      revision: 7,
      expectedFingerprint: "a".repeat(64),
      requestId: MISSION_ID,
      detach: true,
    });
  });

  it.each(["team", "expert", "flow"] as const)(
    "accepts and filters unavailable %s executors",
    async (executorKind) => {
      const io = createIo();
      await expect(
        runCli([executorKind, "discover", "--status=unavailable", "--format=json"], io, {
          localHost: createHost({ executorKind, executorStatus: "unavailable" }),
        }),
      ).resolves.toBe(0);
      expect(jsonOutput(io).result.items).toHaveLength(1);
      expect(jsonOutput(io).result.items[0].availability.status).toBe("unavailable");
    },
  );

  it("supports canonical, name/description, and invalid discover selectors", async () => {
    const exactIo = createIo();
    await expect(
      runCli(["expert", "discover", EXECUTOR_REF, "--format=json"], exactIo, {
        localHost: createHost(),
      }),
    ).resolves.toBe(0);
    expect(jsonOutput(exactIo).result.items).toHaveLength(1);

    const keywordIo = createIo();
    await expect(
      runCli(["expert", "discover", "fixture", "--format=json"], keywordIo, {
        localHost: createHost(),
      }),
    ).resolves.toBe(0);
    expect(jsonOutput(keywordIo).result.items).toHaveLength(1);

    const missingIo = createIo();
    await expect(
      runCli(["expert", "discover", "expert:bbbbbbbbbbbbbbbb", "--format=json"], missingIo, {
        localHost: createHost(),
      }),
    ).resolves.toBe(3);
    expect(jsonOutput(missingIo).error.code).toBe("EXECUTOR_NOT_FOUND");

    const conflictIo = createIo();
    await expect(
      runCli(["expert", "discover", "fixture", "--query", "research", "--format=json"], conflictIo),
    ).resolves.toBe(2);
    expect(jsonOutput(conflictIo).error.code).toBe("INVALID_ARGUMENT");

    const crossKindIo = createIo();
    await expect(
      runCli(["expert", "discover", "team:bbbbbbbbbbbbbbbb", "--format=json"], crossKindIo),
    ).resolves.toBe(2);
    expect(jsonOutput(crossKindIo).error.code).toBe("INVALID_ARGUMENT");

    const textIo = createIo();
    await expect(runCli(["expert", "discover"], textIo, { localHost: createHost() })).resolves.toBe(
      0,
    );
    expect(textIo.stdout.join("")).toContain("REF\tNAME\tSTATUS\tSOURCE");
    expect(textIo.stdout.join("")).toContain(`${EXECUTOR_REF}\tResearch Expert\tready\tbuilt_in`);
  });

  it("folds executor description whitespace only in the text table", async () => {
    const host = createHost();
    const executor = (await host.listExecutors())[0]!;
    const rawDescription = " first\nsecond\r\nthird\tfourth ";
    const describedHost: CliLocalHost = {
      ...host,
      listExecutors: async () => [{ ...executor, description: rawDescription }],
    };

    const textIo = createIo();
    await expect(
      runCli(["expert", "discover"], textIo, { localHost: describedHost }),
    ).resolves.toBe(0);
    const textLines = textIo.stdout.join("").trimEnd().split("\n");
    expect(textLines).toHaveLength(2);
    expect(textLines[1]!.split("\t")).toHaveLength(6);
    expect(textLines[1]).toContain("first second third fourth");

    const jsonIo = createIo();
    await expect(
      runCli(["expert", "discover", "--format=json"], jsonIo, { localHost: describedHost }),
    ).resolves.toBe(0);
    const machineResult = jsonOutput(jsonIo).result as {
      readonly items: readonly { readonly description: string }[];
    };
    expect(machineResult.items[0]?.description).toBe(rawDescription);
  });

  it("returns every executor matching a selector substring", async () => {
    const host = createHost();
    const executors = await host.listExecutors();
    const first = executors[0]!;
    const multiHost: CliLocalHost = {
      ...host,
      listExecutors: async () => [
        first,
        {
          ...first,
          ref: { kind: "expert", id: "bbbbbbbbbbbbbbbb" },
          name: "Fixture Specialist",
          description: "Another fixture executor",
        },
      ],
    };
    const io = createIo();
    await expect(
      runCli(["expert", "discover", "fixture", "--format=json"], io, {
        localHost: multiHost,
      }),
    ).resolves.toBe(0);
    expect(jsonOutput(io).result.items).toHaveLength(2);
  });

  it("normalizes all supported Mission executor reference shapes for filtering", async () => {
    const host = createHost();
    const variants = [
      { id: "11111111-1111-4111-8111-111111111111", executor: { kind: "expert", id: EXECUTOR_ID } },
      { id: "22222222-2222-4222-8222-222222222222", executor: EXECUTOR_REF },
      {
        id: "33333333-3333-4333-8333-333333333333",
        executor: { ref: { kind: "expert", id: EXECUTOR_ID } },
      },
      { id: "44444444-4444-4444-8444-444444444444", executor: { kind: "team", id: EXECUTOR_ID } },
      {
        id: "55555555-5555-4555-8555-555555555555",
        executor: { kind: "expert", id: "bbbbbbbbbbbbbbbb" },
      },
    ];
    const filteredHost: CliLocalHost = {
      ...host,
      listMissions: async () => variants,
    };
    const io = createIo();
    await expect(
      runCli(["mission", "list", "--executor", EXECUTOR_REF, "--format=json"], io, {
        localHost: filteredHost,
      }),
    ).resolves.toBe(0);
    expect(jsonOutput(io).result.items.map((item: { readonly id: string }) => item.id)).toEqual(
      variants.slice(0, 3).map((variant) => variant.id),
    );
  });

  it("uses the Local Host query contract and fails loudly for chat/work", async () => {
    const host = createHost();
    const calls: unknown[] = [];
    const queryHost: CliLocalHost = {
      ...host,
      queryMission: async (input) => {
        calls.push(input);
        return {
          schemaVersion: "pragma.mission-events/v1",
          missionId: input.missionId,
          items: [],
        };
      },
    };
    const eventsIo = createIo();
    await expect(
      runCli(
        [
          "mission",
          "get",
          MISSION_ID,
          "--view",
          "events",
          "--limit",
          "1",
          "--cursor",
          "cursor-1",
          "--format=json",
        ],
        eventsIo,
        { localHost: queryHost },
      ),
    ).resolves.toBe(0);
    expect(calls).toEqual([
      { missionId: MISSION_ID, view: "events", limit: 1, cursor: "cursor-1" },
    ]);

    const chatIo = createIo();
    await expect(
      runCli(["mission", "get", MISSION_ID, "--view", "chat", "--format=json"], chatIo, {
        localHost: queryHost,
      }),
    ).resolves.toBe(2);
    expect(jsonOutput(chatIo).error).toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { view: "chat", supportedViews: ["summary", "result", "events"] },
    });
    expect(calls).toHaveLength(1);

    const resultIo = createIo();
    const runningHost: CliLocalHost = {
      ...host,
      queryMission: async ({ missionId, view }) =>
        view === "result"
          ? {
              schemaVersion: "pragma.mission-result/v1",
              missionId,
              executionId: "33333333-3333-4333-8333-333333333333",
              status: "running",
              available: false,
            }
          : {
              schemaVersion: "pragma.mission-events/v1",
              missionId,
              items: [],
            },
    };
    await expect(
      runCli(["mission", "get", MISSION_ID, "--view", "result"], resultIo, {
        localHost: runningHost,
      }),
    ).resolves.toBe(0);
    expect(resultIo.stdout.join("")).toContain(`MISSION ID: ${MISSION_ID}`);
    expect(resultIo.stdout.join("")).toContain(`NEXT: mission watch ${MISSION_ID}`);
  });

  it("shows generated/explicit run identity in text without adding machine side channels", async () => {
    const start = vi.fn(async (request: { readonly requestId: string }) => ({
      request,
      missionId: MISSION_ID,
      payloadHash: `sha256:${"a".repeat(64)}`,
      disposition: "reserved" as const,
      executionId: "33333333-3333-4333-8333-333333333333",
      outcome: Promise.resolve({
        status: "accepted" as const,
        missionId: MISSION_ID,
        executionId: "33333333-3333-4333-8333-333333333333",
        executor: { kind: "expert" as const, id: EXECUTOR_ID },
        workspace: {
          schemaVersion: "pragma.integration-workspace/v1" as const,
          requestedPath: "/workspace",
          canonicalPath: "/workspace",
          displayName: "workspace",
          identityHash: `sha256:${"b".repeat(64)}`,
          access: { exists: true, readable: true, writable: true },
          source: "explicit" as const,
        },
        result: { detached: true },
      }),
      cancel: async () => undefined,
    }));
    const host: CliLocalHost = {
      ...createHost(),
      resolveWorkspace: async (requestedPath) => ({
        schemaVersion: "pragma.integration-workspace/v1",
        requestedPath,
        canonicalPath: "/workspace",
        displayName: "workspace",
        identityHash: `sha256:${"b".repeat(64)}`,
        access: { exists: true, readable: true, writable: true },
        source: "explicit",
      }),
      run: { start } as never,
    };

    const generatedIo = createIo();
    await expect(
      runCli(
        [
          "expert",
          "run",
          EXECUTOR_REF,
          "--workspace",
          "/workspace",
          "--prompt",
          "hello",
          "--detach",
        ],
        generatedIo,
        { localHost: host },
      ),
    ).resolves.toBe(0);
    const generatedRequestId = start.mock.calls[0]?.[0].requestId;
    expect(generatedRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(generatedIo.stderr.join("")).toContain(
      `Request ID: ${generatedRequestId} (generated; reuse with --request-id for an exact retry)`,
    );
    expect(generatedIo.stderr.join("")).toContain(`Mission ID: ${MISSION_ID}`);
    expect(generatedIo.stderr.join("")).toContain(
      "Execution ID: 33333333-3333-4333-8333-333333333333",
    );
    expect(generatedIo.stdout.join("")).toContain(`request ${generatedRequestId}`);

    const explicitId = "44444444-4444-4444-8444-444444444444";
    const machineIo = createIo();
    await expect(
      runCli(
        [
          "expert",
          "run",
          EXECUTOR_REF,
          "--workspace",
          "/workspace",
          "--prompt",
          "hello",
          "--request-id",
          explicitId,
          "--detach",
          "--format=json",
        ],
        machineIo,
        { localHost: host },
      ),
    ).resolves.toBe(0);
    expect(machineIo.stderr).toEqual([]);
    expect(machineIo.stdout).toHaveLength(1);
    expect(JSON.parse(machineIo.stdout[0]!).requestId).toBe(explicitId);
    expect(start.mock.calls[1]?.[0].requestId).toBe(explicitId);

    const failureIo = createIo();
    const failureStart = vi.fn(async () => {
      throw createIntegrationError({
        code: "EXECUTION_FAILED",
        category: "execution",
        message: "fixture failed",
        retryable: false,
      });
    });
    await expect(
      runCli(
        [
          "expert",
          "run",
          EXECUTOR_REF,
          "--workspace",
          "/workspace",
          "--prompt",
          "hello",
          "--request-id",
          explicitId,
        ],
        failureIo,
        { localHost: { ...host, run: { start: failureStart } as never } },
      ),
    ).resolves.toBe(10);
    expect(failureIo.stderr.join("")).toContain(`Request ID: ${explicitId}`);
  });

  it("rejects an unknown executor status with the usage exit code", async () => {
    const io = createIo();
    await expect(runCli(["team", "discover", "--status=unknown"], io)).resolves.toBe(2);
    expect(io.stderr.join("\n")).toContain("--status must be one of");
  });

  it("rejects mutually exclusive output formats with exit 2 and keeps machine output clean", async () => {
    const io = createIo();
    await expect(runCli(["version", "--json", "--stream-json"], io)).resolves.toBe(2);
    expect(io.stderr).toEqual([]);
    expect(jsonOutput(io).error.message).toContain("mutually exclusive");
  });

  it("renders every M6 query command as text and as one shared JSON result", async () => {
    const cases = [
      { argv: ["version"], command: "version" },
      { argv: ["completion", "bash"], command: "completion" },
      { argv: ["team", "discover"], command: "team.discover" },
      { argv: ["team", "describe", EXECUTOR_REF], command: "team.describe" },
      { argv: ["expert", "discover"], command: "expert.discover" },
      { argv: ["flow", "discover"], command: "flow.discover" },
      { argv: ["mission", "list"], command: "mission.list" },
      { argv: ["mission", "get", MISSION_ID], command: "mission.get" },
      { argv: ["mission", "board", "list", MISSION_ID], command: "mission.board.list" },
      { argv: ["mission", "board", "read", MISSION_ID, "plan.md"], command: "mission.board.read" },
      { argv: ["mission", "board", "search", MISSION_ID, "line"], command: "mission.board.search" },
      { argv: ["mission", "queue", "list", MISSION_ID], command: "mission.queue.list" },
    ] as const;

    for (const testCase of cases) {
      const textIo = createIo();
      const textCode = await runCli(testCase.argv, textIo, { localHost: createHost() });
      expect(textCode, testCase.command).toBe(0);
      if (testCase.command === "mission.board.search") {
        expect(textIo.stdout.join(""), testCase.command).toBe("plan.md:2\tline two\n");
      } else {
        expect(textIo.stdout.join(""), testCase.command).not.toBe("");
      }
      expect(textIo.stderr, testCase.command).toEqual([]);

      const jsonIo = createIo();
      const jsonCode = await runCli([...testCase.argv, "--format=json"], jsonIo, {
        localHost: createHost(),
      });
      expect(jsonCode, testCase.command).toBe(0);
      const result = jsonOutput(jsonIo);
      expect(result).toMatchObject({
        schemaVersion: "pragma.cli-result/v2",
        command: testCase.command,
        status: "succeeded",
      });
    }
  });

  it("uses copyable Mission and queue text columns", async () => {
    const missionIo = createIo();
    await expect(runCli(["mission", "list"], missionIo, { localHost: createHost() })).resolves.toBe(
      0,
    );
    const missionText = missionIo.stdout.join("");
    expect(missionText).toContain("MISSION ID\tSTATUS\tEXECUTOR\tUPDATED\tWORKSPACE");
    expect(missionText).toContain(MISSION_ID);
    expect(missionText).not.toContain("Fixture Mission");

    const queueIo = createIo();
    await expect(
      runCli(["mission", "queue", "list", MISSION_ID], queueIo, {
        localHost: createHost(),
      }),
    ).resolves.toBe(0);
    const queueText = queueIo.stdout.join("");
    expect(queueText).toContain("state:");
    expect(queueText).toContain("pendingCount:");
    expect(queueText).toContain("supportsSteer:");
    expect(queueText).toContain("POSITION\tREQUEST ID\tSTATUS\tSTEERABLE\tCONTENT PREVIEW");
    expect(queueText).toContain("queue-1");
  });

  it("renders multiple Board matches and an explicit empty result in text mode", async () => {
    const host = createHost();
    const multiHost: CliLocalHost = {
      ...host,
      searchSharedBoard: async () => [
        { id: "plan.md", lineNumber: 2, line: "line two" },
        { id: "todos.md", lineNumber: 4, line: "line four" },
      ],
    };
    const multiIo = createIo();
    await expect(
      runCli(["mission", "board", "search", MISSION_ID, "line"], multiIo, {
        localHost: multiHost,
      }),
    ).resolves.toBe(0);
    expect(multiIo.stdout.join("")).toBe("plan.md:2\tline two\ntodos.md:4\tline four\n");

    const emptyIo = createIo();
    await expect(
      runCli(["mission", "board", "search", MISSION_ID, "missing"], emptyIo, {
        localHost: { ...host, searchSharedBoard: async () => [] },
      }),
    ).resolves.toBe(0);
    expect(emptyIo.stdout.join("")).toBe("No matches found.\n");
  });

  it("emits one result envelope or a two-event JSONL stream", async () => {
    const successIo = createIo();
    await expect(
      runCli(["mission", "list", "--stream-json"], successIo, { localHost: createHost() }),
    ).resolves.toBe(0);
    const successEvents = successIo.stdout
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(successEvents).toHaveLength(2);
    expect(successEvents[0]).toMatchObject({
      schemaVersion: "pragma.cli-event/v2",
      type: "command.result",
    });
    expect(successEvents[1]).toMatchObject({
      schemaVersion: "pragma.cli-event/v2",
      type: "stream.end",
      data: { status: "succeeded", exitCode: 0 },
    });
    expect(() => CliEventV2StreamSchema.parse(successEvents)).not.toThrow();

    const failureIo = createIo();
    await expect(
      runCli(["mission", "list", "--stream-json"], failureIo, {
        localHost: {
          ...createHost(),
          listMissions: async () => {
            throw createIntegrationError({
              code: "DEPENDENCY_UNAVAILABLE",
              category: "dependency",
              message: "Mission store is unavailable.",
            });
          },
        },
      }),
    ).resolves.toBe(5);
    const failureEvents = failureIo.stdout
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(failureEvents).toHaveLength(1);
    expect(failureEvents[0]).toMatchObject({
      type: "stream.end",
      data: { status: "failed", exitCode: 5, error: { code: "DEPENDENCY_UNAVAILABLE" } },
    });
    expect(failureIo.stderr).toEqual([]);
    expect(() => CliEventV2StreamSchema.parse(failureEvents)).not.toThrow();
  });

  it("passes board byte ranges, search options, and shared namespace through the M3 facade", async () => {
    const host = createHost();
    const readIo = createIo();
    await expect(
      runCli(
        ["mission", "board", "read", MISSION_ID, "plan.md", "--start", "12", "--offset", "64"],
        readIo,
        { localHost: host },
      ),
    ).resolves.toBe(0);
    expect(host.calls.boardRead).toEqual([[MISSION_ID, "plan.md", 12, 64]]);

    const searchIo = createIo();
    await expect(
      runCli(
        [
          "mission",
          "board",
          "search",
          MISSION_ID,
          "Line",
          "--case-sensitive",
          "--context-lines",
          "1",
          "--max-results",
          "7",
          "--format=json",
        ],
        searchIo,
        { localHost: host },
      ),
    ).resolves.toBe(0);
    expect(host.calls.boardSearch).toEqual([
      [MISSION_ID, "Line", 7, { caseSensitive: true, contextLines: 1 }],
    ]);
    expect(JSON.parse(searchIo.stdout.join("")).result.matches[0].line).toBe(2);
  });

  it("binds local cursors to the command and filters", async () => {
    const host = createHost();
    const firstIo = createIo();
    await expect(
      runCli(["mission", "list", "--limit", "1", "--format=json"], firstIo, { localHost: host }),
    ).resolves.toBe(0);
    const first = jsonOutput(firstIo);
    expect(first.result.items).toHaveLength(1);
    expect(typeof first.result.nextCursor).toBe("string");

    const secondIo = createIo();
    await expect(
      runCli(
        ["mission", "list", "--limit", "1", "--cursor", first.result.nextCursor, "--format=json"],
        secondIo,
        { localHost: host },
      ),
    ).resolves.toBe(0);
    expect(jsonOutput(secondIo).result.items[0].id).toBe("22222222-2222-4222-8222-222222222222");

    const invalidIo = createIo();
    const invalidCursor = `pragma.cli.cursor.v1.${Buffer.from(JSON.stringify({ offset: 99 }), "utf8").toString("base64url")}`;
    await expect(
      runCli(["mission", "list", "--cursor", invalidCursor, "--format=json"], invalidIo, {
        localHost: host,
      }),
    ).resolves.toBe(2);
    expect(jsonOutput(invalidIo).error.code).toBe("CURSOR_INVALID");

    const crossCommandHost: CliLocalHost = {
      ...host,
      listExecutors: async () => [
        ...(await host.listExecutors()),
        {
          ...(await host.listExecutors())[0]!,
          ref: { kind: "expert", id: "bbbbbbbbbbbbbbbb" },
          name: "Second executor",
        },
      ],
    };
    const discoverIo = createIo();
    await expect(
      runCli(["expert", "discover", "--limit", "1", "--format=json"], discoverIo, {
        localHost: crossCommandHost,
      }),
    ).resolves.toBe(0);
    const discoverCursor = jsonOutput(discoverIo).result.nextCursor;
    expect(typeof discoverCursor).toBe("string");

    const crossCommandIo = createIo();
    await expect(
      runCli(["mission", "list", "--cursor", discoverCursor, "--format=json"], crossCommandIo, {
        localHost: crossCommandHost,
      }),
    ).resolves.toBe(2);
    expect(jsonOutput(crossCommandIo).error).toMatchObject({ code: "CURSOR_INVALID" });

    const filteredHost: CliLocalHost = {
      ...host,
      listMissions: async () => [
        { id: MISSION_ID, status: "succeeded" },
        { id: "22222222-2222-4222-8222-222222222222", status: "succeeded" },
        { id: "33333333-3333-4333-8333-333333333333", status: "queued" },
      ],
    };
    const filteredFirstIo = createIo();
    await expect(
      runCli(
        ["mission", "list", "--status", "succeeded", "--limit", "1", "--format=json"],
        filteredFirstIo,
        { localHost: filteredHost },
      ),
    ).resolves.toBe(0);
    const filteredFirst = jsonOutput(filteredFirstIo);
    const filteredCursor = filteredFirst.result.nextCursor;
    expect(typeof filteredCursor).toBe("string");

    const filteredSecondIo = createIo();
    await expect(
      runCli(
        [
          "mission",
          "list",
          "--status",
          "succeeded",
          "--limit",
          "1",
          "--cursor",
          filteredCursor,
          "--format=json",
        ],
        filteredSecondIo,
        { localHost: filteredHost },
      ),
    ).resolves.toBe(0);
    expect(jsonOutput(filteredSecondIo).result.items[0].id).toBe(
      "22222222-2222-4222-8222-222222222222",
    );

    const differentFilterIo = createIo();
    await expect(
      runCli(
        ["mission", "list", "--status", "queued", "--cursor", filteredCursor, "--format=json"],
        differentFilterIo,
        { localHost: filteredHost },
      ),
    ).resolves.toBe(2);
    expect(jsonOutput(differentFilterIo).error).toMatchObject({ code: "CURSOR_INVALID" });
  });

  it("keeps completion independent of Host and secret inspection", async () => {
    let queried = false;
    const host = createHost();
    const guardedHost: CliLocalHost = {
      ...host,
      listExecutors: async () => {
        queried = true;
        return await host.listExecutors();
      },
    };
    const io = createIo();
    await expect(
      runCli(["completion", "powershell", "--format=json"], io, { localHost: guardedHost }),
    ).resolves.toBe(0);
    expect(queried).toBe(false);
    expect(jsonOutput(io).result.shell).toBe("powershell");
  });

  it("keeps shell completion option candidates aligned with the parser", async () => {
    const scripts = new Map<"bash" | "zsh" | "fish" | "powershell", string>();
    for (const shell of ["bash", "zsh", "fish", "powershell"] as const) {
      const io = createIo();
      await expect(
        runCli(["completion", shell, "--format=json"], io, { localHost: createHost() }),
      ).resolves.toBe(0);
      scripts.set(shell, (jsonOutput(io).result as { readonly script: string }).script);
    }

    const globalOptions = [
      "--format",
      "--json",
      "--stream-json",
      "--color",
      "--interactive",
      "--help",
    ];
    for (const script of scripts.values()) {
      for (const option of globalOptions) {
        expect(completionLineHasOption(script, option)).toBe(true);
      }
    }

    const cases = [
      {
        shell: "bash",
        marker: '        send) candidates="--prompt',
        allowed: ["--prompt", "--input", "--request-id", "--wait", "--detach", "--ack-timeout"],
        forbidden: ["--expected-execution", "--request"],
      },
      {
        shell: "zsh",
        marker: "              send) _describe option '--prompt",
        allowed: ["--prompt", "--input", "--request-id", "--wait", "--detach", "--ack-timeout"],
        forbidden: ["--expected-execution", "--request"],
      },
      {
        shell: "fish",
        marker: "__pragma_mission_send' -a",
        allowed: ["--prompt", "--input", "--request-id", "--wait", "--detach", "--ack-timeout"],
        forbidden: ["--expected-execution", "--request"],
      },
      {
        shell: "powershell",
        marker: "$candidates = $globalOptions + @('--prompt','--input','--request-id'",
        allowed: ["--prompt", "--input", "--request-id", "--wait", "--detach", "--ack-timeout"],
        forbidden: ["--expected-execution", "--request"],
      },
      {
        shell: "bash",
        marker: '        steer) candidates="--prompt',
        allowed: [
          "--prompt",
          "--input",
          "--expected-execution",
          "--request-id",
          "--wait",
          "--detach",
          "--ack-timeout",
        ],
        forbidden: ["--request"],
      },
      {
        shell: "zsh",
        marker: "              steer) _describe option '--prompt",
        allowed: [
          "--prompt",
          "--input",
          "--expected-execution",
          "--request-id",
          "--wait",
          "--detach",
          "--ack-timeout",
        ],
        forbidden: ["--request"],
      },
      {
        shell: "fish",
        marker: "__pragma_mission_steer' -a",
        allowed: [
          "--prompt",
          "--input",
          "--expected-execution",
          "--request-id",
          "--wait",
          "--detach",
          "--ack-timeout",
        ],
        forbidden: ["--request"],
      },
      {
        shell: "powershell",
        marker: "$candidates = $globalOptions + @('--prompt','--input','--expected-execution'",
        allowed: [
          "--prompt",
          "--input",
          "--expected-execution",
          "--request-id",
          "--wait",
          "--detach",
          "--ack-timeout",
        ],
        forbidden: ["--request"],
      },
      {
        shell: "bash",
        marker: '            remove) candidates="--request',
        allowed: ["--request", "--request-id", "--ack-timeout"],
        forbidden: ["--expected-execution", "--wait", "--detach", "--prompt", "--input"],
      },
      {
        shell: "zsh",
        marker: "                    remove) _describe option '--request",
        allowed: ["--request", "--request-id", "--ack-timeout"],
        forbidden: ["--expected-execution", "--wait", "--detach", "--prompt", "--input"],
      },
      {
        shell: "fish",
        marker: "__pragma_queue_remove' -a",
        allowed: ["--request", "--request-id", "--ack-timeout"],
        forbidden: ["--expected-execution", "--wait", "--detach", "--prompt", "--input"],
      },
      {
        shell: "powershell",
        marker: "$candidates = $globalOptions + @('--request','--request-id','--ack-timeout'",
        allowed: ["--request", "--request-id", "--ack-timeout"],
        forbidden: ["--expected-execution", "--wait", "--detach", "--prompt", "--input"],
      },
      {
        shell: "bash",
        marker: '            resume) candidates="--request-id',
        allowed: ["--request-id", "--ack-timeout"],
        forbidden: [
          "--request",
          "--expected-execution",
          "--wait",
          "--detach",
          "--prompt",
          "--input",
        ],
      },
      {
        shell: "zsh",
        marker: "                    resume) _describe option '--request-id --ack-timeout",
        allowed: ["--request-id", "--ack-timeout"],
        forbidden: [
          "--request",
          "--expected-execution",
          "--wait",
          "--detach",
          "--prompt",
          "--input",
        ],
      },
      {
        shell: "fish",
        marker: "__pragma_queue_resume' -a",
        allowed: ["--request-id", "--ack-timeout"],
        forbidden: [
          "--request",
          "--expected-execution",
          "--wait",
          "--detach",
          "--prompt",
          "--input",
        ],
      },
      {
        shell: "powershell",
        marker: "$candidates = $globalOptions + @('--request-id','--ack-timeout'",
        allowed: ["--request-id", "--ack-timeout"],
        forbidden: [
          "--request",
          "--expected-execution",
          "--wait",
          "--detach",
          "--prompt",
          "--input",
        ],
      },
      {
        shell: "bash",
        marker: '            steer) candidates="--request',
        allowed: [
          "--request",
          "--request-id",
          "--expected-execution",
          "--wait",
          "--detach",
          "--ack-timeout",
        ],
        forbidden: ["--prompt", "--input"],
      },
      {
        shell: "zsh",
        marker: "                    steer) _describe option '--request --request-id",
        allowed: [
          "--request",
          "--request-id",
          "--expected-execution",
          "--wait",
          "--detach",
          "--ack-timeout",
        ],
        forbidden: ["--prompt", "--input"],
      },
      {
        shell: "fish",
        marker: "__pragma_queue_steer' -a",
        allowed: [
          "--request",
          "--request-id",
          "--expected-execution",
          "--wait",
          "--detach",
          "--ack-timeout",
        ],
        forbidden: ["--prompt", "--input"],
      },
      {
        shell: "powershell",
        marker:
          "$candidates = $globalOptions + @('--request','--request-id','--expected-execution'",
        allowed: [
          "--request",
          "--request-id",
          "--expected-execution",
          "--wait",
          "--detach",
          "--ack-timeout",
        ],
        forbidden: ["--prompt", "--input"],
      },
    ] as const;

    for (const completionCase of cases) {
      const line = completionContextLine(scripts.get(completionCase.shell)!, completionCase.marker);
      for (const option of completionCase.allowed) {
        expect(
          completionLineHasOption(line, option),
          `${completionCase.shell} ${completionCase.marker} missing ${option}: ${line}`,
        ).toBe(true);
      }
      for (const option of completionCase.forbidden) {
        expect(
          completionLineHasOption(line, option),
          `${completionCase.shell} ${completionCase.marker} contains ${option}: ${line}`,
        ).toBe(false);
      }
    }
  });

  it("provides command-specific help and preserves list filters in text continuation", async () => {
    const helpIo = createIo();
    await expect(
      runCli(["expert", "discover", "--help", "--format=json"], helpIo, {
        localHost: createHost(),
      }),
    ).resolves.toBe(0);
    expect(jsonOutput(helpIo).result.help).toContain("SELECTOR");

    const textIo = createIo();
    const host: CliLocalHost = {
      ...createHost(),
      listMissions: async () => [
        { id: MISSION_ID, lifecycleStatus: "succeeded" },
        { id: "22222222-2222-4222-8222-222222222222", lifecycleStatus: "succeeded" },
      ],
    };
    await expect(
      runCli(["mission", "list", "--status", "succeeded", "--limit", "1"], textIo, {
        localHost: host,
      }),
    ).resolves.toBe(0);
    expect(textIo.stdout.join("")).toContain(
      "Continue: pragma mission list --status succeeded --limit 1 --cursor",
    );
  });

  it("returns the same read-only result before and after the Desktop lifecycle changes", async () => {
    const host = createHost();
    const runningIo = createIo();
    const exitedIo = createIo();

    await expect(
      runCli(["mission", "list", "--format=json"], runningIo, { localHost: host }),
    ).resolves.toBe(0);
    await expect(
      runCli(["mission", "list", "--format=json"], exitedIo, { localHost: host }),
    ).resolves.toBe(0);

    expect(jsonOutput(runningIo).result).toEqual(jsonOutput(exitedIo).result);
  });

  it("returns stable exit codes for missing resources, private board, and corrupt/future state", async () => {
    const missingIo = createIo();
    const missingHost: CliLocalHost = {
      ...createHost(),
      queryMission: async () => {
        throw createIntegrationError({
          code: "MISSION_NOT_FOUND",
          category: "not_found",
          message: "Mission not found.",
        });
      },
    };
    await expect(
      runCli(["mission", "get", MISSION_ID, "--format=json"], missingIo, {
        localHost: missingHost,
      }),
    ).resolves.toBe(3);
    expect(jsonOutput(missingIo).error.code).toBe("MISSION_NOT_FOUND");

    const privateIo = createIo();
    const privateHost: CliLocalHost = {
      ...createHost(),
      listSharedBoard: async () => [{ id: "private.md", namespace: "private" }],
    };
    await expect(
      runCli(["mission", "board", "list", MISSION_ID, "--format=json"], privateIo, {
        localHost: privateHost,
      }),
    ).resolves.toBe(6);
    expect(jsonOutput(privateIo).error.code).toBe("PERMISSION_DENIED");

    const futureIo = createIo();
    const futureHost: CliLocalHost = {
      ...createHost(),
      listMissions: async () => {
        throw { code: "unsupported_schema", message: "future state" };
      },
    };
    await expect(
      runCli(["mission", "list", "--format=json"], futureIo, { localHost: futureHost }),
    ).resolves.toBe(7);
    expect(jsonOutput(futureIo).error.code).toBe("STORAGE_VERSION_UNSUPPORTED");
  });
});
