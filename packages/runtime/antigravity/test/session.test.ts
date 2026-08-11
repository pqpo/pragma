import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import { RUNTIME_CONTEXT_COMPACTION_STAGES, type RuntimeTurnContext } from "@pragma/core";
import { describe, expect, it, vi } from "vitest";

import {
  collectAntigravityUsage,
  consumeAntigravityStartupMessages,
  createAntigravityArgs,
  createAntigravityNativeSession,
  expandAntigravitySkillInvocation,
  formatAntigravityPrompt,
  normalizeAntigravityStreamRecord,
  readAntigravityConversationIdFromLog,
  readAntigravityTranscriptAssistantText,
  startAntigravityTurn,
  type AntigravityNativeEvent,
  type AntigravityNativeSession,
} from "../src/session.ts";

const conversation1 = "11111111-2222-4333-8444-555555555551";
const conversation2 = "11111111-2222-4333-8444-555555555552";
const conversation3 = "11111111-2222-4333-8444-555555555553";
const conversation4 = "11111111-2222-4333-8444-555555555554";

describe("Antigravity CLI invocation", () => {
  it("uses only documented headless flags and pins the process workspace", () => {
    expect(
      createAntigravityArgs({
        prompt: "do work",
        workspace: "/workspace/project",
        logPath: "/state/logs/turn.log",
        permissionMode: "request-approval",
        sessionId: conversation1,
        modelName: "gemini-3.1-pro",
        thinkingLevel: "high",
        customizationWorkspace: "/state/managed-customizations",
      }),
    ).toEqual([
      "--output-format",
      "stream-json",
      "--print-timeout",
      "24h",
      "--add-dir",
      "/workspace/project",
      "--add-dir",
      "/state/managed-customizations",
      "--log-file",
      "/state/logs/turn.log",
      "--mode",
      "accept-edits",
      "--sandbox",
      "--dangerously-skip-permissions",
      "--conversation",
      conversation1,
      "--model",
      "gemini-3.1-pro",
      "--effort",
      "high",
      "-p",
      "do work",
    ]);
  });

  it("maps permission modes to sandbox and explicit dangerous overrides", () => {
    const common = {
      prompt: "prompt",
      workspace: "/workspace/project",
      logPath: "/tmp/log",
    } as const;
    expect(createAntigravityArgs({ ...common, permissionMode: "request-approval" })).toContain(
      "--sandbox",
    );
    expect(createAntigravityArgs({ ...common, permissionMode: "auto-approve" })).toContain(
      "--sandbox",
    );
    expect(createAntigravityArgs({ ...common, permissionMode: "full-access" })).toContain(
      "--dangerously-skip-permissions",
    );
    for (const permissionMode of ["request-approval", "auto-approve", "full-access"] as const) {
      const args = createAntigravityArgs({ ...common, permissionMode });
      expect(args).toContain("--dangerously-skip-permissions");
      expect(args).not.toContain("--cwd");
      expect(args).not.toContain("--app_data_dir");
    }
  });

  it("rejects non-UUID native conversation identifiers before they reach argv or transcript recovery", () => {
    expect(() =>
      createAntigravityArgs({
        prompt: "do work",
        workspace: "/workspace/project",
        logPath: "/state/logs/turn.log",
        permissionMode: "request-approval",
        sessionId: "../../other-session",
      }),
    ).toThrow(/invalid conversation identifier/i);
    expect(
      readAntigravityConversationIdFromLog("conversation=../../other-session"),
    ).toBeUndefined();
  });

  it("rewrites only an explicit leading Pragma Skill invocation", () => {
    const session = {
      agent: {
        skills: {
          skills: [
            {
              type: "local",
              name: "review-code",
              description: "Review code",
              path: "/skills/review/SKILL.md",
            },
          ],
        },
      },
      managedHome: { skills: ["pragma-session-review-code"] },
    } as unknown as Pick<AntigravityNativeSession, "agent" | "managedHome">;

    expect(
      expandAntigravitySkillInvocation(
        session,
        "/review-code inspect this change",
        "# My request\n/review-code inspect this change",
      ),
    ).toBe("/pragma-session-review-code\n\n# My request\n/review-code inspect this change");
    expect(
      expandAntigravitySkillInvocation(
        session,
        "please apply review-code",
        "please apply review-code",
      ),
    ).toBe("please apply review-code");

    for (const heading of [
      "# Images mentioned by the user:\n## image.png: /workspace/image.png",
      "# Files mentioned by the user:\n## notes.md: /workspace/notes.md",
      "# Directories mentioned by the user:\n## src: /workspace/src",
    ]) {
      const attachmentQuery = `${heading}\n\n# My request\n/review-code inspect this change`;
      expect(expandAntigravitySkillInvocation(session, attachmentQuery, attachmentQuery)).toBe(
        `/pragma-session-review-code\n\n${attachmentQuery}`,
      );
    }
  });
});

