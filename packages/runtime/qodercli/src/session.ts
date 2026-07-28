import type {
  AgentMessage,
  AgentMessageUsage,
  AgentAssistantMessage,
} from "@pragma/shared";
import {
  createRuntimeContextWindowUsage,
  createUsageFromTokenCounts,
  type Expert,
  type ExpertAgentHumanInteractionHandler,
  type ExpertToolRuntimeState,
  type PragmaLogger,
  type RuntimeContextWindowUsage,
  type RuntimeEventMappingContext,
  type RuntimeEventMappingResult,
  type RuntimeTurnContext,
  type RuntimeTurnResult,
} from "@pragma/core";
import {
  ProcessTransport,
  query,
  type AuthOptions,
  type CanUseTool,
  type PostCompactHookInput,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKResultSuccess,
} from "@qoder-ai/qoder-agent-sdk";

import { resolveQoderContextWindow } from "./models.ts";
import { defaultTokenEstimator } from "./token-estimator.ts";
import type { QoderCliRuntimePermissionMode } from "./types.ts";

export type QoderNativeEvent =
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
      readonly kind: "tool-completed";
      readonly id: string;
      readonly name: string;
      readonly output?: unknown;
      readonly failed?: boolean;
    }
  | { readonly kind: "progress"; readonly stage: string; readonly data?: unknown }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "usage"; readonly usage: AgentMessageUsage };

export interface QoderNativeSession {
  readonly agent: Expert;
  readonly auth: AuthOptions;
  readonly executablePath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly configDir: string;
  readonly mcpServerUrl: string;
  readonly plugin: { readonly path: string; readonly skills: readonly string[] };
  readonly logger: PragmaLogger;
  readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
  readonly permissionMode: QoderCliRuntimePermissionMode;
  readonly defaultModelName?: string | undefined;
  readonly defaultThinkingLevel?: string | undefined;
  readonly contextWindowOverride?: number | undefined;
  readonly compactModelName?: string | undefined;
  readonly systemPrompt: string;
  readonly toolRuntimeState: ExpertToolRuntimeState;
  readonly messages: AgentMessage[];
  readonly toolNames: Map<string, string>;
  sessionId: string;
  activeQuery?: Query | undefined;
  contextWindowUsage?: RuntimeContextWindowUsage | undefined;
  compactSummary?: string | undefined;
  pendingCompaction?: {
    trigger?: "manual" | "auto" | undefined;
    preTokens?: number | undefined;
    summary?: string | undefined;
  } | undefined;
  contextWindowTokens?: number | undefined;
}

export async function startQoderTurn(
  session: QoderNativeSession,
  turn: RuntimeTurnContext<QoderNativeEvent>,
): Promise<RuntimeTurnResult> {
  session.toolRuntimeState.runId = turn.runId;
  session.toolRuntimeState.source = turn.source;
  session.messages.push({
    role: "user",
    content: turn.rawQuery,
    timestamp: Date.now(),
  });

  const prompt = [...turn.startupMessages.map((message) => message.content), turn.prompt].join(
    "\n\n",
  );
  const result = await runQoderQuery(session, prompt, turn);
  const usage = mapQoderUsage(result);
  const assistant = createAssistantMessage(result, usage);
  appendPendingCompactionSummary(session);
  session.messages.push(assistant);
  if (session.contextWindowUsage?.measurement === "estimated") {
    session.contextWindowUsage = estimateContextUsage(session);
  }

  return {
    outputText: result.subtype === "success" ? result.result : undefined,
    usage,
    runtimeSessionId: session.sessionId,
  };
}

