import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { AgentAssistantMessage, AgentMessage, AgentMessageUsage } from "@pragma/shared";
import {
  createUsageFromTokenCounts,
  defaultRuntimeTokenCounter,
  hasNonZeroUsage,
  readFirstTokenCount,
  RUNTIME_CONTEXT_COMPACTION_STAGES,
  type Expert,
  type ExpertAgentStartupMessage,
  type ExpertToolRuntimeState,
  type PragmaLogger,
  type RuntimeEventMappingContext,
  type RuntimeEventMappingResult,
  type RuntimeTokenCounter,
  type RuntimeTokenModelIdentity,
  type RuntimeTurnContext,
  type RuntimeTurnResult,
} from "@pragma/core";
import { z } from "zod";

import { assertAntigravityWorkspaceCustomizationsAreIsolated } from "./workspace-customizations.ts";
import type { ManagedAntigravityHome } from "./managed-home.ts";
import type { AntigravityRuntimePermissionMode, AntigravityRuntimeSpawn } from "./types.ts";

const MAX_NDJSON_LINE_BYTES = 4 * 1024 * 1024;
const STDERR_TAIL_LIMIT = 16 * 1024;
const LOG_TAIL_LIMIT = 64 * 1024;
const TRANSCRIPT_TAIL_LIMIT = 4 * 1024 * 1024;
const PROCESS_TERMINATION_GRACE_MS = 1_000;
const PRINT_TIMEOUT = "24h";
const ANTIGRAVITY_CONVERSATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANTIGRAVITY_TRANSCRIPT_ROOTS = ["antigravity", "antigravity-cli"] as const;

type AntigravityTranscriptRoot = (typeof ANTIGRAVITY_TRANSCRIPT_ROOTS)[number];

const AgyStreamRecordSchema = z.union([
  // agy 1.1.11 uses `event` and places the matching payload under a
  // same-named property (`result`, `init`, or `step_update`). Keep `type`
  // support for the 1.1.8-era shape and compatible wrappers.
  z.object({ event: z.string().min(1) }).passthrough(),
  z.object({ type: z.string().min(1) }).passthrough(),
]);

export type AntigravityNativeEvent =
  | { readonly kind: "message-delta"; readonly text: string }
  | { readonly kind: "thought-delta"; readonly text: string }
  | { readonly kind: "message-completed"; readonly text: string }
  | {
      readonly kind: "tool-started";
      readonly id: string;
      readonly name: string;
      readonly input?: unknown;
    }
  | {
      readonly kind: "tool-delta";
      readonly id: string;
      readonly name: string;
      readonly delta: string;
    }
  | {
      readonly kind: "tool-completed";
      readonly id: string;
      readonly name: string;
      readonly output?: unknown;
      readonly failed?: boolean;
    }
  | { readonly kind: "progress"; readonly stage: string; readonly data?: unknown }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "usage"; readonly usage: AgentMessageUsage };

export interface AntigravityNativeSession {
  readonly agent: Expert;
  readonly executablePath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly logger: PragmaLogger;
  readonly managedHome: ManagedAntigravityHome;
  readonly permissionMode: AntigravityRuntimePermissionMode;
  readonly defaultModelName?: string | undefined;
  readonly defaultThinkingLevel?: string | undefined;
  readonly spawn?: AntigravityRuntimeSpawn | undefined;
  readonly systemPrompt: string;
  readonly toolRuntimeState: ExpertToolRuntimeState;
  readonly tokenCounter: RuntimeTokenCounter;
  readonly messages: AgentMessage[];
  pendingStartupMessages: readonly ExpertAgentStartupMessage[];
  sessionId: string;
  tokenModelIdentity: RuntimeTokenModelIdentity;
  activeProcess?: ChildProcessWithoutNullStreams | undefined;
  activeExitPromise?: Promise<ProcessExit> | undefined;
  activeHasExited?: (() => boolean) | undefined;
}

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface ProcessRunResult {
  readonly outputText: string;
  readonly usage?: AgentMessageUsage | undefined;
  readonly sessionId?: string | undefined;
}

type TranscriptCheckpoint =
  | { readonly kind: "missing" | "unavailable" }
  | {
      readonly kind: "tracked";
      readonly size: number;
      readonly dev: number;
      readonly ino: number;
    };

type TranscriptCheckpoints = ReadonlyMap<AntigravityTranscriptRoot, TranscriptCheckpoint>;

interface StreamState {
  readonly textSnapshots: Map<string, string>;
  readonly thoughtSnapshots: Map<string, string>;
  readonly tools: Map<string, { readonly name: string; outputText: string; completed: boolean }>;
  readonly compactions: Map<string, "started" | "completed" | "failed">;
  outputText: string;
  sessionId?: string | undefined;
  usage?: AgentMessageUsage | undefined;
  resultText?: string | undefined;
  resultError?: string | undefined;
  terminalSeen: boolean;
  plainTextOutput: boolean;
}

export function createAntigravityNativeSession(options: {
  readonly agent: Expert;
  readonly executablePath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly logger: PragmaLogger;
  readonly managedHome: ManagedAntigravityHome;
  readonly permissionMode: AntigravityRuntimePermissionMode;
  readonly defaultModelName?: string | undefined;
  readonly defaultThinkingLevel?: string | undefined;
  readonly spawn?: AntigravityRuntimeSpawn | undefined;
  readonly systemPrompt: string;
  readonly toolRuntimeState: ExpertToolRuntimeState;
  readonly tokenCounter?: RuntimeTokenCounter | undefined;
  readonly startupMessages?: readonly ExpertAgentStartupMessage[] | undefined;
  readonly sessionId?: string | undefined;
}): AntigravityNativeSession {
  const sessionId = options.sessionId ?? "";
  if (sessionId !== "") assertAntigravityConversationId(sessionId);
  return {
    ...options,
    tokenCounter: options.tokenCounter ?? defaultRuntimeTokenCounter,
    tokenModelIdentity: antigravityTokenModelIdentity(options.defaultModelName),
    messages: [],
    pendingStartupMessages: options.startupMessages ?? [],
    sessionId,
  };
}

export function listAntigravityMessages(
  session: AntigravityNativeSession,
): readonly AgentMessage[] {
  return session.messages;
}

export function consumeAntigravityStartupMessages(
  session: AntigravityNativeSession,
): readonly ExpertAgentStartupMessage[] {
  const messages = session.pendingStartupMessages;
  session.pendingStartupMessages = [];
  return messages;
}

