import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createExpertToolsHttpMcpFeature,
  createMcpToolRegistryPool,
  createUsageFromTokenCounts,
  defaultRuntimeTokenCounter,
  defineRuntimeDriver,
  defineRuntimeFeatures,
  runtimeFeature,
  type McpToolRegistryPool,
  type RuntimeAdapter,
  type RuntimeCanUseResult,
  type RuntimeDriverDescriptorOverride,
  type RuntimeEventMappingContext,
  type RuntimeEventMappingResult,
  type RuntimeModel,
  type RuntimeSessionPersistenceSpec,
  type RuntimeSessionRestoreHandler,
  type RuntimeSessionSyncCallback,
  type RuntimeTokenCounter,
  type ExpertAgentStartupMessage,
  type ExpertAgentHumanInteractionHandler,
  type ExpertAgentUserQuestion,
} from "@pragma/core";
import type { AgentMessage } from "@pragma/shared";

import {
  connectOpenCode,
  type OpenCodeClient,
  type OpenCodeModelRef,
  type OpenCodeWireEvent,
} from "./client.ts";
import { prepareOpenCodeDataHome } from "./data-home.ts";
import { prepareOpenCodeConfiguration } from "./configuration.ts";
import { v2PermissionRules, type OpenCodePermissionMode } from "./permissions.ts";
import { probeOpenCode, startOpenCodeProcess } from "./process.ts";

export type { OpenCodePermissionMode } from "./permissions.ts";

export interface OpenCodeRuntimeOptions {
  readonly descriptor?: RuntimeDriverDescriptorOverride | undefined;
  readonly executablePath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly permissionMode?: OpenCodePermissionMode | undefined;
  readonly tokenCounter?: RuntimeTokenCounter | undefined;
  readonly mcpToolRegistryPool?: McpToolRegistryPool | undefined;
  readonly sessionRestoreHandler?: RuntimeSessionRestoreHandler | undefined;
  readonly sessionSyncCallback?: RuntimeSessionSyncCallback | undefined;
}

interface NativeSession {
  readonly client: OpenCodeClient;
  readonly id: string;
  readonly messages: AgentMessage[];
  pendingStartupMessages: ExpertAgentStartupMessage[];
  readonly toolNames: Map<string, string>;
  readonly mode: OpenCodePermissionMode;
  readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
  readonly model?: OpenCodeModelRef | undefined;
  readonly tokenCounter: RuntimeTokenCounter;
  readonly systemPrompt: string;
  activeAbort: AbortController | undefined;
}

const PROVIDER_EVIDENCE_PENDING =
  "OpenCode 1.x and 2.x smoke tests passed; provider-backed behavior is not yet verified.";

