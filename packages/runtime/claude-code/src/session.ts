import { AgentMessageUsageSchema, type AgentMessage, type AgentMessageUsage } from "@pragma/shared";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type {
  ExpertAgent,
  ExpertAgentHumanInteractionHandler,
  ExpertAgentLogger,
  ExpertAgentStartupMessage,
  RuntimeEventMappingContext,
  RuntimeEventMappingResult,
  RuntimeStreamEvent,
  RuntimeStreamEventInput,
  RuntimeTurnContext,
  RuntimeTurnResult,
} from "@pragma/core";
import { readFirstTokenCount, createUsageFromTokenCounts } from "@pragma/core";

import type {
  ClaudeCodeRuntimeIsolationMode,
  ClaudeCodeRuntimeMessage,
  ClaudeCodeRuntimePermissionMode,
  ClaudeCodeRuntimeSessionState,
  ClaudeCodeRuntimeSpawn,
} from "./types.ts";

const MCP_SERVER_NAME = "pragma";
const PERMISSION_TOOL_NAME = "mcp__pragma__request_tool_approval";
const STDERR_TAIL_LIMIT = 8_192;

const PROTOCOL_FLAGS_WITH_VALUE = new Set([
  "--mcp-config",
  "--output-format",
  "--input-format",
  "--permission-prompt-tool",
  "--permission-mode",
  "--plugin-dir",
  "--append-system-prompt",
  "--model",
  "--resume",
  "--allowedTools",
  "--disallowedTools",
  "--add-dir",
  "--ide",
]);

const PROTOCOL_FLAGS = new Set([
  "-p",
  "--print",
  "--verbose",
  "--strict-mcp-config",
  "--bare",
  "--continue",
  "--dangerously-skip-permissions",
]);

export interface ClaudeCodeNativeSession {
  readonly agent: ExpertAgent;
  readonly executablePath: string;
  readonly additionalArgs: readonly string[];
  readonly defaultModelName?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
  readonly isolationMode: ClaudeCodeRuntimeIsolationMode;
  readonly logger: ExpertAgentLogger;
  readonly mcpServerUrl: string;
  readonly permissionMode: ClaudeCodeRuntimePermissionMode;
  readonly pluginDir: string;
  readonly sessionDir: string;
  readonly spawn?: ClaudeCodeRuntimeSpawn | undefined;
  readonly state: ClaudeCodeRuntimeSessionState;
  readonly messages: ClaudeCodeRuntimeMessage[];
  pendingStartupMessages: readonly ExpertAgentStartupMessage[];
  activeProcess?: ChildProcessWithoutNullStreams | undefined;
  activeCancelled: boolean;
}

export function createClaudeCodeNativeSession(options: {
  readonly agent: ExpertAgent;
  readonly executablePath: string;
  readonly additionalArgs: readonly string[];
  readonly defaultModelName?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
  readonly isolationMode: ClaudeCodeRuntimeIsolationMode;
  readonly logger: ExpertAgentLogger;
  readonly mcpServerUrl: string;
  readonly permissionMode: ClaudeCodeRuntimePermissionMode;
  readonly pluginDir: string;
  readonly sessionDir: string;
  readonly spawn?: ClaudeCodeRuntimeSpawn | undefined;
  readonly startupMessages?: readonly ExpertAgentStartupMessage[] | undefined;
  readonly state: ClaudeCodeRuntimeSessionState;
}): ClaudeCodeNativeSession {
  return {
    ...options,
    messages: [],
    pendingStartupMessages: options.startupMessages ?? [],
    activeCancelled: false,
  };
}

export function listClaudeCodeMessages(session: ClaudeCodeNativeSession): readonly AgentMessage[] {
  return convertClaudeMessages(session.messages, session.defaultModelName);
}

export function consumeClaudeCodeStartupMessages(
  session: ClaudeCodeNativeSession,
): readonly ExpertAgentStartupMessage[] {
  const startupMessages = session.pendingStartupMessages;
  session.pendingStartupMessages = [];

  if (startupMessages.length > 0) {
    const timestamp = Date.now();
    session.messages.push(
      ...startupMessages.map((message, index) => ({
        role: "user" as const,
        content: message.content,
        timestamp: timestamp + index,
      })),
    );
  }

  return startupMessages;
}

