import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { AgentAssistantMessage, AgentMessage, AgentMessageUsage } from "@pragma/shared";
import {
  BoundedRuntimeOutputBuffer,
  createUsageFromTokenCounts,
  defaultRuntimeTokenCounter,
  hasNonZeroUsage,
  readFirstTokenCount,
  RUNTIME_CONTEXT_COMPACTION_STAGES,
  RuntimeProcessSupervisor,
  RuntimeTurnNotDispatchedError,
  waitForRuntimeProcessExit,
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
const ANTIGRAVITY_CONVERSATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANTIGRAVITY_TRANSCRIPT_ROOTS = ["antigravity", "antigravity-cli"] as const;

type AntigravityTranscriptRoot = (typeof ANTIGRAVITY_TRANSCRIPT_ROOTS)[number];

const AgyStreamRecordSchema = z.object({ event: z.string().min(1) }).passthrough();

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
  connection?: AntigravityConnection | undefined;
}

interface AntigravityConnection {
  readonly process: ChildProcessWithoutNullStreams;
  readonly supervisor: RuntimeProcessSupervisor;
  readonly selection: string;
  readonly logPath: string;
  stderr: BoundedRuntimeOutputBuffer;
  closing: boolean;
  readonly compactions: StreamState["compactions"];
  cumulativeUsage?: AgentMessageUsage | undefined;
  baselineKnown: boolean;
  pending?:
    | {
        readonly state: StreamState;
        readonly writeNative: (event: AntigravityNativeEvent) => void;
        readonly resolve: (result: ProcessRunResult) => void;
        readonly reject: (error: unknown) => void;
        readonly logCheckpoint: TranscriptCheckpoint;
        readonly priorSessionId: string;
        readonly transcriptCheckpoints: TranscriptCheckpoints;
      }
    | undefined;
}

type ProcessRunResult =
  | {
      readonly kind: "success";
      readonly outputText: string;
      readonly usage?: AgentMessageUsage | undefined;
      readonly sessionId: string;
    }
  | { readonly kind: "failure"; readonly error: AntigravityRuntimeError };

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
  readonly stepUsage: Map<string, AgentMessageUsage>;
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
  latestAssistantResponseKey?: string | undefined;
  assistantResponseCompleted: boolean;
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
  try {
    await assertAntigravityWorkspaceCustomizationsAreIsolated(session.agent.workspace);
    if (turn.signal.aborted) throw createAbortError();
  } catch (error) {
    throw new RuntimeTurnNotDispatchedError(error);
  }
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
  const input = createAntigravityUserMessage(
    turn.startupMessages,
    expandAntigravitySkillInvocation(session, turn.rawQuery, turn.prompt),
  );
  const serializedInput = JSON.stringify(input);

  try {
    const run = await runAntigravityProcess(session, turn, input, modelName, thinkingLevel);
    if (run.kind === "failure") {
      // Without an owned ID, a failed native turn cannot safely reuse its process.
      if (session.sessionId === "") await closeAntigravitySession(session);
      throw run.error;
    }
    session.sessionId = run.sessionId;
    const reportedUsage = run.usage !== undefined && hasNonZeroUsage(run.usage);
    const usage = reportedUsage
      ? run.usage
      : estimateAntigravityTurnUsage(session, messagesBeforeTurn, serializedInput, run.outputText);
    session.messages.push(createAssistantMessage(run.outputText, usage, modelName));
    return {
      outputText: run.outputText,
      // Reported usage has already been emitted as a native usage event. Returning
      // it again makes Core merge and double-count the same observation.
      ...(reportedUsage ? {} : { usage }),
      runtimeSessionId: session.sessionId,
    };
  } catch (error) {
    if (error instanceof RuntimeTurnNotDispatchedError) {
      session.messages.splice(0, session.messages.length, ...messagesBeforeTurn);
    }
    throw error;
  } finally {
    session.toolRuntimeState.runId = undefined;
    session.toolRuntimeState.source = undefined;
  }
}