describe("Antigravity startup messages", () => {
  it("frames every startup message with role, order, and exact character length", () => {
    expect(
      formatAntigravityPrompt(
        [
          { role: "user", content: "always on" },
          { role: "user", content: "承知" },
        ],
        "current request",
      ),
    ).toBe(
      [
        "The following Pragma startup messages precede the current user request. Preserve their order and treat each framed payload according to its declared role and exact character length.",
        "<<<PRAGMA_STARTUP_MESSAGE index=1/2 role=user characters=9>>>",
        "always on",
        "<<<END_PRAGMA_STARTUP_MESSAGE index=1/2>>>",
        "<<<PRAGMA_STARTUP_MESSAGE index=2/2 role=user characters=2>>>",
        "承知",
        "<<<END_PRAGMA_STARTUP_MESSAGE index=2/2>>>",
        "<<<PRAGMA_CURRENT_REQUEST>>>",
        "current request",
        "<<<END_PRAGMA_CURRENT_REQUEST>>>",
      ].join("\n"),
    );
    expect(formatAntigravityPrompt([], "unchanged")).toBe("unchanged");
  });

  it("consumes first-turn startup messages exactly once", () => {
    const session = createSession(createStreamSpawn([]));
    session.pendingStartupMessages = [{ role: "user", content: "mounted context" }];

    expect(consumeAntigravityStartupMessages(session)).toEqual([
      { role: "user", content: "mounted context" },
    ]);
    expect(consumeAntigravityStartupMessages(session)).toEqual([]);
    expect(session.messages).toEqual([]);
  });
});

