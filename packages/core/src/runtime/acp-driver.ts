import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  type ClientConnection,
  type ClientCapabilities,
  type ContentBlock,
  type InitializeResponse,
  type NewSessionRequest,
  type SessionConfigOption,
  type SessionUpdate,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type PromptResponse,
} from "@agentclientprotocol/sdk";
import type { AgentMessage, AgentMessageUsage } from "@pragma/shared";
import type { ExpertAgentStartupMessage } from "../agent/context-manager.ts";
import {
  defineRuntimeDriver,
  RuntimeTurnNotDispatchedError,
  type DefineRuntimeDriverOptions,
  type RuntimeDriver,
  type RuntimeNativeSessionContext,
  type RuntimeTurnContext,
} from "./driver.ts";
import { isRuntimeFeatureEnabled, type RuntimeFeatureSet } from "./features.ts";
import type {
  RuntimeAdapter,
  RuntimeContextWindowUsage,
  RuntimeModelSelection,
} from "./runtime-adapter.ts";
import type { RuntimeCommandSpawn } from "./process-probe.ts";
import type { RuntimeEventMappingContext, RuntimeEventMappingResult } from "./stream-controller.ts";
import { BoundedRuntimeOutputBuffer, RuntimeProcessSupervisor } from "./process-supervisor.ts";
import { createEmptyUsage, createUsageFromTokenCounts, mergeUsage } from "./usage.ts";
import { createRuntimeContextWindowUsage } from "./context-window.ts";
import { defaultRuntimeTokenCounter, type RuntimeTokenCounter } from "./token-counter.ts";
import {
  SteerDeliveryUncertainError,
  SteerNotDispatchedError,
} from "../execution/steer-delivery-error.ts";

export interface AcpRuntimeEvent {
  readonly update?: SessionUpdate;
  readonly completedMessage?: AgentMessage;
  readonly completedText?: string;
  readonly mapping?: RuntimeEventMappingResult;
  readonly toolName?: string | undefined;
  readonly toolStarted?: boolean;
  readonly toolTerminal?: boolean;
  readonly toolDelta?: string | undefined;
}

/** Provider-specific configuration stays in the adapter, outside the ACP transport. */
export interface AcpRuntimeBinding {
  readonly command: {
    readonly executablePath: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
  };
  readonly spawn?: RuntimeCommandSpawn | undefined;
  readonly session: NewSessionRequest;
  readonly clientCapabilities?: ClientCapabilities | undefined;
  /** Some agents (including Claude) report prompt totals rather than session snapshots. */
  readonly promptUsageScope?: "turn" | "session" | undefined;
  readonly tokenContext?: string | undefined;
  readonly tokenCounter?: RuntimeTokenCounter | undefined;
  readonly extensionNotifications?:
    Readonly<Record<string, (params: unknown, session: AcpRuntimeSession) => void>> | undefined;
  readonly selectModel?:
    | ((session: AcpRuntimeSession, selection: RuntimeModelSelection | undefined) => Promise<void>)
    | undefined;
  readonly requestPermission?:
    | ((
        params: RequestPermissionRequest,
        signal: AbortSignal,
      ) => Promise<RequestPermissionResponse>)
    | undefined;
  readonly createElicitation?:
    | ((
        params: CreateElicitationRequest,
        signal: AbortSignal,
      ) => Promise<CreateElicitationResponse>)
    | undefined;
  readonly steer?:
    | ((session: AcpRuntimeSession, content: string) => Promise<"injected" | "not_dispatched">)
    | undefined;
  readonly compact?: ((session: AcpRuntimeSession) => Promise<void>) | undefined;
  readonly onReady?: ((session: AcpRuntimeSession) => void | Promise<void>) | undefined;
  readonly subscribe?: ((session: AcpRuntimeSession) => () => void) | undefined;
  /** Settle provider lifecycle events while the originating turn is still available. */
  readonly onTurnSettled?: ((session: AcpRuntimeSession) => void) | undefined;
}

type DriverBase<F extends RuntimeFeatureSet> = Pick<
  RuntimeDriver<AcpRuntimeEvent, AcpRuntimeSession, F>,
  "descriptor" | "features" | "canUse" | "listModels" | "resolvePersistence" | "outputRetryLimit"