export async function startAntigravityTurn(
  session: AntigravityNativeSession,
  turn: RuntimeTurnContext<AntigravityNativeEvent>,
): Promise<RuntimeTurnResult> {
  await assertAntigravityWorkspaceCustomizationsAreIsolated(session.agent.workspace);
  session.toolRuntimeState.runId = turn.runId;
  session.toolRuntimeState.source = turn.source;
  const modelName = turn.modelSelection?.model.modelId ?? session.defaultModelName;
  const thinkingLevel = turn.modelSelection?.thinkingLevel ?? session.defaultThinkingLevel;
  session.tokenModelIdentity = antigravityTokenModelIdentity(modelName);
  const messagesBeforeTurn = [...session.messages];
  const timestamp = Date.now();
  session.messages.push(
    ...turn.startupMessages.map((message, index) => ({
      role: message.role,
      content: message.content,
      timestamp: timestamp + index,
    })),
    {
      role: "user",
      content: turn.rawQuery,
      timestamp: timestamp + turn.startupMessages.length,
    },
  );
  const prompt = formatAntigravityPrompt(turn.startupMessages, turn.prompt);
  const logPath = join(session.managedHome.logDir, `turn-${safePathSegment(turn.runId)}.log`);
  const transcriptCheckpoints = await captureAntigravityTranscriptCheckpoints(
    session.managedHome.homeDir,
    session.sessionId,
  );

  try {
    const run = await runAntigravityProcess({
      executablePath: session.executablePath,
      args: createAntigravityArgs({
        prompt,
        workspace: session.agent.workspace,
        agentName: session.managedHome.agentName,
        logPath,
        permissionMode: session.permissionMode,
        sessionId: session.sessionId,
        modelName,
        thinkingLevel,
      }),
      cwd: session.agent.workspace,
      env: session.env,
      logger: session.logger,
      spawn: session.spawn,
      signal: turn.signal,
      writeNative(event) {
        // Agy can allocate its conversation before later reporting a failed result.
        // Keep the native Session in sync immediately so an in-process retry resumes
        // the conversation even when runAntigravityProcess rejects before returning.
        if (event.kind === "session") session.sessionId = event.sessionId;
        turn.stream.writeNative(event);
      },
      onProcessStarted(process, exitPromise, hasExited) {
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
      fallback: {
        homeDir: session.managedHome.homeDir,
        logPath,
        priorSessionId: session.sessionId,
        transcriptCheckpoints,
      },
    });
    if (run.sessionId !== undefined) session.sessionId = run.sessionId;
    const usage =
      run.usage !== undefined && hasNonZeroUsage(run.usage)
        ? run.usage
        : estimateAntigravityTurnUsage(session, messagesBeforeTurn, prompt, run.outputText);
    session.messages.push(createAssistantMessage(run.outputText, usage, modelName));
    return {
      outputText: run.outputText,
      usage,
      runtimeSessionId: session.sessionId,
    };
  } finally {
    session.toolRuntimeState.runId = undefined;
    session.toolRuntimeState.source = undefined;
  }
}

export function mapAntigravityEvent(
  event: AntigravityNativeEvent,
  context: RuntimeEventMappingContext,
): RuntimeEventMappingResult {
  switch (event.kind) {
    case "message-delta":
      return {
        events: [context.events.messageDelta(event.text)],
        outputDelta: event.text,
      };
    case "thought-delta":
      return { events: [context.events.thoughtDelta(event.text)] };
    case "message-completed":
      return {
        events: [context.events.messageCompleted(event.text)],
        completedText: event.text,
      };
    case "tool-started":
      return {
        events: [
          context.events.toolStarted({
            toolCallId: event.id,
            toolName: event.name,
            inputPreview: event.input,
          }),
        ],
      };
    case "tool-delta":
      return {
        events: [
          context.events.toolDelta({
            toolCallId: event.id,
            toolName: event.name,
            delta: event.delta,
            channel: "message",
          }),
        ],
      };
    case "tool-completed":
      return {
        events: [
          event.failed === true
            ? context.events.toolFailed({
                toolCallId: event.id,
                toolName: event.name,
                message: printableValue(event.output) || "Antigravity tool failed.",
              })
            : context.events.toolCompleted({
                toolCallId: event.id,
                toolName: event.name,
                outputPreview: event.output,
              }),
        ],
      };
    case "progress":
      return { events: [context.events.progress(event.stage, event.data)] };
    case "session":
      return { runtimeSessionId: event.sessionId };
    case "usage":
      return { usage: event.usage };
  }
}

export function createAntigravityArgs(options: {
  readonly prompt: string;
  readonly workspace: string;
  readonly agentName: string;
  readonly logPath: string;
  readonly permissionMode: AntigravityRuntimePermissionMode;
  readonly sessionId?: string | undefined;
  readonly modelName?: string | undefined;
  readonly thinkingLevel?: string | undefined;
}): readonly string[] {
  const sessionArgs =
    options.sessionId === undefined || options.sessionId === ""
      ? []
      : ["--conversation", assertAntigravityConversationId(options.sessionId)];
  return [
    "--output-format",
    "stream-json",
    "--disable-slash-commands",
    "--print-timeout",
    PRINT_TIMEOUT,
    "--add-dir",
    options.workspace,
    "--agent",
    options.agentName,
    "--log-file",
    options.logPath,
    "--mode",
    "accept-edits",
    ...(options.permissionMode === "auto-approve" ? ["--sandbox"] : []),
    ...(options.permissionMode === "full-access" ? ["--dangerously-skip-permissions"] : []),
    ...sessionArgs,
    ...(options.modelName === undefined ? [] : ["--model", options.modelName]),
    ...(options.thinkingLevel === undefined ? [] : ["--effort", options.thinkingLevel]),
    // Keep the value-taking print flag adjacent to its prompt and last. Older
    // agy builds used a parser that could otherwise treat following flags as
    // part of the prompt.
    "-p",
    options.prompt,
  ];
}

export function formatAntigravityPrompt(
  startupMessages: readonly ExpertAgentStartupMessage[],
  prompt: string,
): string {
  if (startupMessages.length === 0) return prompt;
  const framed = startupMessages.flatMap((message, index) => [
    `<<<PRAGMA_STARTUP_MESSAGE index=${index + 1}/${startupMessages.length} role=${message.role} characters=${message.content.length}>>>`,
    message.content,
    `<<<END_PRAGMA_STARTUP_MESSAGE index=${index + 1}/${startupMessages.length}>>>`,
  ]);
  return [
    "The following Pragma startup messages precede the current user request. Preserve their order and treat each framed payload according to its declared role and exact character length.",
    ...framed,
    "<<<PRAGMA_CURRENT_REQUEST>>>",
    prompt,
    "<<<END_PRAGMA_CURRENT_REQUEST>>>",
  ].join("\n");
}

export function cancelAntigravityTurn(session: AntigravityNativeSession): void {
  const process = session.activeProcess;
  const exitPromise = session.activeExitPromise;
  const hasExited = session.activeHasExited;
  if (process === undefined || exitPromise === undefined || hasExited === undefined) return;
  void terminateAntigravityProcess({ process, exitPromise, hasExited, logger: session.logger });
}

export async function closeAntigravitySession(session: AntigravityNativeSession): Promise<void> {
  cancelAntigravityTurn(session);
  await session.activeExitPromise?.catch(() => undefined);
}

export function collectAntigravityUsage(
  session: AntigravityNativeSession,
  _outputText: string,
  currentUsage: AgentMessageUsage | undefined,
): AgentMessageUsage | undefined {
  if (hasNonZeroUsage(currentUsage)) return currentUsage;
  const assistantIndex = session.messages.findLastIndex((message) => message.role === "assistant");
  if (assistantIndex < 0) return undefined;
  const assistant = session.messages[assistantIndex];
  if (assistant?.role !== "assistant") return undefined;
  return createEstimatedAntigravityUsage(
    session,
    JSON.stringify({
      systemPrompt: session.systemPrompt,
      messages: session.messages.slice(0, assistantIndex),
    }),
    JSON.stringify(assistant.content),
  );
}

async function runAntigravityProcess(options: {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly logger: PragmaLogger;
  readonly spawn?: AntigravityRuntimeSpawn | undefined;
  readonly signal: AbortSignal;
  readonly writeNative: (event: AntigravityNativeEvent) => void;
  readonly onProcessStarted: (
    process: ChildProcessWithoutNullStreams,
    exitPromise: Promise<ProcessExit>,
    hasExited: () => boolean,
  ) => void;
  readonly onProcessClosed: (process: ChildProcessWithoutNullStreams) => void;
  readonly fallback: {
    readonly homeDir: string;
    readonly logPath: string;
    readonly priorSessionId: string;
    readonly transcriptCheckpoints: TranscriptCheckpoints;
  };
}): Promise<ProcessRunResult> {
  if (options.signal.aborted) throw createAbortError();
  const child = (options.spawn ?? defaultSpawn)(options.executablePath, options.args, {
    cwd: options.cwd,
    env: options.env,
  });
  let exited = false;
  const exitPromise = new Promise<ProcessExit>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      exited = true;
      resolveExit({ code, signal });
    });
  });
  options.onProcessStarted(child, exitPromise, () => exited);
  child.stdin.end();
  let stderrTail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_LIMIT);
    options.logger.debug("runtime.antigravity_stderr", "Antigravity CLI emitted stderr", {
      characters: chunk.length,
    });
  });

  const state: StreamState = {
    textSnapshots: new Map(),
    thoughtSnapshots: new Map(),
    tools: new Map(),
    compactions: new Map(),
    outputText: "",
    terminalSeen: false,
    plainTextOutput: false,
  };
  const abort = (): void => {
    void terminateAntigravityProcess({
      process: child,
      exitPromise,
      hasExited: () => exited,
      logger: options.logger,
    });
  };
  options.signal.addEventListener("abort", abort, { once: true });

  try {
    let streamError: unknown;
    try {
      await readAgyOutput(
        child.stdout,
        (raw) => {
          for (const event of normalizeAntigravityStreamRecord(raw, state)) {
            options.writeNative(event);
          }
        },
        (text) => {
          state.plainTextOutput = true;
          state.outputText += text;
          options.writeNative({ kind: "message-delta", text });
        },
      );
    } catch (error) {
      streamError = error;
      abort();
    }
    const exit = await exitPromise;
    const logTail = await readTail(options.fallback.logPath, LOG_TAIL_LIMIT);
    if (options.signal.aborted) throw createAbortError();
    if (streamError !== undefined) throw streamError;
    if (state.resultError !== undefined) {
      throw classifyAntigravityError(state.resultError, stderrTail, logTail);
    }
    if (exit.code !== 0) {
      throw classifyAntigravityError(
        `Antigravity CLI exited with code ${exit.code ?? "null"}${
          exit.signal === null ? "" : ` and signal ${exit.signal}`
        }.`,
        stderrTail,
        logTail,
      );
    }
    if (!state.terminalSeen) {
      const degradedError = readDegradedAntigravityError(state.outputText, logTail);
      if (degradedError !== undefined) {
        throw classifyAntigravityError(degradedError, stderrTail, logTail);
      }
    }

    const recoveredSessionId = state.sessionId ?? readAntigravityConversationIdFromLog(logTail);
    let outputText = state.resultText ?? state.outputText;
    if (state.plainTextOutput) outputText = outputText.trimEnd();
    if (!state.terminalSeen) {
      const recovered = await recoverAntigravityOutput({
        homeDir: options.fallback.homeDir,
        sessionId: recoveredSessionId ?? options.fallback.priorSessionId,
        logTail,
        priorSessionId: options.fallback.priorSessionId,
        transcriptCheckpoints: options.fallback.transcriptCheckpoints,
      });
      outputText ||= recovered ?? "";
      options.logger.warn(
        "runtime.antigravity_terminal_result_missing",
        "Antigravity CLI exited without a terminal result event; using degraded recovery",
        { recovered: outputText !== "", sessionIdAvailable: (recoveredSessionId ?? "") !== "" },
      );
    }
    if (outputText === "") {
      throw new AntigravityRuntimeError(
        "Antigravity CLI ended without a terminal result or recoverable assistant output.",
        "ANTIGRAVITY_PROTOCOL_ERROR",
        false,
      );
    }
    if (state.resultText === undefined) {
      options.writeNative({ kind: "message-completed", text: outputText });
    }
    return {
      outputText,
      usage: state.usage,
      sessionId: recoveredSessionId,
    };
  } finally {
    options.signal.removeEventListener("abort", abort);
    options.onProcessClosed(child);
  }
}

