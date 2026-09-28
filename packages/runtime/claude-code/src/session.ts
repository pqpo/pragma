import { z } from "zod";
import {
  CreateElicitationRequest,
  type CreateElicitationResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  createRuntimeContextWindowUsage,
  createUsageFromTokenCounts,
  mergeUsage,
  steerAcpSession,
  type AcpRuntimeBinding,
  type AcpRuntimeSession,
  type ExpertAgentHumanInteractionHandler,
  type ExpertAgentUserQuestion,
  type RuntimeModelSelection,
} from "@pragma/core";
import type { ClaudeCodeRuntimeAdapterOptions } from "./types.ts";
import type { ManagedClaudeCodeConfig } from "./claude-config.ts";
import type { ClaudeCompactionHookRelay } from "./compaction-hooks.ts";
import { resolveClaudeAcpWorkerPath } from "./acp-executable.ts";
import { assertClaudeCodeModelSelection } from "./models.ts";

const sdkMessageSchema = z.object({
  sessionId: z.string(),
  message: z.looseObject({
    type: z.string(),
    usage: z
      .object({
        input_tokens: z.number().nonnegative(),
        output_tokens: z.number().nonnegative(),
        cache_read_input_tokens: z.number().nonnegative().optional(),
        cache_creation_input_tokens: z.number().nonnegative().optional(),
      })
      .optional(),
    modelUsage: z
      .record(z.string(), z.looseObject({ contextWindow: z.number().positive().optional() }))
      .optional(),
  }),
});

