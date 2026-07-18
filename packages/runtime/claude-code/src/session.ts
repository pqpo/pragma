import { AgentMessageUsageSchema, type AgentMessage, type AgentMessageUsage } from "@pragma/shared";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type {
  Expert,
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
import { createUsageFromTokenCounts, hasNonZeroUsage, readFirstTokenCount } from "@pragma/core";

import type { ManagedClaudeCodeConfig } from "./claude-config.ts";
import type {
  ClaudeCodeRuntimeMessage,
  ClaudeCodeRuntimePermissionMode,
  ClaudeCodeRuntimeSessionState,
  ClaudeCodeRuntimeSpawn,
} from "./types.ts";

const MCP_SERVER_NAME = "pragma";
const PERMISSION_TOOL_NAME = "mcp__pragma__request_tool_approval";
const STDERR_TAIL_LIMIT = 8_192;
const PROCESS_TERMINATION_GRACE_MS = 1_000;
const MAX_TEXT_DELTA_LENGTH = 80;
const CLAUDE_TRANSCRIPT_USAGE_MTIME_TOLERANCE_MS = 5_000;

const PROTOCOL_FLAGS_WITH_VALUE = new Set([
  "--mcp-config",
  "--output-format",
  "--input-format",
  "--permission-prompt-tool",
  "--permission-mode",
  "--plugin-dir",
  "--append-system-prompt",
  "--model",
  "--effort",
  "--resume",
  "--settings",
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
  "--include-partial-messages",
]);

export interface ClaudeCodeNativeSession {
  readonly agent: Expert;
  readonly executablePath: string;
  readonly launcherArgs: readonly string[];
  readonly additionalArgs: readonly string[];
  readonly defaultModelName?: string | undefined;
  readonly defaultThinkingLevel?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
  readonly logger: ExpertAgentLogger;
  readonly managedConfig?: ManagedClaudeCodeConfig | undefined;
  readonly mcpServerUrl: string;
  readonly permissionMode: ClaudeCodeRuntimePermissionMode;
  readonly pluginDir: string;
  readonly sessionDir: string;
  readonly spawn?: ClaudeCodeRuntimeSpawn | undefined;
  readonly state: ClaudeCodeRuntimeSessionState;
  readonly systemPrompt: string;
  readonly messages: ClaudeCodeRuntimeMessage[];
  pendingStartupMessages: readonly ExpertAgentStartupMessage[];
  activeProcess?: ChildProcessWithoutNullStreams | undefined;
  activeExitPromise?:
    | Promise<{
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
      }>
    | undefined;
  activeHasExited?: (() => boolean) | undefined;
  activeCancelled: boolean;
}

export function createClaudeCodeNativeSession(options: {
  readonly agent: Expert;
  readonly executablePath: string;
  readonly launcherArgs: readonly string[];
  readonly additionalArgs: readonly string[];
  readonly defaultModelName?: string | undefined;
  readonly defaultThinkingLevel?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
  readonly logger: ExpertAgentLogger;
  readonly managedConfig?: ManagedClaudeCodeConfig | undefined;
  readonly mcpServerUrl: string;
  readonly permissionMode: ClaudeCodeRuntimePermissionMode;
  readonly pluginDir: string;
  readonly sessionDir: string;
  readonly spawn?: ClaudeCodeRuntimeSpawn | undefined;
  readonly startupMessages?: readonly ExpertAgentStartupMessage[] | undefined;
  readonly state: ClaudeCodeRuntimeSessionState;
  readonly systemPrompt: string;
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
    args: [
      ...session.launcherArgs,
      ...(await createClaudeCodeArgs({
        additionalArgs: session.additionalArgs,
        defaultModelName: session.defaultModelName,
        defaultThinkingLevel: session.defaultThinkingLevel,
        managedConfig: session.managedConfig,
        mcpServerUrl: session.mcpServerUrl,
        modelName: turn.modelSelection?.model.modelId,
        thinkingLevel: turn.modelSelection?.thinkingLevel,
        permissionMode: session.permissionMode,
        pluginDir: session.pluginDir,
        sessionDir: session.sessionDir,
        state: session.state,
        systemPrompt: session.systemPrompt,
      })),
    ],
    cwd: session.agent.workspace,
    env: await createClaudeCodeEnv({
      env: session.env,
      managedConfig: session.managedConfig,
      sessionDir: session.sessionDir,
    }),
    humanInteractionHandler: session.humanInteractionHandler,
    logger: session.logger,
    promptParts: [...turn.startupMessages.map((message) => message.content), turn.prompt],
    runId: turn.runId,
    source: {
      kind: "agent",
      runId: turn.runId,
      agentId: session.agent.id,
      path: [],
    },
    emitRuntimeEvent: turn.stream.write,
    spawn: session.spawn,
    onProcessStarted(process, exitPromise, hasExited) {
      session.activeCancelled = false;
      session.activeProcess = process;
      session.activeExitPromise = exitPromise;
      session.activeHasExited = hasExited;
    },
    onProcessClosed(process) {
      if (session.activeProcess === process) {
        session.activeProcess = undefined;
        session.activeExitPromise = undefined;
        session.activeHasExited = undefined;
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
  const exitPromise = session.activeExitPromise;
  const hasExited = session.activeHasExited;
  session.activeCancelled = true;
  if (process === undefined || exitPromise === undefined || hasExited === undefined) {
    return;
  }

  void terminateClaudeCodeProcess({
    process,
    exitPromise,
    hasExited,
    logger: session.logger,
  });
}

export async function collectClaudeCodeUsage(
  session: ClaudeCodeNativeSession,
  startedAt: Date,
  currentUsage: AgentMessageUsage | undefined,
): Promise<AgentMessageUsage | undefined> {
  if (hasNonZeroUsage(currentUsage)) {
    return currentUsage;
  }

  return await scanClaudeTranscriptUsage({
    configDir: resolveClaudeCodeConfigDir(session),
    sessionId: session.state.sessionId,
    startTime: startedAt,
  });
}

interface ClaudeProcessRunResult {
  readonly outputText: string;
  readonly usage?: AgentMessageUsage | undefined;
  readonly sessionId?: string | undefined;
}

interface ClaudeStreamMappingResult {
  readonly events: readonly RuntimeStreamEventInput[];
  readonly outputDelta?: string | undefined;
  readonly thinkingDelta?: string | undefined;
  readonly completedText?: string | undefined;
  readonly partialKind?: "text" | "thinking" | undefined;
  readonly usage?: AgentMessageUsage | undefined;
}

export interface ClaudeToolStreamState {
  readonly startedToolCallIds: Set<string>;
  readonly toolNames: Map<string, string>;
}

class ClaudeCodeRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ClaudeCodeRuntimeError";
  }
}

async function runClaudeCodeProcess({
  executablePath,
  args,
  cwd,
  env,
  humanInteractionHandler,
  logger,
  promptParts,
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
  readonly promptParts: readonly string[];
  readonly runId: string;
  readonly source: RuntimeStreamEvent["source"];
  readonly emitRuntimeEvent: (event: RuntimeStreamEventInput) => void;
  readonly spawn?: ClaudeCodeRuntimeSpawn | undefined;
  readonly onProcessStarted: (
    process: ChildProcessWithoutNullStreams,
    exitPromise: Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>,
    hasExited: () => boolean,
  ) => void;
  readonly onProcessClosed: (process: ChildProcessWithoutNullStreams) => void;
}): Promise<ClaudeProcessRunResult> {
  const child = (spawn ?? defaultSpawn)(executablePath, args, { cwd, env });
  let exited = false;
  const exitPromise = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  onProcessStarted(child, exitPromise, () => exited);

  let outputText = "";
  let usage: AgentMessageUsage | undefined;
  let sessionId: string | undefined;
  let stderrTail = "";
  let finalResultSeen = false;
  let hasSeenPartialTextDelta = false;
  let hasSeenPartialThinkingDelta = false;
  let partialThinkingText = "";
  const toolStreamState: ClaudeToolStreamState = {
    startedToolCallIds: new Set(),
    toolNames: new Map(),
  };

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_LIMIT);
    logger.debug("Claude Code stderr", { chunk });
  });

  child.stdin.write(`${JSON.stringify(createClaudeCodeUserInput(promptParts))}\n`);

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
      if (event["type"] === "system" && event["subtype"] !== "thinking_tokens") {
        logger.debug("Claude Code system event", {
          subtype: event["subtype"],
          status: event["status"],
          message: event["message"],
        });
      }

      const nextSessionId = readString(event["session_id"]) ?? readString(event["sessionId"]);
      if (nextSessionId !== undefined) {
        sessionId = nextSessionId;
      }

      if (event["type"] === "control_request") {
        await respondToControlRequest(child, event, humanInteractionHandler);
        continue;
      }

      if (event["type"] === "result") {
        finalResultSeen = true;
      }

      const message = readRecord(event["message"]);
      const hadOutputDelta = outputText !== "";
      const mapped: ClaudeStreamMappingResult =
        event["type"] === "assistant" && message !== undefined
          ? readAssistantMessageEvent(message, runId, source, {
              textPrefix: hasSeenPartialTextDelta ? outputText : "",
              thinkingPrefix: partialThinkingText,
              skipText: hasSeenPartialTextDelta,
              skipThinking: hasSeenPartialThinkingDelta,
            })
          : mapClaudeStreamEvent(event, runId, source);
      const resultText = event["type"] === "result" ? readString(event["result"]) : undefined;
      const shouldBackfillResultDeltas =
        resultText !== undefined && event["is_error"] !== true && !hadOutputDelta;
      const rawRuntimeEvents = shouldBackfillResultDeltas
        ? [...createMessageDeltaEvents(resultText, runId, source), ...mapped.events]
        : mapped.events;
      const runtimeEvents = normalizeClaudeToolRuntimeEvents(rawRuntimeEvents, toolStreamState);

      for (const runtimeEvent of runtimeEvents) {
        emitRuntimeEvent(runtimeEvent);
      }
      if (mapped.outputDelta !== undefined) {
        outputText += mapped.outputDelta;
      }
      if (mapped.thinkingDelta !== undefined) {
        partialThinkingText += mapped.thinkingDelta;
      }
      if (mapped.completedText !== undefined) {
        outputText = mapped.completedText;
      }
      // See docs/conventions/runtime-usage-accounting.md: Claude Code usage is a snapshot.
      usage = mapped.usage ?? usage;
      if (mapped.partialKind === "text") {
        hasSeenPartialTextDelta = true;
      }
      if (mapped.partialKind === "thinking") {
        hasSeenPartialThinkingDelta = true;
      }

      if (event["type"] === "result") {
        const resultText = readString(event["result"]);
        if (resultText !== undefined) {
          outputText = resultText;
        }
        closeClaudeCodeInput(child);
        if (event["is_error"] === true) {
          throw createClaudeCodeRuntimeError(
            resultText ?? "Claude Code returned an error result.",
            stderrTail,
          );
        }
      }
    }
  })();

  let exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null };
  try {
    [exit] = await Promise.all([exitPromise, readStdout]);
  } catch (error) {
    closeClaudeCodeInput(child);
    await terminateClaudeCodeProcess({
      process: child,
      exitPromise,
      hasExited: () => exited,
      logger,
    });
    throw normalizeClaudeCodeProcessError(error, stderrTail);
  } finally {
    closeClaudeCodeInput(child);
    onProcessClosed(child);
  }

  if (exit.code !== 0) {
    throw createClaudeCodeRuntimeError(
      `Claude Code exited with code ${exit.code ?? "null"}${exit.signal === null ? "" : ` and signal ${exit.signal}`}.`,
      stderrTail,
    );
  }

  if (!finalResultSeen && outputText.trim() === "") {
    throw createClaudeCodeRuntimeError("Claude Code completed without a result.", stderrTail);
  }

  return {
    outputText,
    ...(usage === undefined ? {} : { usage }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

export function normalizeClaudeToolRuntimeEvents(
  events: readonly RuntimeStreamEventInput[],
  state: ClaudeToolStreamState,
): readonly RuntimeStreamEventInput[] {
  return events.flatMap((event) => {
    if (!event.type.startsWith("tool.")) {
      return [event];
    }

    const payload = readRecord(event.payload);
    const toolCallId = readString(payload?.["toolCallId"]);
    if (payload === undefined || toolCallId === undefined) {
      return [event];
    }

    const toolName = readString(payload["toolName"]);
    if (event.type === "tool.started") {
      if (state.startedToolCallIds.has(toolCallId)) {
        return [];
      }
      state.startedToolCallIds.add(toolCallId);
      if (toolName !== undefined && toolName !== "claude_tool") {
        state.toolNames.set(toolCallId, toolName);
      }
      return [event];
    }

    const knownToolName = state.toolNames.get(toolCallId);
    if (knownToolName === undefined || (toolName !== undefined && toolName !== "claude_tool")) {
      return [event];
    }

    return [
      {
        ...event,
        payload: {
          ...payload,
          toolName: knownToolName,
        },
      } as RuntimeStreamEventInput,
    ];
  });
}

function closeClaudeCodeInput(child: ChildProcessWithoutNullStreams): void {
  if (child.stdin.destroyed || child.stdin.writableEnded) {
    return;
  }

  try {
    child.stdin.end();
  } catch {
    child.stdin.destroy();
  }
}

async function terminateClaudeCodeProcess({
  process,
  exitPromise,
  hasExited,
  logger,
}: {
  readonly process: ChildProcessWithoutNullStreams;
  readonly exitPromise: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly hasExited: () => boolean;
  readonly logger: ExpertAgentLogger;
}): Promise<void> {
  if (hasExited()) {
    return;
  }

  process.kill("SIGTERM");
  if (await waitForClaudeCodeExit(exitPromise)) {
    return;
  }

  logger.warn("Claude Code did not exit after SIGTERM; sending SIGKILL.");
  process.kill("SIGKILL");
  await waitForClaudeCodeExit(exitPromise);
}

async function waitForClaudeCodeExit(
  exitPromise: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>,
): Promise<boolean> {
  return await Promise.race([
    exitPromise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), PROCESS_TERMINATION_GRACE_MS);
    }),
  ]);
}