function readDegradedAntigravityError(outputText: string, logTail: string): string | undefined {
  if (/^\s*Error:\s*timed out waiting for (?:the )?response\b/im.test(outputText)) {
    return "Antigravity CLI timed out waiting for the agent response.";
  }
  if (/Print mode:\s*timed out after \d+ polls/i.test(logTail)) {
    return "Antigravity CLI print timeout elapsed before the agent produced a result.";
  }
  let providerError: string | undefined;
  for (const match of logTail.matchAll(/agent executor error:\s*(.+)$/gim)) {
    if (match[1]?.trim() !== "") providerError = match[1]?.trim();
  }
  return providerError;
}

export function normalizeAntigravityStreamRecord(
  input: unknown,
  state: StreamState = createStreamState(),
): readonly AntigravityNativeEvent[] {
  const raw = AgyStreamRecordSchema.parse(input) as Record<string, unknown>;
  const type = readString(raw["event"] ?? raw["type"])?.toLowerCase() ?? "unknown";
  if (type === "init") return normalizeInit(raw, state);
  if (type === "step_update") return normalizeStepUpdate(raw, state);
  if (type === "result") return normalizeResult(raw, state);
  if (type === "error") {
    const payload = readRecord(raw["error"]) ?? raw;
    const message = readErrorMessage(payload) ?? "Antigravity CLI emitted an error event.";
    state.resultError = message;
    return [{ kind: "progress", stage: "antigravity.error", data: sanitizeProgressData(raw) }];
  }
  return [
    {
      kind: "progress",
      stage: `antigravity.${safeStage(String(type))}`,
      data: sanitizeProgressData(raw),
    },
  ];
}

