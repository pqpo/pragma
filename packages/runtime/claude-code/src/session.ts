import { AgentMessageUsageSchema, type AgentMessage, type AgentMessageUsage } from "@pragma/shared";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type {
  AgentLifecycle,
  ExpertAgent,
  ExpertAgentHumanInteractionHandler,
  ExpertAgentLogger,
  ExpertAgentRunContext,
  ExpertAgentStartupMessage,
  RuntimeAgentSession,
  RuntimeOutputSchema,
  RuntimeRunResult,
  RuntimeSessionInfo,
  RuntimeSessionStorageContext,
  RuntimeSessionSyncCallback,
  RuntimeStreamEvent,
  RuntimeStreamEventInput,
  RuntimeSubmitRequest,
  WorkflowToolRuntimeState,
} from "@pragma/core";
import { AsyncPushQueue, createRuntimeEventEmitter, dispatchExpertAgentHook } from "@pragma/core";

import type {
  ClaudeCodeRuntimeIsolationMode,
  ClaudeCodeRuntimeMessage,
  ClaudeCodeRuntimePermissionMode,
  ClaudeCodeRuntimeSessionState,
  ClaudeCodeRuntimeSpawn,
} from "./types.ts";

const MCP_SERVER_NAME = "pragma";
const PERMISSION_TOOL_NAME = "mcp__pragma__request_tool_approval";
const DEFAULT_OUTPUT_RETRY_LIMIT = 1;
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

