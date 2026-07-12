import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  ContextSystem,
  ExpertAgent,
  HOST_CONTEXT_NAMESPACE,
  PragmaPaths,
  createInMemoryContextStore,
} from "@pragma/core";
import type {
  ExpertAgentHumanRequest,
  RuntimeCreateSessionRequest,
  RuntimeSessionStorageContext,
} from "@pragma/core";

import { createClaudeCodeRuntime as createClaudeCodeRuntimeAdapter } from "../src/adapter.ts";
import { canUseClaudeCodeRuntime } from "../src/availability.ts";
import type { ClaudeCodeRuntimeSpawn } from "../src/types.ts";
import type { ClaudeCodeRuntimeAdapterOptions } from "../src/types.ts";

function createClaudeCodeRuntime(options?: ClaudeCodeRuntimeAdapterOptions) {
  const runtime = createClaudeCodeRuntimeAdapter(options);
  return {
    ...runtime,
    createSession(request: Omit<RuntimeCreateSessionRequest, "owner">) {
      return runtime.createSession({
        ...request,
        owner: { workflowRunId: "workflow-claude-test", taskRunId: "task-claude-test" },
        pragmaHome: join(request.agent.workspace, "pragma-test-home"),
      });
    },
  };
}

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
      defaultThinkingLevel: "high",
      listModels: async () => [
        {
          id: "claude-sonnet-4-5",
          displayName: "Claude Sonnet 4.5",
          provider: "anthropic",
          default: true,
          thinking: {
            supportedLevels: [{ value: "high", label: "High" }],
            defaultLevel: "high",
          },
        },
      ],
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
    expect(fake.args).toContain("--include-partial-messages");
    expect(fake.args).toContain("--bare");
    expect(fake.args).toContain("--strict-mcp-config");
    expect(fake.args[fake.args.indexOf("--permission-mode") + 1]).toBe("auto");
    expect(fake.args).toContain("--permission-prompt-tool");
    expect(fake.args).toContain("mcp__pragma__request_tool_approval");
    const systemPrompt = String(fake.args[fake.args.indexOf("--append-system-prompt") + 1]);
    expect(systemPrompt).toContain("You are Claude Test Agent.");
    expect(systemPrompt).toContain("Answer briefly.");
    expect(fake.args).toContain("--plugin-dir");
    expect(fake.args).toContain("--settings");
    const claudeRuntimeDir = new PragmaPaths({ pragmaHome: agent.pragmaHome }).runtimeRoot(
      "workflow-claude-test",
      session.info().systemSessionId,
      "claude-code",
    );
    expect(fake.args[fake.args.indexOf("--settings") + 1]).toBe(
      join(claudeRuntimeDir, "config", "settings.json"),
    );
    expect(fake.args).toContain("--model");
    expect(fake.args).toContain("claude-sonnet-4-5");
    expect(fake.args[fake.args.indexOf("--effort") + 1]).toBe("high");
    expect(fake.env["CLAUDE_CONFIG_DIR"]).toBe(join(claudeRuntimeDir, "config"));
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
      input: 10,
      output: 3,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 15,
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
    expect(fake.stdinEnded).toBe(true);

    await session.abort();
  });

  it("keeps the final Claude Code usage snapshot instead of summing partial snapshots", async () => {
    const fake = new FakeClaudeCodeCli([
      [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "Thinking" }],
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 2,
              output_tokens: 0,
            },
          },
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello world" }],
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 2,
              output_tokens: 0,
            },
          },
        },
        {
          type: "result",
          session_id: "session-usage",
          result: "Hello world",
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 2,
            output_tokens: 3,
          },
        },
      ],
    ]);
    const adapter = createClaudeCodeRuntime({
      spawn: fake.spawn,
    });
    const agent = await createTestAgent();

    const session = await adapter.createSession({ agent });
    const handle = session.submit({ query: "Say hello" });
    const result = await handle.result;

    expect(result.result.usage).toEqual({
      input: 10,
      output: 3,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 15,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    });

    await session.abort();
  });

  it("falls back to Claude Code transcript usage when stdout usage is missing", async () => {
    const sharedClaudeConfigDir = await mkdtemp(join(tmpdir(), "pragma-claude-shared-config-"));
    const fake = new FakeClaudeCodeCli(
      [
        [
          { type: "system", session_id: "session-transcript" },
          { type: "result", result: "Hello" },
        ],
      ],
      {
        onInput: async (cli) => {
          await writeClaudeTranscriptUsage(cli.env["CLAUDE_CONFIG_DIR"], "session-transcript", {
            inputTokens: 10,
            cacheReadInputTokens: 2,
            outputTokens: 3,
            cacheCreationInputTokens: 0,
          });
        },
      },
    );
    const adapter = createClaudeCodeRuntime({
      env: { CLAUDE_CONFIG_DIR: sharedClaudeConfigDir },
      spawn: fake.spawn,
    });
    const agent = await createTestAgent();

    const session = await adapter.createSession({ agent });
    const handle = session.submit({ query: "Say hello" });
    const result = await handle.result;

    expect(result.result.usage).toEqual({
      input: 10,
      output: 3,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 15,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    });

    await session.abort();
  });

  it("splits large Claude Code assistant text blocks into smaller deltas", async () => {
    const longText = "0123456789".repeat(25);
    const fake = new FakeClaudeCodeCli([
      [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: longText }],
          },
        },
        { type: "result", result: longText },
      ],
    ]);
    const agent = await createTestAgent();
    const adapter = createClaudeCodeRuntime({
      spawn: fake.spawn,
    });

    const session = await adapter.createSession({ agent });
    const handle = session.submit({ query: "Write a long answer" });
    const events = await collectAsync(handle.events);
    const result = await handle.result;
    const deltas = events
      .filter((event) => event.type === "message.delta")
      .map((event) => event.payload.delta);

    expect(result.result.output).toBe(longText);
    expect(deltas).toHaveLength(4);
    expect(deltas.join("")).toBe(longText);
    expect(deltas.every((delta) => Array.from(delta).length <= 80)).toBe(true);

    await session.abort();
  });

  it("maps Claude Code partial stream events without duplicating the final assistant message", async () => {
    const finalText = "streaming output arrived in pieces";
    const fake = new FakeClaudeCodeCli([
      [
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "streaming " },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "output arrived " },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "in pieces" },
          },
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: finalText }],
          },
        },
        { type: "result", result: finalText },
      ],
    ]);
    const agent = await createTestAgent();
    const adapter = createClaudeCodeRuntime({
      spawn: fake.spawn,
    });

    const session = await adapter.createSession({ agent });
    const handle = session.submit({ query: "Write a streaming answer" });
    const events = await collectAsync(handle.events);
    const result = await handle.result;
    const deltas = events
      .filter((event) => event.type === "message.delta")
      .map((event) => event.payload.delta);

    expect(result.result.output).toBe(finalText);
    expect(deltas).toEqual(["streaming ", "output arrived ", "in pieces"]);
    expect(deltas.join("")).toBe(finalText);

    await session.abort();
  });

  it("keeps final thinking content that was not emitted by partial stream events", async () => {
    const fake = new FakeClaudeCodeCli([
      [
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "reasoned " },
          },
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "reasoned fully" },
              { type: "text", text: "done" },
            ],
          },
        },
        { type: "result", result: "done" },
      ],
    ]);
    const agent = await createTestAgent();
    const adapter = createClaudeCodeRuntime({
      spawn: fake.spawn,
    });

    const session = await adapter.createSession({ agent });
    const handle = session.submit({ query: "Think and answer" });
    const events = await collectAsync(handle.events);
    const result = await handle.result;
    const thoughts = events
      .filter((event) => event.type === "thought.delta")
      .map((event) => event.payload.delta);
    const deltas = events
      .filter((event) => event.type === "message.delta")
      .map((event) => event.payload.delta);

    expect(result.result.output).toBe("done");
    expect(thoughts).toEqual(["reasoned ", "fully"]);
    expect(deltas).toEqual(["done"]);

    await session.abort();
  });

  it("backfills deltas before completion when Claude Code only emits a result", async () => {
    const longText = "abcdefghij".repeat(21);
    const fake = new FakeClaudeCodeCli([[{ type: "result", result: longText }]]);
    const agent = await createTestAgent();
    const adapter = createClaudeCodeRuntime({
      spawn: fake.spawn,
    });

    const session = await adapter.createSession({ agent });
    const handle = session.submit({ query: "Write a long answer" });
    const events = await collectAsync(handle.events);
    const result = await handle.result;
    const deltas = events
      .filter((event) => event.type === "message.delta")
      .map((event) => event.payload.delta);
    const completedIndex = events.findIndex((event) => event.type === "message.completed");
    const lastDeltaIndex = events.findLastIndex((event) => event.type === "message.delta");

    expect(result.result.output).toBe(longText);
    expect(deltas).toHaveLength(3);
    expect(deltas.join("")).toBe(longText);
    expect(lastDeltaIndex).toBeLessThan(completedIndex);

    await session.abort();
  });

  it("honors an explicit Claude Code permission mode", async () => {
    const fake = new FakeClaudeCodeCli([
      [
        { type: "system", session_id: "session-permission" },
        { type: "result", result: "done" },
      ],
    ]);
    const agent = await createTestAgent();
    const adapter = createClaudeCodeRuntime({
      permissionMode: "default",
      spawn: fake.spawn,
    });

    const session = await adapter.createSession({ agent });
    const handle = session.submit({ query: "Say hello" });
    await handle.result;

    expect(fake.args[fake.args.indexOf("--permission-mode") + 1]).toBe("default");

    await session.abort();
  });

  it("passes the assembled context system prompt to Claude Code", async () => {
    const fake = new FakeClaudeCodeCli([
      [
        { type: "system", session_id: "session-context" },
        { type: "result", result: "done" },
      ],
    ]);
    const contextSystem = new ContextSystem();
    contextSystem.register({
      namespace: HOST_CONTEXT_NAMESPACE,
      store: createInMemoryContextStore({
        context: [
          {
            id: "runtime-runbook.md",
            content: "Use read_expert_context for exact context ids.",
            metadata: {
              description: "Claude runtime runbook.",
              trigger: "always_on",
            },
          },
        ],
      }),
    });
    const agent = await createTestAgent({ contextSystem });
    const adapter = createClaudeCodeRuntime({
      spawn: fake.spawn,
    });

    const session = await adapter.createSession({ agent });
    const handle = session.submit({ query: "Read runtime-runbook.md" });
    await handle.result;
    const systemPrompt = String(fake.args[fake.args.indexOf("--append-system-prompt") + 1]);

    expect(systemPrompt).toContain("Context access rules:");
    expect(systemPrompt).not.toContain("Available context index");
    expect(systemPrompt).not.toContain("id: runtime-runbook.md");
    expect(systemPrompt).toContain("Use list_expert_context like a directory listing");
    expect(readInputContentBlocks(fake.inputs[0])).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Always-on reference context"),
      }),
      expect.objectContaining({
        type: "text",
        text: "Read runtime-runbook.md",
      }),
    ]);

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
    await seedClaudeSessionRecord(agent, "system-session-existing", "session-existing");

    const session = await adapter.createSession({
      agent,
      systemSessionId: "system-session-existing",
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
      [
        { type: "system", session_id: "session-skills" },
        { type: "result", result: "done" },
      ],
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
    readonly contextSystem?: ContextSystem | undefined;
  } = {},
): Promise<ExpertAgent> {
  const workspace = await mkdtemp(join(tmpdir(), "pragma-claude-runtime-test-"));
  return await ExpertAgent.create({
    id: "agent-claude-test",
    name: "Claude Test Agent",
    description: "Agent used by Claude Code runtime tests.",
    instructions: "Answer briefly.",
    tags: [],
    version: "0.0.0",
    scope: "test",
    workspace,
    pragmaHome: join(workspace, "pragma-test-home"),
    ...(options.contextSystem === undefined ? {} : { contextSystem: options.contextSystem }),
    ...(options.skills === undefined ? {} : { skills: options.skills }),
  });
}