function normalizeInit(
  raw: Record<string, unknown>,
  state: StreamState,
): readonly AntigravityNativeEvent[] {
  const payload = readRecord(raw["init"]) ?? raw;
  const sessionId = readSessionId(payload) ?? readSessionId(raw);
  if (sessionId !== undefined) state.sessionId = sessionId;
  return [
    ...(sessionId === undefined ? [] : ([{ kind: "session", sessionId }] as const)),
    {
      kind: "progress",
      stage: "antigravity.initialized",
      data: sanitizeProgressData({
        model: payload["model"] ?? payload["model_name"],
        tools: payload["tools"],
        mcpServers: payload["mcp_servers"] ?? payload["mcpServers"],
      }),
    },
  ];
}

function normalizeStepUpdate(
  raw: Record<string, unknown>,
  state: StreamState,
): readonly AntigravityNativeEvent[] {
  const step =
    readRecord(raw["step_update"]) ?? readRecord(raw["step"]) ?? readRecord(raw["update"]) ?? raw;
  const sessionId = readSessionId(raw) ?? readSessionId(step);
  const index =
    readString(step["step_id"] ?? step["stepId"] ?? step["id"]) ??
    String(readNumber(step["step_index"] ?? step["stepIndex"] ?? raw["step_index"]) ?? "unknown");
  const stepType =
    readString(step["step_type"] ?? step["stepType"] ?? step["type_name"] ?? step["typeName"]) ??
    "unknown";
  const key = `${index}:${stepType}`;
  const status = readString(step["status"] ?? step["state"])?.toLowerCase();
  const events: AntigravityNativeEvent[] = [];
  if (sessionId !== undefined && sessionId !== state.sessionId) {
    state.sessionId = sessionId;
    events.push({ kind: "session", sessionId });
  }

  events.push(...normalizeCompaction(raw, step, key, status, state));
  const toolInfo =
    readRecord(step["tool_info"]) ?? readRecord(step["toolInfo"]) ?? readRecord(raw["tool_info"]);
  if (toolInfo !== undefined) {
    events.push(...normalizeToolStep(step, toolInfo, key, status, state));
  }
  const subagentInfo =
    readRecord(step["subagent_info"]) ??
    readRecord(step["subagentInfo"]) ??
    readRecord(raw["subagent_info"]);
  if (subagentInfo !== undefined) {
    events.push({
      kind: "progress",
      stage: "antigravity.subagent",
      data: sanitizeProgressData(subagentInfo),
    });
  }

  const isThoughtStep = /(?:reason|thought|analysis)/i.test(stepType);
  const isAssistantResponseStep =
    /(?:planner_response|model.?response|assistant|final.?response|answer|notify_user|finish)/i.test(
      stepType,
    );
  const textDelta = readText(step["text_delta"] ?? step["textDelta"]);
  if (textDelta !== undefined) {
    if (isThoughtStep) {
      events.push({ kind: "thought-delta", text: textDelta });
    } else if (isAssistantResponseStep) {
      state.outputText += textDelta;
      events.push({ kind: "message-delta", text: textDelta });
    } else {
      events.push({
        kind: "progress",
        stage: `antigravity.step.${safeStage(stepType)}`,
        data: sanitizeProgressData({ index, status, stepType, textDelta }),
      });
    }
  }

  const thought =
    textDelta === undefined
      ? readText(
          step["raw_thought"] ??
            step["rawThought"] ??
            step["thought"] ??
            step["reasoning"] ??
            (isThoughtStep ? (step["content"] ?? step["text"]) : undefined),
        )
      : undefined;
  if (thought !== undefined) {
    const delta = snapshotDelta(state.thoughtSnapshots, key, thought);
    if (delta !== "") events.push({ kind: "thought-delta", text: delta });
  }

  const text =
    textDelta === undefined && isAssistantResponseStep
      ? readText(
          step["content"] ??
            step["text"] ??
            step["response"] ??
            step["planner_response"] ??
            step["plannerResponse"] ??
            step["output"],
        )
      : undefined;
  if (text !== undefined) {
    const delta = snapshotDelta(state.textSnapshots, key, text);
    if (delta !== "") {
      state.outputText += delta;
      events.push({ kind: "message-delta", text: delta });
    }
  }
  if (events.length === 0) {
    events.push({
      kind: "progress",
      stage: `antigravity.step.${safeStage(stepType)}`,
      data: sanitizeProgressData({ index, status, stepType }),
    });
  }
  return events;
}

function normalizeResult(
  raw: Record<string, unknown>,
  state: StreamState,
): readonly AntigravityNativeEvent[] {
  state.terminalSeen = true;
  const payload = readRecord(raw["result"]) ?? raw;
  const sessionId = readSessionId(payload) ?? readSessionId(raw);
  if (sessionId !== undefined) state.sessionId = sessionId;
  const usage = readAntigravityUsage(payload) ?? readAntigravityUsage(raw);
  if (usage !== undefined) state.usage = usage;
  const failed =
    payload["is_error"] === true ||
    payload["success"] === false ||
    /^(?:error|failed|cancelled|canceled)$/i.test(
      readString(payload["status"] ?? payload["subtype"]) ?? "",
    );
  const error = failed
    ? (readErrorMessage(payload) ?? "Antigravity CLI returned a failed result.")
    : undefined;
  if (error !== undefined) state.resultError = error;
  const text = readText(
    payload === raw
      ? (raw["result"] ?? raw["output"] ?? raw["response"] ?? raw["text"] ?? raw["content"])
      : (payload["response"] ??
          payload["output"] ??
          payload["text"] ??
          payload["content"] ??
          payload["result"]),
  );
  if (text !== undefined) state.resultText = text;
  return [
    ...(sessionId === undefined ? [] : ([{ kind: "session", sessionId }] as const)),
    ...(usage === undefined ? [] : ([{ kind: "usage", usage }] as const)),
    ...(text === undefined || failed ? [] : ([{ kind: "message-completed", text }] as const)),
  ];
}