export function createClaudeAcpBinding(input: {
  readonly options: ClaudeCodeRuntimeAdapterOptions;
  readonly workspace: string;
  readonly systemPrompt: string;
  readonly managedConfig: ManagedClaudeCodeConfig;
  readonly cli: { readonly executablePath: string; readonly launcherArgs: readonly string[] };
  readonly processEnvironment: NodeJS.ProcessEnv;
  readonly pluginDir: string;
  readonly mcpServerUrl: string;
  readonly relay: ClaudeCompactionHookRelay;
  readonly humanInteractionHandler: ExpertAgentHumanInteractionHandler | undefined;
  readonly defaultSelection: RuntimeModelSelection | undefined;
}): AcpRuntimeBinding {
  const { options, cli, managedConfig } = input;
  const worker = resolveClaudeAcpWorkerPath(options.acpWorkerPath);
  const extraArgs = claudeAdditionalArgs(options.additionalArgs ?? []);
  // Explicit projections take precedence over all user-supplied args.
  extraArgs["bare"] = null;
  extraArgs["strict-mcp-config"] = null;
  let initialModel: string | undefined;
  let initialThinking: string | undefined;
  return {
    promptUsageScope: "turn",
    command: {
      executablePath: process.execPath,
      args: [worker],
      env: {
        ...input.processEnvironment,
        CLAUDE_CONFIG_DIR: managedConfig.configDir,
        CLAUDE_CODE_EXECUTABLE: cli.launcherArgs[0] ?? cli.executablePath,
        ...(process.versions["electron"] === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
      },
    },
    spawn: options.spawn,
    tokenCounter: options.tokenCounter,
    tokenContext: input.systemPrompt,
    clientCapabilities: { elicitation: { form: {} } },
    session: {
      cwd: input.workspace,
      mcpServers: [{ type: "http", name: "pragma", url: input.mcpServerUrl, headers: [] }],
      _meta: {
        systemPrompt: { append: input.systemPrompt },
        claudeCode: {
          emitRawSDKMessages: [{ type: "result" }],
          options: {
            settingSources: [],
            strictMcpConfig: true,
            extraArgs,
            ...(managedConfig.settingsPath === undefined
              ? {}
              : { settings: managedConfig.settingsPath }),
            plugins: [{ type: "local", path: input.pluginDir }],
            ...(input.defaultSelection === undefined
              ? {}
              : {
                  model: input.defaultSelection.model.modelId,
                  effort: input.defaultSelection.thinkingLevel,
                }),
          },
        },
      },
    },
    async onReady(session) {
      initialModel = currentConfigValue(session, "model");
      initialThinking = currentConfigValue(session, "thought_level");
      await session.setConfig("mode", options.permissionMode ?? "bypassPermissions");
      await selectModel(session, input.defaultSelection);
    },
    selectModel: async (session, selection) => await selectModel(session, selection),
    steer: steerAcpSession,
    onTurnSettled() {
      input.relay.failPending("Claude Code ended before context compaction completed.");
    },
    async compact(session) {
      try {
        const result = await session.connection.agent.request("session/prompt", {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "/compact" }],
        });
        if (result.usage != null) session.recordReportedUsage(result.usage);
        if (result.stopReason !== "end_turn")
          throw new Error(`Claude ACP compaction ended with ${result.stopReason}`);
      } catch (error) {
        input.relay.failPending("Claude ACP compaction failed");
        throw error;
      }
    },
    subscribe(session) {
      return input.relay.subscribe((event) => {
        const active = session.active;
        if (active !== undefined)
          session.emit({
            events: [
              {
                runId: active.turn.runId,
                source: active.turn.source,
                type: "progress",
                payload: {
                  stage: event.stage,
                  data: {
                    operationId: event.operationId,
                    trigger: event.trigger,
                    runtimeId: "claude-code-local",
                    ...(event.errorMessage === undefined
                      ? {}
                      : { errorMessage: event.errorMessage }),
                  },
                },
              },
            ],
          });
      });
    },
    extensionNotifications: {
      "_claude/sdkMessage": (value, session) => {
        const result = sdkMessageSchema.safeParse(value);
        if (!result.success || result.data.sessionId !== session.sessionId) return;
        const message = result.data.message;
        if (message.type !== "result") return;
        if (message.usage !== undefined && session.active !== undefined) {
          const usage = message.usage;
          session.active.usage = mergeUsage(
            session.active.usage,
            createUsageFromTokenCounts({
              inputTokens: usage.input_tokens,
              inputTokensIncludeCacheRead: false,
              outputTokens: usage.output_tokens,
              cacheReadTokens: usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
            }),
          );
        }
        const windows = Object.values(message.modelUsage ?? {}).flatMap((model) =>
          model.contextWindow === undefined ? [] : [model.contextWindow],
        );
        if (windows.length === 1 && session.contextWindow !== undefined)
          session.contextWindow = createRuntimeContextWindowUsage({
            usedTokens: session.contextWindow.usedTokens,
            contextWindowTokens: windows[0]!,
            measurement: "reported",
          });
      },
    },
    requestPermission: async (params, signal) =>
      await approveClaudeAcpTool(params, input.humanInteractionHandler, signal),
    createElicitation: async (params, signal) =>
      await answerClaudeAcpForm(params, input.humanInteractionHandler, signal),
  };

  async function selectModel(
    session: AcpRuntimeSession,
    selection: RuntimeModelSelection | undefined,
  ): Promise<void> {
    const model = selection?.model ?? input.defaultSelection?.model;
    const modelId = model?.modelId ?? initialModel;
    const thinkingLevel =
      selection?.thinkingLevel ?? input.defaultSelection?.thinkingLevel ?? initialThinking;
    if (modelId === undefined) return;
    if (options.listModels !== undefined && model !== undefined)
      assertClaudeCodeModelSelection(
        await options.listModels(),
        modelId,
        selection?.thinkingLevel ?? input.defaultSelection?.thinkingLevel,
        model.providerId,
      );
    await session.setConfig("model", modelId);
    if (
      thinkingLevel !== undefined &&
      (selection?.thinkingLevel !== undefined ||
        input.defaultSelection?.thinkingLevel !== undefined ||
        currentConfigValue(session, "thought_level") !== undefined)
    )
      await session.setConfig("thought_level", thinkingLevel);
  }
}