>;

export type DefineAcpRuntimeDriverOptions<F extends RuntimeFeatureSet> = DriverBase<F> & {
  readonly prepare: (context: RuntimeNativeSessionContext<F>) => Promise<AcpRuntimeBinding>;
};

export class AcpRuntimeSession {
  sessionId = "";
  pendingStartupMessages: readonly ExpertAgentStartupMessage[] = [];
  private replaying = false;
  private reportedUsage = createEmptyUsage();
  private controlPrompt = false;
  private preparing = false;
  private readonly tokenHistory: unknown[] = [];
  private readonly tokenTools = new Map<
    string,
    { name: string; input?: unknown; output?: unknown; content?: unknown }
  >();
  initialize!: InitializeResponse;
  configOptions: SessionConfigOption[] = [];
  contextWindow: RuntimeContextWindowUsage | undefined;
  readonly messages: AgentMessage[] = [];
  active:
    | {
        readonly turn: RuntimeTurnContext<AcpRuntimeEvent>;
        text: string;
        thought: string;
        usage: AgentMessageUsage | undefined;
        input: string;
      }
    | undefined;
  private readonly tools = new Map<string, { name: string; terminal: boolean; content: string }>();
  private steering: Promise<void> = Promise.resolve();
  private closing = false;
  private closingOperation: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(
    readonly connection: ClientConnection,
    readonly supervisor: RuntimeProcessSupervisor,
    readonly binding: AcpRuntimeBinding,
  ) {}

  get isClosing(): boolean {
    return this.closing;
  }

  /** Normalize the usage scope declared by the provider binding. */
  recordReportedUsage(reported: NonNullable<PromptResponse["usage"]>): AgentMessageUsage {
    const snapshot = createUsageFromTokenCounts({
      inputTokens: reported.inputTokens,
      inputTokensIncludeCacheRead: false,
      outputTokens: reported.outputTokens,
      cacheReadTokens: reported.cachedReadTokens ?? 0,
      cacheWriteTokens: reported.cachedWriteTokens ?? 0,
    });
    if (this.binding.promptUsageScope === "turn") return snapshot;
    const previous = this.reportedUsage;
    this.reportedUsage = snapshot;
    return createUsageFromTokenCounts({
      inputTokens: Math.max(0, snapshot.input - previous.input),
      inputTokensIncludeCacheRead: false,
      outputTokens: Math.max(0, snapshot.output - previous.output),
      cacheReadTokens: Math.max(0, snapshot.cacheRead - previous.cacheRead),
      cacheWriteTokens: Math.max(0, snapshot.cacheWrite - previous.cacheWrite),
    });
  }

  emit(mapping: RuntimeEventMappingResult): void {
    this.active?.turn.stream.writeNative({ mapping });
    if (mapping.usage !== undefined && this.active !== undefined) this.active.usage = mapping.usage;
    if (mapping.contextWindowUsage !== undefined) this.contextWindow = mapping.contextWindowUsage;
  }

