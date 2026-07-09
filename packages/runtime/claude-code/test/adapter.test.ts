import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { ExpertAgent } from "@pragma/core";
import type { ExpertAgentHumanRequest, RuntimeSessionStorageContext } from "@pragma/core";

import { createClaudeCodeRuntime } from "../src/adapter.ts";
import { canUseClaudeCodeRuntime } from "../src/availability.ts";
import type { ClaudeCodeRuntimeSpawn } from "../src/types.ts";

describe("createClaudeCodeRuntime", () => {
  it("exposes runtime availability through the adapter", async () => {
    const adapter = createClaudeCodeRuntime({
      canUse: () => ({
        usable: true,
        details: {
          source: "test",
        },
      }),
    });

    await expect(adapter.canUse()).resolves.toEqual({
      usable: true,
      details: {
        source: "test",
      },
    });
  });

  it("probes Claude Code CLI availability", async () => {
    const fake = new FakeProbeProcess({
      exitCode: 0,
      stdout: "claude-code 1.2.3\n",
    });

    const availability = await canUseClaudeCodeRuntime({
      spawn: fake.spawn,
    });

    expect(fake.command).toBe("claude");
    expect(fake.args).toEqual(["--version"]);
    expect(availability).toEqual({
      usable: true,
      details: {
        executablePath: "claude",
        version: "claude-code 1.2.3",
      },
    });
  });

  it("rejects session creation when Claude Code is unavailable", async () => {
    const adapter = createClaudeCodeRuntime({
      canUse: () => ({
        usable: false,
        reason: "Claude Code test probe failed.",
      }),
    });
    const agent = await createTestAgent();

    await expect(adapter.createSession({ agent })).rejects.toThrow(
      "Runtime is not available: Claude Code Local (claude-code-local). Claude Code test probe failed.",
    );
  });

  it("starts Claude Code in CLI mode, streams a result, and captures the runtime session id", async () => {
    const fake = new FakeClaudeCodeCli([
      [
        { type: "system", session_id: "session-1" },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello" }],
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 2,
              output_tokens: 3,
            },
          },
        },
        { type: "result", session_id: "session-1", result: "Hello world" },
      ],
    ]);
    const synced: RuntimeSessionStorageContext[] = [];
    const agent = await createTestAgent();
    const sharedClaudeConfigDir = await mkdtemp(join(tmpdir(), "pragma-claude-shared-config-"));
    await writeFile(
      join(sharedClaudeConfigDir, "settings.json"),
      '{"env":{"ANTHROPIC_BASE_URL":"https://example.invalid"}}\n',
    );
    const adapter = createClaudeCodeRuntime({
      defaultModelName: "claude-sonnet-4-5",
      env: { CLAUDE_CONFIG_DIR: sharedClaudeConfigDir },
      spawn: fake.spawn,
      sessionSyncCallback: (context) => {
        synced.push(context);
      },
    });

    const session = await adapter.createSession({ agent });
    const handle = session.submit({ query: "Say hello" });
    const events = await collectAsync(handle.events);
    const result = await handle.result;

    expect(fake.command).toBe("claude");
    expect(fake.args).toContain("-p");
    expect(fake.args).toContain("--output-format");
    expect(fake.args).toContain("stream-json");
    expect(fake.args).toContain("--input-format");
    expect(fake.args).toContain("--bare");
    expect(fake.args).toContain("--strict-mcp-config");
    expect(fake.args).toContain("--permission-prompt-tool");
    expect(fake.args).toContain("mcp__pragma__request_tool_approval");
    expect(fake.args).toContain("--plugin-dir");
    expect(fake.args).toContain("--settings");
    expect(fake.args[fake.args.indexOf("--settings") + 1]).toBe(
      join(
        agent.workspace,
        ".pragma",
        "runtime-sessions",
        "claude-code",
        agent.id,
        "claude-config",
        "settings.json",
      ),
    );
    expect(fake.args).toContain("--model");
    expect(fake.args).toContain("claude-sonnet-4-5");
    expect(fake.env["CLAUDE_CONFIG_DIR"]).toBe(
      join(agent.workspace, ".pragma", "runtime-sessions", "claude-code", agent.id, "claude-config"),
    );
    expect(fake.inputs[0]).toEqual(
      expect.objectContaining({
        type: "user",
        message: expect.objectContaining({
          content: [
            expect.objectContaining({
              text: "Say hello",
            }),
          ],
        }),
      }),
    );
    const mcpConfig = JSON.parse(
      await readFile(String(fake.args[fake.args.indexOf("--mcp-config") + 1]), "utf8"),
    ) as Record<string, unknown>;
    expect(mcpConfig).toEqual({
      mcpServers: {
        pragma: {
          type: "http",
          url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
        },
      },
    });
    expect(session.info().runtimeSession.id).toBe("session-1");
    expect(synced.at(-1)?.runtimeSession).toEqual({
      type: "claude-code-local",
      id: "session-1",
    });
    expect(result.result.output).toBe("Hello world");
    expect(result.result.usage).toEqual({
      input: 8,
      output: 3,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 13,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    });
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "progress",
      "message.delta",
      "message.completed",
      "run.completed",
    ]);
    expect(session.messages()).toHaveLength(2);

    await session.abort();
  });

  it("resumes a matching Claude Code session on the next CLI turn", async () => {
    const fake = new FakeClaudeCodeCli([
      [
        { type: "system", session_id: "session-existing" },
        { type: "result", session_id: "session-existing", result: "Resumed" },
      ],
    ]);
    const agent = await createTestAgent();
    const adapter = createClaudeCodeRuntime({
      spawn: fake.spawn,
    });

    const session = await adapter.createSession({
      agent,
      runtimeSession: {
        type: "claude-code-local",
        id: "session-existing",
      },
    });
    const handle = session.submit({ query: "Continue" });
    await handle.result;

    expect(fake.args).toContain("--resume");
    expect(fake.args).toContain("session-existing");
    expect(session.info().runtimeSession.id).toBe("session-existing");

    await session.abort();
  });

  it("bridges Claude Code control requests to the Pragma approval handler", async () => {
    const fake = new FakeClaudeCodeCli([
      [
        {
          type: "control_request",
          request_id: "request-1",
          tool_name: "Bash",
          tool_call_id: "tool-1",
          input: { command: "echo hello" },
        },
        { type: "system", session_id: "session-approval" },
        { type: "result", session_id: "session-approval", result: "Approved" },
      ],
    ]);
    const requests: ExpertAgentHumanRequest[] = [];
    const agent = await createTestAgent();
    const adapter = createClaudeCodeRuntime({
      spawn: fake.spawn,
    });

    const session = await adapter.createSession({
      agent,
      humanInteractionHandler: async (request) => {
        requests.push(request);
        return {
          kind: "tool_approval",
          approved: true,
          updatedInput: { command: "echo patched" },
        };
      },
    });
    const handle = session.submit({ query: "Run command" });
    await handle.result;

    expect(requests).toEqual([
      {
        kind: "tool_approval",
        toolName: "Bash",
        toolCallId: "tool-1",
        reason: "Claude Code requested tool approval.",
        input: { command: "echo hello" },
      },
    ]);
    expect(fake.controlResponses).toEqual([
      {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "request-1",
          response: {
            behavior: "allow",
            updatedInput: { command: "echo patched" },
          },
        },
      },
    ]);

    await session.abort();
  });

  it("fails the turn and terminates Claude Code when an error result does not exit", async () => {
    const fake = new FakeClaudeCodeCli(
      [[{ type: "result", is_error: true, result: "API error: 400 Invalid API Key" }]],
      { exitAfterOutput: false },
    );
    const agent = await createTestAgent();
    const adapter = createClaudeCodeRuntime({
      spawn: fake.spawn,
    });

    const session = await adapter.createSession({ agent });
    const handle = session.submit({ query: "Say hello" });
    const eventsPromise = collectAsync(handle.events);

    await expect(handle.result).rejects.toMatchObject({
      code: "runtime.auth_invalid",
      retryable: false,
      message: expect.stringContaining("Invalid API Key"),
    });
    const events = await eventsPromise;
    const failed = events.find((event) => event.type === "run.failed");

    expect(fake.killSignals).toEqual(["SIGTERM"]);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "message.completed",
      "run.failed",
    ]);
    expect(failed?.payload).toEqual({
      message: expect.stringContaining("Invalid API Key"),
      code: "runtime.auth_invalid",
      retryable: false,
    });
    expect(session.messages()).toHaveLength(1);

    await session.abort();
  });

  it("classifies Claude Code rate limit failures as retryable", async () => {
    const fake = new FakeClaudeCodeCli([
      [{ type: "result", is_error: true, result: "API error: 429 Too many requests" }],
    ]);
    const agent = await createTestAgent();
    const adapter = createClaudeCodeRuntime({
      spawn: fake.spawn,
    });

    const session = await adapter.createSession({ agent });
    const handle = session.submit({ query: "Say hello" });
    const eventsPromise = collectAsync(handle.events);

    await expect(handle.result).rejects.toMatchObject({
      code: "runtime.rate_limited",
      retryable: true,
      message: expect.stringContaining("429"),
    });
    const events = await eventsPromise;
    const failed = events.find((event) => event.type === "run.failed");

    expect(failed?.payload).toEqual({
      message: expect.stringContaining("429"),
      code: "runtime.rate_limited",
      retryable: true,
    });

    await session.abort();
  });

  it("materializes ExpertAgent skills into a session-scoped Claude plugin", async () => {
    const fake = new FakeClaudeCodeCli([
      [{ type: "system", session_id: "session-skills" }, { type: "result", result: "done" }],
    ]);
    const skillDir = await mkdtemp(join(tmpdir(), "pragma-claude-skill-source-"));
    await writeFile(skillDir + "/SKILL.md", "# Local Skill\n\nUse local behavior.\n");
    const agent = await createTestAgent({
      skills: {
        skills: [
          {
            type: "local",
            name: "Local Skill",
            description: "Use for Claude skill runtime tests.",
            path: skillDir,
          },
          {
            type: "registry",
            name: "Unresolved Registry Skill",
            description: "Ignored until it has a local path.",
          },
        ],
      },
    });
    const adapter = createClaudeCodeRuntime({
      spawn: fake.spawn,
    });

    const session = await adapter.createSession({ agent });
    const handle = session.submit({ query: "Use skill" });
    await handle.result;
    const pluginDir = String(fake.args[fake.args.indexOf("--plugin-dir") + 1]);
    const manifest = JSON.parse(
      await readFile(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    const skill = await readFile(join(pluginDir, "skills", "local-skill", "SKILL.md"), "utf8");

    expect(manifest["name"]).toBe("pragma-agent-claude-test");
    expect(skill).toContain('name: "local-skill"');
    expect(skill).toContain('description: "Use for Claude skill runtime tests."');
    expect(skill).toContain("Use local behavior.");

    await session.abort();
  });
});