export function createClaudeCodeRuntimeSession({
  agent,
  executablePath,
  additionalArgs,
  defaultModelName,
  env,
  humanInteractionHandler,
  info,
  isolationMode,
  lifecycle,
  logger,
  mcpServerUrl,
  outputRetryLimit,
  permissionMode,
  pluginDir,
  sessionDir,
  sessionStorageContext,
  sessionSyncCallback,
  spawn,
  startupMessages,
  state,
  toolRuntimeState,
}: {
  readonly agent: ExpertAgent;
  readonly executablePath: string;
  readonly additionalArgs: readonly string[];
  readonly defaultModelName?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
  readonly info: Omit<RuntimeSessionInfo, "sessionState" | "runState">;
  readonly isolationMode: ClaudeCodeRuntimeIsolationMode;
  readonly lifecycle: AgentLifecycle<ExpertAgentRunContext | undefined>;
  readonly logger: ExpertAgentLogger;
  readonly mcpServerUrl: string;
  readonly outputRetryLimit?: number | undefined;
  readonly permissionMode: ClaudeCodeRuntimePermissionMode;
  readonly pluginDir: string;
  readonly sessionDir: string;
  readonly sessionStorageContext?: RuntimeSessionStorageContext | undefined;
  readonly sessionSyncCallback?: RuntimeSessionSyncCallback | undefined;
  readonly spawn?: ClaudeCodeRuntimeSpawn | undefined;
  readonly startupMessages?: readonly ExpertAgentStartupMessage[] | undefined;
  readonly state: ClaudeCodeRuntimeSessionState;
  readonly toolRuntimeState?: WorkflowToolRuntimeState | undefined;
}): RuntimeAgentSession {
  const messages: ClaudeCodeRuntimeMessage[] = [];
  let pendingStartupMessages = [...(startupMessages ?? [])];
  let activeProcess: ChildProcessWithoutNullStreams | undefined;
  let activeCancelled = false;

  const syncSession = async (): Promise<void> => {
    if (sessionSyncCallback === undefined || sessionStorageContext === undefined) {
      return;
    }

    await sessionSyncCallback({
      ...sessionStorageContext,
      runtimeSession: {
        type: sessionStorageContext.runtimeSession.type,
        id: state.sessionId,
      },
    });
  };

  const killActiveProcess = (): void => {
    activeCancelled = true;
    activeProcess?.kill("SIGTERM");
    setTimeout(() => {
      activeProcess?.kill("SIGKILL");
    }, 1_000).unref();
  };

  return {
    info: () => createSessionInfo(info, lifecycle, state.sessionId),
    messages: () => convertClaudeMessages(messages, defaultModelName),
    submit<TSubmitOutput = string>(submission: RuntimeSubmitRequest<TSubmitOutput>) {
      const runId = submission.runId ?? randomUUID();
      const queue = new AsyncPushQueue<RuntimeStreamEvent>();
      const emitter = createRuntimeEventEmitter(queue);
      const pendingHookCalls: Promise<void>[] = [];
      let cancelled = false;

      const result = lifecycle.enqueue(async ({ signal }) => {
        const source = {
          kind: "agent" as const,
          runId,
          agentId: agent.id,
          displayName: agent.name,
          path: [],
        };
        let emittedSequence = 0;
        const emitRuntimeEvent = (event: RuntimeStreamEventInput): void => {
          const completeEvent = {
            schemaVersion: "pragma.stream/v1",
            eventId: randomUUID(),
            emittedAt: new Date().toISOString(),
            sequence: emittedSequence++,
            ...event,
          } as RuntimeStreamEvent;
          emitter.emit(completeEvent);
          pendingHookCalls.push(
            dispatchExpertAgentHook(agent.hooks, "onStreamEvent", {
              agent,
              session: createSessionInfo(info, lifecycle, state.sessionId),
              runId,
              event: completeEvent,
              context: lifecycle.currentContext,
              logger,
            }),
          );
        };

        if (toolRuntimeState !== undefined) {
          toolRuntimeState.runId = runId;
          toolRuntimeState.source = source;
          toolRuntimeState.emitter = emitter;
        }

        const abortCurrentRun = (): void => {
          cancelled = true;
          killActiveProcess();
        };
        signal.addEventListener("abort", abortCurrentRun, { once: true });

        await dispatchExpertAgentHook(agent.hooks, "beforeTaskSubmit", {
          agent,
          session: createSessionInfo(info, lifecycle, state.sessionId),
          runId,
          submission,
          context: lifecycle.currentContext,
          logger,
        });

        emitRuntimeEvent({
          runId,
          source,
          type: "run.started",
          payload: {
            task: submission.query,
            inputSummary: summarizeInput(submission.query),
          },
        });

        const startupMessagesForRun = pendingStartupMessages;
        pendingStartupMessages = [];
        if (startupMessagesForRun.length > 0) {
          const timestamp = Date.now();
          messages.push(
            ...startupMessagesForRun.map((message, index) => ({
              role: "user" as const,
              content: message.content,
              timestamp: timestamp + index,
            })),
          );
        }

        messages.push({
          role: "user",
          content: submission.query,
          timestamp: Date.now(),
        });

        try {
          const maxAttempts =
            submission.output === undefined
              ? 1
              : normalizeOutputRetryLimit(submission.outputRetryLimit ?? outputRetryLimit) + 1;
          let outputText = "";
          let usage: AgentMessageUsage | undefined;
          let parseResult: ParseRuntimeOutputResult<TSubmitOutput> | undefined;

          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            outputText = "";
            const prompt =
              attempt === 1
                ? createInitialPrompt(submission.query, submission.output, startupMessagesForRun)
                : createOutputRetryPrompt(parseResult);
            const run = await runClaudeCodeProcess({
              executablePath,
              args: await createClaudeCodeArgs({
                additionalArgs,
                defaultModelName,
                mcpServerUrl,
                modelName: submission.modelName,
                permissionMode,
                pluginDir,
                sessionDir,
                state,
                systemPrompt: createSystemPrompt(agent),
              }),
              cwd: agent.workspace,
              env: await createClaudeCodeEnv({ env, isolationMode, sessionDir }),
              humanInteractionHandler,
              logger,
              prompt,
              runId,
              source,
              emitRuntimeEvent,
              spawn,
              onProcessStarted(process) {
                activeCancelled = false;
                activeProcess = process;
              },
              onProcessClosed(process) {
                if (activeProcess === process) {
                  activeProcess = undefined;
                }
              },
            });

            outputText = run.outputText;
            usage = mergeUsage(usage, run.usage);

            if (run.sessionId !== undefined && run.sessionId !== state.sessionId) {
              state.sessionId = run.sessionId;
              await syncSession();
            }

            parseResult = parseRuntimeOutput(outputText, submission.output);

            if (parseResult.ok) {
              break;
            }

            if (attempt === maxAttempts) {
              throw parseResult.error;
            }
          }

          if (parseResult === undefined || !parseResult.ok) {
            throw new Error("Claude Code runtime output parsing did not complete.");
          }

          messages.push({
            role: "assistant",
            content: outputText,
            timestamp: Date.now(),
            details: usage,
          });
          const runResult = createRuntimeRunResult(runId, parseResult.value, usage);

          emitRuntimeEvent({
            runId,
            source,
            type: "run.completed",
            payload: usage === undefined ? {} : { usage },
          });
          await dispatchExpertAgentHook(agent.hooks, "afterTaskSubmit", {
            agent,
            session: createSessionInfo(info, lifecycle, state.sessionId),
            runId,
            submission,
            result: runResult,
            context: lifecycle.currentContext,
            logger,
          });

          return runResult;
        } catch (error) {
          const wasCancelled = signal.aborted || cancelled || activeCancelled;
          const message =
            error instanceof Error ? error.message : "Claude Code runtime run failed.";

          emitRuntimeEvent({
            runId,
            source,
            type: wasCancelled ? "run.cancelled" : "run.failed",
            payload: wasCancelled ? { reason: "cancelled" } : { message },
          });
          await dispatchExpertAgentHook(agent.hooks, "afterTaskSubmit", {
            agent,
            session: createSessionInfo(info, lifecycle, state.sessionId),
            runId,
            submission,
            error,
            context: lifecycle.currentContext,
            logger,
          });
          throw error;
        } finally {
          signal.removeEventListener("abort", abortCurrentRun);
          await Promise.allSettled(pendingHookCalls);
          if (toolRuntimeState !== undefined) {
            delete toolRuntimeState.runId;
            delete toolRuntimeState.source;
            delete toolRuntimeState.emitter;
          }
          emitter.complete();
        }
      });

      return {
        runId,
        events: queue,
        result,
        async cancel() {
          cancelled = true;
          killActiveProcess();
          await lifecycle.abort();
        },
      };
    },
    async abort() {
      killActiveProcess();
      await lifecycle.abort();
    },
  };
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