describe("Antigravity stream-json process", () => {
  it.each([
    ["REJECTED", { error: "User denied access" }],
    ["DONE", { error: "Tool execution failed" }],
  ] as const)("closes a %s tool lifecycle as failed", (status, terminal) => {
    expect(
      normalizeAntigravityStreamRecord({
        event: "step_update",
        step_update: {
          step_id: `tool-${status}`,
          step_type: "tool_use",
          status,
          tool_info: {
            id: `tool-${status}`,
            name: "write_file",
            parameters: { TargetFile: "/workspace/project/out.ts" },
            ...terminal,
          },
        },
      }),
    ).toEqual([
      {
        kind: "tool-started",
        id: `tool-${status}`,
        name: "write_file",
        input: { TargetFile: "/workspace/project/out.ts" },
      },
      {
        kind: "tool-delta",
        id: `tool-${status}`,
        name: "write_file",
        delta: terminal.error,
      },
      {
        kind: "tool-completed",
        id: `tool-${status}`,
        name: "write_file",
        output: terminal.error,
        failed: true,
      },
    ]);
  });

  it("keeps a DONE tool with an explicit null error successful", () => {
    expect(
      normalizeAntigravityStreamRecord({
        event: "step_update",
        step_update: {
          step_id: "tool-success",
          step_type: "tool_use",
          status: "DONE",
          tool_info: {
            id: "tool-success",
            name: "write_to_file",
            parameters: { TargetFile: "/workspace/project/out.ts" },
            output: "created",
            error: null,
          },
        },
      }),
    ).toContainEqual({
      kind: "tool-completed",
      id: "tool-success",
      name: "write_to_file",
      output: "created",
      failed: false,
    });
  });

  it("streams agy 1.1.11 agent_response deltas before the terminal result without duplication", async () => {
    const fixture = await readAgyFixture("agy-1.1.11-agent-response.ndjson");
    const session = createSession(createStreamSpawn(fixture));
    const nativeEvents: AntigravityNativeEvent[] = [];

    await expect(
      startAntigravityTurn(
        session,
        createTurn({ writeNative: (event) => nativeEvents.push(event) }),
      ),
    ).resolves.toMatchObject({ outputText: "你好，streamed response" });

    expect(nativeEvents.filter((event) => event.kind === "message-delta")).toEqual([
      { kind: "message-delta", text: "你好，" },
      { kind: "message-delta", text: "streamed response" },
    ]);
    expect(nativeEvents.filter((event) => event.kind === "message-completed")).toEqual([
      { kind: "message-completed", text: "你好，streamed response" },
    ]);
    expect(nativeEvents).toEqual(
      expect.arrayContaining([
        {
          kind: "tool-started",
          id: "agy-tool:2:tool_use",
          name: "list_dir",
          input: { DirectoryPath: "/workspace/project" },
        },
        {
          kind: "tool-delta",
          id: "agy-tool:2:tool_use",
          name: "list_dir",
          delta: "src\npackage.json",
        },
        {
          kind: "tool-completed",
          id: "agy-tool:2:tool_use",
          name: "list_dir",
          output: "src\npackage.json",
          failed: false,
        },
      ]),
    );
    expect(nativeEvents).toContainEqual(
      expect.objectContaining({ kind: "progress", stage: "antigravity.error_message" }),
    );
    expect(nativeEvents.findIndex((event) => event.kind === "message-delta")).toBeLessThan(
      nativeEvents.findIndex((event) => event.kind === "message-completed"),
    );
  });

  it("decodes NDJSON when a UTF-8 code point is split across stdout chunks", async () => {
    const source = Buffer.from(
      [
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: conversation2,
            step_type: "agent_response",
            status: "DONE",
            text_delta: "你好",
          },
        }),
        JSON.stringify({
          event: "result",
          result: { conversation_id: conversation2, status: "SUCCESS", response: "你好" },
        }),
        "",
      ].join("\n"),
    );
    const splitAt = source.indexOf(Buffer.from("你")) + 1;
    const events: AntigravityNativeEvent[] = [];
    const session = createSession(
      createChunkedRawStreamSpawn([source.subarray(0, splitAt), source.subarray(splitAt)]),
    );

    await expect(
      startAntigravityTurn(session, createTurn({ writeNative: (event) => events.push(event) })),
    ).resolves.toMatchObject({ outputText: "你好" });
    expect(events).toContainEqual({ kind: "message-delta", text: "你好" });
  });

  it("streams messages, thinking, tools, subagents, compaction, session identity, and reported usage", async () => {
    const spawn = createStreamSpawn([
      {
        event: "init",
        init: {
          conversation_id: conversation2,
          model: "gemini-3.1-pro",
          tools: ["view_file"],
          mcp_servers: ["pragma"],
        },
      },
      {
        event: "step_update",
        step_update: {
          step_index: 0,
          step_type: "THOUGHT",
          text_delta: "Inspect",
          status: "running",
        },
      },
      {
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "PLANNER_RESPONSE",
          text_delta: "Hel",
          status: "running",
        },
      },
      {
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "PLANNER_RESPONSE",
          text_delta: "lo",
          status: "completed",
        },
      },
      {
        event: "step_update",
        step_update: {
          step_id: "tool-step",
          step_type: "tool_use",
          status: "running",
          tool_info: {
            id: "tool-1",
            name: "view_file",
            parameters: { AbsolutePath: "/workspace/project/file.ts" },
          },
        },
      },
      {
        event: "step_update",
        step_update: {
          step_id: "tool-step",
          step_type: "tool_use",
          status: "completed",
          tool_info: {
            id: "tool-1",
            name: "view_file",
            output: "contents",
          },
        },
      },
      {
        event: "step_update",
        step_update: {
          step_id: "subagent-1",
          step_type: "subagent",
          subagent_info: { name: "researcher", status: "running" },
        },
      },
      {
        event: "step_update",
        step_update: {
          step_id: "compact-1",
          step_type: "compaction",
          status: "running",
          compaction_info: { operation_id: "compact-op", trigger: "auto" },
        },
      },
      {
        event: "step_update",
        step_update: {
          step_id: "compact-1",
          step_type: "compaction",
          status: "completed",
          compaction_info: { operation_id: "compact-op", trigger: "auto" },
        },
      },
      {
        event: "result",
        result: {
          conversation_id: conversation2,
          status: "SUCCESS",
          response: "Hello",
          duration_seconds: 1.25,
          num_turns: 1,
          usage: {
            input_tokens: 10,
            output_tokens: 3,
            thinking_tokens: 2,
            cache_read_tokens: 4,
            total_tokens: 19,
          },
        },
      },
    ]);
    const session = createSession(spawn);
    const nativeEvents: AntigravityNativeEvent[] = [];

    const result = await startAntigravityTurn(
      session,
      createTurn({
        startupMessages: [{ role: "user", content: "mounted context" }],
        writeNative: (event) => nativeEvents.push(event),
      }),
    );

    expect(result).toMatchObject({
      outputText: "Hello",
      runtimeSessionId: conversation2,
    });
    expect(result.usage).toBeUndefined();
    expect(nativeEvents).toContainEqual({
      kind: "usage",
      usage: expect.objectContaining({
        measurement: "reported",
        input: 10,
        output: 5,
        cacheRead: 4,
        cacheWrite: 0,
        totalTokens: 19,
      }),
    });
    expect(spawn).toHaveBeenCalledWith(
      "/opt/agy",
      expect.arrayContaining(["-p", expect.stringContaining("mounted context")]),
      expect.objectContaining({ cwd: "/workspace/project", env: { PRIVATE_HOME: "true" } }),
    );
    expect(nativeEvents).toEqual(
      expect.arrayContaining([
        { kind: "session", sessionId: conversation2 },
        { kind: "thought-delta", text: "Inspect" },
        { kind: "message-delta", text: "Hel" },
        { kind: "message-delta", text: "lo" },
        {
          kind: "tool-started",
          id: "tool-1",
          name: "view_file",
          input: { AbsolutePath: "/workspace/project/file.ts" },
        },
        { kind: "tool-delta", id: "tool-1", name: "view_file", delta: "contents" },
        {
          kind: "tool-completed",
          id: "tool-1",
          name: "view_file",
          output: "contents",
          failed: false,
        },
        expect.objectContaining({ kind: "progress", stage: "antigravity.subagent" }),
        expect.objectContaining({
          kind: "progress",
          stage: RUNTIME_CONTEXT_COMPACTION_STAGES.started,
        }),
        expect.objectContaining({
          kind: "progress",
          stage: RUNTIME_CONTEXT_COMPACTION_STAGES.completed,
        }),
        expect.objectContaining({ kind: "usage" }),
        { kind: "message-completed", text: "Hello" },
      ]),
    );
    expect(session.messages).toMatchObject([
      { role: "user", content: "mounted context" },
      { role: "user", content: "raw user request" },
      { role: "assistant", provider: "antigravity", api: "antigravity-cli" },
    ]);
  });

  it("uses the shared token counter only when the CLI omits usage, without double-counting startup input", async () => {
    const spawn = createStreamSpawn([
      { type: "init", conversation_id: conversation3 },
      { type: "result", conversation_id: conversation3, result: "Done" },
    ]);
    const countText = vi
      .fn<AntigravityNativeSession["tokenCounter"]["countText"]>()
      .mockReturnValueOnce({ tokens: 12, source: "heuristic" })
      .mockReturnValueOnce({ tokens: 2, source: "heuristic" });
    const session = createSession(spawn, countText);

    const result = await startAntigravityTurn(
      session,
      createTurn({ startupMessages: [{ role: "user", content: "mounted once" }] }),
    );

    expect(result.usage).toMatchObject({ measurement: "estimated", input: 12, output: 2 });
    expect(JSON.parse(countText.mock.calls[0]![0])).toMatchObject({
      systemPrompt: "exact system prompt",
      messages: [],
      prompt: expect.stringContaining("mounted once"),
    });
    expect(countText.mock.calls[0]![0].match(/mounted once/g)).toHaveLength(1);
    expect(countText.mock.calls[1]![0]).toBe("Done");
  });

  it("recovers a non-empty streamed answer when a terminal result is missing", async () => {
    const spawn = createStreamSpawn([
      { type: "init", conversation_id: conversation4 },
      {
        type: "step_update",
        step_update: {
          step_id: "answer",
          step_type: "model_response",
          status: "DONE",
          content: "Recovered answer",
        },
      },
    ]);
    const session = createSession(spawn);
    const events: AntigravityNativeEvent[] = [];

    await expect(
      startAntigravityTurn(session, createTurn({ writeNative: (event) => events.push(event) })),
    ).resolves.toMatchObject({ outputText: "Recovered answer" });
    expect(events).toContainEqual({ kind: "message-completed", text: "Recovered answer" });
    expect(session.logger.warn).toHaveBeenCalledWith(
      "runtime.antigravity_terminal_result_missing",
      expect.any(String),
      expect.objectContaining({ recovered: true }),
    );
  });

  it("does not treat an ACTIVE response after an earlier DONE response as settled", async () => {
    const session = createSession(
      createStreamSpawn([
        { type: "init", conversation_id: conversation4 },
        {
          type: "step_update",
          step_update: {
            step_index: 0,
            step_type: "agent_response",
            status: "DONE",
            text_delta: "Earlier response",
          },
        },
        {
          type: "step_update",
          step_update: {
            step_index: 2,
            step_type: "agent_response",
            status: "ACTIVE",
            text_delta: "Partial final response",
          },
        },
      ]),
    );

    await expect(startAntigravityTurn(session, createTurn())).rejects.toMatchObject({
      code: "ANTIGRAVITY_PROTOCOL_ERROR",
    });
  });

  it("prefers a settled transcript over a partial ACTIVE response when result is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-agy-partial-recovery-"));
    const homeDir = join(root, "home");
    const logDir = join(root, "logs");
    const transcript = join(
      homeDir,
      ".gemini",
      "antigravity",
      "brain",
      conversation4,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    await mkdir(dirname(transcript), { recursive: true });
    await mkdir(logDir, { recursive: true });
    try {
      const spawn = createRawStreamSpawn(
        `${JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: conversation4,
            step_type: "agent_response",
            status: "ACTIVE",
            text_delta: "Hel",
          },
        })}\n`,
        "",
        async () => {
          await writeFile(
            transcript,
            [
              JSON.stringify({ type: "USER_INPUT", content: "current request" }),
              JSON.stringify({
                type: "PLANNER_RESPONSE",
                source: "MODEL",
                status: "DONE",
                content: "Hello",
              }),
            ].join("\n"),
          );
        },
      );
      const session = createSession(spawn, undefined, { homeDir, logDir });
      await expect(startAntigravityTurn(session, createTurn())).resolves.toMatchObject({
        outputText: "Hello",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains an initialized native conversation when the turn later fails", async () => {
    const session = createSession(
      createStreamSpawn([
        { type: "init", conversation_id: conversation3 },
        {
          type: "result",
          result: {
            conversation_id: conversation3,
            status: "ERROR",
            message: "provider rejected the request",
          },
        },
      ]),
    );
    const events: AntigravityNativeEvent[] = [];

    await expect(
      startAntigravityTurn(session, createTurn({ writeNative: (event) => events.push(event) })),
    ).rejects.toMatchObject({ code: "ANTIGRAVITY_PROCESS_FAILED" });

    expect(events).toContainEqual({ kind: "session", sessionId: conversation3 });
    expect(session.sessionId).toBe(conversation3);
  });

  it("accepts the historical plain-text fallback while keeping malformed structured output fatal", async () => {
    const plainSession = createSession(createRawStreamSpawn("First line\nsecond line\n"));
    await expect(startAntigravityTurn(plainSession, createTurn())).resolves.toMatchObject({
      outputText: "First line\nsecond line",
    });

    const malformedSession = createSession(createRawStreamSpawn('{"type":\n'));
    await expect(startAntigravityTurn(malformedSession, createTurn())).rejects.toMatchObject({
      name: "AntigravityRuntimeError",
      code: "ANTIGRAVITY_PROTOCOL_ERROR",
    });

    const timedOutSession = createSession(
      createRawStreamSpawn("Error: timed out waiting for response\n"),
    );
    await expect(startAntigravityTurn(timedOutSession, createTurn())).rejects.toMatchObject({
      name: "AntigravityRuntimeError",
      code: "ANTIGRAVITY_TIMEOUT",
      retryable: true,
    });
  });

  it("recovers the native session id from agy print-mode logs and reuses it in the next argv", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-agy-log-recovery-"));
    const homeDir = join(root, "home");
    const logDir = join(root, "logs");
    await mkdir(logDir, { recursive: true });
    try {
      const session = createSession(
        createRawStreamSpawn("Plain answer\n", "", async (args) => {
          const logPath = args[args.indexOf("--log-file") + 1]!;
          await mkdir(dirname(logPath), { recursive: true });
          await writeFile(logPath, `Print mode: conversation=${conversation2}, sending message\n`);
        }),
        undefined,
        { homeDir, logDir },
      );

      await expect(startAntigravityTurn(session, createTurn())).resolves.toMatchObject({
        outputText: "Plain answer",
        runtimeSessionId: conversation2,
      });
      expect(session.sessionId).toBe(conversation2);
      expect(
        createAntigravityArgs({
          prompt: "next",
          workspace: "/workspace/project",
          logPath: join(logDir, "next.log"),
          permissionMode: "request-approval",
          sessionId: session.sessionId,
        }),
      ).toContain("--conversation");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses a transcript only after this turn's user boundary and never reuses a resumed answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-agy-transcript-recovery-"));
    const homeDir = join(root, "home");
    const logDir = join(root, "logs");
    const transcript = join(
      homeDir,
      ".gemini",
      "antigravity",
      "brain",
      conversation3,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    await mkdir(dirname(transcript), { recursive: true });
    await mkdir(logDir, { recursive: true });
    try {
      await writeFile(
        transcript,
        [
          JSON.stringify({ type: "USER_INPUT", content: "old request" }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            status: "DONE",
            content: "Old answer that must not become this turn's output",
          }),
        ].join("\n"),
      );
      const resumed = createSession(createRawStreamSpawn(""), undefined, {
        homeDir,
        logDir,
        sessionId: conversation3,
      });
      await expect(startAntigravityTurn(resumed, createTurn())).rejects.toMatchObject({
        code: "ANTIGRAVITY_PROTOCOL_ERROR",
      });

      const freshTranscript = join(
        homeDir,
        ".gemini",
        "antigravity",
        "brain",
        conversation4,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      await mkdir(dirname(freshTranscript), { recursive: true });
      await writeFile(
        freshTranscript,
        [
          JSON.stringify({ type: "USER_INPUT", content: "current request" }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            status: "DONE",
            content: "Recovered current answer",
          }),
        ].join("\n"),
      );
      const fresh = createSession(
        createRawStreamSpawn("", "", async (args) => {
          const logPath = args[args.indexOf("--log-file") + 1]!;
          await writeFile(logPath, `Print mode: conversation=${conversation4}, sending message\n`);
        }),
        undefined,
        { homeDir, logDir },
      );
      await expect(startAntigravityTurn(fresh, createTurn())).resolves.toMatchObject({
        outputText: "Recovered current answer",
        runtimeSessionId: conversation4,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies authentication events", async () => {
    const authSession = createSession(
      createStreamSpawn([
        {
          event: "result",
          result: {
            conversation_id: "",
            status: "ERROR",
            response: "",
            error: "authentication failed or timed out",
            duration_seconds: 0,
            num_turns: 0,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              thinking_tokens: 0,
              cache_read_tokens: 0,
              total_tokens: 0,
            },
          },
        },
      ]),
    );
    await expect(startAntigravityTurn(authSession, createTurn())).rejects.toMatchObject({
      name: "AntigravityRuntimeError",
      code: "ANTIGRAVITY_AUTH_REQUIRED",
      retryable: false,
    });
  });

  it("fails when the process exits successfully without any recoverable assistant output", async () => {
    const session = createSession(createStreamSpawn([{ type: "init" }]));

    await expect(startAntigravityTurn(session, createTurn())).rejects.toMatchObject({
      code: "ANTIGRAVITY_PROTOCOL_ERROR",
    });
  });

  it("terminates an active CLI process and surfaces AbortError when a turn is cancelled", async () => {
    const controller = new AbortController();
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn((signal: NodeJS.Signals) => {
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", null, signal);
      });
      return true;
    });
    let resolveSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolveSpawn) => {
      resolveSpawned = resolveSpawn;
    });
    const spawn = vi.fn(() => {
      resolveSpawned?.();
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const session = createSession(spawn);

    const result = startAntigravityTurn(session, createTurn({ signal: controller.signal }));
    await spawned;
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    expect(session.activeProcess).toBeUndefined();
    expect(session.toolRuntimeState.runId).toBeUndefined();
  });
});

