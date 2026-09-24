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
} from "@pragma/core";
import type { AgentMessage } from "@pragma/shared";

import {
  connectOpenCode,
  type OpenCodeClient,
  type OpenCodeModelRef,
  type OpenCodePermissionRule,
  type OpenCodeWireEvent,
} from "./client.ts";
import { prepareOpenCodeDataHome } from "./data-home.ts";
import { probeOpenCode, startOpenCodeProcess } from "./process.ts";

export type OpenCodePermissionMode = "request-approval" | "auto-approve" | "full-access";

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
      const discoveryEnv = await prepareOpenCodeDataHome(env, discoveryRoot);
      const nativeProcess = await startOpenCodeProcess({
        executablePath,
        env: discoveryEnv,
        cwd: globalThis.process.cwd(),
        ...detected,
      });
      const client = connectOpenCode(nativeProcess, globalThis.process.cwd());
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
        const sessionEnvironment = await prepareOpenCodeDataHome(
          ctx.processEnvironment,
          ctx.paths.runtimeSessionDir("opencode"),
        );
        const process = await startOpenCodeProcess({
          executablePath,
          env: sessionEnvironment,
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
          const rules = permissionRules(mode);
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
                  inputTokens: session.tokenCounter.countText(promptText, {
                    runtimeKind: "opencode",
                  }).tokens,
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
  let approved = session.mode !== "request-approval";
  if (
    session.mode === "request-approval" &&
    typeof session.humanInteractionHandler === "function"
  ) {
    const response = await session.humanInteractionHandler({
      kind: "tool_approval",
      toolName: String(event.data["action"] ?? event.data["type"] ?? "opencode"),
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

function permissionRules(mode: OpenCodePermissionMode): readonly OpenCodePermissionRule[] {
  return [{ action: "*", resource: "*", effect: mode === "request-approval" ? "ask" : "allow" }];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