async function seedClaudeSessionRecord(
  agent: ExpertAgent,
  systemSessionId: string,
  runtimeSessionId: string,
): Promise<void> {
  const paths = new PragmaPaths({ pragmaHome: agent.pragmaHome });
  await mkdir(paths.systemSessionRoot("workflow-claude-test", systemSessionId), {
    recursive: true,
  });
  const now = new Date().toISOString();
  await writeFile(
    paths.systemSessionManifest("workflow-claude-test", systemSessionId),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        workflowRunId: "workflow-claude-test",
        systemSessionId,
        agentId: agent.id,
        taskRunId: "task-claude-test",
        runtime: { id: "claude-code-local", kind: "claude-code-local" },
        runtimeSessionRef: { type: "claude-code-local", id: runtimeSessionId },
        currentWorkspace: agent.workspace,
        workspaceHistory: [agent.workspace],
        status: "closed",
        createdAt: now,
        updatedAt: now,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const nativeSessionDir = join(
    paths.runtimeRoot("workflow-claude-test", systemSessionId, "claude-code"),
    "config",
    "projects",
    "test-project",
  );
  await mkdir(nativeSessionDir, { recursive: true });
  await writeFile(join(nativeSessionDir, `${runtimeSessionId}.jsonl`), "{}\n", "utf8");
}

async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];

  for await (const value of iterable) {
    values.push(value);
  }

  return values;
}