function normalizeClaudeCodeProcessError(error: unknown, stderrTail: string): Error {
  if (error instanceof ClaudeCodeRuntimeError) {
    return error;
  }

  if (error instanceof Error) {
    return createClaudeCodeRuntimeError(error.message, stderrTail);
  }

  return createClaudeCodeRuntimeError("Claude Code process failed.", stderrTail);
}

function createClaudeCodeRuntimeError(message: string, stderrTail = ""): ClaudeCodeRuntimeError {
  const trimmedStderr = stderrTail.trim();
  const combinedMessage = trimmedStderr === "" ? message : `${message}\n${trimmedStderr}`;
  const code = inferClaudeCodeRuntimeErrorCode(combinedMessage);

  return new ClaudeCodeRuntimeError(combinedMessage, code, code !== "runtime.auth_invalid");
}

function inferClaudeCodeRuntimeErrorCode(message: string): string {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("429") ||
    normalized.includes("rate limit") ||
    normalized.includes("rate_limit") ||
    normalized.includes("too many requests")
  ) {
    return "runtime.rate_limited";
  }

  if (
    normalized.includes("invalid api key") ||
    normalized.includes("invalid x-api-key") ||
    normalized.includes("incorrect api key") ||
    normalized.includes("authentication") ||
    normalized.includes("unauthorized")
  ) {
    return "runtime.auth_invalid";
  }

  return "runtime.process_failed";
}