export function expandAntigravitySkillInvocation(
  session: Pick<AntigravityNativeSession, "agent" | "managedHome">,
  rawQuery: string,
  prompt: string,
): string {
  const invocation = /^\/([a-z0-9][a-z0-9-]*)(?=\s|$)/i.exec(
    readExplicitSkillInvocationSource(rawQuery),
  );
  if (invocation === null) return prompt;
  const requestedName = invocation[1]?.toLowerCase();
  const sourceSkills = (session.agent.skills?.skills ?? []).filter(
    (skill) => skill.path !== undefined,
  );
  const sourceIndex = sourceSkills.findIndex(
    (skill) => skill.name.trim().toLowerCase() === requestedName,
  );
  const registeredName = session.managedHome.skills[sourceIndex];
  if (sourceIndex < 0 || registeredName === undefined) return prompt;
  return `/${registeredName}\n\n${prompt}`;
}

function readExplicitSkillInvocationSource(rawQuery: string): string {
  if (
    !/^(?:# Images mentioned by the user:|# Files mentioned by the user:|# Directories mentioned by the user:)/.test(
      rawQuery,
    )
  ) {
    return rawQuery;
  }
  const marker = "\n\n# My request\n";
  const markerIndex = rawQuery.indexOf(marker);
  return markerIndex < 0 ? rawQuery : rawQuery.slice(markerIndex + marker.length);
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
  readonly agentName: string;
  readonly workspace: string;
  readonly logPath: string;
  readonly permissionMode: AntigravityRuntimePermissionMode;
  readonly sessionId?: string | undefined;
  readonly modelName?: string | undefined;
  readonly thinkingLevel?: string | undefined;
  readonly customizationWorkspace?: string | undefined;
}): readonly string[] {
  const sessionArgs =
    options.sessionId === undefined || options.sessionId === ""
      ? []
      : ["--conversation", assertAntigravityConversationId(options.sessionId)];
  return [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--agent",
    options.agentName,
    "--add-dir",
    options.workspace,
    ...(options.customizationWorkspace === undefined
      ? []
      : ["--add-dir", options.customizationWorkspace]),
    "--log-file",
    options.logPath,
    "--mode",
    "accept-edits",
    ...(options.permissionMode === "full-access" ? [] : ["--sandbox"]),
    // agy 1.1.11 performs a second non-interactive confirmation after an
    // allowing PreToolUse decision for MCP tools. Bypass that native prompt;
    // the Session-private fail-closed Hook remains the authoritative gate for
    // every tool in all permission modes.
    "--dangerously-skip-permissions",
    ...sessionArgs,
    ...(options.modelName === undefined ? [] : ["--model", options.modelName]),
    ...(options.thinkingLevel === undefined ? [] : ["--effort", options.thinkingLevel]),
  ];
}

export function createAntigravityUserMessage(
  startupMessages: readonly ExpertAgentStartupMessage[],
  prompt: string,
): {
  readonly event: "user";
  readonly message: {
    readonly role: "user";
    readonly content: readonly { readonly type: "text"; readonly text: string }[];
  };
} {
  return {
    event: "user",
    message: {
      role: "user",
      content: [...startupMessages.map((message) => message.content), prompt].map((text) => ({
        type: "text",
        text,
      })),
    },
  };
}

export function cancelAntigravityTurn(session: AntigravityNativeSession): void {
  session.connection?.pending?.reject(createAbortError());
  void closeAntigravitySession(session);
}

export async function closeAntigravitySession(session: AntigravityNativeSession): Promise<void> {
  if (session.connection !== undefined)
    await closeAntigravityConnection(session, session.connection);
}