function readInputContentBlocks(input: unknown): readonly unknown[] {
  if (!isRecord(input)) {
    return [];
  }

  const message = input["message"];
  if (!isRecord(message) || !Array.isArray(message["content"])) {
    return [];
  }

  return message["content"];
}

async function writeClaudeTranscriptUsage(
  configDir: string | undefined,
  sessionId: string,
  usage: {
    readonly inputTokens: number;
    readonly cacheReadInputTokens: number;
    readonly outputTokens: number;
    readonly cacheCreationInputTokens: number;
  },
): Promise<void> {
  if (configDir === undefined) {
    throw new Error("Expected fake Claude Code CLI to receive CLAUDE_CONFIG_DIR.");
  }

  const projectDir = join(configDir, "projects", "-test-workspace");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, `${sessionId}.jsonl`),
    `${JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        usage: {
          input_tokens: usage.inputTokens,
          cache_read_input_tokens: usage.cacheReadInputTokens,
          output_tokens: usage.outputTokens,
          cache_creation_input_tokens: usage.cacheCreationInputTokens,
        },
      },
    })}\n`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class FakeClaudeCodeCli extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly inputs: unknown[] = [];
  readonly controlResponses: unknown[] = [];
  readonly killSignals: NodeJS.Signals[] = [];
  stdinEnded = false;
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
    private readonly options: {
      readonly exitAfterOutput?: boolean | undefined;
      readonly onInput?: ((cli: FakeClaudeCodeCli) => Promise<void> | void) | undefined;
    } = {},
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        void this.handleInputChunk(String(chunk)).then(
          () => {
            callback();
          },
          (error: unknown) => {
            callback(error instanceof Error ? error : new Error(String(error)));
          },
        );
      },
      final: (callback) => {
        this.stdinEnded = true;
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

  private async handleInputChunk(chunk: string): Promise<void> {
    for (const line of chunk.split("\n")) {
      if (line.trim() !== "") {
        await this.handleInputLine(line);
      }
    }
  }

  private async handleInputLine(line: string): Promise<void> {
    const message = JSON.parse(line) as Record<string, unknown>;

    if (message["type"] === "control_response") {
      this.controlResponses.push(message);
      return;
    }

    this.inputs.push(message);
    await this.options.onInput?.(this);
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