async function createClaudeCodeArgs({
  additionalArgs,
  defaultModelName,
  defaultThinkingLevel,
  managedConfig,
  mcpServerUrl,
  modelName,
  thinkingLevel,
  permissionMode,
  pluginDir,
  sessionDir,
  state,
  systemPrompt,
}: {
  readonly additionalArgs: readonly string[];
  readonly defaultModelName?: string | undefined;
  readonly defaultThinkingLevel?: string | undefined;
  readonly managedConfig?: ManagedClaudeCodeConfig | undefined;
  readonly mcpServerUrl: string;
  readonly modelName?: string | undefined;
  readonly thinkingLevel?: string | undefined;
  readonly permissionMode: ClaudeCodeRuntimePermissionMode;
  readonly pluginDir: string;
  readonly sessionDir: string;
  readonly state: ClaudeCodeRuntimeSessionState;
  readonly systemPrompt: string;
}): Promise<readonly string[]> {
  const mcpConfigPath = await writeClaudeCodeMcpConfig(sessionDir, mcpServerUrl);
  const selectedModel = modelName ?? defaultModelName;
  const selectedThinkingLevel = thinkingLevel ?? defaultThinkingLevel;
  const settingsArgs =
    managedConfig?.settingsPath === undefined ? [] : ["--settings", managedConfig.settingsPath];
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--bare",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
    ...settingsArgs,
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
    ...(selectedThinkingLevel === undefined ? [] : ["--effort", selectedThinkingLevel]),
    ...(state.sessionId === "" ? [] : ["--resume", state.sessionId]),
    ...filterAdditionalArgs(additionalArgs),
  ];

  return args;
}

