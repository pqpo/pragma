import {
  SettingsManager,
  createAgentSession,
  createBashToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  BashToolInput,
  CreateAgentSessionOptions,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { McpToolRegistry, RuntimeAdapter } from "@pragma/core";
import {
  createMcpToolRegistry,
  defineRuntimeDriver,
  type RuntimeSessionPersistenceSpec,
} from "@pragma/core";

import {
  createPiModelRuntime,
  createPiModelProviderConverter,
  normalizePiRuntimeModels,
  registerPiModelProvider,
  resolvePiThinkingLevel,
  resolveRequiredRuntimeModel,
} from "./models.ts";
import { createResourceLoader } from "./resources.ts";
import { createPiSessionManager } from "./session-manager.ts";
import {
  collectPiUsage,
  createPiNativeSession,
  listPiMessages,
  mapPiAgentEvent,
  startPiTurn,
  type PiNativeSession,
} from "./session.ts";
import { createResolvedPiTools } from "./tools.ts";
import type { CloudPiRuntimeAdapterOptions, PiRuntimeStreamState } from "./types.ts";
import { defaultOutputParser } from "./types.ts";

const CLOUD_PI_RUNTIME_DESCRIPTOR = {
  id: "cloud-pi-agent",
  kind: "cloud-pi-agent" as const,
  displayName: "Cloud PI Agent",
  capabilities: {
    targets: ["agent"],
    executionLocations: ["cloud"],
    supportsAbort: true,
    supportsMcp: true,
    supportsStreaming: true,
  },
};

interface PiDriverSession extends PiNativeSession {
  readonly mcpToolRegistry: McpToolRegistry;
}

export function createPiRuntime(options: CloudPiRuntimeAdapterOptions = {}): RuntimeAdapter {
  const modelProviderConverter = createPiModelProviderConverter();
  const descriptor = {
    ...CLOUD_PI_RUNTIME_DESCRIPTOR,
    ...options.descriptor,
    kind: options.descriptor?.kind ?? CLOUD_PI_RUNTIME_DESCRIPTOR.kind,
    capabilities: {
      ...CLOUD_PI_RUNTIME_DESCRIPTOR.capabilities,
      ...options.descriptor?.capabilities,
    },
  };

  return defineRuntimeDriver(
    {
      descriptor,
      listModels: async () =>
        normalizePiRuntimeModels(
          (await options.modelProviders?.listProviders())?.flatMap((provider) =>
            modelProviderConverter.toRuntimeModels(provider),
          ) ?? [],
        ),
      defaultOutputParser: options.outputParser ?? defaultOutputParser,
      outputRetryLimit: options.outputRetryLimit ?? 3,
      resolvePersistence(ctx): RuntimeSessionPersistenceSpec {
        return {
          mode: "checkpoint",
          sessionDir: ctx.paths.runtimeSessionDir("pi"),
          watch: true,
          debounceMs: options.sessionSyncDebounceMs,
          checkpointOn: ["session.created", "turn.completed", "session.destroyed", "files.changed"],
          metadata: {
            format: "pi-agent-session-dir",
          },
        };
      },
      async createSession(ctx): Promise<PiDriverSession> {
        const selectedModel = ctx.request.modelSelection?.model;
        const selectedProviderId = selectedModel?.providerId;
        const registeredProvider =
          selectedProviderId === undefined
            ? undefined
            : await options.modelProviders?.resolveProvider(selectedProviderId);
        if (selectedProviderId !== undefined && registeredProvider === undefined) {
          throw new Error(`PI model provider is not registered: ${selectedProviderId}`);
        }
        const cwd = ctx.workspace;
        const settingsManager = SettingsManager.create(cwd);
        const { modelRegistry, modelRuntime } = await createPiModelRuntime(
          registeredProvider === undefined
            ? []
            : [modelProviderConverter.convertProvider(registeredProvider)],
        );
        const loader = createResourceLoader(ctx.agent, cwd, ctx.agentContext.systemPrompt);
        await loader.reload();
        const mcpToolRegistry = await createMcpToolRegistry(ctx.agent.mcp);
        const streamState: PiRuntimeStreamState = { logger: ctx.logger };
        const resolvedTools = createResolvedPiTools({
          agent: ctx.agent,
          cwd,
          mcpTools: mcpToolRegistry.tools,
          parentSystemPrompt: ctx.agentContext.systemPrompt,
          streamState,
          lifecycle: ctx.lifecycle,
          context: ctx.runContext,
          executionContext: ctx.request.executionContext,
          humanInteractionHandler: ctx.request.humanInteractionHandler,
        });
        const piSessionManagerResult = await createPiSessionManager(
          cwd,
          ctx.persistence.spec?.sessionDir ?? ctx.paths.runtimeSessionDir("pi"),
          ctx.request.runtimeSession?.id,
        );
        const sessionOptions: CreateAgentSessionOptions = {
          cwd,
          modelRuntime,
          resourceLoader: loader,
          sessionManager: piSessionManagerResult.sessionManager,
          settingsManager,
        };
        const defaultModel = resolveRequiredRuntimeModel(
          selectedModel,
          modelRegistry,
          "agent default",
        );

        if (defaultModel !== undefined) {
          sessionOptions.model = defaultModel;
        }
        const defaultThinkingLevel = resolvePiThinkingLevel(
          ctx.request.modelSelection?.thinkingLevel,
        );
        if (defaultThinkingLevel !== undefined) {
          sessionOptions.thinkingLevel = defaultThinkingLevel;
        }

        sessionOptions.customTools = [
          ...resolvedTools.tools.map((tool) => tool.tool),
          createPiSessionBashTool({
            cwd,
            processEnvironment: ctx.processEnvironment,
            commandPrefix: settingsManager.getShellCommandPrefix(),
            shellPath: settingsManager.getShellPath(),
          }),
        ];

        const { session } = await createAgentSession(sessionOptions);
        if (!piSessionManagerResult.resumedExistingSession) {
          appendStartupMessages(session, ctx.agentContext.startupMessages);
        }

        return {
          ...createPiNativeSession({
            agent: ctx.agent,
            session,
            streamState,
            models: {
              defaultModel: selectedModel,
              modelRegistry,
              modelRuntime,
            },
          }),
          mcpToolRegistry,
        };
      },
      readSession(session) {
        return {
          runtimeSessionId: session.session.sessionId,
        };
      },
      listMessages: listPiMessages,
      async startTurn(session, turn) {
        const selectedModel = turn.modelSelection?.model;
        if (selectedModel !== undefined) {
          const provider = await options.modelProviders?.resolveProvider(selectedModel.providerId);
          if (provider === undefined) {
            throw new Error(`PI model provider is not registered: ${selectedModel.providerId}`);
          }
          registerPiModelProvider(
            session.models.modelRuntime,
            modelProviderConverter.convertProvider(provider),
          );
        }
        return await startPiTurn(session, turn);
      },
      mapEvent: mapPiAgentEvent,
      collectUsage(session) {
        return collectPiUsage(session);
      },
      async cancelTurn(session) {
        await session.session.abort();
      },
      async steerTurn(session, request) {
        await session.session.steer(request.content);
      },
      async closeSession(session) {
        session.session.dispose();
        await session.mcpToolRegistry.dispose();
      },
    },
    {
      sessionRestoreHandler: options.sessionRestoreHandler,
      sessionSyncCallback: options.sessionSyncCallback,
    },
  );
}

export function createPiSessionBashTool(options: {
  readonly cwd: string;
  readonly processEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly commandPrefix?: string | undefined;
  readonly shellPath?: string | undefined;
}): ToolDefinition {
  const tool = createBashToolDefinition(options.cwd, {
    ...(options.commandPrefix === undefined ? {} : { commandPrefix: options.commandPrefix }),
    ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
    spawnHook: (context) => ({
      ...context,
      env: { ...options.processEnvironment },
    }),
  });
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
    parameters: tool.parameters,
    ...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
    async execute(toolCallId, params, signal, onUpdate, context) {
      return await tool.execute(
        toolCallId,
        params as BashToolInput,
        signal,
        onUpdate as Parameters<typeof tool.execute>[3],
        context as Parameters<typeof tool.execute>[4],
      );
    },
  };
}

function appendStartupMessages(
  session: AgentSession,
  messages: readonly { readonly role: "user"; readonly content: string }[],
): void {
  if (messages.length === 0) {
    return;
  }

  const timestamp = Date.now();
  const piMessages = messages.map((message, index) => ({
    role: message.role,
    content: message.content,
    timestamp: timestamp + index,
  }));
  const mutableSession = session as unknown as {
    readonly state?: { messages: unknown[] } | undefined;
    messages: unknown[];
  };
  const nextMessages = [...mutableSession.messages, ...piMessages];

  if (mutableSession.state !== undefined) {
    mutableSession.state.messages = nextMessages;
    return;
  }

  mutableSession.messages = nextMessages;
}