function currentConfigValue(session: AcpRuntimeSession, category: string): string | undefined {
  const option = session.configOptions.find(
    (candidate) => candidate.category === category || candidate.id === category,
  );
  return option?.type === "select" && typeof option.currentValue === "string"
    ? option.currentValue
    : undefined;
}

export async function approveClaudeAcpTool(
  params: RequestPermissionRequest,
  handler: ExpertAgentHumanInteractionHandler | undefined,
  signal: AbortSignal,
): Promise<RequestPermissionResponse> {
  if (handler === undefined || signal.aborted) return { outcome: { outcome: "cancelled" } };
  const metadata = record(params.toolCall._meta?.["claudeCode"]);
  const presentation = record(params._meta?.["permission"]);
  const nativeName = metadata?.["toolName"];
  const presentationName = presentation?.["name"];
  const toolName =
    params.toolCall.name ??
    (typeof nativeName === "string"
      ? nativeName
      : typeof presentationName === "string"
        ? presentationName
        : (params.toolCall.title ?? params.toolCall.kind ?? "claude_tool"));
  const response = await handler({
    kind: "tool_approval",
    toolName,
    toolCallId: params.toolCall.toolCallId,
    reason: "Claude Code requested tool approval.",
    input: params.toolCall.rawInput,
  });
  if (signal.aborted || response.kind !== "tool_approval")
    return { outcome: { outcome: "cancelled" } };
  const option = params.options.find(
    (candidate) => candidate.kind === (response.approved ? "allow_once" : "reject_once"),
  );
  if (option === undefined) return { outcome: { outcome: "cancelled" } };
  return {
    outcome: { outcome: "selected", optionId: option.optionId },
    ...(response.approved && response.updatedInput !== undefined
      ? {
          _meta: {
            "pragma.updatedInput": z.record(z.string(), z.unknown()).parse(response.updatedInput),
          },
        }
      : {}),
  };
}

