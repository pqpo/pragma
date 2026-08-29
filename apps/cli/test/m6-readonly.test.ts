import { describe, expect, it } from "vitest";

import { CliEventV2StreamSchema, createIntegrationError } from "@pragma/local-host/wire";

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
      id: MISSION_ID,
      title: "Fixture Mission",
      result: { status: "succeeded" },
      events: [{ type: "mission.created" }],
    }),
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

  it("supports local cursors for large in-memory lists", async () => {
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
      getMission: async () => {
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