async function closeAntigravityConnection(
  session: AntigravityNativeSession,
  connection: AntigravityConnection,
): Promise<void> {
  connection.closing = true;
  connection.pending?.reject(createAbortError());
  await connection.supervisor.terminate(antigravityTerminationOptions(session.logger));
  // Descendants can inherit these pipes; process exit alone does not close them.
  connection.process.stdin.destroy();
  connection.process.stdout.destroy();
  connection.process.stderr.destroy();
  if (session.connection === connection) clearAntigravityConnection(session);
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

async function runAntigravityProcess(
  session: AntigravityNativeSession,
  turn: RuntimeTurnContext<AntigravityNativeEvent>,
  input: ReturnType<typeof createAntigravityUserMessage>,
  modelName: string | undefined,
  thinkingLevel: string | undefined,
): Promise<ProcessRunResult> {
  const selection = JSON.stringify([modelName, thinkingLevel]);
  if (
    session.connection !== undefined &&
    (session.connection.selection !== selection ||
      session.connection.closing ||
      session.connection.supervisor.hasExited())
  ) {
    await closeAntigravitySession(session);
  }
  const logPath =
    session.connection?.logPath ?? join(session.managedHome.logDir, `stream-${randomUUID()}.log`);
  let connection: AntigravityConnection;
  let checkpoints: TranscriptCheckpoints;
  let logCheckpoint: TranscriptCheckpoint;
  try {
    [checkpoints, logCheckpoint] = await Promise.all([
      captureAntigravityTranscriptCheckpoints(session.managedHome.homeDir, session.sessionId),
      captureFileCheckpoint(logPath),
    ]);
    if (turn.signal.aborted) throw createAbortError();
    connection =
      session.connection ??
      openAntigravityConnection(session, selection, logPath, modelName, thinkingLevel);
    // Observe a failed OS spawn before stdin can obscure it with EPIPE.
    if ("pid" in connection.process && connection.process.pid === undefined) {
      try {
        await connection.supervisor.exit;
        throw new Error("Antigravity exited before its process could start.");
      } catch (error) {
        await closeAntigravityConnection(session, connection);
        throw error;
      }
    }
    if (connection.pending !== undefined)
      throw new Error("Antigravity already has an active turn.");
    if (connection.closing || connection.supervisor.hasExited())
      throw new Error("Antigravity exited before dispatch.");
  } catch (error) {
    throw new RuntimeTurnNotDispatchedError(error);
  }
  const state = createStreamState();
  // Deduplicate compaction operations for the whole connection, not just a turn.
  const turnState = { ...state, compactions: connection.compactions };
  connection.stderr = new BoundedRuntimeOutputBuffer(STDERR_TAIL_LIMIT);
  const result = new Promise<ProcessRunResult>((resolve, reject) => {
    connection.pending = {
      state: turnState,
      resolve,
      reject,
      logCheckpoint,
      priorSessionId: session.sessionId,
      transcriptCheckpoints: checkpoints,
      writeNative(event) {
        turn.stream.writeNative(event);
      },
    };
  });
  const pending = connection.pending!;
  const abort = (): void => {
    pending.reject(createAbortError());
    void closeAntigravityConnection(session, connection);
  };
  turn.signal.addEventListener("abort", abort, { once: true });
  try {
    // Once write is attempted, failure can be ambiguous. Never automatically replay it.
    connection.process.stdin.write(`${JSON.stringify(input)}\n`, (error) => {
      if (error != null && connection.pending === pending) pending.reject(error);
    });
    if (turn.signal.aborted) abort();
    return await result;
  } catch (error) {
    await closeAntigravityConnection(session, connection);
    throw error;
  } finally {
    turn.signal.removeEventListener("abort", abort);
    if (connection.pending === pending) connection.pending = undefined;
  }
}

function openAntigravityConnection(
  session: AntigravityNativeSession,
  selection: string,
  logPath: string,
  modelName: string | undefined,
  thinkingLevel: string | undefined,
): AntigravityConnection {
  const child = (session.spawn ?? defaultSpawn)(
    session.executablePath,
    createAntigravityArgs({
      agentName: session.managedHome.agentName,
      workspace: session.agent.workspace,
      customizationWorkspace: session.managedHome.customizationWorkspace,
      logPath,
      permissionMode: session.permissionMode,
      sessionId: session.sessionId,
      modelName,
      thinkingLevel,
    }),
    { cwd: session.agent.workspace, env: session.env },
  );
  const supervisor = new RuntimeProcessSupervisor(child);
  const connection: AntigravityConnection = {
    process: child,
    supervisor,
    selection,
    logPath,
    closing: false,
    stderr: new BoundedRuntimeOutputBuffer(STDERR_TAIL_LIMIT),
    compactions: new Map(),
    baselineKnown: session.sessionId === "",
  };
  session.connection = connection;
  child.stdin.on("error", (error) => connection.pending?.reject(error));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => connection.stderr.append(chunk));
  const output = readAgyOutput(child.stdout, (raw) => {
    if (connection.closing || session.connection !== connection) return;
    const pending = connection.pending;
    const state = pending?.state ?? createStreamState();
    const events = normalizeAntigravityStreamRecord(raw, state);
    for (const event of events) {
      if (event.kind === "session") {
        if (session.sessionId !== "" && session.sessionId !== event.sessionId) {
          throw new AntigravityRuntimeError(
            "Antigravity changed the owned conversation identifier.",
            "ANTIGRAVITY_PROTOCOL_ERROR",
            false,
          );
        }
        session.sessionId = event.sessionId;
      }
      if (event.kind === "message-completed" && state.terminalSeen && session.sessionId === "")
        throw new AntigravityRuntimeError(
          "Antigravity returned output without an owned conversation identifier.",
          "ANTIGRAVITY_PROTOCOL_ERROR",
          false,
        );
      if (event.kind !== "usage") pending?.writeNative(event);
    }
    if (pending === undefined) return;
    if (!state.terminalSeen) {
      if (state.resultError !== undefined) {
        const stepUsage = sumStepUsage(state.stepUsage);
        if (stepUsage !== undefined) pending.writeNative({ kind: "usage", usage: stepUsage });
        pending.reject(classifyAntigravityError(state.resultError, connection.stderr.text(), ""));
      }
      return;
    }
    // A failed result is still a completed model turn. Settle cumulative usage
    // before classifying its error so the next turn starts from this baseline.
    const usage = readTurnUsage(connection, state.usage) ?? sumStepUsage(state.stepUsage);
    if (usage !== undefined) pending.writeNative({ kind: "usage", usage });
    const resultError = state.resultError;
    if (resultError !== undefined) {
      connection.pending = undefined;
      void readCurrentTurnLog(logPath, pending.logCheckpoint).then((logTail) => {
        pending.resolve({
          kind: "failure",
          error: classifyAntigravityError(resultError, connection.stderr.text(), logTail),
        });
      });
      return;
    }
    if (session.sessionId === "")
      throw new AntigravityRuntimeError(
        "Antigravity returned output without an owned conversation identifier.",
        "ANTIGRAVITY_PROTOCOL_ERROR",
        false,
      );
    const outputText = state.resultText ?? state.outputText;
    if (state.resultText === undefined && outputText !== "")
      pending.writeNative({ kind: "message-completed", text: outputText });
    connection.pending = undefined;
    if (outputText === "") {
      pending.reject(
        new AntigravityRuntimeError(
          "Antigravity returned an empty result.",
          "ANTIGRAVITY_PROTOCOL_ERROR",
          false,
        ),
      );
    } else {
      pending.resolve({ kind: "success", outputText, usage, sessionId: session.sessionId });
    }
  });
  void output.then(
    async () => {
      if (connection.closing || session.connection !== connection) return;
      if (await waitForRuntimeProcessExit(supervisor.exit, PROCESS_TERMINATION_GRACE_MS)) return;
      if (connection.closing || session.connection !== connection) return;
      connection.pending?.reject(
        new AntigravityRuntimeError(
          "Antigravity closed stdout while its process remained alive.",
          "ANTIGRAVITY_PROTOCOL_ERROR",
          false,
        ),
      );
      await closeAntigravityConnection(session, connection);
    },
    (error: unknown) => {
      if (connection.closing || session.connection !== connection) return;
      connection.pending?.reject(error);
      void closeAntigravityConnection(session, connection);
    },
  );
  void supervisor.exit.then(
    async (exit) => {
      if (connection.closing) return;
      const drained = await waitForRuntimeProcessExit(
        output.then(() => ({ code: 0, signal: null })),
        PROCESS_TERMINATION_GRACE_MS,
      );
      if (connection.closing) return;
      if (!drained) {
        connection.pending?.reject(
          new AntigravityRuntimeError(
            "Antigravity exited without closing its output stream.",
            "ANTIGRAVITY_PROTOCOL_ERROR",
            false,
          ),
        );
        await closeAntigravityConnection(session, connection);
        return;
      }
      const pending = connection.pending;
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (session.connection === connection) clearAntigravityConnection(session);
      if (pending === undefined || pending.state.terminalSeen) return;
      try {
        const logTail = await readCurrentTurnLog(logPath, pending.logCheckpoint);
        if (exit.code !== 0 || pending.state.resultError !== undefined) {
          throw classifyAntigravityError(
            pending.state.resultError ?? `Antigravity CLI exited with code ${exit.code}.`,
            connection.stderr.text(),
            logTail,
          );
        }
        // Only the owned conversation and this turn's checkpoint can supply recovery.
        const text =
          (await recoverAntigravityOutput({
            homeDir: session.managedHome.homeDir,
            sessionId: session.sessionId,
            priorSessionId: pending.priorSessionId,
            transcriptCheckpoints: pending.transcriptCheckpoints,
          })) ?? (pending.state.assistantResponseCompleted ? pending.state.outputText : undefined);
        if (text === undefined || text === "") {
          const failure = readDegradedAntigravityError(pending.state.outputText, logTail);
          if (failure !== undefined)
            throw classifyAntigravityError(failure, connection.stderr.text(), logTail);
          throw new AntigravityRuntimeError(
            "Antigravity exited without a terminal result or settled response.",
            "ANTIGRAVITY_PROTOCOL_ERROR",
            false,
          );
        }
        session.logger.warn(
          "runtime.antigravity_terminal_result_missing",
          "Using settled output from the owned conversation",
          { recovered: true },
        );
        if (session.sessionId === "")
          throw new AntigravityRuntimeError(
            "Antigravity returned output without an owned conversation identifier.",
            "ANTIGRAVITY_PROTOCOL_ERROR",
            false,
          );
        pending.writeNative({ kind: "message-completed", text });
        pending.resolve({ kind: "success", outputText: text, sessionId: session.sessionId });
      } catch (error) {
        pending.reject(error);
      }
    },
    (error: unknown) => {
      if (connection.closing || session.connection !== connection) return;
      connection.pending?.reject(error);
      void closeAntigravityConnection(session, connection);
    },
  );
  return connection;
}