function normalizeToolStep(
  step: Record<string, unknown>,
  toolInfo: Record<string, unknown>,
  key: string,
  status: string | undefined,
  state: StreamState,
): readonly AntigravityNativeEvent[] {
  const name =
    readString(
      toolInfo["name"] ??
        toolInfo["tool_name"] ??
        toolInfo["toolName"] ??
        step["tool_name"] ??
        step["toolName"],
    ) ?? "antigravity_tool";
  const id =
    readString(
      toolInfo["id"] ??
        toolInfo["tool_call_id"] ??
        toolInfo["toolCallId"] ??
        step["step_id"] ??
        step["id"],
    ) ?? `agy-tool:${key}`;
  const input =
    toolInfo["parameters"] ?? toolInfo["params"] ?? toolInfo["arguments"] ?? toolInfo["input"];
  const output = toolInfo["output"] ?? toolInfo["result"] ?? toolInfo["error"] ?? step["output"];
  const sanitizedInput = sanitizeProgressData(input);
  const sanitizedOutput = sanitizeProgressData(output);
  const outputText = printableValue(sanitizedOutput);
  let snapshot = state.tools.get(id);
  const events: AntigravityNativeEvent[] = [];
  if (snapshot === undefined) {
    snapshot = { name, outputText: "", completed: false };
    state.tools.set(id, snapshot);
    events.push({ kind: "tool-started", id, name, input: sanitizedInput });
  }
  const delta = removeSnapshotPrefix(outputText, snapshot.outputText);
  if (delta !== "") {
    snapshot.outputText = outputText;
    events.push({ kind: "tool-delta", id, name: snapshot.name, delta });
  }
  if (isTerminalStatus(status) && !snapshot.completed) {
    snapshot.completed = true;
    events.push({
      kind: "tool-completed",
      id,
      name: snapshot.name,
      output: sanitizedOutput,
      failed: isFailureStatus(status) || toolInfo["is_error"] === true,
    });
  }
  return events;
}

function normalizeCompaction(
  raw: Record<string, unknown>,
  step: Record<string, unknown>,
  key: string,
  status: string | undefined,
  state: StreamState,
): readonly AntigravityNativeEvent[] {
  const info =
    readRecord(step["compaction_info"]) ??
    readRecord(step["compactionInfo"]) ??
    readRecord(raw["compaction_info"]) ??
    readRecord(raw["compactionInfo"]);
  if (info === undefined) return [];
  const operationId =
    readString(info["operation_id"] ?? info["operationId"] ?? info["id"]) ??
    `agy-compaction:${key}`;
  const compactionStatus =
    readString(info["status"] ?? info["state"])?.toLowerCase() ?? status ?? "completed";
  const previous = state.compactions.get(operationId);
  const failed = isFailureStatus(compactionStatus);
  const errorMessage = failed
    ? readText(sanitizeProgressData(info["error"] ?? info["message"] ?? step["error"]))
    : undefined;
  const data = {
    operationId,
    trigger: normalizeCompactionTrigger(readString(info["trigger"])),
    runtimeId: "antigravity-local",
    ...(errorMessage === undefined ? {} : { errorMessage }),
    info: sanitizeProgressData(info),
  };
  if (isTerminalStatus(compactionStatus)) {
    const terminalState = failed ? "failed" : "completed";
    if (previous === "completed" || previous === "failed") return [];
    state.compactions.set(operationId, terminalState);
    return [
      ...(previous === undefined
        ? [
            {
              kind: "progress" as const,
              stage: RUNTIME_CONTEXT_COMPACTION_STAGES.started,
              data,
            },
          ]
        : []),
      {
        kind: "progress" as const,
        stage: failed
          ? RUNTIME_CONTEXT_COMPACTION_STAGES.failed
          : RUNTIME_CONTEXT_COMPACTION_STAGES.completed,
        data,
      },
    ];
  }
  if (previous === undefined) {
    state.compactions.set(operationId, "started");
    return [
      {
        kind: "progress",
        stage: RUNTIME_CONTEXT_COMPACTION_STAGES.started,
        data,
      },
    ];
  }
  return [];
}

function readAntigravityUsage(record: Record<string, unknown>): AgentMessageUsage | undefined {
  const usage =
    readRecord(record["usage"]) ??
    readRecord(record["token_usage"]) ??
    readRecord(record["tokenUsage"]) ??
    readRecord(record["cost_summary"]);
  if (usage === undefined) return undefined;
  const input = readFirstTokenCount(usage, [
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
    "promptTokens",
  ]);
  const directOutput = readFirstTokenCount(usage, [
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens",
  ]);
  const thinkingOutput = readFirstTokenCount(usage, [
    "thinking_output_tokens",
    "thinkingOutputTokens",
  ]);
  const responseOutput = readFirstTokenCount(usage, [
    "response_output_tokens",
    "responseOutputTokens",
  ]);
  const separateThinking = readFirstTokenCount(usage, [
    "thinking_tokens",
    "thinkingTokens",
    "reasoning_tokens",
    "reasoningTokens",
  ]);
  const cacheRead = readFirstTokenCount(usage, ["cache_read_tokens", "cacheReadTokens"]);
  const cacheWrite = readFirstTokenCount(usage, ["cache_write_tokens", "cacheWriteTokens"]);
  const total = readFirstTokenCount(usage, ["total_tokens", "totalTokens"]);
  if (
    input === undefined &&
    directOutput === undefined &&
    thinkingOutput === undefined &&
    responseOutput === undefined &&
    separateThinking === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined;
  }
  const inputTokens = normalizeTokenCount(input);
  const outputTokens =
    normalizeTokenCount(
      directOutput ?? normalizeTokenCount(thinkingOutput) + normalizeTokenCount(responseOutput),
    ) + normalizeTokenCount(separateThinking);
  const cacheReadTokens = normalizeTokenCount(cacheRead);
  const cacheWriteTokens = normalizeTokenCount(cacheWrite);
  const totalTokens = normalizeTokenCount(total);
  const inputTokensIncludeCacheRead =
    cacheReadTokens > 0 &&
    totalTokens > 0 &&
    totalTokens === inputTokens + outputTokens + cacheWriteTokens;
  return createUsageFromTokenCounts({
    measurement: "reported",
    inputTokens,
    inputTokensIncludeCacheRead,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  });
}

function estimateAntigravityTurnUsage(
  session: AntigravityNativeSession,
  messagesBeforeTurn: readonly AgentMessage[],
  prompt: string,
  outputText: string,
): AgentMessageUsage {
  return createEstimatedAntigravityUsage(
    session,
    JSON.stringify({
      systemPrompt: session.systemPrompt,
      messages: messagesBeforeTurn,
      prompt,
    }),
    outputText,
  );
}