function createSessionInfo(
  info: Omit<RuntimeSessionInfo, "sessionState" | "runState">,
  lifecycle: AgentLifecycle,
  sessionId: string,
): RuntimeSessionInfo {
  return {
    ...info,
    runtimeSession: {
      type: info.runtimeSession.type,
      id: sessionId,
    },
    sessionState: lifecycle.sessionState,
    runState: lifecycle.runState,
  };
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

  return createUsage({
    inputTokens: normalizeTokenCount(inputTokens),
    outputTokens: normalizeTokenCount(outputTokens),
    cacheReadTokens: normalizeTokenCount(cacheReadTokens),
    cacheWriteTokens: normalizeTokenCount(cacheWriteTokens),
  });
}

function createRuntimeRunResult<TOutput>(
  runId: string,
  output: TOutput,
  usage: AgentMessageUsage | undefined,
): RuntimeRunResult<TOutput> {
  return {
    runId,
    result: {
      output,
      ...(usage === undefined ? {} : { usage }),
    },
  };
}

function parseRuntimeOutput<TOutput>(
  text: string,
  output: RuntimeOutputSchema<TOutput> | undefined,
): ParseRuntimeOutputResult<TOutput> {
  try {
    if (output === undefined) {
      return { ok: true, value: text as TOutput };
    }

    const json = tryParseJsonLike(text);
    return { ok: true, value: output.parse(json.ok ? json.value : text) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

type ParseRuntimeOutputResult<TOutput> =
  | { readonly ok: true; readonly value: TOutput }
  | { readonly ok: false; readonly error: Error };

function createInitialPrompt(
  query: string,
  output: RuntimeOutputSchema<unknown> | undefined,
  startupMessages: readonly ExpertAgentStartupMessage[],
): string {
  const prompt =
    output === undefined
      ? query
      : `${query}

Return the final answer as valid JSON only. Do not include Markdown fences, prose, comments, or any characters before or after the JSON value. The JSON value must satisfy the requested output schema.`;

  return [...startupMessages.map((message) => message.content), prompt].join("\n\n");
}

function createOutputRetryPrompt(
  parseResult: ParseRuntimeOutputResult<unknown> | undefined,
): string {
  const message =
    parseResult !== undefined && !parseResult.ok
      ? parseResult.error.message
      : "The previous response could not be parsed.";

  return `The previous response did not satisfy the required JSON output format.

Parser error:
${message}

Reply again with valid JSON only. Do not include Markdown fences, prose, comments, or any characters before or after the JSON value.`;
}

function normalizeOutputRetryLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_OUTPUT_RETRY_LIMIT;
  }

  return Math.trunc(value);
}

function tryParseJsonLike(
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const trimmed = text.trim();
  const candidates = [trimmed, ...extractFencedCodeBlocks(trimmed)];
  const balanced = extractBalancedJsonValue(trimmed);

  if (balanced !== undefined) {
    candidates.push(balanced);
  }

  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) as unknown };
    } catch {
      continue;
    }
  }

  return { ok: false };
}

function extractFencedCodeBlocks(text: string): string[] {
  const matches = text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g);
  return [...matches].map((match) => match[1] ?? "");
}

function extractBalancedJsonValue(text: string): string | undefined {
  const start = [...text].findIndex((char) => char === "{" || char === "[");

  if (start < 0) {
    return undefined;
  }

  const open = text[start];
  const close = open === "{" ? "}" : "]";
  const end = text.lastIndexOf(close);

  if (end <= start) {
    return undefined;
  }

  return text.slice(start, end + 1);
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

  return createUsage({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
}

function createUsage(usage: {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}): AgentMessageUsage {
  const input = Math.max(usage.inputTokens - usage.cacheReadTokens, 0);

  return {
    input,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens,
    totalTokens: input + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
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

function readFirstTokenCount(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  let zeroValue: number | undefined;

  for (const key of keys) {
    const value = readNumber(record[key]);

    if (value === undefined) {
      continue;
    }

    const normalized = normalizeTokenCount(value);

    if (normalized > 0) {
      return normalized;
    }

    zeroValue = 0;
  }

  return zeroValue;
}

function normalizeTokenCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.trunc(value);
}

function summarizeInput(input: string): string {
  const compact = input.replace(/\s+/g, " ").trim();
  return compact.length <= 160 ? compact : `${compact.slice(0, 157)}...`;
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

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