export function mapQoderEvent(
  event: QoderNativeEvent,
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
      return { events: [context.events.messageCompleted(event.text)] };
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
    case "tool-completed":
      return {
        events: [
          event.failed === true
            ? context.events.toolFailed({
                toolCallId: event.id,
                toolName: event.name,
                message: typeof event.output === "string" ? event.output : "Qoder tool failed.",
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

export function listQoderMessages(session: QoderNativeSession): readonly AgentMessage[] {
  return session.messages;
}

export function readQoderContextWindow(
  session: QoderNativeSession,
): RuntimeContextWindowUsage | undefined {
  return session.contextWindowUsage;
}

export async function compactQoderContextWindow(
  session: QoderNativeSession,
): Promise<RuntimeContextWindowUsage | undefined> {
  if (session.sessionId === "") {
    throw new Error("Cannot compact a Qoder session before its first turn.");
  }

  session.pendingCompaction = undefined;
  const q = createQuery(session, "/compact", {
    modelName: session.compactModelName,
    onPostCompact(input) {
      session.compactSummary = input.compact_summary;
      session.pendingCompaction = {
        ...(session.pendingCompaction ?? {}),
        trigger: input.trigger,
        summary: input.compact_summary,
      };
    },
  });
  session.activeQuery = q;
  try {
    let result: SDKResultMessage | undefined;
    let iterationError: unknown;
    const init = await q.initializationResult();
    if (!init.commands.some((command) => command.name === "compact")) {
      throw new Error("The installed Qoder CLI does not support the /compact command.");
    }
    try {
      for await (const message of q) {
        updateSessionId(session, message);
        if (
          message.type === "system" &&
          message.subtype === "compact_boundary" &&
          message.compact_metadata.trigger === "manual"
        ) {
          session.pendingCompaction = {
            ...(session.pendingCompaction ?? {}),
            trigger: "manual",
            preTokens: message.compact_metadata.pre_tokens,
          };
        }
        if (message.type === "result") {
          result = message;
          session.contextWindowUsage = await readContextUsage(q, session, message);
        }
      }
    } catch (error) {
      iterationError = error;
    }
    requireSuccessfulQoderResult(
      result,
      iterationError,
      "Qoder CLI ended /compact without a result message.",
    );
    if (
      session.pendingCompaction?.trigger !== "manual" ||
      session.pendingCompaction.preTokens === undefined
    ) {
      throw new Error("Qoder CLI completed /compact without a manual compaction boundary.");
    }
    appendPendingCompactionSummary(session);
    return session.contextWindowUsage;
  } finally {
    session.pendingCompaction = undefined;
    session.activeQuery = undefined;
    await q.close().catch(() => undefined);
  }
}

export async function cancelQoderTurn(session: QoderNativeSession): Promise<void> {
  await session.activeQuery?.interrupt().catch(() => undefined);
}

export async function closeQoderSession(session: QoderNativeSession): Promise<void> {
  await session.activeQuery?.close().catch(() => undefined);
  session.activeQuery = undefined;
}

async function runQoderQuery(
  session: QoderNativeSession,
  prompt: string,
  turn: RuntimeTurnContext<QoderNativeEvent>,
): Promise<SDKResultMessage> {
  session.pendingCompaction = undefined;
  const q = createQuery(session, prompt, {
    modelName: turn.modelSelection?.model.modelId,
    thinkingLevel: turn.modelSelection?.thinkingLevel,
    onPostCompact(input) {
      session.compactSummary = input.compact_summary;
      session.pendingCompaction = {
        ...(session.pendingCompaction ?? {}),
        trigger: input.trigger,
        summary: input.compact_summary,
      };
    },
  });
  session.activeQuery = q;
  const onAbort = (): void => {
    void q.interrupt().catch(() => undefined);
  };
  turn.signal.addEventListener("abort", onAbort, { once: true });

  try {
    let result: SDKResultMessage | undefined;
    let iterationError: unknown;
    try {
      for await (const message of q) {
        updateSessionId(session, message);
        emitSdkMessage(session, message, turn);
        if (message.type === "result") {
          result = message;
          session.contextWindowUsage = await readContextUsage(q, session, message);
          turn.stream.writeNative({ kind: "usage", usage: mapQoderUsage(message) });
        }
      }
    } catch (error) {
      iterationError = error;
    }
    return requireSuccessfulQoderResult(
      result,
      iterationError,
      "Qoder CLI ended without a result message.",
    );
  } finally {
    turn.signal.removeEventListener("abort", onAbort);
    session.activeQuery = undefined;
    session.toolRuntimeState.runId = undefined;
    session.toolRuntimeState.source = undefined;
    await q.close().catch(() => undefined);
  }
}

function createQuery(
  session: QoderNativeSession,
  prompt: string,
  options: {
    readonly modelName?: string | undefined;
    readonly thinkingLevel?: string | undefined;
    readonly onPostCompact?: ((input: PostCompactHookInput) => void) | undefined;
  },
): Query {
  const modelName = options.modelName ?? session.defaultModelName ?? "auto";
  const compactModelName = session.compactModelName ?? modelName;
  return query({
    prompt,
    options: {
      auth: session.auth,
      transport: ProcessTransport.default,
      pathToQoderCLIExecutable: session.executablePath,
      cwd: session.agent.workspace,
      env: { ...session.env, QODER_CONFIG_DIR: session.configDir },
      settingSources: [],
      ...(session.sessionId === "" ? {} : { resume: session.sessionId }),
      includePartialMessages: true,
      includeHookEvents: true,
      systemPrompt: { type: "preset", preset: "qodercli", append: session.systemPrompt },
      mcpServers: {
        pragma: {
          type: "http",
          url: session.mcpServerUrl,
          tools: [{ name: "*", permission_policy: "always_allow" }],
        },
      },
      allowedMcpServerNames: ["pragma"],
      strictMcpConfig: true,
      disallowedTools: ["AskUserQuestion"],
      settings: { model: compactModelName },
      plugins: [{ type: "local", path: session.plugin.path }],
      skills: [...session.plugin.skills],
      permissionMode: session.permissionMode,
      allowDangerouslySkipPermissions: session.permissionMode === "bypassPermissions",
      ...(session.permissionMode === "bypassPermissions"
        ? {}
        : { canUseTool: createCanUseTool(session.humanInteractionHandler) }),
      hooks: {
        PostCompact: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name === "PostCompact") {
                  options.onPostCompact?.(input);
                }
                return {};
              },
            ],
          },
        ],
      },
      resolveModel(context) {
        const isCompaction =
          context.purpose === "compact" || context.purpose === "compression";
        const resolvedModelName = isCompaction ? compactModelName : modelName;
        const selected =
          context.availableModels.find((model) => model.value === resolvedModelName) ??
          context.availableModels.find((model) => model.isDefault === true);
        const contextWindow = resolveQoderContextWindow(
          selected,
          session.contextWindowOverride,
        );
        if (!isCompaction) session.contextWindowTokens = contextWindow;
        return {
          model: resolvedModelName,
          parameters: {
            contextWindow,
            ...(options.thinkingLevel === undefined
              ? {}
              : { reasoningEffort: options.thinkingLevel }),
          },
        };
      },
      stderr(data) {
        session.logger.debug("runtime.qodercli_stderr", "Qoder CLI stderr", { data });
      },
    },
  });
}