  async open(restoredId: string | undefined): Promise<void> {
    this.initialize = await withDeadline(
      this.connection.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientInfo: { name: "pragma", version: "1" },
        clientCapabilities: this.binding.clientCapabilities ?? {},
      }),
      15_000,
      "ACP initialization timed out",
    );
    if (this.initialize.protocolVersion !== 1) throw new Error("Unsupported ACP protocol version");
    if (
      this.binding.session.mcpServers.some(
        (server) => "type" in server && server.type === "http",
      ) &&
      this.initialize.agentCapabilities?.mcpCapabilities?.http !== true
    ) {
      throw new Error("ACP agent does not support HTTP MCP servers");
    }
    if (restoredId !== undefined && restoredId !== "") {
      if (!this.initialize.agentCapabilities?.loadSession)
        throw new Error("ACP agent cannot load the owned session");
      this.sessionId = restoredId;
      this.replaying = true;
      const response = await withDeadline(
        this.connection.agent.request(methods.agent.session.load, {
          ...this.binding.session,
          sessionId: restoredId,
        }),
        60_000,
        "ACP session load timed out",
      );
      this.configOptions = response.configOptions ?? [];
      this.replaying = false;
    } else {
      const response = await withDeadline(
        this.connection.agent.request(methods.agent.session.new, this.binding.session),
        60_000,
        "ACP session creation timed out",
      );
      this.sessionId = response.sessionId;
      this.configOptions = response.configOptions ?? [];
    }
    await this.binding.onReady?.(this);
    this.unsubscribe = this.binding.subscribe?.(this);
  }

  update(sessionId: string, update: SessionUpdate): void {
    if (this.sessionId !== "" && sessionId !== this.sessionId) return;
    if (update.sessionUpdate === "config_option_update") this.configOptions = update.configOptions;
    if (update.sessionUpdate === "usage_update") {
      this.contextWindow = createRuntimeContextWindowUsage({
        usedTokens: update.used,
        contextWindowTokens: update.size,
        measurement: "reported",
      });
    }
    const active = this.active;
    if (this.controlPrompt) return;
    if (active !== undefined || this.replaying) {
      if (
        (update.sessionUpdate === "user_message_chunk" && this.replaying) ||
        update.sessionUpdate === "agent_message_chunk" ||
        update.sessionUpdate === "agent_thought_chunk"
      )
        this.tokenHistory.push({ role: update.sessionUpdate, content: update.content });
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        let tool = this.tokenTools.get(update.toolCallId);
        if (tool === undefined) {
          tool = { name: update.name ?? update.title ?? update.kind ?? "acp_tool" };
          this.tokenTools.set(update.toolCallId, tool);
          this.tokenHistory.push(tool);
        }
        if (update.rawInput !== undefined) tool.input = update.rawInput;
        if (update.rawOutput !== undefined) tool.output = update.rawOutput;
        if (update.content !== undefined) tool.content = update.content;
      }
    }
    if (active === undefined) {
      if (
        this.replaying &&
        (update.sessionUpdate === "user_message_chunk" ||
          update.sessionUpdate === "agent_message_chunk") &&
        update.content.type === "text"
      ) {
        this.appendMessage(
          update.sessionUpdate === "user_message_chunk" ? "user" : "assistant",
          update.content.text,
          true,
        );
      }
      return;
    }
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
      active.text += update.content.text;
    if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text")
      active.thought += update.content.text;
    let toolName: string | undefined;
    let toolStarted = false;
    let toolTerminal = false;
    let toolDelta: string | undefined;
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const previous = this.tools.get(update.toolCallId);
      toolName = previous?.name ?? update.name ?? update.title ?? update.kind ?? "acp_tool";
      toolStarted = previous === undefined;
      toolTerminal =
        !previous?.terminal && (update.status === "completed" || update.status === "failed");
      const content =
        update.content == null
          ? (previous?.content ?? "")
          : update.content
              .flatMap((item) =>
                item.type === "content" && item.content.type === "text" ? [item.content.text] : [],
              )
              .join("\n");
      if (content !== (previous?.content ?? ""))
        toolDelta = content.startsWith(previous?.content ?? "")
          ? content.slice(previous?.content.length ?? 0)
          : content;
      this.tools.set(update.toolCallId, {
        name: toolName,
        terminal: previous?.terminal === true || toolTerminal,
        content,
      });
    }
    active.turn.stream.writeNative({ update, toolName, toolStarted, toolTerminal, toolDelta });
  }

  async setConfig(category: string, value: string): Promise<void> {
    this.assertOpen();
    const option = this.configOptions.find(
      (candidate) => candidate.category === category || candidate.id === category,
    );
    if (option === undefined || option.type !== "select")
      throw new Error(`ACP configuration unavailable: ${category}`);
    const values = option.options.flatMap((candidate) =>
      "options" in candidate ? candidate.options : [candidate],
    );
    if (!values.some((candidate) => candidate.value === value))
      throw new Error(`Unsupported ACP ${category}: ${value}`);
    if (option.currentValue === value) return;
    const result = await this.mutationWithDeadline(
      this.connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: this.sessionId,
        configId: option.id,
        value,
      }),
      15_000,
      `ACP configuration timed out: ${category}`,
    );
    this.configOptions = result.configOptions;
  }

  async prompt(
    turn: RuntimeTurnContext<AcpRuntimeEvent>,
  ): Promise<{ outputText: string; usage: AgentMessageUsage; runtimeSessionId: string }> {
    let dispatched = false;
    let reserved = false;
    try {
      this.assertOpen();
      if (this.preparing || this.active !== undefined || this.controlPrompt)
        throw new Error("An ACP operation is already active");
      this.preparing = true;
      reserved = true;
      return await this.promptTurn(turn, () => {
        dispatched = true;
      });
    } catch (error) {
      if (!dispatched) throw new RuntimeTurnNotDispatchedError(error);
      throw error;
    } finally {
      if (reserved) this.preparing = false;
    }
  }

  private async promptTurn(
    turn: RuntimeTurnContext<AcpRuntimeEvent>,
    onDispatch: () => void,
  ): Promise<{ outputText: string; usage: AgentMessageUsage; runtimeSessionId: string }> {
    if (turn.signal.aborted) throw new Error("ACP prompt cancelled before dispatch");
    await this.binding.selectModel?.(this, turn.modelSelection);
    if (turn.signal.aborted) throw new Error("ACP prompt cancelled before dispatch");
    const prompt: ContentBlock[] = [
      ...turn.startupMessages
        .filter((message) => message.content.trim() !== "")
        .map((message) => ({ type: "text" as const, text: message.content })),
      { type: "text", text: turn.prompt },
    ];
    for (const attachment of turn.attachments) {
      if (attachment.kind === "image") {
        if (!this.initialize.agentCapabilities?.promptCapabilities?.image)
          throw new Error("ACP agent cannot accept images");
        const path = attachment.optimized?.path ?? attachment.path;
        prompt.push({
          type: "image",
          data: (await readFile(path, { signal: turn.signal })).toString("base64"),
          mimeType:
            attachment.optimized?.mimeType ?? attachment.mimeType ?? "application/octet-stream",
        });
      } else {
        prompt.push({
          type: "resource_link",
          uri: pathToFileURL(attachment.path).href,
          name: attachment.name,
          ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
        });
      }
    }
    this.assertOpen();
    if (turn.signal.aborted) throw new Error("ACP prompt cancelled before dispatch");
    this.tools.clear();
    this.tokenTools.clear();
    const active = {
      turn,
      text: "",
      thought: "",
      usage: undefined as AgentMessageUsage | undefined,
      input: (this.binding.tokenContext ?? "") + JSON.stringify([...this.tokenHistory, ...prompt]),
    };
    this.tokenHistory.push(...prompt);
    this.active = active;
    for (const message of turn.startupMessages) this.appendMessage("user", message.content);
    this.appendMessage("user", turn.rawQuery);
    let terminalUsageRecorded = false;
    try {
      onDispatch();
      const response = await this.connection.agent.request(methods.agent.session.prompt, {
        sessionId: this.sessionId,
        prompt,
      });
      const exactUsage =
        response.usage == null ? active.usage : this.recordReportedUsage(response.usage);
      active.usage = exactUsage;
      terminalUsageRecorded = response.usage != null;
      if (!terminalUsageRecorded && exactUsage?.measurement === "reported") {
        this.recordFallbackUsage(exactUsage);
        terminalUsageRecorded = true;
      }
      if (response.stopReason === "cancelled" || response.stopReason === "refusal") {
        throw new Error(
          response.stopReason === "cancelled"
            ? "ACP prompt cancelled"
            : "ACP agent refused the prompt",
        );
      }
      const counter = this.binding.tokenCounter ?? defaultRuntimeTokenCounter;
      const identity = {
        modelId: turn.modelSelection?.model.modelId,
        providerId: turn.modelSelection?.model.providerId,
      };
      const usage =
        exactUsage ??
        createUsageFromTokenCounts({
          measurement: "estimated",
          inputTokens: counter.countText(active.input, identity).tokens,
          inputTokensIncludeCacheRead: false,
          outputTokens: counter.countText(active.text + active.thought, identity).tokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
      this.appendMessage("assistant", active.text, false, usage);
      const message = this.messages.at(-1)!;
      if (message.role === "assistant") {
        message.stopReason =
          response.stopReason === "max_tokens" || response.stopReason === "max_turn_requests"
            ? "length"
            : "stop";
        if (active.thought !== "")
          message.content.unshift({ type: "thinking", thinking: active.thought });
        message.model = turn.modelSelection?.model.modelId ?? "runtime-managed";
        message.provider = turn.modelSelection?.model.providerId ?? "runtime-managed";
      }
      turn.stream.writeNative({
        completedText: active.text,
        completedMessage: this.messages.at(-1)!,
      });
      return { outputText: active.text, usage, runtimeSessionId: this.sessionId };
    } catch (error) {
      // A provider result may precede an RPC error or disconnect. Keep its exact usage.
      if (active.usage !== undefined) {
        if (!terminalUsageRecorded && active.usage.measurement === "reported")
          this.recordFallbackUsage(active.usage);
        this.emit({ usage: active.usage });
      }
      throw error;
    } finally {
      try {
        this.binding.onTurnSettled?.(this);
      } finally {
        this.active = undefined;
      }
    }
  }

  async steer(request: { readonly content: string; readonly targetRunId: string }): Promise<void> {
    const operation = this.steering.then(async () => {
      const active = this.active;
      if (active === undefined || active.turn.runId !== request.targetRunId)
        throw new SteerNotDispatchedError(
          "target_changed",
          "ACP target turn changed before steering",
        );
      if (this.binding.steer === undefined)
        throw new SteerNotDispatchedError(
          "runtime_unsupported",
          "ACP agent has no steering extension",
        );
      const outcome = await this.binding.steer(this, request.content);
      if (outcome === "not_dispatched")
        throw new SteerNotDispatchedError("no_active_turn", "ACP target turn has already finished");
      active.input += JSON.stringify({ type: "text", text: request.content });
      this.tokenHistory.push({ type: "text", text: request.content });
      this.appendMessage("user", request.content);
    });
    this.steering = operation.catch(() => {});
    await operation;
  }

  async cancel(): Promise<void> {
    const active = this.active;
    if (active === undefined) return;
    try {
      await withDeadline(
        this.connection.agent.notify(methods.agent.session.cancel, { sessionId: this.sessionId }),
        1_000,
        "ACP cancellation dispatch timed out",
      );
      await withDeadline(
        new Promise<void>((resolve) => {
          const poll = setInterval(() => {
            if (this.active !== active) {
              clearInterval(poll);
              resolve();
            }
          }, 10);
          setTimeout(() => {
            clearInterval(poll);
            resolve();
          }, 1_000).unref();
        }),
        1_100,
        "ACP cancellation timed out",
      );
    } finally {
      if (this.active === active) await this.close();
    }
  }

  async compact(): Promise<RuntimeContextWindowUsage | undefined> {
    this.assertOpen();
    if (this.preparing || this.active !== undefined || this.controlPrompt)
      throw new Error("Cannot compact an active ACP operation");
    if (this.binding.compact === undefined) throw new Error("ACP agent cannot compact context");
    this.controlPrompt = true;
    try {
      await this.mutationWithDeadline(
        this.binding.compact(this),
        60_000,
        "ACP compaction timed out",
      );
    } finally {
      this.controlPrompt = false;
    }
    return this.contextWindow;
  }

  private assertOpen(): void {
    if (this.closing || this.connection.signal.aborted)
      throw new Error("ACP connection is closed; restore the owned session before continuing");
  }

  private recordFallbackUsage(usage: AgentMessageUsage): void {
    if (this.binding.promptUsageScope !== "turn")
      this.reportedUsage = mergeUsage(this.reportedUsage, usage)!;
  }

  private async mutationWithDeadline<T>(
    operation: Promise<T>,
    ms: number,
    message: string,
  ): Promise<T> {
    try {
      return await withDeadline(operation, ms, message);
    } catch (error) {
      if (error instanceof AcpTimeoutError) await this.close().catch(() => {});
      throw error;
    }
  }

  close(): Promise<void> {
    return (this.closingOperation ??= this.closeOnce());
  }

  private async closeOnce(): Promise<void> {
    this.closing = true;
    this.unsubscribe?.();
    try {
      if (
        !this.connection.signal.aborted &&
        this.sessionId !== "" &&
        this.initialize?.agentCapabilities?.sessionCapabilities?.close !== undefined
      ) {
        await withDeadline(
          this.connection.agent.request(methods.agent.session.close, { sessionId: this.sessionId }),
          750,
          "ACP close timed out",
        );
      }
    } finally {
      this.connection.close();
      await this.supervisor.terminate({ graceMs: 500 });
    }
  }

  private appendMessage(
    role: "user" | "assistant",
    text: string,
    replay = false,
    usage = createEmptyUsage(),
  ): void {
    const previous = this.messages.at(-1);
    if (replay && previous?.role === role) {
      if (role === "user" && previous.role === "user" && typeof previous.content === "string")
        previous.content += text;
      else if (previous.role === "assistant") previous.content.push({ type: "text", text });
      return;
    }
    this.messages.push(
      role === "user"
        ? { role, content: text, timestamp: Date.now() }
        : {
            role,
            content: [{ type: "text", text }],
            timestamp: Date.now(),
            api: "acp",
            provider: "runtime-managed",
            model: "runtime-managed",
            usage,
            stopReason: "stop",
          },
    );
  }
}

export function defineAcpRuntimeDriver<F extends RuntimeFeatureSet>(
  options: DefineAcpRuntimeDriverOptions<F>,
  lifecycle: DefineRuntimeDriverOptions = {},
): RuntimeAdapter {
  if (!isRuntimeFeatureEnabled(options.features.close))
    throw new Error("The ACP stdio driver requires close support to release its subprocess.");
  return defineRuntimeDriver<AcpRuntimeEvent, AcpRuntimeSession>(
    {
      ...options,
      async createSession(ctx) {
        const binding = await options.prepare(ctx as RuntimeNativeSessionContext<F>);
        const child = (
          binding.spawn ??
          ((command, args, settings) => spawn(command, [...args], { ...settings, stdio: "pipe" }))
        )(binding.command.executablePath, binding.command.args, {
          cwd: ctx.workspace,
          env: binding.command.env,
        });
        const supervisor = new RuntimeProcessSupervisor(child);
        const stderr = new BoundedRuntimeOutputBuffer(8_192);
        child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
        // Assigned before the transport dispatches its first notification.
        // eslint-disable-next-line prefer-const
        let session: AcpRuntimeSession;
        const app = client({ name: "pragma" })
          .onNotification(methods.client.session.update, ({ params }) =>
            session.update(params.sessionId, params.update),
          )
          .onRequest(methods.client.session.requestPermission, async ({ params, signal }) => {
            const active = session.active;
            if (params.sessionId !== session.sessionId || active === undefined)
              return { outcome: { outcome: "cancelled" as const } };
            const requestSignal = AbortSignal.any([signal, active.turn.signal]);
            const response = await binding.requestPermission?.(params, requestSignal);
            return requestSignal.aborted || session.active !== active || response === undefined
              ? { outcome: { outcome: "cancelled" as const } }
              : response;
          })
          .onRequest(methods.client.elicitation.create, async ({ params, signal }) => {
            const active = session.active;
            if (
              active === undefined ||
              ("sessionId" in params && params.sessionId !== session.sessionId)
            )
              return { action: "cancel" as const };
            const requestSignal = AbortSignal.any([signal, active.turn.signal]);
            const response = await binding.createElicitation?.(params, requestSignal);
            return requestSignal.aborted || session.active !== active || response === undefined
              ? { action: "cancel" as const }
              : response;
          });
        for (const [method, handler] of Object.entries(binding.extensionNotifications ?? {}))
          app.onNotification(
            method,
            (value) => value,
            ({ params }) => handler(params, session),
          );
        const connection = app.connect(
          ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
        );
        session = new AcpRuntimeSession(connection, supervisor, binding);
        void supervisor.exit.then(
          (exit) => {
            if (!session.isClosing)
              ctx.logger.warn("runtime.acp_process_exit", "ACP process exited", {
                code: exit.code,
                signal: exit.signal,
                stderr: stderr.text(),
              });
            connection.close(new Error(`ACP process exited (${exit.code ?? exit.signal})`));
          },
          (error: unknown) => connection.close(error),
        );
        try {
          await session.open(
            ctx.persistence.restoredRuntimeSessionId ?? ctx.request.runtimeSession?.id,
          );
        } catch (error) {
          await session.close().catch(() => {});
          throw error;
        }
        // A loaded conversation may contain older or compacted Context bodies.
        // Bootstrap every newly opened connection with the current assembly.
        session.pendingStartupMessages = ctx.agentContext.startupMessages;
        return session;
      },
      readSession: (session) => ({ runtimeSessionId: session.sessionId }),
      listMessages: (session) => session.messages,
      consumeStartupMessages(session) {
        const messages = session.pendingStartupMessages;
        session.pendingStartupMessages = [];
        return messages;
      },
      startTurn: (session, turn) => session.prompt(turn),
      mapEvent: mapAcpRuntimeEvent,
      readContextWindow: isRuntimeFeatureEnabled(options.features.contextWindow)
        ? (session) => session.contextWindow
        : undefined,
      compactContext: isRuntimeFeatureEnabled(options.features.compaction)
        ? (session) => session.compact()
        : undefined,
      cancelTurn: isRuntimeFeatureEnabled(options.features.cancellation)
        ? (session) => session.cancel()
        : undefined,
      steerTurn: isRuntimeFeatureEnabled(options.features.steering)
        ? (session, request) => session.steer(request)
        : undefined,
      closeSession: isRuntimeFeatureEnabled(options.features.close)
        ? (session) => session.close()
        : undefined,
    },
    lifecycle,
  );
}

export function mapAcpRuntimeEvent(
  event: AcpRuntimeEvent,
  context: RuntimeEventMappingContext,
): RuntimeEventMappingResult {
  if (event.mapping !== undefined) return event.mapping;
  if (event.completedMessage !== undefined)
    return {
      completedText: event.completedText,
      events: [context.events.messageCompleted(event.completedMessage)],
    };
  const update = event.update;
  if (update === undefined) return {};
  if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
    return {
      outputDelta: update.content.text,
      events: [context.events.messageDelta(update.content.text)],
    };
  if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text")
    return { events: [context.events.thoughtDelta(update.content.text)] };
  if (update.sessionUpdate === "usage_update")
    return {
      contextWindowUsage: createRuntimeContextWindowUsage({
        usedTokens: update.used,
        contextWindowTokens: update.size,
        measurement: "reported",
      }),
    };
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    const tool = { toolCallId: update.toolCallId, toolName: event.toolName ?? "acp_tool" };
    const events = [];
    if (event.toolStarted)
      events.push(context.events.toolStarted({ ...tool, inputPreview: update.rawInput }));
    if (event.toolDelta !== undefined && event.toolDelta !== "")
      events.push(context.events.toolDelta({ ...tool, delta: event.toolDelta }));
    if (event.toolTerminal)
      events.push(
        update.status === "failed"
          ? context.events.toolFailed({
              ...tool,
              message: typeof update.rawOutput === "string" ? update.rawOutput : "ACP tool failed",
            })
          : context.events.toolCompleted({
              ...tool,
              outputPreview: update.rawOutput ?? update.content,
            }),
      );
    return { events };
  }
  return {};
}

/** Host-owned idle handling prevents an untracked detached prompt. */
export async function steerAcpSession(
  session: AcpRuntimeSession,
  content: string,
): Promise<"injected" | "not_dispatched"> {
  const steering = session.initialize._meta?.["steering"];
  if (
    typeof steering !== "object" ||
    steering === null ||
    !("supported" in steering) ||
    steering.supported !== true
  )
    throw new SteerNotDispatchedError(
      "runtime_unsupported",
      "ACP agent does not advertise steering",
    );
  try {
    const response = await withDeadline(
      session.connection.agent.request<{ outcome: string }>("_session/steering", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: content }],
        _meta: { steering: { idleBehavior: "promptRequired" } },
      }),
      1_750,
      "ACP steering timed out",
    );
    if (response.outcome === "injected") return "injected";
    if (response.outcome === "promptRequired") return "not_dispatched";
    throw new Error(`Unexpected ACP steering outcome: ${response.outcome}`);
  } catch (error) {
    throw new SteerDeliveryUncertainError("ACP steering delivery could not be confirmed", {
      cause: error,
    });
  }
}

class AcpTimeoutError extends Error {}

async function withDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AcpTimeoutError(message)), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