describe("Antigravity record normalization and usage collection", () => {
  it("keeps unknown records observable while recursively removing credentials", () => {
    expect(
      normalizeAntigravityStreamRecord({
        type: "future_event",
        authorization: "secret",
        token: "secret",
        visible: "kept",
        nested: { cookie: "secret", visible: ["nested"] },
      }),
    ).toEqual([
      {
        kind: "progress",
        stage: "antigravity.future_event",
        data: { type: "future_event", visible: "kept", nested: { visible: ["nested"] } },
      },
    ]);
  });

  it("prefers direct output token totals over component output fields", () => {
    expect(
      normalizeAntigravityStreamRecord({
        type: "result",
        result: "done",
        usage: {
          inputTokens: 7,
          outputTokens: 11,
          thinkingOutputTokens: 100,
          responseOutputTokens: 200,
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "usage",
          usage: expect.objectContaining({ input: 7, output: 11, measurement: "reported" }),
        }),
      ]),
    );
  });

  it.each(["failed", "error", "cancelled"])(
    "reports a %s compaction as failed instead of completed",
    (status) => {
      const events = normalizeAntigravityStreamRecord({
        event: "step_update",
        step_update: {
          step_id: "compact-1",
          step_type: "compaction",
          status,
          compaction_info: {
            operation_id: "compact-op",
            trigger: "automatic",
            error: "provider unavailable",
          },
        },
      });

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "progress",
            stage: RUNTIME_CONTEXT_COMPACTION_STAGES.started,
          }),
          expect.objectContaining({
            kind: "progress",
            stage: RUNTIME_CONTEXT_COMPACTION_STAGES.failed,
            data: expect.objectContaining({
              operationId: "compact-op",
              trigger: "auto",
              errorMessage: "provider unavailable",
            }),
          }),
        ]),
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({ stage: RUNTIME_CONTEXT_COMPACTION_STAGES.completed }),
      );
    },
  );

  it("redacts credentials from native tool events and vendor failures", async () => {
    const events = normalizeAntigravityStreamRecord({
      event: "step_update",
      step_update: {
        step_id: "tool-1",
        step_type: "tool_use",
        status: "completed",
        tool_info: {
          id: "tool-1",
          name: "mcp__unmanaged__read",
          parameters: {
            Authorization: "Bearer input-secret",
            nested: { token: "nested-secret", visible: "kept" },
          },
          output: 'Authorization: Bearer output-secret {"password":"hidden","visible":"kept"}',
        },
      },
    });
    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain("input-secret");
    expect(serializedEvents).not.toContain("nested-secret");
    expect(serializedEvents).not.toContain("output-secret");
    expect(serializedEvents).not.toContain("hidden");
    expect(serializedEvents).toContain("[redacted]");

    const failed = createSession(
      createStreamSpawn([
        {
          event: "result",
          result: {
            status: "ERROR",
            error: "provider failed: Authorization: Bearer result-secret",
          },
        },
      ]),
    );
    await expect(startAntigravityTurn(failed, createTurn())).rejects.toMatchObject({
      code: "ANTIGRAVITY_PROCESS_FAILED",
      message: expect.not.stringContaining("result-secret"),
    });
  });

  it("uses reported total_tokens to detect input counts that already include cache reads", () => {
    expect(
      normalizeAntigravityStreamRecord({
        event: "result",
        result: {
          status: "SUCCESS",
          response: "done",
          usage: {
            input_tokens: 14,
            output_tokens: 3,
            thinking_tokens: 2,
            cache_read_tokens: 4,
            total_tokens: 19,
          },
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "usage",
          usage: expect.objectContaining({
            input: 10,
            output: 5,
            cacheRead: 4,
            totalTokens: 19,
          }),
        }),
      ]),
    );
  });

  it("preserves existing non-zero usage during final collection", () => {
    const session = createSession(createStreamSpawn([]));
    const usage = {
      measurement: "reported",
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } as const;

    expect(collectAntigravityUsage(session, "ignored", usage)).toBe(usage);
  });

  it("recovers only the current transcript turn and the latest logged conversation id", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-agy-transcript-test-"));
    const transcript = join(root, "transcript.jsonl");
    try {
      await writeFile(
        transcript,
        [
          JSON.stringify({
            trajectory: {
              steps: [
                {
                  stepType: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
                  plannerResponse: { response: "Recovered planner answer" },
                },
              ],
            },
          }),
          "{incomplete",
        ].join("\n"),
      );

      await expect(readAntigravityTranscriptAssistantText(transcript)).resolves.toBe(
        "Recovered planner answer",
      );

      await writeFile(
        transcript,
        [
          JSON.stringify({ type: "USER_INPUT", content: "old turn" }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            status: "DONE",
            content: "Old answer that must not leak",
          }),
          JSON.stringify({ type: "USER_INPUT", content: "current turn" }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            status: "DONE",
            content: "Current narration",
          }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            status: "RUNNING",
            content: "Partial text that must not leak",
          }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            status: "DONE",
            content: "Current final answer",
          }),
          "{incomplete",
        ].join("\n"),
      );
      await expect(readAntigravityTranscriptAssistantText(transcript)).resolves.toBe(
        "Current narration\n\nCurrent final answer",
      );

      await writeFile(
        transcript,
        [
          JSON.stringify({ type: "USER_INPUT", content: "old turn" }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            status: "DONE",
            content: "Old answer",
          }),
          JSON.stringify({ type: "USER_INPUT", content: "empty current turn" }),
        ].join("\n"),
      );
      await expect(readAntigravityTranscriptAssistantText(transcript)).resolves.toBeUndefined();
      await writeFile(
        transcript,
        [
          JSON.stringify({ type: "USER_INPUT", content: "old turn before the tail" }),
          " ".repeat(4 * 1024 * 1024 + 1_024),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            status: "DONE",
            content: "Old answer beyond a truncated boundary",
          }),
        ].join("\n"),
      );
      await expect(readAntigravityTranscriptAssistantText(transcript)).resolves.toBeUndefined();
      expect(
        readAntigravityConversationIdFromLog(
          'conversationID=""\ncreated conversation_id: 11111111-2222-4333-8444-555555555555\n',
        ),
      ).toBe("11111111-2222-4333-8444-555555555555");
      expect(
        readAntigravityConversationIdFromLog(
          `Print mode: conversation=${conversation1}, sending message`,
        ),
      ).toBe(conversation1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createSession(
  spawn: AntigravityNativeSession["spawn"],
  countText: AntigravityNativeSession["tokenCounter"]["countText"] = () => ({
    tokens: 1,
    source: "heuristic",
  }),
  options: {
    readonly homeDir?: string | undefined;
    readonly logDir?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly workspace?: string | undefined;
  } = {},
): AntigravityNativeSession {
  const homeDir = options.homeDir ?? "/state/home";
  const logDir = options.logDir ?? "/state/logs";
  return createAntigravityNativeSession({
    agent: {
      workspace: options.workspace ?? "/workspace/project",
    } as AntigravityNativeSession["agent"],
    executablePath: "/opt/agy",
    env: { PRIVATE_HOME: "true" },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as AntigravityNativeSession["logger"],
    managedHome: {
      authenticationMode: "isolated-environment",
      homeDir,
      appDataDir: join(homeDir, ".gemini", "antigravity-cli"),
      configDir: join(homeDir, ".gemini", "config"),
      agentName: "pragma-review",
      mcpServerName: "pragma0123456789abcdef",
      hookName: "pragma-permission-gate-0123456789abcdef",
      pluginName: "pragma-0123456789abcdef",
      pluginDir: join(homeDir, ".gemini", "config", "plugins", "pragma-0123456789abcdef"),
      logDir,
      env: { PRIVATE_HOME: "true" },
      skills: [],
    },
    permissionMode: "request-approval",
    spawn,
    systemPrompt: "exact system prompt",
    toolRuntimeState: {},
    tokenCounter: { countText },
    sessionId: options.sessionId,
  });
}

async function readAgyFixture(name: string): Promise<readonly unknown[]> {
  const source = await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  return source
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

function createTurn(
  options: {
    readonly startupMessages?: RuntimeTurnContext<AntigravityNativeEvent>["startupMessages"];
    readonly writeNative?: (event: AntigravityNativeEvent) => void;
    readonly signal?: AbortSignal;
  } = {},
): RuntimeTurnContext<AntigravityNativeEvent> {
  return {
    runId: "run-1",
    attempt: 1,
    isRetry: false,
    rawQuery: "raw user request",
    prompt: "rendered user request",
    attachments: [],
    startupMessages: options.startupMessages ?? [],
    signal: options.signal ?? new AbortController().signal,
    source: { kind: "runtime", runId: "run-1", path: [] },
    stream: {
      write: vi.fn(),
      writeNative: options.writeNative ?? vi.fn(),
    } as unknown as RuntimeTurnContext<AntigravityNativeEvent>["stream"],
  };
}

function createStreamSpawn(records: readonly unknown[], stderr = "") {
  return createRawStreamSpawn(
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    stderr,
  );
}

function createRawStreamSpawn(
  stdout: string,
  stderr = "",
  beforeExit?: (args: readonly string[]) => Promise<void> | void,
) {
  return vi.fn((_command: string, args: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    queueMicrotask(() => {
      void Promise.resolve(beforeExit?.(args)).then(
        () => {
          child.stdout.end(stdout);
          child.stderr.end(stderr);
          child.emit("exit", 0, null);
        },
        (error: unknown) => {
          child.emit("error", error);
        },
      );
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  });
}

function createChunkedRawStreamSpawn(chunks: readonly Buffer[]) {
  return vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    queueMicrotask(() => {
      for (const chunk of chunks) child.stdout.write(chunk);
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", 0, null);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  });
}