function readTurnUsage(
  connection: AntigravityConnection,
  cumulative: AgentMessageUsage | undefined,
): AgentMessageUsage | undefined {
  if (cumulative === undefined) {
    connection.baselineKnown = false;
    return undefined;
  }
  const previous = connection.cumulativeUsage;
  const known = connection.baselineKnown;
  connection.cumulativeUsage = cumulative;
  connection.baselineKnown = true;
  if (!known) return undefined;
  if (
    previous !== undefined &&
    (cumulative.input < previous.input ||
      cumulative.output < previous.output ||
      cumulative.cacheRead < previous.cacheRead ||
      cumulative.cacheWrite < previous.cacheWrite)
  )
    return undefined;
  return createUsageFromTokenCounts({
    measurement: "reported",
    inputTokens: cumulative.input - (previous?.input ?? 0),
    inputTokensIncludeCacheRead: false,
    outputTokens: cumulative.output - (previous?.output ?? 0),
    cacheReadTokens: cumulative.cacheRead - (previous?.cacheRead ?? 0),
    cacheWriteTokens: cumulative.cacheWrite - (previous?.cacheWrite ?? 0),
  });
}

function sumStepUsage(
  observations: ReadonlyMap<string, AgentMessageUsage>,
): AgentMessageUsage | undefined {
  if (observations.size === 0) return undefined;
  const values = [...observations.values()];
  return createUsageFromTokenCounts({
    measurement: "reported",
    inputTokensIncludeCacheRead: false,
    inputTokens: values.reduce((sum, usage) => sum + usage.input, 0),
    outputTokens: values.reduce((sum, usage) => sum + usage.output, 0),
    cacheReadTokens: values.reduce((sum, usage) => sum + usage.cacheRead, 0),
    cacheWriteTokens: values.reduce((sum, usage) => sum + usage.cacheWrite, 0),
  });
}