function createEstimatedAntigravityUsage(
  session: AntigravityNativeSession,
  inputText: string,
  outputText: string,
): AgentMessageUsage {
  return createUsageFromTokenCounts({
    measurement: "estimated",
    inputTokens: session.tokenCounter.countText(inputText, session.tokenModelIdentity).tokens,
    inputTokensIncludeCacheRead: false,
    outputTokens: session.tokenCounter.countText(outputText, session.tokenModelIdentity).tokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
}

function createAssistantMessage(
  text: string,
  usage: AgentMessageUsage,
  modelName: string | undefined,
): AgentAssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "antigravity-cli",
    provider: "antigravity",
    model: modelName ?? "antigravity",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function antigravityTokenModelIdentity(modelId: string | undefined): RuntimeTokenModelIdentity {
  return {
    runtimeKind: "antigravity",
    providerCatalogId: "antigravity",
    providerId: "antigravity",
    api: "antigravity-cli",
    ...(modelId === undefined ? {} : { modelId }),
  };
}

async function readAgyOutput(
  stdout: NodeJS.ReadableStream,
  onRecord: (record: Record<string, unknown>) => void,
  onText: (text: string) => void,
): Promise<void> {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let mode: "unknown" | "stream-json" | "text" = "unknown";
  let pendingLeadingWhitespace = "";
  for await (const chunk of stdout) {
    buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    if (Buffer.byteLength(buffer) > MAX_NDJSON_LINE_BYTES && !buffer.includes("\n")) {
      throw new AntigravityRuntimeError(
        `Antigravity CLI emitted an NDJSON line larger than ${MAX_NDJSON_LINE_BYTES} bytes.`,
        "ANTIGRAVITY_PROTOCOL_ERROR",
        false,
      );
    }
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      ({ mode, pendingLeadingWhitespace } = parseAgyOutputLine({
        line: buffer.slice(0, newline),
        terminated: true,
        mode,
        pendingLeadingWhitespace,
        onRecord,
        onText,
      }));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.end();
  ({ mode, pendingLeadingWhitespace } = parseAgyOutputLine({
    line: buffer,
    terminated: false,
    mode,
    pendingLeadingWhitespace,
    onRecord,
    onText,
  }));
  if (mode === "unknown" && pendingLeadingWhitespace !== "") onText(pendingLeadingWhitespace);
}

function parseAgyOutputLine(options: {
  readonly line: string;
  readonly terminated: boolean;
  readonly mode: "unknown" | "stream-json" | "text";
  readonly pendingLeadingWhitespace: string;
  readonly onRecord: (record: Record<string, unknown>) => void;
  readonly onText: (text: string) => void;
}): {
  readonly mode: "unknown" | "stream-json" | "text";
  readonly pendingLeadingWhitespace: string;
} {
  const { line, terminated, onRecord, onText } = options;
  const trimmed = line.trim();
  const lineWithTerminator = `${line}${terminated ? "\n" : ""}`;
  if (options.mode === "text") {
    onText(lineWithTerminator);
    return { mode: "text", pendingLeadingWhitespace: "" };
  }
  if (trimmed === "") {
    return options.mode === "stream-json"
      ? { mode: "stream-json", pendingLeadingWhitespace: "" }
      : {
          mode: "unknown",
          pendingLeadingWhitespace: options.pendingLeadingWhitespace + lineWithTerminator,
        };
  }
  if (Buffer.byteLength(trimmed) > MAX_NDJSON_LINE_BYTES) {
    throw new AntigravityRuntimeError(
      `Antigravity CLI emitted an NDJSON line larger than ${MAX_NDJSON_LINE_BYTES} bytes.`,
      "ANTIGRAVITY_PROTOCOL_ERROR",
      false,
    );
  }
  if (options.mode === "stream-json") {
    onRecord(parseStructuredAgyLine(trimmed));
    return { mode: "stream-json", pendingLeadingWhitespace: "" };
  }

  try {
    const value = JSON.parse(trimmed) as unknown;
    const parsed = AgyStreamRecordSchema.safeParse(value);
    if (parsed.success) {
      onRecord(parsed.data as Record<string, unknown>);
      return { mode: "stream-json", pendingLeadingWhitespace: "" };
    }
    onText(options.pendingLeadingWhitespace + lineWithTerminator);
    return { mode: "text", pendingLeadingWhitespace: "" };
  } catch (error) {
    if (!/^(?:\{|\[)/.test(trimmed)) {
      onText(options.pendingLeadingWhitespace + lineWithTerminator);
      return { mode: "text", pendingLeadingWhitespace: "" };
    }
    throw new AntigravityRuntimeError(
      `Antigravity CLI emitted malformed stream-json output: ${errorMessage(error)}`,
      "ANTIGRAVITY_PROTOCOL_ERROR",
      false,
    );
  }
}

function parseStructuredAgyLine(line: string): Record<string, unknown> {
  try {
    return AgyStreamRecordSchema.parse(JSON.parse(line) as unknown) as Record<string, unknown>;
  } catch (error) {
    throw new AntigravityRuntimeError(
      `Antigravity CLI emitted malformed stream-json output: ${errorMessage(error)}`,
      "ANTIGRAVITY_PROTOCOL_ERROR",
      false,
    );
  }
}

async function recoverAntigravityOutput(options: {
  readonly homeDir: string;
  readonly sessionId: string;
  readonly logTail: string;
  readonly priorSessionId: string;
  readonly transcriptCheckpoints: TranscriptCheckpoints;
}): Promise<string | undefined> {
  if (options.sessionId !== "" && isAntigravityConversationId(options.sessionId)) {
    for (const root of ANTIGRAVITY_TRANSCRIPT_ROOTS) {
      const transcript = resolveAntigravityTranscriptPath(options.homeDir, root, options.sessionId);
      if (transcript === undefined) continue;
      const checkpoint =
        options.sessionId === options.priorSessionId
          ? options.transcriptCheckpoints.get(root)
          : undefined;
      if (checkpoint?.kind === "unavailable") continue;
      const recovered = await readAntigravityTranscriptAssistantText(transcript, {
        // A fallback must prove that it saw the current turn's input. This is
        // necessary for both fresh conversations and resumed transcripts.
        requireUserBoundary: true,
        ...(checkpoint === undefined ? {} : { checkpoint }),
      });
      if (recovered !== undefined) return recovered;
    }
  }
  const logMatch = options.logTail.match(/(?:final result|assistant response)[:=]\s*(.+)$/im);
  return logMatch?.[1]?.trim() || undefined;
}

async function captureAntigravityTranscriptCheckpoints(
  homeDir: string,
  sessionId: string,
): Promise<TranscriptCheckpoints> {
  const checkpoints = new Map<AntigravityTranscriptRoot, TranscriptCheckpoint>();
  if (!isAntigravityConversationId(sessionId)) return checkpoints;
  await Promise.all(
    ANTIGRAVITY_TRANSCRIPT_ROOTS.map(async (root) => {
      const transcript = resolveAntigravityTranscriptPath(homeDir, root, sessionId);
      if (transcript === undefined) {
        checkpoints.set(root, { kind: "unavailable" });
        return;
      }
      try {
        const metadata = await stat(transcript);
        checkpoints.set(
          root,
          metadata.isFile()
            ? { kind: "tracked", size: metadata.size, dev: metadata.dev, ino: metadata.ino }
            : { kind: "unavailable" },
        );
      } catch (error) {
        checkpoints.set(
          root,
          isMissingPathError(error) ? { kind: "missing" } : { kind: "unavailable" },
        );
      }
    }),
  );
  return checkpoints;
}

export async function readAntigravityTranscriptAssistantText(
  path: string,
  options: {
    readonly requireUserBoundary?: boolean | undefined;
    readonly checkpoint?: TranscriptCheckpoint | undefined;
  } = {},
): Promise<string | undefined> {
  const tail = await readFileTailWithMetadata(
    path,
    TRANSCRIPT_TAIL_LIMIT,
    options.checkpoint,
  ).catch(() => undefined);
  if (tail === undefined) return undefined;
  const settledResponses: string[] = [];
  let nestedFallback: string | undefined;
  let observedUserBoundary = false;
  for (const line of tail.content.split(/\r?\n/)) {
    try {
      const record = readRecord(JSON.parse(line) as unknown);
      if (record === undefined) continue;
      if (isTranscriptUserInput(record)) {
        // A resumed transcript accumulates every turn. Only responses after
        // the last user boundary belong to the process we are recovering.
        settledResponses.length = 0;
        nestedFallback = undefined;
        observedUserBoundary = true;
        continue;
      }
      const settled = readSettledTranscriptResponse(record);
      if (settled !== undefined) {
        settledResponses.push(settled);
        continue;
      }
      const candidate = findAssistantText(record, 0);
      if (candidate !== undefined) nestedFallback = candidate;
    } catch {
      // Ignore incomplete transcript lines during degraded recovery.
    }
  }
  if ((options.requireUserBoundary === true || tail.truncated) && !observedUserBoundary) {
    return undefined;
  }
  return settledResponses.length === 0 ? nestedFallback : settledResponses.join("\n\n");
}

function resolveAntigravityTranscriptPath(
  homeDir: string,
  root: "antigravity" | "antigravity-cli",
  sessionId: string,
): string | undefined {
  const brainRoot = resolve(homeDir, ".gemini", root, "brain");
  const transcript = resolve(brainRoot, sessionId, ".system_generated", "logs", "transcript.jsonl");
  const difference = relative(brainRoot, transcript);
  if (difference === ".." || difference.startsWith("..") || isAbsolute(difference)) {
    return undefined;
  }
  return transcript;
}

function isTranscriptUserInput(record: Record<string, unknown>): boolean {
  return /^(?:user|user_input)$/i.test(
    readString(record["type"] ?? record["role"] ?? record["step_type"] ?? record["stepType"]) ?? "",
  );
}

function readSettledTranscriptResponse(record: Record<string, unknown>): string | undefined {
  const type =
    readString(record["type"] ?? record["role"] ?? record["step_type"] ?? record["stepType"]) ?? "";
  if (!/(?:assistant|planner_response|model_response|final_response)/i.test(type)) {
    return undefined;
  }
  const source = readString(record["source"]);
  if (source !== undefined && !/^(?:assistant|model)$/i.test(source)) return undefined;
  const status = readString(record["status"] ?? record["state"]);
  if (status !== undefined && !isSuccessfulTerminalStatus(status)) return undefined;
  return readText(
    record["content"] ??
      record["text"] ??
      record["response"] ??
      record["output"] ??
      record["planner_response"] ??
      record["plannerResponse"],
  );
}

function findAssistantText(value: unknown, depth: number): string | undefined {
  if (depth > 6) return undefined;
  if (Array.isArray(value)) {
    let result: string | undefined;
    for (const entry of value) {
      const candidate = findAssistantText(entry, depth + 1);
      if (candidate !== undefined) result = candidate;
    }
    return result;
  }
  const record = readRecord(value);
  if (record === undefined) return undefined;
  const role = readString(
    record["role"] ?? record["type"] ?? record["step_type"] ?? record["stepType"],
  );
  if (
    role !== undefined &&
    /(?:assistant|planner_response|model_response|final_response)/i.test(role)
  ) {
    const source = readString(record["source"]);
    const status = readString(record["status"] ?? record["state"]);
    if (
      (source === undefined || /^(?:assistant|model)$/i.test(source)) &&
      (status === undefined || isSuccessfulTerminalStatus(status))
    ) {
      const direct = readText(
        record["text"] ??
          record["content"] ??
          record["response"] ??
          record["output"] ??
          record["planner_response"] ??
          record["plannerResponse"],
      );
      if (direct !== undefined) return direct;
    }
  }
  let result: string | undefined;
  for (const nested of Object.values(record)) {
    const candidate = findAssistantText(nested, depth + 1);
    if (candidate !== undefined) result = candidate;
  }
  return result;
}

export function readAntigravityConversationIdFromLog(log: string): string | undefined {
  let result: string | undefined;
  const pattern =
    /\bconversation(?:[_ ]?id)?\b\s*(?:=|:)\s*["']?([a-zA-Z0-9][a-zA-Z0-9._-]{0,255})/gi;
  for (const match of log.matchAll(pattern)) {
    const candidate = match[1];
    if (candidate !== undefined && isAntigravityConversationId(candidate)) result = candidate;
  }
  return result;
}

export function isAntigravityConversationId(value: string): boolean {
  return ANTIGRAVITY_CONVERSATION_ID.test(value);
}

export function assertAntigravityConversationId(value: string): string {
  if (!isAntigravityConversationId(value)) {
    throw new AntigravityRuntimeError(
      "Antigravity CLI returned an invalid conversation identifier.",
      "ANTIGRAVITY_PROTOCOL_ERROR",
      false,
    );
  }
  return value;
}

function classifyAntigravityError(
  primary: string,
  stderrTail: string,
  logTail: string,
): AntigravityRuntimeError {
  const combined = [primary, stderrTail, logTail].filter(Boolean).join("\n");
  if (
    /sign in|not logged|authentication (?:required|failed|timed out)|oauth|credentials/i.test(
      combined,
    )
  ) {
    return new AntigravityRuntimeError(
      "Antigravity CLI is not signed in. Run agy interactively once, or configure an explicit supported authentication environment.",
      "ANTIGRAVITY_AUTH_REQUIRED",
      false,
    );
  }
  if (/rate limit|resource exhausted|quota|out of credits|429/i.test(combined)) {
    return new AntigravityRuntimeError(
      "Antigravity CLI is rate limited or out of quota.",
      "ANTIGRAVITY_RATE_LIMITED",
      true,
    );
  }
  if (
    /model .*not found|no models available|model-loading|missing license|missing iam/i.test(
      combined,
    )
  ) {
    return new AntigravityRuntimeError(
      "The selected Antigravity model is unavailable for this account.",
      "ANTIGRAVITY_MODEL_UNAVAILABLE",
      false,
    );
  }
  if (/timed? out|deadline exceeded|print timeout/i.test(combined)) {
    return new AntigravityRuntimeError(
      "Antigravity CLI timed out before producing a result.",
      "ANTIGRAVITY_TIMEOUT",
      true,
    );
  }
  return new AntigravityRuntimeError(
    redactSensitiveText(primary),
    "ANTIGRAVITY_PROCESS_FAILED",
    false,
  );
}

class AntigravityRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AntigravityRuntimeError";
  }
}

async function terminateAntigravityProcess(options: {
  readonly process: ChildProcessWithoutNullStreams;
  readonly exitPromise: Promise<ProcessExit>;
  readonly hasExited: () => boolean;
  readonly logger: PragmaLogger;
}): Promise<void> {
  if (options.hasExited()) return;
  options.process.stdin.end();
  options.process.kill("SIGTERM");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    options.exitPromise.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(false), PROCESS_TERMINATION_GRACE_MS);
    }),
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
  if (!exited && !options.hasExited()) {
    options.logger.warn(
      "runtime.antigravity_force_kill",
      "Antigravity CLI did not stop after SIGTERM; sending SIGKILL",
    );
    options.process.kill("SIGKILL");
    await options.exitPromise.catch(() => undefined);
  }
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

function createAbortError(): Error {
  const error = new Error("Antigravity CLI turn was cancelled.");
  error.name = "AbortError";
  return error;
}

function createStreamState(): StreamState {
  return {
    textSnapshots: new Map(),
    thoughtSnapshots: new Map(),
    tools: new Map(),
    compactions: new Map(),
    outputText: "",
    terminalSeen: false,
    plainTextOutput: false,
  };
}

function readSessionId(record: Record<string, unknown>): string | undefined {
  const candidate = readString(
    record["conversation_id"] ??
      record["conversationId"] ??
      record["session_id"] ??
      record["sessionId"],
  );
  return candidate !== undefined && isAntigravityConversationId(candidate) ? candidate : undefined;
}

function readErrorMessage(record: Record<string, unknown>): string | undefined {
  return readText(
    record["error"] ??
      record["message"] ??
      record["errors"] ??
      readRecord(record["result"])?.["error"],
  );
}

function readText(value: unknown): string | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (Array.isArray(value)) {
    const text = value
      .map(readText)
      .filter((entry): entry is string => entry !== undefined)
      .join("");
    return text === "" ? undefined : text;
  }
  const record = readRecord(value);
  if (record === undefined) return undefined;
  for (const key of ["text", "content", "value", "message", "response", "result", "output"]) {
    const text = readText(record[key]);
    if (text !== undefined) return text;
  }
  return undefined;
}

function snapshotDelta(store: Map<string, string>, key: string, text: string): string {
  const previous = store.get(key) ?? "";
  store.set(key, text);
  return removeSnapshotPrefix(text, previous);
}

function removeSnapshotPrefix(current: string, previous: string): string {
  if (previous === "") return current;
  if (current.startsWith(previous)) return current.slice(previous.length);
  if (previous.startsWith(current)) return "";
  return current;
}

function printableValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return redactSensitiveText(value);
  try {
    return redactSensitiveText(JSON.stringify(value) ?? String(value));
  } catch {
    return redactSensitiveText(String(value));
  }
}