function createCanUseTool(
  handler: ExpertAgentHumanInteractionHandler | undefined,
): CanUseTool {
  return async (toolName, input, options) => {
    if (toolName.startsWith("mcp__pragma__")) {
      return { behavior: "allow", updatedInput: input };
    }
    if (handler === undefined) {
      return { behavior: "deny", message: "No approval handler is configured." };
    }
    const response = await handler({
      kind: "tool_approval",
      toolName,
      toolCallId: options.toolUseID,
      reason: options.decisionReason ?? "Qoder CLI requested tool approval.",
      input,
    });
    if (response.kind !== "tool_approval" || !response.approved) {
      return {
        behavior: "deny",
        message:
          response.kind === "tool_approval"
            ? response.reason ?? "Tool call was denied."
            : "Invalid approval response.",
      };
    }
    return {
      behavior: "allow",
      updatedInput: resolveQoderApprovedToolInput(input, response.updatedInput),
    };
  };
}

export function resolveQoderApprovedToolInput(
  originalInput: Record<string, unknown>,
  updatedInput: unknown,
): Record<string, unknown> {
  if (updatedInput === null || typeof updatedInput !== "object" || Array.isArray(updatedInput)) {
    return originalInput;
  }
  const prototype = Object.getPrototypeOf(updatedInput);
  return prototype === Object.prototype || prototype === null
    ? (updatedInput as Record<string, unknown>)
    : originalInput;
}

function emitSdkMessage(
  session: QoderNativeSession,
  message: SDKMessage,
  turn: RuntimeTurnContext<QoderNativeEvent>,
): void {
  if (message.type === "stream_event") {
    const event = message.event;
    const delta = asRecord(event.delta);
    if (delta?.["type"] === "text_delta" && typeof delta["text"] === "string") {
      turn.stream.writeNative({ kind: "message-delta", text: delta["text"] });
    } else if (
      delta?.["type"] === "thinking_delta" &&
      typeof delta["thinking"] === "string"
    ) {
      turn.stream.writeNative({ kind: "thought-delta", text: delta["thinking"] });
    }
    const block = asRecord(event.content_block);
    if (event.type === "content_block_start" && block?.["type"] === "tool_use") {
      const id = typeof block["id"] === "string" ? block["id"] : "";
      const name = typeof block["name"] === "string" ? block["name"] : "qoder_tool";
      if (id !== "") {
        session.toolNames.set(id, name);
        turn.stream.writeNative({ kind: "tool-started", id, name, input: block["input"] });
      }
    }
    return;
  }

  if (message.type === "assistant") {
    const text = message.message.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    if (text !== "") turn.stream.writeNative({ kind: "message-completed", text });
    return;
  }

  if (message.type === "user") {
    const content = Array.isArray(message.message.content) ? message.message.content : [];
    for (const block of content) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const name = session.toolNames.get(block.tool_use_id) ?? "qoder_tool";
      turn.stream.writeNative({
        kind: "tool-completed",
        id: block.tool_use_id,
        name,
        output: block.content,
        failed: block.is_error === true,
      });
    }
    return;
  }

  if (message.type === "system" && message.subtype === "init") {
    turn.stream.writeNative({ kind: "session", sessionId: message.session_id });
    turn.stream.writeNative({
      kind: "progress",
      stage: "qoder.initialized",
      data: { version: message.qodercli_version, model: message.model },
    });
    return;
  }

  if (message.type === "system" && message.subtype === "compact_boundary") {
    session.pendingCompaction = {
      ...(session.pendingCompaction ?? {}),
      trigger: message.compact_metadata.trigger,
      preTokens: message.compact_metadata.pre_tokens,
    };
  }

  if (message.type === "system") {
    turn.stream.writeNative({
      kind: "progress",
      stage: `qoder.${message.subtype}`,
      data: message,
    });
  }
}