function clearAntigravityConnection(session: AntigravityNativeSession): void {
  session.connection = undefined;
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
  const type = readString(raw["event"])?.toLowerCase() ?? "unknown";
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

  const stepUsage = readAntigravityUsage(step);
  if (stepUsage !== undefined) state.stepUsage.set(key, stepUsage);
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

  const normalizedStepType = normalizeStepType(stepType);
  const isThoughtStep = isThoughtStepType(normalizedStepType);
  const isAssistantResponseStep = isAssistantResponseStepType(normalizedStepType);
  if (isAssistantResponseStep && key !== state.latestAssistantResponseKey) {
    state.latestAssistantResponseKey = key;
    state.assistantResponseCompleted = false;
  }
  if (normalizedStepType === "error_message") {
    events.push({
      kind: "progress",
      stage: "antigravity.error_message",
      data: sanitizeProgressData({
        index,
        status,
        stepType,
        message:
          readText(step["error"] ?? step["message"] ?? step["content"] ?? step["text"]) ??
          "Antigravity reported a recoverable step error.",
      }),
    });
  }
  const textDelta = readText(step["text_delta"] ?? step["textDelta"]);
  if (textDelta !== undefined) {
    if (isThoughtStep) {
      state.thoughtSnapshots.set(key, (state.thoughtSnapshots.get(key) ?? "") + textDelta);
      events.push({ kind: "thought-delta", text: textDelta });
    } else if (isAssistantResponseStep) {
      state.textSnapshots.set(key, (state.textSnapshots.get(key) ?? "") + textDelta);
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

  const thought = readText(
    step["raw_thought"] ??
      step["rawThought"] ??
      step["thought"] ??
      step["reasoning"] ??
      (isThoughtStep && textDelta === undefined ? (step["content"] ?? step["text"]) : undefined),
  );
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
  if (isAssistantResponseStep && status !== undefined) {
    state.assistantResponseCompleted = isSuccessfulTerminalStatus(status);
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

function normalizeStepType(stepType: string): string {
  return stepType
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function isThoughtStepType(stepType: string): boolean {
  return (
    stepType === "reason" ||
    stepType === "reasoning" ||
    stepType.includes("thought") ||
    stepType === "analysis"
  );
}

function isAssistantResponseStepType(stepType: string): boolean {
  switch (stepType) {
    case "agent_response":
    case "planner_response":
    case "model_response":
    case "assistant":
    case "assistant_response":
    case "final_response":
    case "answer":
    case "notify_user":
    case "finish":
      return true;
    default:
      return false;
  }
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
  const nativeName =
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
  // Preserve the native wrapper input (including ServerName) for audit, while
  // displaying the actual MCP operation consistently across its lifecycle.
  const mcpName =
    nativeName === "call_mcp_tool" ? readString(readRecord(input)?.["ToolName"]) : undefined;
  const name =
    mcpName !== undefined && /^[a-zA-Z0-9_-]{1,64}$/.test(mcpName) ? mcpName : nativeName;
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
      failed:
        isFailureStatus(status) ||
        toolInfo["is_error"] === true ||
        hasNonEmptyToolError(toolInfo["error"]),
    });
  }
  return events;
}

function hasNonEmptyToolError(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  return printableValue(sanitizeProgressData(value)).trim() !== "";
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
  const compactionStatus = readString(info["status"] ?? info["state"])?.toLowerCase() ?? status;
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
): Promise<void> {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const consume = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    if (Buffer.byteLength(trimmed) > MAX_NDJSON_LINE_BYTES) {
      throw new AntigravityRuntimeError(
        "Antigravity NDJSON frame exceeds the line limit.",
        "ANTIGRAVITY_PROTOCOL_ERROR",
        false,
      );
    }
    onRecord(parseStructuredAgyLine(trimmed));
  };
  for await (const chunk of stdout) {
    buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      consume(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (Buffer.byteLength(buffer) > MAX_NDJSON_LINE_BYTES) {
      throw new AntigravityRuntimeError(
        "Antigravity NDJSON frame exceeds the line limit.",
        "ANTIGRAVITY_PROTOCOL_ERROR",
        false,
      );
    }
  }
  consume(buffer + decoder.end());
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
  return undefined;
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
      checkpoints.set(root, await captureFileCheckpoint(transcript));
    }),
  );
  return checkpoints;
}