export async function writeClaudeCodeMcpConfig(
  sessionDir: string,
  mcpServerUrl: string,
): Promise<string> {
  const path = join(sessionDir, "mcp-config.json");
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
  managedConfig,
  sessionDir,
}: {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly managedConfig?: ManagedClaudeCodeConfig | undefined;
  readonly sessionDir: string;
}): Promise<NodeJS.ProcessEnv> {
  const nextEnv = {
    ...(env ?? filterClaudeRuntimeEnv(process.env)),
  };

  const configDir = managedConfig?.configDir ?? join(sessionDir, "config");
  await mkdir(configDir, { recursive: true });
  nextEnv["CLAUDE_CONFIG_DIR"] = configDir;

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

function createClaudeCodeUserInput(promptParts: readonly string[]): Record<string, unknown> {
  return {
    type: "user",
    message: {
      role: "user",
      content: promptParts
        .filter((part) => part.trim() !== "")
        .map((part) => ({
          type: "text",
          text: part,
        })),
    },
  };
}

function mapClaudeStreamEvent(
  event: Record<string, unknown>,
  runId: string,
  source: RuntimeStreamEvent["source"],
): ClaudeStreamMappingResult {
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
    // Claude emits internal lifecycle and thinking-token accounting events in
    // the same stream as user-facing deltas. They carry no displayable progress
    // message and must not interrupt a contiguous Thinking section.
    return { events: [] };
  }

  if (type === "stream_event") {
    return readClaudeSdkStreamEvent(event, runId, source);
  }

  return { events: [] };
}