export async function answerClaudeAcpForm(
  params: CreateElicitationRequest,
  handler: ExpertAgentHumanInteractionHandler | undefined,
  signal: AbortSignal,
): Promise<CreateElicitationResponse> {
  if (handler === undefined || signal.aborted || !CreateElicitationRequest.isForm(params))
    return { action: "cancel" };
  const entries = Object.entries(params.requestedSchema.properties ?? {});
  const customFields = new Map<string, string>();
  for (const [key, field] of entries) {
    const metadata = record(record(field)?.["_meta"]);
    const custom = record(metadata?.["_askUserQuestionCustomAnswer"]);
    if (custom?.["isCustomAnswer"] === true && typeof custom["questionId"] === "string") {
      if (customFields.has(custom["questionId"])) return { action: "cancel" };
      customFields.set(custom["questionId"], key);
    }
  }
  const questions: { key: string; question: ExpertAgentUserQuestion; customKey?: string }[] = [];
  for (const [key, field] of entries) {
    if ([...customFields.values()].includes(key)) continue;
    const value = record(field);
    if (value === undefined) return { action: "cancel" };
    const items = record(value["items"]);
    const choices = value["oneOf"] ?? items?.["anyOf"];
    if (value["type"] !== "string" && value["type"] !== "array") return { action: "cancel" };
    const plainEnum = value["enum"] ?? items?.["enum"];
    const options = Array.isArray(choices)
      ? choices.flatMap((choice) => {
          const entry = record(choice);
          return typeof entry?.["const"] === "string"
            ? [
                {
                  label: typeof entry["title"] === "string" ? entry["title"] : entry["const"],
                  value: entry["const"],
                  description: typeof entry["description"] === "string" ? entry["description"] : "",
                },
              ]
            : [];
        })
      : Array.isArray(plainEnum)
        ? plainEnum.flatMap((value) =>
            typeof value === "string" ? [{ label: value, value, description: "" }] : [],
          )
        : [];
    const title = typeof value["title"] === "string" ? value["title"] : key;
    const question =
      typeof value["description"] === "string"
        ? value["description"]
        : entries.length - customFields.size === 1
          ? params.message
          : `${params.message}\n${title}`;
    const customKey = customFields.get(key);
    questions.push({
      key,
      ...(customKey === undefined ? {} : { customKey }),
      question: {
        question,
        header: title,
        kind:
          value["type"] === "array"
            ? "multiple_choice"
            : options.length > 0
              ? "single_choice"
              : "text",
        options,
      },
    });
  }
  if (
    questions.length === 0 ||
    [...customFields.keys()].some((key) => !questions.some((entry) => entry.key === key))
  )
    return { action: "cancel" };
  const response = await handler({
    kind: "user_question",
    toolName: "askUserQuestion",
    questions: questions.map((entry) => entry.question),
  });
  if (signal.aborted || response.kind !== "user_question" || !response.answered)
    return { action: "cancel" };
  const answers = record(response.answers);
  if (answers === undefined) return { action: "cancel" };
  const content: Record<string, string | string[]> = {};
  for (const { key, question, customKey } of questions) {
    const answer = answers[key] ?? answers[question.question];
    if (answer === undefined) {
      if (params.requestedSchema.required?.includes(key)) return { action: "cancel" };
    } else {
      const values =
        typeof answer === "string"
          ? [answer]
          : Array.isArray(answer) && answer.every((item) => typeof item === "string")
            ? answer
            : undefined;
      if (values === undefined || (question.kind !== "multiple_choice" && values.length !== 1))
        return { action: "cancel" };
      const selected = values.filter(
        (value) =>
          question.options.length === 0 ||
          question.options.some((option) => option.value === value),
      );
      const other = values.filter((value) => !selected.includes(value));
      if (other.length > 0 && customKey === undefined) return { action: "cancel" };
      if (selected.length > 0 || question.kind === "multiple_choice")
        content[key] = question.kind === "multiple_choice" ? selected : selected[0]!;
      if (other.length > 0 && customKey !== undefined) content[customKey] = other.join(", ");
    }
    if (customKey !== undefined) {
      const custom = answers[customKey] ?? (questions.length === 1 ? response.notes : undefined);
      if (typeof custom === "string" && custom.trim() !== "")
        content[customKey] = [content[customKey], custom].filter(Boolean).join("\n");
    }
  }
  return { action: "accept", content };
}

export function claudeAdditionalArgs(args: readonly string[]): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  const reserved = new Set([
    "print",
    "p",
    "output-format",
    "input-format",
    "include-partial-messages",
    "verbose",
    "mcp-config",
    "permission-prompt-tool",
    "permission-mode",
    "plugin-dir",
    "append-system-prompt",
    "system-prompt",
    "model",
    "effort",
    "resume",
    "continue",
    "session-id",
    "settings",
    "setting-sources",
    "allowedTools",
    "disallowedTools",
    "add-dir",
    "ide",
    "dangerously-skip-permissions",
    "bare",
    "strict-mcp-config",
  ]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--"))
      throw new Error(`Claude additional argument must be a long option: ${arg}`);
    const [key, inline] = arg.slice(2).split(/=(.*)/s);
    if (key === undefined || reserved.has(key))
      throw new Error(`Claude argument is controlled by Pragma: ${arg}`);
    const next = args[index + 1];
    result[key] = inline ?? (next !== undefined && !next.startsWith("-") ? args[++index]! : null);
  }
  return result;
}

export function filterClaudeRuntimeEnv(env: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) =>
        value !== undefined &&
        key !== "CLAUDECODE" &&
        key !== "CLAUDE_CODE_ENTRYPOINT" &&
        key !== "CLAUDE_CODE_EXECPATH" &&
        key !== "CLAUDE_CODE_SESSION_ID" &&
        key !== "CLAUDE_CODE_SSE_PORT" &&
        !key.startsWith("CLAUDECODE_") &&
        !key.startsWith("CLAUDE_CODE_INTERNAL_"),
    ),
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