async function captureFileCheckpoint(path: string): Promise<TranscriptCheckpoint> {
  try {
    const metadata = await stat(path);
    return metadata.isFile()
      ? { kind: "tracked", size: metadata.size, dev: metadata.dev, ino: metadata.ino }
      : { kind: "unavailable" };
  } catch (error) {
    return isMissingPathError(error) ? { kind: "missing" } : { kind: "unavailable" };
  }
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

function antigravityTerminationOptions(logger: PragmaLogger) {
  return {
    graceMs: PROCESS_TERMINATION_GRACE_MS,
    onForceKill: () => {
      logger.warn(
        "runtime.antigravity_force_kill",
        "Antigravity CLI did not stop after SIGTERM; sending SIGKILL",
      );
    },
    onStuck: () => {
      logger.error(
        "runtime.antigravity_process_did_not_exit",
        "Antigravity CLI did not report exit after SIGKILL; continuing bounded Session cleanup",
        new Error("Antigravity CLI remained alive after SIGKILL."),
      );
    },
  };
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
    stepUsage: new Map(),
    textSnapshots: new Map(),
    thoughtSnapshots: new Map(),
    tools: new Map(),
    compactions: new Map(),
    outputText: "",
    terminalSeen: false,
    assistantResponseCompleted: false,
  };
}