async function createTestAgent(
  options: {
    readonly skills?: Parameters<typeof ExpertAgent.create>[0]["skills"] | undefined;
  } = {},
): Promise<ExpertAgent> {
  return await ExpertAgent.create({
    id: "agent-claude-test",
    name: "Claude Test Agent",
    description: "Agent used by Claude Code runtime tests.",
    instructions: "Answer briefly.",
    tags: [],
    version: "0.0.0",
    scope: "test",
    workspace: await mkdtemp(join(tmpdir(), "pragma-claude-runtime-test-")),
    ...(options.skills === undefined ? {} : { skills: options.skills }),
  });
}

async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];

  for await (const value of iterable) {
    values.push(value);
  }

  return values;
}

class FakeClaudeCodeCli extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly inputs: unknown[] = [];
  readonly controlResponses: unknown[] = [];
  readonly killSignals: NodeJS.Signals[] = [];
  command = "";
  args: readonly string[] = [];
  env: NodeJS.ProcessEnv = {};
  private spawnCount = 0;

  readonly spawn: ClaudeCodeRuntimeSpawn = (command, args, options) => {
    this.command = command;
    this.args = args;
    this.env = options.env;
    this.spawnCount += 1;
    return this as unknown as ChildProcessWithoutNullStreams;
  };

  constructor(
    private readonly outputBySpawn: readonly (readonly Record<string, unknown>[])[],
    private readonly options: { readonly exitAfterOutput?: boolean | undefined } = {},
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const line of String(chunk).split("\n")) {
          if (line.trim() !== "") {
            this.handleInputLine(line);
          }
        }
        callback();
      },
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killSignals.push(signal);
    queueMicrotask(() => {
      this.emit("exit", null, signal);
    });
    return true;
  }

  private handleInputLine(line: string): void {
    const message = JSON.parse(line) as Record<string, unknown>;

    if (message["type"] === "control_response") {
      this.controlResponses.push(message);
      return;
    }

    this.inputs.push(message);
    this.writeSpawnOutput();
  }

  private writeSpawnOutput(): void {
    const output = this.outputBySpawn[this.spawnCount - 1] ?? [];

    queueMicrotask(() => {
      for (const event of output) {
        this.stdout.write(`${JSON.stringify(event)}\n`);
      }
      if (this.options.exitAfterOutput === false) {
        return;
      }
      this.stdout.end();
      this.emit("exit", 0, null);
    });
  }
}

class FakeProbeProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  command = "";
  args: readonly string[] = [];
  env: NodeJS.ProcessEnv = {};

  readonly spawn: ClaudeCodeRuntimeSpawn = (command, args, options) => {
    this.command = command;
    this.args = args;
    this.env = options.env;
    queueMicrotask(() => {
      this.stdout.write(this.result.stdout ?? "");
      this.stderr.write(this.result.stderr ?? "");
      this.stdout.end();
      this.stderr.end();
      this.emit("exit", this.result.exitCode, null);
    });
    return this as unknown as ChildProcessWithoutNullStreams;
  };

  constructor(
    private readonly result: {
      readonly exitCode: number;
      readonly stdout?: string | undefined;
      readonly stderr?: string | undefined;
    },
  ) {
    super();
  }

  kill(): boolean {
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}