export function readAssistantMessageEvent(
  message: Record<string, unknown>,
  runId: string,
  source: RuntimeStreamEvent["source"],
  options: {
    readonly textPrefix?: string | undefined;
    readonly thinkingPrefix?: string | undefined;
    readonly skipText?: boolean | undefined;
    readonly skipThinking?: boolean | undefined;
  } = {},
): {
  readonly events: readonly RuntimeStreamEventInput[];
  readonly outputDelta?: string | undefined;
  readonly thinkingDelta?: string | undefined;
  readonly usage?: AgentMessageUsage | undefined;
} {
  const runtimeEvents: RuntimeStreamEventInput[] = [];
  let outputDelta = "";
  let thinkingDelta = "";
  let textPrefix = options.textPrefix ?? "";
  let thinkingPrefix = options.thinkingPrefix ?? "";

  for (const block of readContentBlocks(message)) {
    const blockType = readString(block["type"]);

    if (blockType === "text") {
      if (options.skipText === true) {
        continue;
      }
      const text = readString(block["text"]);
      if (text !== undefined) {
        const delta = removeKnownTextPrefix(text, textPrefix);
        textPrefix = removeConsumedTextPrefix(textPrefix, text);
        if (delta !== "") {
          outputDelta += delta;
          runtimeEvents.push(...createMessageDeltaEvents(delta, runId, source));
        }
      }
      continue;
    }

    if (blockType === "thinking") {
      if (options.skipThinking === true) {
        continue;
      }
      const thinking = readString(block["thinking"]);
      if (thinking !== undefined) {
        const delta = removeKnownTextPrefix(thinking, thinkingPrefix);
        thinkingPrefix = removeConsumedTextPrefix(thinkingPrefix, thinking);
        if (delta !== "") {
          thinkingDelta += delta;
          runtimeEvents.push(createThoughtDeltaEvent(delta, runId, source));
        }
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
    ...(thinkingDelta === "" ? {} : { thinkingDelta }),
    ...(usage === undefined ? {} : { usage }),
  };
}

function readClaudeSdkStreamEvent(
  event: Record<string, unknown>,
  runId: string,
  source: RuntimeStreamEvent["source"],
): ClaudeStreamMappingResult {
  const streamEvent = readClaudeSdkStreamPayload(event);
  const type = readString(streamEvent?.["type"]);

  if (streamEvent === undefined || type === undefined) {
    return { events: [] };
  }

  if (type === "content_block_delta") {
    const delta = readRecord(streamEvent["delta"]);
    const deltaType = readString(delta?.["type"]);

    if (deltaType === "text_delta") {
      const text = readString(delta?.["text"]);
      return text === undefined
        ? { events: [] }
        : {
            events: createMessageDeltaEvents(text, runId, source),
            outputDelta: text,
            partialKind: "text",
          };
    }

    if (deltaType === "thinking_delta") {
      const thinking = readString(delta?.["thinking"]);
      return thinking === undefined
        ? { events: [] }
        : {
            events: [createThoughtDeltaEvent(thinking, runId, source)],
            thinkingDelta: thinking,
            partialKind: "thinking",
          };
    }
  }

  if (type === "content_block_start") {
    const contentBlock = readRecord(streamEvent["content_block"]);
    if (readString(contentBlock?.["type"]) === "tool_use") {
      return {
        events: [
          {
            runId,
            source,
            type: "tool.started",
            payload: {
              toolCallId: readString(contentBlock?.["id"]) ?? randomUUID(),
              toolName: readString(contentBlock?.["name"]) ?? "claude_tool",
              kind: "tool",
              inputPreview: contentBlock?.["input"],
            },
          },
        ],
      };
    }
  }

  return {
    events: [],
    usage: readUsage(streamEvent),
  };
}

function readClaudeSdkStreamPayload(
  event: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return (
    readRecord(event["event"]) ?? readRecord(event["stream_event"]) ?? readRecord(event["payload"])
  );
}

function removeKnownTextPrefix(text: string, prefix: string): string {
  if (prefix === "") {
    return text;
  }

  if (text.startsWith(prefix)) {
    return text.slice(prefix.length);
  }

  if (prefix.startsWith(text)) {
    return "";
  }

  return text;
}

function removeConsumedTextPrefix(prefix: string, text: string): string {
  if (prefix === "") {
    return "";
  }

  if (text.startsWith(prefix)) {
    return "";
  }

  if (prefix.startsWith(text)) {
    return prefix.slice(text.length);
  }

  return "";
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

function createMessageDeltaEvents(
  text: string,
  runId: string,
  source: RuntimeStreamEvent["source"],
): RuntimeStreamEventInput[] {
  return splitTextDeltas(text).map((delta) => ({
    runId,
    source,
    type: "message.delta",
    payload: {
      role: "assistant",
      contentType: "text",
      delta,
    },
  }));
}

function createThoughtDeltaEvent(
  delta: string,
  runId: string,
  source: RuntimeStreamEvent["source"],
): RuntimeStreamEventInput {
  return {
    runId,
    source,
    type: "thought.delta",
    payload: {
      contentType: "text",
      delta,
    },
  };
}

function splitTextDeltas(text: string): string[] {
  const chars = Array.from(text);
  const chunks: string[] = [];

  for (let index = 0; index < chars.length; index += MAX_TEXT_DELTA_LENGTH) {
    chunks.push(chars.slice(index, index + MAX_TEXT_DELTA_LENGTH).join(""));
  }

  return chunks;
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

function resolveClaudeCodeConfigDir(session: ClaudeCodeNativeSession): string {
  const configDir = session.managedConfig?.configDir;
  if (configDir === undefined) {
    throw new Error("Claude Code session is missing its Execution-owned managed config directory.");
  }
  return configDir;
}

async function scanClaudeTranscriptUsage({
  configDir,
  sessionId,
  startTime,
}: {
  readonly configDir: string;
  readonly sessionId: string;
  readonly startTime: Date;
}): Promise<AgentMessageUsage | undefined> {
  const root = join(configDir, "projects");
  const candidates = await listClaudeTranscriptCandidates(root, sessionId, startTime);

  candidates.sort((left, right) => left.mtime - right.mtime || left.path.localeCompare(right.path));

  let result: AgentMessageUsage | undefined;

  for (const candidate of candidates) {
    result = (await parseClaudeTranscriptUsageFile(candidate.path)) ?? result;
  }

  return hasNonZeroUsage(result) ? result : undefined;
}

async function listClaudeTranscriptCandidates(
  root: string,
  sessionId: string,
  startTime: Date,
): Promise<{ readonly path: string; readonly mtime: number }[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates: { readonly path: string; readonly mtime: number }[] = [];
  const expectedFileName = sessionId === "" ? undefined : `${sessionId}.jsonl`;

  for (const entry of entries) {
    const path = join(root, entry.name);

    if (entry.isDirectory()) {
      candidates.push(...(await listClaudeTranscriptCandidates(path, sessionId, startTime)));
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }

    if (expectedFileName !== undefined && entry.name !== expectedFileName) {
      continue;
    }

    const info = await stat(path).catch(() => undefined);

    if (
      info === undefined ||
      info.mtime.getTime() + CLAUDE_TRANSCRIPT_USAGE_MTIME_TOLERANCE_MS < startTime.getTime()
    ) {
      continue;
    }

    candidates.push({ path, mtime: info.mtime.getTime() });
  }

  return candidates;
}

async function parseClaudeTranscriptUsageFile(
  path: string,
): Promise<AgentMessageUsage | undefined> {
  const content = await readFile(path, "utf8").catch(() => undefined);

  if (content === undefined) {
    return undefined;
  }

  let result: AgentMessageUsage | undefined;

  for (const line of content.split("\n")) {
    if (!line.includes("usage") && !line.includes("modelUsage")) {
      continue;
    }

    const event = parseJsonRecord(line);
    const message = readRecord(event?.["message"]);
    const usage = readUsage(message ?? event ?? {});

    if (usage !== undefined) {
      result = usage;
    }
  }

  return result;
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
    inputTokensIncludeCacheRead: false,
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
    inputTokensIncludeCacheRead: false,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
}

function normalizePermissionMode(mode: ClaudeCodeRuntimePermissionMode): string {
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

export function filterClaudeRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