function appendPendingCompactionSummary(session: QoderNativeSession): void {
  const pending = session.pendingCompaction;
  if (pending?.summary === undefined || pending.preTokens === undefined) return;
  session.messages.push({
    role: "compactionSummary",
    summary: pending.summary,
    tokensBefore: pending.preTokens,
    timestamp: Date.now(),
  });
  session.pendingCompaction = undefined;
}

export function mapQoderUsage(result: SDKResultMessage): AgentMessageUsage {
  return createUsageFromTokenCounts({
    measurement: "reported",
    inputTokens: result.usage.input_tokens,
    inputTokensIncludeCacheRead: false,
    outputTokens: result.usage.output_tokens,
    cacheReadTokens: result.usage.cache_read_input_tokens,
    cacheWriteTokens: result.usage.cache_creation_input_tokens,
    cacheWrite1hTokens: result.usage.cache_creation.ephemeral_1h_input_tokens,
  });
}

export function requireSuccessfulQoderResult(
  result: SDKResultMessage | undefined,
  iterationError: unknown,
  missingResultMessage: string,
): SDKResultSuccess {
  if (result === undefined) {
    if (iterationError !== undefined) throw iterationError;
    throw new Error(missingResultMessage);
  }
  if (result.subtype !== "success") {
    throw new Error(result.errors.join("\n") || `Qoder CLI failed: ${result.subtype}.`);
  }
  if (iterationError !== undefined) throw iterationError;
  return result;
}

async function readContextUsage(
  q: Query,
  session: QoderNativeSession,
  result?: SDKResultMessage,
): Promise<RuntimeContextWindowUsage | undefined> {
  const derived = deriveQoderContextWindowUsage(result, session.contextWindowTokens);
  if (derived !== undefined) return derived;
  const usage = await q.getContextUsage().catch(() => undefined);
  if (usage !== undefined && usage.maxTokens > 0) {
    return createRuntimeContextWindowUsage({
      usedTokens: usage.totalTokens,
      contextWindowTokens: usage.maxTokens,
      measurement: "reported",
    });
  }
  if (session.contextWindowTokens === undefined) return undefined;
  return estimateContextUsage(session);
}

export function deriveQoderContextWindowUsage(
  result: SDKResultMessage | undefined,
  contextWindowTokens: number | undefined,
): RuntimeContextWindowUsage | undefined {
  const ratio = result?.usage.context_usage_ratio;
  if (
    contextWindowTokens === undefined ||
    ratio === undefined ||
    !Number.isFinite(ratio) ||
    ratio < 0
  ) {
    return undefined;
  }
  return createRuntimeContextWindowUsage({
    usedTokens: ratio * contextWindowTokens,
    contextWindowTokens,
    measurement: "derived",
  });
}

function estimateContextUsage(
  session: QoderNativeSession,
): RuntimeContextWindowUsage | undefined {
  if (session.contextWindowTokens === undefined) return undefined;
  const latestCompactionIndex = session.messages.findLastIndex(
    (message) => message.role === "compactionSummary",
  );
  const activeMessages =
    latestCompactionIndex < 0 ? session.messages : session.messages.slice(latestCompactionIndex);
  return createRuntimeContextWindowUsage({
    usedTokens: defaultTokenEstimator.count(
      JSON.stringify({
        systemPrompt: session.systemPrompt,
        messages: activeMessages,
        ...(latestCompactionIndex < 0 && session.compactSummary !== undefined
          ? { compactSummary: session.compactSummary }
          : {}),
      }),
    ),
    contextWindowTokens: session.contextWindowTokens,
    measurement: "estimated",
  });
}

function createAssistantMessage(
  result: SDKResultMessage,
  usage: AgentMessageUsage,
): AgentAssistantMessage {
  return {
    role: "assistant",
    content:
      result.subtype === "success"
        ? [{ type: "text", text: result.result }]
        : [{ type: "text", text: result.errors.join("\n") }],
    api: "qoder-agent-sdk",
    provider: "qoder",
    model: Object.keys(result.modelUsage)[0] ?? "qoder",
    usage,
    stopReason: result.subtype === "success" ? "stop" : "error",
    timestamp: Date.now(),
  };
}

function updateSessionId(session: QoderNativeSession, message: SDKMessage): void {
  if ("session_id" in message && typeof message.session_id === "string") {
    session.sessionId = message.session_id;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