export function createOpenCodeRuntime(options: OpenCodeRuntimeOptions = {}): RuntimeAdapter {
  const executablePath = options.executablePath ?? "opencode";
  const env = { ...(options.env ?? process.env) };
  const pool = options.mcpToolRegistryPool ?? createMcpToolRegistryPool();
  const descriptor = {
    id: "opencode-local",
    kind: "opencode-local" as const,
    displayName: "OpenCode Local",
    capabilities: { targets: ["agent"], executionLocations: ["local"] },
    ...options.descriptor,
  };
  const enabled = () => runtimeFeature.native(runtimeFeature.degraded(PROVIDER_EVIDENCE_PENDING));
  const mcp = createExpertToolsHttpMcpFeature({
    readiness: runtimeFeature.degraded(PROVIDER_EVIDENCE_PENDING),
    pool,
    resourcePrefix: "opencode",
  });
  const permissions = runtimeFeature.session({
    id: "opencode.permissions",
    readiness: runtimeFeature.degraded(PROVIDER_EVIDENCE_PENDING),
    prepare() {
      return { mode: options.permissionMode ?? "request-approval" };
    },
  });
  const features = defineRuntimeFeatures({
    availability: enabled(),
    authentication: enabled(),
    modelDiscovery: enabled(),
    modelSelection: enabled(),
    thinking: enabled(),
    freshSession: enabled(),
    resume: enabled(),
    systemPrompt: enabled(),
    startupMessages: enabled(),
    textStreaming: enabled(),
    reasoningStreaming: enabled(),
    nativeToolLifecycle: enabled(),
    mcp,
    permissions,
    userInteraction: enabled(),
    skills: runtimeFeature.native(
      runtimeFeature.unsupported(
        "Pragma Skill materialization is not connected to OpenCode configuration.",
      ),
    ),
    attachmentImage: enabled(),
    attachmentFile: enabled(),
    attachmentDirectory: runtimeFeature.native(
      runtimeFeature.degraded("Directories are supplied as text paths."),
    ),
    usage: enabled(),
    contextWindow: runtimeFeature.native(
      runtimeFeature.unsupported("Context window inspection is not connected."),
    ),
    compaction: runtimeFeature.native(
      runtimeFeature.degraded(PROVIDER_EVIDENCE_PENDING, { compactionModes: ["manual", "events"] }),
    ),
    cancellation: enabled(),
    steering: runtimeFeature.native(
      runtimeFeature.unsupported(
        "Active-turn steering is not uniformly available in OpenCode 1.x and 2.x.",
      ),
    ),
    close: enabled(),
    cleanup: enabled(),
  });
  const listModels = async (): Promise<readonly RuntimeModel[]> => {
    const discoveryRoot = await mkdtemp(join(tmpdir(), "pragma-opencode-discovery-"));
    try {
      const detected = await probeOpenCode(executablePath, env);
      const discoveryDataEnv = await prepareOpenCodeDataHome(env, discoveryRoot);
      const discovery = await prepareOpenCodeConfiguration({
        env: discoveryDataEnv,
        workspace: discoveryRoot,
        sessionDir: discoveryRoot,
        major: detected.major,
      });
      const nativeProcess = await startOpenCodeProcess({
        executablePath,
        env: discovery.env,
        cwd: discoveryRoot,
        ...detected,
      });
      const client = connectOpenCode(nativeProcess, discoveryRoot);
      try {
        return (await client.listModels()).map((model) => ({
          id: model.modelId,
          displayName: model.displayName,
          provider: {
            kind: "runtime-managed" as const,
            id: model.providerId,
            displayName: model.providerName,
          },
          ...(model.isDefault === undefined ? {} : { default: model.isDefault }),
          ...(model.inputModalities === undefined
            ? {}
            : { inputModalities: model.inputModalities }),
          ...(model.variants === undefined || model.variants.length === 0
            ? {}
            : {
                thinking: {
                  supportedLevels: model.variants.map((value) => ({ value, label: value })),
                },
              }),
        }));
      } finally {
        await client.close();
      }
    } finally {
      await rm(discoveryRoot, { recursive: true, force: true });
    }
  };
  return defineRuntimeDriver(
    {
      descriptor,
      features,
      async canUse(): Promise<RuntimeCanUseResult> {
        try {
          const { version } = await probeOpenCode(executablePath, env);
          const models = await listModels();
          return { usable: true, details: { executablePath, version, modelCount: models.length } };
        } catch (error) {
          return {
            usable: false,
            reason: error instanceof Error ? error.message : String(error),
            details: { executablePath },
          };
        }
      },
      listModels,
      resolvePersistence(ctx): RuntimeSessionPersistenceSpec {
        return {
          mode: "checkpoint",
          sessionDir: ctx.paths.runtimeSessionDir("opencode"),
          checkpointOn: [
            "session.created",
            "turn.completed",
            "context.compacted",
            "session.destroyed",
          ],
          metadata: { format: "opencode-native-session-ref" },
        };
      },
      async createSession(ctx): Promise<NativeSession> {
        const detected = await probeOpenCode(executablePath, env);
        const sessionDir = ctx.paths.runtimeSessionDir("opencode");
        const dataEnvironment = await prepareOpenCodeDataHome(ctx.processEnvironment, sessionDir);
        const sessionConfiguration = await prepareOpenCodeConfiguration({
          env: dataEnvironment,
          workspace: ctx.workspace,
          sessionDir,
          major: detected.major,
        });
        const process = await startOpenCodeProcess({
          executablePath,
          env: sessionConfiguration.env,
          cwd: ctx.workspace,
          permissionMode: ctx.features.permissions.mode,
          mcpUrl: ctx.features.mcp.registration.url,
          ...detected,
        });
        const client = connectOpenCode(process, ctx.workspace);
        try {
          const model = ctx.request.modelSelection?.model;
          const models = await client.listModels();
          if (
            model !== undefined &&
            models.length > 0 &&
            !models.some(
              (item) => item.providerId === model.providerId && item.modelId === model.modelId,
            )
          ) {
            throw new Error(`OpenCode model is unavailable: ${model.providerId}/${model.modelId}.`);
          }
          const mode = ctx.features.permissions.mode;
          const rules = v2PermissionRules(mode, sessionConfiguration.deniedPermissions);
          const id = await client.createSession(
            ctx.persistence.restoredRuntimeSessionId ?? ctx.request.runtimeSession?.id ?? "",
            ctx.agentContext.systemPrompt,
            rules,
          );
          if (detected.major === 2) {
            await client.addMcp(
              `pragma_${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
              ctx.features.mcp.registration.url,
            );
          }
          return {
            client,
            id,
            messages: [],
            toolNames: new Map(),
            mode,
            humanInteractionHandler: ctx.request.humanInteractionHandler,
            model:
              model === undefined
                ? undefined
                : {
                    providerId: model.providerId,
                    modelId: model.modelId,
                    variant: ctx.request.modelSelection?.thinkingLevel,
                  },
            pendingStartupMessages:
              id === (ctx.persistence.restoredRuntimeSessionId ?? ctx.request.runtimeSession?.id)
                ? []
                : [...ctx.agentContext.startupMessages],
            tokenCounter: options.tokenCounter ?? defaultRuntimeTokenCounter,
            systemPrompt: ctx.agentContext.systemPrompt,
            activeAbort: undefined,
          };
        } catch (error) {
          await client.close();
          throw error;
        }
      },
      readSession(session) {
        return { runtimeSessionId: session.id };
      },
      listMessages(session) {
        return session.messages;
      },
      consumeStartupMessages(session) {
        return session.pendingStartupMessages.splice(0);
      },
      async startTurn(session, turn) {
        const abort = new AbortController();
        session.activeAbort = abort;
        const onAbort = () => abort.abort(turn.signal.reason);
        turn.signal.addEventListener("abort", onAbort, { once: true });
        let streamed = "";
        try {
          const model =
            turn.modelSelection === undefined
              ? session.model
              : {
                  providerId: turn.modelSelection.model.providerId,
                  modelId: turn.modelSelection.model.modelId,
                  variant: turn.modelSelection.thinkingLevel,
                };
          const files = turn.attachments
            .filter((attachment) => attachment.kind !== "directory")
            .map((attachment) => ({
              uri: pathToFileURL(attachment.optimized?.path ?? attachment.path).href,
              name: attachment.name,
              mimeType:
                attachment.optimized?.mimeType ?? attachment.mimeType ?? "application/octet-stream",
            }));
          const directoryContext = turn.attachments
            .filter((attachment) => attachment.kind === "directory")
            .map((attachment) => `Directory: ${attachment.path}`)
            .join("\n");
          const promptText = [
            ...turn.startupMessages.map((message) => message.content),
            turn.prompt,
            directoryContext,
          ]
            .filter(Boolean)
            .join("\n\n");
          const previousContext = await session.client.serializedContext(session.id);
          const output = await session.client.prompt({
            sessionId: session.id,
            model,
            signal: abort.signal,
            text: promptText,
            files,
            onEvent: async (event) => {
              if (event.type === "permission.asked" || event.type === "permission.updated") {
                await handlePermission(session, event);
                return;
              }
              if (event.type === "question.asked" || event.type === "form.created") {
                await handleOpenCodeQuestion(session, event);
                return;
              }
              const normalized = normalizeEvent(event, session.toolNames);
              if (normalized?.kind === "message-delta") streamed += normalized.text;
              if (normalized !== undefined) turn.stream.writeNative(normalized);
            },
          });
          if (output.text.trim() === "")
            throw new Error("OpenCode turn completed without assistant text.");
          if (streamed === "")
            turn.stream.writeNative({ kind: "message-delta", text: output.text });
          turn.stream.writeNative({ kind: "message-completed", text: output.text });
          const usage =
            output.usage === undefined
              ? createUsageFromTokenCounts({
                  measurement: "estimated",
                  inputTokens: session.tokenCounter.countText(
                    JSON.stringify({
                      system: session.systemPrompt,
                      history: previousContext,
                      prompt: promptText,
                      attachments: files,
                    }),
                    {
                      runtimeKind: "opencode",
                    },
                  ).tokens,
                  inputTokensIncludeCacheRead: false,
                  outputTokens: session.tokenCounter.countText(output.text, {
                    runtimeKind: "opencode",
                  }).tokens,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                })
              : createUsageFromTokenCounts({
                  measurement: "reported",
                  inputTokens: output.usage.input,
                  inputTokensIncludeCacheRead: true,
                  outputTokens: output.usage.output,
                  cacheReadTokens: output.usage.cacheRead,
                  cacheWriteTokens: output.usage.cacheWrite,
                });
          session.messages.push(
            { role: "user", content: turn.rawQuery, timestamp: Date.now() },
            {
              role: "assistant",
              content: [{ type: "text", text: output.text }],
              api: "opencode",
              provider: model?.providerId ?? "opencode",
              model: model?.modelId ?? "default",
              usage,
              stopReason: "stop",
              timestamp: Date.now(),
            },
          );
          return { outputText: output.text, usage, runtimeSessionId: session.id };
        } finally {
          turn.signal.removeEventListener("abort", onAbort);
          session.activeAbort = undefined;
        }
      },
      mapEvent: mapOpenCodeEvent,
      async compactContext(session) {
        await session.client.compact(session.id, session.model);
        return undefined;
      },
      async cancelTurn(session) {
        session.activeAbort?.abort();
        await session.client.cancel(session.id);
      },
      async closeSession(session) {
        await session.client.close();
      },
    },
    {
      sessionRestoreHandler: options.sessionRestoreHandler,
      sessionSyncCallback: options.sessionSyncCallback,
      createProcessEnvironment: () => ({ ...env }),
    },
  );
}

type NativeEvent =
  | {
      readonly kind: "message-delta" | "thought-delta" | "message-completed";
      readonly text: string;
    }
  | {
      readonly kind: "tool-started" | "tool-completed" | "tool-failed";
      readonly id: string;
      readonly name: string;
      readonly value?: unknown;
    }
  | { readonly kind: "progress"; readonly stage: string };

export function mapOpenCodeEvent(
  event: NativeEvent,
  context: RuntimeEventMappingContext,
): RuntimeEventMappingResult {
  switch (event.kind) {
    case "message-delta":
      return { events: [context.events.messageDelta(event.text)], outputDelta: event.text };
    case "thought-delta":
      return { events: [context.events.thoughtDelta(event.text)] };
    case "message-completed":
      return { events: [context.events.messageCompleted(event.text)], completedText: event.text };
    case "tool-started":
      return {
        events: [
          context.events.toolStarted({
            toolCallId: event.id,
            toolName: event.name,
            inputPreview: event.value,
          }),
        ],
      };
    case "tool-completed":
      return {
        events: [
          context.events.toolCompleted({
            toolCallId: event.id,
            toolName: event.name,
            outputPreview: event.value,
          }),
        ],
      };
    case "tool-failed":
      return {
        events: [
          context.events.toolFailed({
            toolCallId: event.id,
            toolName: event.name,
            message: String(event.value ?? "OpenCode tool failed."),
          }),
        ],
      };
    case "progress":
      return { events: [context.events.progress(event.stage)] };
  }
}

function normalizeEvent(
  event: OpenCodeWireEvent,
  names: Map<string, string>,
): NativeEvent | undefined {
  const data = event.data;
  if (event.type === "session.text.delta" && typeof data["delta"] === "string")
    return { kind: "message-delta", text: data["delta"] };
  if (event.type === "session.reasoning.delta" && typeof data["delta"] === "string")
    return { kind: "thought-delta", text: data["delta"] };
  if (
    event.type === "session.tool.input.started" &&
    typeof data["id"] === "string" &&
    typeof data["name"] === "string"
  ) {
    names.set(data["id"], data["name"]);
    return { kind: "tool-started", id: data["id"], name: data["name"] };
  }
  if (
    (event.type === "session.tool.success" || event.type === "session.tool.failed") &&
    typeof data["id"] === "string"
  ) {
    return {
      kind: event.type === "session.tool.success" ? "tool-completed" : "tool-failed",
      id: data["id"],
      name: names.get(data["id"]) ?? "unknown",
      value: data["error"] ?? data["content"],
    };
  }
  if (event.type === "message.part.updated") {
    const part = object(data["part"]);
    if (part?.["type"] === "text" && typeof data["delta"] === "string")
      return { kind: "message-delta", text: data["delta"] };
    if (part?.["type"] === "reasoning" && typeof data["delta"] === "string")
      return { kind: "thought-delta", text: data["delta"] };
    if (part?.["type"] === "tool" && typeof part["callID"] === "string") {
      const id = part["callID"];
      const name = typeof part["tool"] === "string" ? part["tool"] : "unknown";
      const state = object(part["state"]);
      if (!names.has(id)) {
        names.set(id, name);
        return { kind: "tool-started", id, name, value: state?.["input"] };
      }
      if (state?.["status"] === "completed")
        return { kind: "tool-completed", id, name, value: state["output"] };
      if (state?.["status"] === "error")
        return { kind: "tool-failed", id, name, value: state["error"] };
    }
  }
  if (event.type === "message.part.delta" && typeof data["delta"] === "string") {
    if (data["field"] === "text") return { kind: "message-delta", text: data["delta"] };
    if (data["field"] === "reasoning") return { kind: "thought-delta", text: data["delta"] };
  }
  if (event.type.includes("compaction")) return { kind: "progress", stage: event.type };
  return undefined;
}

async function handlePermission(session: NativeSession, event: OpenCodeWireEvent): Promise<void> {
  const id = event.data["id"];
  if (typeof id !== "string") return;
  const action = String(event.data["action"] ?? event.data["type"] ?? "");
  let approved = session.mode === "full-access";
  if (
    session.mode === "request-approval" &&
    !["bash", "shell", "execute", "external_directory", "task", "subagent"].includes(action) &&
    typeof session.humanInteractionHandler === "function"
  ) {
    const response = await session.humanInteractionHandler({
      kind: "tool_approval",
      toolName: action || "opencode",
      toolCallId: String(event.data["callID"] ?? id),
      input: event.data["resources"] ?? event.data["metadata"] ?? event.data,
      reason: String(
        event.data["message"] ?? event.data["title"] ?? "OpenCode requests permission.",
      ),
    });
    approved = response.kind === "tool_approval" && response.approved;
  }
  await session.client.replyPermission(session.id, id, approved);
}

export async function handleOpenCodeQuestion(
  session: NativeSession,
  event: OpenCodeWireEvent,
): Promise<void> {
  const form = event.type === "form.created" ? object(event.data["form"]) : event.data;
  const id = form?.["id"];
  if (form === undefined || typeof id !== "string")
    throw new Error("OpenCode question event has no request ID.");
  const raw = event.type === "form.created" ? form["fields"] : form["questions"];
  if (!Array.isArray(raw) || raw.length === 0) {
    await session.client.replyQuestion(session.id, id);
    return;
  }
  const parsed = raw.map((entry, index) =>
    parseQuestion(entry, index, event.type === "form.created"),
  );
  if (
    parsed.some((question) => question === undefined) ||
    session.humanInteractionHandler === undefined
  ) {
    await session.client.replyQuestion(session.id, id);
    return;
  }
  const questions = parsed as { key: string; question: ExpertAgentUserQuestion }[];
  const response = await session.humanInteractionHandler({
    kind: "user_question",
    toolName: "askUserQuestion",
    toolCallId: id,
    questions: questions.map((item) => item.question),
  });
  if (response.kind !== "user_question" || !response.answered) {
    await session.client.replyQuestion(session.id, id);
    return;
  }
  const values = object(response.answers);
  if (values === undefined) {
    await session.client.replyQuestion(session.id, id);
    return;
  }
  const answered = questions.map(({ key, question }, index) => {
    const value = values[question.question] ?? values[key] ?? values[String(index)];
    if (typeof value === "string") return [value];
    if (Array.isArray(value) && value.every((item) => typeof item === "string"))
      return value as string[];
    return undefined;
  });
  if (answered.some((answer) => answer === undefined)) {
    await session.client.replyQuestion(session.id, id);
    return;
  }
  if (event.type === "question.asked") {
    await session.client.replyQuestion(session.id, id, answered as string[][]);
  } else {
    await session.client.replyQuestion(
      session.id,
      id,
      Object.fromEntries(
        questions.map(({ key, question }, index) => [
          key,
          question.kind === "multiple_choice"
            ? answered[index]!.map(
                (answer) =>
                  question.options.find((option) => option.label === answer)?.value ?? answer,
              )
            : (question.options.find((option) => option.label === answered[index]![0])?.value ??
              answered[index]![0]!),
        ]),
      ),
    );
  }
}

function parseQuestion(
  value: unknown,
  index: number,
  isForm: boolean,
): { key: string; question: ExpertAgentUserQuestion } | undefined {
  const entry = object(value);
  if (entry === undefined) return undefined;
  if (isForm && entry["type"] !== "string" && entry["type"] !== "multiselect") return undefined;
  const text = isForm
    ? (entry["title"] ?? entry["description"] ?? entry["key"])
    : entry["question"];
  if (typeof text !== "string" || text === "") return undefined;
  const rawOptions = entry["options"];
  const options = Array.isArray(rawOptions)
    ? rawOptions.flatMap((candidate) => {
        const option = object(candidate);
        if (typeof option?.["label"] !== "string") return [];
        return [
          {
            label: option["label"],
            description: String(option["description"] ?? ""),
            ...(typeof option["value"] === "string" ? { value: option["value"] } : {}),
          },
        ];
      })
    : [];
  return {
    key: isForm && typeof entry["key"] === "string" ? entry["key"] : String(index),
    question: {
      question: text,
      header: typeof entry["header"] === "string" ? entry["header"] : "OpenCode",
      kind:
        (isForm && entry["type"] === "multiselect") || entry["multiple"] === true
          ? "multiple_choice"
          : options.length > 0
            ? "single_choice"
            : "text",
      options,
    },
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