function readSessionId(record: Record<string, unknown>): string | undefined {
  const candidate = readString(
    record["conversation_id"] ??
      record["conversationId"] ??
      record["session_id"] ??
      record["sessionId"],
  );
  return candidate === undefined ? undefined : assertAntigravityConversationId(candidate);
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
  return /^(?:complete|completed|success|succeeded|done|failed|error|cancelled|canceled|rejected|denied|blocked|aborted)$/i.test(
    status ?? "",
  );
}

function isSuccessfulTerminalStatus(status: string): boolean {
  return /^(?:complete|completed|success|succeeded|done)$/i.test(status);
}

function isFailureStatus(status: string | undefined): boolean {
  return /^(?:failed|error|cancelled|canceled|rejected|denied|blocked|aborted)$/i.test(
    status ?? "",
  );
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

async function readTail(
  path: string,
  limit: number,
  checkpoint?: TranscriptCheckpoint,
): Promise<string> {
  return await readFileTailWithMetadata(path, limit, checkpoint).then(
    (tail) => tail.content,
    () => "",
  );
}

async function readCurrentTurnLog(path: string, checkpoint: TranscriptCheckpoint): Promise<string> {
  return checkpoint.kind === "unavailable" ? "" : await readTail(path, LOG_TAIL_LIMIT, checkpoint);
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