export async function startClaudeCodeTurn(
  session: ClaudeCodeNativeSession,
  turn: RuntimeTurnContext<Record<string, unknown>>,
): Promise<RuntimeTurnResult> {
  session.messages.push({
    role: "user",
    content: turn.rawQuery,
    timestamp: Date.now(),
  });

  const run = await runClaudeCodeProcess({
    executablePath: session.executablePath,
    args: await createClaudeCodeArgs({
      additionalArgs: session.additionalArgs,
      defaultModelName: session.defaultModelName,
      mcpServerUrl: session.mcpServerUrl,
      modelName: turn.modelName,
      permissionMode: session.permissionMode,
      pluginDir: session.pluginDir,
      sessionDir: session.sessionDir,
      state: session.state,
      systemPrompt: createSystemPrompt(session.agent),
    }),
    cwd: session.agent.workspace,
    env: await createClaudeCodeEnv({
      env: session.env,
      isolationMode: session.isolationMode,
      sessionDir: session.sessionDir,
    }),
    humanInteractionHandler: session.humanInteractionHandler,
    logger: session.logger,
    prompt: [...turn.startupMessages.map((message) => message.content), turn.prompt].join("\n\n"),
    runId: turn.runId,
    source: {
      kind: "agent",
      runId: turn.runId,
      agentId: session.agent.id,
      path: [],
    },
    emitRuntimeEvent: turn.stream.write,
    spawn: session.spawn,
    onProcessStarted(process) {
      session.activeCancelled = false;
      session.activeProcess = process;
    },
    onProcessClosed(process) {
      if (session.activeProcess === process) {
        session.activeProcess = undefined;
      }
    },
  });

  if (run.sessionId !== undefined && run.sessionId !== session.state.sessionId) {
    session.state.sessionId = run.sessionId;
  }

  session.messages.push({
    role: "assistant",
    content: run.outputText,
    timestamp: Date.now(),
    details: run.usage,
  });

  return {
    outputText: run.outputText,
    usage: run.usage,
    runtimeSessionId: session.state.sessionId,
  };
}

export function mapClaudeCodeNativeEvent(
  event: Record<string, unknown>,
  context: RuntimeEventMappingContext,
): RuntimeEventMappingResult {
  return mapClaudeStreamEvent(event, context.runId, context.source);
}

export function cancelClaudeCodeTurn(session: ClaudeCodeNativeSession): void {
  const process = session.activeProcess;
  session.activeCancelled = true;
  process?.kill("SIGTERM");
  setTimeout(() => {
    process?.kill("SIGKILL");
  }, 1_000).unref();
}

interface ClaudeProcessRunResult {
  readonly outputText: string;
  readonly usage?: AgentMessageUsage | undefined;
  readonly sessionId?: string | undefined;
}