function sanitizeProgressData(value: unknown, depth = 0): unknown {
  if (value === undefined) return undefined;
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeProgressData(entry, depth + 1));
  }
  const record = readRecord(value);
  if (record === undefined) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (
      /(?:authorization|token|secret|credential|cookie|password|api[_-]?key|access[_-]?key|private[_-]?key)/i.test(
        key,
      )
    ) {
      continue;
    }
    result[key] = sanitizeProgressData(entry, depth + 1);
  }
  return result;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;"'}\]]+/gi, "$1: [redacted]")
    .replace(
      /\b(token|secret|credential|cookie|password|api[_-]?key|access[_-]?key|private[_-]?key)\s*[:=]\s*(?:["'])?[^\s,;"'}\]]+/gi,
      "$1: [redacted]",
    )
    .replace(
      /(["'](?:authorization|token|secret|credential|cookie|password|api[_-]?key|access[_-]?key|private[_-]?key)["']\s*:\s*["'])[^"']*/gi,
      "$1[redacted]",
    );
}

function isTerminalStatus(status: string | undefined): boolean {
  return /^(?:complete|completed|success|succeeded|done|failed|error|cancelled|canceled)$/i.test(
    status ?? "",
  );
}

function isSuccessfulTerminalStatus(status: string): boolean {
  return /^(?:complete|completed|success|succeeded|done)$/i.test(status);
}

function isFailureStatus(status: string | undefined): boolean {
  return /^(?:failed|error|cancelled|canceled)$/i.test(status ?? "");
}

function normalizeCompactionTrigger(
  trigger: string | undefined,
): "auto" | "manual" | "overflow" | "unknown" {
  if (trigger === "manual") return "manual";
  if (trigger === "overflow") return "overflow";
  if (trigger === "auto" || trigger === "automatic" || trigger === "threshold") return "auto";
  return "unknown";
}

function normalizeTokenCount(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? 0 : Math.trunc(value);
}

async function readTail(path: string, limit: number): Promise<string> {
  return await readFileTail(path, limit).catch(() => "");
}

async function readFileTail(path: string, limit: number): Promise<string> {
  return (await readFileTailWithMetadata(path, limit)).content;
}

interface FileTail {
  readonly content: string;
  readonly truncated: boolean;
}

async function readFileTailWithMetadata(
  path: string,
  limit: number,
  checkpoint?: TranscriptCheckpoint | undefined,
): Promise<FileTail> {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (checkpoint?.kind === "unavailable") {
      throw new Error("Antigravity transcript checkpoint is unavailable.");
    }
    if (
      checkpoint?.kind === "tracked" &&
      (metadata.dev !== checkpoint.dev ||
        metadata.ino !== checkpoint.ino ||
        metadata.size < checkpoint.size)
    ) {
      throw new Error("Antigravity transcript changed before degraded recovery.");
    }
    const startOffset = checkpoint?.kind === "tracked" ? checkpoint.size : 0;
    const available = metadata.size - startOffset;
    const length = Math.min(available, limit);
    if (length === 0) return { content: "", truncated: false };
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        length - offset,
        metadata.size - length + offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return {
      content: buffer.subarray(0, offset).toString("utf8"),
      truncated: available > limit,
    };
  } finally {
    await handle.close();
  }
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || randomUUID();
}

function safeStage(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "_")
      .slice(0, 80) || "unknown"
  );
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