async function runClaudeCodeProcess({
  executablePath,
  args,
  cwd,
  env,
  humanInteractionHandler,
  logger,
  prompt,
  runId,
  source,
  emitRuntimeEvent,
  spawn,
  onProcessStarted,
  onProcessClosed,
}: {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
  readonly logger: ExpertAgentLogger;
  readonly prompt: string;
  readonly runId: string;
  readonly source: RuntimeStreamEvent["source"];
  readonly emitRuntimeEvent: (event: RuntimeStreamEventInput) => void;
  readonly spawn?: ClaudeCodeRuntimeSpawn | undefined;
  readonly onProcessStarted: (process: ChildProcessWithoutNullStreams) => void;
  readonly onProcessClosed: (process: ChildProcessWithoutNullStreams) => void;
}): Promise<ClaudeProcessRunResult> {
  const child = (spawn ?? defaultSpawn)(executablePath, args, { cwd, env });
  onProcessStarted(child);

  let outputText = "";
  let usage: AgentMessageUsage | undefined;
  let sessionId: string | undefined;
  let stderrTail = "";
  let finalResultSeen = false;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_LIMIT);
    logger.debug("Claude Code stderr", { chunk });
  });

  child.stdin.write(`${JSON.stringify(createClaudeCodeUserInput(prompt))}\n`);

  const lines = createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });

  const readStdout = (async (): Promise<void> => {
    for await (const line of lines) {
      if (line.trim() === "") {
        continue;
      }

      const event = parseJsonRecord(line);
      if (event === undefined) {
        logger.debug("Ignoring non-JSON Claude Code stream line", { line });
        continue;
      }

      const nextSessionId = readString(event["session_id"]) ?? readString(event["sessionId"]);
      if (nextSessionId !== undefined) {
        sessionId = nextSessionId;
      }

      if (event["type"] === "control_request") {
        await respondToControlRequest(child, event, humanInteractionHandler);
        continue;
      }

      const mapped = mapClaudeStreamEvent(event, runId, source);
      for (const runtimeEvent of mapped.events) {
        emitRuntimeEvent(runtimeEvent);
      }
      if (mapped.outputDelta !== undefined) {
        outputText += mapped.outputDelta;
      }
      if (mapped.completedText !== undefined) {
        outputText = mapped.completedText;
      }
      usage = mergeUsage(usage, mapped.usage);

      if (event["type"] === "result") {
        finalResultSeen = true;
        const resultText = readString(event["result"]);
        if (resultText !== undefined) {
          outputText = resultText;
        }
        if (event["is_error"] === true) {
          throw new Error(resultText ?? "Claude Code returned an error result.");
        }
      }
    }
  })();

  const exitPromise = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null };
  try {
    [exit] = await Promise.all([exitPromise, readStdout]);
    child.stdin.end();
  } finally {
    onProcessClosed(child);
  }

  if (exit.code !== 0) {
    throw new Error(
      `Claude Code exited with code ${exit.code ?? "null"}${exit.signal === null ? "" : ` and signal ${exit.signal}`}.${stderrTail.trim() === "" ? "" : `\n${stderrTail.trim()}`}`,
    );
  }

  if (!finalResultSeen && outputText.trim() === "") {
    throw new Error("Claude Code completed without a result.");
  }

  return {
    outputText,
    ...(usage === undefined ? {} : { usage }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

async function createClaudeCodeArgs({
  additionalArgs,
  defaultModelName,
  mcpServerUrl,
  modelName,
  permissionMode,
  pluginDir,
  sessionDir,
  state,
  systemPrompt,
}: {
  readonly additionalArgs: readonly string[];
  readonly defaultModelName?: string | undefined;
  readonly mcpServerUrl: string;
  readonly modelName?: string | undefined;
  readonly permissionMode: ClaudeCodeRuntimePermissionMode;
  readonly pluginDir: string;
  readonly sessionDir: string;
  readonly state: ClaudeCodeRuntimeSessionState;
  readonly systemPrompt: string;
}): Promise<readonly string[]> {
  const mcpConfigPath = await writeMcpConfig(sessionDir, mcpServerUrl);
  const selectedModel = modelName ?? defaultModelName;
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    "--bare",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
    "--plugin-dir",
    pluginDir,
    "--append-system-prompt",
    systemPrompt,
    "--permission-mode",
    normalizePermissionMode(permissionMode),
    "--permission-prompt-tool",
    PERMISSION_TOOL_NAME,
    "--disallowedTools",
    "AskUserQuestion",
    ...(selectedModel === undefined ? [] : ["--model", selectedModel]),
    ...(state.sessionId === "" ? [] : ["--resume", state.sessionId]),
    ...filterAdditionalArgs(additionalArgs),
  ];

  return args;
}

async function writeMcpConfig(sessionDir: string, mcpServerUrl: string): Promise<string> {
  const path = join(sessionDir, "claude-mcp-config.json");
  await writeFile(
    path,
    `${JSON.stringify(
      {
        mcpServers: {
          [MCP_SERVER_NAME]: {
            type: "http",
            url: mcpServerUrl,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

async function createClaudeCodeEnv({
  env,
  isolationMode,
  sessionDir,
}: {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly isolationMode: ClaudeCodeRuntimeIsolationMode;
  readonly sessionDir: string;
}): Promise<NodeJS.ProcessEnv> {
  const nextEnv = {
    ...filterClaudeRuntimeEnv(process.env),
    ...env,
  };

  if (isolationMode === "strict") {
    const configDir = join(sessionDir, "claude-config");
    await mkdir(configDir, { recursive: true });
    nextEnv["CLAUDE_CONFIG_DIR"] = configDir;
  }

  return nextEnv;
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): ChildProcessWithoutNullStreams {
  return nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
  });
}

function createClaudeCodeUserInput(prompt: string): Record<string, unknown> {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: prompt,
        },
      ],
    },
  };
}

function createSystemPrompt(agent: ExpertAgent): string {
  return [
    `You are ${agent.name}.`,
    agent.description,
    agent.instructions,
    `Expert ID: ${agent.id}`,
    `Scope: ${agent.scope}`,
    `Tags: ${agent.tags.join(", ")}`,
  ]
    .filter((part): part is string => part !== undefined && part.trim() !== "")
    .join("\n\n");
}

function mapClaudeStreamEvent(
  event: Record<string, unknown>,
  runId: string,
  source: RuntimeStreamEvent["source"],
): {
  readonly events: readonly RuntimeStreamEventInput[];
  readonly outputDelta?: string | undefined;
  readonly completedText?: string | undefined;
  readonly usage?: AgentMessageUsage | undefined;
} {
  const type = readString(event["type"]);
  const message = readRecord(event["message"]);

  if (type === "assistant" && message !== undefined) {
    return readAssistantMessageEvent(message, runId, source);
  }

  if (type === "user" && message !== undefined) {
    return readUserMessageEvent(message, runId, source);
  }

  if (type === "result") {
    const text = readString(event["result"]);
    return {
      events:
        text === undefined
          ? []
          : [
              {
                runId,
                source,
                type: "message.completed",
                payload: {
                  role: "assistant",
                  contentType: "text",
                  text,
                },
              },
            ],
      ...(text === undefined ? {} : { completedText: text }),
      usage: readUsage(event),
    };
  }

  if (type === "system") {
    return {
      events: [
        {
          runId,
          source,
          type: "progress",
          payload: {
            stage: "claude.system",
            data: event,
          },
        },
      ],
    };
  }

  return { events: [] };
}

function readAssistantMessageEvent(
  message: Record<string, unknown>,
  runId: string,
  source: RuntimeStreamEvent["source"],
): {
  readonly events: readonly RuntimeStreamEventInput[];
  readonly outputDelta?: string | undefined;
  readonly usage?: AgentMessageUsage | undefined;
} {
  const runtimeEvents: RuntimeStreamEventInput[] = [];
  let outputDelta = "";

  for (const block of readContentBlocks(message)) {
    const blockType = readString(block["type"]);

    if (blockType === "text") {
      const text = readString(block["text"]);
      if (text !== undefined) {
        outputDelta += text;
        runtimeEvents.push({
          runId,
          source,
          type: "message.delta",
          payload: {
            role: "assistant",
            contentType: "text",
            delta: text,
          },
        });
      }
      continue;
    }

    if (blockType === "thinking") {
      const thinking = readString(block["thinking"]);
      if (thinking !== undefined) {
        runtimeEvents.push({
          runId,
          source,
          type: "thought.delta",
          payload: {
            contentType: "text",
            delta: thinking,
          },
        });
      }
      continue;
    }

    if (blockType === "tool_use") {
      runtimeEvents.push({
        runId,
        source,
        type: "tool.started",
        payload: {
          toolCallId: readString(block["id"]) ?? randomUUID(),
          toolName: readString(block["name"]) ?? "claude_tool",
          kind: "tool",
          inputPreview: block["input"],
        },
      });
    }
  }

  const usage = readUsage(message);

  return {
    events: runtimeEvents,
    ...(outputDelta === "" ? {} : { outputDelta }),
    ...(usage === undefined ? {} : { usage }),
  };
}

function readUserMessageEvent(
  message: Record<string, unknown>,
  runId: string,
  source: RuntimeStreamEvent["source"],
): {
  readonly events: readonly RuntimeStreamEventInput[];
} {
  const runtimeEvents: RuntimeStreamEventInput[] = [];

  for (const block of readContentBlocks(message)) {
    if (block["type"] !== "tool_result") {
      continue;
    }

    const toolCallId = readString(block["tool_use_id"]) ?? randomUUID();
    runtimeEvents.push({
      runId,
      source,
      type: block["is_error"] === true ? "tool.failed" : "tool.completed",
      payload:
        block["is_error"] === true
          ? {
              toolCallId,
              toolName: "claude_tool",
              kind: "tool",
              message: readToolResultText(block) ?? "Tool call failed.",
            }
          : {
              toolCallId,
              toolName: "claude_tool",
              kind: "tool",
              outputPreview: block["content"],
            },
    });
  }

  return { events: runtimeEvents };
}

async function respondToControlRequest(
  child: ChildProcessWithoutNullStreams,
  event: Record<string, unknown>,
  humanInteractionHandler: ExpertAgentHumanInteractionHandler | undefined,
): Promise<void> {
  const requestId = readString(event["request_id"]) ?? readString(event["requestId"]);
  const toolName =
    readString(event["tool_name"]) ??
    readString(event["toolName"]) ??
    readString(readRecord(event["tool"])?.["name"]) ??
    "claude_tool";
  const toolCallId =
    readString(event["tool_call_id"]) ??
    readString(event["toolCallId"]) ??
    readString(event["id"]) ??
    requestId;
  const input =
    event["input"] ??
    event["tool_input"] ??
    event["toolInput"] ??
    event["arguments"] ??
    event["params"] ??
    event;

  if (humanInteractionHandler === undefined) {
    writeControlResponse(child, requestId, {
      behavior: "deny",
      message: "No approval handler is configured.",
    });
    return;
  }

  const response = await humanInteractionHandler({
    kind: "tool_approval",
    toolName,
    toolCallId,
    reason: "Claude Code requested tool approval.",
    input,
  });

  if (response.kind !== "tool_approval" || !response.approved) {
    writeControlResponse(child, requestId, {
      behavior: "deny",
      message:
        response.kind === "tool_approval" && response.reason !== undefined
          ? response.reason
          : `User declined ${toolName}.`,
    });
    return;
  }

  writeControlResponse(child, requestId, {
    behavior: "allow",
    updatedInput: response.updatedInput ?? input,
  });
}

function writeControlResponse(
  child: ChildProcessWithoutNullStreams,
  requestId: string | undefined,
  response: Record<string, unknown>,
): void {
  child.stdin.write(
    `${JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        ...(requestId === undefined ? {} : { request_id: requestId }),
        response,
      },
    })}\n`,
  );
}

function readContentBlocks(message: Record<string, unknown>): readonly Record<string, unknown>[] {
  const content = message["content"];
  if (!Array.isArray(content)) {
    return [];
  }

  return content.filter(isRecord);
}

function readToolResultText(block: Record<string, unknown>): string | undefined {
  const content = block["content"];

  if (typeof content === "string" && content.trim() !== "") {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  return content
    .map((item) => readString(readRecord(item)?.["text"]))
    .filter((text): text is string => text !== undefined)
    .join("\n");
}

function readUsage(record: Record<string, unknown>): AgentMessageUsage | undefined {
  const usage =
    readRecord(record["usage"]) ??
    readRecord(record["token_usage"]) ??
    readRecord(record["tokens"]) ??
    readRecord(record["modelUsage"]);

  if (usage === undefined) {
    return undefined;
  }

  const inputTokens = readFirstTokenCount(usage, [
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
    "promptTokens",
    "input",
  ]);
  const outputTokens = readFirstTokenCount(usage, [
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens",
    "output",
  ]);
  const cacheReadTokens = readFirstTokenCount(usage, [
    "cache_read_input_tokens",
    "cacheReadInputTokens",
    "cached_input_tokens",
    "cachedInputTokens",
    "cache_read_tokens",
    "cacheReadTokens",
  ]);
  const cacheWriteTokens = readFirstTokenCount(usage, [
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "cache_write_tokens",
    "cacheWriteTokens",
  ]);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined
  ) {
    return undefined;
  }

  return createUsageFromTokenCounts({
    inputTokens: normalizeTokenCount(inputTokens),
    outputTokens: normalizeTokenCount(outputTokens),
    cacheReadTokens: normalizeTokenCount(cacheReadTokens),
    cacheWriteTokens: normalizeTokenCount(cacheWriteTokens),
  });
}

function convertClaudeMessages(
  messages: readonly ClaudeCodeRuntimeMessage[],
  modelName: string | undefined,
): readonly AgentMessage[] {
  return messages.map((message): AgentMessage => {
    if (message.role === "user") {
      return {
        role: "user",
        content: message.content,
        timestamp: message.timestamp,
      };
    }

    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: [{ type: "text", text: message.content }],
        api: "claude-code-cli",
        provider: "anthropic",
        model: modelName ?? "claude-code",
        usage: readAgentMessageUsage(message.details),
        stopReason: "stop",
        timestamp: message.timestamp,
      };
    }

    return {
      role: "custom",
      customType: "claude-code.runtime",
      content: message.content,
      display: false,
      details: message.details,
      timestamp: message.timestamp,
    };
  });
}

function readAgentMessageUsage(value: unknown): AgentMessageUsage {
  const result = AgentMessageUsageSchema.safeParse(value);

  if (result.success) {
    return result.data;
  }

  return createUsageFromTokenCounts({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
}

function mergeUsage(
  current: AgentMessageUsage | undefined,
  next: AgentMessageUsage | undefined,
): AgentMessageUsage | undefined {
  if (next === undefined) {
    return current;
  }

  if (current === undefined) {
    return next;
  }

  return {
    input: current.input + next.input,
    output: current.output + next.output,
    cacheRead: current.cacheRead + next.cacheRead,
    cacheWrite: current.cacheWrite + next.cacheWrite,
    ...(current.cacheWrite1h === undefined && next.cacheWrite1h === undefined
      ? {}
      : { cacheWrite1h: (current.cacheWrite1h ?? 0) + (next.cacheWrite1h ?? 0) }),
    totalTokens: current.totalTokens + next.totalTokens,
    cost: {
      input: current.cost.input + next.cost.input,
      output: current.cost.output + next.cost.output,
      cacheRead: current.cost.cacheRead + next.cost.cacheRead,
      cacheWrite: current.cost.cacheWrite + next.cost.cacheWrite,
      total: current.cost.total + next.cost.total,
    },
  };
}

function normalizePermissionMode(mode: ClaudeCodeRuntimePermissionMode): string {
  if (mode === "auto") {
    return "acceptEdits";
  }

  if (mode === "dontAsk") {
    return "bypassPermissions";
  }

  return mode;
}

function filterAdditionalArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  let skipNext = false;

  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    const normalized = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;

    if (PROTOCOL_FLAGS.has(normalized)) {
      continue;
    }

    if (PROTOCOL_FLAGS_WITH_VALUE.has(normalized)) {
      skipNext = !arg.includes("=");
      continue;
    }

    result.push(arg);
  }

  return result;
}

function filterClaudeRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isClaudeInternalEnvKey(key)) {
      continue;
    }

    result[key] = value;
  }

  return result;
}

function isClaudeInternalEnvKey(key: string): boolean {
  return (
    key === "CLAUDECODE" ||
    key === "CLAUDE_CODE_ENTRYPOINT" ||
    key === "CLAUDE_CODE_EXECPATH" ||
    key === "CLAUDE_CODE_SESSION_ID" ||
    key === "CLAUDE_CODE_SSE_PORT" ||
    key.startsWith("CLAUDECODE_")
  );
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    return readRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function normalizeTokenCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.trunc(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
